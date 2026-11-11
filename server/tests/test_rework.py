import io
from zipfile import ZipFile

import pytest
from openpyxl import load_workbook

from fd_desk.exports import KINDS

WEEK = "2026-11-02"


def task_and_enterprise(client):
    response = client.get("/api/tasks", params={"line": "inspiration", "week": WEEK, "limit": 1})
    assert response.status_code == 200
    task = response.json()["items"][0]
    return task, task["enterprise"]["id"]


def workbook_rows(content):
    book = load_workbook(io.BytesIO(content), read_only=True)
    try:
        return list(book.active.iter_rows(values_only=True))
    finally:
        book.close()


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("line", ("inspiration", "video"))
def test_all_export_workbooks_from_real_records(client, kind, line):
    _, enterprise = task_and_enterprise(client)
    response = client.get(f"/api/export/{kind}", params={"line": line, "week": WEEK, "enterprise": enterprise})
    assert response.status_code == 200
    rows = workbook_rows(response.content)
    assert rows and all(isinstance(value, str) and value for value in rows[0])
    assert all(len(row) == len(rows[0]) for row in rows)
    for row in rows[1:]:
        for value in row:
            assert not isinstance(value, str) or "https://img" not in value


def test_task_export_limit_and_selected_roster(client):
    response = client.get("/api/export/tasks", params={"line": "inspiration", "week": WEEK})
    assert response.status_code == 422
    assert response.json()["code"] == "export_task_limit"
    assert "5000" in response.json()["message"]
    _, enterprise = task_and_enterprise(client)
    result = client.get("/api/export/roster", params={"line": "inspiration", "week": WEEK, "ids": enterprise})
    rows = workbook_rows(result.content)
    assert len(rows) == 2 and rows[1][0] == enterprise
    assert client.get("/api/export/roster", params={"line": "inspiration", "week": WEEK, "ids": "unknown"}).status_code == 422


def test_roster_export_includes_conversion_candidates(client):
    response = client.get("/api/export/roster", params={"line": "video", "week": WEEK})
    assert response.status_code == 200
    expected = client.get("/api/enterprises", params={"line": "video", "week": WEEK}).json()["rows"]
    assert len(workbook_rows(response.content)) == len(expected) + 1


def test_bundle_contains_requested_workbooks(client):
    items = [{"kind": kind, "params": {"line": "video", "week": WEEK}} for kind in ("roster", "analysis_matrix", "analysis_failures")]
    response = client.post("/api/export/bundle", json={"items": items})
    assert response.status_code == 200
    job = response.json()
    assert job["kind"] == "export"
    future = client.app.state.rework.jobs.active.get(job["id"])
    if future is not None:
        future.result(timeout=30)
    finished = client.app.state.rework.jobs.wait(job["id"])
    assert finished["state"] == "done"
    assert finished["progress"] == {"done": 3, "total": 3}
    download = client.get(finished["result"]["url"])
    assert download.status_code == 200
    with ZipFile(io.BytesIO(download.content)) as archive:
        assert archive.namelist() == [f"{index:02d}_{item['kind']}.xlsx" for index, item in enumerate(items, 1)]
        assert archive.testzip() is None
        for name in archive.namelist():
            assert workbook_rows(archive.read(name))


def test_followup_updates_preserve_manual_script_and_annotations(client):
    task, enterprise = task_and_enterprise(client)
    response = client.post("/api/followups", json={"line": "inspiration", "week": WEEK, "enterprise": enterprise,
                           "goal": "help", "reason": task["scene"], "script": task["prompt"]})
    assert response.status_code == 200
    item = response.json()
    initial = client.get("/api/annotations", params={"enterprise": enterprise}).json()
    updated = client.patch(f"/api/followups/{item['id']}", json={"state": "contacted"})
    assert updated.status_code == 200
    assert updated.json()["contactedAt"]
    annotations = client.get("/api/annotations", params={"enterprise": enterprise}).json()
    assert len(annotations) == len(initial) + 1
    assert any(annotation["kind"] == "followup" for annotation in annotations)
    assert client.patch(f"/api/followups/{item['id']}", json={"state": "contacted"}).status_code == 200
    assert len(client.get("/api/annotations", params={"enterprise": enterprise}).json()) == len(annotations)
    client.app.state.rework.followups.suggest("inspiration", WEEK)
    board = client.get("/api/followups", params={"line": "inspiration", "week": WEEK}).json()
    saved = next(value for value in board["items"] if value["id"] == item["id"])
    assert saved["script"] == item["script"] and saved["script"]["source"] == "manual"
    assert len(board["suggestions"]) <= 12
    assert all(value["goal"] != "convert" for value in board["suggestions"])


