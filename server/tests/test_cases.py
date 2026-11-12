import io
import json
import os
import sqlite3
import tempfile
import time
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
from fd_desk.case_costs import CaseCosts
from fd_desk.cases import BatchInput, CaseQuery, Cases
from fd_desk.core import ROOT, digest
from fd_desk.record_analysis import cleanup_images
from fd_desk.templates import Create as TemplateCreate


@pytest.fixture
def real_cases(tmp_path):
    previous_tempdir = tempfile.tempdir
    app = create_app(tmp_path)
    context = app.state.rework
    try:
        configuration = json.loads((ROOT / "data/runtime.json").read_text())
        pricing = configuration["caseAnalysisPricing"]
        pricing["historyDirectories"] = [str((ROOT / "data" / value).resolve()) for value in pricing["historyDirectories"]]
        (tmp_path / "runtime.json").write_text(json.dumps(configuration))
        with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as source, context.store.connection() as copied:
            copied.executemany("INSERT INTO enterprises(id,name,admin_phone,kind,contract,sales,after_sales,summary,owner_manual) VALUES (?,?,?,?,?,?,?,?,?)", source.execute("SELECT id,name,admin_phone,kind,contract,sales,after_sales,summary,owner_manual FROM enterprises"))
            copied.executemany("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", source.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE line IN ('inspiration','video') AND created_at>='2026-11-01' AND created_at<'2026-11-10'"))
            copied.executemany("INSERT INTO coverage VALUES (?,?,?)", source.execute("SELECT * FROM coverage WHERE day>='2026-11-01' AND day<'2026-11-10'"))
        client = TestClient(app)
        yield context, client
    finally:
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
    inspiration = client.get("/api/cases/tags", params={"line": "inspiration"}).json()
    video = client.get("/api/cases/tags", params={"line": "video"}).json()
    assert len(inspiration) == 13 and len(video) == 16
    video_tags = {value["id"] for value in video if value["lines"] == ["video"]}
    assert video_tags == {"motion_stiff", "video_inconsistent", "video_pacing"}
    assert not video_tags & {value["id"] for value in inspiration}
    assert client.patch("/api/cases/tags/motion_stiff", json={"lines": []}).status_code == 422
    assert client.put("/api/cases/reviews", json={**selection, "addTags": ["motion_stiff"]}).status_code == 422
    response = client.put("/api/cases/reviews", json={**selection, "rating": "bad", "addTags": [tag["id"]], "status": "seen"})
    assert response.json() == {"updated": 1}
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["processed"] == "done" and detail["review"]["processedAt"]
    processed_at = detail["review"]["processedAt"]
    assert "rating" not in detail["review"] and "status" not in detail["review"]
    assert all(step["review"]["tags"] == [] and step["review"]["effectiveTags"] == [tag["id"]] and step["review"]["inherited"] for step in detail["steps"])
    assert page(client, scope="library", week="2020-01-06")["total"] == 1
    step = detail["steps"][1]
    task_selection = {"items": [{"id": step["rowKey"], "unit": "task"}]}
    assert client.put("/api/cases/reviews", json={**task_selection, "setTags": ["color_shift"]}).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["steps"][1]["review"]["effectiveTags"] == ["color_shift"]
    assert detail["steps"][1]["review"]["inherited"] is False
    assert detail["steps"][0]["review"]["inherited"] is True
    assert set(detail["review"]["effectiveTags"]) == {tag["id"], "color_shift"}
    assert detail["review"]["processedAt"] == processed_at
    assert client.request("DELETE", "/api/cases/reviews", json=task_selection).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["steps"][1]["review"]["inherited"] is True
    context.profiles.add_annotation(fact.enterprise, "核对客户指令与最终结果", anchor={"block": "case:" + fact.id})
    context.profiles.add_annotation(fact.enterprise, "需要复核该步骤", anchor={"block": "record:" + step["rowKey"]})
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": "chain"}).json()
    assert detail["annotationCount"] == len(detail["annotations"]) == 2
    assert detail["steps"][1]["annotationCount"] == 1
    assert len(page(client, noted="any")["items"]) >= 1
    issues = client.get("/api/cases/issues", params={"line": fact.line, "week": fact.week}).json()
    assert issues[0]["cases"] == 1 and len(issues[0]["weekly"]) == 8
    assert next(value for value in issues[0]["weekly"] if value["week"] == fact.week)["cases"] == 1
    assert client.patch(f'/api/cases/tags/{tag["id"]}', json={"archived": True}).status_code == 200
    assert tag["id"] not in {item["id"] for item in client.get("/api/cases/tags", params={"line": "inspiration"}).json()}
    assert tag["id"] in {item["id"] for item in client.get("/api/cases/tags", params={"line": "inspiration", "all": 1}).json()}
    assert client.delete(f'/api/cases/tags/{tag["id"]}').status_code == 404
    assert client.request("DELETE", "/api/cases/reviews", json=selection).status_code == 200
    assert client.get("/api/cases/issues", params={"line": fact.line, "week": fact.week}).json() == []
    assert page(client, processed="noted")["total"] == 1
    assert page(client, scope="library")["total"] == 0


@pytest.mark.parametrize("strategy", ["stratified", "problems", "per_enterprise", "per_intent"])
def test_sampling_pool_and_exports(real_cases, strategy):
    _context, client = real_cases
    body = {"line": "inspiration", "from": "2026-11-02", "to": "2026-11-08", "unit": "chain", "filters": {"sort": "newest", "offset": "999", "limit": "1"}, "strategy": strategy, "size": 20, "perGroup": 3, "seed": 817}
    first = client.post("/api/cases/batches", json=body)
    assert first.status_code == 200
    first = first.json()
    assert not {"line", "from", "to", "unit", "sort", "offset", "limit"} & first["filters"].keys()
    assert len(first["items"]) == body["size"]
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
    assert client.put("/api/cases/reviews", json={**selection, "addTags": ["quality_defect"]}).status_code == 200
    assert client.get(f'/api/cases/batches/{first["id"]}').json()["processed"] == 3
    assert client.delete(f'/api/cases/batches/{first["id"]}').status_code == 204
    second = client.post("/api/cases/batches", json=body).json()
    assert not {item["id"] for item in first["items"]} & {item["id"] for item in second["items"]}
    response = client.put('/api/cases/pool', json={"line": "inspiration", "add": selection["items"]})
    assert response.json()["updated"] == 3
    assert page(client, pool="any")["total"] == 3
    exported = client.get("/api/cases/export", params={"line": "inspiration", "ids": ",".join(item["id"] for item in selection["items"]), "unit": "chain"})
    assert exported.status_code == 200
    book = load_workbook(io.BytesIO(exported.content), read_only=True)
    assert book["记录"].max_row == 4
    details = [client.get(f'/api/cases/{item["id"]}', params={"unit": "chain"}).json() for item in selection["items"]]
    assert book["步骤"].max_row == sum(detail["stepCount"] for detail in details) + 1
    values = list(book["记录"].values)
    assert any(value for row in values[1:] for value in row[16:18])
    assert {"处理时间", "生效标签", "批注数", "最近3条批注", "是否在可做模板池", "池备注"} <= set(values[0])
    assert not {"评价", "状态", "收藏夹"} & set(values[0])
    book.close()
    assert client.get("/api/cases/collections", params={"line": "inspiration"}).status_code == 404
    assert client.put("/api/cases/pool", json={"line": "inspiration", "remove": selection["items"]}).status_code == 200
    assert page(client, pool="any")["total"] == 0


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
    assert response.json()["estimated"] > 0 and response.json()["currency"] == "USD"
    assert context.repo.find("case_analysis") == []
    with context.store.connection() as conn:
        assert conn.execute("SELECT count(*) FROM case_reviews").fetchone()[0] == 0
    assert client.get("/api/cases/analyses", params={"line": fact.line}).json() == []
    assert CaseQuery(line=fact.line, week=fact.week).unit is None
    assert BatchInput.model_validate({"line": fact.line, "from": "2026-11-02", "to": "2026-11-08", "unit": fact.unit, "strategy": "stratified", "size": 20}).seed == 0
    assert json.loads(json.dumps(inputs))["cases"][0]["id"] == fact.id


def test_case_price_uses_real_cli_usage(real_cases):
    context, _ = real_cases
    costs = context.case_analyses.costs
    price, source = costs.price()
    assert price["model"] == json.loads((context.store.directory / "runtime.json").read_text())["model"]
    with sqlite3.connect(f'{Path(source["database"]).as_uri()}?mode=ro', uri=True) as connection:
        actual = connection.execute("SELECT input_cost_per_million,output_cost_per_million,cache_read_cost_per_million FROM model_pricing WHERE model_id=?", (price["model"],)).fetchone()
    assert (price["input"], price["output"], price["cacheRead"]) == actual
    history = Path(source["historyDirectories"][0])
    directory = next(path.parent for path in history.glob("*/usage.json"))
    usage = json.loads((directory / "usage.json").read_text())
    assert costs.amount(usage, price) > 0
    full_price = costs.amount({"input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"]}, price)
    assert costs.amount(usage, price) < full_price
    inputs = json.loads((directory / "input.json").read_text())
    quoted, snapshot = costs.quote(inputs)
    assert quoted["estimated"] > 0 and quoted["currency"] == "USD" and quoted["spent"] is None
    assert snapshot == price
    assert CaseCosts.dimensions(inputs)[0] == len(inputs["cases"])


