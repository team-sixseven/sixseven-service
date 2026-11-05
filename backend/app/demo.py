"""시연용 가상 데이터와 병원 전산(EMR) 목업. 실제 환자 정보가 아닙니다."""
import asyncio
import json
import os
from datetime import timedelta

from . import model, pipeline, service
from .database import SCHEMA, connect, get_settings, iso, next_id, now
from .events import publish

DEMO_MODE = os.environ.get("DEMO_MODE", "").lower() in ("1", "true", "yes")

# EMR 담당 환자 목록(목업). clinical에 없는 값은 EMR에 없는 값입니다.
ROSTER = [
    dict(id="v01", mrn="10-2384-11", name="박민수", age=72, sex="M", nyha="III", dx="허혈성 심부전", next_visit="+12",
         clinical=dict(lvef=27, la_size=52, egfr=48, probnp=2800, ischemic=1, prior_mi=1)),
    dict(id="v02", mrn="10-1177-42", name="이영숙", age=66, sex="F", nyha="II", dx="확장성 심근병증", next_visit="+30",
         clinical=dict(lvef=41, la_size=42, egfr=74, probnp=640, ischemic=0, prior_mi=0)),
    dict(id="v03", mrn="10-2290-63", name="최재훈", age=69, sex="M", nyha="III", dx="허혈성 심부전", next_visit="+7",
         clinical=dict(lvef=25, la_size=50, egfr=52, probnp=3900, ischemic=1, prior_mi=1)),
    dict(id="v04", mrn="10-4120-77", name="김도현", age=57, sex="M", nyha="II", dx="확장성 심근병증", next_visit="+21",
         clinical=dict(lvef=42, la_size=41, egfr=72, probnp=600, ischemic=0, prior_mi=0)),
    dict(id="v05", mrn="10-3315-08", name="정서민", age=63, sex="F", nyha="III", dx="허혈성 심부전", next_visit="+14",
         clinical=dict(lvef=24, la_size=51, egfr=55, probnp=3300, ischemic=1, prior_mi=0)),
    dict(id="v06", mrn="10-0391-25", name="오준석", age=54, sex="M", nyha="II", dx="비허혈성 심부전", next_visit="+45",
         clinical=dict(lvef=38, la_size=43, egfr=85, probnp=520, ischemic=0, prior_mi=0)),
    # 동기화 버튼을 눌러야 들어오는 새 환자 (송은희는 EMR에 Pro-BNP가 아직 없음)
    dict(id="n10552137", mrn="10-5521-37", name="송은희", age=61, sex="F", nyha="II", dx="확장성 심근병증",
         next_visit="+28", clinical=dict(lvef=36, la_size=44, egfr=72, ischemic=0, prior_mi=0), sync_only=True),
    dict(id="n10608314", mrn="10-6083-14", name="문상철", age=70, sex="M", nyha="III", dx="허혈성 심부전",
         next_visit="+10", clinical=dict(lvef=26, la_size=53, egfr=49, probnp=3600, ischemic=1, prior_mi=1),
         sync_only=True),
]
# '다시 확인'을 누르면 EMR에 들어와 있는 값
EMR_LATE_VALUES = {"n10552137": {"probnp": 1850}}

# 판독실이 보내는 시연용 기록. (patient, file, vpb, couplets, nsvt, 시간(h), 고위험 시연 여부)
ARRIVALS = {
    "v06": ("HOLTER_10-0391-25_report.xml", 50, 0, False, 15.2, False),
    "v05": ("HOLTER_10-3315-08_report.xml", 967, 41, True, 23.6, True),
    "v04": ("HOLTER_10-4120-77_report.xml", 221, 12, True, 21.4, False),
    "n10552137": ("HOLTER_10-5521-37_report.xml", 154, 3, False, 18.5, False),
    "n10608314": ("HOLTER_10-6083-14_report.xml", 660, 28, True, 24.0, True),
    "v01": ("HOLTER_10-2384-11_{date}_report.xml", 442, 23, True, 22.8, False),
}
AUTO_ORDER = [("v06", 8), ("v05", 12), ("v04", 14)]  # 로그인 후 몇 초 뒤에 들어오는지
SYNC_ORDER = ["n10552137", "n10608314", "v01"]
SYNC_DELAY_SEC = 4.5

