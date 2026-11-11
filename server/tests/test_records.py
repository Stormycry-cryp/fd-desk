import io
import sqlite3
from collections import Counter
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from fd_desk.core import ROOT, ApiProblem
from fd_desk.engine import Engine
from fd_desk.exports import Exports
from fd_desk.jobs import Jobs
from fd_desk.profiles import Profiles
from fd_desk.query_cache import QueryCache
from fd_desk.records import Records, mount
from fd_desk.rework_store import Repo
from fd_desk.store import Store

CHENGFU = "1cd6112680"
MIXED = "bb6d98c570"
ANNOTATED_ENTERPRISE = "d841f92c77"


@pytest.fixture(scope="module")
def records_client(tmp_path_factory):
    directory = tmp_path_factory.mktemp("records-real")
    store = Store(directory)
    source = sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    enterprises = (CHENGFU, MIXED, ANNOTATED_ENTERPRISE)
    with store.connection() as target:
        for enterprise in enterprises:
            entity = source.execute("SELECT id,name,admin_phone,kind,contract,sales,after_sales,summary FROM enterprises WHERE id=?", (enterprise,)).fetchone()
            assert entity is not None
            target.execute("INSERT INTO enterprises VALUES (?,?,?,?,?,?,?,?)", tuple(entity))
            tasks = source.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE enterprise_id=? AND line IN ('inspiration','video','other')", (enterprise,))
            target.executemany("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", (tuple(row) for row in tasks))
    repo = Repo(store)
    with store.connection() as target:
        rows = source.execute("SELECT kind,id,enterprise_id,line,week,state,value FROM rework_objects WHERE kind='annotation' AND enterprise_id=?", (ANNOTATED_ENTERPRISE,))
        target.executemany("INSERT INTO rework_objects VALUES (?,?,?,?,?,?,?)", (tuple(row) for row in rows))
    source.close()
    engine = Engine(store)
    jobs = Jobs(repo, store)
    context = SimpleNamespace(store=store, engine=engine, repo=repo, jobs=jobs, cache=QueryCache(store))
    context.profiles = Profiles(context)
    context.records = Records(context)
    app = FastAPI()

    @app.exception_handler(ApiProblem)
    def handle_problem(request: Request, error: ApiProblem):
        return JSONResponse(error.payload, status_code=error.status)

    mount(app, context)
    client = TestClient(app)
    yield client, context
    client.close()
    jobs.shutdown()
    store.close()


def test_page_filters_facets_sort_and_range(records_client):
    client, context = records_client
    params = {"enterprise": CHENGFU, "scope": "all"}
    page = client.get("/api/records", params=params).json()
    assert page["total"] == 615
    assert page["range"]["from"] <= page["range"]["to"]
    assert {item["task"]["line"] for item in page["items"]} == {"inspiration"}
    first = page["items"][0]["task"]
    filtered = client.get("/api/records", params=params | {"model": first["model"], "result": "failed", "limit": 1}).json()
    assert filtered["range"] == page["range"]
    assert sum(item["count"] for item in filtered["facets"]["results"]) >= filtered["total"]
    assert next((item["count"] for item in filtered["facets"]["models"] if item["key"] == first["model"]), 0) == filtered["total"]
    by_date = client.get("/api/records", params=params | {"from": first["createdAt"][:10], "to": first["createdAt"][:10]}).json()
    assert all(item["task"]["createdAt"][:10] == first["createdAt"][:10] for item in by_date["items"])
    oldest = client.get("/api/records", params=params | {"sort": "oldest", "limit": 1}).json()
    next_page = client.get("/api/records", params=params | {"offset": 1, "limit": 1}).json()
    assert oldest["items"][0]["task"]["createdAt"] <= first["createdAt"]
    assert next_page["items"][0]["task"]["rowKey"] == page["items"][1]["task"]["rowKey"]
    assert client.get("/api/records", params=params | {"noted": "any"}).json()["total"] == 0
    assert client.get("/api/records", params=params | {"from": "2025-02-03", "to": "2025-02-02"}).status_code == 422
    assert context.engine.facts_version is None
    assert client.get("/api/records", params=params | {"scope": "video"}).json()["total"] == 0