def test_existing_batch_filters_and_video_tag_scope(real_cases):
    context, client = real_cases
    batch = client.post("/api/cases/batches", json={"line": "inspiration", "from": "2026-11-02", "to": "2026-11-08", "unit": "chain", "filters": {"outcome": "bad"}, "strategy": "problems", "size": 5}).json()
    selected = batch["items"]
    batch["filters"].update(sort="bad_first", offset="0", limit="50")
    batch["filters"].update(line="inspiration", unit="chain", **{"from": "2026-11-02", "to": "2026-11-08"})
    context.repo.save("case_batch", batch)
    with context.store.connection() as connection:
        connection.execute("UPDATE case_tags SET lines_json='[]' WHERE id IN ('motion_stiff','video_inconsistent','video_pacing')")
    context.cases = Cases(context)
    stored = context.repo.get("case_batch", batch["id"])
    assert stored["items"] == selected and stored["filters"]["outcome"] == "bad"
    assert not {"line", "from", "to", "unit", "sort", "offset", "limit"} & stored["filters"].keys()
    assert context.cases.batch(batch["id"], detail=True)["rows"]
    assert len(context.cases.tags("inspiration")) == 13
    assert len(context.cases.tags("video")) == 16
    assert all(value["lines"] == ["video"] for value in context.cases.tags("video") if value["group"] == "视频")


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
    assert client.put("/api/cases/reviews", json=[]).status_code == 422
    assert client.post("/api/cases/batches", json=[]).status_code == 422
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
    assert client.put("/api/cases/reviews", json={"items": [target], "rating": "bad", "status": "seen"}).json() == {"updated": 0}
    key = context.cases.index.rows[fact.indices[1]].row_key
    step_target = {"id": key, "unit": "task"}
    assert client.put("/api/cases/reviews", json={"items": [step_target], "setTags": ["color_shift"]}).status_code == 200
    assert client.request("DELETE", "/api/cases/reviews", json={"items": [target]}).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()
    assert detail["review"]["tags"] == [] and detail["review"]["effectiveTags"] == ["color_shift"]
    assert detail["processed"] == "done" and detail["steps"][0]["review"] is None
    assert detail["steps"][1]["review"]["tags"] == ["color_shift"] and detail["steps"][1]["review"]["inherited"] is False
    assert page(client, tag="color_shift")["total"] == 1
    assert client.request("DELETE", "/api/cases/reviews", json={"items": [step_target]}).status_code == 200
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()
    assert detail["processed"] == "todo" and detail["review"] is None
    assert client.post("/api/cases/batches", json={"line": fact.line, "from": "2026-11-02", "to": "2026-11-08", "unit": fact.unit, "strategy": "problems", "size": 10, "filters": {"outcome": "invalid"}}).status_code == 422
    assert client.get("/api/export/cases", params={"line": fact.line, "from": "2026-11-02"}).status_code == 422


