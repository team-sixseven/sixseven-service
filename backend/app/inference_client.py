"""Remote inference adapter. No local fallback for live analyses."""
import asyncio
import json
import math
import os
import urllib.error
import urllib.request

from . import model

SPEC_SHA256 = "8da345e58d816f2b32d8a8107ee723d3436465c66a1f0c4b38c07f23ff7d1a6f"


def _predict(inputs):
    url = os.environ.get("INFERENCE_BASE_URL", "").rstrip("/")
    token = os.environ.get("INFERENCE_API_KEY", "")
    if not url or not token:
        raise RuntimeError("AI 서버 연결 설정이 없습니다.")
    payload = {v["column"]: inputs[v["key"]] for v in model.VARIABLES}
    req = urllib.request.Request(url + "/predict", data=json.dumps(payload, allow_nan=False).encode(),
          headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise RuntimeError("AI 서버 응답을 확인할 수 없습니다.") from error
    if result.get("model_sha256") != model.MODEL_SHA256:
        raise RuntimeError("AI 서버의 모델 버전이 서비스와 다릅니다.")
    if result.get("spec_sha256") != SPEC_SHA256:
        raise RuntimeError("AI 서버의 모델 설정이 서비스와 다릅니다.")
    score = result.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
        raise RuntimeError("AI 서버의 점수 형식이 올바르지 않습니다.")
    values = result.get("contributions", {})
    contributions = []
    for v in model.VARIABLES:
        value = values.get(v["column"])
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise RuntimeError("AI 서버의 기여도 형식이 올바르지 않습니다.")
        contributions.append({"key": v["key"], "contribution": value})
    return {"score": score, "contributions": contributions, "missing": []}


async def predict(inputs):
    return await asyncio.to_thread(_predict, inputs)


def ready():
    url = os.environ.get("INFERENCE_BASE_URL", "").rstrip("/")
    token = os.environ.get("INFERENCE_API_KEY", "")
    request = urllib.request.Request(url + "/ready", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(request, timeout=3) as response:
        result = json.load(response)
    if (result.get("model_sha256") != model.MODEL_SHA256 or result.get("status") != "ready"
            or result.get("spec_sha256") != SPEC_SHA256):
        raise RuntimeError("AI 모델 준비 상태가 올바르지 않습니다.")
    return True
