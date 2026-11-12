import os
import sqlite3
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fd_desk import analysis
from fd_desk.core import ROOT
from fd_desk.engine import Engine
from fd_desk.jobs import Jobs
from fd_desk.media import Thumbnails
from fd_desk.model_runner import ModelRunner
from fd_desk.query_cache import QueryCache
from fd_desk.rework_store import Repo
from fd_desk.store import Store
from fd_desk.templates import Content, Create, Patch, Templates, mount


@pytest.fixture
def real_templates():
    source = ROOT / "data/fd-desk.db"
    if not source.is_file():
        pytest.skip("真实数据文件不可用")
    destination = ROOT / "data/verification"
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="templates-real-", dir=destination) as directory:
        store = Store(Path(directory))
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as original, store.connection() as copied:
            drafts = original.execute("SELECT id,value FROM drafts").fetchall()
            tasks = original.execute("SELECT row_key,enterprise_id,line,week,created_at,file_order,row_no,payload FROM tasks WHERE line='video' ORDER BY created_at DESC LIMIT 500").fetchall()
            enterprises = original.execute("SELECT * FROM enterprises").fetchall()
            copied.executemany("INSERT OR REPLACE INTO enterprises VALUES (?,?,?,?,?,?,?,?)", enterprises)
            copied.executemany("INSERT OR REPLACE INTO tasks (row_key,enterprise_id,line,week,created_at,file_order,row_no,payload) VALUES (?,?,?,?,?,?,?,?)", tasks)
            copied.executemany("INSERT OR REPLACE INTO drafts VALUES (?,?)", drafts)
        context = SimpleNamespace(store=store, engine=Engine(store), media=Thumbnails(store.directory))
        context.repo = Repo(store)
        context.jobs = Jobs(context.repo, store)
        context.model = ModelRunner(store)
        context.templates = Templates(context)
        yield context
        context.jobs.shutdown()
        store.observer.close()


def test_real_drafts_migrate_without_losing_content(real_templates):
    templates = real_templates.templates
    drafts = real_templates.store.items("drafts")
    assert len(drafts) == 14
    for draft in drafts:
        item = templates.get(draft["id"])
        assert real_templates.repo.get("template_migration", draft["id"])["draft"] == draft
        assert item["current"]["content"]["title"] == draft["title"]["text"]
        assert item["current"]["content"]["prompt"] == draft["prompt"]["text"]
        assert [slot["name"] for slot in item["current"]["content"]["slots"]] == draft["slots"]
        assert item["kind"] == ("custom" if len(draft["sourceEnterprises"]) == 1 else "official")
        assert len(item["review"]["checks"]) == 5
    deleted = drafts[0]["id"]
    real_templates.repo.delete("template", deleted)
    templates._migrate()
    assert deleted not in {item["id"] for item in templates.list("video")}


def test_real_manual_versions_restore_and_monitor(real_templates):
    templates = real_templates.templates
    item = next(item for item in templates.list("video") if item["kind"] == "custom")
    original = item["current"]["content"]
    revised = Content.model_validate({**original, "prompt": original["prompt"] + "。"})
    changed = templates.patch(item["id"], Patch(content=revised, state="live"))
    assert changed["current"]["source"] == "manual"
    assert changed["current"]["version"] == 2
    restored = templates.restore(item["id"], 1)
    assert restored["current"]["content"] == original
    assert len(restored["versions"]) == 3
    point = next(point for point in templates.monitor("video") if point["templateId"] == item["id"])
    assert point["estimated"] is True
    assert len(point["revisions"]) == 3


def test_real_template_http_routes(real_templates):
    real_templates.cache = QueryCache(real_templates.store)
    app = FastAPI()
    mount(app, real_templates)
    with TestClient(app) as client:
        response = client.get("/api/templates", params={"line": "video"})
        assert response.status_code == 200
        assert len(response.json()) == 14
        assert client.get("/api/templates/monitor", params={"line": "video"}).json() == []
        item = response.json()[0]
        result = client.get(f"/api/templates/{item['id']}")
        assert result.status_code == 200
        assert result.json()["current"]["content"] == item["current"]["content"]


def test_real_opportunity_evidence(real_templates):
    templates = real_templates.templates
    frame = real_templates.engine.frame
    week = str(frame.week.max())
    evidence = templates._evidence("video", week)
    assert evidence
    entry = next(iter(evidence.values()))
    indices = analysis.cluster_indices(real_templates.engine, "video", entry["clusterId"])
    part = frame.loc[indices]
    part = part[part.week <= week]
    assert entry["evidence"]["uses"] == len(part)
    assert entry["evidence"]["enterprises"] == part.enterprise_id.nunique()
    assert entry["evidence"]["weeks"] == part.week.nunique()
    assert entry["evidence"]["downloadRate"] == pytest.approx(part.downloaded.mean())


@pytest.mark.skipif(os.environ.get("R3_NETWORK_TEST") != "1", reason="需显式运行真实图片读取测试")
def test_real_source_image_download(real_templates):
    templates = real_templates.templates
    engine = real_templates.engine
    members = analysis.build_clusters(engine, "video")
    key = next(key for key, indices in members.items() if any(engine.frame.loc[index].inputs for index in indices))
    item = templates.create(Create(line="video", kind="official", clusterIds=[key], write=False))["template"]
    inputs = templates._write_inputs(item, {"kind": "write"}, "real-image-test")
    assert inputs["tasks"]
    assert inputs["images"]
    assert all(Path(image["path"]).is_file() for image in inputs["images"])
