import json
import os
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from uuid import uuid4

import pytest

from fd_desk.engine import Engine
from fd_desk.profile_facts import calculate
from fd_desk.store import Store


class ReadOnlyStore(Store):
    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, uri=True)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()


def test_facts_match_real_database():
    path = Path(__file__).resolve().parents[2] / "data" / "fd-desk.db"
    if not path.is_file():
        pytest.skip("真实数据不存在")
    store = ReadOnlyStore.__new__(ReadOnlyStore)
    store.path = f"{path.as_uri()}?mode=ro"
    store.directory = path.parent
    store.lock = RLock()
    store.observer = sqlite3.connect(store.path, uri=True, check_same_thread=False)
    try:
        with store.connection() as conn:
            row = conn.execute("SELECT enterprise_id FROM tasks GROUP BY enterprise_id HAVING SUM(line='other')>0 AND SUM(line='inspiration')>0 ORDER BY COUNT(*) DESC LIMIT 1").fetchone()
            if row is None:
                pytest.skip("没有包含 other 和灵感成款的真实企业")
            enterprise = row[0]
            expected = dict(conn.execute("SELECT line, count(*) FROM tasks WHERE enterprise_id=? GROUP BY line", (enterprise,)).fetchall())
        facts = calculate(Engine(store), enterprise)
        assert facts["all"]["totals"]["tasks"] == sum(expected.values())
        for line in ("inspiration", "video"):
            assert (facts[line]["totals"]["tasks"] if facts[line] else 0) == expected.get(line, 0)
        assert sum(sum(day) for day in facts["all"]["hours"]) == sum(expected.values())
        assert sum(item["tasks"] for item in facts["all"]["scenes"]) == sum(expected.values())
    finally:
        store.close()


@pytest.mark.skipif(not os.environ.get("FD_PROFILE_VERIFY_THREE"), reason="仅在明确指定隔离数据目录时执行真实模型调用")
def test_three_real_model_outputs():
    from fd_desk.jobs import Jobs
    from fd_desk.media import Thumbnails
    from fd_desk.model_runner import ModelRunner
    from fd_desk.profiles import ProfileOutput, Profiles
    from fd_desk.rework_store import Repo

    directory = Path(os.environ["FD_PROFILE_VERIFY_THREE"]).resolve()
    data_root = Path(__file__).resolve().parents[2] / "data"
    if not directory.is_relative_to(data_root / "work") or not (directory / "fd-desk.db").is_file() or not (directory / "runtime.json").is_file():
        pytest.fail("请提供 data/work 下包含真实数据库副本和 runtime.json 的隔离目录")
    store = Store(directory)
    repo = Repo(store)
    jobs = Jobs(repo, store)
    context = SimpleNamespace(store=store, repo=repo, jobs=jobs, engine=Engine(store), model=ModelRunner(store), media=Thumbnails(directory))
    profiles = Profiles(context)
    try:
        with store.connection() as conn:
            rows = conn.execute("""
                SELECT enterprise_id FROM tasks
                WHERE line IN ('inspiration','video')
                  AND json_array_length(json_extract(payload,'$.inputs'))>0
                  AND json_array_length(json_extract(payload,'$.outputs'))>0
                  AND lower(json_extract(payload,'$.inputs[0]')) NOT LIKE '%.mp4%'
                  AND lower(json_extract(payload,'$.outputs[0]')) NOT LIKE '%.mp4%'
                GROUP BY enterprise_id HAVING count(*)>=20 ORDER BY count(*) DESC LIMIT 3
            """).fetchall()
        assert len(rows) == 3, "真实数据中不足三家符合条件的企业"
        for row in rows:
            job = profiles.refresh(row[0])
            completed = jobs.wait(job["id"])
            assert completed["state"] == "done"
            answer = directory / "analysis" / job["id"] / "answer.json"
            result = ProfileOutput.model_validate_json(answer.read_text())
            input_data = json.loads((answer.parent / "input.json").read_text())
            assert len(input_data["images"]) == 8
            assert all(key in input_data["evidenceCatalog"] for insight in result.insights for key in insight.evidenceIds)
            assert all(not Path(image[side]).exists() for image in input_data["images"] for side in ("input", "output"))
            assert profiles.get(row[0])["version"] > 0
            print(f"真实模型输出: {answer}")
    finally:
        jobs.shutdown()
        store.close()


