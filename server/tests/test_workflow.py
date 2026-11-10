import io

from openpyxl import load_workbook

from fd_desk.core import ROOT

WEEK = "2026-11-02"


def real_task(client):
    return client.get("/api/tasks", params={"line": "inspiration", "week": WEEK}).json()["items"][0]


def create_touch(client):
    task = real_task(client)
    response = client.post("/api/touches", json={"line": "inspiration", "week": WEEK, "slot": "mon", "enterprise": task["enterprise"]["id"],
        "goal": "help", "draft": task["prompt"], "owner": "接口验证", "source": "manual"})
    assert response.status_code == 200
    return response.json()


def test_matrix_matches_real_records(client):
    engine = client.app.state.engine
    for line in ("inspiration", "video"):
        response = client.get(f"/api/analysis/{line}", params={"week": WEEK})
        assert response.status_code == 200
        value = response.json()
        group = engine.group(line, WEEK)
        assert sum(cell["tasks"] for cell in value["matrix"]) == len(group)
        assert sum(round(cell["downloadRate"] * cell["tasks"]) for cell in value["matrix"]) == int(group.downloaded.sum())
        if line == "inspiration":
            cell = value["matrix"][0]
            part = group[(group.intent == cell["intent"]) & (group.model == cell["model"])]
            assert cell["enterpriseMedianDownloadRate"] == float(part.groupby("enterprise_id").downloaded.mean().median())
        else:
            assert sum(cell["points"] for cell in value["matrix"]) == int(group.points.sum())


def test_clusters_task_membership_and_disk_cache(client):
    params = {"line": "inspiration", "week": WEEK}
    clusters = client.get("/api/clusters", params=params).json()
    assert clusters
    cluster = clusters[0]
    tasks = client.get("/api/tasks", params={**params, "cluster": cluster["id"], "limit": 200}).json()
    assert tasks["total"] == cluster["uses"]
    assert all(task["pattern"] != "agent" for task in tasks["items"])
    engine = client.app.state.engine
    engine.cluster_cache.clear()
    assert client.get("/api/clusters", params=params).json() == clusters
    assert client.get("/api/tasks", params={**params, "cluster": "missing"}).status_code == 404


def test_draft_manual_protection_scope_and_links(client):
    cluster = client.get("/api/clusters", params={"line": "inspiration", "week": WEEK, "candidate": True}).json()[0]
    response = client.post("/api/drafts", json={"line": "inspiration", "title": cluster["intent"] or "提示词模板", "prompt": cluster["sample"], "slots": [], "clusterId": cluster["id"], "source": "manual"})
    assert response.status_code == 200
    draft = response.json()
    assert draft["scope"] == "owner"
    assert draft["sourceEnterprises"]
    denied = client.patch(f"/api/drafts/{draft['id']}", json={"title": "自动生成标题", "slots": ["参考图"], "source": "agent"})
    assert denied.status_code == 409
    unchanged = next(item for item in client.get("/api/drafts", params={"line": "inspiration"}).json() if item["id"] == draft["id"])
    assert unchanged["slots"] == []
    assert client.patch(f"/api/drafts/{draft['id']}", json={"scope": "general", "source": "agent"}).status_code == 409
    assert client.patch(f"/api/drafts/{draft['id']}", json={"status": "published"}).status_code == 422


def test_touch_edit_protection_export_and_atomic_import(client):
    touch = create_touch(client)
    key = touch["id"]
    assert client.patch(f"/api/touches/{key}", json={"draft": "自动改写", "status": "assigned", "source": "agent"}).status_code == 409
    board = client.get("/api/touches", params={"line": "inspiration", "week": WEEK}).json()
    assert any(item["id"] == key and item["status"] == "draft" for item in board["slots"]["mon"])
    output = client.get("/api/touches/export", params={"line": "inspiration", "week": WEEK, "owner": "接口验证"})
    workbook = load_workbook(io.BytesIO(output.content))
    sheet = workbook.active
    assert sheet.column_dimensions["N"].hidden
    assert sheet.cell(2, 14).value == key
    sheet.cell(2, 11, "已回复")
    sheet.cell(2, 12, "已收到")
    sheet.cell(2, 13, "2026-11-03")
    sheet.append([None] * 13 + ["不存在的卡片"])
    content = io.BytesIO()
    workbook.save(content)
    response = client.post("/api/touches/import", files={"file": ("touches.xlsx", content.getvalue())})
    assert response.json() == {"updated": 1, "skipped": 1, "errors": []}
    sheet.cell(2, 12, "尚未写入")
    sheet.cell(3, 14, key)
    content = io.BytesIO()
    workbook.save(content)
    workbook.close()
    invalid = client.post("/api/touches/import", files={"file": ("touches.xlsx", content.getvalue())}).json()
    assert invalid["updated"] == 0 and invalid["errors"]
    current = next(item for item in client.get("/api/touches", params={"line": "inspiration", "week": WEEK}).json()["slots"]["mon"] if item["id"] == key)
    assert current["reply"] == "已收到"
    assert current["outcome"] is None
    detail = client.get(f"/api/enterprises/{touch['enterprise']['id']}", params={"week": WEEK}).json()
    assert any(item["id"] == key for item in detail["touches"])
    report = client.get("/api/report", params={"week": WEEK}).json()
    assert report["touches"]["replied"] >= 1