def test_sample_real_enterprise(records_client):
    client, context = records_client
    body = {"enterprise": CHENGFU, "scope": "all", "size": 24, "seed": 37}
    sample = client.post("/api/records/sample", json=body).json()
    assert sample == client.post("/api/records/sample", json=body).json()
    assert sample["items"] != client.post("/api/records/sample", json=body | {"seed": 38}).json()["items"]
    assert len(sample["items"]) == 24
    assert sample["dims"]["intents"] >= 4
    _, frame = context.records.data(CHENGFU, "all")
    assert sample["dims"]["users"] == frame.user_id.nunique()
    picked = Counter(item["sampleReason"] for item in sample["items"])
    assert all(item["picked"] == picked[item["stratum"]] and item["picked"] <= item["available"] for item in sample["coverage"])
    for item in sample["items"]:
        if item["sampleReason"] == "not_downloaded":
            assert not item["task"]["downloaded"] and not item["task"]["failed"]
    excluded = [item["task"]["rowKey"] for item in sample["items"]]
    replacement = client.post("/api/records/sample", json=body | {"exclude": excluded}).json()
    assert not set(excluded) & {item["task"]["rowKey"] for item in replacement["items"]}


def test_mixed_line_sample_and_export(records_client):
    client, context = records_client
    sample = client.post("/api/records/sample", json={"enterprise": MIXED, "scope": "all", "size": 24, "seed": 19}).json()
    lines = Counter(item["task"]["line"] for item in sample["items"])
    assert lines["inspiration"] >= 6 and lines["video"] >= 6
    keys = [item["task"]["rowKey"] for item in sample["items"][:3]]
    response = client.get("/api/records/export", params={"enterprise": MIXED, "scope": "all", "rowKeys": ",".join(keys)})
    assert response.status_code == 200
    sheet = load_workbook(io.BytesIO(response.content), read_only=True).active
    rows = list(sheet.values)
    assert rows[0] == ("时间", "产品线", "模式", "任务类型", "模型", "成员", "提示词", "结果", "失败原因", "耗点", "FD 链接", "批注")
    assert len(rows) == 4
    assert all("http" not in str(value) for row in rows[1:] for index, value in enumerate(row) if index != 10)
    assert client.get("/api/records/export", params={"enterprise": CHENGFU, "rowKeys": keys[0]}).status_code == 422
    assert client.get("/api/records/export", params={"enterprise": MIXED, "rowKeys": "missing"}).status_code == 422
    assert context.records.render_export({"enterprise": MIXED, "scope": "all", "rowKeys": keys[0]}).startswith(b"PK")
    with context.store.lock:
        _, frame = context.records.data(MIXED, "all")
    expected = len(frame[(frame.status == "success") & ~frame.downloaded & ~frame.failed])
    page = client.get("/api/records", params={"enterprise": MIXED, "result": "not_downloaded", "limit": 200}).json()
    assert page["total"] == expected
    assert all(item["task"]["status"] == "success" and not item["task"]["failed"] for item in page["items"])
    unknown = frame[(frame.status == "unknown") & ~frame.downloaded & ~frame.failed].iloc[0]
    content = context.records.render_export({"enterprise": MIXED, "rowKeys": unknown.row_key})
    assert list(load_workbook(io.BytesIO(content), read_only=True).active.values)[1][7] == "未知"


def test_cross_facets_and_all_filters(records_client):
    client, context = records_client
    with context.store.lock:
        _, frame = context.records.data(CHENGFU, "all")
    row = frame[frame.user_id.notna() & frame.model.notna() & frame.intent.notna()].iloc[-1]
    query = {"enterprise": CHENGFU, "scope": "all", "intent": row.intent, "model": row.model,
             "user": row.user_id, "mode": row["mode"], "pattern": row.pattern, "q": row.prompt[:4]}
    response = client.get("/api/records", params=query).json()
    expected = frame[(frame.intent == row.intent) & (frame.model == row.model) & (frame.user_id == row.user_id) &
                     (frame["mode"] == row["mode"]) & (frame.pattern == row.pattern) &
                     frame.prompt.str.contains(row.prompt[:4], case=False, regex=False, na=False)]
    assert response["total"] == len(expected)
    assert all(item["task"]["rowKey"] in set(expected.row_key) for item in response["items"])
    for facet, field, key in (("intents", "intent", "key"), ("models", "model", "key"), ("modes", "mode", "key"), ("users", "user_id", "id")):
        expected_filter = {name: value for name, value in query.items() if name != {"intent": "intent", "model": "model", "mode": "mode", "user_id": "user"}[field]}
        other = client.get("/api/records", params=expected_filter | {"limit": 200}).json()
        expected_counts = Counter(item["task"][field if field != "user_id" else "user"]["id"] if field == "user_id" else item["task"][field] for item in other["items"])
        actual = {item[key]: item["count"] for item in response["facets"][facet]}
        if other["total"] <= 200:
            assert actual == {key: count for key, count in expected_counts.items() if key}
    assert client.get("/api/records", params={"enterprise": ANNOTATED_ENTERPRISE, "noted": "any"}).json()["total"] == 0


