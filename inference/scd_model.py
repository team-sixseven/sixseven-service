"""SCD risk predictor (logistic regression, 12 inputs). Pure Python: no numpy / sklearn needed.

    from scd_model import SCDModel
    model = SCDModel("model.json")
    model.predict_proba(patient_inputs)  # uncalibrated score, not absolute risk
"""

from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


class SCDModel:
    def __init__(self, path: str | Path = HERE / "model.json"):
        self.spec = json.loads(Path(path).read_text(encoding="utf-8"))
        self.features: list[str] = self.spec["features"]

    def _validate(self, x: dict) -> None:
        missing = [f for f in self.features if x.get(f) is None or (isinstance(x[f], float) and math.isnan(x[f]))]
        if missing:
            raise ValueError(f"missing inputs: {missing}")
        for f in self.features:
            v = x[f]
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise ValueError(f"{f} must be a finite number")
            if v < 0:
                raise ValueError(f"{f} must be >= 0")
        for f in ("Gender (male=1)", "Ischemic etiology", "Prior Myocardial Infarction (yes=1)", "Holter NSVT (yes=1)"):
            if x[f] not in (0, 1):
                raise ValueError(f"{f} must be 0 or 1")
        if x["NYHA class"] not in (1, 2, 3, 4):
            raise ValueError("NYHA class must be 1, 2, 3 or 4")
        if x["LVEF (%)"] > 100:
            raise ValueError("LVEF (%) must be <= 100")
        for f in ("Holter ventricular premature beats in 24h", "Holter ventricular couplets"):
            if not float(x[f]).is_integer():
                raise ValueError(f"{f} must be an integer")

    def predict_proba(self, x: dict) -> float:
        """Uncalibrated model score for one patient (dict keyed by the 12 feature names)."""
        self._validate(x)
        z = self.spec["intercept"]
        for t in self.spec["terms"]:
            v = float(x[t["feature"]])
            if t["log1p"]:
                v = math.log1p(v)
            z += t["coef"] * (v - t["mean"]) / t["scale"]
        return 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))

    def contributions(self, x: dict) -> dict[str, float]:
        """Linear contributions in log-odds relative to the transformed training mean.

        The reference is the training mean of each transformed feature. These
        values add to the intercept to reconstruct the prediction's log-odds.
        """
        self._validate(x)
        out = {}
        for t in self.spec["terms"]:
            v = float(x[t["feature"]])
            v = math.log1p(v) if t["log1p"] else v
            out[t["feature"]] = t["coef"] * (v - t["mean"]) / t["scale"]
        return out
