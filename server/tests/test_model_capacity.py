import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fd_desk.core import ROOT
from fd_desk.model_capacity import ModelCapacity

NODE = Path.home() / ".nvm/versions/node/v24.15.0/bin/node"
SCHEMA = ROOT / "server/fd_desk/model_capacity.sql"
WORKER = ROOT / "server/tests/capacity_worker.mjs"


def wait_status(capacity, predicate):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = capacity.status()
        if predicate(state):
            return state
        time.sleep(.025)
    raise AssertionError("实际并发状态未在限定时间内满足条件")


def test_python_and_node_share_capacity_and_recover_process_exit(tmp_path):
    capacity = ModelCapacity(tmp_path)
    holders = []
    try:
        for _ in range(4):
            process = subprocess.Popen([str(NODE), str(WORKER), str(tmp_path), str(SCHEMA), "hold"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            holders.append(process)
            assert process.stdout.readline().strip() == "acquired"
        state = capacity.status()
        assert state["running"] == 4 and state["reservedSlots"] + state["running"] == 5
        with ThreadPoolExecutor(max_workers=1) as executor:
            def acquire_python():
                with capacity.acquire("python-verification"):
                    return capacity.status()
            future = executor.submit(acquire_python)
            wait_status(capacity, lambda item: item["queued"] == 1)
            assert not future.done()
            holders[0].terminate()
            holders[0].wait(timeout=5)
            state = future.result(timeout=20)
            assert state["running"] == 4 and state["queued"] == 0
        assert capacity.status()["running"] == 3
    finally:
        for process in holders:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)
    assert capacity.status()["running"] == 0


def test_node_wait_can_be_cancelled_without_leaking_capacity(tmp_path):
    capacity = ModelCapacity(tmp_path)
    with capacity.acquire("first"), capacity.acquire("second"), capacity.acquire("third"), capacity.acquire("ask"):
        result = subprocess.run([str(NODE), str(WORKER), str(tmp_path), str(SCHEMA), "abort"], capture_output=True, text=True, timeout=10, check=True)
        assert result.stdout.strip() == "aborted"
        assert capacity.status()["running"] == 4
        assert capacity.status()["queued"] == 0
    assert capacity.status()["running"] == 0


def test_background_queue_leaves_capacity_for_foreground(tmp_path):
    capacity = ModelCapacity(tmp_path)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with capacity.acquire("analysis"), capacity.acquire("analysis"), capacity.acquire("collector"):
            def acquire_background():
                with capacity.acquire("image"):
                    return True
            future = executor.submit(acquire_background)
            wait_status(capacity, lambda item: item["queued"] == 1)
            result = subprocess.run([str(NODE), str(WORKER), str(tmp_path), str(SCHEMA), "once"], capture_output=True, text=True, timeout=10, check=True)
            assert result.stdout.splitlines() == ["acquired", "released"]
            assert not future.done()
        assert future.result(timeout=10)


def test_cli_capacity_tracks_child_process_identity(tmp_path):
    capacity = ModelCapacity(tmp_path)
    child = subprocess.Popen(["sleep", "30"])
    try:
        with capacity.acquire("cli-verification") as key:
            from fd_desk.model_capacity import process_start
            capacity.bind(key, child.pid, process_start(child.pid))
            assert capacity.status()["running"] == 1
            with capacity.connection() as connection:
                row = connection.execute("SELECT pid FROM model_capacity_requests WHERE id=?", (key,)).fetchone()
                assert row[0] == child.pid and row[0] != os.getpid()
    finally:
        child.terminate()
        child.wait(timeout=5)
