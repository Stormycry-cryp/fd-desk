import copy
import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field
from rapidfuzz import fuzz

from . import analysis
from .core import ApiProblem, Line, now, shift_week, validate_week, week_key
from .engine import main_value, rate, ref
from .record_analysis import cleanup_images

Kind = Literal["official", "custom"]
State = Literal["draft", "tried", "exported", "live", "retired"]
OpportunityState = Literal["open", "adopted", "shelved", "dismissed"]


class TemplateModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Variable(TemplateModel):
    name: str
    default: str = ""
    options: list[str] = Field(default_factory=list)


class Slot(TemplateModel):
    name: str
    required: bool = True
    requirement: str = ""


class Content(TemplateModel):
    title: str = ""
    task: str = ""
    prompt: str = ""
    variables: list[Variable] = Field(default_factory=list)
    slots: list[Slot] = Field(default_factory=list)
    model: str | None = None
    ratio: str | None = None
    resolution: str | None = None
    fits: str = ""
    avoids: str = ""


class Create(TemplateModel):
    line: Line
    kind: Kind
    target: str | None = None
    opportunityId: str | None = None
    clusterIds: list[str] = Field(default_factory=list)
    caseIds: list[str] = Field(default_factory=list)
    content: Content = Field(default_factory=Content)
    write: bool


class Patch(TemplateModel):
    kind: Kind | None = None
    target: str | None = None
    state: State | None = None
    content: Content | None = None
    fdTemplateId: int | None = None
    cover: dict | None = None


class Revision(TemplateModel):
    kind: Literal["shorter", "general", "specific", "from_trial", "custom"]
    instruction: str | None = None
    runId: str | None = None


class Restore(TemplateModel):
    version: int


class Refresh(TemplateModel):
    line: Line
    week: str


class OpportunityPatch(TemplateModel):
    state: OpportunityState


class OpportunityChoice(TemplateModel):
    clusterId: str
    kind: Kind
    targetId: str | None = None
    title: str = Field(min_length=1, max_length=60)
    value: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=250)
    priority: Literal["high", "medium", "low"]


class OpportunityResult(TemplateModel):
    opportunities: list[OpportunityChoice] = Field(max_length=30)


class WriteResult(TemplateModel):
    content: Content
    note: str = Field(min_length=1, max_length=500)


class ReviewResult(TemplateModel):
    comment: str = Field(min_length=1, max_length=100)


