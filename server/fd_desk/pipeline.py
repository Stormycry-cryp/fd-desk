from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from uuid import uuid4

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from .core import LINES, ROOT, ApiProblem, now, validate_week
from .jobs import DAILY_LIMIT_KINDS
from .model_capacity import ModelCapacity
from .views import meta

STEPS = ("facts", "profiles", "movement", "opportunities", "followups", "monitor")


class PipelineInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: list[str] | None = None
    week: str | None = None


class Pipeline:
    def __init__(self, context):
        self.context = context
        self.repo = context.repo
        self.store = context.store
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fd-pipeline")
        self.active = {}

    def status(self):
        history = sorted(self.repo.find("pipeline"), key=lambda item: item["startedAt"], reverse=True)[:30]
        settings = self.store.settings()["pipeline"]
        initialization = self.repo.find("profile_initialization")
        return {"latest": history[0] if history else None, "history": history,
                "initialization": {**initialization[0], **self.context.profiles.initialization_counts()} if initialization else None,
                "capacity": ModelCapacity(ROOT / "data").status(),
                "limits": {"profilesPerRun": settings["profilesPerRun"], "concurrency": min(3, settings["concurrency"])}}

    def create(self, steps=None, week=None, trigger="manual", *, initialize=False):
        selected = list(STEPS) if steps is None else steps
        if not selected or len(set(selected)) != len(selected) or set(selected) - set(STEPS):
            raise ApiProblem(422, "invalid_pipeline_steps", "流水线步骤必须来自事实、档案、变动、机会、跟进和监控，且不能重复")
        selected = [kind for kind in STEPS if kind in selected]
        if week:
            week = validate_week(week)
        with self.store.lock:
            current = next((item for item in self.repo.find("pipeline") if item["finishedAt"] is None), None)
            if current:
                initial_run = any(item["id"] == current["id"] for item in self.repo.find("profile_init"))
                if [step["kind"] for step in current["steps"]] != selected or current["week"] != week or initial_run != initialize:
                    raise ApiProblem(409, "pipeline_running", "已有流水线正在执行，请等待完成后提交所选步骤")
                return current
            item = {"id": uuid4().hex, "trigger": trigger, "week": week,
                    "steps": [{"kind": kind, "state": "queued", "progress": {"done": 0, "total": 0}, "detail": None,
                               "error": None, "startedAt": None, "finishedAt": None} for kind in selected],
                    "startedAt": now(), "finishedAt": None}
            self.repo.save("pipeline", item)
            if initialize:
                self.repo.save("profile_init", {"id": item["id"]})
                previous = self.repo.find("profile_initialization")
                self.repo.save("profile_initialization", {"id": "all", "state": "running",
                    "requestedAt": previous[0]["requestedAt"] if previous else now(), "nextAttemptAt": None})
            self.active[item["id"]] = self.executor.submit(self.execute, item["id"])
            self.active[item["id"]].add_done_callback(lambda future: self.active.pop(item["id"], None))
            return item

    def update(self, run_id, index, **changes):
        with self.store.lock:
            item = self.repo.get("pipeline", run_id)
            item["steps"][index].update(changes)
            self.repo.save("pipeline", item)

    def execute(self, run_id):
        run = self.repo.get("pipeline", run_id)
        for index, step in enumerate(run["steps"]):
            if step["state"] == "done":
                continue
            self.update(run_id, index, state="running", startedAt=now(), error=None)
            try:
                self.execute_step(run_id, index, step["kind"], run["week"])
            except Exception as error:  # noqa: BLE001 记录独立步骤错误，继续执行后续步骤
                self.update(run_id, index, state="failed", finishedAt=now(), error=error.payload if isinstance(error, ApiProblem) else {"code": "pipeline_failed", "message": f"流水线步骤失败：{type(error).__name__}"})
                continue
            item = self.repo.get("pipeline", run_id)["steps"][index]
            self.update(run_id, index, state="done", finishedAt=now(), progress={"done": item["progress"]["total"], "total": item["progress"]["total"]})
        with self.store.lock:
            run = self.repo.get("pipeline", run_id)
            run["finishedAt"] = now()
            self.repo.save("pipeline", run)
            if any(item["id"] == run_id for item in self.repo.find("profile_init")):
                initial = self.repo.get("profile_initialization", "all")
                delay = 60 if any(step["state"] == "failed" or not step["progress"]["total"] for step in run["steps"]) else 0
                initial.update(state="waiting", nextAttemptAt=(datetime.fromisoformat(now()) + timedelta(seconds=delay)).isoformat(timespec="seconds"))
                self.repo.save("profile_initialization", initial)

    def execute_step(self, run_id, index, kind, week):
        context = self.context
        with self.store.lock:
            context.engine.refresh()
            metadata = meta(context.engine)
        complete = {line: [value["week"] for value in metadata["coverage"] if value["line"] == line and value["complete"] and (week is None or value["week"] == week)] for line in LINES}
        targets = {line: max(values) for line, values in complete.items() if values}
        if kind == "facts":
            with self.store.connection() as conn:
                enterprises = [row[0] for row in conn.execute("SELECT DISTINCT enterprise_id FROM tasks")]
            total = len(enterprises)
            self.update(run_id, index, progress={"done": 0, "total": total})
            for done, enterprise in enumerate(enterprises, 1):
                with self.store.lock:
                    context.profiles.facts(enterprise)
                self.update(run_id, index, progress={"done": done, "total": total})
            return
        if kind == "profiles":
            with self.store.lock:
                batches = [item for item in self.repo.find("profile_batch") if item["id"] == run_id]
                if batches:
                    batch = batches[0]
                else:
                    batch = {"id": run_id, "enterprises": context.profiles.pending(self.store.settings()["pipeline"]["profilesPerRun"]), "jobs": {}}
                    self.repo.save("profile_batch", batch)
            pending = batch["enterprises"]
            self.update(run_id, index, progress={"done": 0, "total": len(pending)})
            for offset in range(0, len(pending), 10):
                jobs = []
                try:
                    for enterprise in pending[offset:offset + 10]:
                        with self.store.lock:
                            if enterprise not in batch["jobs"]:
                                run = self.repo.get("pipeline", run_id)
                                previous = next((item for item in self.repo.find("job") if item.get("operation") == "profile" and item.get("payload", {}).get("enterprise") == enterprise and item["job"]["createdAt"] >= run["startedAt"]), None)
                                job = previous["job"] if previous else context.profiles.refresh(enterprise)
                                batch["jobs"][enterprise] = job["id"]
                                self.repo.save("profile_batch", batch)
                            jobs.append(batch["jobs"][enterprise])
                finally:
                    self.wait_jobs(run_id, index, jobs, offset, len(pending))
            return
        if kind in ("movement", "opportunities"):
            jobs = []
            try:
                for line, target_week in targets.items():
                    if kind == "movement":
                        with self.store.lock:
                            selected = context.movements.candidates(line, target_week)
                        for candidate in selected["up"] + selected["down"]:
                            with self.store.lock:
                                item = context.movements.create(candidate["enterprise"], line, target_week, "auto")
                            jobs.append(item["id"])
                    else:
                        jobs.append(context.templates.refresh_opportunities(line, target_week)["id"])
            finally:
                self.update(run_id, index, progress={"done": 0, "total": len(jobs)})
                self.wait_jobs(run_id, index, jobs, 0, len(jobs))
            if not jobs:
                self.update(run_id, index, detail="当前范围没有完整周或没有符合条件的企业")
            return
        if kind in ("followups", "monitor"):
            self.update(run_id, index, progress={"done": 0, "total": len(LINES)})
            for done, line in enumerate(LINES, 1):
                with self.store.lock:
                    if kind == "followups" and line in targets:
                        context.followups.suggest(line, targets[line])
                    elif kind == "monitor":
                        context.templates.monitor(line)
                self.update(run_id, index, progress={"done": done, "total": len(LINES)})

    def wait_jobs(self, run_id, index, jobs, offset, total):
        failures = []
        for number, job_id in enumerate(jobs, offset + 1):
            try:
                self.context.jobs.wait(job_id)
            except ApiProblem:
                failures.append(job_id)
            self.update(run_id, index, progress={"done": number, "total": total})
        if failures:
            raise ApiProblem(422, "pipeline_jobs_failed", f"本步骤有{len(failures)}项任务失败，可通过任务编号查看错误：{','.join(failures)}")

    def consume_event(self):
        with self.store.lock:
            with self.store.connection() as conn:
                row = conn.execute("SELECT value FROM metadata WHERE key='pipeline_pending'").fetchone()
            if row is None or any(item["finishedAt"] is None for item in self.repo.find("pipeline")):
                return
            self.create(trigger="collector")
            with self.store.connection() as conn:
                conn.execute("DELETE FROM metadata WHERE key='pipeline_pending' AND value=?", (row[0],))

    def consume_initialization(self):
        with self.store.lock:
            pending = self.repo.find("profile_initialization")
            if not pending or pending[0]["state"] == "complete":
                return
            initial = pending[0]
            if any(item["finishedAt"] is None for item in self.repo.find("pipeline")):
                return
            counts = self.context.profiles.initialization_counts()
            if not counts["remaining"]:
                initial.update(state="complete", nextAttemptAt=None)
                self.repo.save("profile_initialization", initial)
                return
            if initial["nextAttemptAt"] and initial["nextAttemptAt"] > now():
                return
            today = now()[:10]
            marks = ",".join("?" for _ in DAILY_LIMIT_KINDS)
            with self.store.connection() as conn:
                used = conn.execute(f"SELECT COUNT(*) FROM rework_objects WHERE kind='job' AND substr(json_extract(value,'$.job.createdAt'),1,10)=? AND json_extract(value,'$.job.kind') IN ({marks})", (today, *sorted(DAILY_LIMIT_KINDS))).fetchone()[0]
            if used >= self.store.settings()["pipeline"]["dailyJobs"]:
                tomorrow = (datetime.fromisoformat(now()) + timedelta(days=1)).replace(hour=0, minute=1, second=0, microsecond=0)
                initial.update(state="daily_limit", nextAttemptAt=tomorrow.isoformat())
                self.repo.save("profile_initialization", initial)
                return
            self.create(["profiles"], initialize=True)

    def recover(self):
        for item in self.repo.find("pipeline"):
            if item["finishedAt"] is None:
                self.active[item["id"]] = self.executor.submit(self.execute, item["id"])

    def shutdown(self):
        self.executor.shutdown(wait=True)


def queue_event(store):
    with store.lock, store.connection() as conn:
        conn.execute("INSERT OR REPLACE INTO metadata VALUES ('pipeline_pending',?)", (now(),))


def mount(app: FastAPI, context):
    @app.post("/api/profiles/init")
    def initialize_profiles():
        return context.pipeline.create(["profiles"], initialize=True)

    @app.get("/api/pipeline")
    def get_pipeline():
        return context.pipeline.status()

    @app.post("/api/pipeline/run")
    def run_pipeline(body: PipelineInput):
        return context.pipeline.create(body.steps, body.week)

    @app.get("/api/jobs/{key}")
    def get_job(key: str):
        return context.jobs.get(key)