def test_suggestion_acceptance_survives_recalculation(client):
    board = client.get("/api/touches", params={"line": "inspiration", "week": WEEK}).json()
    assert board["suggestions"]
    suggestion = board["suggestions"][0]
    key = suggestion["id"]
    updated = client.patch(f"/api/touches/{key}", json={"suggested": False, "draft": suggestion["draft"]["text"], "source": "manual"}).json()
    assert updated["suggested"] is False
    store = client.app.state.store
    with store.connection() as conn:
        conn.execute("DELETE FROM metadata WHERE key=?", (f"suggestions:inspiration:{WEEK}",))
    board = client.get("/api/touches", params={"line": "inspiration", "week": WEEK}).json()
    assert all(item["id"] != key for item in board["suggestions"])
    accepted = next(item for values in board["slots"].values() for item in values if item["id"] == key)
    assert accepted["draft"] == updated["draft"]


def test_owner_push_blocks_unrelated_real_enterprise(client):
    drafts = client.get("/api/drafts", params={"line": "inspiration"}).json()
    draft = next(item for item in drafts if item["scope"] == "owner")
    owners = {item["id"] for item in draft["sourceEnterprises"]}
    other = next(item["enterprise"]["id"] for item in client.get("/api/enterprises", params={"line": "inspiration", "week": WEEK}).json()["rows"] if item["enterprise"]["id"] not in owners)
    preview = client.post(f"/api/drafts/{draft['id']}/pushes", json={"enterprises": [other]}).json()
    assert preview["blocked"][0]["enterprise"]["id"] == other
    assert preview["receivers"] == []
    assert not any(key.startswith("_") for key in preview)
    assert client.post(f"/api/pushes/{preview['id']}/confirm", json={"receiverUserIds": [1]}).status_code == 422
    cancelled = client.post(f"/api/pushes/{preview['id']}/cancel").json()
    assert cancelled["state"] == "cancelled"
    assert client.post(f"/api/pushes/{preview['id']}/cancel").json() == cancelled


def test_rerun_real_model_preflight_requires_price_before_payment(client):
    directory = client.app.state.store.directory
    (directory / "runtime.json").symlink_to(ROOT / "data/runtime.json")
    task = real_task(client)
    response = client.post("/api/reruns", json={"sourceRowKey": task["rowKey"], "prompt": task["prompt"], "model": "gpt-image-2"})
    assert response.status_code == 200
    rerun = response.json()
    assert rerun["estimatedPoints"] is None and rerun["spentPoints"] is None
    assert rerun["provider"] == "litellm" and rerun["estimatedCost"] is None
    assert rerun["sourceTask"]["inputs"] == task["inputs"]
    assert client.post(f"/api/reruns/{rerun['id']}/confirm").json()["code"] == "rerun_price_required"
    assert not (directory / "reruns").exists()


def test_findings_and_cross_line_use_real_records(client):
    finding = client.get("/api/findings").json()[0]
    body = {key: value for key, value in finding.items() if key not in ("id", "updatedAt")}
    created = client.post("/api/findings", json=body).json()
    assert client.patch(f"/api/findings/{created['id']}", json={"verdict": "open"}).json()["verdict"] == "open"
    value = client.get("/api/cross-line", params={"week": WEEK}).json()
    first = {item["id"] for item in value["both"] + value["inspirationOnly"]}
    second = {item["id"] for item in value["both"] + value["videoOnly"]}
    engine = client.app.state.engine
    assert first == set(engine.group("inspiration", WEEK).enterprise_id)
    assert second == set(engine.group("video", WEEK).enterprise_id)
