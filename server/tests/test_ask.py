import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fd_desk.ask_proxy import mount


@pytest.fixture
def client():
    app = FastAPI()
    mount(app, None)
    with TestClient(app) as test_client:
        yield test_client


def service_available():
    try:
        return httpx.get("http://127.0.0.1:8766/api/ask/sessions", timeout=2, trust_env=False).status_code == 200
    except httpx.HTTPError:
        return False


def test_only_explicit_routes_are_exposed(client):
    assert client.get("/api/ask/anything").status_code == 404
    assert client.get("/api/ask/sessions/invalid").status_code == 404
    assert client.get("/api/ask/sessions/invalid/anything").status_code == 404
    assert client.post("/api/ask/sessions/invalid/messages").status_code == 404


def test_unavailable_service_is_isolated(client):
    if service_available():
        pytest.skip("问答服务正在运行；停止该独立服务后验证 503")
    response = client.get("/api/ask/sessions")
    assert response.status_code == 503
    assert response.json()["code"] == "ask_unavailable"


def test_live_session_lifecycle(client):
    if not service_available():
        pytest.skip("独立问答服务未运行")
    created = client.post("/api/ask/sessions")
    assert created.status_code == 200
    session = created.json()
    session_id = session["id"]
    try:
        assert session["messages"] == []
        assert client.get(f"/api/ask/sessions/{session_id}").json()["id"] == session_id
        assert any(item["id"] == session_id for item in client.get("/api/ask/sessions").json())
        assert client.post(f"/api/ask/sessions/{session_id}/stop").status_code == 204
    finally:
        assert client.delete(f"/api/ask/sessions/{session_id}").status_code == 204
    assert client.get(f"/api/ask/sessions/{session_id}").status_code == 404