class Templates:
    def __init__(self, context):
        self.context, self.store, self.engine, self.repo = context, context.store, context.engine, context.repo
        context.jobs.register("templates.opportunities", self._analyze)
        context.jobs.register("templates.write", self._write)
        context.jobs.register("templates.review", self._review)
        self._migrate()

    def _save(self, item, conn=None):
        self.repo.save("template", item, line=item["line"], enterprise=(item["target"] or {}).get("id"), state=item["state"], conn=conn)

    def _save_opportunity(self, item):
        self.repo.save("opportunity", item, line=item["line"], enterprise=(item["target"] or {}).get("id"), week=item["week"], state=item["state"])

    def _migrate(self):
        with self.store.lock:
            existing = {item["id"] for item in self.repo.find("template")}
            migrated = {item["id"] for item in self.repo.find("template_migration")}
            for old in self.store.items("drafts"):
                if old["id"] in migrated:
                    continue
                if old["id"] in existing:
                    self.repo.save("template_migration", {"id": old["id"], "draft": old})
                    continue
                owners = old.get("sourceEnterprises") or []
                content = Content(title=old["title"]["text"], prompt=old["prompt"]["text"], slots=[Slot(name=slot) for slot in old.get("slots", [])]).model_dump()
                stamp = old["createdAt"]
                version = {"version": 1, "content": content, "source": "manual" if "manual" in (old["title"].get("source"), old["prompt"].get("source")) else old["prompt"].get("source", "agent"), "note": None, "createdAt": stamp}
                item = {"id": old["id"], "line": old["line"], "kind": "custom" if len(owners) == 1 else "official", "target": owners[0] if len(owners) == 1 else None, "scene": old.get("scene"), "state": "draft", "current": version, "versions": [version], "cover": None, "origin": {"opportunityId": None, "clusterIds": [old["clusterId"]] if old.get("clusterId") else [], "uses": 0, "enterprises": len(owners), "downloadRate": None, "originalPrompt": None}, "review": {"checks": [], "trial": None, "comment": None, "suggestedState": None}, "fdTemplateId": old.get("fdTemplateId"), "exportedAt": None, "liveAt": None, "createdAt": stamp, "updatedAt": stamp}
                self.refresh_checks(item)
                self._save(item)
                self.repo.save("template_migration", {"id": old["id"], "draft": old})

    def get(self, key):
        item = self.repo.get("template", key)
        item.setdefault("sourceCases", [])
        return item

    def list(self, line, kind=None, state=None, enterprise=None):
        return [{**item, "sourceCases": item.get("sourceCases", [])} for item in self.repo.find("template", line=line, state=state, enterprise=enterprise) if kind is None or item["kind"] == kind]

    def opportunities(self, line, kind=None, state=None, enterprise=None):
        return [item for item in self.repo.find("opportunity", line=line, state=state, enterprise=enterprise) if kind is None or item["kind"] == kind]

    def _target(self, kind, target):
        if kind == "custom":
            if not target:
                raise ApiProblem(422, "target_required", "定制模板需要目标企业")
            return ref(self.store.enterprise(target))
        if target:
            raise ApiProblem(422, "invalid_target", "官方模板不能指定目标企业")
        return None

    def _clusters(self, line, ids):
        if not ids:
            return {}
        members = analysis.build_clusters(self.engine, line)
        for key in ids:
            if key not in members:
                raise ApiProblem(404, "not_found", "提示词簇不存在或来源记录已更新")
        return members

    def create(self, body):
        self.engine.refresh()
        target = self._target(body.kind, body.target)
        opportunity = self.repo.get("opportunity", body.opportunityId) if body.opportunityId else None
        if opportunity and (opportunity["line"] != body.line or opportunity["kind"] != body.kind or opportunity["target"] != target):
            raise ApiProblem(422, "invalid_opportunity", "机会与模板范围不一致")
        ids = list(dict.fromkeys(body.clusterIds or (opportunity["clusterIds"] if opportunity else [])))
        members = self._clusters(body.line, ids)
        indices = list(dict.fromkeys(index for key in ids for index in members[key]))
        source_cases = [self.context.cases.fact(key) for key in dict.fromkeys(body.caseIds)]
        if any(fact.line != body.line or target and fact.enterprise != target["id"] for fact in source_cases):
            raise ApiProblem(422, "invalid_source_case", "参考 Case 与模板产品线或目标企业不一致")
        indices = list(dict.fromkeys(indices + [index for fact in source_cases for index in fact.indices]))
        part = self.engine.frame.loc[indices] if indices else None
        if target and part is not None and target["id"] not in set(part.enterprise_id):
            raise ApiProblem(422, "invalid_target", "目标企业不在来源簇中")
        scene = main_value(part.scene) if part is not None and len(part) else None
        original = main_value(part.prompt) if part is not None and len(part) else None
        stamp = now()
        version = {"version": 1, "content": body.content.model_dump(), "source": "manual", "note": None, "createdAt": stamp}
        evidence = opportunity["evidence"] if opportunity else {"uses": len(part) if part is not None else 0, "enterprises": int(part.enterprise_id.nunique()) if part is not None else 0, "downloadRate": rate(part) if part is not None and len(part) else None}
        item = {"id": uuid4().hex, "line": body.line, "kind": body.kind, "target": target, "scene": scene, "state": "draft", "current": version, "versions": [version], "cover": None, "origin": {"opportunityId": body.opportunityId, "clusterIds": ids, "uses": evidence.get("uses", 0), "enterprises": evidence.get("enterprises", 0), "downloadRate": evidence.get("downloadRate"), "originalPrompt": original}, "review": {"checks": [], "trial": None, "comment": None, "suggestedState": None}, "fdTemplateId": None, "exportedAt": None, "liveAt": None, "createdAt": stamp, "updatedAt": stamp}
        self.refresh_checks(item)
        item["sourceCases"] = [self.context.cases.source(fact.id) for fact in source_cases]
        self._save(item)
        if opportunity:
            opportunity.update(state="adopted", draftId=item["id"])
            self._save_opportunity(opportunity)
        job = self._submit_write(item, {"kind": "write"}, initial=body.write and not body.content.prompt) if body.write else None
        return {"template": item, "job": job}

    def append_version(self, key, content, source, note):
        with self.store.lock:
            item = self.get(key)
            version = {"version": max((entry["version"] for entry in item["versions"]), default=0) + 1, "content": Content.model_validate(content).model_dump(), "source": source, "note": note, "createdAt": now()}
            item["versions"].append(version)
            item["current"] = version
            item["updatedAt"] = now()
            self.refresh_checks(item)
            self._save(item)
            return item

    def _identities(self):
        self.engine.refresh()
        names = {str(value) for value in self.engine.frame.user_name.dropna().unique() if value and len(str(value)) >= 2}
        names.update(str(item["name"]) for item in self.engine.enterprises.values() if item.get("name") and len(item["name"]) >= 2)
        return names

    def _identity_matches(self, value):
        def strings(item):
            if isinstance(item, str):
                yield item
            elif isinstance(item, dict):
                for child in item.values():
                    yield from strings(child)
            elif isinstance(item, list):
                for child in item:
                    yield from strings(child)
        text = "\n".join(strings(value))
        matches = []
        for name in self._identities():
            pattern = re.escape(name)
            if re.fullmatch(r"[A-Za-z0-9_ .-]+", name):
                pattern = r"(?<![A-Za-z0-9_])" + pattern + r"(?![A-Za-z0-9_])"
            if re.search(pattern, text):
                matches.append(name)
        return matches

    def refresh_checks(self, item):
        self.engine.refresh()
        content = item["current"]["content"]
        prompt = content["prompt"]
        identities = self._identity_matches(content) if item["kind"] == "official" else []
        missing = [slot["name"] for slot in content["slots"] if slot["name"] not in prompt]
        duplicate = any(other["id"] != item["id"] and other["current"]["content"]["prompt"] and fuzz.ratio(prompt, other["current"]["content"]["prompt"]) >= 90 for other in self.repo.find("template", line=item["line"])) if prompt else False
        if not duplicate and prompt:
            duplicate = any(fuzz.ratio(prompt, "".join(part.get("value", "") for part in json.loads(entry.get("templateConfig") or "[]") if part.get("type") == "text")) >= 90 for entry in self.engine.catalog)
        item["review"]["checks"] = [{"key": key, "ok": ok, "message": None if ok else message} for key, ok, message in [("identity", not identities, "可能包含企业或人员名称"), ("slots", not missing, "提示词未引用全部图片槽位"), ("variables", len(content["variables"]) <= 3, "可变项超过三个"), ("length", 60 <= len(prompt) <= 400, "提示词长度不在60至400字之间"), ("duplicate", not duplicate, "与现有模板内容相似")]]
        return item

    def patch(self, key, body):
        item = self.get(key)
        changes = body.model_dump(exclude_unset=True)
        if any(changes.get(field) is None for field in ("kind", "state", "content") if field in changes):
            raise ApiProblem(422, "invalid_template", "模板类型、状态和内容不能为空")
        kind = changes.get("kind", item["kind"])
        target = changes.get("target", (item["target"] or {}).get("id"))
        item["target"] = self._target(kind, target)
        item["kind"] = kind
        if "content" in changes and changes["content"] is not None:
            item = self.append_version(key, changes["content"], "manual", None)
            item["kind"], item["target"] = kind, self._target(kind, target)
        for field in ("state", "fdTemplateId"):
            if field in changes:
                item[field] = changes[field]
        if changes.get("state") == "live" and not item["liveAt"]:
            item["liveAt"] = now()
        if "cover" in changes:
            item["cover"] = self._cover(item, changes["cover"])
        item["updatedAt"] = now()
        self.refresh_checks(item)
        self._save(item)
        return item

    def _cover(self, item, selection):
        if selection is None:
            return None
        run = self.context.trials.get(selection.get("runId"))
        if run.get("templateId") != item["id"]:
            raise ApiProblem(422, "invalid_cover", "试验不属于该模板")
        for case in run["cases"]:
            for cell in case["cells"]:
                if case["id"] == selection.get("caseId") and cell["armId"] == selection.get("armId") and cell["outputs"]:
                    output = cell["outputs"][0]
                    prefix = f"/api/trials/{run['id']}/media/{case['id']}/{cell['armId']}/"
                    url = output.get("url", "")
                    name = url.removeprefix(prefix)
                    root = (self.store.directory / "trials").resolve()
                    path = (root / run["id"] / case["id"] / cell["armId"] / name).resolve()
                    if not url.startswith(prefix) or "/" in name or not path.is_relative_to(root) or not path.is_file():
                        break
                    return {"input": None, "output": output}
        raise ApiProblem(422, "invalid_cover", "试验结果不存在")

    def _submit_write(self, item, request, initial=False):
        return self.context.jobs.submit("draft_write", "templates.write", {"template": item["id"], "baseVersion": item["current"]["version"], "request": request, "initial": initial})

    def revise(self, key, body):
        item = self.get(key)
        if body.kind == "from_trial":
            if not body.runId:
                raise ApiProblem(422, "trial_required", "需要指定试验")
            trial = self.context.trials.get(body.runId)
            if trial.get("templateId") != key:
                raise ApiProblem(422, "invalid_trial", "试验不属于该模板")
        return self._submit_write(item, body.model_dump())

    def restore(self, key, number):
        item = self.get(key)
        version = next ( (entry for entry in item["versions"] if entry["version"] == number), None)
        if version is None:
            raise ApiProblem(404, "not_found", "版本不存在")
        return self.append_version(key, version["content"], "manual", f"恢复版本 {number}")

    def review(self, key):
        item = self.get(key)
        return self.context.jobs.submit("draft_write", "templates.review", {"template": key, "version": item["current"]["version"]})

    def refresh_opportunities(self, line, week):
        return self.context.jobs.submit("opportunities", "templates.opportunities", {"line": line, "week": validate_week(week)})

    def _retry_share(self, part):
        if part.empty:
            return None
        if part.iloc[0].line == "video":
            retries = {index for chain_id in part.chain_id.dropna().unique() for index in self.engine.chains[chain_id][1:]}
            return float(part.index.isin(retries).mean())
        return float(part.pattern.isin(["retry", "tweak"]).mean())

    def _evidence(self, line, week):
        self.engine.refresh()
        frame = self.engine.frame
        members = analysis.build_clusters(self.engine, line)
        universe = frame[(frame.line == line) & (frame.week <= week)]
        dimension = "intent" if line == "inspiration" else "mode"
        peer_rates = universe.groupby([dimension, "enterprise_id"]).downloaded.mean().groupby(level=0).median().to_dict()
        catalog = {}
        for key, indices in members.items():
            part = frame.loc[indices]
            part = part[part.week <= week]
            if part.empty:
                continue
            category = part[dimension].mode()
            peer_rate = float(peer_rates[category.iloc[0]]) if not category.empty and category.iloc[0] in peer_rates else None
            prompts = {re.sub(r"\s+", "", value) for value in part.prompt}
            covered = bool(part.template_id.notna().any()) or any(head in prompt or tail in prompt for prompt in prompts for _, head, tail in self.engine.template_keys)
            evidence = {"uses": len(part), "enterprises": int(part.enterprise_id.nunique()), "weeks": int(part.week.nunique()), "downloadRate": rate(part), "peerDownloadRate": peer_rate, "retryShare": self._retry_share(part), "officialCovered": covered}
            owners = sorted(set(part.enterprise_id))
            unresolved = []
            for chain_id in part.chain_id.dropna().unique():
                chain = frame.loc[self.engine.chains[chain_id]]
                chain = chain[chain.week <= week]
                if len(chain) >= 3 and not chain.downloaded.any():
                    unresolved.append({"id": chain_id, "tasks": [str(value) for value in chain.row_key]})
            catalog[key] = {"clusterId": key, "evidence": evidence, "enterprises": [ref(self.engine.enterprises[owner]) for owner in owners], "sampleTasks": [self.engine.task(row) for _, row in part.sort_values("created_at", ascending=False).head(5).iterrows()], "variants": part.prompt.drop_duplicates().head(20).tolist(), "unresolvedChains": unresolved[:10]}
        return catalog

    @staticmethod
    def _numbers(text):
        values = set()
        for token in re.findall(r"(?<![A-Za-z0-9_.])\d+(?:\.\d+)?%?", text):
            values.add(Decimal(token.rstrip("%")) / (100 if token.endswith("%") else 1))
        return values

    def _analyze(self, job_id, payload):
        line, week = payload["line"], payload["week"]
        with self.store.lock:
            catalog = self._evidence(line, week)
        choices = []
        entries = list(catalog.values())
        chunks = [entries[index:index + 100] for index in range(0, len(entries), 100)]
        profiles = {}
        for index, chunk in enumerate(chunks):
            input_path = self.store.directory / "analysis" / f"{job_id}-{index}" / "input.json"
            if input_path.is_file():
                inputs = json.loads(input_path.read_text())
                if inputs["line"] != line or inputs["week"] != week or inputs["clusters"] != chunk:
                    raise ApiProblem(409, "analysis_input_changed", "模板机会恢复时来源证据已经变化，请重新发起分析")
            else:
                owners = sorted({owner["id"] for entry in chunk for owner in entry["enterprises"]})
                for owner in owners:
                    if owner not in profiles:
                        with self.store.lock:
                            profile = self.context.profiles.get(owner)
                        profiles[owner] = {key: profile.get(key) for key in ("enterprise", "headline", "insights", "tags")}
                inputs = {"line": line, "week": week, "clusters": chunk, "profiles": [profiles[owner] for owner in owners]}
            result = self.context.model.run("opportunities", inputs, OpportunityResult, f"{job_id}-{index}")
            keys = {entry["clusterId"] for entry in chunk}
            choices.extend(choice for choice in result.opportunities if choice.clusterId in keys)
            self.context.jobs.progress(job_id, index + 1, len(chunks) + 1)
        discarded = []
        with self.store.lock:
            current = self._evidence(line, week)
            prior = self.opportunities(line)
            open_items = [item for item in self.opportunities(line, state="open") if item["week"] == week]
            available = max(0, 30 - len(open_items))
            for choice in choices:
                entry = catalog.get(choice.clusterId)
                if entry is None or current.get(choice.clusterId) != entry:
                    discarded.append({"clusterId": choice.clusterId, "reason": "簇不存在或证据已变化"})
                    continue
                owners = {owner["id"]: owner for owner in entry["enterprises"]}
                if (choice.kind == "custom" and choice.targetId not in owners) or (choice.kind == "official" and (choice.targetId is not None or len(owners) < 2)):
                    discarded.append({"clusterId": choice.clusterId, "reason": "类型或目标企业与来源不符"})
                    continue
                numbers = set()
                for value in entry["evidence"].values():
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        numbers.add(Decimal(str(value)))
                text = f"{choice.title} {choice.value} {choice.reason}"
                for owner in entry["enterprises"]:
                    text = text.replace(owner["name"], "")
                if not self._numbers(text) <= numbers:
                    discarded.append({"clusterId": choice.clusterId, "reason": "文字含未核验数字"})
                    continue
                matching = [item for item in prior if choice.clusterId in item["clusterIds"] and item["kind"] == choice.kind and (item["target"] or {}).get("id") == choice.targetId]
                if any(item["state"] == "dismissed" and entry["evidence"]["uses"] <= item["evidence"]["uses"] * 1.5 for item in matching):
                    continue
                if any(item["state"] == "open" and item["week"] == week for item in matching) or available <= 0:
                    continue
                item = {"id": uuid4().hex, "line": line, "kind": choice.kind, "target": owners.get(choice.targetId), "title": choice.title, "value": choice.value, "reason": choice.reason, "priority": choice.priority, "evidence": entry["evidence"], "clusterIds": [choice.clusterId], "sampleTasks": entry["sampleTasks"], "state": "open", "draftId": None, "week": week, "createdAt": now()}
                self._save_opportunity(item)
                prior.append(item)
                available -= 1
        self.context.model.discarded(job_id, discarded)

    def _write_inputs(self, item, request, job_id):
        with self.store.lock:
            members = self._clusters(item["line"], item["origin"]["clusterIds"])
            indices = list(dict.fromkeys(index for key in item["origin"]["clusterIds"] for index in members[key]))
            source_cases = [self.context.cases.fact(value["id"], value["unit"]) for value in item.get("sourceCases", [])]
            indices = list(dict.fromkeys(indices + [index for fact in source_cases for index in fact.indices]))
            part = self.engine.frame.loc[indices].copy()
            if item["target"]:
                part = part[part.enterprise_id == item["target"]["id"]]
            selected = []
            for downloaded in (True, False):
                selected.extend(row for _, row in part[part.downloaded == downloaded].sort_values("created_at", ascending=False).head(5).iterrows())
            tasks = [self.engine.task(row) for row in selected]
            source_case_rows = [self.context.cases.row(fact, detail=True) for fact in source_cases]
            profile = self.context.profiles.get(item["target"]["id"]) if item["target"] else None
        images = {}
        image_dir = (self.store.directory / "analysis" / job_id / "images").resolve()
        for row in [row for row in selected if row.inputs][:4]:
            source = row.inputs[0]
            if source not in images:
                images[source] = {"task": row.row_key, "source": source, "path": str(image_dir / f"{row.row_key}.webp"), "references": []}
            images[source]["references"].append({"rowKey": row.row_key, "kind": "inputs"})
        if source_case_rows:
            for image in self.context.case_analyses.images({"cases": source_case_rows}, image_dir):
                source = image["source"]
                if source in images:
                    images[source]["references"].extend(image["references"])
                else:
                    images[source] = image
        trial_cases = []
        if request.get("kind") == "from_trial":
            trial = self.context.trials.get(request["runId"])
            for case in trial["cases"]:
                cells = [cell for cell in case["cells"] if cell.get("mark") == "worse" or cell.get("usable") is False]
                for cell in cells:
                    for output in cell.get("outputs", []):
                        url = output.get("url", "")
                        if not url.startswith("/api/trials/"):
                            raise ApiProblem(422, "invalid_trial_output", "试验输出不是本地产物")
                        root = (self.store.directory / "trials").resolve()
                        parts = url.removeprefix("/api/trials/").split("/")
                        if len(parts) != 5 or parts[1] != "media" or parts[0] != request["runId"] or parts[2] != case["id"] or parts[3] != cell["armId"]:
                            raise ApiProblem(422, "invalid_trial_output", "试验图片路径无效")
                        path = (root / parts[0] / parts[2] / parts[3] / parts[4]).resolve()
                        if not path.is_relative_to(root) or not path.is_file():
                            raise ApiProblem(422, "invalid_trial_output", "试验图片无法读取")
                        output["localPath"] = str(path)
                if cells:
                    trial_cases.append({"task": case["task"], "cells": cells})
        complete = False
        try:
            for image in images.values():
                image_dir.mkdir(parents=True, exist_ok=True)
                Path(image["path"]).write_bytes(self.context.media.get(image["source"], 480))
            complete = True
            return {"template": item, "request": request, "variants": part.prompt.drop_duplicates().head(20).tolist(), "tasks": tasks, "images": list(images.values()), "profile": profile, "trialCases": trial_cases,
                    "sourceCases": source_case_rows}
        finally:
            if not complete:
                cleanup_images(image_dir.parent, image_dir)

    def _write(self, job_id, payload):
        with self.store.lock:
            if self.repo.find("template_write_applied", state=job_id):
                return {"draftId": payload["template"]}
            item = self.get(payload["template"])
        directory = (self.store.directory / "analysis" / job_id).resolve()
        input_path = directory / "input.json"
        try:
            inputs = json.loads(input_path.read_text()) if input_path.is_file() else self._write_inputs(item, payload["request"], job_id)
            if not (directory / "answer.json").is_file():
                for image in inputs["images"]:
                    path = Path(image["path"])
                    if not path.is_file():
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(self.context.media.get(image["source"], 480))
            self.context.jobs.progress(job_id, 1, 3)
            result = self.context.model.run("template_write", inputs, WriteResult, job_id)
        finally:
            cleanup_images(directory, directory / "images")
        self.context.jobs.progress(job_id, 2, 3)
        if not self._numbers(result.model_dump_json()) <= self._numbers(json.dumps(inputs, ensure_ascii=False)):
            self.context.model.discarded(job_id, [{"reason": "生成内容包含输入中不存在的数字"}])
            raise ApiProblem(422, "unverified_number", "生成内容包含无法核验的数字")
        with self.store.lock:
            item = self.get(payload["template"])
            candidate = copy.deepcopy(item)
            candidate["current"]["content"] = result.content.model_dump()
            self.refresh_checks(candidate)
            if item["kind"] == "official" and (not candidate["review"]["checks"][0]["ok"] or self._identity_matches(result.note)):
                self.context.model.discarded(job_id, [{"reason": "官方模板包含已知企业或人员名称"}])
                raise ApiProblem(422, "identity_leak", "官方模板包含客户身份，生成结果已丢弃")
            unchanged = item["current"]["version"] == payload["baseVersion"]
            version = {"version": max(entry["version"] for entry in item["versions"]) + 1, "content": result.content.model_dump(), "source": "agent", "note": result.note, "createdAt": now()}
            if payload["initial"] and unchanged:
                version["version"] = 1
                item["versions"] = [version]
            else:
                item["versions"].append(version)
            if unchanged:
                item["current"] = version
                self.refresh_checks(item)
            item["updatedAt"] = now()
            with self.store.connection() as conn:
                self._save(item, conn)
                self.repo.save("template_write_applied", {"id": job_id, "template": item["id"]}, state=job_id, conn=conn)
        self.context.model.discarded(job_id, [])
        return {"draftId": item["id"]}

    def _review(self, job_id, payload):
        with self.store.lock:
            if self.repo.find("template_review_applied", state=job_id):
                return {"draftId": payload["template"]}
            item = self.get(payload["template"])
        self.context.jobs.progress(job_id, 1, 3)
        result = self.context.model.run("template_review", {"template": item}, ReviewResult, job_id)
        self.context.jobs.progress(job_id, 2, 3)
        if not self._numbers(result.comment) <= self._numbers(json.dumps(item, ensure_ascii=False)):
            self.context.model.discarded(job_id, [{"reason": "评语包含输入中不存在的数字"}])
            raise ApiProblem(422, "unverified_number", "评语包含无法核验的数字")
        with self.store.lock:
            item = self.get(payload["template"])
            if item["current"]["version"] == payload["version"] and (item["review"]["comment"] or {}).get("source") != "manual":
                item["review"]["comment"] = {"text": result.comment, "source": "agent", "updatedAt": now()}
            with self.store.connection() as conn:
                self._save(item, conn)
                self.repo.save("template_review_applied", {"id": job_id, "template": item["id"]}, state=job_id, conn=conn)
        self.context.model.discarded(job_id, [])
        return {"draftId": item["id"]}

    def monitor(self, line, kind=None):
        self.engine.refresh()
        frame = self.engine.frame
        frame = frame[frame.line == line]
        result = []
        for item in self.list(line, kind):
            if item["state"] not in ("live", "retired") and not item["liveAt"]:
                continue
            configs = frame.config
            id_keys = ("templateId", "template_id", "fdTemplateId", "templateID", "template_id_str")
            has_id = bool(configs.map(lambda config, keys=id_keys: any(config.get(key) not in (None, "") for key in keys)).any())
            exact = item["fdTemplateId"] is not None and has_id
            if exact:
                wanted = str(item["fdTemplateId"])
                mask = configs.map(lambda config, keys=id_keys, target=wanted: any(str(config.get(key)) == target for key in keys if config.get(key) is not None))
            else:
                text = re.sub(r"\s+", "", item["current"]["content"]["prompt"])
                mask = frame.prompt.map(lambda prompt, target=text: len(target) >= 16 and (target[:16] in re.sub(r"\s+", "", prompt) or target[-16:] in re.sub(r"\s+", "", prompt)))
            selected = frame[mask]
            if item["target"]:
                selected = selected[selected.enterprise_id == item["target"]["id"]]
            if item["liveAt"]:
                selected = selected[selected.created_at >= item["liveAt"]]
            weekly = [{"week": week, "uses": len(group), "enterprises": int(group.enterprise_id.nunique()), "downloadRate": rate(group)} for week, group in selected.groupby("week", sort=True)]
            baseline = None
            effect = None
            before = frame.iloc[0:0]
            if item["liveAt"] and item["origin"]["clusterIds"]:
                members = analysis.build_clusters(self.engine, line)
                indices = list(dict.fromkeys(index for key in item["origin"]["clusterIds"] for index in members.get(key, [])))
                before = self.engine.frame.loc[indices]
                live_week = week_key(item["liveAt"])
                before = before[(before.week >= shift_week(live_week, -4)) & (before.week < live_week)]
                if item["target"]:
                    before = before[before.enterprise_id == item["target"]["id"]]
                baseline = {"uses": len(before), "downloadRate": rate(before) if len(before) else None}
            if item["target"]:
                effect = {"retryShare": {"before": self._retry_share(before), "after": self._retry_share(selected)}, "downloadRate": {"before": rate(before) if len(before) else None, "after": rate(selected) if len(selected) else None}}
            result.append({"templateId": item["id"], "title": item["current"]["content"]["title"], "kind": item["kind"], "target": item["target"], "fdTemplateId": item["fdTemplateId"], "liveAt": item["liveAt"], "estimated": not exact, "weekly": weekly, "baseline": baseline, "targetEffect": effect, "revisions": [{"version": version["version"], "at": version["createdAt"]} for version in item["versions"]]})
        return result


