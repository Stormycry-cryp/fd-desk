import json
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI
from pydantic import Field

from .case_costs import CaseCosts
from .cases import CaseRef, Rating, Strict
from .core import ApiProblem, Line, now
from .engine import ref
from .record_analysis import cleanup_images


class Estimate(Strict):
    items: list[CaseRef] = Field(min_length=1, max_length=40)


class Create(Estimate):
    line: Line
    question: str | None = None


class Cluster(Strict):
    title: str
    summary: str
    tags: list[str]
    caseIds: list[str] = Field(min_length=1)
    severity: Literal["high", "medium", "low"]


class Judgment(Strict):
    id: str
    rating: Rating
    tags: list[str]
    note: str


class Result(Strict):
    headline: str = Field(max_length=40)
    clusters: list[Cluster]
    perCase: list[Judgment]
    suggestions: list[str] = Field(max_length=3)


PUBLIC = ("id", "line", "items", "question", "state", "headline", "clusters", "perCase", "suggestions", "cost", "error", "createdAt", "finishedAt")


class CaseAnalyses:
    def __init__(self, context):
        self.context, self.store, self.repo, self.cases = context, context.store, context.repo, context.cases
        self.costs = CaseCosts(self.store.directory)
        context.jobs.register("cases.analyze", self.analyze)

    def inputs(self, facts, question):
        return {"cases": [self.cases.row(fact, detail=True) for fact in facts], "question": question,
                "tags": [tag for tag in self.cases.tags(all_=False) if not tag["lines"] or any(fact.line in tag["lines"] for fact in facts)]}

    @staticmethod
    def images(inputs, directory):
        images = {}
        for case in inputs["cases"]:
            steps = case["steps"]
            selected = list(range(len(steps))) if len(steps) <= 6 else sorted({0, len(steps) - 1} | ({case["downloadedAt"]} if case["downloadedAt"] is not None else set()))
            media = [(steps[0], "inputs", item) for item in steps[0]["inputs"]]
            media.extend((steps[index], "outputs", item) for index in selected for item in steps[index]["outputs"])
            for step, kind, item in media:
                source = item.get("poster") if item["kind"] == "video" else item["url"]
                if not source or urlsplit(source).path.lower().endswith((".mp4", ".mov", ".webm", ".m4v")):
                    continue
                if source not in images:
                    images[source] = {"source": source, "path": str(directory / f"{len(images):04d}.webp"), "references": []}
                images[source]["references"].append({"caseId": case["id"], "rowKey": step["rowKey"], "index": step["index"], "kind": kind})
        return list(images.values())

    def estimate(self, items):
        facts = self.cases.selected(items)
        inputs = self.inputs(facts, None)
        images = self.images(inputs, Path("case-images"))
        cost, _ = self.costs.quote({**inputs, "images": images})
        return {"cases": len(facts), "images": len(images), "estimated": cost["estimated"], "currency": cost["currency"]}

    def create(self, body):
        facts = self.cases.selected(body.items, body.line)
        inputs = self.inputs(facts, body.question)
        key = uuid4().hex
        directory = (self.store.directory / "analysis" / key / "case-images").resolve()
        inputs["images"] = self.images(inputs, directory)
        cost, price = self.costs.quote(inputs)
        item = {"id": key, "line": body.line, "items": [value.model_dump() for value in body.items], "question": body.question,
                "state": "queued", "headline": "", "clusters": [], "perCase": [], "suggestions": [],
                "cost": cost, "price": price, "error": None,
                "createdAt": now(), "finishedAt": None, "input": inputs}
        self.context.jobs.submit("case_analysis", "cases.analyze", {"analysis": key}, job_id=key, objects=(("case_analysis", item),))
        return {field: item[field] for field in PUBLIC}

    def get(self, key):
        item = self.repo.get("case_analysis", key)
        job = self.context.jobs.get(key)
        item.update(state=job["state"], error=job["error"], finishedAt=job["finishedAt"])
        return {field: item[field] for field in PUBLIC}

    def list(self, line):
        return [self.get(item["id"]) for item in self.repo.find("case_analysis", line=line)]

    def delete(self, key):
        item = self.get(key)
        if item["state"] in ("queued", "running"):
            raise ApiProblem(409, "analysis_running", "分析正在执行，结束后可以删除")
        self.repo.delete("case_analysis", key)

    @staticmethod
    def validate(result, inputs):
        cases = {case["id"]: case for case in inputs["cases"]}
        tags = {tag["id"]: tag for tag in inputs["tags"]}
        judgments = [value.id for value in result.perCase]
        if len(judgments) != len(set(judgments)) or set(judgments) != cases.keys():
            raise ApiProblem(422, "invalid_case_evidence", "逐条初判必须完整引用本次选择的 Case")
        for judgment in result.perCase:
            if not set(judgment.tags) <= tags.keys() or any(tags[key]["lines"] and cases[judgment.id]["line"] not in tags[key]["lines"] for key in judgment.tags):
                raise ApiProblem(422, "invalid_case_tags", "初判引用了无效标签")
        clusters = []
        for value in result.clusters:
            if not set(value.caseIds) <= cases.keys() or not set(value.tags) <= tags.keys():
                raise ApiProblem(422, "invalid_case_evidence", "问题分类引用了本次选择范围以外的 Case 或标签")
            enterprises = {cases[key]["enterprise"]["id"]: cases[key]["enterprise"] for key in value.caseIds}
            clusters.append({**value.model_dump(), "caseIds": list(dict.fromkeys(value.caseIds)), "tags": list(dict.fromkeys(value.tags)), "enterprises": [ref(enterprise) for enterprise in enterprises.values()]})
        return {"headline": result.headline, "clusters": clusters, "perCase": [value.model_dump() for value in result.perCase], "suggestions": result.suggestions}

    def analyze(self, job_id, payload):
        if payload.get("analysis") != job_id:
            raise ApiProblem(422, "invalid_analysis_job", "分析编号与任务编号不一致")
        directory = (self.store.directory / "analysis" / job_id).resolve()
        image_directory = directory / "case-images"
        try:
            with self.store.lock:
                item = self.repo.get("case_analysis", job_id)
                if item["state"] == "done":
                    return {"analysisId": job_id}
                inputs = item["input"]
            image_directory.mkdir(parents=True, exist_ok=True)
            answer = directory / "answer.json"
            if not answer.is_file():
                for index, image in enumerate(inputs["images"]):
                    path = Path(image["path"])
                    if not path.is_file():
                        path.write_bytes(self.context.media.get(image["source"], 480))
                    self.context.jobs.progress(job_id, index + 1, len(inputs["images"]) + 1)
            result = self.context.model.run("case_analysis", inputs, Result, job_id)
            validated = self.validate(result, inputs)
            usage = json.loads((directory / "usage.json").read_text())
            cost = {**item["cost"], "spent": float(round(self.costs.amount(usage, item["price"]), 8))}
            with self.store.lock:
                item.update(**validated, cost=cost, state="done", finishedAt=now())
                self.repo.save("case_analysis", item)
            return {"analysisId": job_id}
        finally:
            cleanup_images(directory, image_directory)


def mount(app: FastAPI, context):
    service = context.case_analyses

    @app.post("/api/cases/analyses/estimate")
    def estimate(body: Estimate):
        with context.store.lock:
            return service.estimate(body.items)

    @app.post("/api/cases/analyses")
    def create(body: Create):
        with context.store.lock:
            return service.create(body)

    @app.get("/api/cases/analyses")
    def analyses(line: Line):
        with context.store.lock:
            return service.list(line)

    @app.get("/api/cases/analyses/{key}")
    def get(key: str):
        with context.store.lock:
            return service.get(key)

    @app.delete("/api/cases/analyses/{key}", status_code=204)
    def delete(key: str):
        with context.store.lock:
            service.delete(key)
