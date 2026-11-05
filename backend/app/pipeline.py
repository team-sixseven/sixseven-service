"""Holter 판독 결과 수신 → 대기열 → 한 건씩 분석 → 알림."""
import asyncio
import json
import os

from . import model, inference_client
from .database import connect, get_settings, iso, next_id, next_number
from .events import publish
from .service import add_log, band_for, create_alert, queue_position

STAGES = [
    ("receive", "판독 결과 수신"),
    ("validate", "입력값 확인"),
    ("holter", "Holter 지표 확인"),
    ("score", "위험 점수 계산"),
    ("factors", "요인 정리"),
]
SHORT_HOURS = 20
NYHA_NUM = {"I": 1, "II": 2, "III": 3, "IV": 4}

_wake: asyncio.Event | None = None
_generation = 0


def stage_seconds() -> float:
    return float(os.environ.get("ANALYSIS_STAGE_MIN_SEC", "2"))


def wake() -> None:
    if _wake is not None:
        _wake.set()


def bump_generation() -> None:
    """데모 초기화 때 진행 중이던 분석을 버립니다."""
    global _generation
    _generation += 1


def fresh_progress() -> dict:
    return {"stages": [{"key": k, "label": label, "state": "wait"} for k, label in STAGES]}


def ingest_report(conn, patient, file_name, duration_h, vpb, couplets, nsvt, file_uri=None, source="판독실", input_snapshot=None) -> dict:
    report_id = next_id(conn, "r")
    seq = next_number(conn, "q")
    received = iso()
    conn.execute(
        "INSERT INTO holter_reports(id, patient_id, file_uri, file_name, received_at, source, duration_h, vpb_24h, "
        "couplets_24h, nsvt, status, queue_seq, progress) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (report_id, patient["id"], file_uri, file_name, received, source, duration_h, vpb, couplets, int(nsvt),
         "queued", seq, json.dumps(fresh_progress(), ensure_ascii=False)))
    if input_snapshot is not None:
        if set(input_snapshot) != set(model.KEYS):
            raise ValueError("A complete model input snapshot is required")
        conn.execute("INSERT INTO report_inputs(report_id,inputs) VALUES (?,?)",
                     (report_id,json.dumps(input_snapshot,allow_nan=False)))
    add_log(conn, "판독실", "system", "record.received", "Holter 기록 업로드", patient["id"])
    pos = queue_position(conn, report_id)
    publish("analysis.queued", {"patient_id": patient["id"], "record_id": report_id, "queue_pos": pos,
                                "short": 0 < duration_h < SHORT_HOURS})
    wake()
    return {"record_id": report_id, "patient_id": patient["id"], "status": "queued", "queue_pos": pos,
            "received_at": received}


def gather_inputs(conn, patient, report) -> dict:
    snapshot = conn.execute("SELECT inputs FROM report_inputs WHERE report_id=?",(report["id"],)).fetchone()
    if snapshot:
        return json.loads(snapshot["inputs"])
    inputs = {
        "age": patient["age"],
        "sex_male": None if patient["sex"] is None else (1 if patient["sex"] == "M" else 0),
        "nyha": NYHA_NUM.get(patient["nyha"]),
    }
    for key in model.CLINICAL_KEYS:
        if key in inputs:
            continue
        row = conn.execute(
            "SELECT value FROM clinical_values WHERE patient_id=? AND key=? ORDER BY measured_at DESC LIMIT 1",
            (patient["id"], key)).fetchone()
        inputs[key] = row["value"] if row else None
    inputs.update(vpb_24h=report["vpb_24h"], couplets_24h=report["couplets_24h"], nsvt=int(report["nsvt"]))
    return inputs


def ineligible_reason(patient) -> str | None:
    if patient["exclusion"]:
        return patient["exclusion"]
    if NYHA_NUM.get(patient["nyha"]) not in model.ELIGIBLE_NYHA:
        return f"NYHA {patient['nyha']}"
    return None


def save_progress(conn, report_id, progress, **fields) -> None:
    sets = ", ".join(["progress=?"] + [f"{k}=?" for k in fields])
    conn.execute(f"UPDATE holter_reports SET {sets} WHERE id=?",
                 (json.dumps(progress, ensure_ascii=False), *fields.values(), report_id))


def set_stage(conn, report, progress, key, state, info=None) -> None:
    for stage in progress["stages"]:
        if stage["key"] == key:
            stage["state"] = state
            if info is not None:
                stage["info"] = info
    save_progress(conn, report["id"], progress)
    publish("analysis.progress", {"patient_id": report["patient_id"], "record_id": report["id"], "stage": key,
                                  "state": state, "info": info})


