import re

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_BASE = "http://127.0.0.1:8766"


async def _proxy(request: Request, path: str):
    client = httpx.AsyncClient(timeout=httpx.Timeout(15, read=None), trust_env=False)
    try:
        upstream = client.build_request(
            request.method, _BASE + path, content=await request.body(),
            headers={"content-type": request.headers.get("content-type", "application/json"), "accept-encoding": "identity"},
        )
        response = await client.send(upstream, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        return JSONResponse({"code": "ask_unavailable", "message": "问答服务暂不可用"}, status_code=503)

    async def body():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    headers = {"cache-control": "no-cache", "x-accel-buffering": "no"}
    if response.headers.get("content-type"):
        headers["content-type"] = response.headers["content-type"]
    return StreamingResponse(body(), status_code=response.status_code, headers=headers)


def mount(app, context):
    @app.api_route("/api/ask/sessions", methods=["GET", "POST"])
    async def sessions(request: Request):
        return await _proxy(request, "/api/ask/sessions")

    @app.api_route("/api/ask/sessions/{session_id}", methods=["GET", "DELETE"])
    async def session(session_id: str, request: Request):
        if not _ID.fullmatch(session_id):
            return Response(status_code=404)
        return await _proxy(request, f"/api/ask/sessions/{session_id}")

    @app.post("/api/ask/sessions/{session_id}/messages")
    async def messages(session_id: str, request: Request):
        if not _ID.fullmatch(session_id):
            return Response(status_code=404)
        return await _proxy(request, f"/api/ask/sessions/{session_id}/messages")

    @app.post("/api/ask/sessions/{session_id}/stop")
    async def stop(session_id: str, request: Request):
        if not _ID.fullmatch(session_id):
            return Response(status_code=404)
        return await _proxy(request, f"/api/ask/sessions/{session_id}/stop")
