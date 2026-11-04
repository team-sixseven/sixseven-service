"""모델 실행부가 모델팀 파일(model.joblib)과 같은 점수를 내는지 확인합니다.

EXAMPLES의 점수는 scikit-learn 1.9.1로 model.joblib의 predict_proba를 실행해 얻은 값입니다.
"""
import math

import pytest

from app import model

EXAMPLES = [
    {
        "inputs": {
            "age": 82,
            "sex_male": 1,
            "nyha": 3,
            "lvef": 55,
            "la_size": 49,
            "egfr": 90,
            "probnp": 6677,
            "ischemic": 0,
            "prior_mi": 0,
            "vpb_24h": 4502,
            "couplets_24h": 85,
            "nsvt": 1
        },
        "score": 0.7109943027537696
    },
    {
        "inputs": {
            "age": 81,
            "sex_male": 0,
            "nyha": 2,
            "lvef": 51,
            "la_size": 38,
            "egfr": 92,
            "probnp": 996,
            "ischemic": 0,
            "prior_mi": 1,
            "vpb_24h": 4545,
            "couplets_24h": 102,
            "nsvt": 0
        },
        "score": 0.4462190813120652
    },
    {
        "inputs": {
            "age": 72,
            "sex_male": 0,
            "nyha": 3,
            "lvef": 35,
            "la_size": 46,
            "egfr": 67,
            "probnp": 4681,
            "ischemic": 1,
            "prior_mi": 1,
            "vpb_24h": 14932,
            "couplets_24h": 242,
            "nsvt": 1
        },
        "score": 0.7970864900376728
    },
    {
        "inputs": {
            "age": 71,
            "sex_male": 1,
            "nyha": 2,
            "lvef": 59,
            "la_size": 46,
            "egfr": 43,
            "probnp": 6768,
            "ischemic": 0,
            "prior_mi": 1,
            "vpb_24h": 9188,
            "couplets_24h": 34,
            "nsvt": 0
        },
        "score": 0.5654821570359784
    },
    {
        "inputs": {
            "age": 60,
            "sex_male": 0,
            "nyha": 2,
            "lvef": 38,
            "la_size": 59,
            "egfr": 64,
            "probnp": 6477,
            "ischemic": 1,
            "prior_mi": 1,
            "vpb_24h": 9438,
            "couplets_24h": 132,
            "nsvt": 1
        },
        "score": 0.7453065527627516
    },
    {
        "inputs": {
            "age": 51,
            "sex_male": 0,
            "nyha": 2,
            "lvef": 26,
            "la_size": 59,
            "egfr": 26,
            "probnp": 822,
            "ischemic": 0,
            "prior_mi": 1,
            "vpb_24h": 10380,
            "couplets_24h": 264,
            "nsvt": 0
        },
        "score": 0.5865290361757625
    },
    {
        "inputs": {
            "age": 72,
            "sex_male": 0,
            "nyha": 2,
            "lvef": 15,
            "la_size": 50,
            "egfr": 95,
            "probnp": 5326,
            "ischemic": 0,
            "prior_mi": 1,
            "vpb_24h": 4013,
            "couplets_24h": 289,
            "nsvt": 1
        },
        "score": 0.7214644230178742
    },
    {
        "inputs": {
            "age": 48,
            "sex_male": 1,
            "nyha": 3,
            "lvef": 53,
            "la_size": 52,
            "egfr": 79,
            "probnp": 384,
            "ischemic": 1,
            "prior_mi": 0,
            "vpb_24h": 1372,
            "couplets_24h": 73,
            "nsvt": 1
        },
        "score": 0.6097938025285417
    },
    {
        "inputs": {
            "age": 72,
            "sex_male": 1,
            "nyha": 3,
            "lvef": 54,
            "la_size": 52,
            "egfr": 55,
            "probnp": 5163,
            "ischemic": 1,
            "prior_mi": 0,
            "vpb_24h": 888,
            "couplets_24h": 198,
            "nsvt": 0
        },
        "score": 0.6824393024872606
    },
    {
        "inputs": {
            "age": 66,
            "sex_male": 0,
            "nyha": 2,
            "lvef": 21,
            "la_size": 44,
            "egfr": 94,
            "probnp": 3237,
            "ischemic": 0,
            "prior_mi": 1,
            "vpb_24h": 14681,
            "couplets_24h": 117,
            "nsvt": 1
        },
        "score": 0.6608028930942517
    }
]


@pytest.mark.parametrize("example", EXAMPLES)
def test_matches_sklearn(example):
    result = model.predict(example["inputs"])
    assert result["missing"] == []
    assert result["score"] == pytest.approx(example["score"], abs=1e-4)


def test_contributions_sum_to_logit():
    inputs = EXAMPLES[0]["inputs"]
    result = model.predict(inputs)
    logit = model.INTERCEPT + sum(c["contribution"] for c in result["contributions"])
    assert 1 / (1 + math.exp(-logit)) == pytest.approx(EXAMPLES[0]["score"], abs=1e-3)


def test_missing_value_is_not_scored():
    inputs = dict(EXAMPLES[0]["inputs"], probnp=None)
    assert model.predict(inputs) == {"score": None, "contributions": [], "missing": ["probnp"]}
