"""설명서 v1.3의 판독 수신·보류·조치·권한 시나리오 회귀 검사."""
import os
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import model, demo
from app.database import connect
from app.main import app


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "SQLITE_PATH": f"{self.temp.name}/test.sqlite3",
            "DEMO_MODE": "true", "ANALYSIS_STAGE_MIN_SEC": "0",
        })
        self.env.start()
        self.demo_mode = patch.object(demo, "DEMO_MODE", True)
        self.demo_mode.start()
        self.autoplay = patch.object(demo, "start_autoplay", return_value=False)
        self.autoplay_mock = self.autoplay.start()
        self.inference = patch('app.inference_client.predict', side_effect=model.predict)
        self.inference_mock = self.inference.start()
        self.client = TestClient(app)
        self.client.__enter__()
        self.headers = {}
        for role in ("test", "admin", "oncall"):
            response = self.client.post('/api/auth/login', json={"username": role, "password": "1234"})
            self.assertEqual(response.status_code, 200)
            self.headers[role] = {"Authorization": f"Bearer {response.json()['token']}"}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.inference.stop()
        self.autoplay.stop()
        self.demo_mode.stop()
        self.env.stop()
        self.temp.cleanup()

    def wait_for(self, pid, status):
        for _ in range(200):
            response = self.client.get(f'/api/patients/{pid}', headers=self.headers['test'])
            self.assertEqual(response.status_code, 200)
            detail = response.json()
            if detail['record_status'] == status:
                return detail
            time.sleep(.01)
        self.fail(f'{pid} did not reach {status}: {detail}')

    def test_next_record_updates_remaining_and_does_not_duplicate(self):
        def remaining():
            return self.client.get('/api/admin/demo/auto', headers=self.headers['admin']).json()['remaining']
        before = remaining()
        first = self.client.post('/api/admin/demo/arrive', headers=self.headers['admin'])
        self.assertEqual(first.status_code, 200)
        self.assertEqual(len(first.json()['arrived']), 1)
        self.assertEqual(remaining(), before - 1)
        while remaining():
            response = self.client.post('/api/admin/demo/arrive', headers=self.headers['admin'])
            self.assertEqual(len(response.json()['arrived']), 1)
        response = self.client.post('/api/admin/demo/arrive', headers=self.headers['admin'])
        self.assertEqual(response.json()['arrived'], [])
        self.assertEqual(remaining(), 0)

    def arrive(self, pid):
        result = self.client.post(f'/api/admin/demo/arrive?patient={pid}', headers=self.headers['admin'])
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(result.json()['arrived']), 1)

    def test_logout_preserves_other_session_and_analysis(self):
        self.autoplay_mock.assert_not_called()
        self.arrive('v05')
        before = self.wait_for('v05', 'done')['analysis']['id']
        self.assertEqual(self.client.post('/api/auth/logout', headers=self.headers['test']).status_code, 204)
        after = self.client.get('/api/patients/v05', headers=self.headers['admin'])
        self.assertEqual(after.status_code, 200)
        self.assertEqual(after.json()['analysis']['id'], before)

    def test_inference_failure_is_recorded(self):
        self.inference_mock.side_effect = RuntimeError('AI 서버 응답을 확인할 수 없습니다.')
        self.arrive('v05')
        failed = self.wait_for('v05', 'failed')
        self.assertIsNone(failed['record']['analysis_id'])
        self.assertIn('AI 서버', failed['record']['fail_reason'])

    def test_held_recheck_preserves_short_record_warning(self):
        with patch.object(demo, 'schedule_sync_followup'):
            response = self.client.post('/api/patients/sync', headers=self.headers['test'])
        self.assertEqual(len(response.json()['added']), 2)
        self.arrive('n10552137')
        detail = self.wait_for('n10552137', 'held')
        self.assertEqual(detail['record']['missing'], ['Pro-BNP'])
        self.assertIsNone(detail['analysis'])
        self.assertTrue(detail['record']['short'])
        response = self.client.post(f"/api/records/{detail['record']['id']}/recheck", headers=self.headers['test'])
        self.assertEqual(response.status_code, 200)
        done = self.wait_for('n10552137', 'done')
        self.assertEqual(len(done['analysis']['factors']), 12)
        self.assertEqual(done['analysis']['inputs']['probnp'], 1850)
        self.assertEqual(done['analysis']['inputs']['vpb_24h'], 154)

    def test_seen_ack_cancel_action_and_memo_history(self):
        self.arrive('v05')
        detail = self.wait_for('v05', 'done')
        alert_id = detail['alert']['id']
        base = f'/api/alerts/{alert_id}'
        headers = self.headers['test']
        response = self.client.post(base + '/seen', headers=headers)
        self.assertTrue(response.json()['seen'])
        self.assertEqual(response.json()['status'], 'new')
        self.assertEqual(self.client.patch(base, json={'status': 'ack'}, headers=headers).json()['status'], 'ack')
        self.assertEqual(self.client.patch(base, json={'status': 'new'}, headers=headers).json()['status'], 'new')
        logs = self.client.get('/api/logs?patient=v05&kind=human', headers=headers).json()['items']
        before = len(logs)
        response = self.client.post(base + '/actions', json={'acts': ['기타'], 'other_text': '상담', 'memo': '외래 확인'}, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['status'], 'done')
        self.assertEqual(self.client.put(base + '/memo', json={'memo': '재평가'}, headers=headers).status_code, 200)
        self.assertEqual(self.client.put(base + '/memo', json={'memo': ''}, headers=headers).status_code, 200)
        logs = self.client.get('/api/logs?patient=v05&kind=human', headers=headers).json()['items']
        self.assertEqual(len(logs), before + 4)
        self.assertEqual([x['event'] for x in logs[:4]], ['memo.deleted', 'memo.edited', 'memo.added', 'alert.done'])

    def test_past_analysis_is_read_only_on_server(self):
        detail = self.client.get('/api/patients/v01', headers=self.headers['test']).json()
        past = self.client.get(f"/api/analyses/{detail['exams'][-1]['analysis_id']}", headers=self.headers['test']).json()
        response = self.client.put(f"/api/alerts/{past['alert']['id']}/memo", json={'memo': '변경'}, headers=self.headers['admin'])
        self.assertEqual(response.status_code, 409)

    def test_latest_low_score_does_not_inherit_previous_alert(self):
        with connect() as conn:
            for key, value in [('lvef', 55), ('probnp', 150), ('egfr', 80), ('la_size', 38), ('ischemic', 0), ('prior_mi', 0)]:
                conn.execute('UPDATE clinical_values SET value=? WHERE patient_id=? AND key=?', (value, 'v01', key))
            conn.execute("UPDATE patients SET nyha='II' WHERE id='v01'")
        response = self.client.post('/api/holter', headers=self.headers['admin'], json={
            'patient_id': 'v01', 'file_name': 'followup.xml', 'duration_h': 24,
            'vpb_24h': 0, 'couplets_24h': 0, 'nsvt': False,
        })
        self.assertEqual(response.status_code, 202)
        # 기존 이력이 done이므로 새 보고서가 완료될 때까지 별도로 확인합니다.
        for _ in range(200):
            detail = self.client.get('/api/patients/v01', headers=self.headers['test']).json()
            if detail['record']['id'] == response.json()['record_id'] and detail['record_status'] == 'done':
                break
            time.sleep(.01)
        else:
            self.fail('follow-up report did not complete')
        self.assertLess(detail['analysis']['score'], detail['threshold'])
        self.assertIsNone(detail['alert'])
        patients = self.client.get('/api/patients', headers=self.headers['test']).json()
        self.assertIsNone(next(p for p in patients if p['id'] == 'v01')['alert'])

    def test_permissions_and_reminders(self):
        self.assertEqual(self.client.get('/api/logs?kind=system', headers=self.headers['test']).status_code, 403)
        self.assertEqual(self.client.post('/api/admin/demo/arrive', headers=self.headers['test']).status_code, 403)
        self.arrive('v05')
        detail = self.wait_for('v05', 'done')
        base = f"/api/alerts/{detail['alert']['id']}"
        payload = {'acts': ['경과 관찰']}
        self.assertEqual(self.client.post(base + '/actions', json=payload, headers=self.headers['oncall']).status_code, 403)
        with connect() as conn:
            conn.execute("UPDATE patients SET attending_id='another-doctor' WHERE id='v05'")
        self.assertEqual(self.client.post(base + '/actions', json=payload, headers=self.headers['test']).status_code, 403)
        self.client.post('/api/admin/demo/advance?min=60', headers=self.headers['admin'])
        detail = self.client.get('/api/patients/v05', headers=self.headers['oncall']).json()
        self.assertEqual(detail['alert']['re'], 2)
        self.assertEqual(self.client.post(base + '/actions', json=payload, headers=self.headers['oncall']).status_code, 200)

    def test_settings_snapshot_and_websocket_delivery_from_sync_api(self):
        self.arrive('v05')
        detail = self.wait_for('v05', 'done')
        token = self.headers['admin']['Authorization'][7:]
        with self.client.websocket_connect('/api/ws?token=' + token) as ws:
            self.assertEqual(ws.receive_json()['type'], 'hello')
            response = self.client.patch('/api/settings', json={'re_min': 15, 'threshold': .45}, headers=self.headers['test'])
            self.assertEqual(response.status_code, 200)
            event = ws.receive_json()
            self.assertEqual(event['type'], 'log.created')
            while event['type'] != 'settings.updated':
                event = ws.receive_json()
            self.assertEqual(event['data']['threshold'], .45)
        with connect() as conn:
            row = conn.execute('SELECT re_min FROM alerts WHERE id=?', (detail['alert']['id'],)).fetchone()
            self.assertEqual(row['re_min'], 30)

    def test_operating_mode_rejects_demo_emr_and_scores_with_real_model(self):
        with patch.object(demo, 'DEMO_MODE', False), patch.dict(os.environ, {'DEMO_MODE': 'false'}):
            self.assertEqual(self.client.post('/api/patients/sync', headers=self.headers['test']).status_code, 503)
            self.assertEqual(self.client.post('/api/admin/demo/arrive', headers=self.headers['admin']).status_code, 404)
            response = self.client.post('/api/holter', headers=self.headers['admin'], json={
                'patient_id': 'v05', 'file_name': 'report.xml', 'duration_h': 24,
                'vpb_24h': 967, 'couplets_24h': 41, 'nsvt': True,
            })
            self.assertEqual(response.status_code, 202)
            detail = self.wait_for('v05', 'done')
            self.assertEqual(detail['analysis']['model_hash'], model.MODEL_HASH)
            self.assertFalse(model.PLACEHOLDER)


if __name__ == '__main__':
    unittest.main()
