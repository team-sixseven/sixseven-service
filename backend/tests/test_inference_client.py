import asyncio
import json
import os
import urllib.error
from io import BytesIO
from unittest.mock import patch

import pytest

from app import inference_client, model

INPUT = {v['key']: 1 for v in model.VARIABLES}

def response():
    # Expected spec hash is checked in the adapter, not accepted from arbitrary servers.
    import hashlib
    from pathlib import Path
    h = hashlib.sha256((Path(__file__).resolve().parents[2] / 'inference/model.json').read_bytes()).hexdigest()
    return {'model_sha256': model.MODEL_SHA256, 'spec_sha256': h, 'score': .5,
            'contributions': {v['column']: .1 for v in model.VARIABLES}}


def test_remote_mapping_and_unrounded_score():
    result = response() | {'score': .39999999}
    with patch.dict(os.environ, {'INFERENCE_BASE_URL': 'http://inference:8000', 'INFERENCE_API_KEY': 'test'}):
        with patch('urllib.request.urlopen', return_value=BytesIO(json.dumps(result).encode())) as call:
            got = asyncio.run(inference_client.predict(INPUT))
    assert got['score'] == .39999999
    assert len(got['contributions']) == 12
    request = call.call_args.args[0]
    assert set(json.loads(request.data)) == {v['column'] for v in model.VARIABLES}


@pytest.mark.parametrize('change', [{'model_sha256': 'wrong'}, {'spec_sha256': 'wrong'},
    {'score': True}, {'score': 2}, {'contributions': {}}])
def test_bad_response_is_rejected(change):
    with patch.dict(os.environ, {'INFERENCE_BASE_URL': 'http://inference:8000', 'INFERENCE_API_KEY': 'test'}):
        with patch('urllib.request.urlopen', return_value=BytesIO(json.dumps(response() | change).encode())):
            with pytest.raises(RuntimeError):
                asyncio.run(inference_client.predict(INPUT))


def test_outage_never_falls_back():
    with patch.dict(os.environ, {'INFERENCE_BASE_URL': 'http://inference:8000', 'INFERENCE_API_KEY': 'test'}):
        with patch('urllib.request.urlopen', side_effect=urllib.error.URLError('offline')):
            with patch.object(model, 'predict') as local:
                with pytest.raises(RuntimeError):
                    asyncio.run(inference_client.predict(INPUT))
                local.assert_not_called()
