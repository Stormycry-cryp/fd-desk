import json
import re
import shutil
import subprocess
import time
from decimal import Decimal
from pathlib import Path
from threading import Thread
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

import cn2an
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .core import ApiProblem, dump, now
from .engine import ref


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Finding(Strict):
    text: str = Field(min_length=1, max_length=300)
    confidence: Literal["high", "medium", "low"]
    rowKeys: list[str] = Field(min_length=1, max_length=40)
    evidenceIds: list[str] = Field(min_length=1, max_length=40)

    @field_validator("text")
    @classmethod
    def sentences(cls, value):
        if len([part for part in re.split(r"[。！？!?]+", value) if part.strip()]) > 2:
            raise ValueError("发现不能超过两句")
        return value


class PerRecord(Strict):
    rowKey: str
    verdict: Literal["good", "ok", "bad"]
    note: str = Field(min_length=1, max_length=300)

    @field_validator("note")
    @classmethod
    def sentence(cls, value):
        if len([part for part in re.split(r"[。！？!?]+", value) if part.strip()]) > 1:
            raise ValueError("逐条说明不能超过一句")
        return value


class Result(Strict):
    headline: str = Field(min_length=1, max_length=200)
    findings: list[Finding] = Field(min_length=2, max_length=5)
    perRecord: list[PerRecord] = Field(min_length=1, max_length=40)
    suggestions: list[str] = Field(max_length=3)

    @field_validator("headline")
    @classmethod
    def sentence(cls, value):
        if len([part for part in re.split(r"[。！？!?]+", value) if part.strip()]) > 1:
            raise ValueError("结论不能超过一句")
        return value


class Create(Strict):
    enterprise: str = Field(min_length=1)
    rowKeys: list[str] = Field(min_length=1, max_length=40)
    question: str | None = Field(default=None, max_length=1000)


def numbers(text):
    text = re.sub(r"百分之([负零〇一二两三四五六七八九十百千万亿点\d.]+)",
                  lambda match: f"{cn2an.cn2an(match[1], 'smart')}%", text)
    return {Decimal(token.rstrip("%").replace(",", "")) / (100 if token.endswith("%") else 1)
            for token in re.findall(r"(?<![\d.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?", text)}


def display_evidence(evidence, tasks):
    task = tasks[evidence["target"]["task"]]
    result = "失败" if task["failed"] else "已下载" if task["downloaded"] else "未下载" if task["status"] == "success" else "已删除" if task["status"] == "deleted" else "未知"
    value = f"{result}；耗点 {task['points']}；输入 {len(task['inputs'])} 项；结果 {len(task['outputs'])} 项"
    return {"label": "生成记录", "value": value, "target": evidence["target"]}


def process_running(directory):
    path = directory / "process.json"
    if not path.is_file():
        return False
    process = json.loads(path.read_text())
    result = subprocess.run(["ps", "-p", str(process["pid"]), "-o", "lstart="], capture_output=True, text=True, check=False)
    return bool(result.stdout.strip()) and result.stdout.strip() == process["processStart"]


def cleanup_images(directory, image_directory):
    if process_running(directory):
        def wait_for_process():
            while process_running(directory):
                time.sleep(1)
            shutil.rmtree(image_directory, ignore_errors=True)
        Thread(target=wait_for_process, daemon=True).start()
    else:
        shutil.rmtree(image_directory, ignore_errors=True)


