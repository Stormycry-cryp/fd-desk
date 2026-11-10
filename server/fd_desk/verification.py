import tempfile

from fastapi.testclient import TestClient

from .app import create_app
from .core import ROOT, dump, read_spec
from .ingest import import_file
from .summary import summarize


def compare(expected, actual, path="root"):
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and set(expected) == set(actual), f"{path}: 字段不一致"
        for key in expected:
            compare(expected[key], actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(expected) == len(actual), f"{path}: 列表长度不一致"
        for index, (left, right) in enumerate(zip(expected, actual)):
            compare(left, right, f"{path}[{index}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and abs(expected - actual) <= 1e-4, f"{path}: 数值不一致 ({expected}, {actual})"
    else:
        assert expected == actual, f"{path}: 取值不一致"


def write_fixtures(client):
    directory = ROOT / "data/fixtures"
    directory.mkdir(parents=True, exist_ok=True)
    routes = {
        "meta": "/api/meta", "settings": "/api/settings", "imports": "/api/imports",
        "report": "/api/report?week=2026-11-02",
    }
    for line in ("inspiration", "video"):
        for name in ("overview", "enterprises", "alerts", "tasks", "chains"):
            routes[f"{name}_{line}"] = f"/api/{name}?line={line}&week=2026-11-02"
        routes[f"tasks_sample_{line}"] = f"/api/tasks?line={line}&week=2026-11-02&sample=2"
        response = client.get(routes[f"enterprises_{line}"])
        assert response.status_code == 200
        enterprise_id = response.json()["rows"][0]["enterprise"]["id"]
        routes[f"enterprise_{line}"] = f"/api/enterprises/{enterprise_id}?week=2026-11-02"
        routes[f"enterprise_export_{line}"] = f"/api/enterprises/export?line={line}&week=2026-11-02"
    written = []
    for name, route in routes.items():
        response = client.get(route)
        assert response.status_code == 200, f"{name}: 接口验证失败"
        if name.startswith("enterprise_export_"):
            (directory / f"{name}.xlsx").write_bytes(response.content)
        else:
            (directory / f"{name}.json").write_text(dump(response.json()), encoding="utf-8")
        written.append(name)
    return written


def selfcheck():
    directory = ROOT / "data/verification"
    directory.mkdir(parents=True, exist_ok=True)
    files = sorted((ROOT / "data/inbox").glob("*.xlsx"))
    if len(files) != 2:
        raise ValueError("自检需要 golden.json 对应的两份原始导出")
    with tempfile.TemporaryDirectory(prefix="selfcheck-", dir=directory) as path:
        app = create_app(path)
        store, engine = app.state.store, app.state.engine
        for file in files:
            import_file(store, file)
        expected = read_spec("golden.json")
        actual = summarize(engine)
        compare(expected, actual)
        for file in files:
            job = import_file(store, file)
            assert job["inserted"] == 0
            compare(actual, summarize(engine))
        client = TestClient(app)
        fixtures = write_fixtures(client)
        (ROOT / "data/fixtures/summary.json").write_text(dump(actual), encoding="utf-8")
        client.close()
    return {"golden": "passed", "duplicateImport": "passed", "rows": actual["rows"], "enterprises": actual["enterprises"], "fixtures": len(fixtures) + 1}