def test_library_statistics_false_alarm_tags_and_sorting(real_cases):
    context, client = real_cases
    context.cases.refresh()
    facts = context.cases.index.by_line["inspiration", "chain"]
    bad = [fact for fact in facts if fact.week == "2026-11-02" and fact.outcome == "bad"][:3]
    good = next(fact for fact in facts if fact.week == "2026-11-02" and fact.outcome == "good")
    selection = [{"id": fact.id, "unit": fact.unit} for fact in bad]
    assert client.put("/api/cases/reviews", json={"items": selection, "setTags": ["color_shift"]}).status_code == 200
    assert client.get("/api/cases/tags", params={"line": "inspiration"}).json()[0]["id"] == "color_shift"
    assert client.get("/api/cases/tags", params={"line": "inspiration"}).json()[0]["uses"] == 3
    assert client.put("/api/cases/reviews", json={"items": [selection[0], {"id": good.id, "unit": good.unit}], "addTags": ["false_alarm"]}).status_code == 200
    response = client.get("/api/cases/library/stats", params={"line": "inspiration", "unit": "chain", "weeks": 12})
    assert response.status_code == 200
    stats = response.json()
    assert stats["processed"] == 4 and stats["outcomes"] == {"bad": 3, "grind": 0, "good": 1}
    assert stats["falseAlarm"] == {"cases": 1, "rate": 1 / 3}
    assert sum(tag["cases"] for tag in stats["tags"]) == 5
    assert len(stats["weekly"]) == 12 and sum(week["processed"] for week in stats["weekly"]) == 4
    assert sum(row["cases"] for row in stats["matrix"]) == 5
    assert sum(enterprise["cases"] for enterprise in stats["enterprises"]) == 4
    filtered = client.get("/api/cases/library/stats", params={"line": "inspiration", "tag": "false_alarm", "outcome": "bad"}).json()
    assert filtered["processed"] == 1 and filtered["falseAlarm"]["rate"] == 1
    library = page(client, scope="library", **{"from": "2020-01-10", "to": "2020-01-01"})
    assert library["total"] == 4 and library["summary"]["processed"] == 4
    assert [item["review"]["processedAt"] for item in library["items"]] == sorted((item["review"]["processedAt"] for item in library["items"]), reverse=True)
    exported = client.get("/api/cases/export", params={"line": "inspiration", "scope": "library"})
    assert exported.status_code == 200 and "%E6%A1%88%E4%BE%8B%E9%9B%86" in exported.headers["content-disposition"]
    assert client.request("DELETE", "/api/cases/reviews", json={"items": [selection[0]]}).status_code == 200
    assert client.get(f'/api/cases/{bad[0].id}', params={"unit": "chain"}).json()["review"] is None
    assert client.put("/api/cases/reviews", json={"items": [selection[0]], "addTags": ["quality_defect"]}).status_code == 200
    restarted = Cases(context)
    restarted.refresh()
    assert restarted.review(restarted.fact(bad[0].id, "chain"))["processedAt"]


