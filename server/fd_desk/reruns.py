import argparse
import mimetypes
from pathlib import Path
from threading import BoundedSemaphore
from uuid import uuid4

from .core import ApiProblem, now
from .litellm_adapter import credentials, estimate, load_runner
from .media import original_image
from .pushes import public


class Reruns:
    def __init__(self, engine, thumbnails):
        self.engine = engine
        self.store = engine.store
        self.thumbnails = thumbnails
        self.semaphore = BoundedSemaphore(1)

    def create(self, body):
        self.engine.refresh()
        rows = self.engine.frame[self.engine.frame.row_key == body.sourceRowKey]
        if rows.empty:
            raise ApiProblem(404, "not_found", "来源任务不存在")
        row = rows.iloc[0]
        if row.line != "inspiration":
            raise ApiProblem(422, "unsupported_rerun", "LiteLLM 生图重跑当前支持灵感成款任务")
        if not row.inputs:
            raise ApiProblem(422, "source_input_required", "来源任务缺少真实输入图片")
        model, amount, currency = estimate(self.store.directory, body.model)
        item = {"id": uuid4().hex, "enterprise": self.engine.task(row)["enterprise"], "sourceTask": self.engine.task(row),
            "prompt": body.prompt, "model": model, "estimatedPoints": None, "spentPoints": None, "state": "estimated", "result": [],
            "createdAt": now(), "provider": "litellm", "estimatedCost": amount, "spentCost": None, "currency": currency, "error": None,
            "_confirmedAt": None, "_assets": [], "_inputs": list(row.inputs)}
        self.store.save("reruns", item)
        return public(item)

    def confirm(self, key):
        item = self.store.item("reruns", key)
        if item["state"] != "estimated":
            return public(item), False
        model, amount, currency = estimate(self.store.directory, item["model"])
        if amount is None:
            raise ApiProblem(409, "rerun_price_required", "缺少有依据的单次费用上限，尚不能确认收费执行")
        if amount != item["estimatedCost"] or currency != item["currency"]:
            raise ApiProblem(409, "rerun_estimate_expired", "费用配置发生变化，请重新估算")
        settings = self.store.settings()
        used = sum(value["estimatedCost"] or 0 for value in self.store.items("reruns") if (value.get("_confirmedAt") or "").startswith(now()[:10]))
        if currency != settings["rerunCurrency"] or used + amount > settings["rerunDailyBudget"]:
            raise ApiProblem(409, "rerun_daily_limit", "生图费用超过每日预算或货币设置不一致")
        directory = self.store.directory / "reruns" / key
        directory.mkdir(parents=True, exist_ok=True)
        paths = []
        for index, url in enumerate(item["_inputs"]):
            content, extension = original_image(url)
            path = directory / f"input-{index + 1}{extension}"
            path.write_bytes(content)
            paths.append(str(path))
        runner = load_runner(self.store.directory)
        job = {"id": "single", "type": "edit", "model": model, "prompt": item["prompt"], "images": paths}
        runner.build_job(job, directory, "gray")
        item.update(state="confirmed", _confirmedAt=now(), _imagePaths=paths)
        self.store.save("reruns", item)
        return public(item), True

    def execute(self, key):
        with self.semaphore:
            self.execute_one(key)

    def execute_one(self, key):
        with self.store.lock:
            item = self.store.item("reruns", key)
            if item["state"] != "confirmed":
                return
        directory = self.store.directory / "reruns" / key
        submitted, completed = False, False
        try:
            runner = load_runner(self.store.directory)
            base, api_key, resolve = credentials(runner)
            built = runner.build_job({"id": "single", "type": "edit", "model": item["model"], "prompt": item["prompt"], "images": item["_imagePaths"]}, directory, "gray")
            with self.store.lock:
                item["state"] = "running"
                self.store.save("reruns", item)
            submitted = True
            result = runner.execute_one(built, directory, base, api_key,
                argparse.Namespace(timeout=600, max_retries=0, resolve_ip=resolve))
            runner.write_json(directory / "result.json", result)
            paths = result.get("response", {}).get("saved_assets", [])
            if result["ok"] and paths:
                item["_assets"] = paths
                item["result"] = [{"kind": "image", "url": f"/api/reruns/{key}/media/{index}", "thumb": f"/api/reruns/{key}/media/{index}", "poster": None} for index in range(len(paths))]
                item["state"] = "done"
            elif result.get("outcome_unknown") or result.get("ok"):
                item.update(state="uncertain", error={"code": "rerun_uncertain", "message": "请核对本次 LiteLLM 归档和账单，禁止自动重试"})
            else:
                item.update(state="failed", error={"code": "rerun_failed", "message": "LiteLLM 未完成图片生成，请检查本次结果归档"})
            with self.store.lock:
                self.store.save("reruns", item)
            completed = True
        finally:
            if not completed:
                item.update(state="uncertain" if submitted else "failed", error={"code": "rerun_uncertain" if submitted else "rerun_failed", "message": "请核对本次 LiteLLM 归档和账单，禁止自动重试" if submitted else "生图提交前的参数或凭据检查失败"})
                with self.store.lock:
                    self.store.save("reruns", item)

    def media(self, key, index):
        item = self.store.item("reruns", key)
        paths = item.get("_assets", [])
        if index < 0 or index >= len(paths):
            raise ApiProblem(404, "not_found", "重跑图片不存在")
        path = Path(paths[index]).resolve()
        if not path.is_relative_to((self.store.directory / "reruns" / key).resolve()) or not path.is_file():
            raise ApiProblem(404, "not_found", "重跑图片文件不存在")
        return path, mimetypes.guess_type(path)[0]
