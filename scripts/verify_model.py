"""Compare the delivered joblib with JSON inference; joblib must be a trusted team artifact.
Usage: python scripts/verify_model.py /path/to/model_ml.zip
"""
import io
import json
import random
import sys
import zipfile
from pathlib import Path

import joblib
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'inference'))
from scd_model import SCDModel

with zipfile.ZipFile(sys.argv[1]) as archive:
    original = joblib.load(io.BytesIO(archive.read('model_ml/model.joblib')))
    example = json.loads(archive.read('model_ml/sample_input.json'))
model = SCDModel()
rng = random.Random(67)
rows = [example]
for _ in range(1000):
    x = {k: rng.uniform(0, 100) for k in model.features}
    x.update({'Age': rng.randint(18, 100), 'NYHA class': rng.choice([2, 3]),
              'Pro-BNP (ng/L)': rng.uniform(0, 30000),
              'Holter ventricular premature beats in 24h': rng.randint(0, 50000),
              'Holter ventricular couplets': rng.randint(0, 1000)})
    for k in ('Gender (male=1)', 'Ischemic etiology', 'Prior Myocardial Infarction (yes=1)', 'Holter NSVT (yes=1)'):
        x[k] = rng.randint(0, 1)
    rows.append(x)
expected = original.predict_proba(pd.DataFrame(rows)[original.feature_names_in_])
positive = list(original.classes_).index(1)
error = max(abs(model.predict_proba(x) - y[positive]) for x, y in zip(rows, expected))
print(json.dumps({'cases': len(rows), 'max_absolute_error': error, 'sample_score': model.predict_proba(example)}))
if error > 1e-9:
    raise SystemExit('Model parity failed')
