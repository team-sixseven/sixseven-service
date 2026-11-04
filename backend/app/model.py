"""SCD 위험 점수 모델 실행부 (로지스틱 회귀, 변수 12개).

모델팀이 준 scikit-learn 파이프라인(model.joblib, scikit-learn 1.9.1)의 값을 그대로 옮겼습니다.
  - Pro-BNP · 24시간 심실조기수축 · 커플렛: log1p 후 표준화
  - 나머지 9개: 표준화
  - LogisticRegression(C=0.01, class_weight='balanced')
서버에서 피클(joblib)을 직접 불러오지 않고 계수만 쓰므로 scikit-learn이 필요 없습니다.
같은 점수가 나오는지는 tests/test_model.py가 scikit-learn 예측값과 비교해 확인합니다.
모델 파일을 바꾸면 계수를 다시 꺼내고 MODEL_SHA256과 테스트 예시를 함께 갱신해야 합니다.
"""
import math

PLACEHOLDER = False
MODEL_FILE = "model.joblib"
MODEL_SHA256 = "533928061184002b3f2bcb6b176816c6476e736f8cef4a26fd63809d11e42849"
SKLEARN_VERSION = "1.9.1"
INTERCEPT = -0.3399619853817614

# 입력 순서는 모델의 feature_names_in_ 순서와 같습니다(column이 모델 열 이름).
VARIABLES = [
    dict(key="age", column="Age", name="나이", group="clinical", unit="세", source="EMR",
         log=False, mean=62.91011235955056, std=11.189773068998761, coef=0.053651307956832296),
    dict(key="sex_male", column="Gender (male=1)", name="성별", group="clinical", unit="", source="EMR",
         log=False, mean=0.7162921348314607, std=0.4507967528832137, coef=0.08617539707385624),
    dict(key="nyha", column="NYHA class", name="NYHA 등급", group="clinical", unit="", source="EMR",
         log=False, mean=2.168539325842697, std=0.3743445224484872, coef=0.17986776738010135),
    dict(key="lvef", column="LVEF (%)", name="LVEF", group="clinical", unit="%", source="EMR(심장초음파)",
         log=False, mean=40.07022471910113, std=13.637485968645649, coef=-0.13514026983103686),
    dict(key="la_size", column="Left atrial size (mm)", name="좌심방 크기", group="clinical", unit="mm", source="EMR(심장초음파)",
         log=False, mean=44.93539325842696, std=7.82309926747185, coef=0.17458475677104643),
    dict(key="egfr", column="eGFR", name="eGFR", group="clinical", unit="mL/min", source="EMR(검사)",
         log=False, mean=65.13126551173251, std=17.522219036834343, coef=0.023394696662231276),
    dict(key="probnp", column="Pro-BNP (ng/L)", name="Pro-BNP", group="clinical", unit="ng/L", source="EMR(검사)",
         log=True, mean=6.465655793833288, std=1.2843570445138934, coef=0.21989851902931984),
    dict(key="ischemic", column="Ischemic etiology", name="허혈성 원인", group="clinical", unit="", source="EMR",
         log=False, mean=0.449438202247191, std=0.4974369353073855, coef=0.10492995222717848),
    dict(key="prior_mi", column="Prior Myocardial Infarction (yes=1)", name="과거 심근경색", group="clinical", unit="", source="EMR",
         log=False, mean=0.41292134831460675, std=0.4923589223530471, coef=0.15390349298023084),
    dict(key="vpb_24h", column="Holter ventricular premature beats in 24h", name="심실조기수축(24시간)", group="holter", unit="회", source="Holter 판독",
         log=True, mean=5.439789657117917, std=2.5334289765195055, coef=0.16095930670968756),
    dict(key="couplets_24h", column="Holter ventricular couplets", name="심실 커플렛(24시간)", group="holter", unit="회", source="Holter 판독",
         log=True, mean=1.5954725124243598, std=1.9884125040234713, coef=0.12949842206587278),
    dict(key="nsvt", column="Holter NSVT (yes=1)", name="비지속성 심실빈맥", group="holter", unit="", source="Holter 판독",
         log=False, mean=0.29213483146067415, std=0.4547439628055744, coef=0.10726382189516903),
]
KEYS = [v["key"] for v in VARIABLES]
BY_KEY = {v["key"]: v for v in VARIABLES}
CLINICAL_KEYS = [v["key"] for v in VARIABLES if v["group"] == "clinical"]
MODEL_HASH = MODEL_SHA256[:16]
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
    "placeholder_note": "",
    "sha256": MODEL_SHA256,
    "sklearn_version": SKLEARN_VERSION,
    "type": "로지스틱 회귀 (C=0.01, class weight balanced)",
    "file": MODEL_FILE,
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
