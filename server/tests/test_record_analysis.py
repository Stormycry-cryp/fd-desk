import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from openai import pydantic_function_tool

from fd_desk.core import ROOT, ApiProblem, now
from fd_desk.engine import Engine, ref
from fd_desk.jobs import MODEL_KINDS, Jobs
from fd_desk.media import Thumbnails
from fd_desk.model_runner import ModelRunner
from fd_desk.models import Settings
from fd_desk.profiles import Profiles
from fd_desk.record_analysis import RecordAnalyses, Result, mount, numbers
from fd_desk.records import Records
from fd_desk.rework_store import Repo
from fd_desk.store import Store


@pytest.fixture
def real_context(tmp_path):
    store = Store(tmp_path)
    source = sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    enterprises = source.execute("SELECT enterprise_id FROM tasks WHERE line IN ('inspiration','video') GROUP BY enterprise_id HAVING count(*)>=6 ORDER BY count(*) DESC LIMIT 2").fetchall()
    assert len(enterprises) == 2
    ids = [row[0] for row in enterprises]
    with store.connection() as conn:
        for enterprise in ids:
            row = source.execute("SELECT * FROM enterprises WHERE id=?", (enterprise,)).fetchone()
            conn.execute("INSERT INTO enterprises VALUES (?,?,?,?,?,?,?,?)", tuple(row))
            rows = source.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE enterprise_id=? AND line IN ('inspiration','video') ORDER BY created_at DESC LIMIT 160", (enterprise,)).fetchall()
            conn.executemany("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", [tuple(row) for row in rows])
    repo = Repo(store)
    marks = ",".join("?" for _ in MODEL_KINDS)
    row = source.execute(f"SELECT value FROM rework_objects WHERE kind='job' AND json_extract(value,'$.job.kind') IN ({marks}) AND substr(json_extract(value,'$.job.createdAt'),1,10)=? LIMIT 1", (*sorted(MODEL_KINDS), now()[:10])).fetchone()
    previous_job = json.loads(row[0]) if row else None
    source.close()
    jobs = Jobs(repo, store)
    context = SimpleNamespace(store=store, repo=repo, engine=Engine(store), jobs=jobs,
                              model=ModelRunner(store), media=Thumbnails(store.directory))
    context.profiles = Profiles(context)
    context.records = Records(context)
    context.record_analyses = RecordAnalyses(context)
    app = FastAPI()

    @app.exception_handler(ApiProblem)
    async def problem(request: Request, error: ApiProblem):
        return JSONResponse(error.payload, status_code=error.status)

    mount(app, context)
    with TestClient(app) as client:
        yield context, client, ids, previous_job
    jobs.shutdown()
    store.close()


def selected(context, enterprise):
    context.engine.refresh()
    return context.engine.frame[context.engine.frame.enterprise_id == enterprise].row_key.tolist()[:6]


def test_http_validation_and_submission_without_daily_quota(real_context):
    context, client, enterprises, previous_job = real_context
    keys = selected(context, enterprises[0])
    other = selected(context, enterprises[1])[0]
    body = {"enterprise": enterprises[0], "rowKeys": keys}
    for row_keys, status in (([keys[0], keys[0]], 422), ([keys[0], other], 422), (["absent"], 404), ([], 422)):
        assert client.post("/api/records/analyses", json=body | {"rowKeys": row_keys}).status_code == status
    if previous_job is None:
        pytest.skip("当日没有可复用的真实模型任务")
    context.repo.save("job", previous_job, state=previous_job["job"]["state"])
    settings = context.store.settings()
    settings["pipeline"]["dailyJobs"] = 1
    with context.store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
    assert not (context.store.directory / "runtime.json").exists()
    response = client.post("/api/records/analyses", json=body)
    assert response.status_code == 200
    analysis = response.json()
    assert context.repo.get("record_analysis", analysis["id"])["rowKeys"] == keys
    assert context.jobs.get(analysis["id"])["kind"] == "record_analysis"
    assert len(context.repo.find("job")) == 2
    with pytest.raises(ApiProblem) as error:
        context.jobs.wait(analysis["id"])
    assert error.value.payload["code"] == "codex_unconfigured"