# 이전에 분석이 끝난 검사 이력 (patient, 며칠 전, 값 덮어쓰기)
HISTORY = [
    ("v01", 83, dict(vpb_24h=380, couplets_24h=18, nsvt=1, duration_h=22.1, lvef=29, probnp=2400, egfr=50)),
    ("v01", 41, dict(vpb_24h=405, couplets_24h=20, nsvt=1, duration_h=23.0, lvef=28, probnp=2600, egfr=49)),
    ("v02", 20, dict(vpb_24h=30, couplets_24h=0, nsvt=0, duration_h=23.5)),
    ("v03", 9, dict(vpb_24h=820, couplets_24h=35, nsvt=1, duration_h=23.8)),
    ("v04", 30, dict(vpb_24h=180, couplets_24h=8, nsvt=0, duration_h=22.0)),
    ("v05", 60, dict(vpb_24h=700, couplets_24h=30, nsvt=1, duration_h=23.0, lvef=26, probnp=3000)),
]

_tasks: list[asyncio.Task] = []


def _insert_patient(conn, spec, seq):
    visit = (now() + timedelta(days=int(spec["next_visit"]))).date().isoformat()
    conn.execute(
        "INSERT INTO patients(id, mrn, name, age, sex, nyha, dx, next_visit, attending_id, exclusion, active, seq) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,1,?)",
        (spec["id"], spec["mrn"], spec["name"], spec["age"], spec["sex"], spec["nyha"], spec["dx"], visit,
         "u-test", spec.get("exclusion"), seq))
    for key, value in spec["clinical"].items():
        conn.execute("INSERT INTO clinical_values(patient_id, key, value, measured_at, source) VALUES (?,?,?,?,?)",
                     (spec["id"], key, value, iso(now() - timedelta(days=3)), "EMR"))


def seed(conn) -> None:
    for seq, spec in enumerate(ROSTER):
        if not spec.get("sync_only"):
            _insert_patient(conn, spec, seq)
    settings = get_settings(conn)
    by_id = {s["id"]: s for s in ROSTER}
    for pid, days_ago, override in HISTORY:
        spec = by_id[pid]
        when = now() - timedelta(days=days_ago, hours=3)
        inputs = dict(age=spec["age"], sex_male=1 if spec["sex"] == "M" else 0, nyha=pipeline.NYHA_NUM[spec["nyha"]],
                      **spec["clinical"])
        inputs.update({k: v for k, v in override.items() if k in model.KEYS})
        report_id = next_id(conn, "r")
        conn.execute(
            "INSERT INTO holter_reports(id, patient_id, file_name, received_at, source, duration_h, vpb_24h, "
            "couplets_24h, nsvt, status, progress) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (report_id, pid, f"HOLTER_{spec['mrn']}_{when:%Y%m%d}_report.xml", iso(when), "판독실",
             override["duration_h"], override["vpb_24h"], override["couplets_24h"], override["nsvt"], "done", "{}"))
        report = {"id": report_id}
        result = model.predict(inputs)
        saved = pipeline.save_analysis(conn, report, {"id": pid}, inputs, result, when=iso(when), settings=settings)
        service.add_log(conn, "판독실", "system", "record.received", "Holter 기록 업로드", pid, t=iso(when))
        service.add_log(conn, "시스템", "system", "analysis.completed",
                        f"Holter 분석 완료 · 위험 점수 {round(result['score'] * 100)}점", pid,
                        analysis_id=saved["id"], t=iso(when))
        if result["score"] >= settings["threshold"]:
            sent = when + timedelta(minutes=1)
            alert = service.create_alert(conn, saved["id"], pid, result["score"], settings, sent_at=iso(sent))
            done = sent + timedelta(hours=1)
            acts = ["외래 일정 앞당김", "ICD 평가 의뢰"] if pid == "v01" else ["경과 관찰"]
            conn.execute("UPDATE alerts SET status='done', seen=1, seen_at=?, done_at=?, acts=?, memo=?, memo_at=? "
                         "WHERE id=?", (iso(sent), iso(done), json.dumps(acts, ensure_ascii=False),
                                        "다음 외래에서 재평가" if pid == "v01" else None,
                                        iso(done) if pid == "v01" else None, alert["id"]))
            service.add_log(conn, "시스템", "system", "alert.created",
                            f"고위험 알림 발송 · {', '.join(alert['channels'])}", pid, alert["id"], saved["id"],
                            t=iso(sent))
            service.add_log(conn, "담당의", "human", "alert.done", f"조치 완료 · {', '.join(acts)}", pid, alert["id"],
                            saved["id"], t=iso(done))


