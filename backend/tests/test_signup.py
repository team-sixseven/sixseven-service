import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import demo, security, service
from app.database import connect
from app.main import app


class SignupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'SQLITE_PATH': self.temp.name + '/signup.sqlite3',
            'DEMO_MODE': 'true', 'ALLOW_SIGNUP': 'true', 'PUBLIC_DEMO': 'false'})
        self.env.start()
        self.mode = patch.object(demo, 'DEMO_MODE', True)
        self.mode.start()
        security._signup_attempts.clear()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        security._signup_attempts.clear()
        self.mode.stop()
        self.env.stop()
        self.temp.cleanup()

    def signup(self, **extra):
        return self.client.post('/api/auth/signup', json={'username': 'judge_1', 'password': 'demo-Password-67', **extra})

    def test_minimal_signup_logs_in_without_elevated_role(self):
        result = self.signup(role='admin', id='u-admin', name='관리자')
        self.assertEqual(result.status_code, 201)
        body = result.json()
        self.assertEqual(body['user']['role'], 'attending')
        self.assertEqual(body['user']['username'], 'judge_1')
        headers = {'Authorization': 'Bearer ' + body['token']}
        self.assertEqual(self.client.get('/api/patients', headers=headers).status_code, 200)
        self.assertEqual(self.client.post('/api/admin/demo/reset', headers=headers).status_code, 403)
        self.assertEqual(self.client.get('/api/logs?kind=system', headers=headers).status_code, 403)
        patient = self.client.get('/api/patients/v01', headers=headers).json()
        response = self.client.put('/api/alerts/' + patient['alert']['id'] + '/memo',
                                   headers=headers, json={'memo': '시연 메모 확인'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['memo'], '시연 메모 확인')
        with connect() as conn:
            row = conn.execute('SELECT * FROM users WHERE username=?', ('judge_1',)).fetchone()
            self.assertNotEqual(row['password_hash'], 'demo-Password-67')
            self.assertTrue(security.verify_password('demo-Password-67', row['password_hash']))

    def test_existing_and_case_normalization(self):
        self.assertEqual(self.signup(username=' Judge_1 ').status_code, 201)
        self.assertEqual(self.signup().status_code, 409)
        self.assertEqual(self.signup(username='admin').status_code, 409)
        login = self.client.post('/api/auth/login', json={'username': 'JUDGE_1', 'password': 'demo-Password-67'})
        self.assertEqual(login.status_code, 200)

    def test_disabled_outside_demo(self):
        with patch.object(demo, 'DEMO_MODE', False):
            self.assertFalse(self.client.get('/api/auth/options').json()['signup_enabled'])
            self.assertEqual(self.signup().status_code, 403)
        with patch.dict(os.environ, {'ALLOW_SIGNUP': 'false'}):
            self.assertEqual(self.signup().status_code, 403)

    def test_input_rules(self):
        for change in ({'username':'ab'}, {'username':'관리자'}, {'username':'a b'}, {'password':'short'}, {'password':' '*8}):
            self.assertEqual(self.signup(**change).status_code, 422)

    def test_rate_limit_before_hashing(self):
        with patch.object(security, 'signup_locked', return_value=True):
            with patch.object(security, 'hash_password') as hashed:
                self.assertEqual(self.signup().status_code, 429)
                hashed.assert_not_called()

    def test_capacity(self):
        with connect() as conn:
            for n in range(97):
                conn.execute("INSERT INTO users(id,username,password_hash,name,role) VALUES (?,?,?,?,?)",
                             (f'capacity-{n}',f'capacity-{n}','unused','capacity','attending'))
        self.assertEqual(self.signup().status_code, 429)

    def test_shared_demo_actions_do_not_grant_production_access(self):
        result = self.signup()
        user = result.json()['user']
        with connect() as conn:
            alert = conn.execute("SELECT * FROM alerts LIMIT 1").fetchone()
            service.ensure_can_act(conn, user, alert)
            with patch.dict(os.environ, {'DEMO_MODE': 'false'}):
                with self.assertRaises(service.AlertError):
                    service.ensure_can_act(conn, user, alert)
            with patch.dict(os.environ, {'ALLOW_SIGNUP': 'false'}):
                with self.assertRaises(service.AlertError):
                    service.ensure_can_act(conn, user, alert)

    def test_concurrent_duplicate_signup(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda _: self.signup(username='concurrent'), range(2)))
        self.assertEqual(sorted(r.status_code for r in responses), [201, 409])
