"""SQLite online backup, executed inside the backend container."""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

path = Path(os.environ['SQLITE_PATH'])
folder = path.parent / 'backups'
folder.mkdir(exist_ok=True)
output = folder / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
with sqlite3.connect(f'{path.as_uri()}?mode=rw', uri=True) as source:
    with sqlite3.connect(output) as target:
        source.backup(target)
print('Database backup completed')
