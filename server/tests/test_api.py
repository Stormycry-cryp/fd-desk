import io
import json
import tempfile
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

import pandas as pd
import pytest
from openpyxl import load_workbook
from PIL import Image

from fd_desk.core import ROOT, digest, dump, read_spec
from fd_desk.ingest import import_file
from fd_desk.media import ALLOWED_HOSTS
from fd_desk.store import Store
from fd_desk.summary import summarize
from fd_desk.verification import compare

WEEK = "2026-11-02"


def enterprise_id(client):
    return client.get("/api/enterprises", params={"line": "inspiration", "week": WEEK}).json()["rows"][0]["enterprise"]["id"]


def test_database_matches_all_golden_values(client):
    compare(read_spec("golden.json"), summarize(client.app.state.engine))


@pytest.mark.parametrize("line,tasks,stable,points", [("inspiration", 9077, 46, 33586), ("video", 881, 19, 60016)])
def test_overview_and_incomplete_week(client, line, tasks, stable, points):
    response = client.get("/api/overview", params={"line": line, "week": WEEK})
    assert response.status_code == 200
    overview = response.json()
    assert set(overview) == {"line", "week", "coverage", "previousCoverage", "comparableWeekdays", "stable", "levels", "activeEnterprises", "users", "tasks", "points", "downloadRate", "failed", "concentration", "history", "movers", "moverCounts", "alerts", "inspiration", "video"}
    assert overview["tasks"]["value"] == tasks
    assert overview["stable"]["value"] == stable
    assert overview["points"]["value"] == points
    assert overview["comparableWeekdays"] == [3, 4, 5, 6]
    assert overview["tasks"]["comparableExcluded"] is not None
    expected = read_spec("golden.json")["comparisons"]["2026-10-26_2026-11-02"][line]
    assert overview["tasks"]["comparableExcluded"] == {"previous": expected["tasks_excluding_top1"][0], "current": expected["tasks_excluding_top1"][1]}
    assert len(overview["history"]) == 12
    partial = client.get("/api/overview", params={"line": line, "week": "2026-10-26"}).json()
    assert partial["stable"] is None and partial["levels"] is None
    assert partial["tasks"]["comparable"] is None


def test_roster_history_and_detail_contract(client):
    roster = client.get("/api/enterprises", params={"line": "inspiration", "week": WEEK}).json()
    assert set(roster) == {"line", "week", "rows", "poolCounts"}
    assert set(roster["poolCounts"]) == {"retain", "recall", "help", "keep", "nurture", "convert"}
    assert sum(roster["poolCounts"].values()) <= len(roster["rows"])
    assert any(row["tasks"] == 0 for row in roster["rows"])
    for row in roster["rows"]:
        assert len(row["spark"]) == 12
        assert row["spark"][-1]["tasks"] == row["tasks"]
        assert all(point["level"] is None for point in row["spark"] if not point["complete"])
    key = roster["rows"][0]["enterprise"]["id"]
    detail = client.get(f"/api/enterprises/{key}", params={"week": WEEK}).json()
    assert set(detail) == {"enterprise", "adminPhone", "contract", "owner", "firstSeenAt", "lastActiveAt", "summary", "lines", "alerts", "touches", "notes"}
    assert digest(detail["adminPhone"], 10) == key
    for line in detail["lines"].values():
        if line is not None:
            assert len(line["history"]) == 12
            assert all(member["id"] == digest(member["phone"], 10) for member in line["members"])


@pytest.mark.parametrize("line", ["inspiration", "video"])
def test_real_excel_export_and_pool_filter(client, line):
    roster = client.get("/api/enterprises", params={"line": line, "week": WEEK}).json()
    for pool in (None, "help"):
        response = client.get("/api/enterprises/export", params={"line": line, "week": WEEK, **({"pool": pool} if pool else {})})
        assert response.status_code == 200
        workbook = load_workbook(io.BytesIO(response.content))
        expected = sum(pool is None or row["pool"] == pool for row in roster["rows"])
        assert workbook.active.max_row == expected + 1
        assert all(cell.data_type != "f" for row in workbook.active for cell in row)
        workbook.close()


