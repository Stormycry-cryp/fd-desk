import json
from concurrent.futures import ThreadPoolExecutor
from threading import Condition, RLock
from uuid import uuid4

from .core import ApiProblem, digest, now

MODEL_KINDS = {"profiles", "movement", "opportunities", "draft_write", "finding_recheck", "record_analysis"}


class Jobs:
    def __init__(self, repo, store):
        self.repo = repo
        self.store = store
        self.handlers = {}
        self.active = {}
        self.lock = RLock()
        self.gate = Condition()
        self.running = 0
        self.executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="fd-analysis")
        self.utility = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fd-exports")

    def register(self, operation, handler):
        if operation in self.handlers:
            raise ValueError("任务处理器已经注册")
        self.handlers[operation] = handler

    def get(self, key):
        return self.repo.get("job", key)["job"]

    def submit(self, kind, operation, payload, *, signature=None, total=1, job_id=None, objects=()):
        if operation not in self.handlers:
            raise ValueError("任务处理器尚未注册")
        with self.store.lock, self.lock:
            today = now()[:10]
            limit = self.store.settings()["pipeline"]["dailyJobs"]
            with self.store.connection() as conn:
                if signature:
                    found = conn.execute("SELECT value FROM rework_objects WHERE kind='job' AND json_extract(value,'$.signature')=? AND state IN ('queued','running','done') LIMIT 1", (signature,)).fetchone()
                    if found:
                        return json.loads(found[0])["job"]
                marks = ",".join("?" for _ in MODEL_KINDS)
                used = conn.execute(f"SELECT COUNT(*) FROM rework_objects WHERE kind='job' AND substr(json_extract(value,'$.job.createdAt'),1,10)=? AND json_extract(value,'$.job.kind') IN ({marks})", (today, *sorted(MODEL_KINDS))).fetchone()[0]
            if kind in MODEL_KINDS and used >= limit:
                raise ApiProblem(409, "analysis_daily_limit", f"今日模型任务已达到{limit}项上限")
            key = job_id or uuid4().hex
            job = {"id": key, "kind": kind, "state": "queued", "progress": {"done": 0, "total": total},
                   "result": None, "error": None, "createdAt": now(), "finishedAt": None}
            record = {"id": key, "job": job, "operation": operation, "payload": payload, "signature": signature}
            with self.store.connection() as conn:
                for object_kind, value in objects:
                    self.repo.save(object_kind, value, conn=conn)
                self.repo.save("job", record, state="queued", conn=conn)
            self.enqueue(key, kind)
            return job

    def _run(self, key):
        with self.gate:
            while self.running >= min(3, self.store.settings()["pipeline"]["concurrency"]):
                self.gate.wait(timeout=1)
            self.running += 1
        try:
            return self.execute(key)
        finally:
            with self.gate:
                self.running -= 1
                self.gate.notify_all()

    def enqueue(self, key, kind):
        future = self.executor.submit(self._run, key) if kind in MODEL_KINDS else self.utility.submit(self.execute, key)
        self.active[key] = future
        future.add_done_callback(lambda finished: self.forget(key))

    def forget(self, key):
        with self.lock:
            self.active.pop(key, None)

    def execute(self, key):
        with self.store.lock, self.lock:
            record = self.repo.get("job", key)
            record["job"].update(state="running", error=None, finishedAt=None)
            self.repo.save("job", record, state="running")
        try:
            result = self.handlers[record["operation"]](key, record["payload"])
        except Exception as error:
            with self.store.lock, self.lock:
                record = self.repo.get("job", key)
                record["job"].update(state="failed", error=error.payload if isinstance(error, ApiProblem) else {"code": "job_failed", "message": f"任务执行失败：{type(error).__name__}"}, finishedAt=now())
                self.repo.save("job", record, state="failed")
            raise
        with self.store.lock, self.lock:
            record = self.repo.get("job", key)
            record["job"].update(state="done", result=result, finishedAt=now())
            record["job"]["progress"]["done"] = record["job"]["progress"]["total"]
            self.repo.save("job", record, state="done")
        return result

    def progress(self, key, done, total):
        if not 0 <= done <= total:
            raise ValueError("任务进度超出范围")
        with self.store.lock, self.lock:
            record = self.repo.get("job", key)
            record["job"]["progress"] = {"done": done, "total": total}
            self.repo.save("job", record, state=record["job"]["state"])

    def recover(self):
        with self.store.lock, self.lock:
            for record in self.repo.find("job"):
                if record["job"]["state"] in ("queued", "running") and record["operation"] in self.handlers:
                    self.enqueue(record["id"], record["job"]["kind"])

    def wait(self, key):
        future = self.active.get(key)
        if future is not None:
            try:
                future.result()
            except Exception:
                job = self.get(key)
                if job["state"] != "failed":
                    raise
                raise ApiProblem(422, job["error"]["code"], job["error"]["message"]) from None
        job = self.get(key)
        if job["state"] == "failed":
            raise ApiProblem(422, job["error"]["code"], job["error"]["message"])
        return job

    def shutdown(self):
        self.utility.shutdown(wait=True)
        self.executor.shutdown(wait=True)


def signature(kind, payload, revision):
    from .core import dump
    return digest(f"{kind}:{revision}:{dump(payload)}")
