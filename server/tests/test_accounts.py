import io
import json
import shutil
import tempfile
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from pydantic import ValidationError

from fd_desk.account_collection import collect_accounts
from fd_desk.accounts import Accounts, AccountSnapshot, is_low
from fd_desk.app import create_app
from fd_desk.core import ROOT, ZONE

WEEK = "2026-11-02"


@pytest.fixture
def account_workspace(client, tmp_path):
    sources = sorted((ROOT / "data/collector/accounts").glob("*/codex-*/snapshot.json"))
    assert sources, "需要已经完成且通过核验的真实账户采集"
    source = sources[-1]
    snapshot = AccountSnapshot.model_validate_json(source.read_text())
    previous_tempdir = tempfile.tempdir
    app = create_app(tmp_path)
    try:
        store = app.state.store
        with store.connection() as conn:
            conn.execute("ATTACH DATABASE ? AS original", (str(client.app.state.store.path),))
            conn.execute("INSERT INTO enterprises SELECT * FROM original.enterprises")
            conn.execute("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM original.tasks")
            conn.execute("INSERT INTO coverage SELECT * FROM original.coverage")
        target = tmp_path / "accounts.json"
        shutil.copyfile(source, target)
        with TestClient(app) as api:
            yield api, target, snapshot
    finally:
        app.state.rework.jobs.shutdown()
        app.state.rework.trials.shutdown()
        app.state.store.close()
        tempfile.tempdir = previous_tempdir


def test_full_real_snapshot_is_atomic_and_reimport_is_idempotent(account_workspace):
    api, source, snapshot = account_workspace
    accounts = Accounts(api.app.state.store)
    result = accounts.ingest(source)
    assert result["state"] == "done"
    assert result["rows"] == result["matched"] + result["unmatched"] == snapshot.expectedTotal
    assert result["matched"] > 0
    assert accounts.ingest(source) == result
    unmatched = api.get("/api/accounts/unmatched").json()
    assert len(unmatched) == result["unmatched"]
    assert all(set(row) == {"name", "phone", "sales", "afterSales", "remaining", "used7d", "takenAt"} for row in unmatched)
    assert api.get("/api/meta").json()["accountsAt"] == result["takenAt"]
    assert api.get("/api/pipeline").json()["accounts"]["latest"] == result
    with api.app.state.store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM account_snapshots").fetchone()[0] == result["matched"]
    if result["takenAt"][:10] == datetime.now(ZONE).date().isoformat():
        assert collect_accounts(api.app.state.store) == {"state": "already_done", "takenAt": result["takenAt"]}


def test_manual_owner_changes_survive_real_account_import(account_workspace):
    api, source, snapshot = account_workspace
    store = api.app.state.store
    with store.connection() as conn:
        by_phone = {row["admin_phone"]: row["id"] for row in conn.execute("SELECT id,admin_phone FROM enterprises")}
    row = next(row for page in snapshot.pages for row in page.rows if row.phone in by_phone and row.sales)
    enterprise = by_phone[row.phone]
    owner = {"sales": None, "afterSales": None}
    response = api.patch(f"/api/enterprises/{enterprise}", json={"owner": owner})
    assert response.status_code == 200
    Accounts(store).ingest(source)
    detail = api.get(f"/api/enterprises/{enterprise}", params={"week": WEEK}).json()
    assert detail["owner"] == owner
    assert detail["account"]["remaining"] == row.remaining
    with store.connection() as conn:
        assert conn.execute("SELECT owner_manual FROM enterprises WHERE id=?", (enterprise,)).fetchone()[0] == 1