def test_pool_template_references_and_legacy_label_migration(real_cases):
    context, client = real_cases
    fact = chain(context)
    task_id = context.cases.index.rows[fact.indices[1]].row_key
    items = [{"id": fact.id, "unit": "chain"}, {"id": task_id, "unit": "task"}]
    assert client.put("/api/cases/pool", json={"line": fact.line, "add": items, "note": {"ref": items[0], "text": "用于模板说明"}}).json() == {"updated": 2}
    created = client.post("/api/templates", json={"line": fact.line, "kind": "custom", "target": fact.enterprise, "caseIds": items, "write": False})
    assert created.status_code == 200
    template = created.json()["template"]
    assert [(item["id"], item["unit"]) for item in template["sourceCases"]] == [(item["id"], item["unit"]) for item in items]
    pool = client.get("/api/cases/pool", params={"line": fact.line}).json()
    assert len(pool["entries"]) == 2 and all(item["templateId"] == template["id"] for item in pool["entries"])
    assert any(item["note"] == "用于模板说明" for item in pool["entries"])
    assert client.put("/api/cases/pool", json={"line": fact.line, "remove": items[:1]}).status_code == 200
    assert client.get(f'/api/templates/{template["id"]}').status_code == 200
    assert client.get("/api/cases/pool", params={"line": fact.line, "unit": "chain"}).json()["entries"] == []
    assert len(client.get("/api/cases/pool", params={"line": fact.line, "unit": "task"}).json()["entries"]) == 1
    assert client.put("/api/cases/pool", json={"line": fact.line, "add": items[:1]}).status_code == 200
    assert client.delete(f'/api/templates/{template["id"]}').status_code == 200
    assert all(item["templateId"] is None for item in client.get("/api/cases/pool", params={"line": fact.line}).json()["entries"])
    assert client.put("/api/cases/pool", json={"line": fact.line, "remove": items}).status_code == 200
    with context.store.connection() as connection:
        connection.execute("INSERT INTO case_tags VALUES ('template_candidate','值得关注','可做模板','[]','good',15,0)")
        connection.execute("INSERT INTO case_reviews(id,unit,line,enterprise_id,tags_json,updated_at) VALUES (?,?,?,?,?,?)", (fact.id, fact.unit, fact.line, fact.enterprise, json.dumps(["template_candidate", "color_shift"]), fact.started))
    context.cases = Cases(context)
    pool = context.cases.pool(fact.line)
    assert len(pool["entries"]) == 1 and pool["entries"][0]["id"] == fact.id
    assert context.cases.review(context.cases.fact(fact.id))["tags"] == ["color_shift"]
    assert next(tag for tag in context.cases.tags(all_=True) if tag["id"] == "template_candidate")["archived"] is True
    with context.store.connection() as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert not {"case_collections", "case_collection_items"} & tables


