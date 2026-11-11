import re
from decimal import Decimal
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from . import analysis, views
from .core import ApiProblem, now
from .jobs import signature


class RecheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Literal["confirmed", "refuted", "open"]
    explanation: str = Field(min_length=1, max_length=250)
    evidenceIds: list[str] = Field(min_length=1, max_length=5)


class Findings:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        context.jobs.register("finding_recheck", self.recheck)
        with self.store.lock, self.store.connection() as conn:
            for item in self.store.items("findings"):
                if "rechecks" not in item:
                    self.store.save("findings", {**item, "rechecks": []}, conn)

    def create(self, key):
        with self.store.lock:
            self.store.item("findings", key)
            return self.context.jobs.submit("finding_recheck", "finding_recheck", {"finding": key}, signature=signature("finding_recheck", {"finding": key}, self.store.revisions()["facts_revision"]))

    def input(self, item):
        engine = self.context.engine
        engine.refresh()
        coverage = [value["week"] for value in views.meta(engine)["coverage"] if value["line"] == item["line"] and value["complete"]]
        if not coverage:
            raise ApiProblem(422, "complete_week_required", "重新核对需要至少一个完整周")
        week = max(coverage)
        overview = views.overview(engine, item["line"], week)
        matrix = getattr(analysis, item["line"])(engine, week)
        catalog = {}
        def add(path, value):
            if isinstance(value, dict):
                for key, child in value.items():
                    add(f"{path}.{key}", child)
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    add(f"{path}.{index}", child)
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                catalog[path] = value
        add("overview", overview)
        add("analysis", matrix)
        return {"finding": item, "week": week, "overview": overview, "analysis": matrix, "evidenceCatalog": catalog}, catalog

    def recheck(self, job_id, payload):
        with self.store.lock:
            if self.context.repo.find("finding_recheck_applied", state=job_id):
                return
            item = self.store.item("findings", payload["finding"])
            inputs, catalog = self.input(item)
            revision = self.store.revisions()["facts_revision"]
        rule = item.get("rule")
        if rule and rule["kind"] == "mismatch":
            rows = [row for row in inputs["analysis"]["matrix"] if row.get("intent") == rule["intent"]]
            target = next((row for row in rows if row["model"] == rule["model"]), None)
            peers = [row for row in rows if row["model"] != rule["model"] and row["tasks"] >= self.store.settings()["alerts"]["mismatch"]["minTasks"]]
            sufficient = target is not None and target["tasks"] >= self.store.settings()["alerts"]["mismatch"]["minTasks"] and len(peers) >= 2
            if sufficient:
                amount = target["enterpriseMedianDownloadRate"]
                verdict = "confirmed" if all(amount < row["enterpriseMedianDownloadRate"] for row in peers) else "refuted"
            else:
                verdict = "open"
            evidence = "; ".join(f"{row['model']}：{row['tasks']}个任务、{row['enterprises']}家企业、下载率{row['downloadRate']:.2%}、企业中位下载率{row['enterpriseMedianDownloadRate']:.2%}" for row in rows)
            evidence = ("按完整周同类任务的企业中位下载率核对。" if sufficient else "当前同类任务或比较模型的样本不足。") + evidence
            self.context.model.discarded(job_id, [])
        else:
            result = self.context.model.run("finding_recheck", inputs, RecheckResult, job_id)
            invalid = [key for key in result.evidenceIds if key not in catalog]
            discarded = [{"evidenceId": key, "reason": "证据编号不存在"} for key in invalid]
            explanation = result.explanation
            for model in sorted(self.context.engine.frame.model.dropna().unique(), key=len, reverse=True):
                explanation = explanation.replace(model, "")
            amounts = {Decimal(token.rstrip("%")) / (100 if token.endswith("%") else 1) for token in re.findall(r"\d+(?:\.\d+)?%?", explanation)}
            available = {Decimal(str(catalog[key])) for key in result.evidenceIds if key in catalog}
            if amounts - available:
                discarded.append({"reason": "核对说明包含无法由引用证据复算的数字"})
            self.context.model.discarded(job_id, discarded)
            if invalid:
                raise ApiProblem(422, "invalid_recheck_evidence", "模型核对引用了不存在的证据")
            if amounts - available:
                raise ApiProblem(422, "unverified_number", "模型核对说明包含无法核验的数字")
            verdict = result.verdict
            evidence = result.explanation + "；" + "；".join(f"{key}={catalog[key]}" for key in result.evidenceIds)
        with self.store.lock:
            if self.store.revisions()["facts_revision"] != revision:
                raise ApiProblem(409, "evidence_changed", "核对期间数据已经更新，请重新发起核对")
            current = self.store.item("findings", item["id"])
            if any(current.get(field) != item.get(field) for field in ("claim", "rule", "verdict")):
                raise ApiProblem(409, "finding_changed", "核对期间原结论已经修改，请重新发起核对")
            recheck = {"at": now(), "verdict": verdict, "evidence": evidence, "sample": f"{inputs['week']}完整周，{item['line']}，{inputs['overview']['tasks']['value']}个任务", "changed": verdict != item["verdict"]}
            current.setdefault("rechecks", []).append(recheck)
            with self.store.connection() as conn:
                self.store.save("findings", current, conn)
                self.context.repo.save("finding_recheck_applied", {"id": job_id, "finding": item["id"]}, state=job_id, conn=conn)


def mount(app: FastAPI, context):
    @app.post("/api/findings/{key}/recheck")
    def recheck_finding(key: str):
        return context.findings.create(key)
