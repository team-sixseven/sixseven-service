"""Account-owned demo databases; authentication remains in the original database."""
import asyncio
import hashlib
import os
import sqlite3
from contextlib import closing

from . import database

_tasks: dict[str, list[asyncio.Task]] = {}


def enabled():
    return (os.environ.get('ISOLATED_DEMO', 'false').lower() == 'true'
            and os.environ.get('DEMO_MODE', 'false').lower() == 'true'
            and bool(os.environ.get('MUSIC_DATA_PATH')))


def ensure_database(user):
    from . import music_data
    root = database._db_path
    folder = root.parent / 'workspaces'
    folder.mkdir(exist_ok=True)
    name = hashlib.sha256(user['id'].encode()).hexdigest()
    path = folder / (name + '.sqlite3')
    if path.exists():
        return path
    temporary = folder / (name + '.creating')
    # Called on the event loop before any await; concurrent requests cannot interleave creation.
    try:
        with closing(sqlite3.connect(root)) as source, closing(sqlite3.connect(temporary)) as target:
            source.backup(target)
        with database.use_workspace(temporary):
            with database.connect() as conn:
                conn.execute('DELETE FROM auth_tokens')
                conn.execute('DELETE FROM users WHERE id != ?', (user['id'],))
                conn.execute("UPDATE users SET password_hash='workspace-auth-disabled'")
                if user['role'] != 'admin':
                    music_data.reset_reception(conn)
                conn.execute('UPDATE patients SET attending_id=?', (user['id'],))
                conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def start_workers(path):
    from . import pipeline
    from .main import reminder_loop
    key = str(path)
    tasks = _tasks.setdefault(key, [None, None])
    for index, factory in enumerate((pipeline.run_worker, reminder_loop)):
        if tasks[index] is None or tasks[index].done():
            tasks[index] = asyncio.create_task(factory())


async def stop_workers():
    from . import demo
    scheduled = [*demo._tasks, *(t for tasks in demo._workspace_tasks.values() for t in tasks)]
    demo.cancel_all_scheduled()
    running = [t for tasks in _tasks.values() for t in tasks if t is not None]
    for task in running:
        task.cancel()
    await asyncio.gather(*running, *scheduled, return_exceptions=True)
    for key in _tasks:
        from . import pipeline
        pipeline._wakes.pop(key, None)
    _tasks.clear()


class WorkspaceMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if not enabled() or scope['type'] not in ('http', 'websocket') or scope.get('path', '').startswith('/api/auth/'):
            return await self.app(scope, receive, send)
        from . import security
        from urllib.parse import parse_qs
        if scope['type'] == 'websocket':
            token = parse_qs(scope.get('query_string', b'').decode()).get('token', [None])[0]
        else:
            auth = dict(scope.get('headers', [])).get(b'authorization', b'').decode()
            token = auth[7:] if auth.lower().startswith('bearer ') else None
        user = security.user_for_token(token)
        if user is None:
            return await self.app(scope, receive, send)
        path = ensure_database(user)
        with database.use_workspace(path):
            start_workers(path)
            await self.app(scope, receive, send)
