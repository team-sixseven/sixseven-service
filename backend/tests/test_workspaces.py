"""Two account isolation, including identical local record IDs and event channels."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from app import database, demo, events, model, music_data, pipeline, workspaces
from app.main import app


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        rows = []
        for i in range(89):
            row = {v['column']: 1 for v in model.VARIABLES}
            row.update(demo_id=['T78','T34'][i] if i < 2 else f'fixture_{i}',
                       SCD_actual=int(i < 10), expected_score=.7 if 1 <= i <= 28 else .2,
                       expected_high_risk=int(1 <= i <= 28))
            row['NYHA class'] = 2
            row['Pro-BNP (ng/L)'] = 1000 if 1 <= i <= 28 else 100
            rows.append(row)
        file = self.root / 'music.json'
        file.write_text(json.dumps(rows))
        self.env = patch.dict(os.environ, {
            'SQLITE_PATH': str(self.root/'service.sqlite3'), 'MUSIC_DATA_PATH':str(file),
            'ISOLATED_DEMO':'true','DEMO_MODE':'true','ALLOW_SIGNUP':'true',
            'ANALYSIS_STAGE_MIN_SEC':'0', 'PUBLIC_DEMO':'false'})
        self.env.start()
        self.mode = patch.object(demo,'DEMO_MODE',True); self.mode.start()
        self.predict = patch.object(music_data.inference_client, '_predict', side_effect=lambda inputs: {
            'score':.7 if inputs['probnp']==1000 else .2,
            'contributions':[{'key':k,'contribution':.01} for k in model.KEYS], 'missing':[]})
        self.predict.start()
        self.infer = patch.object(music_data.inference_client, 'predict', side_effect=self.async_predict)
        self.infer.start()
        self.client = TestClient(app)
        self.client.__enter__()
        self.headers = []
        for name in ('judge_one','judge_two'):
            response = self.client.post('/api/auth/signup',json={'username':name,'password':'demo-only-password'})
            self.assertEqual(response.status_code,201,response.text)
            self.headers.append({'Authorization':'Bearer '+response.json()['token']})

    async def async_predict(self, inputs):
        return {'score':.7,'contributions':[{'key':k,'contribution':.01} for k in model.KEYS], 'missing':[]}

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.infer.stop(); self.predict.stop(); self.mode.stop(); self.env.stop()
        self.tmp.cleanup()

    def get(self, path, n=0):
        return self.client.get('/api/'+path,headers=self.headers[n])

    def post(self,path,n=0):
        return self.client.post('/api/'+path,headers=self.headers[n])

    def test_accounts_have_independent_receive_results_reset_and_auth(self):
        self.assertTrue(self.get('me').json()['personal_demo'])
        self.assertEqual(self.get('me').json()['role'],'attending')
        self.assertEqual(self.get('logs?kind=all').status_code,403)
        self.get('me',1)
        self.assertEqual(self.get('admin/demo/auto').json()['remaining'],90)
        self.assertEqual(self.post('admin/demo/arrive').status_code,200)
        self.assertEqual(self.get('admin/demo/auto').json()['remaining'],89)
        self.assertEqual(self.get('admin/demo/auto',1).json()['remaining'],90)
        self.assertEqual(self.get('patients/T78',1).json()['exams'],[])
        self.assertEqual(self.post('admin/demo/arrive',1).status_code,200)
        for _ in range(100):
            a=self.get('patients/T78').json(); b=self.get('patients/T78',1).json()
            if a['exams'] and b['exams']:break
            time.sleep(.02)
        self.assertTrue(a['exams']); self.assertTrue(b['exams'])
        aid=a['exams'][0]['analysis_id']
        alert=self.get('analyses/'+aid,1).json()['alert']['id']
        result=self.client.post('/api/alerts/'+alert+'/actions', headers=self.headers[1],
                                json={'acts':['추가 검사 (심장초음파 등)'], 'memo':'judge two'})
        self.assertEqual(result.status_code,200,result.text)
        self.assertNotEqual(self.get('analyses/'+aid).json()['alert']['memo'],'judge two')

        self.assertEqual(self.post('admin/demo/reset').status_code,200)
        self.assertEqual(self.get('patients/T78').json()['exams'],[])
        self.assertTrue(self.get('patients/T78',1).json()['exams'])
        self.assertEqual(self.get('analyses/'+aid,1).json()['alert']['memo'],'judge two')
        self.assertEqual(self.get('analyses/'+aid).status_code,404)
        self.assertEqual(self.get('me').status_code,200)
        with database.connect(root=True) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM analyses').fetchone()[0],89)
        self.assertEqual(self.client.post('/api/admin/demo/arrive').status_code,401)

    def test_workspace_persists_after_new_login(self):
        self.post('admin/demo/arrive')
        response=self.client.post('/api/auth/login',json={'username':'judge_one','password':'demo-only-password'})
        self.headers[0]={'Authorization':'Bearer '+response.json()['token']}
        self.assertEqual(self.get('admin/demo/auto').json()['remaining'],89)
        self.client.__exit__(None,None,None)
        self.client.__enter__()
        self.assertEqual(self.get('admin/demo/auto').json()['remaining'],89)

    def test_websocket_events_reach_only_the_matching_account(self):
        tokens=[h['Authorization'][7:] for h in self.headers]
        with self.client.websocket_connect('/api/ws?token='+tokens[0]) as a, \
             self.client.websocket_connect('/api/ws?token='+tokens[1]) as b:
            self.assertEqual(a.receive_json()['type'],'hello')
            self.assertEqual(b.receive_json()['type'],'hello')
            self.assertEqual(self.post('admin/demo/arrive?patient=T78').status_code,200)
            self.assertEqual(self.post('admin/demo/arrive?patient=T34',1).status_code,200)
            self.assertEqual(a.receive_json()['data']['patient_id'],'T78')
            self.assertEqual(b.receive_json()['data']['patient_id'],'T34')

    def test_event_and_reset_generation_are_scoped(self):
        async def scenario():
            with database.use_workspace(self.root/'a.sqlite3'):
                qa=events.subscribe()
                pipeline.bump_generation()
                gen=pipeline._generations[database.workspace_key()]
            with database.use_workspace(self.root/'b.sqlite3'):
                qb=events.subscribe()
                pipeline.bump_generation()
                events.publish('demo.focus',{'patient_id':'T34'})
            await asyncio.sleep(0)
            self.assertTrue(qa.empty())
            self.assertEqual(qb.get_nowait()['data']['patient_id'],'T34')
            with database.use_workspace(self.root/'a.sqlite3'):
                self.assertEqual(pipeline._generations[database.workspace_key()],gen)
            with database.use_workspace(self.root/'a.sqlite3'):
                ta=asyncio.create_task(asyncio.sleep(60));demo.task_list().append(ta)
            with database.use_workspace(self.root/'b.sqlite3'):
                tb=asyncio.create_task(asyncio.sleep(60));demo.task_list().append(tb)
                demo.cancel_scheduled()
            await asyncio.sleep(0)
            self.assertFalse(ta.cancelled())
            self.assertTrue(tb.cancelled())
            ta.cancel()
            await asyncio.gather(ta,tb,return_exceptions=True)
            events.unsubscribe(qa);events.unsubscribe(qb)
        asyncio.run(scenario())
