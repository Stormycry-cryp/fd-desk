import json

import pandas as pd
import pytest

from fd_desk.core import ROOT, ApiProblem, read_spec
from fd_desk.ingest import import_file, parse_rows, scan
from fd_desk.store import Store
from fd_desk.summary import summarize
from fd_desk.verification import compare


@pytest.fixture
def csv_export(client, tmp_path):
    source = sorted((ROOT / "data/inbox").glob("*.xlsx"))[1]
    frame = pd.read_excel(source)
    target = tmp_path / source.name.replace(".xlsx", ".csv.gz")
    frame.to_csv(target, index=False, encoding="utf-8-sig", compression="gzip")
    return source, target


def test_csv_chunks_preserve_real_excel_keys_and_fields(csv_export):
    source, target = csv_export
    expected = {row["row_key"]: row for row in parse_rows(source)}
    actual = {row["row_key"]: row for row in parse_rows(target)}
    assert len(actual) > 2000
    assert actual == expected


def test_csv_upload_updates_existing_rows_and_preserves_golden(client, csv_export):
    _, target = csv_export
    with target.open("rb") as stream:
        response = client.post("/api/imports", files={"file": (target.name, stream, "application/gzip")})
    assert response.status_code == 200
    assert response.json()["inserted"] == 0
    assert response.json()["updated"] == 9958
    assert response.json()["error"] is None
    compare(read_spec("golden.json"), summarize(client.app.state.engine))


def test_csv_scan_is_idempotent(csv_export, tmp_path):
    source, target = csv_export
    store = Store(tmp_path / "scan")
    import_file(store, source)
    inbox = store.directory / "inbox"
    inbox.mkdir()
    (inbox / target.name).symlink_to(target)
    jobs = scan(store)
    assert len(jobs) == 1 and jobs[0]["inserted"] == 0
    assert scan(store) == []


def test_csv_declared_range_failure_is_atomic(csv_export, tmp_path):
    _, target = csv_export
    invalid = target.with_name("FD_在约体验_20260910-20260911.csv.gz")
    invalid.symlink_to(target)
    store = Store(tmp_path / "range")
    with pytest.raises(ApiProblem) as error:
        import_file(store, invalid)
    assert error.value.payload["code"] == "invalid_import_range"
    with store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM enterprises").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM coverage").fetchone()[0] == 0


def test_range_replacement_requires_matching_fddata_evidence(csv_export, tmp_path):
    _, target = csv_export
    store = Store(tmp_path / "evidence")
    with pytest.raises(ApiProblem) as error:
        import_file(store, target, replace_range=True)
    assert error.value.payload["code"] == "validation_required"
    with store.connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0


def test_invalid_csv_upload_returns_api_error(client):
    response = client.post("/api/imports", files={"file": ("invalid.csv.gz", b"invalid", "application/gzip")})
    assert response.status_code == 422
    assert set(response.json()) == {"code", "message"}
    assert json.loads(json.dumps(response.json()))["code"] == "invalid_import"