def save_analysis(conn, report, patient, inputs, result, when=None, settings=None) -> dict:
    """모델 결과를 analyses/factors에 저장하고 analysis id를 돌려줍니다."""
    settings = settings or get_settings(conn)
    analysis_id = next_id(conn, "a")
    when = when or iso()
    conn.execute(
        "INSERT INTO analyses(id, report_id, patient_id, score, band, analyzed_at, inputs, model_hash) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (analysis_id, report["id"], patient["id"], result["score"], band_for(result["score"], settings["threshold"]),
         when, json.dumps(inputs, ensure_ascii=False), model.MODEL_HASH))
    ranked = sorted(result["contributions"], key=lambda c: abs(c["contribution"]), reverse=True)
    for rank, c in enumerate(ranked, 1):
        v = model.BY_KEY[c["key"]]
        conn.execute("INSERT INTO factors(analysis_id, key, name, grp, value_text, contribution, rank) "
                     "VALUES (?,?,?,?,?,?,?)",
                     (analysis_id, c["key"], v["name"], v["group"], model.format_value(c["key"], inputs[c["key"]]),
                      c["contribution"], rank))
    conn.execute("UPDATE holter_reports SET status='done', analysis_id=?, missing='[]' WHERE id=?",
                 (analysis_id, report["id"]))
    return {"id": analysis_id, "band": band_for(result["score"], settings["threshold"])}


def next_queued(conn):
    return conn.execute(
        "SELECT * FROM holter_reports WHERE status='queued' ORDER BY queue_seq, id LIMIT 1").fetchone()


def recover_interrupted() -> None:
    """서버가 분석 중에 꺼졌다면 다시 대기열로 돌립니다."""
    with connect() as conn:
        conn.execute("UPDATE holter_reports SET status='queued', progress=? WHERE status='analyzing'",
                     (json.dumps(fresh_progress(), ensure_ascii=False),))


async def process(report_id: str) -> None:
    gen = _generation
    with connect() as conn:
        report = conn.execute("SELECT * FROM holter_reports WHERE id=?", (report_id,)).fetchone()
        patient = conn.execute("SELECT * FROM patients WHERE id=?", (report["patient_id"],)).fetchone()
        progress = fresh_progress()
        conn.execute("UPDATE holter_reports SET status='analyzing', progress=?, missing='[]', hold_reason=NULL, "
                     "fail_reason=NULL WHERE id=?", (json.dumps(progress, ensure_ascii=False), report_id))
        publish("analysis.started", {"patient_id": patient["id"], "record_id": report_id})

    def alive() -> bool:
        return gen == _generation

    async def stage(key, run):
        """단계를 '진행 중'으로 보여 주고 최소 시간 뒤에 결과(info)를 확정합니다."""
        with connect() as c:
            set_stage(c, report, progress, key, "running")
        await asyncio.sleep(stage_seconds())
        if not alive():
            raise asyncio.CancelledError
        with connect() as c:
            return run(c)

    try:
        info = await stage("receive", lambda c: (
            set_stage(c, report, progress, "receive", "done",
                      {"received_at": report["received_at"], "duration_h": report["duration_h"]}), None)[1])

        held = {}

        def validate(c):
            inputs = gather_inputs(c, patient, report)
            reason = ineligible_reason(patient)
            missing = [k for k in model.KEYS if inputs.get(k) is None]
            if reason or missing:
                held.update(inputs=inputs, reason=reason, missing=missing)
                names = [model.BY_KEY[k]["name"] for k in missing]
                set_stage(c, report, progress, "validate", "held",
                          {"missing": names, "eligible": reason is None, "reason": reason})
                return
            held["inputs"] = inputs
            set_stage(c, report, progress, "validate", "done", {"missing": [], "eligible": True})

        await stage("validate", validate)
        if held.get("missing") or held.get("reason"):
            names = [model.BY_KEY[k]["name"] for k in held["missing"]]
            with connect() as c:
                kind = "ineligible" if held["reason"] else "missing"
                c.execute("UPDATE holter_reports SET status='held', missing=?, hold_reason=? WHERE id=?",
                          (json.dumps(names, ensure_ascii=False), kind, report_id))
                text = (f"위험 점수 계산 보류 · 모델 대상 아님({held['reason']})" if held["reason"]
                        else f"위험 점수 계산 보류 · {', '.join(names)} 없음")
                add_log(c, "시스템", "system", "analysis.held", text, patient["id"])
                publish("analysis.held", {"patient_id": patient["id"], "record_id": report_id, "missing": names,
                                          "reason": held["reason"]})
            return
        inputs = held["inputs"]

        await stage("holter", lambda c: set_stage(
            c, report, progress, "holter", "done",
            {"vpb": report["vpb_24h"], "couplets": report["couplets_24h"], "nsvt": bool(report["nsvt"]),
             "short": 0 < report["duration_h"] < SHORT_HOURS}))

        if model.PLACEHOLDER and os.environ.get("DEMO_MODE", "").lower() not in ("1", "true", "yes"):
            raise RuntimeError("실제 모델이 설정되지 않았습니다. 모델팀의 모델 파일과 계수가 필요합니다.")
        result = await inference_client.predict(inputs)
        await stage("score", lambda c: set_stage(c, report, progress, "score", "done", {"score": result["score"]}))

        saved = {}

        def finish(c):
            settings = get_settings(c)
            saved.update(save_analysis(c, report, patient, inputs, result, settings=settings))
            set_stage(c, report, progress, "factors", "done",
                      {"factor_count": min(3, len(result["contributions"]))})
            points = round(result["score"] * 100)
            add_log(c, "시스템", "system", "analysis.completed", f"Holter 분석 완료 · 위험 점수 {points}점",
                    patient["id"], analysis_id=saved["id"])
            publish("analysis.completed", {"patient_id": patient["id"], "record_id": report_id,
                                           "analysis_id": saved["id"], "score": result["score"],
                                           "band": saved["band"], "analyzed_at": iso()})
            if result["score"] >= settings["threshold"]:
                alert = create_alert(c, saved["id"], patient["id"], result["score"], settings)
                add_log(c, "시스템", "system", "alert.created",
                        f"고위험 알림 발송 · {', '.join(alert['channels'])}", patient["id"], alert["id"], saved["id"])
                publish("alert.created", {"patient_id": patient["id"], "name": patient["name"],
                                          "score": result["score"], "alert": alert})

        await stage("factors", finish)
    except asyncio.CancelledError:
        if not alive():
            return  # 데모 초기화로 버려진 분석
        raise
    except Exception as error:  # noqa: BLE001 - 어떤 오류든 기록 상태를 failed로 남겨야 합니다
        with connect() as c:
            c.execute("UPDATE holter_reports SET status='failed', fail_reason=? WHERE id=?", (str(error), report_id))
            add_log(c, "시스템", "system", "analysis.failed", f"Holter 분석 실패 · {error}", patient["id"])
            publish("analysis.failed", {"patient_id": patient["id"], "record_id": report_id, "reason": str(error)})


