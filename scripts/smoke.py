"""Verify running service and remote inference without printing credentials/patient inputs."""
import json
import sys
import time
import urllib.request
from pathlib import Path

base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8080'
env = dict(line.split('=', 1) for line in (Path(__file__).resolve().parents[1] / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))

def call(path, token=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + '/api' + path, headers=headers,
              data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=15) as response:
        data = response.read()
        return json.loads(data) if data else None

admin = call('/auth/login', body={'username': 'admin', 'password': env['ADMIN_PASSWORD']})['token']
viewer = call('/auth/login', body={'username': 'test', 'password': env['ATTENDING_PASSWORD']})['token']
call('/admin/demo/arrive?patient=v05', admin, {})
for _ in range(90):
    detail = call('/patients/v05', viewer)
    if detail['record_status'] in ('done', 'failed'):
        break
    time.sleep(.5)
assert detail['record_status'] == 'done', detail.get('record_status')
assert len(detail['analysis']['factors']) == 12
analysis_id = detail['analysis']['id']
call('/auth/logout', viewer, {})
assert call('/patients/v05', admin)['analysis']['id'] == analysis_id
print('PASS: real inference via service, 12 contributions, logout preserves shared analysis')
