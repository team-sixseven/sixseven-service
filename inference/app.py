import hashlib
import os
import secrets
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from scd_model import SCDModel

model = SCDModel()
MODEL_HASH = "533928061184002b3f2bcb6b176816c6476e736f8cef4a26fd63809d11e42849"
SPEC_HASH = hashlib.sha256(Path(__file__).with_name("model.json").read_bytes()).hexdigest()
TOKEN = os.environ.get("INFERENCE_API_KEY", "")
if not TOKEN:
    raise RuntimeError("INFERENCE_API_KEY is required")
app = FastAPI(title="SixSeven inference", docs_url=None, redoc_url=None)


def authorize(authorization: str = Header(default="")):
    if not secrets.compare_digest(authorization, "Bearer " + TOKEN):
        raise HTTPException(401, "Invalid inference credentials")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready", dependencies=[Depends(authorize)])
@app.get("/model", dependencies=[Depends(authorize)])
def ready():
    return {"status": "ready", "model_id": model.spec["model"],
            "model_sha256": MODEL_HASH, "spec_sha256": SPEC_HASH,
            "features": model.features, "output": "uncalibrated_score"}


@app.post("/predict", dependencies=[Depends(authorize)])
def predict(inputs: dict):
    try:
        score = model.predict_proba(inputs)
        contributions = model.contributions(inputs)
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        raise HTTPException(422, str(error)) from error
    return {"model_id": model.spec["model"], "model_sha256": MODEL_HASH,
            "spec_sha256": SPEC_HASH, "score": score, "contributions": contributions,
            "contribution_basis": "transformed_training_mean_log_odds"}
