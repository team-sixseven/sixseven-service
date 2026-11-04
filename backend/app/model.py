"""SCD 위험 점수 모델 실행부 (로지스틱 회귀, 변수 12개).

주의: 아래 PARAMS의 평균·표준편차·계수는 모델팀이 아직 전달하지 않아서 넣어 둔 **임시 값(placeholder)**입니다.
모델팀의 실제 값(또는 .joblib)을 받으면 이 표만 교체하면 되고, 교체 전까지 /api/model 응답의
`placeholder`가 true로 나갑니다. 변수 순서와 log1p 처리는 모델팀 확정 후 맞춰야 합니다.
"""
import hashlib
import json
import math

PLACEHOLDER = True
INTERCEPT = -0.4

# key, 화면 이름, 구분, 단위, 출처, log1p 변환, 평균, 표준편차, 계수
VARIABLES = [
    dict(key="age", name="나이", group="clinical", unit="세", source="EMR", log=False, mean=63.0, std=11.0, coef=0.12),
    dict(key="sex_male", name="성별(남=1)", group="clinical", unit="", source="EMR", log=False, mean=0.75, std=0.43, coef=0.10),
    dict(key="nyha", name="NYHA 등급", group="clinical", unit="", source="EMR", log=False, mean=2.5, std=0.5, coef=0.15),
    dict(key="lvef", name="LVEF", group="clinical", unit="%", source="EMR(심장초음파)", log=False, mean=33.0, std=9.0, coef=-0.22),
    dict(key="la_size", name="좌심방 크기", group="clinical", unit="mm", source="EMR(심장초음파)", log=False, mean=46.0, std=8.0, coef=0.10),
    dict(key="egfr", name="eGFR", group="clinical", unit="mL/min/1.73㎡", source="EMR(검사)", log=False, mean=70.0, std=22.0, coef=-0.12),
    dict(key="probnp", name="Pro-BNP", group="clinical", unit="ng/L", source="EMR(검사)", log=True, mean=7.0, std=1.1, coef=0.20),
    dict(key="ischemic", name="허혈성 원인", group="clinical", unit="", source="EMR", log=False, mean=0.40, std=0.49, coef=0.08),
    dict(key="prior_mi", name="과거 심근경색", group="clinical", unit="", source="EMR", log=False, mean=0.30, std=0.46, coef=0.06),
    dict(key="vpb_24h", name="심실조기수축(24시간)", group="holter", unit="회", source="Holter 판독", log=True, mean=5.5, std=1.8, coef=0.18),
    dict(key="couplets_24h", name="심실 커플렛(24시간)", group="holter", unit="회", source="Holter 판독", log=True, mean=2.2, std=1.6, coef=0.15),
    dict(key="nsvt", name="비지속성 심실빈맥", group="holter", unit="", source="Holter 판독", log=False, mean=0.35, std=0.48, coef=0.20),
]
KEYS = [v["key"] for v in VARIABLES]
BY_KEY = {v["key"]: v for v in VARIABLES}
CLINICAL_KEYS = [v["key"] for v in VARIABLES if v["group"] == "clinical"]
MODEL_HASH = hashlib.sha256(json.dumps([INTERCEPT, VARIABLES], sort_keys=True).encode()).hexdigest()[:16]
ELIGIBLE_NYHA = (2, 3)


def predict(inputs: dict) -> dict:
    """inputs: 12개 키 -> 값(없으면 None). 빠진 값이 있으면 계산하지 않고 missing만 돌려줍니다."""
    missing = [k for k in KEYS if inputs.get(k) is None]
    if missing:
        return {"score": None, "contributions": [], "missing": missing}
    logit = INTERCEPT
    contributions = []
    for v in VARIABLES:
        x = float(inputs[v["key"]])
        if v["log"]:
            x = math.log1p(x)
        contribution = v["coef"] * (x - v["mean"]) / v["std"]
        logit += contribution
        contributions.append({"key": v["key"], "contribution": round(contribution, 4)})
    return {"score": round(1 / (1 + math.exp(-logit)), 4), "contributions": contributions, "missing": []}


def format_value(key: str, value: float) -> str:
    if key == "sex_male":
        return "남" if value >= 0.5 else "여"
    if key == "nyha":
        return {1: "I", 2: "II", 3: "III", 4: "IV"}.get(int(value), str(value))
    if key in ("ischemic", "prior_mi", "nsvt"):
        return "있음" if value >= 0.5 else "없음"
    unit = BY_KEY[key]["unit"]
    number = f"{int(value):,}" if float(value).is_integer() else f"{value:g}"
    if key == "age":
        return f"{number}세"
    if unit in ("%",):
        return f"{number} %"
    return f"{number} {unit}".strip()


MODEL_INFO = {
    "placeholder": PLACEHOLDER,
    "placeholder_note": "계수·평균·표준편차는 모델팀 확정 전 임시 값입니다. 성능 지표는 모델팀이 전달한 값을 그대로 표시합니다.",
    "type": "로지스틱 회귀 (C=0.01, class weight balanced)",
    "file": "scd_logreg_v0_1.joblib",
    "hash": MODEL_HASH,
    "output": "4년 이내 돌연심장사(SCD) 위험 점수 0~1 (보정하지 않은 값, 실제 발생 확률 아님)",
    "description": "임상 정량 데이터 + 일부 심전도(ECG) 지표(Holter 판독 3개)",
    "variables": [
        {k: v[k] for k in ("key", "name", "group", "unit", "source")} for v in VARIABLES
    ],
    "training": "MUSIC 원본 992명 중 조건을 충족한 445명으로 개발 (학습 356 / 테스트 89, SCD 50명)",
    "exclusions": [
        "기기 이식 환자(ICD·CRT·심박조율기)",
        "심장이식 환자",
        "NYHA I·IV",
        "급성기 실시간 감시",
        "진단 확정",
    ],
    "threshold_basis": 0.40,
    "performance": {
        "test": {
            "label": "테스트 89명 (기준 0.40)",
            "auroc": 0.834, "auroc_ci": [0.690, 0.944], "ap": 0.371, "recall": 0.900, "precision": 0.209,
            "f1": 0.340, "specificity": 0.570, "alert_rate": 0.48,
            "confusion": {"tn": 45, "fp": 34, "fn": 1, "tp": 9},
        },
        "cv": {
            "label": "교차검증 356명",
            "auroc": 0.766, "auroc_sd": 0.007, "ap": 0.366, "ap_sd": 0.017, "recall": 0.875,
            "precision": 0.190, "f1": 0.312,
            "confusion": {"tn": 167, "fp": 149, "fn": 5, "tp": 35},
        },
    },
    "disclaimer": "이 점수는 진단이 아닌 보조 정보이며 실제 발생 확률이 아닙니다.",
}
