import asyncio
import os
import sqlite3
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import demo, events, model, pipeline, security, service
from .database import check_database, connect, get_settings, initialize_database, iso, now, set_setting
from .service import AlertError

ADMIN_PASSWORD_ENV = "ADMIN_PASSWORD"


def ensure_users() -> None:
    """시연 계정은 DEMO_MODE일 때만 만듭니다. 운영에서는 ADMIN_PASSWORD로 관리자 한 명만 만듭니다."""
    accounts = []
    if demo.DEMO_MODE:
        accounts = [("u-test", "test", "1234", "김담당", "attending", "심장내과"),
                    ("u-admin", "admin", "1234", "관리자", "admin", None),
                    ("u-oncall", "oncall", "1234", "이당직", "oncall", "심장내과")]
    elif os.environ.get(ADMIN_PASSWORD_ENV):
        accounts = [("u-admin", "admin", os.environ[ADMIN_PASSWORD_ENV], "관리자", "admin", None)]
    with connect() as conn:
        for uid, username, password, name, role, dept in accounts:
            if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone() is None:
                conn.execute("INSERT INTO users(id, username, password_hash, name, role, dept) VALUES (?,?,?,?,?,?)",
                             (uid, username, security.hash_password(password), name, role, dept))


async def reminder_loop() -> None:
    while True:
        await asyncio.sleep(60)
        with connect() as conn:
            service.check_reminders(conn)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.database_path = initialize_database()
    ensure_users()
    if demo.DEMO_MODE:
        with connect() as conn:
            if conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0] == 0:
                demo.seed(conn)
    tasks = [asyncio.create_task(pipeline.run_worker()), asyncio.create_task(reminder_loop())]
    yield
    demo.cancel_scheduled()
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title="SixSeven Service API",
    version="0.2.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
    lifespan=lifespan,
)


@app.exception_handler(AlertError)
async def alert_error_handler(_: Request, error: AlertError):
    return JSONResponse({"detail": error.message}, status_code=error.status)


# ---------------------------------------------------------------- 인증
def current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    token = authorization[7:] if authorization and authorization.lower().startswith("bearer ") else None
    user = security.user_for_token(token)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다.", headers={"WWW-Authenticate": "Bearer"})
    return user


User = Annotated[dict, Depends(current_user)]


def admin_only(user: User) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "관리자만 사용할 수 있습니다.")
    return user


Admin = Annotated[dict, Depends(admin_only)]


def public_user(u: dict) -> dict:
    return {"id": u["id"], "username": u["username"], "name": u["name"], "role": u["role"],
            "role_label": service.ROLE_LABEL[u["role"]], "dept": u["dept"], "demo_mode": demo.DEMO_MODE}


class LoginBody(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


@app.post("/api/auth/login", tags=["auth"])
async def login(body: LoginBody):
    username = body.username.strip()
    if security.is_locked(username):
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.")
    user = await asyncio.to_thread(security.authenticate, username, body.password)
    if user is None:
        security.record_failure(username)
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
    security.clear_failures(username)
    token, expires = security.issue_token(user["id"])
    if demo.DEMO_MODE:
        demo.start_autoplay()
    return {"token": token, "expires_at": expires, "user": public_user(user)}


@app.post("/api/auth/logout", tags=["auth"], status_code=204)
async def logout(user: User, authorization: Annotated[str, Header()]):
    security.revoke_token(authorization[7:])
    if demo.DEMO_MODE:
        demo.full_reset()  # 로그아웃하면 시연 데이터가 처음 상태로 돌아갑니다


@app.get("/api/me", tags=["auth"])
def me(user: User):
    return public_user(user)


# ---------------------------------------------------------------- 상태
class HealthStatus(BaseModel):
    status: Literal["ok"]
    database: Literal["sqlite"]


@app.get("/api/health", response_model=HealthStatus, tags=["status"])
def health(request: Request) -> HealthStatus:
    try:
        check_database(request.app.state.database_path)
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Database unavailable") from error
    return HealthStatus(status="ok", database="sqlite")


@app.get("/api/model", tags=["status"])
def model_info(user: User):
    return model.MODEL_INFO


# ---------------------------------------------------------------- 환자
@app.get("/api/patients", tags=["patients"])
def patients(user: User):
    with connect() as conn:
        rows = conn.execute("SELECT * FROM patients WHERE active=1 ORDER BY seq").fetchall()
        return [service.patient_summary(conn, p) for p in rows]


@app.get("/api/patients/{patient_id}", tags=["patients"])
def patient(patient_id: str, user: User):
    with connect() as conn:
        row = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "환자를 찾을 수 없습니다.")
        return service.patient_detail(conn, row)


@app.post("/api/patients/sync", tags=["patients"])
async def sync_patients(user: User):
    if not demo.DEMO_MODE:
        raise HTTPException(503, "병원 전산(EMR) 연동이 아직 설정되지 않았습니다.")
    with connect() as conn:
        result = demo.sync_patients(conn)
    if demo.DEMO_MODE and result["added"]:
        demo.schedule_sync_followup()
    return result