def test_real_balances_filters_owners_alerts_and_export(account_workspace):
    api, source, _ = account_workspace
    Accounts(api.app.state.store).ingest(source)
    query = {"line": "inspiration", "week": WEEK}
    response = api.get("/api/enterprises", params=query)
    assert response.status_code == 200
    roster = response.json()
    matched = [row for row in roster["rows"] if row["account"]]
    assert matched
    for row in matched:
        account = row["account"]
        assert len(account["trend"]) == 1
        assert account["trend"][0]["remaining"] == account["remaining"]
        assert account["daysLeft"] == (account["remaining"] / (account["used7d"] / 7) if account["used7d"] else None)
        assert ("low_points" in row["alerts"]) == is_low(account)
    low = api.get("/api/enterprises", params={**query, "points": "low"}).json()
    assert {row["enterprise"]["id"] for row in low["rows"]} == {row["enterprise"]["id"] for row in matched if is_low(row["account"])}
    owner = next(value for row in matched for value in row["owner"].values() if value)
    filtered = api.get("/api/enterprises", params={**query, "owner": owner}).json()
    assert {row["enterprise"]["id"] for row in filtered["rows"]} == {row["enterprise"]["id"] for row in roster["rows"] if owner in row["owner"].values()}
    owners = api.get("/api/owners", params={"line": "inspiration"}).json()
    assert any(item["name"] == owner for item in owners)
    assert all(set(item) == {"name", "role", "enterprises"} and item["enterprises"] > 0 for item in owners)
    export = api.get("/api/enterprises/export", params={**query, "owner": owner})
    assert export.status_code == 200
    workbook = load_workbook(io.BytesIO(export.content))
    header = [cell.value for cell in workbook.active[1]]
    assert all(label in header for label in ("销售", "售后", "剩余点数", "近七日消耗", "预计可用天数"))
    assert workbook.active.max_row == len(filtered["rows"]) + 1
    for values in workbook.active.iter_rows(min_row=2, values_only=True):
        expected = next(row for row in filtered["rows"] if row["enterprise"]["name"] == values[0])
        account = expected["account"] or {}
        for column, field in (("剩余点数", "remaining"), ("近七日消耗", "used7d"), ("预计可用天数", "daysLeft")):
            value = account.get(field)
            assert values[header.index(column)] == (pytest.approx(value) if value is not None else None)
    workbook.close()


def test_account_update_invalidates_queries_without_reloading_generation_records(account_workspace):
    api, source, _ = account_workspace
    engine = api.app.state.engine
    query = {"line": "inspiration", "week": WEEK}
    before = api.get("/api/enterprises", params=query)
    assert before.status_code == 200
    frame, revision = engine.frame, engine.facts_version
    Accounts(api.app.state.store).ingest(source)
    after = api.get("/api/enterprises", params=query)
    assert after.status_code == 200 and after.content != before.content
    assert engine.frame is frame and engine.facts_version == revision
    row = next(row for row in after.json()["rows"] if row["account"] and row["tasks"])
    profile = api.get(f"/api/profiles/{row['enterprise']['id']}").json()
    assert profile["facts"]["all"]["account"]["remaining"] == row["account"]["remaining"]
    assert profile["facts"]["inspiration"]["account"] == profile["facts"]["all"]["account"]
    old = engine.accounts.get(row["enterprise"]["id"], at="2026-11-08T23:59:59+08:00")
    assert old is None


def test_incomplete_real_snapshot_preserves_last_successful_import(account_workspace):
    api, source, _ = account_workspace
    accounts = Accounts(api.app.state.store)
    imported = accounts.ingest(source)
    incomplete = json.loads(source.read_text())
    incomplete["pages"].pop()
    target = source.with_name("incomplete.json")
    target.write_text(json.dumps(incomplete))
    with pytest.raises(ValidationError, match="行数与页面总数不一致"):
        accounts.ingest(target)
    assert accounts.status()["latest"] == imported
    with api.app.state.store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM account_snapshots").fetchone()[0] == imported["matched"]


def test_movement_evidence_keeps_account_snapshot_dates(account_workspace):
    api, source, _ = account_workspace
    Accounts(api.app.state.store).ingest(source)
    query = {"line": "inspiration", "week": WEEK}
    rows = api.get("/api/enterprises", params=query).json()["rows"]
    row = next(row for row in rows if row["account"] and row["tasks"] and row["downloadRate"] is not None)
    facts, catalog = api.app.state.rework.movements.input({**query, "enterprise": row["enterprise"]})
    assert facts["account"] is None
    assert facts["latestAccount"]["remaining"] == row["account"]["remaining"]
    assert catalog["latestAccount.takenAt"]["value"] == row["account"]["takenAt"]
    assert "account.remaining" not in catalog


def test_interrupted_collection_can_resume_the_same_run(account_workspace):
    api, _, _ = account_workspace
    accounts = Accounts(api.app.state.store)
    key = accounts.begin()
    accounts.failed(key, {"code": "collection_interrupted", "message": "账户采集已经中断"})
    accounts.resume(key)
    result = accounts.status()["latest"]
    assert result["id"] == key and result["state"] == "running"
    assert result["finishedAt"] is None and result["error"] is None
