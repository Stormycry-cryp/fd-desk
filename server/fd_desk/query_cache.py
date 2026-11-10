from collections import OrderedDict
from functools import wraps

import orjson
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool


class QueryCache:
    def __init__(self, store, max_bytes=32 * 1024 * 1024, max_entries=256):
        self.store = store
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.entries = OrderedDict()
        self.bytes = 0
        self.version = None

    def lookup(self, key):
        version = self.store.generation
        if version != self.version:
            self.entries.clear()
            self.bytes = 0
            self.version = version
        content = self.entries.get(key)
        if content is not None:
            self.entries.move_to_end(key)
        return version, content

    def cached(self, function):
        def calculate(key, args, kwargs):
            with self.store.lock:
                version, content = self.lookup(key)
                if content is not None:
                    return Response(content, media_type="application/json")
                value = function(*args, **kwargs)
                content = orjson.dumps(value, option=orjson.OPT_SERIALIZE_NUMPY)
                if self.store.generation == version and len(content) <= self.max_bytes:
                    while self.entries and (len(self.entries) >= self.max_entries or self.bytes + len(content) > self.max_bytes):
                        _, expired = self.entries.popitem(last=False)
                        self.bytes -= len(expired)
                    self.entries[key] = content
                    self.bytes += len(content)
                return Response(content, media_type="application/json")

        @wraps(function)
        async def read(*args, **kwargs):
            key = (function.__name__, args, tuple(sorted(kwargs.items())))
            if self.store.lock.acquire(blocking=False):
                try:
                    _, content = self.lookup(key)
                finally:
                    self.store.lock.release()
                if content is not None:
                    return Response(content, media_type="application/json")
            return await run_in_threadpool(calculate, key, args, kwargs)

        return read
