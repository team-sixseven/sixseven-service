import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'inference'))
os.environ.setdefault('INFERENCE_API_KEY', 'test-only-key')
spec = importlib.util.spec_from_file_location('inference_api', ROOT / 'inference/app.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
client = TestClient(api.app)
HEADERS = {'Authorization': 'Bearer test-only-key'}
SAMPLE = json.loads((ROOT / 'inference/sample_input.json').read_text())


def test_sample_and_auth():
    assert client.get('/health').status_code == 200
    assert client.get('/ready').status_code == 401
    assert client.post('/predict', json=SAMPLE).status_code == 401
    result = client.post('/predict', json=SAMPLE, headers=HEADERS).json()
    assert result['score'] == pytest.approx(0.6336517020627861, abs=1e-12)
    assert len(result['contributions']) == 12
    import math
    z = api.model.spec['intercept'] + sum(result['contributions'].values())
    assert 1 / (1 + math.exp(-z)) == pytest.approx(result['score'], abs=1e-12)


@pytest.mark.parametrize('key,value', [('Age', None), ('Gender (male=1)', 2), ('NYHA class', 2.5),
    ('Holter ventricular couplets', -1), ('Holter ventricular couplets', 1.5), ('LVEF (%)', 101), ('Age', '65')])
def test_invalid_inputs(key, value):
    assert client.post('/predict', json=SAMPLE | {key: value}, headers=HEADERS).status_code == 422


def test_nonfinite_and_extreme():
    for value in (float('nan'), float('inf')):
        with pytest.raises(ValueError):
            api.model.predict_proba(SAMPLE | {'Age': value})
    assert api.model.predict_proba(SAMPLE | {'Age': 1e10}) == 1