def test_fact_revision_refreshes_scoped_engine(records_client):
    client, context = records_client
    params = {"enterprise": CHENGFU, "scope": "all", "limit": 1}
    original = client.get("/api/records", params=params).json()
    key = original["items"][0]["task"]["rowKey"]
    with context.store.connection() as connection:
        row = tuple(connection.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE row_key=?", (key,)).fetchone())
        connection.execute("DELETE FROM tasks WHERE row_key=?", (key,))
    try:
        changed = client.get("/api/records", params=params).json()
        assert changed["total"] == original["total"] - 1
        assert changed["items"][0]["task"]["rowKey"] != key
    finally:
        with context.store.connection() as connection:
            connection.execute("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", row)
    assert client.get("/api/records", params=params).json() == original


def test_record_annotation_counts_export_and_cache(records_client):
    client, context = records_client
    query = {"enterprise": CHENGFU, "scope": "all", "limit": 1}
    page = client.get("/api/records", params=query).json()
    task = page["items"][0]["task"]
    assert task["createdAt"] and task["model"] and isinstance(task["downloaded"], bool)
    note = context.profiles.add_annotation(CHENGFU, "验收记录：已核对该条记录的时间、模型和下载状态。", anchor={"block": "record:" + task["rowKey"], "quote": task["prompt"][:60]})
    try:
        annotated = client.get("/api/records", params=query | {"noted": "any"}).json()
        assert annotated["total"] == 1
        assert annotated["items"][0]["annotationCount"] == 1
        assert annotated["items"][0]["lastAnnotation"]["text"] == note["entries"][0]["text"]
        assert client.get("/api/records", params=query).json()["items"][0]["annotationCount"] == 1
        content = context.records.render_export({"enterprise": CHENGFU, "rowKeys": task["rowKey"]})
        book = load_workbook(io.BytesIO(content), read_only=True)
        assert list(book.active.values)[1][-1] == note["entries"][0]["text"]
        book.close()
        content, _ = Exports(context).render("annotations", {"enterprise": CHENGFU, "line": "inspiration", "week": "2026-11-02", "ids": note["id"]})
        book = load_workbook(io.BytesIO(content), read_only=True)
        assert list(book.active.values)[1][3] == "记录 " + task["sourceId"]
        book.close()
        with pytest.raises(ApiProblem) as error:
            context.profiles.add_annotation(MIXED, note["entries"][0]["text"], anchor={"block": "record:" + task["rowKey"]})
        assert error.value.payload["code"] == "invalid_record_anchor"
    finally:
        context.repo.delete("annotation", note["id"])
    assert client.get("/api/records", params=query | {"noted": "any"}).json()["total"] == 0


@pytest.mark.parametrize("size", [1, 12, 24, 48])
def test_sample_scaled_quotas_and_exclusions(records_client, size):
    client, context = records_client
    body = {"enterprise": MIXED, "scope": "all", "size": size, "seed": 37}
    result = client.post("/api/records/sample", json=body).json()
    assert len(result["items"]) == size
    lines = Counter(item["task"]["line"] for item in result["items"])
    if size >= 2:
        assert min(lines["inspiration"], lines["video"]) >= (size + 3) // 4
    for coverage in result["coverage"]:
        if coverage["stratum"] not in {"stuck_tail", "not_downloaded", "downloaded"}:
            assert coverage["picked"] <= (size * {"failed": 2, "batch": 2, "agent": 1, "rare_intent": 2,
                                                 "new_model": 1, "member": 2, "annotated": 1, "recent": 2}[coverage["stratum"]] + 23) // 24
    if size == 24:
        with context.store.lock:
            _, frame = context.records.data(MIXED, "all")
        excluded = frame.row_key.iloc[5:].tolist()
        replacement = client.post("/api/records/sample", json=body | {"exclude": excluded}).json()
        assert len(replacement["items"]) == size
        assert set(frame.row_key.iloc[:5]).issubset({item["task"]["rowKey"] for item in replacement["items"]})
