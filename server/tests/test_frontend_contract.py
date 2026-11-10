import io
import json

from openpyxl import load_workbook

from fd_desk.views import report

WEEK = "2026-11-02"


def test_model_filter_uses_all_enterprise_tasks(client):
    for line in ("inspiration", "video"):
        base = client.get("/api/enterprises", params={"line": line, "week": WEEK}).json()
        group = client.app.state.engine.group(line, WEEK)
        assert set(base["models"]) == set(group.model.dropna().unique())
        for model in base["models"]:
            result = client.get("/api/enterprises", params={"line": line, "week": WEEK, "model": model})
            assert result.status_code == 200
            data = result.json()
            expected = set(group.loc[group.model == model, "enterprise_id"])
            assert {row["enterprise"]["id"] for row in data["rows"]} == expected
            assert data["poolCounts"] == base["poolCounts"]


def test_selected_export_contains_exact_enterprises(client):
    rows = client.get("/api/enterprises", params={"line": "inspiration", "week": WEEK}).json()["rows"][:2]
    response = client.get("/api/enterprises/export", params={"line": "inspiration", "week": WEEK, "ids": ",".join(row["enterprise"]["id"] for row in rows)})
    assert response.status_code == 200
    workbook = load_workbook(io.BytesIO(response.content))
    assert workbook.active.max_row == 3
    assert {row[0] for row in workbook.active.iter_rows(min_row=2, values_only=True)} == {row["enterprise"]["name"] for row in rows}
    workbook.close()
    assert client.get("/api/enterprises/export", params={"line": "inspiration", "week": WEEK, "ids": "unknown"}).status_code == 422


def test_draft_scope_is_explicit_and_preserves_sources(client):
    cluster = client.get("/api/clusters", params={"line": "inspiration", "week": WEEK, "candidate": True}).json()[0]
    body = {"line": "inspiration", "title": cluster["intent"] or cluster["sample"][:20], "prompt": cluster["sample"], "slots": [], "clusterId": cluster["id"], "scope": "general", "source": "manual"}
    response = client.post("/api/drafts", json=body)
    assert response.status_code == 200
    assert response.json()["scope"] == "general"
    assert response.json()["sourceEnterprises"]
    assert client.post("/api/drafts", json={**body, "source": "agent"}).status_code == 409
    body.pop("clusterId")
    assert client.post("/api/drafts", json={**body, "scope": "owner"}).status_code == 422


def test_editing_a_mapped_draft_requires_new_publication(client):
    engine = client.app.state.engine
    template = engine.catalog[0]
    prompt = "".join(item.get("value", "") for item in json.loads(template["templateConfig"]) if item.get("type") == "text")
    task = client.get("/api/tasks", params={"line": "inspiration", "week": WEEK}).json()["items"][0]
    draft = client.post("/api/drafts", json={"line": "inspiration", "title": template["name"], "prompt": prompt, "slots": [], "source": "manual"}).json()
    mapped = client.patch(f"/api/drafts/{draft['id']}", json={"fdTemplateId": template["id"], "fdTemplateSource": "official"})
    assert mapped.status_code == 200
    unchanged = client.patch(f"/api/drafts/{draft['id']}", json={"prompt": prompt, "source": "manual"})
    assert unchanged.status_code == 200 and unchanged.json()["fdTemplateId"] == template["id"]
    edited = client.patch(f"/api/drafts/{draft['id']}", json={"prompt": task["prompt"], "source": "manual"})
    assert edited.status_code == 200
    assert edited.json()["fdTemplateId"] is None
    assert edited.json()["link"] is None
    assert edited.json()["status"] == "draft"


def test_top_customer_comparison_is_independent_of_exclusion_settings(client):
    engine = client.app.state.engine
    original = client.get("/api/settings").json()
    before = {}
    for line in ("inspiration", "video"):
        current, previous, days = engine.comparable(line, WEEK)
        assert days
        top = current.groupby("enterprise_id").points.sum().idxmax() if line == "video" else current.enterprise_id.value_counts().idxmax()
        expected = {"current": int(current.loc[current.enterprise_id != top, "points"].sum()) if line == "video" else int((current.enterprise_id != top).sum()),
            "previous": int(previous.loc[previous.enterprise_id != top, "points"].sum()) if line == "video" else int((previous.enterprise_id != top).sum())}
        overview = client.get("/api/overview", params={"line": line, "week": WEEK}).json()
        before[line] = overview["concentration"]["withoutTop1"]
        assert before[line] == expected
    assert client.put("/api/settings", json={"excluded": {"inspiration": [], "video": []}}).status_code == 200
    for line in ("inspiration", "video"):
        overview = client.get("/api/overview", params={"line": line, "week": WEEK}).json()
        assert overview["tasks"]["comparableExcluded"] is None
        assert overview["concentration"]["withoutTop1"] == before[line]
    result = report(engine, WEEK)
    assert all(line["withoutTop1"] == before[line["line"]] for line in result["lines"])
    assert client.put("/api/settings", json=original).status_code == 200


def test_report_describes_real_changes_in_task_composition(client):
    result = client.get("/api/report", params={"week": WEEK}).json()
    engine = client.app.state.engine
    for line in result["lines"]:
        for mover in line["falling"] + line["rising"]:
            current, previous, _ = engine.comparable(line["line"], WEEK, mover["enterprise"]["id"])
            assert f"活跃天数{previous.day.nunique()}→{current.day.nunique()}" in mover["reason"]
            dimension = "intent" if line["line"] == "inspiration" else "mode"
            assert any(str(key) in mover["reason"] for key in set(current[dimension]) | set(previous[dimension])) or mover["current"] == mover["previous"]
