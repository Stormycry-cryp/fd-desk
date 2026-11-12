import os
import sqlite3
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


def process_start(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, check=False,
                            env={**os.environ, "LC_ALL": "C"})
    return result.stdout.strip()


class ModelCapacity:
    def __init__(self, directory):
        service = Path(directory) / "service"
        service.mkdir(parents=True, exist_ok=True)
        self.path = service / "model-capacity.sqlite3"
        with self.connection() as connection:
            connection.executescript(Path(__file__).with_suffix(".sql").read_text())

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def reap(self, connection):
        owners = connection.execute("SELECT DISTINCT pid,process_start FROM model_capacity_requests").fetchall()
        for owner in owners:
            if process_start(owner["pid"]) != owner["process_start"]:
                connection.execute("DELETE FROM model_capacity_requests WHERE pid=? AND process_start=?", tuple(owner))

    def ready(self, key):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.reap(connection)
            first = connection.execute("SELECT id FROM model_capacity_next").fetchone()
            used = connection.execute("SELECT COUNT(*) FROM model_capacity_requests WHERE state='running'").fetchone()[0]
            maximum = connection.execute("SELECT total_limit-reserved_slots FROM model_capacity_limits WHERE id=1").fetchone()[0]
            if first is None or first[0] != key or used >= maximum:
                return False
            connection.execute("UPDATE model_capacity_requests SET state='running' WHERE id=?", (key,))
            return True

    def bind(self, key, pid, stamp):
        if not stamp:
            raise RuntimeError("模型进程启动时间不可用")
        with self.connection() as connection:
            if connection.execute("UPDATE model_capacity_requests SET pid=?,process_start=? WHERE id=? AND state='running'", (pid, stamp, key)).rowcount != 1:
                raise RuntimeError("模型并发名额已经失效")

    @contextmanager
    def acquire(self, category):
        key = uuid4().hex
        stamp = process_start(os.getpid())
        if not stamp:
            raise RuntimeError("当前进程启动时间不可用")
        with self.connection() as connection:
            connection.execute("INSERT INTO model_capacity_requests(id,pid,process_start,category,state) VALUES (?,?,?,?,'queued')", (key, os.getpid(), stamp, category))
        try:
            while not self.ready(key):
                time.sleep(.25)
            yield key
        finally:
            with self.connection() as connection:
                connection.execute("DELETE FROM model_capacity_requests WHERE id=?", (key,))

    def status(self):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.reap(connection)
            rows = connection.execute("SELECT category,state,COUNT(*) AS count FROM model_capacity_requests GROUP BY category,state").fetchall()
        return {"totalLimit": 5, "reservedSlots": 1, "serviceLimit": 4, "backgroundLimit": 3,
                "running": sum(row["count"] for row in rows if row["state"] == "running"),
                "queued": sum(row["count"] for row in rows if row["state"] == "queued"),
                "categories": [dict(row) for row in rows]}