def reset_all(conn) -> None:
    """로그인 토큰과 계정은 남기고 시연 데이터를 처음 상태로 되돌립니다."""
    conn.executescript("DROP TRIGGER IF EXISTS audit_logs_no_update; DROP TRIGGER IF EXISTS audit_logs_no_delete;")
    for table in ("audit_logs", "alerts", "factors", "analyses", "holter_reports", "clinical_values", "patients",
                  "settings", "seq"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM sqlite_sequence WHERE name='audit_logs'")
    conn.executescript(SCHEMA)
    seed(conn)


def emr_fetch_roster() -> list[dict]:
    return ROSTER


def emr_fetch_values(patient_id: str) -> dict:
    return dict(EMR_LATE_VALUES.get(patient_id, {}))


def sync_patients(conn) -> dict:
    """병원 전산(EMR) 담당 환자 목록과 맞춥니다. Holter 기록은 가져오지 않습니다."""
    roster = {s["id"]: s for s in emr_fetch_roster()}
    existing = {r["id"]: r for r in conn.execute("SELECT * FROM patients")}
    added, removed = [], []
    for pid, spec in roster.items():
        if pid not in existing:
            _insert_patient(conn, spec, len(existing) + len(added))
            added.append({"id": pid, "name": spec["name"]})
        elif not existing[pid]["active"]:
            conn.execute("UPDATE patients SET active=1 WHERE id=?", (pid,))
            added.append({"id": pid, "name": spec["name"]})
    for pid, row in existing.items():
        if pid not in roster and row["active"]:
            conn.execute("UPDATE patients SET active=0 WHERE id=?", (pid,))  # 기록은 지우지 않고 보관
            removed.append({"id": pid, "name": row["name"]})
    synced_at = iso()
    text = "병원 전산(EMR) 담당 환자 목록 동기화 · " + (f"새 환자 {len(added)}명 불러옴" if added else "변경 없음")
    service.add_log(conn, "시스템", "system", "patients.synced", text)
    publish("patients.synced", {"added": added, "removed": removed, "synced_at": synced_at})
    return {"added": added, "removed": removed, "synced_at": synced_at}


def arrive(conn, patient_id: str) -> dict | None:
    from . import music_data
    if music_data.enabled():
        return music_data.arrive(conn, patient_id)
    spec = ARRIVALS.get(patient_id)
    patient = conn.execute("SELECT * FROM patients WHERE id=? AND active=1", (patient_id,)).fetchone()
    if spec is None or patient is None:
        return None
    file_name, vpb, couplets, nsvt, hours, _ = spec
    file_name = file_name.format(date=f"{now():%Y%m%d}")
    return pipeline.ingest_report(conn, patient, file_name, hours, vpb, couplets, nsvt,
                                  file_uri=f"demo:{patient_id}")


def pending_arrivals(conn) -> list[str]:
    """아직 받지 않은 시연 기록의 환자 id (등록된 환자만)."""
    from . import music_data
    if music_data.enabled():
        return music_data.pending(conn)
    todo = []
    for pid in ARRIVALS:
        exists = conn.execute("SELECT 1 FROM patients WHERE id=? AND active=1", (pid,)).fetchone()
        done = conn.execute("SELECT 1 FROM holter_reports WHERE file_uri=?", (f"demo:{pid}",)).fetchone()
        if exists and not done:
            todo.append(pid)
    return todo


async def _later(delay: float, patient_id: str) -> None:
    await asyncio.sleep(delay)
    with connect() as conn:
        if patient_id in pending_arrivals(conn):  # 이미 받은 기록은 다시 넣지 않음
            arrive(conn, patient_id)


def schedule(delays: list[tuple[str, float]]) -> None:
    for pid, delay in delays:
        _tasks.append(asyncio.create_task(_later(delay, pid)))


def cancel_scheduled() -> None:
    for task in _tasks:
        task.cancel()
    _tasks.clear()


def start_autoplay() -> bool:
    if _tasks and any(not t.done() for t in _tasks):
        return False
    from . import music_data
    if music_data.enabled():
        with connect() as conn:
            waiting = music_data.pending(conn)
        if not waiting:
            return False
        schedule([(pid, 8 + i * 15) for i, pid in enumerate(waiting)])
        return True
    with connect() as conn:
        waiting = [pid for pid, _ in AUTO_ORDER if pid in pending_arrivals(conn)]
    if not waiting:
        return False
    schedule([(pid, delay) for pid, delay in AUTO_ORDER if pid in waiting])
    return True


def schedule_sync_followup() -> None:
    """동기화 약 4.5초 뒤 판독실에서 새 환자 2명 + 박민수 재검사 결과가 들어옵니다(시연)."""
    schedule([(pid, SYNC_DELAY_SEC + i * 0.3) for i, pid in enumerate(SYNC_ORDER)])


def full_reset() -> None:
    cancel_scheduled()
    pipeline.bump_generation()
    from . import music_data
    with connect() as conn:
        if music_data.enabled():
            music_data.reset_reception(conn)
        else:
            reset_all(conn)
    publish("demo.reset", {})
