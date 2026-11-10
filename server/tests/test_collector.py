import fcntl
import importlib.util
import json
import os
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

from fd_desk.core import ROOT
from fd_desk.store import Store


def collector_module():
    spec = importlib.util.spec_from_file_location("fd_daily", ROOT / "collector/daily.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_daily_plan_preserves_missing_dates_and_refreshes_interrupted_day(client):
    collector = collector_module()
    store = client.app.state.store
    today = date(2026, 11, 10)
    with store.connection() as conn:
        coverage = {row[0] for row in conn.execute("SELECT day FROM coverage GROUP BY day HAVING COUNT(DISTINCT line)=2")}
    state = {"days": {day: {"refreshedFor": today.isoformat()} for day in coverage}}
    expected = [day for day in collector.days_between(collector.START, today - timedelta(days=1)) if day.isoformat() not in coverage]
    assert collector.plan(store, state, today) == expected
    day = max(date.fromisoformat(value) for value in coverage)
    state["days"].pop(day.isoformat())
    assert collector.plan(store, state, today) == expected + [day]


def test_daily_process_lock_prevents_duplicate_collection(client):
    directory = client.app.state.store.directory / "collector"
    directory.mkdir(exist_ok=True)
    with (directory / "collector.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = subprocess.run([sys.executable, str(ROOT / "collector/daily.py"), "--plan"], check=True, capture_output=True, text=True,
            env={**os.environ, "FD_DESK_DATA_DIR": str(client.app.state.store.directory)})
    assert json.loads(result.stdout) == {"state": "already_running"}


def test_daily_recovery_reuses_verified_export_across_execution_dates(tmp_path):
    collector = collector_module()
    source_day = ROOT / "data/collector/2026-11-09"
    completed = [path for path in source_day.glob("*/codex-*/answer.json") if json.loads(path.read_text())["state"] == "done"]
    assert completed
    answer = completed[-1]
    store = Store(tmp_path)
    directory = store.directory / "collector"
    directory.mkdir()
    (directory / "2026-11-09").symlink_to(source_day, target_is_directory=True)
    state = {"days": {"2026-11-09": {"state": "running", "activeRun": str(answer.parent)}}}
    state_path = directory / "state.json"
    result = collector.collect_day(store, state, state_path, date(2026, 11, 9), date(2026, 11, 11))
    report = json.loads(Path(json.loads(answer.read_text())["outputFile"]).with_suffix(".validation.json").read_text())
    assert result["rows"] == report["actual_rows"] == report["expected_total_ui"]
    assert state["days"]["2026-11-09"]["refreshedFor"] == "2026-11-10"
    assert "activeRun" not in state["days"]["2026-11-09"]
    assert date(2026, 11, 9) in collector.plan(store, state, date(2026, 11, 11))
