from fd_desk.reports import backfill, narratives


def test_historical_reports_use_actual_metrics_and_coverage(client):
    engine = client.app.state.engine
    weeks = client.get("/api/meta").json()["weeks"]
    for week in weeks:
        response = client.get("/api/report", params={"week": week})
        assert response.status_code == 200
        report = response.json()
        generated = narratives(engine, report)
        for line in report["lines"]:
            assert f"{line['tasks']['value']:,}个任务" in generated["done"]
            assert f"{line['activeEnterprises']['value']}家活跃企业" in generated["done"]
            coverage = engine.coverage(line["line"], week)
            if not coverage["complete"]:
                assert f"共{len(coverage['days'])}天" in generated["done"]
                assert line["stable"] is None
            for mover in line["falling"][:2]:
                if mover["current"] < mover["previous"]:
                    assert mover["enterprise"]["name"] in generated["next"]
        assert f"已发送{report['touches']['sent']}条" in generated["done"]
        assert "依据本周数据生成的后续建议" in generated["next"]


def test_backfill_is_idempotent_and_preserves_authored_text(client):
    store = client.app.state.store
    weeks = client.get("/api/meta").json()["weeks"]
    before = {week: client.get("/api/report", params={"week": week}).json() for week in weeks}
    first = backfill(store)
    assert first["weeks"] == len(weeks)
    generation = store.generation
    repeated = backfill(store)
    assert repeated["written"] == 0
    assert store.generation == generation
    for week in weeks:
        after = client.get("/api/report", params={"week": week}).json()
        assert after["lines"] == before[week]["lines"]
        for field in ("done", "next"):
            assert after[field]["text"] == before[week][field]["text"]
    week = weeks[0]
    text = before[week]["next"]["text"]
    saved = client.put("/api/report", json={"week": week, "next": text, "source": "manual"})
    assert saved.status_code == 200
    manual = saved.json()["next"]
    assert backfill(store)["preserved"] >= 1
    assert client.get("/api/report", params={"week": week}).json()["next"] == manual
