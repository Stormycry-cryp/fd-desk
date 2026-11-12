import json
import math
import tempfile
import time
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
from PIL import Image

from .core import ROOT, ApiProblem
from .litellm_adapter import credentials, load_runner
from .media import original_image
from .model_capacity import ModelCapacity

OUTPUT_HOSTS = {"ark-acg-cn-beijing.tos-cn-beijing.volces.com"}


class Generation:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.price_path = ROOT / "data/private/litellm-prices.json"
        self.temp_root = self.directory / "work/litellm"
        self.lock = Lock()
        self.cached = None
        self.cached_until = 0

    def runner(self):
        runner = load_runner(ROOT / "data")
        self.temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        runner.tempfile = SimpleNamespace(TemporaryDirectory=lambda **kwargs: tempfile.TemporaryDirectory(dir=self.temp_root, **kwargs))
        try:
            base, key, resolve = credentials(runner)
        except runner.RunnerError:
            raise ApiProblem(503, "litellm_unconfigured", "LiteLLM runner 或 gray 内网凭据配置不可用") from None
        return runner, base, key, resolve

    def models(self, currency):
        with self.lock:
            if self.cached is None or time.monotonic() >= self.cached_until:
                runner, base, key, resolve = self.runner()
                try:
                    _, listing = runner.curl_request("GET", "/v1/models", base, key, 15, resolve_ip=resolve)
                    entries = listing["data"]
                    if not isinstance(entries, list):
                        raise TypeError("模型目录需要数组")
                    available = {item["id"] for item in entries if isinstance(item, dict) and isinstance(item.get("id"), str)}
                    catalog = runner.catalog()
                    prices = json.loads(self.price_path.read_text())
                    if not isinstance(prices, dict):
                        raise TypeError("价格配置需要对象")
                except runner.RequestError as error:
                    raise ApiProblem(503, "litellm_discovery_failed", "LiteLLM 内网模型发现失败：" + str(error)[:400]) from None
                except (runner.RunnerError, OSError, ValueError, KeyError, TypeError):
                    raise ApiProblem(503, "litellm_discovery_failed", "LiteLLM 内网发现响应或价格配置无效") from None
                result = []
                for model, price in prices.items():
                    if not isinstance(price, dict) or model not in available or model not in catalog or catalog[model]["family"] == "chat":
                        continue
                    amount = price.get("maxCost")
                    mappings = price.get("fdModels")
                    if (isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount)
                            or amount <= 0 or not price.get("evidence") or not isinstance(mappings, list)
                            or any(not isinstance(item, str) or not item for item in mappings)):
                        raise ApiProblem(503, "invalid_price_configuration", "LiteLLM 图片价格或模型映射配置无效")
                    result.append({"id": model, "label": price.get("label", model), "fdModels": mappings,
                                   "unitCost": amount, "currency": price.get("currency")})
                self.cached = result
                self.cached_until = time.monotonic() + 300
            return [{key: value for key, value in item.items() if key != "currency"} for item in self.cached if item["currency"] == currency]

    def generate(self, task, arm, output_dir):
        runner, base, key, resolve = self.runner()
        receipt = output_dir / "response.json"
        if receipt.is_file():
            return self.materialize(runner, json.loads(receipt.read_text()), output_dir)
        family = runner.catalog().get(arm["model"], {}).get("family")
        config = task.get("config") or {}
        ratio, resolution = config.get("ratio"), config.get("resolution")
        submitted = False
        try:
            with tempfile.TemporaryDirectory(dir=self.temp_root, prefix="inputs-") as temporary:
                paths = []
                for index, item in enumerate(task["inputs"]):
                    if item["kind"] != "image":
                        raise ApiProblem(422, "invalid_input", "试验只支持图片输入")
                    content, extension = original_image(item["url"])
                    path = Path(temporary) / (str(index) + extension)
                    path.write_bytes(content)
                    paths.append(str(path))
                if not paths:
                    raise ApiProblem(422, "source_input_required", "来源任务缺少输入图片")
                job = {"id": "result", "type": "edit", "model": arm["model"], "prompt": arm["prompt"], "images": paths}
                if family == "gemini-image":
                    if ratio:
                        job["aspect_ratio"] = ratio
                    if resolution:
                        job["image_size"] = resolution.upper()
                elif family in ("seedream-image", "gpt-image"):
                    dimensions = {"1K": {"1:1": "1024x1024", "3:4": "768x1024", "4:3": "1024x768"},
                                  "2K": {"1:1": "2048x2048", "3:4": "1536x2048", "4:3": "2048x1536"},
                                  "4K": {"1:1": "2880x2880", "3:4": "2160x2880", "4:3": "2880x2160"}}
                    if ratio or resolution:
                        size = dimensions.get((resolution or "2K").upper(), {}).get(ratio or "1:1")
                        if not size:
                            raise ApiProblem(422, "unsupported_image_dimensions", "无法可靠转换该比例和清晰度")
                        job["size"] = size
                built = runner.build_job(job, Path(temporary), "gray")
                if family == "seedream-image":
                    built["payload"].pop("response_format", None)
                    built["payload"].pop("sequential_image_generation", None)
                with ModelCapacity(ROOT / "data").acquire("image"):
                    submitted = True
                    _, response, _, _ = runner.send_request(built, base, key, 600, 0, resolve_ip=resolve)
                output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                receipt = output_dir / "response.json"
                encoded = json.dumps(response, ensure_ascii=False).encode("utf-8")
                if len(encoded) > 64 * 1024 * 1024:
                    raise ApiProblem(502, "gateway_outcome_unknown", "网关响应超过64MB；预留金额保留")
                receipt.write_bytes(encoded)
                receipt.chmod(0o600)
                return self.materialize(runner, response, output_dir)
        except runner.RequestError as error:
            if error.status == 408 or error.outcome_unknown:
                raise ApiProblem(502, "gateway_outcome_unknown", "LiteLLM 内网请求失败或超时，扣费结果未知；预留金额保留") from None
            raise ApiProblem(502, "gateway_image_error", f"LiteLLM 内网图片请求返回 HTTP {error.status}") from None
        except runner.RunnerError:
            if submitted:
                raise ApiProblem(502, "gateway_outcome_unknown", "图片响应无效，扣费结果未知；预留金额保留") from None
            raise ApiProblem(422, "invalid_image_request", "LiteLLM 图片请求参数或输入图片无效") from None
        except OSError:
            raise ApiProblem(502, "gateway_outcome_unknown" if submitted else "media_unavailable", "图片读写失败") from None

    def materialize(self, runner, response, output_dir):
        root = output_dir.resolve()
        paths = [Path(path) for path in response.get("saved_assets", [])]
        if any(not path.resolve().is_relative_to(root) for path in paths):
            raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片记录无效；预留金额保留")
        if not paths:
            response = runner.materialize_assets(response, output_dir, "result")
            paths = [Path(path) for path in response["saved_assets"]]
            receipt = output_dir / "response.json"
            receipt.write_text(json.dumps(response, ensure_ascii=False))
            receipt.chmod(0o600)
            remote = response.get("remote_assets", [])
            if not paths and len(remote) == 1:
                paths = [self.download(remote[0], output_dir)]
        if len(paths) != 1:
            raise ApiProblem(502, "gateway_outcome_unknown", f"网关图片结果无法保存（{response.get('asset_status', 'unknown')}）；预留金额保留")
        with Image.open(paths[0]) as image:
            if image.format not in ("PNG", "JPEG", "WEBP") or image.width * image.height > 40_000_000 or paths[0].stat().st_size > 32 * 1024 * 1024:
                raise ApiProblem(502, "gateway_outcome_unknown", "网关返回的图片格式或大小无效；预留金额保留")
            image.verify()
        response.update(saved_assets=[str(path) for path in paths], asset_status="saved")
        (output_dir / "response.json").write_text(json.dumps(response, ensure_ascii=False))
        return paths

    @staticmethod
    def download(url, output_dir):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in OUTPUT_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片地址无效；预留金额保留")
        content = bytearray()
        try:
            with httpx.Client(timeout=120, follow_redirects=False, trust_env=False) as client, client.stream("GET", url) as response:
                if response.status_code != 200:
                    raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片下载失败；预留金额保留")
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > 32 * 1024 * 1024:
                        raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片超过32MB；预留金额保留")
        except httpx.HTTPError:
            raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片下载中断；预留金额保留") from None
        path = output_dir / "result-1.image"
        with path.open("xb") as handle:
            handle.write(content)
        with Image.open(path) as image:
            extension = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}.get(image.format)
            if extension is None:
                raise ApiProblem(502, "gateway_outcome_unknown", "网关结果图片格式无效；预留金额保留")
        destination = path.with_suffix(extension)
        path.rename(destination)
        return destination
