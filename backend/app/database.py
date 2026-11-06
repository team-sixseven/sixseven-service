import json
import os
import sqlite3
from contextlib import closing, contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
_db_path: Path | None = None
_workspace = ContextVar('workspace_database', default=None)


def workspace_key():
    return str(_workspace.get() or _db_path)


@contextmanager
def use_workspace(path):
    token = _workspace.set(path)
    try:
        yield
    finally:
        _workspace.reset(token)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('attending','oncall','admin')), dept TEXT
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, mrn TEXT UNIQUE NOT NULL, name TEXT NOT NULL, age INTEGER, sex TEXT, nyha TEXT,
  dx TEXT, next_visit TEXT, attending_id TEXT, exclusion TEXT, active INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clinical_values (
  patient_id TEXT NOT NULL REFERENCES patients(id), key TEXT NOT NULL, value REAL NOT NULL,
  measured_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'EMR',
  PRIMARY KEY (patient_id, key, measured_at)
);
CREATE TABLE IF NOT EXISTS holter_reports (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), file_uri TEXT, file_name TEXT,
  received_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '판독실', duration_h REAL NOT NULL,
  vpb_24h INTEGER NOT NULL, couplets_24h INTEGER NOT NULL, nsvt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','analyzing','held','done','failed')),
  queue_seq INTEGER, missing TEXT NOT NULL DEFAULT '[]', hold_reason TEXT, fail_reason TEXT,
  progress TEXT NOT NULL DEFAULT '{}', analysis_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_patient ON holter_reports(patient_id, received_at);
CREATE TABLE IF NOT EXISTS report_inputs (
  report_id TEXT PRIMARY KEY REFERENCES holter_reports(id), inputs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id),
  score REAL NOT NULL, band TEXT NOT NULL, analyzed_at TEXT NOT NULL, inputs TEXT NOT NULL, model_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_analyses_patient ON analyses(patient_id, analyzed_at);
CREATE TABLE IF NOT EXISTS factors (
  analysis_id TEXT NOT NULL REFERENCES analyses(id), key TEXT NOT NULL, name TEXT NOT NULL,
  grp TEXT NOT NULL, value_text TEXT NOT NULL, contribution REAL NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, key)
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id),
  status TEXT NOT NULL CHECK (status IN ('new','ack','done')), seen INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT, sent_at TEXT NOT NULL, ack_at TEXT, done_at TEXT, re INTEGER NOT NULL DEFAULT 0,
  re_at TEXT, esc_at TEXT, re_min INTEGER NOT NULL, esc_min INTEGER NOT NULL, channels TEXT NOT NULL,
  skip INTEGER NOT NULL DEFAULT 0, reason TEXT, skip_note TEXT, acts TEXT NOT NULL DEFAULT '[]',
  other_text TEXT, memo TEXT, memo_at TEXT, changed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON alerts(patient_id, sent_at);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human','system')), patient_id TEXT, alert_id TEXT,
  analysis_id TEXT, event TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
"""

DEFAULT_SETTINGS = {
    "threshold": 0.40,
    "re_min": 30,
    "esc_min": 60,
    "channels": {"app": True, "web": True, "sms": False},
}


def now() -> datetime:
    return datetime.now(KST)


def iso(dt: datetime | None = None) -> str:
    return (dt or now()).isoformat(timespec="seconds")


def initialize_database() -> Path:
    global _db_path
    path = Path(os.environ.get("SQLITE_PATH", "data/service.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=5)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(SCHEMA)
    _db_path = path
    return path


def check_database(path: Path) -> None:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=rw", uri=True, timeout=2)) as connection:
        connection.execute("PRAGMA schema_version").fetchone()


@contextmanager
def connect(*, root=False):
    """Autocommit connection: every statement is committed immediately."""
    assert _db_path is not None, "database is not initialized"
    connection = sqlite3.connect(_db_path if root else (_workspace.get() or _db_path), timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        yield connection
    finally:
        connection.close()


def next_id(conn: sqlite3.Connection, name: str) -> str:
    conn.execute("INSERT INTO seq(name, n) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET n = n + 1", (name,))
    return f"{name}-{conn.execute('SELECT n FROM seq WHERE name=?', (name,)).fetchone()[0]}"


def next_number(conn: sqlite3.Connection, name: str) -> int:
    return int(next_id(conn, name).split("-")[1])


def get_settings(conn: sqlite3.Connection) -> dict:
    values = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        values[row["key"]] = json.loads(row["value"])
    return values


def set_setting(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )
