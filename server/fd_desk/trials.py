from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import BoundedSemaphore
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from .analysis import cluster_indices
from .core import ApiProblem, now
from .fd_generation import Generation


class ArmInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=30000)
    model: str = Field(min_length=1, max_length=200)
    templateVersion: int | None = None


class TrialInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    templateId: str | None = None
    taskRowKeys: list[str] = Field(min_length=1)
    arms: list[ArmInput] = Field(min_length=1)


class CasesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskRowKeys: list[str] = Field(min_length=1)


class CellInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: str
    armId: str
    mark: Literal["better", "same", "worse"] | None = None
    usable: bool | None = None


class CellKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: str
    armId: str


class CoverInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    caseId: str


class AdoptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    armId: str
    cover: CoverInput | None = None


class Trials:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        self.engine = context.engine
        self.generator = Generation(self.store.directory)
        self.executor = ThreadPoolExecutor(max_workers=32, thread_name_prefix="trial")
        self.gate = BoundedSemaphore(max(1, min(32, self.store.settings()["trials"]["concurrency"])))

    def budget(self):
        settings = self.store.settings()["trials"]
        with self.store.connection() as conn:
            rows = conn.execute("SELECT value FROM rework_objects WHERE kind='trial_charge' AND week=?", (now()[:10],))
            import json
            spent = sum(json.loads(row[0])["amount"] for row in rows)
        return {"currency": settings["currency"], "dailyLimit": settings["dailyLimit"], "spentToday": round(spent, 4),
                "maxCases": settings["maxCases"], "maxArms": settings["maxArms"],
                "models": self.generator.models(settings["currency"])}

    def get(self, key):
        return self.repo.get("trial", key)

    def list(self, template=None, enterprise=None):
        items = self.repo.find("trial")
        return [item for item in items if (not template or item["templateId"] == template)
                and (not enterprise or any(case["task"]["enterprise"]["id"] == enterprise for case in item["cases"]))]

    def template(self, key):
        if not key:
            return None
        template = self.context.templates.get(key)
        if template["line"] != "inspiration":
            raise ApiProblem(422, "unsupported_trial", "试验台只支持灵感成款模板")
        return template

    def candidates(self, template=None, cluster=None, enterprise=None, chain=None, limit=6):
        with self.store.lock:
            self.engine.refresh()
            selected = self.template(template)
            if selected and selected["kind"] == "custom":
                owner = selected["target"]["id"]
                if enterprise and enterprise != owner:
                    raise ApiProblem(422, "trial_enterprise_mismatch", "定制模板仅可使用目标企业的任务")
                enterprise = owner
            frame = self.engine.frame
            frame = frame[frame.line == "inspiration"]
            if enterprise:
                frame = frame[frame.enterprise_id == enterprise]
            if chain:
                if chain not in self.engine.chains:
                    raise ApiProblem(404, "not_found", "连续尝试不存在")
                frame = frame.loc[frame.index.intersection(self.engine.chains[chain])]
            clusters = [cluster] if cluster else (selected["origin"]["clusterIds"] if selected else [])
            if clusters:
                indices = set()
                for cluster_id in clusters:
                    indices.update(cluster_indices(self.engine, "inspiration", cluster_id))
                frame = frame.loc[frame.index.intersection(list(indices))]
            rows = [row for _, row in frame.iterrows() if row.inputs]
            rows.sort(key=lambda row: (bool(row.downloaded), str(row.row_key)))
            picked, enterprises, images = [], set(), set()
            while rows and len(picked) < max(1, min(limit, 100)):
                best = min(range(len(rows)), key=lambda index: (bool(rows[index].downloaded),
                    rows[index].enterprise_id in enterprises, tuple(rows[index].inputs) in images, index))
                row = rows.pop(best)
                picked.append(self.engine.task(row))
                enterprises.add(row.enterprise_id)
                images.add(tuple(row.inputs))
            return picked

    def tasks(self, keys, template):
        if len(set(keys)) != len(keys):
            raise ApiProblem(422, "duplicate_case", "用例不可重复")
        self.engine.refresh()
        frame = self.engine.frame
        rows = {row.row_key: row for _, row in frame[frame.row_key.isin(keys)].iterrows()}
        if len(rows) != len(keys):
            raise ApiProblem(404, "not_found", "来源任务不存在")
        tasks = [self.engine.task(rows[key]) for key in keys]
        if any(task["line"] != "inspiration" or not task["inputs"] or any(image["kind"] != "image" for image in task["inputs"]) for task in tasks):
            raise ApiProblem(422, "invalid_trial_case", "用例必须是有图片输入的灵感成款任务")
        if template and template["kind"] == "custom" and any(task["enterprise"]["id"] != template["target"]["id"] for task in tasks):
            raise ApiProblem(422, "trial_enterprise_mismatch", "定制模板仅可使用目标企业的任务")
        return tasks

    def arm(self, body, models):
        if body.model not in models:
            raise ApiProblem(422, "unsupported_image_model", "LiteLLM 内网没有已配置价格的该图片模型")
        return {"id": uuid4().hex, **body.model_dump()}

    def fidelity(self, run, models):
        import json
        prices = json.loads(self.generator.price_path.read_text())
        model_map = {item["id"]: item for item in models}
        available_fd = {name for item in models for name in item["fdModels"]}
        direct = False
        for case in run["cases"]:
            source = case["task"]["model"]
            for arm in run["arms"]:
                model = model_map.get(arm["model"])
                if not model:
                    raise ApiProblem(422, "unsupported_image_model", "LiteLLM 内网没有已配置价格的该图片模型")
                if source == arm["model"] or source in model["fdModels"]:
                    continue
                if source and source not in available_fd and source in prices[arm["model"]].get("sameFamilyFdModels", []):
                    direct = True
                else:
                    raise ApiProblem(422, "fidelity_unverified", "缺少该 FD 模型与试验模型的可靠映射，无法确认还原程度")
        run["fidelity"] = {"level": "direct" if direct else "close", "note": "FD 前端按顺序提交输入图与提示词；模型映射与尺寸转换来自已读取的前端代码。Agent 图片角色、服务端拼装和真实提示词尚无法核验。费用为预留估计，实际账单未提供。"}

    @staticmethod
    def cell(arm):
        return {"armId": arm["id"], "state": "queued", "outputs": [], "cost": None, "error": None, "mark": None, "usable": None}

    def update(self, run, conn=None):
        run["summary"] = [{"armId": arm["id"], "done": sum(cell["state"] == "done" for case in run["cases"] for cell in case["cells"] if cell["armId"] == arm["id"]),
            "total": len(run["cases"]), **{mark: sum(cell["mark"] == mark for case in run["cases"] for cell in case["cells"] if cell["armId"] == arm["id"]) for mark in ("better", "same", "worse")},
            "usable": sum(cell["usable"] is True for case in run["cases"] for cell in case["cells"] if cell["armId"] == arm["id"])} for arm in run["arms"]]
        cells = [cell for case in run["cases"] for cell in case["cells"]]
        if any(cell["state"] == "running" for cell in cells):
            run["state"] = "running"
        elif any(cell["state"] == "queued" for cell in cells):
            run["state"] = "queued"
        elif any(cell["state"] == "failed" for cell in cells):
            run["state"] = "failed"
        elif all(cell["state"] == "cancelled" for cell in cells):
            run["state"] = "cancelled"
        else:
            run["state"] = "done"
        return self.repo.save("trial", run, state=run["state"], conn=conn)

    def reserve(self, run, pairs, prices, conn):
        import json
        day = now()[:10]
        rows = conn.execute("SELECT value FROM rework_objects WHERE kind='trial_charge' AND week=?", (day,))
        used = sum(json.loads(row[0])["amount"] for row in rows)
        amount = sum(prices[arm["model"]] for _, arm in pairs)
        limit = self.store.settings()["trials"]["dailyLimit"]
        if round(used + amount, 6) > limit:
            raise ApiProblem(409, "budget_exceeded", f"今日预算剩余 {max(0, limit-used):.2f}，预计需要 {amount:.2f}")
        for case, arm in pairs:
            charge = {"id": f'{run["id"]}:{case["id"]}:{arm["id"]}', "amount": prices[arm["model"]], "at": now(), "status": "reserved"}
            self.repo.save("trial_charge", charge, week=day, conn=conn)
        run["cost"]["estimated"] = round(run["cost"]["estimated"] + amount, 4)

    def schedule(self, run, pairs):
        for case, arm in pairs:
            self.executor.submit(self.execute, run["id"], case["id"], arm["id"])

    def create(self, body):
        with self.store.lock:
            budget = self.budget()
            if len(body.taskRowKeys) > budget["maxCases"] or len(body.arms) > budget["maxArms"]:
                raise ApiProblem(422, "trial_limit", "用例数或写法数超过单次上限")
            template = self.template(body.templateId)
            tasks = self.tasks(body.taskRowKeys, template)
            models = {model["id"]: model["unitCost"] for model in budget["models"]}
            arms = [self.arm(arm, models) for arm in body.arms]
            cases = [{"id": uuid4().hex, "task": task, "cells": [self.cell(arm) for arm in arms]} for task in tasks]
            run = {"id": uuid4().hex, "templateId": body.templateId, "arms": arms, "cases": cases, "state": "queued",
                   "cost": {"estimated": 0, "spent": 0, "currency": budget["currency"]}, "summary": [],
                   "fidelity": None, "createdAt": now()}
            self.fidelity(run, budget["models"])
            pairs = [(case, arm) for case in cases for arm in arms]
            with self.store.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.reserve(run, pairs, models, conn)
                self.update(run, conn)
            self.schedule(run, pairs)
            return run

    def extend(self, key, arms=None, keys=None):
        with self.store.lock:
            run = self.get(key)
            budget = self.budget()
            prices = {item["id"]: item["unitCost"] for item in budget["models"]}
            if arms:
                if len(run["arms"]) + len(arms) > budget["maxArms"]:
                    raise ApiProblem(422, "trial_limit", "写法数超过上限")
                new_arms = [self.arm(arm, prices) for arm in arms]
                for case in run["cases"]:
                    case["cells"].extend(self.cell(arm) for arm in new_arms)
                run["arms"].extend(new_arms)
                pairs = [(case, arm) for case in run["cases"] for arm in new_arms]
            else:
                if len(run["cases"]) + len(keys) > budget["maxCases"]:
                    raise ApiProblem(422, "trial_limit", "用例数超过上限")
                if set(keys) & {case["task"]["rowKey"] for case in run["cases"]}:
                    raise ApiProblem(422, "duplicate_case", "用例不可重复")
                if any(arm["model"] not in prices for arm in run["arms"]):
                    raise ApiProblem(422, "unsupported_image_model", "LiteLLM 内网没有已配置价格的该图片模型")
                tasks = self.tasks(keys, self.template(run["templateId"]))
                cases = [{"id": uuid4().hex, "task": task, "cells": [self.cell(arm) for arm in run["arms"]]} for task in tasks]
                run["cases"].extend(cases)
                pairs = [(case, arm) for case in cases for arm in run["arms"]]
            self.fidelity(run, budget["models"])
            with self.store.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.reserve(run, pairs, prices, conn)
                self.update(run, conn)
            self.schedule(run, pairs)
            return run

    def pair(self, run, case_id, arm_id):
        case = next((case for case in run["cases"] if case["id"] == case_id), None)
        arm = next((arm for arm in run["arms"] if arm["id"] == arm_id), None)
        cell = next((cell for cell in case["cells"] if cell["armId"] == arm_id), None) if case else None
        if not case or not arm or not cell:
            raise ApiProblem(404, "not_found", "试验格子不存在")
        return case, arm, cell

    def retry(self, key, body):
        with self.store.lock:
            run = self.get(key)
            case, arm, cell = self.pair(run, body.caseId, body.armId)
            receipt = self.store.directory / "trials" / key / case["id"] / arm["id"] / "response.json"
            resume_output = receipt.is_file()
            if cell["state"] not in ("failed", "cancelled") or ((cell["error"] or {}).get("code") == "gateway_outcome_unknown" and not resume_output):
                raise ApiProblem(409, "trial_retry_forbidden", "此格不可重试，扣费未知时请先核对账单")
            prices = {} if resume_output else {item["id"]: item["unitCost"] for item in self.budget()["models"]}
            if not resume_output and arm["model"] not in prices:
                raise ApiProblem(422, "unsupported_image_model", "LiteLLM 内网没有已配置价格的该图片模型")
            cell.update(state="queued", outputs=[], cost=None, error=None, mark=None, usable=None)
            with self.store.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                if not resume_output:
                    self.reserve(run, [(case, arm)], prices, conn)
                self.update(run, conn)
            self.schedule(run, [(case, arm)])
            return run

    def mark(self, key, body):
        with self.store.lock:
            run = self.get(key)
            _, _, cell = self.pair(run, body.caseId, body.armId)
            if cell["state"] != "done":
                raise ApiProblem(409, "trial_cell_not_done", "只能标记已完成的结果")
            for field in body.model_fields_set & {"mark", "usable"}:
                cell[field] = getattr(body, field)
            return self.update(run)

    def cancel(self, key):
        with self.store.lock, self.store.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            run = self.get(key)
            for case in run["cases"]:
                for cell in case["cells"]:
                    if cell["state"] == "queued":
                        cell["state"] = "cancelled"
                        conn.execute("DELETE FROM rework_objects WHERE kind='trial_charge' AND id=?", (f'{key}:{case["id"]}:{cell["armId"]}',))
            return self.update(run, conn)

    def execute(self, key, case_id, arm_id):
        with self.gate:
            with self.store.lock:
                run = self.get(key)
                case, arm, cell = self.pair(run, case_id, arm_id)
                if cell["state"] != "queued":
                    return
                cell["state"] = "running"
                self.update(run)
            try:
                directory = self.store.directory / "trials" / key / case_id / arm_id
                paths = self.generator.generate(case["task"], arm, directory)
                outputs = [{"kind": "image", "url": f"/api/trials/{key}/media/{case_id}/{arm_id}/{path.name}",
                            "thumb": f"/api/trials/{key}/media/{case_id}/{arm_id}/{path.name}", "poster": None} for path in paths]
                error = None
            except Exception as exc:  # noqa: BLE001 独立格子记录真实执行错误，其余格子继续处理
                outputs = []
                error = exc.payload if isinstance(exc, ApiProblem) else {"code": "gateway_outcome_unknown", "message": f"执行中断（{type(exc).__name__}），扣费结果未知；预留金额保留"}
            with self.store.lock, self.store.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                run = self.get(key)
                _, _, cell = self.pair(run, case_id, arm_id)
                charge_id = f'{key}:{case_id}:{arm_id}'
                if error:
                    cell.update(state="failed", error=error)
                    if error["code"] != "gateway_outcome_unknown":
                        conn.execute("DELETE FROM rework_objects WHERE kind='trial_charge' AND id=?", (charge_id,))
                else:
                    cell.update(state="done", outputs=outputs, error=None)
                    charge = self.repo.get("trial_charge", charge_id)
                    cell["cost"] = charge["amount"]
                    charge["status"] = "estimated_spent"
                    self.repo.save("trial_charge", charge, week=charge["at"][:10], conn=conn)
                    run["cost"]["spent"] = round(run["cost"]["spent"] + charge["amount"], 4)
                self.update(run, conn)

    def recover(self):
        with self.store.lock:
            for run in self.repo.find("trial"):
                pairs = []
                for case in run["cases"]:
                    for cell in case["cells"]:
                        if cell["state"] == "running":
                            cell.update(state="failed", error={"code": "gateway_outcome_unknown", "message": "服务中断，扣费结果未知；预留金额保留，请核对账单"})
                        elif cell["state"] == "queued":
                            pairs.append((case, next(arm for arm in run["arms"] if arm["id"] == cell["armId"])))
                self.update(run)
                self.schedule(run, pairs)

    def shutdown(self):
        self.executor.shutdown(wait=True)

    def adopt(self, key, body):
        with self.store.lock:
            run = self.get(key)
            if not run["templateId"]:
                raise ApiProblem(422, "template_required", "该试验没有关联模板")
            arm = next((item for item in run["arms"] if item["id"] == body.armId), None)
            if not arm:
                raise ApiProblem(404, "not_found", "写法不存在")
            cover = None
            if body.cover:
                case, _, cell = self.pair(run, body.cover.caseId, arm["id"])
                if cell["state"] != "done" or not cell["outputs"]:
                    raise ApiProblem(422, "trial_cover_required", "封面必须是已完成的本地试验结果")
                cover = {"input": case["task"]["inputs"][0] if case["task"]["inputs"] else None, "output": cell["outputs"][0]}
            template = self.context.templates.get(run["templateId"])
            if template["kind"] == "custom" and any(case["task"]["enterprise"]["id"] != template["target"]["id"] for case in run["cases"]):
                raise ApiProblem(422, "trial_enterprise_mismatch", "定制模板仅可采用目标企业的试验")
            content = dict(template["current"]["content"])
            content.update(prompt=arm["prompt"], model=arm["model"])
            template = self.context.templates.append_version(template["id"], content, "manual", "采用试验台写法")
            if cover:
                template["cover"] = cover
            summary = next(item for item in run["summary"] if item["armId"] == arm["id"])
            template["review"]["trial"] = {"runId": key, "cases": len(run["cases"]), **{name: summary[name] for name in ("usable", "better", "same", "worse")}}
            return self.repo.save("template", template)

    def media(self, key, case_id, arm_id, name):
        run = self.get(key)
        _, _, cell = self.pair(run, case_id, arm_id)
        url = f"/api/trials/{key}/media/{case_id}/{arm_id}/{name}"
        if not any(item["url"] == url for item in cell["outputs"]) or Path(name).name != name:
            raise ApiProblem(404, "not_found", "试验图片不存在")
        root = (self.store.directory / "trials").resolve()
        path = (root / key / case_id / arm_id / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ApiProblem(404, "not_found", "试验图片不存在")
        return path


def mount(app: FastAPI, context):
    @app.get("/api/trials/budget")
    def budget():
        return context.trials.budget()

    @app.get("/api/trials/candidates")
    def candidates(template: str | None = None, cluster: str | None = None, enterprise: str | None = None, chain: str | None = None, limit: int = 6):
        return context.trials.candidates(template, cluster, enterprise, chain, limit)

    @app.get("/api/trials")
    def list_trials(template: str | None = None, enterprise: str | None = None):
        return context.trials.list(template, enterprise)

    @app.post("/api/trials")
    def create(body: TrialInput):
        return context.trials.create(body)

    @app.get("/api/trials/{key}")
    def get(key: str):
        return context.trials.get(key)

    @app.post("/api/trials/{key}/arms")
    def add_arm(key: str, body: ArmInput):
        return context.trials.extend(key, arms=[body])

    @app.post("/api/trials/{key}/cases")
    def add_cases(key: str, body: CasesInput):
        return context.trials.extend(key, keys=body.taskRowKeys)

    @app.post("/api/trials/{key}/retry")
    def retry(key: str, body: CellKey):
        return context.trials.retry(key, body)

    @app.patch("/api/trials/{key}/cells")
    def mark(key: str, body: CellInput):
        return context.trials.mark(key, body)

    @app.post("/api/trials/{key}/cancel")
    def cancel(key: str):
        return context.trials.cancel(key)

    @app.post("/api/trials/{key}/adopt")
    def adopt(key: str, body: AdoptInput):
        return context.trials.adopt(key, body)

    @app.get("/api/trials/{key}/media/{case_id}/{arm_id}/{name}")
    def media(key: str, case_id: str, arm_id: str, name: str):
        return FileResponse(context.trials.media(key, case_id, arm_id, name))
