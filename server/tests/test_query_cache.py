import sqlite3
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path

import pytest

from fd_desk.core import dump
from fd_desk.engine import ANALYSIS_RECORDS_SQL
from fd_desk.similarity import PromptMatcher

WEEK = "2026-11-02"


def test_manual_action_refreshes_response_without_rebuilding_facts(client):
    params = {"line": "inspiration", "week": WEEK}
    original_response = client.get("/api/enterprises", params=params)
    original_response.raise_for_status()
    enterprise = original_response.json()["rows"][0]["enterprise"]["id"]
    store, engine = client.app.state.store, client.app.state.engine
    key = f"{enterprise}:inspiration"
    original = store.authored("next_action", key)
    frame, revision = engine.frame, engine.facts_version
    action = {"line": "inspiration", "text": "核验原始输入与客户下载记录", "source": "manual"}
    try:
        client.put(f"/api/enterprises/{enterprise}/next-action", json=action).raise_for_status()
        response = client.get("/api/enterprises", params=params)
        response.raise_for_status()
        row = next(row for row in response.json()["rows"] if row["enterprise"]["id"] == enterprise)
        assert row["nextAction"]["text"] == action["text"]
        assert engine.frame is frame
        assert engine.facts_version == revision == store.revisions()["facts_revision"]
        assert client.get("/api/enterprises", params=params).content == response.content
    finally:
        with store.connection() as conn:
            if original is None:
                conn.execute("DELETE FROM authored WHERE scope='next_action' AND key=?", (key,))
            else:
                conn.execute("UPDATE authored SET value=? WHERE scope='next_action' AND key=?", (dump(original), key))


def test_separate_process_update_and_delete_invalidate_cached_detail(client):
    enterprise = client.get("/api/tasks", params={"line": "video", "week": WEEK}).json()["items"][0]["enterprise"]["id"]
    route = f"/api/enterprises/{enterprise}"
    response = client.post(f"{route}/notes", json={"text": "等待核验的查询记录"})
    response.raise_for_status()
    note = response.json()
    store, engine = client.app.state.store, client.app.state.engine
    try:
        before = client.get(route, params={"week": WEEK})
        before.raise_for_status()
        frame = engine.frame
        text = "已经核验的查询记录"
        subprocess.run([sys.executable, str(Path(__file__).resolve()), str(store.path), note["id"], text], check=True)
        after = client.get(route, params={"week": WEEK})
        after.raise_for_status()
        assert next(item for item in after.json()["notes"] if item["id"] == note["id"])["text"] == text
        assert after.content != before.content
        assert engine.frame is frame
    finally:
        assert client.delete(f"/api/notes/{note['id']}").status_code == 204
    assert all(item["id"] != note["id"] for item in client.get(route, params={"week": WEEK}).json()["notes"])


def test_real_task_changes_rebuild_facts_and_cached_counts(client):
    store, engine = client.app.state.store, client.app.state.engine
    params = {"line": "video", "week": WEEK}
    before = client.get("/api/tasks", params=params).json()
    frame, revision = engine.frame, engine.facts_version
    with store.connection() as conn:
        original = tuple(conn.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE line=? AND week=? LIMIT 1", ("video", WEEK)).fetchone())
    try:
        with sqlite3.connect(store.path) as conn:
            assert conn.execute("DELETE FROM tasks WHERE row_key=?", (original[0],)).rowcount == 1
        after = client.get("/api/tasks", params=params).json()
        assert after["total"] == before["total"] - 1
        assert engine.frame is not frame
        assert engine.facts_version > revision
    finally:
        with store.connection() as conn:
            conn.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)", original)
    assert client.get("/api/tasks", params=params).json() == before


