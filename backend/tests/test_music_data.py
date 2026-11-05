import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import database, model, music_data, service, demo


class MusicImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.file = self.root/'cohort.json'
        self.env = patch.dict(os.environ, {'SQLITE_PATH':str(self.root/'service.sqlite3'), 'MUSIC_DATA_PATH':str(self.file)})
        self.env.start()
        database.initialize_database()
        self.rows=[]
        for i in range(89):
            row={v['column']:1 for v in model.VARIABLES}
            row.update({'demo_id':f'synthetic_{i}', 'NYHA class':2, 'SCD_actual':int(i<10),
                        'expected_score':.7 if i<28 else .2, 'expected_high_risk':int(i<28),
                        'Pro-BNP (ng/L)': 1000 if i<28 else 100})
            self.rows.append(row)
        self.write()
        with database.connect() as conn:
            conn.execute("INSERT INTO users VALUES ('keep','keep','hash','keep','attending',NULL)")
            demo.seed(conn)

    def tearDown(self):
        self.env.stop(); self.tmp.cleanup()

    def write(self):
        self.file.write_text(json.dumps(self.rows))

    def predict(self, inputs):
        self.assertEqual(set(inputs),set(model.KEYS))
        return {'score':.7 if inputs['probnp']==1000 else .2,
                'contributions':[{'key':k,'contribution':.01} for k in model.KEYS], 'missing':[]}

    def test_import_preserves_accounts_and_is_idempotent(self):
        with patch.object(music_data.inference_client,'_predict',side_effect=self.predict) as remote:
            music_data.initialize(); self.assertEqual(remote.call_count,89)
            with database.connect() as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM patients').fetchone()[0],89)
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM analyses').fetchone()[0],89)
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM alerts').fetchone()[0],28)
                self.assertEqual(conn.execute('SELECT SUM(scd) FROM music_outcomes').fetchone()[0],10)
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0],1)
                self.assertIsNone(conn.execute('SELECT next_visit FROM patients LIMIT 1').fetchone()[0])
                summary=service.patient_detail(conn,conn.execute('SELECT * FROM patients LIMIT 1').fetchone())
                self.assertNotIn('scd_actual',json.dumps(summary))
                aid=conn.execute('SELECT id FROM alerts LIMIT 1').fetchone()[0]
                conn.execute("UPDATE alerts SET memo='keep memo' WHERE id=?",(aid,))
            music_data.initialize(); self.assertEqual(remote.call_count,89)
            with database.connect() as conn:
                self.assertEqual(conn.execute('SELECT memo FROM alerts WHERE id=?',(aid,)).fetchone()[0],'keep memo')
                with self.assertRaises(Exception): conn.execute('DELETE FROM audit_logs')
        self.assertTrue(list((self.root/'backups').glob('before-music-*.sqlite3')))

    def test_failed_prediction_preserves_existing_data(self):
        with patch.object(music_data.inference_client,'_predict',side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError): music_data.initialize()
        with database.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM patients').fetchone()[0],6)

    def test_mismatch_preserves_existing_data(self):
        with patch.object(music_data.inference_client,'_predict',return_value={'score':.1}):
            with self.assertRaises(ValueError): music_data.initialize()
        with database.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM patients').fetchone()[0],6)

    def test_bad_inputs_and_duplicates(self):
        self.rows[1]['demo_id']=self.rows[0]['demo_id'];self.write()
        with self.assertRaises(ValueError):music_data.load_rows(self.file)
        self.rows[1]['demo_id']='synthetic_other';self.rows[0]['Age']=None;self.write()
        with self.assertRaises(ValueError):music_data.load_rows(self.file)

    def test_changed_dataset_requires_explicit_migration(self):
        with patch.object(music_data.inference_client,'_predict',side_effect=self.predict):music_data.initialize()
        self.rows[0]['Age']=55;self.write()
        with self.assertRaises(RuntimeError):music_data.initialize()

    def test_database_failure_rolls_back_complete_replacement(self):
        original = music_data.pipeline.save_analysis
        calls = 0
        def fail_after_one(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('write failure')
            return original(*args, **kwargs)
        with patch.object(music_data.inference_client,'_predict',side_effect=self.predict), patch.object(music_data.pipeline,'save_analysis',side_effect=fail_after_one):
            with self.assertRaises(RuntimeError):music_data.initialize()
        with database.connect() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM patients').fetchone()[0],6)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM music_imports').fetchone()[0],0)
            with self.assertRaises(Exception):conn.execute('DELETE FROM audit_logs')
