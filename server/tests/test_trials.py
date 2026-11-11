import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from fd_desk.core import ROOT, ApiProblem
from fd_desk.engine import Engine
from fd_desk.jobs import Jobs
from fd_desk.rework_store import Repo
from fd_desk.store import Store
from fd_desk.templates import Content, Create, Templates
from fd_desk.trials import Trials, mount


@pytest.fixture
def captured_trial():
    source = ROOT / "data/fd-desk.db"
    if not source.is_file():
        pytest.skip("真实客户数据库不可用")
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT value FROM rework_objects WHERE kind='trial' AND state='done' AND json_array_length(json_extract(value,'$.cases'))>=6 ORDER BY rowid DESC LIMIT 1").fetchone()
        if row is None:
            pytest.skip("真实六用例试验结果不可用")
        run = json.loads(row[0])
        charges = [json.loads(row[0]) for row in connection.execute("SELECT value FROM rework_objects WHERE kind='trial_charge' AND id LIKE ?", (run["id"] + ":%",))]
    return run, charges


def set_daily_limit(store, amount):
    settings = store.settings()
    settings["trials"]["dailyLimit"] = amount
    with store.connection() as connection:
        connection.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))


@pytest.fixture
def workspace(tmp_path):
    source = ROOT / "data/fd-desk.db"
    if not source.is_file():
        pytest.skip("真实客户数据库不可用")
    store = Store(tmp_path)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as original:
        original.row_factory = sqlite3.Row
        tasks = original.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE line='inspiration' AND json_array_length(json_extract(payload,'$.inputs')) > 0 ORDER BY created_at DESC LIMIT 100").fetchall()
        enterprises = {row["enterprise_id"] for row in tasks}
        records = [original.execute("SELECT * FROM enterprises WHERE id=?", (key,)).fetchone() for key in enterprises]
    if len(tasks) < 6:
        store.close()
        pytest.skip("真实数据中没有足够的图片用例")
    with store.connection() as conn:
        for row in records:
            conn.execute("INSERT INTO enterprises VALUES (" + ",".join("?" for _ in row) + ")", tuple(row))
        for row in tasks:
            conn.execute("INSERT INTO tasks VALUES (" + ",".join("?" for _ in row) + ")", tuple(row))
    repo = Repo(store)
    engine = Engine(store)
    context = SimpleNamespace(store=store, repo=repo, engine=engine, jobs=Jobs(repo, store))
    context.templates = Templates(context)
    context.trials = Trials(context)
    app = FastAPI()

    @app.exception_handler(ApiProblem)
    async def error_handler(request, error):
        return JSONResponse(error.payload, status_code=error.status)

    mount(app, context)
    with TestClient(app) as client:
        yield context, client
    context.trials.shutdown()
    context.jobs.shutdown()
    store.close()


def test_real_gateway_catalog_and_real_candidates(workspace):
    context, client = workspace
    budget = client.get("/api/trials/budget")
    assert budget.status_code in (200, 503)
    if budget.status_code == 503:
        assert budget.json()["code"] == "litellm_discovery_failed"
    else:
        assert budget.json()["currency"] == "CNY"
        assert budget.json()["maxCases"] == 12
        assert budget.json()["maxArms"] == 3
        deadline = context.trials.generator.cached_until
        assert client.get("/api/trials/budget").json()["models"] == budget.json()["models"]
        assert context.trials.generator.cached_until == deadline
    candidates = client.get("/api/trials/candidates", params={"limit": 6})
    assert candidates.status_code == 200
    assert len(candidates.json()) == 6
    assert all(item["line"] == "inspiration" and item["inputs"] for item in candidates.json())
    if budget.status_code == 200 and not budget.json()["models"]:
        result = client.post("/api/trials", json={"taskRowKeys": [item["rowKey"] for item in candidates.json()],
            "arms": [{"label": "A", "prompt": "测试", "model": "gpt-image-1"}, {"label": "B", "prompt": "测试", "model": "gpt-image-1"}]})
        assert result.status_code == 422
        assert result.json()["code"] == "unsupported_image_model"
        assert client.get("/api/trials").json() == []


def test_transactional_budget_reservation(workspace, captured_trial):
    context, _ = workspace
    trials = context.trials
    run, charges = captured_trial
    run = copy.deepcopy(run)
    case, arm = run["cases"][0], run["arms"][0]
    charge_id = f"{run['id']}:{case['id']}:{arm['id']}"
    amount = next(item["amount"] for item in charges if item["id"] == charge_id)
    set_daily_limit(context.store, amount)
    with context.store.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        trials.reserve(run, [(case, arm)], {arm["model"]: amount}, conn)
    assert context.repo.get("trial_charge", charge_id)["amount"] == amount
    with pytest.raises(ApiProblem) as failure, context.store.connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        trials.reserve(run, [(run["cases"][1], arm)], {arm["model"]: amount}, conn)
    assert failure.value.status == 409
    assert failure.value.payload["code"] == "budget_exceeded"
    assert context.repo.get("trial_charge", charge_id)["amount"] == amount


def test_concurrent_reservations_do_not_overspend(workspace, captured_trial):
    context, _ = workspace
    captured, charges = captured_trial
    amount = charges[0]["amount"]
    set_daily_limit(context.store, amount)
    barrier = Barrier(2)

    def reserve(index):
        run = copy.deepcopy(captured)
        case, arm = run["cases"][index - 1], run["arms"][0]
        barrier.wait()
        try:
            with context.store.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                context.trials.reserve(run, [(case, arm)], {arm["model"]: amount}, conn)
            return "reserved"
        except ApiProblem as error:
            return error.payload["code"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(reserve, (1, 2)))
    assert sorted(results) == ["budget_exceeded", "reserved"]
    assert sum(item["amount"] for item in context.repo.find("trial_charge")) == amount


def test_custom_template_ownership_on_real_tasks(workspace):
    context, client = workspace
    candidates = client.get("/api/trials/candidates", params={"limit": 100}).json()
    first = candidates[0]
    other = next((item for item in candidates if item["enterprise"]["id"] != first["enterprise"]["id"]), None)
    if other is None:
        pytest.skip("真实任务样本没有第二家企业")
    template = context.templates.create(Create(line="inspiration", kind="custom", target=first["enterprise"]["id"], content=Content(), write=False))["template"]
    response = client.get("/api/trials/candidates", params={"template": template["id"], "limit": 100})
    assert response.status_code == 200
    assert response.json()
    assert all(item["enterprise"]["id"] == first["enterprise"]["id"] for item in response.json())
    with pytest.raises(ApiProblem) as failure:
        context.trials.tasks([other["rowKey"]], template)
    assert failure.value.payload["code"] == "trial_enterprise_mismatch"


def test_completed_real_run_recovers_without_repeating_generation(workspace, captured_trial):
    context, _ = workspace
    run, charges = captured_trial
    with context.store.connection() as conn:
        context.repo.save("trial", run, state=run["state"], conn=conn)
        for charge in charges:
            context.repo.save("trial_charge", charge, week=charge["at"][:10], conn=conn)
    context.trials.recover()
    assert context.trials.get(run["id"]) == run
    assert sorted(context.repo.find("trial_charge"), key=lambda item: item["id"]) == sorted(charges, key=lambda item: item["id"])