def test_processing_timestamps_notes_and_read_only_detail(real_cases):
    context, client = real_cases
    fact = chain(context)
    target = {"items": [{"id": fact.id, "unit": fact.unit}]}
    step_key = context.cases.index.rows[fact.indices[2]].row_key
    context.profiles.add_annotation(fact.enterprise, "需要确认输入要求", anchor={"block": "case:" + fact.id})
    context.profiles.add_annotation(fact.enterprise, "核对该步骤", anchor={"block": "record:" + step_key})
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()
    assert detail["processed"] == "noted" and detail["annotationCount"] == 2
    assert detail["steps"][2]["annotationCount"] == 1 and detail["steps"][0]["annotationCount"] == 0
    assert client.put("/api/cases/reviews", json={**target, "setTags": ["color_shift"]}).status_code == 200
    initial = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()["review"]["processedAt"]
    time.sleep(1.05)
    assert client.put("/api/cases/reviews", json={**target, "setTags": ["quality_defect"]}).status_code == 200
    restarted = Cases(context)
    assert restarted.review(restarted.fact(fact.id, fact.unit))["processedAt"] == initial
    detail = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()
    assert detail["review"]["processedAt"] == initial
    generation = context.store.generation
    for _ in range(3):
        assert client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json() == detail
    assert context.store.generation == generation
    assert client.request("DELETE", "/api/cases/reviews", json=target).status_code == 200
    assert page(client, scope="library")["total"] == 0
    assert client.put("/api/cases/reviews", json={**target, "addTags": ["color_shift"]}).status_code == 200
    renewed = client.get(f"/api/cases/{fact.id}", params={"unit": fact.unit}).json()["review"]["processedAt"]
    assert renewed > initial
    with context.store.connection() as connection:
        assert connection.execute("SELECT processed_at FROM case_processing WHERE unit=? AND id=?", (fact.unit, fact.id)).fetchone()[0] == renewed


def test_sampling_skips_effectively_processed_cases_and_legacy_fields(real_cases):
    context, client = real_cases
    fact = chain(context)
    task_key = context.cases.index.rows[fact.indices[1]].row_key
    assert client.put("/api/cases/reviews", json={"items": [{"id": task_key, "unit": "task"}], "addTags": ["color_shift"]}).status_code == 200
    body = {"line": fact.line, "from": "2026-11-02", "to": "2026-11-08", "unit": fact.unit,
            "strategy": "per_enterprise", "size": 5, "filters": {"processed": "done"}}
    assert client.post("/api/cases/batches", json=body).json()["items"] == []
    assert BatchInput.model_validate({**body, "skipReviewed": False}).skipProcessed is False
    assert BatchInput.model_validate({**body, "skipRated": False}).skipProcessed is False
    assert BatchInput.model_validate({**body, "skipRated": False, "skipProcessed": True}).skipProcessed is True
    batch = client.post("/api/cases/batches", json={**body, "skipProcessed": False}).json()
    assert batch["items"] == [{"id": fact.id, "unit": fact.unit}] and batch["processed"] == 1
    assert client.request("DELETE", "/api/cases/reviews", json={"items": [{"id": task_key, "unit": "task"}]}).status_code == 200
    assert client.get(f'/api/cases/batches/{batch["id"]}').json()["processed"] == 0


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
