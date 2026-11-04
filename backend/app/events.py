import asyncio
from typing import Any

from .database import iso

_subscribers: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}


def subscribe() -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _subscribers[queue] = asyncio.get_running_loop()
    return queue


def unsubscribe(queue: asyncio.Queue) -> None:
    _subscribers.pop(queue, None)


def publish(event_type: str, data: dict[str, Any]) -> None:
    event = {"type": event_type, "at": iso(), "data": data}

    def deliver(queue):
        if queue not in _subscribers:
            return
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            pass

    # FastAPI의 동기 API는 작업 스레드에서 실행되므로 큐의 이벤트 루프로 전달합니다.
    for queue, loop in list(_subscribers.items()):
        if not loop.is_closed():
            loop.call_soon_threadsafe(deliver, queue)
