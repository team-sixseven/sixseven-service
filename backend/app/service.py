"""조회·변경 로직: 로그, 환자 목록/상세, 알림 처리."""
import json
import sqlite3
from datetime import datetime

from . import model
from .database import get_settings, iso, now
from .events import publish

DISCLAIMER = "이 점수는 진단이 아닌 보조 정보이며 실제 발생 확률이 아닙니다."
ROLE_LABEL = {"attending": "담당의", "oncall": "당직의", "admin": "관리자"}
CHANNEL_LABEL = {"app": "앱", "web": "업무 화면", "sms": "문자"}
ACT_CHOICES = ["외래 일정 앞당김", "ICD 평가 의뢰", "추가 검사(심장초음파 등)", "약물 조정 검토", "경과 관찰", "기타"]
SKIP_REASONS = [
    "임상적으로 위험이 낮다고 판단",
    "이미 관련 조치 중(약물 조정 등)",
    "심전도 기록 품질 문제(잡음·탈락)",
    "기타",
]
MID_BAND = 0.20


def band_for(score: float, threshold: float) -> str:
    return "high" if score >= threshold else "mid" if score >= MID_BAND else "low"


# ---------------------------------------------------------------- 로그
def add_log(conn, actor: str, kind: str, event: str, text: str, patient_id=None, alert_id=None, analysis_id=None,
            t: str | None = None) -> dict:
    t = t or iso()
    cur = conn.execute(
        "INSERT INTO audit_logs(t, actor, kind, patient_id, alert_id, analysis_id, event, text) VALUES (?,?,?,?,?,?,?,?)",
        (t, actor, kind, patient_id, alert_id, analysis_id, event, text),
    )
    entry = {"id": cur.lastrowid, "t": t, "actor": actor, "kind": kind, "patient_id": patient_id,
             "alert_id": alert_id, "analysis_id": analysis_id, "event": event, "text": text}
    publish("log.created", entry)
    return entry