@pytest.mark.parametrize("line", ["inspiration", "video"])
def test_task_fields_pagination_filters_and_sampling(client, line):
    params = {"line": line, "week": WEEK}
    page = client.get("/api/tasks", params=params).json()
    assert len(page["items"]) == 50
    assert page["total"] == (9077 if line == "inspiration" else 881)
    assert [task["createdAt"] for task in page["items"]] == sorted((task["createdAt"] for task in page["items"]), reverse=True)
    assert client.get("/api/tasks", params={**params, "limit": 201}).status_code == 422
    second = client.get("/api/tasks", params={**params, "offset": 50}).json()
    assert {task["rowKey"] for task in page["items"]}.isdisjoint(task["rowKey"] for task in second["items"])
    sample = client.get("/api/tasks", params={**params, "sample": 2}).json()
    assert max(Counter(task["sampleReason"] for task in sample["items"]).values()) <= 2
    assert len({task["rowKey"] for task in sample["items"]}) == len(sample["items"])
    for task in sample["items"]:
        assert set(task) == {"rowKey", "sourceId", "turnKey", "line", "scene", "mode", "createdAt", "enterprise", "user", "model", "prompt", "inputs", "outputs", "points", "status", "failed", "downloaded", "downloadVia", "failure", "durationSeconds", "intent", "pattern", "chainId", "sampleReason", "config"}
        assert task["createdAt"].endswith("+08:00")
        assert isinstance(task["config"]["referenceImages"], int)
        assert isinstance(task["config"]["hasReferenceVideo"], bool)
        for media in task["inputs"] + task["outputs"]:
            assert set(media) == {"kind", "url", "thumb", "poster"}
            assert media["thumb"].startswith("/api/media/thumb?url=")
    failed = client.get("/api/tasks", params={**params, "failed": True}).json()
    assert all(task["failed"] for task in failed["items"])


def test_deleted_video_failures_and_missing_members(client):
    failed = client.get("/api/tasks", params={"line": "video", "week": WEEK, "failed": True, "limit": 200}).json()
    assert failed["total"] == 68
    assert sum(task["status"] == "deleted" for task in failed["items"]) == 7
    tasks = client.app.state.engine.frame
    assert int(tasks.user_phone.isna().sum()) == 25
    assert (tasks[tasks.user_phone.isna()].pattern == "none").all()


def test_stuck_chains_contain_real_contiguous_tasks(client):
    result = client.get("/api/chains", params={"line": "inspiration", "week": WEEK, "downloaded": False}).json()
    assert result["total"] > 0
    for chain in result["items"]:
        assert chain["length"] >= 3
        assert chain["length"] == len(chain["tasks"])
        assert not any(task["downloaded"] for task in chain["tasks"])
        for previous, current in zip(chain["tasks"], chain["tasks"][1:]):
            assert {item["url"] for item in previous["inputs"]} & {item["url"] for item in current["inputs"]}


def test_manual_fields_are_protected_and_atomic(client):
    key = enterprise_id(client)
    route = f"/api/enterprises/{key}"
    response = client.patch(route, json={"summary": "人工核验内容", "source": "manual"})
    assert response.status_code == 200
    kind = response.json()["enterprise"]["kind"]
    locked = client.patch(route, json={"summary": "自动化内容", "source": "agent", "kind": "agency"})
    assert locked.status_code == 409
    assert locked.json()["code"] == "manual_locked"
    assert locked.json()["current"]["text"] == "人工核验内容"
    assert client.get(route, params={"week": WEEK}).json()["enterprise"]["kind"] == kind
    action = f"{route}/next-action"
    assert client.put(action, json={"line": "inspiration", "text": "人工下一步", "source": "manual"}).status_code == 200
    assert client.put(action, json={"line": "inspiration", "text": "规则下一步", "source": "rule"}).status_code == 409
    assert client.patch(route, json={"summary": "缺少来源"}).status_code == 422


def test_internal_enterprise_and_excluded_metrics(client):
    key = enterprise_id(client)
    original = client.get("/api/settings").json()
    route = f"/api/enterprises/{key}"
    kind = client.get(route, params={"week": WEEK}).json()["enterprise"]["kind"]
    assert client.patch(route, json={"kind": "internal"}).status_code == 200
    settings = client.get("/api/settings").json()
    assert all(key in settings["excluded"][line] for line in ("inspiration", "video"))
    for line in ("inspiration", "video"):
        overview = client.get("/api/overview", params={"line": line, "week": WEEK}).json()
        assert overview["tasks"]["comparableExcluded"] is not None
        assert overview["tasks"]["comparableExcluded"]["current"] <= overview["tasks"]["comparable"]["current"]
    assert client.patch(route, json={"kind": kind}).status_code == 200
    assert client.put("/api/settings", json=original).status_code == 200


def test_settings_thresholds_change_results_and_persist(client):
    original = client.get("/api/settings").json()
    candidate = json.loads(json.dumps(original["thresholds"]))
    candidate["inspiration"]["heavy"]["tasks"] = 100000
    candidate["inspiration"]["medium"]["tasks"] = 100000
    response = client.put("/api/settings", json={"thresholds": candidate})
    assert response.status_code == 200
    assert client.get("/api/overview", params={"line": "inspiration", "week": WEEK}).json()["stable"]["value"] == 0
    assert Store(client.app.state.store.directory).settings()["thresholds"] == candidate
    assert client.put("/api/settings", json=original).status_code == 200
    assert client.put("/api/settings", json={"rerunDailyPointLimit": -1}).status_code == 422
    assert client.put("/api/settings", json={"siteBaseUrl": "invalid"}).status_code == 422