class RecordAnalyses:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        self.engine = context.engine
        context.jobs.register("records.analyze", self.analyze)

    def get(self, key):
        item = self.repo.get("record_analysis", key)
        job = self.context.jobs.get(key)
        tasks = {row["task"]["rowKey"]: row["task"] for row in item["records"]}
        for finding in item["findings"]:
            finding["evidence"] = [display_evidence(evidence, tasks) for evidence in finding["evidence"]]
        return {**item, "state": job["state"], "error": job["error"], "finishedAt": job["finishedAt"] if job["state"] != "done" else item["finishedAt"]}

    def list(self, enterprise):
        self.store.enterprise(enterprise)
        return [self.get(item["id"]) for item in self.repo.find("record_analysis", enterprise=enterprise)]

    def create(self, body):
        if len(set(body.rowKeys)) != len(body.rowKeys):
            raise ApiProblem(422, "duplicate_records", "记录不能重复选择")
        enterprise = self.store.enterprise(body.enterprise)
        selected = self.selected(body.enterprise, body.rowKeys)
        annotations = self.context.records.annotations(body.enterprise)
        records = [self.context.records.row(self.engine, row, annotations) for row in selected]
        key = uuid4().hex
        item = {"id": key, "enterprise": ref(enterprise), "rowKeys": body.rowKeys, "question": body.question,
                "state": "queued", "records": records, "headline": "", "findings": [], "perRecord": [], "suggestions": [],
                "error": None, "createdAt": now(), "finishedAt": None}
        self.context.jobs.submit("record_analysis", "records.analyze", {"analysis": key}, job_id=key, objects=(("record_analysis", item),))
        return item

    def delete(self, key):
        item = self.get(key)
        if item["state"] in ("queued", "running"):
            raise ApiProblem(409, "analysis_running", "分析尚未结束，不能删除")
        with self.store.connection() as conn:
            self.repo.delete("record_analysis", key, conn=conn)
            conn.execute("DELETE FROM rework_objects WHERE kind='record_analysis_applied' AND id=?", (key,))

    def selected(self, enterprise, keys):
        self.engine.refresh()
        rows = self.engine.frame[self.engine.frame.row_key.isin(keys)]
        by_key = {row.row_key: row for _, row in rows.iterrows()}
        if len(by_key) != len(keys):
            raise ApiProblem(404, "record_not_found", "所选记录不存在")
        if any(by_key[key].enterprise_id != enterprise for key in keys):
            raise ApiProblem(422, "record_enterprise_mismatch", "所选记录不属于同一企业")
        if any(by_key[key].line not in ("inspiration", "video") for key in keys):
            raise ApiProblem(422, "invalid_record_line", "记录产品线不受支持")
        return [by_key[key] for key in keys]

    def input(self, item):
        rows = self.selected(item["enterprise"]["id"], item["rowKeys"])
        placeholders = ",".join("?" for _ in item["rowKeys"])
        with self.store.connection() as conn:
            raw = {row["row_key"]: json.loads(row["payload"]) for row in conn.execute(
                f"SELECT row_key,payload FROM tasks WHERE row_key IN ({placeholders})", item["rowKeys"])}
        annotations = self.context.profiles.annotations(item["enterprise"]["id"])
        annotations = [entry for entry in annotations if (entry.get("anchor") or {}).get("block") in {f"record:{key}" for key in item["rowKeys"]}]
        profile = self.context.profiles.record(item["enterprise"]["id"])
        summary = {key: profile.get(key) for key in ("headline", "insights", "tags", "change")}
        records, catalog = [], {}
        for row in rows:
            task = self.engine.task(row)
            chain = self.engine.chains.get(row.chain_id, [])
            index = row.name
            position = chain.index(index) if index in chain else 0
            neighbors = [self.engine.task(self.engine.frame.loc[neighbor]) for neighbor in chain[max(0, position - 2):position + 3] if neighbor != index]
            record_annotations = [entry for entry in annotations if (entry.get("anchor") or {}).get("block") == f"record:{row.row_key}"]
            records.append({"task": task, "rawTask": raw[row.row_key], "neighbors": neighbors, "annotations": record_annotations,
                            "stuck": index in self.engine.stuck_tails})
            evidence_id = f"record:{row.row_key}"
            facts = {key: task[key] for key in ("prompt", "mode", "model", "config", "status", "failed", "downloaded", "failure", "points", "durationSeconds", "intent", "pattern")}
            facts["annotations"] = [entry["text"] for annotation in record_annotations for entry in annotation["entries"]]
            value = dump(facts)
            catalog[evidence_id] = {"label": "生成记录", "value": value, "target": {"page": "enterprise", "enterprise": item["enterprise"]["id"], "tab": "tasks", "line": row.line, "task": row.row_key}}
        return {"enterprise": item["enterprise"], "question": item["question"], "records": records, "profile": summary, "evidenceCatalog": catalog}

    def images(self, inputs, directory):
        candidates = sorted(inputs["records"], key=lambda record: (not (record["stuck"] or not record["task"]["downloaded"]),))
        images = []
        for record in candidates:
            for category in ("inputs", "outputs"):
                for media in record["task"][category][:2]:
                    source = media.get("poster") if media["kind"] == "video" else media["url"]
                    if not source or urlsplit(source).path.lower().endswith((".mp4", ".mov", ".webm", ".m4v")):
                        continue
                    if len(images) >= 40:
                        return images
                    path = directory / f"{len(images):02d}.webp"
                    images.append({"rowKey": record["task"]["rowKey"], "kind": category, "source": source, "path": str(path)})
        return images

    def validate(self, result, inputs):
        catalog = inputs["evidenceCatalog"]
        tasks = {record["task"]["rowKey"]: record["task"] for record in inputs["records"]}
        keys = {record["task"]["rowKey"] for record in inputs["records"]}
        errors = []
        findings = []
        for finding in result.findings:
            linked = {f"record:{key}" for key in finding.rowKeys}
            if (len(set(finding.rowKeys)) != len(finding.rowKeys) or len(set(finding.evidenceIds)) != len(finding.evidenceIds)
                    or set(finding.evidenceIds) != linked or not linked <= catalog.keys()):
                errors.append({"finding": finding.model_dump(), "reason": "记录或证据引用无效"})
                continue
            evidence = [catalog[key] for key in finding.evidenceIds]
            if not numbers(finding.text) <= numbers(" ".join(entry["value"] for entry in evidence)):
                errors.append({"finding": finding.model_dump(), "reason": "发现中的数字无法由所引用证据核验"})
                continue
            findings.append({"id": uuid4().hex, "text": finding.text, "confidence": finding.confidence, "rowKeys": finding.rowKeys, "evidence": [display_evidence(entry, tasks) for entry in evidence]})
        per_keys = [entry.rowKey for entry in result.perRecord]
        if len(per_keys) != len(keys) or set(per_keys) != keys:
            errors.append({"perRecord": per_keys, "reason": "逐条判断必须恰好覆盖所有所选记录"})
        for entry in result.perRecord:
            evidence = catalog.get(f"record:{entry.rowKey}")
            if evidence and not numbers(entry.note) <= numbers(evidence["value"]):
                errors.append({"perRecord": entry.model_dump(), "reason": "逐条判断中的数字无法核验"})
        accepted = {f"record:{key}" for finding in findings for key in finding["rowKeys"]}
        available = numbers(" ".join(catalog[key]["value"] for key in accepted))
        for text in [result.headline, *result.suggestions]:
            if not numbers(text) <= available:
                errors.append({"text": text, "reason": "摘要或建议中的数字无法由发现的证据核验"})
        if errors:
            return None, errors
        return {"headline": result.headline, "findings": findings, "perRecord": [entry.model_dump() for entry in result.perRecord], "suggestions": result.suggestions}, []

    def analyze(self, job_id, payload):
        if payload.get("analysis") != job_id:
            raise ApiProblem(422, "invalid_analysis_job", "任务编号与分析编号不一致")
        directory = (self.store.directory / "analysis" / job_id).resolve()
        image_directory = directory / "record-images"
        try:
            with self.store.lock:
                item = self.repo.get("record_analysis", payload["analysis"])
                if self.repo.find("record_analysis_applied", state=job_id):
                    return {"analysisId": job_id}
                inputs = self.input(item)
                inputs["images"] = self.images(inputs, image_directory)
                directory.mkdir(parents=True, exist_ok=True)
                snapshot = directory / "record-input.json"
                if snapshot.exists() and json.loads(snapshot.read_text()) != inputs:
                    raise ApiProblem(409, "analysis_input_changed", "分析输入、记录或批注已经变化，请重新发起")
                if not snapshot.exists():
                    snapshot.write_text(dump(inputs))
            image_directory.mkdir(parents=True, exist_ok=True)
            total = len(inputs["images"]) + 2
            self.context.jobs.progress(job_id, 1, total)
            for index, image in enumerate(inputs["images"], 2):
                path = Path(image["path"])
                if not path.is_file():
                    path.write_bytes(self.context.media.get(image["source"], 480))
                self.context.jobs.progress(job_id, index, total)
            try:
                result = self.context.model.run("record_analysis", inputs, Result, job_id)
            except ValidationError as error:
                answer = directory / "answer.json"
                self.context.model.discarded(job_id, [{"reason": "模型输出结构无效", "output": answer.read_text() if answer.exists() else str(error)}])
                raise ApiProblem(422, "invalid_analysis_output", "模型输出结构无效") from error
            except json.JSONDecodeError as error:
                answer = directory / "answer.json"
                self.context.model.discarded(job_id, [{"reason": "模型输出不是有效 JSON", "output": answer.read_text() if answer.exists() else str(error)}])
                raise ApiProblem(422, "invalid_analysis_output", "模型输出不是有效 JSON") from error
            except Exception as error:
                answer = directory / "answer.json"
                self.context.model.discarded(job_id, [{"reason": "模型调用或输出读取失败", "error": str(error), "output": answer.read_text() if answer.exists() else None}])
                if isinstance(error, ApiProblem):
                    raise
                raise ApiProblem(502, "analysis_model_failed", f"模型调用或输出读取失败：{type(error).__name__}") from error
            validated, errors = self.validate(result, inputs)
            self.context.model.discarded(job_id, errors)
            if errors:
                raise ApiProblem(422, "invalid_evidence", "模型输出包含无效引用或无法核验的数字")
            with self.store.lock, self.store.connection() as conn:
                if conn.execute("SELECT 1 FROM rework_objects WHERE kind='record_analysis_applied' AND id=?", (job_id,)).fetchone():
                    return {"analysisId": job_id}
                current = self.repo.get("record_analysis", job_id)
                current_inputs = self.input(current)
                current_inputs["images"] = self.images(current_inputs, image_directory)
                if current_inputs != inputs:
                    raise ApiProblem(409, "analysis_input_changed", "分析期间记录、批注或档案发生变化，请重新发起")
                current.update(**validated, state="done", error=None, finishedAt=now())
                self.repo.save("record_analysis", current, conn=conn)
                self.repo.save("record_analysis_applied", {"id": job_id, "enterprise": current["enterprise"]}, state=job_id, conn=conn)
            return {"analysisId": job_id}
        finally:
            cleanup_images(directory, image_directory)


def mount(app: FastAPI, context):
    @app.get("/api/records/analyses")
    def list_analyses(enterprise: str):
        with context.store.lock:
            return context.record_analyses.list(enterprise)

    @app.post("/api/records/analyses")
    def create_analysis(body: Create):
        with context.store.lock:
            return context.record_analyses.create(body)

    @app.get("/api/records/analyses/{key}")
    def get_analysis(key: str):
        with context.store.lock:
            return context.record_analyses.get(key)

    @app.delete("/api/records/analyses/{key}", status_code=204)
    def delete_analysis(key: str):
        with context.store.lock:
            context.record_analyses.delete(key)
