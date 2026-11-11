import io
import json
import os
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from openai import pydantic_function_tool
from openpyxl import load_workbook
from PIL import Image

from fd_desk.app import create_app
from fd_desk.case_analysis import Result
from fd_desk.cases import BatchInput, CaseQuery
from fd_desk.core import ROOT, digest
from fd_desk.record_analysis import cleanup_images
from fd_desk.templates import Create as TemplateCreate


@pytest.fixture
def real_cases(tmp_path):
    previous_tempdir = tempfile.tempdir
    app = create_app(tmp_path)
    context = app.state.rework
    with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as source, context.store.connection() as copied:
        copied.executemany("INSERT INTO enterprises VALUES (?,?,?,?,?,?,?,?)", source.execute("SELECT * FROM enterprises"))
        copied.executemany("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", source.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE line IN ('inspiration','video') AND created_at>='2026-11-01' AND created_at<'2026-11-10'"))
        copied.executemany("INSERT INTO coverage VALUES (?,?,?)", source.execute("SELECT * FROM coverage WHERE day>='2026-11-01' AND day<'2026-11-10'"))
    client = TestClient(app)
    yield context, client
    context.jobs.shutdown()
    context.trials.shutdown()
    context.store.close()
    tempfile.tempdir = previous_tempdir


def page(client, **params):
    response = client.get("/api/cases", params={"line": "inspiration", "week": "2026-11-02", **params})
    assert response.status_code == 200
    return response.json()


def chain(context):
    context.cases.refresh()
    return next(fact for fact in context.cases.index.by_line["inspiration", "chain"] if fact.week == "2026-11-02" and len(fact.indices) >= 3)


def test_real_counts_outcomes_facets_and_detail(real_cases):
    context, client = real_cases
    result = page(client)
    assert sum(result["summary"]["outcomes"].values()) == result["total"]
    assert all(item["steps"] is None for item in result["items"])
    tasks = page(client, unit="task")
    overview = client.get("/api/overview", params={"line": "inspiration", "week": "2026-11-02"}).json()
    assert tasks["total"] == overview["tasks"]["value"]
    videos = page(client, line="video")
    assert all(item["unit"] == "task" for item in videos["items"])
    assert tasks["summary"]["outcomes"]["grind"] == 0
    filtered = page(client, outcome="bad", level="heavy,medium")
    counts = {item["key"]: item["count"] for item in filtered["facets"]["outcomes"]}
    assert counts["grind"] > 0 and counts["good"] > 0
    assert filtered["summary"] == result["summary"]
    fact = chain(context)
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain", "week": "2026-11-02"}).json()
    assert len(detail["steps"]) == detail["stepCount"] == len(fact.indices)
    assert fact.id == digest("chain|" + detail["first"]["rowKey"])
    assert [step["index"] for step in detail["steps"]] == list(range(len(fact.indices)))
    assert detail["last"] == detail["steps"][-1]
    for source in context.cases.index.by_line["inspiration", "chain"]:
        steps = [context.cases.index.rows[index] for index in source.indices]
        deleted = [index for index, row in enumerate(steps) if row.status == "deleted"]
        if deleted and not any(row.downloaded and row.status != "deleted" and not row.failed for row in steps[deleted[-1] + 1:]):
            assert source.outcome == "bad"
        if source.outcome == "grind":
            assert not steps[0].downloaded and any(row.downloaded for row in steps[1:])
    assert client.get("/api/cases", params={"line": "inspiration", "from": "2026-11-08", "to": "2026-11-02"}).status_code == 422
    assert client.get("/api/cases", params={"line": "inspiration", "limit": 201}).status_code == 422


def test_manual_review_inheritance_tags_and_annotations(real_cases):
    context, client = real_cases
    fact = chain(context)
    selection = {"items": [{"id": fact.id, "unit": "chain"}]}
    tag = client.get("/api/cases/tags", params={"line": "inspiration"}).json()[0]
    assert len(client.get("/api/cases/tags", params={"line": "video"}).json()) == 16
    response = client.put("/api/cases/reviews", json={**selection, "rating": "bad", "addTags": [tag["id"]], "status": "seen"})
    assert response.json() == {"updated": 1}
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert all(step["review"]["rating"] == "bad" and step["review"]["inherited"] for step in detail["steps"])
    step = detail["steps"][1]
    task_selection = {"items": [{"id": step["rowKey"], "unit": "task"}]}
    assert client.put("/api/cases/reviews", json={**task_selection, "rating": "good"}).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["steps"][1]["review"]["rating"] == "good"
    assert detail["steps"][1]["review"]["inherited"] is False
    assert detail["steps"][0]["review"]["inherited"] is True
    assert client.request("DELETE", "/api/cases/reviews", json=task_selection).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["steps"][1]["review"]["inherited"] is True
    context.profiles.add_annotation(fact.enterprise, "核对客户指令与最终结果", anchor={"block": "case:" + fact.id})
    context.profiles.add_annotation(fact.enterprise, "需要复核该步骤", anchor={"block": "record:" + step["rowKey"]})
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["annotationCount"] == len(detail["annotations"]) == 2
    assert len(page(client, noted="any")["items"]) >= 1
    issues = client.get("/api/cases/issues", params={"line": fact.line, "week": fact.week}).json()
    assert issues[0]["cases"] == 1 and len(issues[0]["weekly"]) == 8
    assert issues[0]["weekly"][-1]["cases"] == 1
    assert client.patch(f'/api/cases/tags/{tag["id"]}', json={"archived": True}).status_code == 200
    assert tag["id"] not in {item["id"] for item in client.get("/api/cases/tags", params={"line": "inspiration"}).json()}
    assert tag["id"] in {item["id"] for item in client.get("/api/cases/tags", params={"line": "inspiration", "all": 1}).json()}
    assert client.delete(f'/api/cases/tags/{tag["id"]}').status_code == 404
    assert client.request("DELETE", "/api/cases/reviews", json=selection).status_code == 200
    assert client.get("/api/cases/issues", params={"line": fact.line, "week": fact.week}).json() == []


@pytest.mark.parametrize("strategy", ["stratified", "problems", "per_enterprise", "per_intent"])
def test_sampling_collections_and_exports(real_cases, strategy):
    _context, client = real_cases
    body = {"line": "inspiration", "from": "2026-11-02", "to": "2026-11-08", "unit": "chain", "filters": {}, "strategy": strategy, "size": 20, "perGroup": 3, "seed": 817}
    first = client.post("/api/cases/batches", json=body)
    assert first.status_code == 200
    first = first.json()
    assert 0 < len(first["items"]) <= 20
    rows = client.get(f'/api/cases/batches/{first["id"]}').json()["rows"]
    assert [(row["id"], row["unit"]) for row in rows] == [(item["id"], item["unit"]) for item in first["items"]]
    if strategy == "stratified":
        assert max(Counter(row["enterprise"]["id"] for row in rows).values()) <= 5
    if strategy == "problems":
        assert all(row["outcome"] in ("bad", "grind") for row in rows)
    if strategy == "per_enterprise":
        assert max(Counter(row["enterprise"]["id"] for row in rows).values()) <= 3
    if strategy == "per_intent":
        assert max(Counter(row["intent"] for row in rows).values()) <= 3
    selection = {"items": first["items"][:3]}
    assert client.put("/api/cases/reviews", json={**selection, "rating": "bad"}).status_code == 200
    assert client.get(f'/api/cases/batches/{first["id"]}').json()["reviewed"] == 3
    assert client.delete(f'/api/cases/batches/{first["id"]}').status_code == 204
    second = client.post("/api/cases/batches", json=body).json()
    assert not {item["id"] for item in first["items"]} & {item["id"] for item in second["items"]}
    collection = client.post("/api/cases/collections", json={"line": "inspiration", "name": "运营复核案例"}).json()
    response = client.put(f'/api/cases/collections/{collection["id"]}/items', json={"add": selection["items"]})
    assert response.json()["count"] == 3
    assert page(client, collection=collection["id"])["total"] == 3
    exported = client.get("/api/cases/export", params={"line": "inspiration", "ids": ",".join(item["id"] for item in selection["items"]), "unit": "chain"})
    assert exported.status_code == 200
    book = load_workbook(io.BytesIO(exported.content), read_only=True)
    assert book["记录"].max_row == 4
    details = [client.get(f'/api/cases/{item["id"]}', params={"unit": "chain"}).json() for item in selection["items"]]
    assert book["步骤"].max_row == sum(detail["stepCount"] for detail in details) + 1
    values = list(book["记录"].values)
    assert any(value for row in values[1:] for value in row[16:18])
    book.close()
    assert client.patch(f'/api/cases/collections/{collection["id"]}', json={"name": "已复核案例"}).status_code == 200
    assert client.delete(f'/api/cases/collections/{collection["id"]}').status_code == 204
    assert page(client, collection=collection["id"])["total"] == 0


def test_case_links_and_analysis_input(real_cases):
    context, client = real_cases
    fact = chain(context)
    followup = client.post("/api/followups", json={"line": fact.line, "week": fact.week, "enterprise": fact.enterprise, "goal": "help", "attachments": [{"kind": "case", "id": fact.id}]})
    assert followup.status_code == 200
    assert followup.json()["attachments"][0]["target"]["page"] == "cases"
    template = client.post("/api/templates", json={"line": fact.line, "kind": "custom", "target": fact.enterprise, "caseIds": [fact.id], "write": False})
    assert template.status_code == 200
    assert template.json()["template"]["sourceCases"][0]["id"] == fact.id
    candidates = client.get("/api/trials/candidates", params={"caseIds": fact.id, "template": template.json()["template"]["id"]})
    assert candidates.status_code == 200
    assert candidates.json()[0]["rowKey"] == context.cases.index.rows[fact.indices[0]].row_key
    inputs = context.case_analyses.inputs([fact], "需要核对哪些质量问题")
    images = context.case_analyses.images(inputs, context.store.directory / "analysis-images")
    assert len(inputs["cases"][0]["steps"]) == len(fact.indices)
    assert all(image["references"][0]["caseId"] == fact.id for image in images)
    assert pydantic_function_tool(Result)["function"]["parameters"]["additionalProperties"] is False
    response = client.post("/api/cases/analyses/estimate", json={"items": [{"id": fact.id, "unit": fact.unit}]})
    assert response.status_code == 200
    assert response.json()["cases"] == 1 and response.json()["images"] == len(images)
    assert response.json()["estimated"] is None
    assert context.repo.find("case_analysis") == []
    with context.store.connection() as conn:
        assert conn.execute("SELECT count(*) FROM case_reviews").fetchone()[0] == 0
    assert client.get("/api/cases/analyses", params={"line": fact.line}).json() == []
    assert CaseQuery(line=fact.line, week=fact.week).unit is None
    assert BatchInput.model_validate({"line": fact.line, "from": "2026-11-02", "to": "2026-11-08", "unit": fact.unit, "strategy": "stratified", "size": 20}).seed == 0
    assert json.loads(json.dumps(inputs))["cases"][0]["id"] == fact.id


@pytest.mark.skipif(os.environ.get("R3_NETWORK_TEST") != "1", reason="需显式运行真实图片读取测试")
def test_template_case_input_and_output_images(real_cases):
    context, _ = real_cases
    fact = chain(context)
    item = context.templates.create(TemplateCreate(line=fact.line, kind="custom", target=fact.enterprise, caseIds=[fact.id], write=False))["template"]
    directory = context.store.directory / "analysis" / "case-template-images"
    try:
        inputs = context.templates._write_inputs(item, {"kind": "write"}, directory.name)
        assert inputs["sourceCases"][0]["id"] == fact.id
        references = [reference for image in inputs["images"] for reference in image["references"] if reference.get("caseId") == fact.id]
        assert {reference["kind"] for reference in references} == {"inputs", "outputs"}
        assert len({image["source"] for image in inputs["images"]}) == len(inputs["images"])
        steps = inputs["sourceCases"][0]["steps"]
        for image in inputs["images"]:
            path = Path(image["path"])
            assert path.is_file() and path.is_relative_to(directory)
            with Image.open(path) as decoded:
                decoded.verify()
            for reference in image["references"]:
                if reference.get("caseId") == fact.id:
                    step = steps[reference["index"]]
                    assert step["rowKey"] == reference["rowKey"]
                    assert image["source"] in {media["url"] for media in step[reference["kind"]]}
    finally:
        cleanup_images(directory, directory / "images")
    assert not (directory / "images").exists()


def test_review_atomicity_clear_override_and_tag_only_issues(real_cases):
    context, client = real_cases
    fact = chain(context)
    target = {"id": fact.id, "unit": fact.unit}
    invalid = client.put("/api/cases/reviews", json={"items": [target, {"id": "absent", "unit": "task"}], "rating": "bad"})
    assert invalid.status_code == 404
    assert client.put("/api/cases/reviews", json={"items": [target] * 501, "rating": "bad"}).status_code == 422
    with context.store.connection() as conn:
        assert conn.execute("SELECT count(*) FROM case_reviews").fetchone()[0] == 0
    assert client.put("/api/cases/reviews", json={"items": [target], "addTags": ["quality_defect"]}).status_code == 200
    issues = client.get("/api/cases/issues", params={"line": fact.line, "week": fact.week}).json()
    assert issues[0]["cases"] == 1 and issues[0]["tag"]["id"] == "quality_defect"
    assert client.put("/api/cases/reviews", json={"items": [target], "rating": "bad"}).status_code == 200
    key = context.cases.index.rows[fact.indices[1]].row_key
    step_target = {"id": key, "unit": "task"}
    assert client.put("/api/cases/reviews", json={"items": [step_target], "rating": "good", "removeTags": ["quality_defect"]}).status_code == 200
    assert client.request("DELETE", "/api/cases/reviews", json={"items": [target]}).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()
    assert detail["review"] is None and detail["steps"][0]["review"] is None
    assert detail["steps"][1]["review"]["rating"] == "good" and detail["steps"][1]["review"]["inherited"] is False
    assert client.post("/api/cases/batches", json={"line": fact.line, "from": "2026-11-02", "to": "2026-11-08", "unit": fact.unit, "strategy": "problems", "size": 10, "filters": {"outcome": "invalid"}}).status_code == 422
    assert client.get("/api/export/cases", params={"line": fact.line, "from": "2026-11-02"}).status_code == 422


def test_deterministic_sampling_and_bundle(real_cases):
    context, client = real_cases
    directory = context.store.directory / "replica"
    directory.mkdir()
    with context.store.connection() as source, sqlite3.connect(directory / "fd-desk.db") as destination:
        source.backup(destination)
    replica = create_app(directory).state.rework
    body = BatchInput.model_validate({"line": "inspiration", "from": "2026-11-02", "to": "2026-11-08", "unit": "chain", "strategy": "stratified", "size": 20, "seed": 71})
    first = context.cases.sample(body)
    second = replica.cases.sample(body)
    assert first["items"] == second["items"]
    replica.jobs.shutdown()
    replica.trials.shutdown()
    replica.store.close()
    ids = ",".join(item["id"] for item in first["items"][:3])
    job = client.post("/api/export/bundle", json={"items": [{"kind": "cases", "params": {"line": "inspiration", "unit": "chain", "ids": ids}}]}).json()
    context.jobs.wait(job["id"])
    response = client.get(f'/api/export/download/{job["id"]}')
    assert response.status_code == 200
    with ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["01_cases.xlsx"]
        book = load_workbook(io.BytesIO(archive.read("01_cases.xlsx")), read_only=True)
        assert book["记录"].max_row == 4 and "步骤" in book.sheetnames
        book.close()
