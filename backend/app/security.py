import hashlib
import hmac
import secrets
import time
from datetime import timedelta

from .database import connect, iso, now

ITERATIONS = 200_000
TOKEN_HOURS = 12
MAX_FAILURES = 5
WINDOW_SEC = 600
_failures: dict[str, list[float]] = {}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, digest = stored.split("$")
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(candidate.hex(), digest)
    except ValueError:
        return False


# 없는 아이디도 같은 계산을 하도록 미리 만들어 둔 해시 (응답 시간으로 아이디 존재가 드러나지 않게)
DUMMY_HASH = hash_password(secrets.token_hex(8))


def is_locked(username: str) -> bool:
    cutoff = time.monotonic() - WINDOW_SEC
    recent = [t for t in _failures.get(username, []) if t > cutoff]
    _failures[username] = recent
    return len(recent) >= MAX_FAILURES


def record_failure(username: str) -> None:
    _failures.setdefault(username, []).append(time.monotonic())


def clear_failures(username: str) -> None:
    _failures.pop(username, None)


def authenticate(username: str, password: str) -> dict | None:
    with connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    ok = verify_password(password, user["password_hash"] if user else DUMMY_HASH)
    return dict(user) if user and ok else None


def issue_token(user_id: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    expires = iso(now() + timedelta(hours=TOKEN_HOURS))
    with connect() as conn:
        conn.execute("DELETE FROM auth_tokens WHERE expires_at < ?", (iso(),))
        conn.execute(
            "INSERT INTO auth_tokens(token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, user_id, iso(), expires),
        )
    return token, expires


def user_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token=? AND t.expires_at > ?",
            (token, iso()),
        ).fetchone()
    return dict(row) if row else None


def revoke_token(token: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM auth_tokens WHERE token=?", (token,))