@app.get("/api/analyses/{analysis_id}", tags=["patients"])
def analysis(analysis_id: str, user: User):
    with connect() as conn:
        detail = service.analysis_detail(conn, analysis_id)
    if detail is None:
        raise HTTPException(404, "검사를 찾을 수 없습니다.")
    return detail


@app.get("/api/queue", tags=["analysis"])
def queue(user: User):
    with connect() as conn:
        return service.queue_state(conn)


class HolterBody(BaseModel):
    patient_id: str = Field(description="환자 id 또는 등록번호")
    file_name: str = Field(max_length=200)
    duration_h: float = Field(gt=0, le=48)
    vpb_24h: int = Field(ge=0)
    couplets_24h: int = Field(ge=0)
    nsvt: bool


@app.post("/api/holter", status_code=202, tags=["analysis"])
async def receive_holter(body: HolterBody, user: Admin):
    """판독실 시스템이 호출합니다. 연동용 계정 역할이 정해질 때까지 관리자 토큰만 허용합니다."""
    with connect() as conn:
        p = conn.execute("SELECT * FROM patients WHERE (id=? OR mrn=?) AND active=1",
                         (body.patient_id, body.patient_id)).fetchone()
        if p is None:
            raise HTTPException(404, "담당 환자를 찾을 수 없습니다.")
        return pipeline.ingest_report(conn, p, body.file_name, body.duration_h, body.vpb_24h, body.couplets_24h,
                                      body.nsvt)


@app.post("/api/records/{record_id}/recheck", tags=["analysis"])
async def recheck(record_id: str, user: User):
    if not demo.DEMO_MODE:
        raise HTTPException(503, "병원 전산(EMR) 연동이 아직 설정되지 않았습니다.")
    with connect() as conn:
        result = pipeline.recheck(conn, record_id, demo.emr_fetch_values)
    if result.get("error") == 404:
        raise HTTPException(404, "기록을 찾을 수 없습니다.")
    if result.get("error") == 409:
        raise HTTPException(409, "보류된 기록만 다시 확인할 수 있습니다.")
    return result


# ---------------------------------------------------------------- 알림
class ActionBody(BaseModel):
    acts: list[str] = Field(default_factory=list, max_length=8)
    other_text: str | None = Field(default=None, max_length=200)
    memo: str | None = Field(default=None, max_length=1000)


class SkipBody(BaseModel):
    reason: str
    note: str | None = Field(default=None, max_length=200)


class ChangeBody(BaseModel):
    skip: bool = False
    acts: list[str] = Field(default_factory=list, max_length=8)
    other_text: str | None = Field(default=None, max_length=200)
    reason: str | None = None
    note: str | None = Field(default=None, max_length=200)


class MemoBody(BaseModel):
    memo: str = Field(default="", max_length=1000)


class AckBody(BaseModel):
    status: Literal["ack", "new"]


@app.post("/api/alerts/{alert_id}/seen", tags=["alerts"])
async def alert_seen(alert_id: str, user: User):
    with connect() as conn:
        return service.mark_seen(conn, alert_id)


@app.patch("/api/alerts/{alert_id}", tags=["alerts"])
async def alert_ack(alert_id: str, body: AckBody, user: User):
    with connect() as conn:
        return service.set_ack(conn, user, alert_id, body.status)


@app.post("/api/alerts/{alert_id}/actions", tags=["alerts"])
async def alert_done(alert_id: str, body: ActionBody, user: User):
    with connect() as conn:
        return service.complete_action(conn, user, alert_id, body.acts, body.other_text, body.memo)


@app.post("/api/alerts/{alert_id}/skip", tags=["alerts"])
async def alert_skip(alert_id: str, body: SkipBody, user: User):
    with connect() as conn:
        return service.skip_action(conn, user, alert_id, body.reason, body.note)


@app.put("/api/alerts/{alert_id}/actions", tags=["alerts"])
async def alert_change(alert_id: str, body: ChangeBody, user: User):
    with connect() as conn:
        return service.change_action(conn, user, alert_id, body.skip, body.acts, body.other_text, body.reason,
                                     body.note)


@app.put("/api/alerts/{alert_id}/memo", tags=["alerts"])
async def alert_memo(alert_id: str, body: MemoBody, user: User):
    with connect() as conn:
        return service.change_memo(conn, user, alert_id, body.memo)


@app.get("/api/choices", tags=["alerts"])
def choices(user: User):
    return {"acts": service.ACT_CHOICES, "skip_reasons": service.SKIP_REASONS}


# ---------------------------------------------------------------- 기록 · 설정
@app.get("/api/logs", tags=["logs"])
def logs(user: User, kind: Literal["human", "system", "all"] = "human", q: str | None = Query(None, max_length=100),
         patient: str | None = None, analysis: str | None = None, cursor: int | None = None,
         limit: int = Query(100, ge=1, le=500)):
    if kind != "human" and user["role"] != "admin":
        raise HTTPException(403, "시스템 처리기록은 관리자만 볼 수 있습니다.")
    with connect() as conn:
        return service.query_logs(conn, None if kind == "all" else kind, q, patient, analysis, cursor, limit)


