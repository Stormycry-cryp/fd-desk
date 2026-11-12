import json
import sqlite3

import pytest

from fd_desk.core import ROOT
from fd_desk.engine import Engine
from fd_desk.store import Store
from fd_desk.trends import calculate

ENTERPRISES = ("a76c739b69", "34a4dd649a", "99deb7cc6c")


@pytest.fixture
def real_trends(tmp_path):
    store = Store(tmp_path)
    with sqlite3.connect(f"{(ROOT / 'data/fd-desk.db').as_uri()}?mode=ro", uri=True) as source, store.connection() as target:
        for enterprise in ENTERPRISES:
            target.execute("INSERT INTO enterprises VALUES (?,?,?,?,?,?,?,?)", source.execute("SELECT * FROM enterprises WHERE id=?", (enterprise,)).fetchone())
            rows = source.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE enterprise_id=? AND line IN ('inspiration','video')", (enterprise,))
            target.executemany("INSERT INTO tasks(row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", rows)
        target.executemany("INSERT INTO coverage VALUES (?,?,?)", source.execute("SELECT * FROM coverage"))
    yield store, Engine(store)
    store.close()


def test_real_complete_week_trends_and_series(real_trends):
    store, engine = real_trends
    values = {item["enterpriseId"]: item for line in ("inspiration", "video") for item in calculate(engine, line, "2026-11-02")}
    assert {enterprise: item["kind"] for enterprise, item in values.items()} == dict(zip(ENTERPRISES, ("sliding", "churned", "fading")))
    for enterprise, item in values.items():
        with store.connection() as conn:
            expected = dict(conn.execute("SELECT week,count(*) FROM tasks WHERE enterprise_id=? AND line=? GROUP BY week", (enterprise, item["line"])))
        assert len(item["series"]) == 8
        assert item["series"][-1]["week"] == "2026-11-02"
        assert all(point["tasks"] == expected.get(point["week"], 0) for point in item["series"])
    assert values[ENTERPRISES[0]]["weeks"] == 7
    assert values[ENTERPRISES[1]]["weeks"] == 4
    assert values[ENTERPRISES[2]]["from"] == 53
    assert calculate(engine, "inspiration", "2026-11-09") == calculate(engine, "inspiration", "2026-11-02")


def test_settings_and_incomplete_week_invalidate_trends(real_trends):
    store, engine = real_trends
    original = calculate(engine, "inspiration", "2026-11-02")
    assert len(original) == 2
    settings = store.settings()
    settings["trends"]["slideRatio"] = .05
    settings["trends"]["churnGapWeeks"] = 5
    with store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
    assert calculate(engine, "inspiration", "2026-11-02") == []
    settings["trends"]["slideRatio"] = .6
    settings["trends"]["churnGapWeeks"] = 2
    with store.connection() as conn:
        conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
        conn.execute("DELETE FROM coverage WHERE line='inspiration' AND day='2026-11-08'")
    values = calculate(engine, "inspiration", "2026-11-02")
    sliding = next(item for item in values if item["enterpriseId"] == ENTERPRISES[0])
    assert sliding["series"][-1]["week"] == "2026-10-26" and sliding["weeks"] == 6