def test_legacy_touch_writes_are_visible_in_followups(client):
    task, enterprise = task_and_enterprise(client)
    old = client.post("/api/touches", json={"line": "inspiration", "week": WEEK, "slot": "mon", "enterprise": enterprise,
        "goal": "help", "draft": task["prompt"], "source": "manual"})
    assert old.status_code == 200
    key = old.json()["id"]
    board = client.get("/api/followups", params={"line": "inspiration", "week": WEEK}).json()
    assert any(value["id"] == key for value in board["items"])
    assert client.patch(f"/api/followups/{key}", json={"state": "contacted"}).status_code == 200
    legacy = client.get("/api/touches", params={"line": "inspiration", "week": WEEK}).json()
    value = next(value for items in legacy["slots"].values() for value in items if value["id"] == key)
    assert value["status"] == "sent" and value["draft"]["text"] == task["prompt"]


def test_legacy_note_removal_also_removes_migrated_annotation(client):
    task, enterprise = task_and_enterprise(client)
    note = client.post(f"/api/enterprises/{enterprise}/notes", json={"text": task["prompt"]}).json()
    key = "note-" + note["id"]
    assert any(value["id"] == key for value in client.get("/api/annotations", params={"enterprise": enterprise}).json())
    assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert all(value["id"] != key for value in client.get("/api/annotations", params={"enterprise": enterprise}).json())
    assert all(value["id"] != key for value in client.app.state.rework.repo.find("annotation", enterprise=enterprise))


def test_code_recheck_appends_without_modifying_finding(client):
    finding = next(value for value in client.get("/api/findings").json() if (value.get("rule") or {}).get("kind") == "mismatch")
    response = client.post(f"/api/findings/{finding['id']}/recheck")
    assert response.status_code == 200
    job = client.app.state.rework.jobs.wait(response.json()["id"])
    assert job["state"] == "done"
    current = next(value for value in client.get("/api/findings").json() if value["id"] == finding["id"])
    assert {key: value for key, value in current.items() if key != "rechecks"} == {key: value for key, value in finding.items() if key != "rechecks"}
    assert len(current["rechecks"]) == len(finding["rechecks"]) + 1
    assert current["rechecks"][-1]["verdict"] in ("confirmed", "refuted", "open")


def test_pipeline_reports_real_model_configuration_failure_and_continues(client):
    context = client.app.state.rework
    assert not (context.store.directory / "runtime.json").exists()
    response = client.post("/api/pipeline/run", json={"steps": ["opportunities", "followups", "monitor"], "week": WEEK})
    assert response.status_code == 200
    context.pipeline.executor.submit(lambda: None).result(timeout=90)
    result = client.get("/api/pipeline").json()["latest"]
    assert result["id"] == response.json()["id"] and result["finishedAt"]
    states = {step["kind"]: step for step in result["steps"]}
    assert states["opportunities"]["state"] == "failed"
    assert states["opportunities"]["error"]
    assert states["followups"]["state"] == "done"
    assert states["monitor"]["state"] == "done"
    rerun = client.post("/api/pipeline/run", json={"steps": ["followups"], "week": WEEK})
    assert rerun.status_code == 200 and rerun.json()["id"] != result["id"]
    context.pipeline.executor.submit(lambda: None).result(timeout=30)
    assert client.get("/api/pipeline").json()["latest"]["steps"][0]["state"] == "done"