def test_roster_real_subset_mutations():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from fd_desk.jobs import Jobs
    from fd_desk.profiles import Profiles, mount
    from fd_desk.query_cache import QueryCache
    from fd_desk.rework_store import Repo
    from fd_desk.views import roster

    root = Path(__file__).resolve().parents[2] / "data" / "fixtures" / "rework" / "R1"
    source = root / "real-subset" / "fd-desk.db"
    if not source.exists():
        pytest.skip("真实数据抽样不存在")
    directory = root.parents[2] / "work" / "rework" / "profileperf" / ("test-" + uuid4().hex)
    directory.mkdir(parents=True)
    with sqlite3.connect(source) as original, sqlite3.connect(directory / "fd-desk.db") as destination:
        original.backup(destination)
    store = Store(directory)
    repo = Repo(store)
    jobs = Jobs(repo, store)
    engine = Engine(store)
    context = SimpleNamespace(store=store, repo=repo, jobs=jobs, engine=engine, cache=QueryCache(store))
    profiles = Profiles(context)
    context.profiles = profiles
    app = FastAPI()
    mount(app, context)
    client = TestClient(app)
    enterprise = "8a4376d578"
    week = "2026-11-02"
    try:
        initial = profiles.roster("inspiration", week)
        assert [row["enterpriseId"] for row in initial] == [row["enterprise"]["id"] for row in roster(engine, "inspiration", week)["rows"]]
        assert any(row["enterpriseId"] == enterprise for row in initial)
        assert client.get("/api/profiles/roster", params={"line": "inspiration", "week": week}).json() == initial
        assert client.get("/api/profiles", params={"ids": enterprise}).json()[0] == profiles.get(enterprise)
        assert client.get(f"/api/profiles/{enterprise}").json() == profiles.get(enterprise)
        assert client.get("/api/tags").status_code == 200
        assert client.put(f"/api/profiles/{enterprise}/tags", json={"dimension": "rhythm", "value": None}).status_code == 200
        assert client.put(f"/api/profiles/{enterprise}/headline", json={"text": "验收手工标题"}).status_code == 200
        assert client.post("/api/annotations", json={"enterprise": enterprise, "text": "验收临时批注"}).status_code == 200
        updated = next(row for row in profiles.roster("inspiration", week) if row["enterpriseId"] == enterprise)
        detail = profiles.get(enterprise)
        assert detail["version"] > 0
        assert updated["headline"] == detail["headline"]["text"] == "验收手工标题"
        assert updated["tags"] == detail["tags"]
        assert not any(tag["dimension"] == "rhythm" for tag in updated["tags"])
        assert updated["annotationCount"] == len(detail["annotations"])
        assert updated["lastAnnotation"]["text"] == "验收临时批注"
        assert detail["state"] == "stale"
        repo.save("pipeline", {"id": "initialization-test", "finishedAt": None})
        repo.save("profile_init", {"id": "initialization-test"})
        assert enterprise not in profiles.pending(100)
        assert profiles.initialize() == []
        repo.delete("profile_init", "initialization-test")
        assert enterprise in profiles.pending(100)
        revision = store.revisions()["facts_revision"]
        before = store.generation
        store.changed()
        started = time.perf_counter()
        after = profiles.roster("inspiration", week)
        elapsed = (time.perf_counter() - started) * 1000
        assert store.generation > before and store.revisions()["facts_revision"] == revision
        assert after == profiles.roster("inspiration", week)
        print(f"真实抽样全局版本变化后名单: {elapsed:.2f} ms")
        settings = store.settings()
        settings["pipeline"]["profileMinTasks"] = detail["facts"]["all"]["totals"]["tasks"] + 1
        with store.connection() as conn:
            conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
            conn.execute("DELETE FROM rework_objects WHERE kind='job'")
        assert profiles.get(enterprise)["state"] == "facts_only"
    finally:
        client.close()
        jobs.shutdown()
        store.close()
        shutil.rmtree(directory)