def mount(app: FastAPI, context):
    templates = context.templates

    @app.get("/api/templates/opportunities")
    @context.cache.cached
    def opportunities(line: Line, kind: Kind | None = None, state: OpportunityState | None = None, enterprise: str | None = None):
        with context.store.lock:
            return templates.opportunities(line, kind, state, enterprise)

    @app.patch("/api/templates/opportunities/{key}")
    def patch_opportunity(key: str, body: OpportunityPatch):
        with context.store.lock:
            item = context.repo.get("opportunity", key)
            if body.state == "open" and item["state"] != "open" and len([other for other in templates.opportunities(item["line"], state="open") if other["week"] == item["week"]]) >= 30:
                raise ApiProblem(409, "opportunity_limit", "每周每条线最多保留30个待处理机会")
            item["state"] = body.state
            templates._save_opportunity(item)
            return item

    @app.post("/api/templates/opportunities/refresh")
    def refresh_opportunities(body: Refresh):
        return templates.refresh_opportunities(body.line, body.week)

    @app.get("/api/templates/monitor")
    @context.cache.cached
    def monitor(line: Line, kind: Kind | None = None):
        with context.store.lock:
            return templates.monitor(line, kind)

    @app.get("/api/templates")
    @context.cache.cached
    def list_templates(line: Line, kind: Kind | None = None, state: State | None = None, enterprise: str | None = None):
        with context.store.lock:
            return templates.list(line, kind, state, enterprise)

    @app.post("/api/templates")
    def create_template(body: Create):
        with context.store.lock:
            return templates.create(body)

    @app.get("/api/templates/{key}")
    def get_template(key: str):
        with context.store.lock:
            return templates.get(key)

    @app.patch("/api/templates/{key}")
    def patch_template(key: str, body: Patch):
        with context.store.lock:
            return templates.patch(key, body)

    @app.post("/api/templates/{key}/revise")
    def revise_template(key: str, body: Revision):
        with context.store.lock:
            return templates.revise(key, body)

    @app.post("/api/templates/{key}/restore")
    def restore_template(key: str, body: Restore):
        with context.store.lock:
            return templates.restore(key, body.version)

    @app.post("/api/templates/{key}/review")
    def review_template(key: str):
        with context.store.lock:
            return templates.review(key)

    @app.delete("/api/templates/{key}")
    def delete_template(key: str):
        with context.store.lock:
            context.repo.delete("template", key)
