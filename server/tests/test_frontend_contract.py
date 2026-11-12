import io

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


def test_template_scope_preserves_real_sources(client):
    cluster = client.get("/api/clusters", params={"line": "inspiration", "week": WEEK, "candidate": True}).json()[0]
    body = {"line": "inspiration", "kind": "official", "clusterIds": [cluster["id"]], "write": False,
            "content": {"title": cluster["intent"] or "提示词模板", "prompt": cluster["sample"]}}
    response = client.post("/api/templates", json=body)
    assert response.status_code == 200
    value = response.json()["template"]
    assert value["kind"] == "official" and value["target"] is None
    assert value["origin"]["clusterIds"] == [cluster["id"]]
    assert value["origin"]["uses"] == cluster["uses"]
    assert value["current"]["source"] == "manual"
    assert client.post("/api/templates", json={**body, "kind": "custom"}).status_code == 422


def test_template_edit_retains_content_history(client):
    engine = client.app.state.engine
    template = engine.catalog[0]
    task = client.get("/api/tasks", params={"line": "inspiration", "week": WEEK}).json()["items"][0]
    draft = client.post("/api/templates", json={"line": "inspiration", "kind": "custom", "target": task["enterprise"]["id"],
        "content": {"title": template["name"][:10], "prompt": task["prompt"]}, "write": False}).json()["template"]
    mapped = client.patch(f"/api/templates/{draft['id']}", json={"fdTemplateId": template["id"]})
    assert mapped.status_code == 200
    content = {**draft["current"]["content"], "fits": task["scene"]}
    edited = client.patch(f"/api/templates/{draft['id']}", json={"content": content})
    assert edited.status_code == 200
    value = edited.json()
    assert value["fdTemplateId"] == template["id"]
    assert value["current"]["version"] == 2
    assert value["versions"][0]["content"] == draft["current"]["content"]
    assert value["current"]["content"] == content


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
