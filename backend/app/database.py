import os
import sqlite3
from contextlib import closing
from pathlib import Path


def initialize_database() -> Path:
    path = Path(os.environ.get("SQLITE_PATH", "data/service.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=5)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
    return path


def check_database(path: Path) -> None:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=rw", uri=True, timeout=2)) as connection:
        connection.execute("PRAGMA schema_version").fetchone()
