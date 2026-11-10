import hashlib
import io
import json
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from .core import ApiProblem

ALLOWED_HOSTS = {
    "zhiyi-image.oss-cn-hangzhou.aliyuncs.com", "cdn.zhiyitech.cn",
    "zhiyi-image-cdn.zhiyitech.cn", "img-cdn.zhiyitech.cn",
}
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024


class Thumbnails:
    def __init__(self, directory: Path):
        self.directory = directory / "cache/thumbs"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.manifest = self.directory / "manifest.json"
        self.owned = set(json.loads(self.manifest.read_text())) if self.manifest.is_file() else set()
        if any(not isinstance(name, str) or len(name) != 69 or not name.endswith(".webp") or any(character not in "0123456789abcdef" for character in name[:64]) for name in self.owned):
            raise ValueError("缩略图缓存清单无效")

    def get(self, url, width):
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError:
            raise ApiProblem(422, "invalid_media_url", "图片地址格式不符合要求") from None
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or port not in (None, 443):
            raise ApiProblem(422, "invalid_media_url", "图片地址必须使用允许域名的 HTTPS 地址")
        key = hashlib.sha256(f"{url}|{width}".encode()).hexdigest()
        path = self.directory / f"{key}.webp"
        with self.lock:
            if path.is_symlink():
                raise ApiProblem(500, "invalid_cache", "缓存文件类型异常")
            if path.is_file():
                if path.name not in self.owned:
                    raise ApiProblem(500, "invalid_cache", "缓存文件不在本服务的清单中")
                return path.read_bytes()
            try:
                with (
                    httpx.Client(timeout=30, follow_redirects=False, trust_env=False) as client,
                    client.stream("GET", url) as response,
                ):
                    if response.status_code != 200:
                        raise ApiProblem(502, "media_unavailable", "图片服务没有返回可读取的图片")
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_IMAGE_BYTES:
                            raise ApiProblem(413, "media_too_large", "原图超过 32 MB")
                with Image.open(io.BytesIO(content)) as image:
                    if image.width * image.height > 40_000_000:
                        raise ApiProblem(413, "media_too_large", "原图像素数量超过限制")
                    image.thumbnail((width, width * 8))
                    if image.mode not in ("RGB", "RGBA"):
                        image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                    output = io.BytesIO()
                    image.save(output, format="WEBP", quality=82)
            except (httpx.HTTPError, httpx.InvalidURL):
                raise ApiProblem(502, "media_unavailable", "图片服务请求失败") from None
            except (UnidentifiedImageError, Image.DecompressionBombError, OSError):
                raise ApiProblem(422, "invalid_image", "地址没有返回有效图片") from None
            data = output.getvalue()
            files = [self.directory / name for name in self.owned if (self.directory / name).is_file() and not (self.directory / name).is_symlink()]
            size = sum(item.stat().st_size for item in files)
            for item in sorted(files, key=lambda item: item.stat().st_mtime):
                if size + len(data) <= MAX_CACHE_BYTES:
                    break
                item_size = item.stat().st_size
                item.unlink()
                self.owned.remove(item.name)
                size -= item_size
            self.owned.add(path.name)
            self.manifest.write_text(json.dumps(sorted(self.owned)))
            path.write_bytes(data)
            return data
