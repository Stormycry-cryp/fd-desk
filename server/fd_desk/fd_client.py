import os
from urllib.parse import urlsplit

import httpx
from dotenv import dotenv_values

from .core import ApiProblem, now


class FDClient:
    def __init__(self, directory):
        self.directory = directory

    def credentials(self):
        values = dotenv_values(self.directory / "private/fd.env")
        base = os.environ.get("FD_API_BASE_URL") or values.get("FD_API_BASE_URL")
        token = os.environ.get("FD_API_TOKEN") or values.get("FD_API_TOKEN")
        if not base or not token:
            raise ApiProblem(503, "fd_account_unconfigured", "缺少 FD_API_BASE_URL 和 FD_API_TOKEN 的本机私有配置")
        parsed = urlsplit(base)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ApiProblem(422, "invalid_fd_configuration", "FD 接口必须使用无凭据和查询参数的 HTTPS 地址")
        return base.rstrip("/"), token

    def request(self, method, path, body=None):
        base, token = self.credentials()
        with httpx.Client(timeout=45, follow_redirects=False, trust_env=False) as client:
            response = client.request(method, base + path, json=body,
                headers={"Authorization": token, "group": "7"})
        if response.status_code != 200:
            raise ApiProblem(502, "fd_http_error", "FD 接口未返回成功响应")
        result = response.json()
        if not isinstance(result, dict) or result.get("success") is not True or "result" not in result:
            raise ApiProblem(502, "fd_rejected", "FD 接口拒绝了请求，请在 FD 核对权限和参数")
        return result["result"]

    def check(self):
        result = self.request("GET", "/clothing-ai/chatting-template-manage/share/capability")
        return {"ready": True, "userName": None, "externalShareAllowed": result.get("externalShareAllowed") is True,
            "checkedAt": now()}