def test_external_database_updates_refresh_cached_views(client):
    store = Store(client.app.state.store.directory)
    settings = store.settings()
    candidate = {**settings, "siteBaseUrl": settings["siteBaseUrl"] + "/"}
    with store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(candidate),))
    assert client.get("/api/meta").json()["siteBaseUrl"] == candidate["siteBaseUrl"]
    with store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(settings),))
    assert client.get("/api/meta").json()["siteBaseUrl"] == settings["siteBaseUrl"]


def test_notes_alerts_and_report_writes(client):
    key = enterprise_id(client)
    note = client.post(f"/api/enterprises/{key}/notes", json={"text": "接口验证备注"}).json()
    detail = client.get(f"/api/enterprises/{key}", params={"week": WEEK}).json()
    assert any(item["id"] == note["id"] for item in detail["notes"])
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert client.delete(f"/api/notes/{note['id']}").status_code == 404
    alert = client.get("/api/alerts", params={"line": "inspiration", "week": WEEK, "kind": "mismatch"}).json()[0]
    assert client.patch(f"/api/alerts/{alert['id']}", json={"dismissed": True}).json()["dismissed"]
    assert not client.patch(f"/api/alerts/{alert['id']}", json={"dismissed": False}).json()["dismissed"]
    report = client.put("/api/report", json={"week": WEEK, "done": "完成核验", "next": "继续联系客户", "source": "manual"})
    assert report.status_code == 200 and len(report.json()["lines"]) == 2
    assert client.put("/api/report", json={"week": WEEK, "done": "自动生成", "source": "agent"}).status_code == 409


def test_duplicate_upload_scan_and_malformed_upload(client):
    source = min((ROOT / "data/inbox").glob("*.xlsx"))
    with source.open("rb") as file:
        response = client.post("/api/imports", files={"file": (source.name, file, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert response.status_code == 200
    assert response.json()["inserted"] == 0
    assert client.post("/api/imports/scan").json() == []
    assert client.post("/api/imports", files={"file": ("invalid.txt", b"invalid")}).status_code == 422
    assert client.post("/api/imports", files={"file": ("invalid.xlsx", b"invalid")}).status_code == 422
    assert client.get("/api/imports").json()[0]["state"] == "failed"


def test_real_overlap_import_and_filename_range(client):
    store = client.app.state.store
    source = sorted((ROOT / "data/inbox").glob("*.xlsx"))[1]
    frame = pd.read_excel(source)
    with tempfile.TemporaryDirectory(prefix="overlap-", dir=store.directory / "work") as directory:
        path = Path(directory) / "overlapping_export.xlsx"
        frame.to_excel(path, index=False)
        response = import_file(store, path)
        assert response["inserted"] == 0 and response["updated"] == len(frame)
        assert response["error"] is not None
        assert response["from"] == "2026-11-02" and response["to"] == "2026-11-08"
    compare(read_spec("golden.json"), summarize(client.app.state.engine))


@pytest.mark.parametrize("route", ["/api/overview?line=inspiration&week=2026-11-03", "/api/tasks?line=invalid", "/api/tasks?line=inspiration&week=", "/api/unknown", "/api/enterprises/unknown?week=2026-11-02"])
def test_invalid_requests_return_api_error(client, route):
    response = client.get(route)
    assert response.status_code in (404, 422)
    assert set(response.json()) == {"code", "message"}


@pytest.mark.parametrize("url", ["https://example.com/image.png", "http://cdn.zhiyitech.cn/image.png", "https://cdn.zhiyitech.cn.evil.example/image.png", "https://user@cdn.zhiyitech.cn/image.png", "https://cdn.zhiyitech.cn:444/image.png"])
def test_media_domain_restrictions(client, url):
    assert client.get("/api/media/thumb", params={"url": url, "w": 480}).status_code == 422


def test_real_media_thumbnail_and_cached_response(client):
    engine = client.app.state.engine
    engine.refresh()
    urls = [url for inputs in engine.frame.inputs for url in inputs if urlsplit(url).hostname in ALLOWED_HOSTS and not urlsplit(url).path.lower().endswith((".mp4", ".mov"))]
    assert urls
    response = client.get("/api/media/thumb", params={"url": urls[0], "w": 240})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert "max-age=31536000" in response.headers["cache-control"]
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.width <= 240
    cached = client.get("/api/media/thumb", params={"url": urls[0], "w": 240})
    assert cached.content == response.content
