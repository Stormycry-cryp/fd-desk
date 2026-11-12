import json
import sqlite3
from contextlib import closing
from decimal import Decimal
from pathlib import Path
from statistics import median

from .codex_runner import runtime
from .core import ApiProblem, dump


class CaseCosts:
    def __init__(self, directory):
        self.directory = directory

    def price(self):
        configuration = runtime(self.directory)
        source = configuration.get("caseAnalysisPricing", {})
        if not source.get("database"):
            raise ApiProblem(503, "case_price_unconfigured", "缺少当前 Codex CLI 渠道的价格数据库配置")
        database = Path(source["database"]).expanduser().resolve()
        with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("BEGIN")
            model = connection.execute("SELECT * FROM model_pricing WHERE model_id=?", (configuration["model"],)).fetchone()
            providers = connection.execute("SELECT id,cost_multiplier FROM providers WHERE app_type='codex' AND is_current=1").fetchall()
        if model is None or len(providers) != 1:
            raise ApiProblem(503, "case_price_unavailable", "当前模型单价或当前 Codex CLI 渠道无法确定")
        price = {"model": configuration["model"], "provider": providers[0]["id"], "currency": "USD",
                 "input": model["input_cost_per_million"], "output": model["output_cost_per_million"],
                 "cacheRead": model["cache_read_cost_per_million"], "cacheWrite": model["cache_creation_cost_per_million"],
                 "multiplier": providers[0]["cost_multiplier"]}
        values = [Decimal(price[key]) for key in ("input", "output", "cacheRead", "cacheWrite", "multiplier")]
        if any(not value.is_finite() or value < 0 for value in values):
            raise ApiProblem(503, "invalid_case_price", "模型价格或渠道倍率无效")
        return price, source

    @staticmethod
    def amount(usage, price):
        input_tokens = usage["input_tokens"]
        output_tokens = usage["output_tokens"]
        cache_read = usage.get("cached_input_tokens", 0)
        cache_write = usage.get("cache_write_input_tokens", 0)
        counts = (input_tokens, output_tokens, cache_read, cache_write)
        if any(not isinstance(value, int) or value < 0 for value in counts) or cache_read + cache_write > input_tokens:
            raise ApiProblem(502, "invalid_case_usage", "Codex CLI 返回的 token 用量无效")
        amount = (Decimal(input_tokens - cache_read - cache_write) * Decimal(price["input"])
                  + Decimal(cache_read) * Decimal(price["cacheRead"])
                  + Decimal(cache_write) * Decimal(price["cacheWrite"])
                  + Decimal(output_tokens) * Decimal(price["output"]))
        return amount * Decimal(price["multiplier"]) / Decimal(1000000)

    @staticmethod
    def dimensions(inputs):
        text = {key: value for key, value in inputs.items() if key != "images"}
        return len(inputs["cases"]), len(inputs["images"]), len(dump(text).encode("utf-8"))

    def quote(self, inputs):
        price, source = self.price()
        roots = {self.directory / "analysis"}
        roots.update((self.directory / value).resolve() for value in source.get("historyDirectories", []))
        samples = {path for root in roots for path in sorted(root.glob("*/usage.json"), key=lambda path: path.stat().st_mtime, reverse=True)[:100]}
        samples = sorted(samples, key=lambda path: path.stat().st_mtime, reverse=True)
        amounts = []
        dimensions = self.dimensions(inputs)
        for usage_path in samples:
            directory = usage_path.parent
            process = json.loads((directory / "process.json").read_text())
            if process["model"] != price["model"] or not (directory / "answer.json").is_file():
                continue
            sample = json.loads((directory / "input.json").read_text())
            if not sample.get("cases") or "images" not in sample:
                continue
            measured = self.dimensions(sample)
            scale = max(Decimal(current) / Decimal(max(previous, 1)) for current, previous in zip(dimensions, measured))
            usage = json.loads(usage_path.read_text())
            # 预估使用完整输入单价，缓存命中由完成后的实际用量计算。
            counts = {"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}
            amounts.append(self.amount(counts, price) * scale)
            if len(amounts) == 20:
                break
        if not amounts:
            raise ApiProblem(503, "case_usage_unavailable", "缺少当前模型已完成的 Case 分析用量，无法计算金额预估")
        return {"estimated": float(round(median(amounts), 6)), "spent": None, "currency": price["currency"]}, price
