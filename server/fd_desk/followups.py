import json
from statistics import median
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from .core import ApiProblem, Line, digest, now, shift_week, validate_week, week_key
from .engine import rate, ref
from .models import Pool
from .workflow import authored

STATES = {"draft": "todo", "assigned": "todo", "sent": "contacted", "replied": "replied", "closed": "shelved"}
GOALS = {"keep": "保住", "help": "帮助", "recall": "召回", "retain": "维持", "nurture": "培育", "convert": "转化"}


class AttachmentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["template", "opportunity", "chain", "movement", "trial", "case"]
    id: str


class FollowupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line: Line
    week: str
    enterprise: str
    goal: Pool
    reason: str = ""
    script: str = ""
    attachments: list[AttachmentInput] | None = Field(default=None, max_length=20)


class FollowupPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    goal: Pool | None = None
    state: Literal["todo", "contacted", "replied", "shelved"] | None = None
    script: str | None = None
    reply: str | None = None
    suggested: bool | None = None
    attachments: list[AttachmentInput] | None = Field(default=None, max_length=20)


class Followups:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        self.engine = context.engine
        with self.store.lock, self.store.connection() as conn:
            migrated = conn.execute("SELECT 1 FROM rework_objects WHERE kind='migration' AND id='followups-v1'").fetchone()
            if not migrated:
                for old in self.store.items("touches"):
                    if old["suggested"] and old["goal"] == "convert":
                        continue
                    self.repo.save("followup", self.from_legacy(old), conn=conn)
                self.repo.save("migration", {"id": "followups-v1", "at": now()}, conn=conn)

    @staticmethod
    def from_legacy(old):
        return {"id": old["id"], "line": old["line"], "week": old["week"], "enterprise": old["enterprise"],
                "goal": old["goal"], "reason": "；".join(old["evidence"]), "evidence": [], "attachments": [],
                "script": old["draft"], "state": STATES[old["status"]], "reply": old["reply"],
                "contactedAt": old["sentAt"], "outcome": old.get("outcome"), "suggested": old["suggested"], "rank": None}

    def annotate(self, item, conn):
        text = f"{'已联系' if item['state'] == 'contacted' else '已回复'}；跟进目的：{GOALS[item['goal']]}。"
        if item["reply"]:
            text += f"客户回复：{item['reply']}"
        stamp = now()
        annotation = {"id": uuid4().hex, "enterprise": item["enterprise"], "kind": "followup", "anchor": None,
                      "entries": [{"id": uuid4().hex, "text": text, "createdAt": stamp, "editedAt": None}],
                      "resolved": False, "createdAt": stamp, "updatedAt": stamp}
        self.repo.save("annotation", annotation, conn=conn)

    def sync_legacy(self, old):
        if old["suggested"] and old["goal"] == "convert":
            return
        with self.store.lock, self.store.connection() as conn:
            previous = conn.execute("SELECT value FROM rework_objects WHERE kind='followup' AND id=?", (old["id"],)).fetchone()
            item = self.from_legacy(old)
            if previous:
                previous = json.loads(previous[0])
                item.update(evidence=previous["evidence"], attachments=previous["attachments"], rank=previous["rank"])
            self.repo.save("followup", item, conn=conn)
            if item["state"] in ("contacted", "replied") and (previous is None or any(previous[field] != item[field] for field in ("state", "reply"))):
                self.annotate(item, conn)

    def attachment(self, kind, key, enterprise, line, week):
        target = {"page": "enterprise", "line": line, "week": week, "enterprise": enterprise}
        if kind == "case":
            fact = self.context.cases.fact(key)
            if fact.enterprise != enterprise or fact.line != line:
                raise ApiProblem(422, "invalid_attachment", "Case 与所选企业或产品线不一致")
            return {"kind": kind, "id": key, "label": f"{len(fact.indices)} 步 Case", "target": {"page": "cases", "line": line, "week": fact.week, "enterprise": enterprise, "filters": {"case": key, "unit": fact.unit}}}
        if kind == "template":
            item = self.context.templates.get(key)
            if item["line"] != line or item["kind"] == "custom" and item["target"]["id"] != enterprise:
                raise ApiProblem(422, "invalid_attachment", "模板与所选企业或产品线不一致")
            return {"kind": kind, "id": key, "label": item["current"]["content"]["title"], "target": {"page": "templates", "line": line, "draft": key}}
        if kind == "opportunity":
            item = next((value for value in self.context.templates.opportunities(line) if value["id"] == key), None)
            if item is None or item["target"] and item["target"]["id"] != enterprise:
                raise ApiProblem(422, "invalid_attachment", "模板机会与所选企业不一致")
            return {"kind": kind, "id": key, "label": item["title"], "target": {"page": "templates", "line": line, "filters": {"opportunity": key}}}
        if kind == "chain":
            self.engine.refresh()
            if key not in self.engine.chains:
                raise ApiProblem(404, "not_found", "连续尝试不存在")
            group = self.engine.frame.loc[self.engine.chains[key]]
            if set(group.enterprise_id) != {enterprise} or set(group.line) != {line}:
                raise ApiProblem(422, "invalid_attachment", "连续尝试与所选企业或产品线不一致")
            return {"kind": kind, "id": key, "label": f"{len(group)}次连续尝试", "target": {**target, "tab": "tasks", "section": "chains", "filters": {"chain": key}}}
        if kind == "movement":
            item = self.context.movements.get(key)
            if item["enterprise"]["id"] != enterprise or item["line"] != line:
                raise ApiProblem(422, "invalid_attachment", "变动分析与所选企业或产品线不一致")
            return {"kind": kind, "id": key, "label": item["headline"] or "变动原因分析", "target": {**target, "filters": {"movement": key}}}
        run = self.context.trials.get(key)
        if not any(case["task"]["enterprise"]["id"] == enterprise for case in run["cases"]):
            raise ApiProblem(422, "invalid_attachment", "试验记录没有所选企业的用例")
        return {"kind": kind, "id": key, "label": "试验台结果", "target": {"page": "playground", "line": line, "run": key}}

    def attachments(self, enterprise, line, week, goal):
        values = []
        if goal in ("retain", "recall"):
            templates = self.context.templates.list(line, kind="custom", enterprise=enterprise)
            for item in templates[:1]:
                values.append(self.attachment("template", item["id"], enterprise, line, week))
            opportunities = self.context.templates.opportunities(line, kind="custom", enterprise=enterprise)
            for item in opportunities[:1]:
                values.append(self.attachment("opportunity", item["id"], enterprise, line, week))
        elif goal == "help":
            chains = self.engine.chain_list(line, week, enterprise, downloaded=False)["items"]
            for item in chains[:1]:
                values.append(self.attachment("chain", item["id"], enterprise, line, week))
            runs = [run for run in self.repo.find("trial") if any(case["task"]["enterprise"]["id"] == enterprise for case in run["cases"])]
            for run in runs[:1]:
                values.append(self.attachment("trial", run["id"], enterprise, line, week))
        elif goal == "keep":
            movements = [item for item in self.context.movements.list(line, week) if item["enterprise"]["id"] == enterprise]
            for item in movements[:1]:
                values.append(self.attachment("movement", item["id"], enterprise, line, week))
        return values

    def create(self, body):
        enterprise = self.store.enterprise(body.enterprise)
        week = validate_week(body.week)
        item = {"id": uuid4().hex, "line": body.line, "week": week, "enterprise": ref(enterprise), "goal": body.goal,
                "reason": body.reason, "evidence": [], "attachments": [self.attachment(value.kind, value.id, body.enterprise, body.line, week) for value in body.attachments] if body.attachments is not None else self.attachments(body.enterprise, body.line, week, body.goal),
                "script": authored(body.script, "manual"), "state": "todo", "reply": None, "contactedAt": None,
                "outcome": None, "suggested": False, "rank": None}
        return self.repo.save("followup", item)

    def suggest(self, line, week):
        validate_week(week)
        self.engine.refresh()
        rows = [row for row in self.engine.base_roster(line, week) if row["pool"] and row["pool"] != "convert" and not row["excluded"]]
        priorities = {"keep": 5, "help": 4, "recall": 3, "retain": 2, "nurture": 1}
        rows.sort(key=lambda row: (-priorities[row["pool"]], -abs((row.get("comparable") or {}).get("current", row["tasks"]) - (row.get("comparable") or {}).get("previous", 0)), -row["tasks"], row["enterprise"]["id"]))
        existing = self.repo.find("followup", line=line, week=week)
        accepted = {item["enterprise"]["id"] for item in existing if not item["suggested"]}
        limit = self.store.settings()["followups"]["suggestionsPerWeek"]
        selected = [row for row in rows if row["enterprise"]["id"] not in accepted][:limit]
        retained = set()
        with self.store.connection() as conn:
            for rank, row in enumerate(selected, 1):
                enterprise = row["enterprise"]["id"]
                prior = next((item for item in existing if item["suggested"] and item["enterprise"]["id"] == enterprise), None)
                key = prior["id"] if prior else digest(f"followup:{line}:{week}:{enterprise}")
                retained.add(key)
                pair = row.get("comparable")
                reason = f"按{GOALS[row['pool']]}类影响排序第{rank}；本周{row['tasks']}个任务、{row['activeDays']}个使用日"
                if pair:
                    reason += f"，同星期用量{pair['previous']}→{pair['current']}"
                evidence = [{"label": "本周任务数", "value": str(row["tasks"]), "target": {"page": "enterprise", "enterprise": enterprise, "line": line, "week": week, "tab": "data", "section": "facts.weekly"}}]
                if "low_points" in row["alerts"]:
                    account = row["account"]
                    reason += f"；账户剩余{account['remaining']:g}点，近七日消耗{account['used7d']:g}点"
                    evidence.append({"label": "剩余点数", "value": str(account["remaining"]), "target": {"page": "enterprise", "enterprise": enterprise, "line": line, "week": week, "tab": "data", "section": "account"}})
                item = {"id": key, "line": line, "week": week, "enterprise": row["enterprise"], "goal": row["pool"], "reason": reason,
                        "evidence": evidence, "attachments": self.attachments(enterprise, line, week, row["pool"]),
                        "script": prior["script"] if prior else authored("", "rule"), "state": "todo", "reply": None, "contactedAt": None,
                        "outcome": None, "suggested": True, "rank": rank}
                self.repo.save("followup", item, conn=conn)
            for item in existing:
                if item["suggested"] and item["id"] not in retained:
                    self.repo.delete("followup", item["id"], conn)
        return selected

    def outcome(self, item):
        if not item["contactedAt"]:
            return None
        self.engine.refresh()
        line, enterprise = item["line"], item["enterprise"]["id"]
        week = week_key(item["contactedAt"])
        following = shift_week(week, 1)
        if not self.engine.coverage(line, week)["complete"] or not self.engine.coverage(line, following)["complete"]:
            return None
        before, after = self.engine.group(line, week, enterprise), self.engine.group(line, following, enterprise)
        touched = {value["enterprise"]["id"] for value in self.repo.find("followup", line=line) if value["contactedAt"] and week_key(value["contactedAt"]) == week}
        controls = []
        for row in self.engine.base_roster(line, week):
            if row["pool"] == item["goal"] and row["enterprise"]["id"] not in touched and not row["excluded"]:
                controls.append(len(self.engine.group(line, following, row["enterprise"]["id"])) - len(self.engine.group(line, week, row["enterprise"]["id"])))
        return {"week": following, "tasks": {"previous": len(before), "current": len(after)},
                "downloadRate": {"previous": rate(before) if len(before) else None, "current": rate(after) if len(after) else None},
                "templateUsed": None, "control": {"enterprises": len(controls), "medianTaskChange": float(median(controls))} if controls else None}

    def board(self, line, week):
        items = self.repo.find("followup", line=line, week=validate_week(week))
        for item in items:
            item["outcome"] = self.outcome(item)
        return {"items": [item for item in items if not item["suggested"]],
                "suggestions": sorted((item for item in items if item["suggested"] and item["goal"] != "convert"), key=lambda item: item["rank"] or 10000)[:self.store.settings()["followups"]["suggestionsPerWeek"]]}

    def patch(self, key, body):
        item = self.repo.get("followup", key)
        changes = body.model_dump(exclude_unset=True)
        if changes.get("suggested") is True or any(value is None for field, value in changes.items() if field != "reply"):
            raise ApiProblem(422, "invalid_followup", "跟进字段不能为空，已处理内容不能重新设为建议")
        if "script" in changes:
            changes["script"] = authored(changes["script"], "manual")
        if "attachments" in changes:
            changes["attachments"] = [self.attachment(value["kind"], value["id"], item["enterprise"]["id"], item["line"], item["week"]) for value in changes["attachments"]]
        previous_state, previous_reply = item["state"], item["reply"]
        item.update(changes, suggested=False)
        if item["state"] in ("contacted", "replied") and not item["contactedAt"]:
            item["contactedAt"] = now()
        item["outcome"] = self.outcome(item)
        with self.store.connection() as conn:
            self.repo.save("followup", item, conn=conn)
            if item["state"] in ("contacted", "replied") and (item["state"] != previous_state or item["reply"] != previous_reply):
                self.annotate(item, conn)
            old = conn.execute("SELECT value FROM touches WHERE id=?", (key,)).fetchone()
            if old:
                old = json.loads(old[0])
                old.update(goal=item["goal"], status={"todo": "draft", "contacted": "sent", "replied": "replied", "shelved": "closed"}[item["state"]],
                           draft=item["script"], reply=item["reply"], sentAt=item["contactedAt"], suggested=False)
                self.store.save("touches", old, conn)
        return item


def mount(app: FastAPI, context):
    @app.get("/api/followups")
    @context.cache.cached
    def get_followups(line: Line, week: str):
        with context.store.lock:
            return context.followups.board(line, week)

    @app.post("/api/followups")
    def create_followup(body: FollowupCreate):
        with context.store.lock:
            return context.followups.create(body)

    @app.patch("/api/followups/{key}")
    def patch_followup(key: str, body: FollowupPatch):
        with context.store.lock:
            return context.followups.patch(key, body)

    @app.delete("/api/followups/{key}", status_code=204)
    def delete_followup(key: str):
        with context.store.lock:
            context.repo.delete("followup", key)
