import argparse
import importlib.util
import json
import math

from .codex_runner import runtime
from .core import ApiProblem


def load_runner(directory):
    path = runtime(directory).get("litellmRunner")
    if not path:
        raise ApiProblem(503, "litellm_unconfigured", "缺少 LiteLLM Skill runner 路径")
    spec = importlib.util.spec_from_file_location("fd_litellm_runner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def credentials(runner):
    args = argparse.Namespace(environment="gray", base_url=None, resolve_ip=None)
    environment, base, key = runner.configuration(args)
    resolve = runner.resolve_configuration(args)
    runner.validate_credentials(environment, base, key, resolve)
    return base, key, resolve


def estimate(directory, model):
    runner = load_runner(directory)
    resolved = runner.MODEL_ALIASES.get(model, model)
    catalog = runner.catalog()
    if resolved not in catalog or catalog[resolved]["family"] == "chat":
        raise ApiProblem(422, "unsupported_image_model", "请选择 LiteLLM Skill 已支持的准确图片模型 ID")
    credentials(runner)
    path = directory / "private/litellm-prices.json"
    if not path.is_file():
        return resolved, None, None
    price = json.loads(path.read_text()).get(resolved)
    if price is None:
        return resolved, None, None
    amount = price.get("maxCost")
    if not isinstance(amount, (float, int)) or not math.isfinite(amount) or amount <= 0 or price.get("currency") not in ("CNY", "USD") or not price.get("evidence"):
        raise ApiProblem(422, "invalid_price_configuration", "生图费用配置需要正数 maxCost、货币和价格依据")
    return resolved, float(amount), price["currency"]