class SettingsPatch(BaseModel):
    threshold: float | None = Field(default=None, ge=0.2, le=0.8)
    re_min: Literal[15, 30, 60] | None = None
    esc_min: Literal[60, 120] | None = None
    channels: dict[Literal["app", "web", "sms"], bool] | None = None


def settings_view(conn) -> dict:
    return get_settings(conn) | {"performance_threshold": model.MODEL_INFO["threshold_basis"]}


@app.get("/api/settings", tags=["settings"])
def read_settings(user: User):
    with connect() as conn:
        return settings_view(conn)


@app.patch("/api/settings", tags=["settings"])
def update_settings(body: SettingsPatch, user: User):
    with connect() as conn:
        current = get_settings(conn)
        actor = service.ROLE_LABEL[user["role"]]
        if body.threshold is not None and abs(body.threshold * 20 - round(body.threshold * 20)) > 1e-6:
            raise HTTPException(422, "알림 기준은 5점 단위로 정해 주세요.")
        changes = []
        if body.threshold is not None and round(body.threshold, 2) != current["threshold"]:
            changes.append(("threshold", round(body.threshold, 2),
                            f"알림 기준 변경 · {round(current['threshold'] * 100)}점 → {round(body.threshold * 100)}점"))
        if body.re_min is not None and body.re_min != current["re_min"]:
            changes.append(("re_min", body.re_min, f"재알림 시간 변경 · {body.re_min}분"))
        if body.esc_min is not None and body.esc_min != current["esc_min"]:
            changes.append(("esc_min", body.esc_min, f"당직의 전달 시간 변경 · {body.esc_min}분"))
        if body.channels is not None:
            merged = current["channels"] | body.channels
            if merged != current["channels"]:
                names = ", ".join(service.CHANNEL_LABEL[k] for k, on in merged.items() if on) or "없음"
                changes.append(("channels", merged, f"알림 받는 방법 변경 · {names}"))
        for key, value, text in changes:
            set_setting(conn, key, value)
            service.add_log(conn, actor, "human", "settings.changed", text)
        if changes:
            events.publish("settings.updated", settings_view(conn))
        return settings_view(conn)


# ---------------------------------------------------------------- 시연 (DEMO_MODE + 관리자)
def demo_only(user: Admin) -> dict:
    if not demo.DEMO_MODE:
        raise HTTPException(404, "시연 모드가 꺼져 있습니다.")
    return user


Demo = Annotated[dict, Depends(demo_only)]


@app.post("/api/admin/demo/arrive", tags=["demo"])
async def demo_arrive(user: Demo, high: bool = False, patient: str | None = None, all: bool = False):
    with connect() as conn:
        todo = demo.pending_arrivals(conn)
        if patient:
            todo = [p for p in todo if p == patient]
        elif high:
            todo = [p for p in todo if demo.ARRIVALS[p][5]][:1]
        elif not all:
            order = [p for p, _ in demo.AUTO_ORDER] + demo.SYNC_ORDER
            todo = sorted(todo, key=order.index)[:1]
        return {"arrived": [r for p in todo if (r := demo.arrive(conn, p))]}


@app.post("/api/admin/demo/advance", tags=["demo"])
async def demo_advance(user: Demo, min: int = Query(30, ge=1, le=240)):
    from datetime import datetime, timedelta
    with connect() as conn:
        for a in conn.execute("SELECT id, sent_at FROM alerts WHERE status='new'").fetchall():
            shifted = datetime.fromisoformat(a["sent_at"]) - timedelta(minutes=min)
            conn.execute("UPDATE alerts SET sent_at=? WHERE id=?", (iso(shifted), a["id"]))
        return {"changed": [a["id"] for a in service.check_reminders(conn)]}


@app.post("/api/admin/demo/reset", tags=["demo"])
async def demo_reset(user: Demo):
    demo.full_reset()
    return {"ok": True}


@app.post("/api/admin/demo/auto", tags=["demo"])
async def demo_auto(user: Demo, enabled: bool = True):
    if enabled:
        return {"started": demo.start_autoplay()}
    demo.cancel_scheduled()
    return {"started": False}


# ---------------------------------------------------------------- 실시간
@app.websocket("/api/ws")
async def ws(websocket: WebSocket, token: str | None = None):
    await websocket.accept()
    user = security.user_for_token(token)
    if user is None:
        await websocket.close(code=1008)
        return
    queue_ = events.subscribe()
    try:
        await websocket.send_json({"type": "hello", "at": iso(), "data": {"user": user["id"]}})
        while True:
            receiver = asyncio.create_task(websocket.receive_text())
            sender = asyncio.create_task(queue_.get())
            done, pending = await asyncio.wait({receiver, sender}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if receiver in done:
                receiver.result()  # 연결이 끊기면 WebSocketDisconnect
            if sender in done:
                event = sender.result()
                if event["type"] == "log.created" and event["data"]["kind"] == "system" and user["role"] != "admin":
                    continue
                await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        events.unsubscribe(queue_)