async def run_worker() -> None:
    global _wake
    _wake = asyncio.Event()
    recover_interrupted()
    _wake.set()
    while True:
        await _wake.wait()
        _wake.clear()
        while True:
            with connect() as conn:
                nxt = next_queued(conn)
            if nxt is None:
                break
            await process(nxt["id"])


def recheck(conn, report_id: str, fetch_values) -> dict:
    """보류된 기록의 EMR 값을 다시 읽어 와서, 이제 모두 있으면 대기열로 돌립니다."""
    report = conn.execute("SELECT * FROM holter_reports WHERE id=?", (report_id,)).fetchone()
    if report is None:
        return {"error": 404}
    if report["status"] != "held":
        return {"error": 409}
    patient = conn.execute("SELECT * FROM patients WHERE id=?", (report["patient_id"],)).fetchone()
    received = fetch_values(patient["id"])
    for key, value in received.items():
        conn.execute("INSERT OR REPLACE INTO clinical_values(patient_id, key, value, measured_at, source) "
                     "VALUES (?,?,?,?,?)", (patient["id"], key, value, iso(), "EMR"))
    inputs = gather_inputs(conn, patient, report)
    missing = [k for k in model.KEYS if inputs.get(k) is None]
    if missing or ineligible_reason(patient):
        names = [model.BY_KEY[k]["name"] for k in missing]
        conn.execute("UPDATE holter_reports SET missing=? WHERE id=?", (json.dumps(names, ensure_ascii=False),
                                                                          report_id))
        return {"status": "held", "missing": names}
    got = ", ".join(model.BY_KEY[k]["name"] for k in received) or "필수 값"
    conn.execute("UPDATE holter_reports SET status='queued', queue_seq=?, missing='[]', hold_reason=NULL, "
                 "progress=? WHERE id=?", (next_number(conn, "q"), json.dumps(fresh_progress(), ensure_ascii=False),
                                           report_id))
    add_log(conn, "시스템", "system", "emr.rechecked", f"EMR 값 수신 · {got} · 다시 계산", patient["id"])
    pos = queue_position(conn, report_id)
    publish("analysis.queued", {"patient_id": patient["id"], "record_id": report_id, "queue_pos": pos})
    wake()
    return {"status": "queued", "queue_pos": pos, "missing": []}