def query_logs(conn, kind: str | None, q: str | None, patient: str | None, analysis: str | None,
               cursor: int | None, limit: int) -> dict:
    where, args = [], []
    if kind in ("human", "system"):
        where.append("l.kind = ?"); args.append(kind)
    if patient:
        where.append("l.patient_id = ?"); args.append(patient)
    if analysis:
        where.append("l.analysis_id = ?"); args.append(analysis)
    if cursor:
        where.append("l.id < ?"); args.append(cursor)
    if q:
        where.append("(l.text LIKE ? OR p.name LIKE ? OR p.mrn LIKE ?)"); args += [f"%{q}%"] * 3
    sql = ("SELECT l.*, p.name AS patient_name, p.mrn AS patient_mrn FROM audit_logs l "
           "LEFT JOIN patients p ON p.id = l.patient_id")
    if where:
        sql += " WHERE " + " AND ".join(where)
    rows = conn.execute(sql + " ORDER BY l.id DESC LIMIT ?", (*args, limit + 1)).fetchall()
    items = [dict(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": items[-1]["id"] if len(rows) > limit else None}


# ---------------------------------------------------------------- 환자
def _json(value, default):
    try:
        return json.loads(value) if value else default
    except json.JSONDecodeError:
        return default


def alert_view(row) -> dict | None:
    if row is None:
        return None
    a = dict(row)
    a["acts"] = _json(a["acts"], [])
    a["channels"] = _json(a["channels"], [])
    a["seen"] = bool(a["seen"])
    a["skip"] = bool(a["skip"])
    return a


def report_view(conn, row) -> dict | None:
    if row is None:
        return None
    r = dict(row)
    r["nsvt"] = bool(r["nsvt"])
    r["missing"] = _json(r["missing"], [])
    r["progress"] = _json(r["progress"], {})
    r["short"] = r["duration_h"] < 20
    if r["status"] == "queued":
        r["queue_pos"] = queue_position(conn, r["id"])
    return r


def queue_position(conn, report_id: str) -> int | None:
    ids = [x["id"] for x in conn.execute(
        "SELECT id FROM holter_reports WHERE status='queued' ORDER BY queue_seq, id")]
    return ids.index(report_id) + 1 if report_id in ids else None


def factor_rows(conn, analysis_id: str) -> list[dict]:
    return [dict(r) | {"group": r["grp"]} for r in conn.execute(
        "SELECT key, name, grp, value_text, contribution, rank FROM factors WHERE analysis_id=? ORDER BY rank",
        (analysis_id,))]


def analysis_view(conn, row, with_factors=True) -> dict | None:
    if row is None:
        return None
    a = dict(row)
    a["inputs"] = _json(a["inputs"], {})
    if with_factors:
        a["factors"] = factor_rows(conn, a["id"])
    return a


def patient_summary(conn, p) -> dict:
    report = conn.execute(
        "SELECT * FROM holter_reports WHERE patient_id=? ORDER BY received_at DESC, rowid DESC LIMIT 1", (p["id"],)
    ).fetchone()
    analysis = conn.execute(
        "SELECT * FROM analyses WHERE patient_id=? ORDER BY analyzed_at DESC, rowid DESC LIMIT 1", (p["id"],)
    ).fetchone()
    alert = conn.execute(
        "SELECT * FROM alerts WHERE analysis_id=? ORDER BY sent_at DESC, rowid DESC LIMIT 1", (analysis["id"],)
    ).fetchone() if analysis else None
    if report is None:
        status = "waiting"
    elif report["status"] in ("queued", "analyzing", "held", "failed"):
        status = report["status"]
    else:
        status = "done"
    latest = {
        "analysis_id": analysis["id"] if analysis else None,
        "score": analysis["score"] if analysis else None,
        "band": analysis["band"] if analysis else None,
        "analyzed_at": analysis["analyzed_at"] if analysis else None,
        "record_status": status,
    }
    if report is not None:
        latest.update(record_id=report["id"], duration_h=report["duration_h"], short=report["duration_h"] < 20,
                      received_at=report["received_at"], file_name=report["file_name"])
        if status == "held":
            latest["missing"] = _json(report["missing"], [])
            latest["hold_reason"] = report["hold_reason"]
        if status == "queued":
            latest["queue_pos"] = queue_position(conn, report["id"])
    return {
        "id": p["id"], "mrn": p["mrn"], "name": p["name"], "age": p["age"], "sex": p["sex"], "nyha": p["nyha"],
        "dx": p["dx"], "next_visit": p["next_visit"], "exclusion": p["exclusion"],
        "latest": latest, "alert": alert_view(alert),
    }


def exam_list(conn, patient_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM analyses WHERE patient_id=? ORDER BY analyzed_at, rowid", (patient_id,)).fetchall()
    exams, prev = [], None
    for row in rows:
        top = conn.execute(
            "SELECT name, value_text, contribution FROM factors WHERE analysis_id=? AND contribution > 0 ORDER BY contribution DESC LIMIT 1",
            (row["id"],)).fetchone()
        gap = None
        if prev is not None:
            gap = (datetime.fromisoformat(row["analyzed_at"]) - datetime.fromisoformat(prev["analyzed_at"])).days
        exams.append({
            "analysis_id": row["id"], "at": row["analyzed_at"], "score": row["score"], "band": row["band"],
            "delta": round(row["score"] - prev["score"], 4) if prev is not None else None,
            "gap_days": gap, "top_factor": top["name"] if top else None, "latest": False,
            "top_factor_detail": f"{top['name']} · {top['value_text']} · 기여도 +{top['contribution']:.2f}" if top else None,
        })
        prev = row
    if exams:
        exams[-1]["latest"] = True
    return exams[::-1]


def patient_detail(conn, p) -> dict:
    summary = patient_summary(conn, p)
    latest_report = conn.execute(
        "SELECT * FROM holter_reports WHERE patient_id=? ORDER BY received_at DESC, rowid DESC LIMIT 1", (p["id"],)
    ).fetchone()
    analysis = conn.execute(
        "SELECT * FROM analyses WHERE patient_id=? ORDER BY analyzed_at DESC, rowid DESC LIMIT 1", (p["id"],)
    ).fetchone()
    alert = None
    if analysis:
        alert = alert_view(conn.execute(
            "SELECT * FROM alerts WHERE analysis_id=? ORDER BY sent_at DESC LIMIT 1", (analysis["id"],)).fetchone())
    settings = get_settings(conn)
    preview = None
    if latest_report is not None and latest_report["status"] in ("queued", "analyzing", "held", "failed"):
        preview = inputs_preview(conn, p, latest_report)
    return summary | {
        "record_status": summary["latest"]["record_status"],
        "record": report_view(conn, latest_report),
        "inputs_preview": preview,
        "analysis": analysis_view(conn, analysis),
        "exams": exam_list(conn, p["id"]),
        "alert": alert,
        "threshold": settings["threshold"],
        "disclaimer": DISCLAIMER,
    }


def inputs_preview(conn, patient, report) -> dict:
    """분석 진행 화면에 보여 줄, 모델에 들어갈 값(없는 값은 null)."""
    from .pipeline import gather_inputs
    inputs = gather_inputs(conn, patient, report)
    rows = [{"key": v["key"], "name": v["name"], "group": v["group"],
             "value_text": None if inputs.get(v["key"]) is None else model.format_value(v["key"], inputs[v["key"]])}
            for v in model.VARIABLES]
    return {"clinical": [r for r in rows if r["group"] == "clinical"],
            "holter": [r for r in rows if r["group"] == "holter"], "duration_h": report["duration_h"]}


def analysis_detail(conn, analysis_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM analyses WHERE id=?", (analysis_id,)).fetchone()
    if row is None:
        return None
    ids = [r["id"] for r in conn.execute(
        "SELECT id FROM analyses WHERE patient_id=? ORDER BY analyzed_at, rowid", (row["patient_id"],))]
    index = ids.index(analysis_id)
    prev = conn.execute("SELECT * FROM analyses WHERE id=?", (ids[index - 1],)).fetchone() if index else None
    alert = alert_view(conn.execute("SELECT * FROM alerts WHERE analysis_id=?", (analysis_id,)).fetchone())
    return {
        "analysis": analysis_view(conn, row),
        "previous": analysis_view(conn, prev),
        "alert": alert,
        "threshold": get_settings(conn)["threshold"],
        "disclaimer": DISCLAIMER,
    }


def queue_state(conn) -> dict:
    cur = conn.execute(
        "SELECT r.id, r.patient_id, p.name FROM holter_reports r JOIN patients p ON p.id=r.patient_id "
        "WHERE r.status='analyzing' LIMIT 1").fetchone()
    waiting = conn.execute(
        "SELECT r.id, r.patient_id, p.name FROM holter_reports r JOIN patients p ON p.id=r.patient_id "
        "WHERE r.status='queued' ORDER BY r.queue_seq, r.id").fetchall()
    return {
        "analyzing": dict(cur) if cur else None,
        "queued": [dict(w) | {"pos": i + 1} for i, w in enumerate(waiting)],
    }


# ---------------------------------------------------------------- 알림 처리
class AlertError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


def get_alert(conn, alert_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
    if row is None:
        raise AlertError(404, "알림을 찾을 수 없습니다.")
    return row


def ensure_can_act(conn, user: dict, alert) -> None:
    if user["role"] == "oncall" and alert["re"] < 2:
        raise AlertError(403, "당직의는 당직의에게 전달된 알림만 처리할 수 있습니다.")
    if user["role"] == "attending":
        patient = conn.execute("SELECT attending_id FROM patients WHERE id=?", (alert["patient_id"],)).fetchone()
        if patient is None or patient["attending_id"] != user["id"]:
            raise AlertError(403, "담당 환자의 알림만 처리할 수 있습니다.")


def ensure_latest_analysis(conn, alert) -> None:
    latest = conn.execute(
        "SELECT id FROM analyses WHERE patient_id=? ORDER BY analyzed_at DESC, rowid DESC LIMIT 1",
        (alert["patient_id"],)).fetchone()
    if latest is None or latest["id"] != alert["analysis_id"]:
        raise AlertError(409, "과거 검사는 읽기 전용입니다. 최신 검사에서 조치해 주세요.")


def _emit_alert(conn, alert_id: str) -> dict:
    view = alert_view(conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone())
    publish("alert.updated", {"patient_id": view["patient_id"], "alert": view})
    return view


def _actor(user: dict) -> str:
    return ROLE_LABEL[user["role"]]


def _act_text(acts: list[str], other: str | None) -> str:
    return ", ".join(f"기타({other})" if a == "기타" and other else a for a in acts)


def _clean_acts(acts: list[str], other_text: str | None) -> list[str]:
    acts = [a for a in dict.fromkeys(acts) if a in ACT_CHOICES]
    if not acts:
        raise AlertError(422, "조치를 하나 이상 선택해 주세요.")
    if "기타" in acts and not (other_text or "").strip():
        raise AlertError(422, "기타 내용을 입력해 주세요.")
    return acts


def _describe(alert) -> str:
    if alert["skip"]:
        note = f" ({alert['skip_note']})" if alert["skip_note"] else ""
        return f"조치 불필요 · {alert['reason']}{note}"
    return f"조치 {_act_text(_json(alert['acts'], []), alert['other_text'])}"


def mark_seen(conn, alert_id: str) -> dict:
    alert = get_alert(conn, alert_id)
    if alert["status"] == "new" and not alert["seen"]:
        conn.execute("UPDATE alerts SET seen=1, seen_at=? WHERE id=?", (iso(), alert_id))
    return _emit_alert(conn, alert_id)


def set_ack(conn, user: dict, alert_id: str, status: str) -> dict:
    alert = get_alert(conn, alert_id)
    ensure_can_act(conn, user, alert)
    if status == "ack":
        ensure_latest_analysis(conn, alert)
    if status == "ack" and alert["status"] == "new":
        conn.execute("UPDATE alerts SET status='ack', ack_at=?, seen=1, seen_at=COALESCE(seen_at, ?) WHERE id=?",
                     (iso(), iso(), alert_id))
    elif status == "new" and alert["status"] == "ack":
        conn.execute("UPDATE alerts SET status='new', ack_at=NULL WHERE id=?", (alert_id,))
    elif alert["status"] != status:
        raise AlertError(409, "이 알림은 지금 상태에서 바꿀 수 없습니다.")
    return _emit_alert(conn, alert_id)


def _log_memo(conn, user, alert, old: str | None, new: str | None):
    if (old or "") == (new or ""):
        return
    if not old:
        event, text = "memo.added", f"메모 추가 · {new}"
    elif not new:
        event, text = "memo.deleted", f"메모 삭제 · 이전: {old}"
    else:
        event, text = "memo.edited", f"메모 수정 · {old} → {new}"
    add_log(conn, _actor(user), "human", event, text, alert["patient_id"], alert["id"], alert["analysis_id"])


def complete_action(conn, user, alert_id, acts, other_text, memo) -> dict:
    alert = get_alert(conn, alert_id)
    ensure_can_act(conn, user, alert)
    ensure_latest_analysis(conn, alert)
    if alert["status"] == "done":
        raise AlertError(409, "이미 처리된 알림입니다. 조치 수정을 이용해 주세요.")
    acts = _clean_acts(acts, other_text)
    memo = (memo or "").strip() or None
    ts = iso()
    conn.execute(
        "UPDATE alerts SET status='done', skip=0, acts=?, other_text=?, reason=NULL, skip_note=NULL, memo=?, "
        "memo_at=?, done_at=?, seen=1, seen_at=COALESCE(seen_at, ?) WHERE id=?",
        (json.dumps(acts, ensure_ascii=False), other_text if "기타" in acts else None, memo,
         ts if memo else None, ts, ts, alert_id))
    add_log(conn, _actor(user), "human", "alert.done", f"조치 완료 · {_act_text(acts, other_text)}",
            alert["patient_id"], alert_id, alert["analysis_id"])
    _log_memo(conn, user, alert, None, memo)
    return _emit_alert(conn, alert_id)


def skip_action(conn, user, alert_id, reason, note) -> dict:
    alert = get_alert(conn, alert_id)
    ensure_can_act(conn, user, alert)
    ensure_latest_analysis(conn, alert)
    if alert["status"] == "done":
        raise AlertError(409, "이미 처리된 알림입니다. 조치 수정을 이용해 주세요.")
    note = (note or "").strip() or None
    if reason not in SKIP_REASONS:
        raise AlertError(422, "사유를 선택해 주세요.")
    if reason == "기타" and not note:
        raise AlertError(422, "기타 내용을 입력해 주세요.")
    ts = iso()
    conn.execute(
        "UPDATE alerts SET status='done', skip=1, reason=?, skip_note=?, acts='[]', other_text=NULL, done_at=?, "
        "seen=1, seen_at=COALESCE(seen_at, ?) WHERE id=?", (reason, note, ts, ts, alert_id))
    add_log(conn, _actor(user), "human", "alert.skipped",
            f"조치 불필요 · {reason}" + (f" ({note})" if note else ""), alert["patient_id"], alert_id,
            alert["analysis_id"])
    return _emit_alert(conn, alert_id)


def change_action(conn, user, alert_id, skip, acts, other_text, reason, note) -> dict:
    alert = get_alert(conn, alert_id)
    ensure_can_act(conn, user, alert)
    ensure_latest_analysis(conn, alert)
    if alert["status"] != "done":
        raise AlertError(409, "처리가 끝난 알림만 수정할 수 있습니다.")
    before = _describe(alert)
    ts = iso()
    if skip:
        note = (note or "").strip() or None
        if reason not in SKIP_REASONS:
            raise AlertError(422, "사유를 선택해 주세요.")
        if reason == "기타" and not note:
            raise AlertError(422, "기타 내용을 입력해 주세요.")
        conn.execute("UPDATE alerts SET skip=1, reason=?, skip_note=?, acts='[]', other_text=NULL, changed_at=? "
                     "WHERE id=?", (reason, note, ts, alert_id))
    else:
        acts = _clean_acts(acts or [], other_text)
        conn.execute("UPDATE alerts SET skip=0, acts=?, other_text=?, reason=NULL, skip_note=NULL, changed_at=? "
                     "WHERE id=?", (json.dumps(acts, ensure_ascii=False), other_text if "기타" in acts else None,
                                    ts, alert_id))
    after = _describe(get_alert(conn, alert_id))
    add_log(conn, _actor(user), "human", "alert.changed", f"조치 변경 · {before} → {after}",
            alert["patient_id"], alert_id, alert["analysis_id"])
    return _emit_alert(conn, alert_id)


def change_memo(conn, user, alert_id, memo) -> dict:
    alert = get_alert(conn, alert_id)
    ensure_can_act(conn, user, alert)
    ensure_latest_analysis(conn, alert)
    if alert["status"] != "done":
        raise AlertError(409, "처리가 끝난 알림에만 메모를 남길 수 있습니다.")
    memo = (memo or "").strip() or None
    conn.execute("UPDATE alerts SET memo=?, memo_at=? WHERE id=?", (memo, iso() if memo else None, alert_id))
    _log_memo(conn, user, alert, alert["memo"], memo)
    return _emit_alert(conn, alert_id)


def create_alert(conn, analysis_id, patient_id, score, settings, sent_at=None) -> dict:
    from .database import next_id
    channels = [CHANNEL_LABEL[k] for k, on in settings["channels"].items() if on]
    alert_id = next_id(conn, "al")
    sent = sent_at or iso()
    conn.execute(
        "INSERT INTO alerts(id, analysis_id, patient_id, status, seen, sent_at, re_min, esc_min, channels) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (alert_id, analysis_id, patient_id, "new", 0, sent, settings["re_min"], settings["esc_min"],
         json.dumps(channels, ensure_ascii=False)))
    return alert_view(conn.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone())


def check_reminders(conn, at: datetime | None = None) -> list[dict]:
    """미확인 알림의 재알림(1) · 당직의 전달(2). 확인한 알림(seen)은 대상이 아닙니다."""
    at = at or now()
    changed = []
    for a in conn.execute("SELECT * FROM alerts WHERE status='new' AND seen=0 ORDER BY sent_at").fetchall():
        elapsed = (at - datetime.fromisoformat(a["sent_at"])).total_seconds() / 60
        for level, minutes, col, event, text in (
            (1, a["re_min"], "re_at", "alert.reminded", f"{a['re_min']}분 동안 확인하지 않음 · 담당의에게 재알림"),
            (2, a["esc_min"], "esc_at", "alert.escalated", f"{a['esc_min']}분 동안 확인하지 않음 · 당직의에게 전달"),
        ):
            current = conn.execute("SELECT re FROM alerts WHERE id=?", (a["id"],)).fetchone()["re"]
            if elapsed >= minutes and current < level:
                conn.execute(f"UPDATE alerts SET re=?, {col}=? WHERE id=?", (level, iso(at), a["id"]))
                add_log(conn, "시스템", "system", event, text, a["patient_id"], a["id"], a["analysis_id"])
                view = alert_view(conn.execute("SELECT * FROM alerts WHERE id=?", (a["id"],)).fetchone())
                publish(event, {"patient_id": a["patient_id"], "alert": view})
                changed.append(view)
    return changed


def model_names() -> dict:
    return {v["key"]: v["name"] for v in model.VARIABLES}
