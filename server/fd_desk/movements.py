import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from . import views
from .core import ApiProblem, Line, now, shift_week, validate_week
from .engine import ref


class Reason(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=120)
    evidenceId: str


class MovementResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    headline: str = Field(min_length=1, max_length=40)
    reasons: list[Reason] = Field(min_length=2, max_length=3)
    action: str = Field(min_length=1, max_length=100)
    confidence: Literal["high", "medium", "low"]


class MovementCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprise: str
    line: Line
    week: str


class Movements:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        self.engine = context.engine
        context.jobs.register("movement", self.analyze)

    def candidates(self, line, week):
        self.engine.refresh()
        if not self.engine.coverage(line, week)["complete"]:
            return {"up": [], "down": []}
        current, previous, days = self.engine.comparable(line, week)
        if not days:
            return {"up": [], "down": []}
        before_tasks = previous.groupby("enterprise_id").size()
        eligible = before_tasks[before_tasks >= self.engine.settings["thresholds"][line]["moverBase"]].index
        before = previous.groupby("enterprise_id").points.sum() if line == "video" else before_tasks
        after = current.groupby("enterprise_id").points.sum() if line == "video" else current.groupby("enterprise_id").size()
        changes = []
        for enterprise in eligible:
            a, b = int(after.get(enterprise, 0)), int(before.get(enterprise, 0))
            if b and a != b:
                changes.append({"enterprise": str(enterprise), "current": a, "previous": b, "relative": (a - b) / b})
        return {
            "up": sorted((item for item in changes if item["relative"] > 0), key=lambda item: (-item["relative"], item["enterprise"]))[:5],
            "down": sorted((item for item in changes if item["relative"] < 0), key=lambda item: (item["relative"], item["enterprise"]))[:5],
        }

    def list(self, line, week, trigger=None):
        values = self.repo.find("movement", line=line, week=week)
        return [self.get(item["id"]) for item in values if trigger is None or item["trigger"] == trigger]

    def get(self, key):
        item = self.repo.get("movement", key)
        if item["state"] in ("queued", "running"):
            job = self.context.jobs.get(key)
            item.update(state=job["state"], error=job["error"])
        return item

    def create(self, enterprise, line, week, trigger="manual"):
        week = validate_week(week)
        entity = self.store.enterprise(enterprise)
        previous = next((item for item in self.list(line, week) if item["enterprise"]["id"] == enterprise and item["state"] in ("queued", "running", "done")), None)
        if previous:
            return self.get(previous["id"])
        current, before, days = self.engine.comparable(line, week, enterprise)
        if not days:
            raise ApiProblem(422, "no_comparable_data", "所选周没有可比较的同星期数据")
        value = lambda group: int(group.points.sum()) if line == "video" else len(group)
        a, b = value(current), value(before)
        if a == b:
            raise ApiProblem(422, "no_movement", "所选范围的用量没有变化")
        key = uuid4().hex
        item = {"id": key, "enterprise": ref(entity), "line": line, "week": week, "direction": "up" if a > b else "down",
                "change": {"current": a, "previous": b}, "headline": "", "reasons": [], "action": None,
                "confidence": "low", "trigger": trigger, "state": "queued", "error": None, "createdAt": now()}
        with self.store.lock:
            self.context.jobs.submit("movement", "movement", {"movement": key}, job_id=key)
            self.repo.save("movement", item)
        return item

    def input(self, item):
        enterprise, line, week = item["enterprise"]["id"], item["line"], item["week"]
        current, previous, days = self.engine.comparable(line, week, enterprise)
        value = lambda group: int(group.points.sum()) if line == "video" else len(group)
        catalog = {}

        def evidence(key, label, amount, section, task=None):
            target = {"page": "enterprise", "enterprise": enterprise, "line": line, "week": week, "tab": "data", "section": section}
            if task:
                target.update(tab="tasks", task=task)
            catalog[key] = {"label": label, "value": str(amount), "target": target}

        for label, part in (("current", current), ("previous", previous)):
            evidence(f"{label}.tasks", "本周任务数" if label == "current" else "上周同星期任务数", len(part), "facts.weekly")
            evidence(f"{label}.points", "本周耗点" if label == "current" else "上周同星期耗点", int(part.points.sum()), "facts.weekly")
            evidence(f"{label}.days", "本周使用天数" if label == "current" else "上周同星期使用天数", int(part.day.nunique()), "facts.weekly")
            evidence(f"{label}.failed", "本周失败次数" if label == "current" else "上周同星期失败次数", int(part.failed.sum()), "facts.quality")
            evidence(f"{label}.downloadRate", "本周下载率" if label == "current" else "上周同星期下载率", f"{views.rate(part):.1%}", "facts.quality")
            for dimension, section in (("intent" if line == "inspiration" else "mode", "facts.intents"), ("model", "facts.models"), ("user_id", "facts.weekly")):
                for name, group in part.groupby(dimension):
                    evidence(f"{label}.{dimension}.{name}", f"{label} {dimension} {name}", value(group), section, str(group.iloc[-1].row_key))
        history = []
        for offset in range(-7, 1):
            key = shift_week(week, offset)
            part = self.engine.group(line, key, enterprise)
            history.append({"week": key, "tasks": len(part), "points": int(part.points.sum()), "downloadRate": views.rate(part), "days": int(part.day.nunique())})
        start = date.fromisoformat(week) - timedelta(days=7)
        daily = views.daily(self.engine, line, start, date.fromisoformat(week) + timedelta(days=6), enterprise)
        chains = []
        for key, indices in self.engine.chains.items():
            part = self.engine.frame.loc[indices]
            if len(part) >= 3 and part.iloc[-1].enterprise_id == enterprise and part.iloc[-1].line == line and part.iloc[-1].week in (week, shift_week(week, -1)) and not part.downloaded.any():
                chains.append({"id": key, "tasks": [str(row) for row in part.row_key], "length": len(part)})
        profile = self.context.profiles.get(enterprise)
        return {"enterprise": item["enterprise"], "line": line, "week": week, "comparableWeekdays": days,
                "history": history, "daily": daily, "unresolvedChains": chains,
                "profile": {"headline": profile["headline"], "insights": profile["insights"], "tags": profile["tags"]},
                "annotations": profile["annotations"], "evidenceCatalog": catalog}, catalog

    def analyze(self, job_id, payload):
        item = self.repo.get("movement", payload["movement"])
        if item["state"] == "done":
            return {"movementId": item["id"]}
        with self.store.lock:
            item["state"] = "running"
            self.repo.save("movement", item)
            inputs, catalog = self.input(item)
        result = self.context.model.run("movement", inputs, MovementResult, job_id)
        with self.store.lock:
            _, current_catalog = self.input(item)
            discarded = []
            reasons = []
            for reason in result.reasons:
                if reason.evidenceId not in catalog or current_catalog.get(reason.evidenceId) != catalog[reason.evidenceId]:
                    discarded.append({"evidenceId": reason.evidenceId, "reason": "证据不存在或数据已经变化"})
                elif not self.numbers_valid(reason.text, catalog[reason.evidenceId]["value"], item):
                    discarded.append({"evidenceId": reason.evidenceId, "reason": "原因文字包含无法由关联证据复算的数字"})
                else:
                    reasons.append({"text": reason.text, "evidence": catalog[reason.evidenceId]})
            available = " ".join(reason["evidence"]["value"] for reason in reasons)
            for field in ("headline", "action"):
                if not self.numbers_valid(getattr(result, field), available, item):
                    discarded.append({"field": field, "reason": "结论或建议包含无法由关联证据复算的数字"})
            self.context.model.discarded(job_id, discarded)
            if len(reasons) < 2:
                raise ApiProblem(422, "insufficient_evidence", "模型原因缺少两项可复算的证据")
            if any("field" in entry for entry in discarded):
                raise ApiProblem(422, "unverified_number", "模型结论或建议包含无法核验的数字")
            item.update(headline=result.headline, reasons=reasons, action=result.action, confidence=result.confidence, state="done", error=None)
            self.repo.save("movement", item)
        return {"movementId": item["id"]}

    def numbers_valid(self, text, evidence, item):
        names = [item["enterprise"]["name"], *self.engine.frame.model.dropna().unique()]
        for name in sorted((str(value) for value in names), key=len, reverse=True):
            text = text.replace(name, "")
        def amounts(value):
            return {Decimal(token.rstrip("%")) / (100 if token.endswith("%") else 1) for token in re.findall(r"\d+(?:\.\d+)?%?", value)}
        return amounts(text) <= amounts(evidence or "")


def mount(app: FastAPI, context):
    movements = context.movements

    @app.get("/api/movements")
    @context.cache.cached
    def get_movements(line: Line, week: str, trigger: Literal["auto", "manual"] | None = None):
        with context.store.lock:
            return [movements.get(item["id"]) for item in movements.list(line, validate_week(week), trigger)]

    @app.post("/api/movements")
    def create_movement(body: MovementCreate):
        with context.store.lock:
            return movements.create(body.enterprise, body.line, body.week)

    @app.get("/api/movements/{key}")
    def get_movement(key: str):
        with context.store.lock:
            return movements.get(key)