def test_persistent_profile_cache_real_subset():
    from fd_desk.jobs import Jobs
    from fd_desk.profiles import PROFILE_CACHE_VERSION, Profiles
    from fd_desk.rework_store import Repo

    data = Path(__file__).resolve().parents[2] / "data"
    source = data / "fixtures" / "rework" / "R1" / "real-subset" / "fd-desk.db"
    if not source.exists():
        pytest.skip("真实数据抽样不存在")
    directory = data / "work" / "rework" / "profileperf" / ("cache-test-" + uuid4().hex)
    directory.mkdir(parents=True)
    with sqlite3.connect(source) as original, sqlite3.connect(directory / "fd-desk.db") as destination:
        original.backup(destination)

    store = Store(directory)
    repo = Repo(store)
    job_sets = []

    def instance():
        jobs = Jobs(repo, store)
        job_sets.append(jobs)
        engine = Engine(store)
        return Profiles(SimpleNamespace(store=store, repo=repo, jobs=jobs, engine=engine))

    try:
        profiles = instance()
        enterprise = "8a4376d578"
        before = store.revisions()
        facts = profiles.facts(enterprise)
        snapshot = profiles.snapshot_stats(enterprise)
        assert store.revisions() == before
        assert facts == calculate(profiles.engine, enterprise)
        with store.connection() as conn:
            rows = conn.execute("SELECT kind,version FROM profile_calculation_cache WHERE enterprise=?", (enterprise,)).fetchall()
        assert {(row[0], row[1]) for row in rows} == {("facts", PROFILE_CACHE_VERSION), ("snapshot", PROFILE_CACHE_VERSION)}

        restarted = instance()
        assert restarted.facts(enterprise) == facts
        assert restarted.snapshot_stats(enterprise) == snapshot
        assert store.revisions() == before

        for column, value in (("version", PROFILE_CACHE_VERSION - 1), ("week", "1900-01-01"), ("thresholds", "{}"), ("facts_revision", -1)):
            with store.connection() as conn:
                conn.execute(f"UPDATE profile_calculation_cache SET {column}=? WHERE enterprise=?", (value, enterprise))
            restarted = instance()
            assert restarted.facts(enterprise) == facts
            assert restarted.snapshot_stats(enterprise) == snapshot
            with store.connection() as conn:
                assert conn.execute(f"SELECT count(*) FROM profile_calculation_cache WHERE enterprise=? AND {column}=?", (enterprise, value)).fetchone()[0] == 0
            assert store.revisions() == before

        settings = store.settings()
        settings["thresholds"]["inspiration"]["heavy"]["tasks"] = 1000000
        settings["thresholds"]["inspiration"]["medium"]["tasks"] = 1000000
        with store.connection() as conn:
            conn.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps(settings),))
        updated = instance()
        assert updated.facts(enterprise) == calculate(updated.engine, enterprise)
        assert updated.snapshot_stats(enterprise) == updated.calculate_snapshot_stats(enterprise)
        with store.connection() as conn:
            assert all(json.loads(row[0]) == {key: settings[key] for key in ("thresholds", "trends")} for row in conn.execute("SELECT thresholds FROM profile_calculation_cache WHERE enterprise=?", (enterprise,)))
            conn.execute("UPDATE coverage SET day=day WHERE rowid=(SELECT rowid FROM coverage LIMIT 1)")
        changed_revision = store.revisions()["facts_revision"]
        assert changed_revision > before["facts_revision"]
        assert updated.facts(enterprise) == calculate(updated.engine, enterprise)
        assert updated.snapshot_stats(enterprise) == updated.calculate_snapshot_stats(enterprise)
        with store.connection() as conn:
            assert {row[0] for row in conn.execute("SELECT facts_revision FROM profile_calculation_cache WHERE enterprise=?", (enterprise,))} == {changed_revision}
            assert conn.execute("SELECT count(*) FROM profile_calculation_cache WHERE enterprise=?", (enterprise,)).fetchone()[0] == 2
            conn.execute("DELETE FROM tasks WHERE row_key=(SELECT row_key FROM tasks WHERE enterprise_id=? LIMIT 1)", (enterprise,))
        after_delete = updated.facts(enterprise)
        assert after_delete["all"]["totals"]["tasks"] == facts["all"]["totals"]["tasks"] - 1
        assert after_delete == calculate(updated.engine, enterprise)
        assert updated.snapshot_stats(enterprise) == updated.calculate_snapshot_stats(enterprise)
    finally:
        for jobs in job_sets:
            jobs.shutdown()
        store.close()
        shutil.rmtree(directory)