def test_cached_parameters_and_capacity_do_not_mix_results(client):
    cache = client.app.state.queries
    original_limits = cache.max_entries, cache.max_bytes
    try:
        cache.max_entries, cache.max_bytes = 2, 8192
        cache.entries.clear()
        cache.bytes = 0
        results = {}
        for line in ("inspiration", "video"):
            for downloaded in (True, False):
                params = {"line": line, "week": WEEK, "downloaded": downloaded, "limit": 1}
                response = client.get("/api/tasks", params=params)
                response.raise_for_status()
                result = response.json()
                assert all(task["line"] == line and task["downloaded"] == downloaded for task in result["items"])
                assert cache.bytes == sum(len(content) for content in cache.entries.values()) <= cache.max_bytes
                assert len(cache.entries) <= cache.max_entries
                results[line, downloaded] = response.content
        assert client.get("/api/tasks", params={"line": "inspiration", "week": WEEK, "downloaded": True, "limit": 1}).content == results["inspiration", True]
        cache.max_bytes = 1
        cache.entries.clear()
        cache.bytes = 0
        client.get("/api/tasks", params={"line": "video", "week": WEEK}).raise_for_status()
        assert cache.bytes == 0 and not cache.entries
    finally:
        cache.max_entries, cache.max_bytes = original_limits
        cache.entries.clear()
        cache.bytes = 0


@pytest.mark.parametrize("line", ["inspiration", "video"])
def test_conversion_matches_all_real_source_scenes(client, line):
    store = client.app.state.store
    with store.connection() as conn:
        expected = {(row["enterprise_id"], row["scene"]): row["tasks"] for row in conn.execute(
            "SELECT t.enterprise_id, json_extract(t.payload,'$.scene') AS scene, COUNT(*) AS tasks "
            "FROM tasks t JOIN enterprises e ON e.id=t.enterprise_id WHERE t.line<>? AND e.kind<>'internal' "
            "AND e.contract NOT IN ('expired','internal') AND t.enterprise_id NOT IN "
            "(SELECT enterprise_id FROM tasks WHERE line=?) GROUP BY t.enterprise_id,scene", (line, line))}
    response = client.get("/api/conversion", params={"line": line})
    response.raise_for_status()
    actual = {(item["enterprise"]["id"], scene["scene"]): scene["tasks"] for item in response.json() for scene in item["scenes"]}
    assert actual == expected


def test_hot_queries_use_indexes_for_order_and_enterprise_lookups(client):
    store = client.app.state.store
    with store.connection() as conn:
        enterprise = conn.execute("SELECT enterprise_id FROM tasks LIMIT 1").fetchone()[0]
        ordered = [row["detail"] for row in conn.execute("EXPLAIN QUERY PLAN " + ANALYSIS_RECORDS_SQL)]
        members = [row["detail"] for row in conn.execute("EXPLAIN QUERY PLAN SELECT DISTINCT user_phone FROM tasks WHERE enterprise_id=?", (enterprise,))]
        used = [row["detail"] for row in conn.execute("EXPLAIN QUERY PLAN SELECT 1 FROM tasks WHERE enterprise_id=? AND line=? AND week<=? LIMIT 1", (enterprise, "video", WEEK))]
    assert sum("tasks_line_time" in detail for detail in ordered) == 2
    assert not any("TEMP B-TREE" in detail for detail in ordered)
    assert any("tasks_members" in detail for detail in members)
    assert any("SEARCH" in detail and "enterprise_id=? AND line=?" in detail for detail in used)


@pytest.mark.parametrize("threshold", [0, 0.8, 0.85, 1])
def test_similarity_filters_preserve_real_prompt_matching_order(client, threshold):
    engine = client.app.state.engine
    engine.refresh()
    prompts = list(dict.fromkeys(text for text in engine.frame.normalized_prompt if text))
    prompts = prompts[::max(1, len(prompts) // 96)][:96]
    matcher = PromptMatcher(threshold, len(prompts))
    representatives = []
    for text in prompts:
        expected = next((index for index, other in enumerate(representatives) if SequenceMatcher(None, text, other).ratio() >= threshold), None)
        assert matcher.find(text) == expected
        if expected is None:
            matcher.add(text)
            representatives.append(text)


if __name__ == "__main__":
    with sqlite3.connect(sys.argv[1]) as connection:
        assert connection.execute("UPDATE notes SET text=? WHERE id=?", (sys.argv[3], sys.argv[2])).rowcount == 1