def test_persisted_settings_remove_daily_quota_on_restart(tmp_path):
    store = Store(tmp_path)
    settings = store.settings()
    settings["pipeline"]["dailyJobs"] = 1
    with store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
    store.close()
    restarted = Store(tmp_path)
    try:
        expected = {**settings, "pipeline": {key: value for key, value in settings["pipeline"].items() if key != "dailyJobs"}}
        assert restarted.settings() == expected
        assert Settings.model_validate(restarted.settings()).model_dump() == expected
    finally:
        restarted.close()


def test_real_input_schema_and_evidence(real_context):
    context, _, enterprises, _ = real_context
    keys = selected(context, enterprises[0])
    inputs = context.record_analyses.input({"enterprise": ref(context.store.enterprise(enterprises[0])), "rowKeys": keys, "question": None})
    assert [record["task"]["rowKey"] for record in inputs["records"]] == keys
    assert all(record["rawTask"]["row_key"] == record["task"]["rowKey"] for record in inputs["records"])
    images = context.record_analyses.images(inputs, context.store.directory / "analysis" / "record-images")
    assert len(images) <= 40
    assert all(not image["source"].lower().split("?")[0].endswith((".mp4", ".mov", ".webm", ".m4v")) for image in images)
    for record in inputs["records"]:
        for category in ("inputs", "outputs"):
            assert sum(image["rowKey"] == record["task"]["rowKey"] and image["kind"] == category for image in images) <= 2
    schema = pydantic_function_tool(Result)["function"]["parameters"]
    assert schema["additionalProperties"] is False
    assert all(definition.get("additionalProperties") is False for definition in schema["$defs"].values())
    assert set(inputs["evidenceCatalog"]) == {f"record:{key}" for key in keys}
    assert all(entry["target"]["task"] in keys for entry in inputs["evidenceCatalog"].values())
    points = str(inputs["records"][0]["task"]["points"])
    assert numbers(points) <= numbers(inputs["evidenceCatalog"][f"record:{keys[0]}"]["value"])


def test_saved_real_model_result_passes_reference_checks(real_context):
    context, _, _, _ = real_context
    with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as source:
        row = source.execute("SELECT id,value FROM rework_objects WHERE kind='record_analysis' AND state='done' ORDER BY rowid DESC LIMIT 1").fetchone()
    if row is None:
        pytest.skip("尚无完成的真实记录分析")
    directory = ROOT / "data/analysis" / row[0]
    result = Result.model_validate_json((directory / "answer.json").read_text())
    inputs = json.loads((directory / "input.json").read_text())
    saved = json.loads(row[1])
    validated, discarded = context.record_analyses.validate(result, inputs)
    assert discarded == []
    assert validated["headline"] == saved["headline"]
    assert validated["perRecord"] == saved["perRecord"]
    assert [finding["text"] for finding in validated["findings"]] == [finding["text"] for finding in saved["findings"]]
    assert {record["task"]["rowKey"] for record in saved["records"]} == set(saved["rowKeys"])


def test_real_prompt_percentages_support_model_numeric_notation(real_context):
    context, _, _, _ = real_context
    with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as source:
        rows = source.execute("SELECT id FROM rework_objects WHERE kind='record_analysis' ORDER BY rowid DESC").fetchall()
    checked = 0
    for row in rows:
        directory = ROOT / "data/analysis" / row[0]
        if not (directory / "answer.json").is_file():
            continue
        inputs = json.loads((directory / "input.json").read_text())
        if not any("百分之" in record["task"]["prompt"] for record in inputs["records"]):
            continue
        result = Result.model_validate_json((directory / "answer.json").read_text())
        validated, discarded = context.record_analyses.validate(result, inputs)
        assert discarded == [] and validated is not None
        checked += 1
    if not checked:
        pytest.skip("尚无包含中文百分比的真实记录分析输出")
