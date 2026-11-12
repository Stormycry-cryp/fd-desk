import json
import os
import selectors
import shutil
import signal
import subprocess
import time
import tomllib
from pathlib import Path

import tomli_w

from .core import ROOT, ApiProblem, dump
from .model_capacity import ModelCapacity, process_start


def runtime(directory):
    path = directory / "runtime.json"
    if not path.is_file():
        raise ApiProblem(503, "codex_unconfigured", "缺少 data/runtime.json 中的当前会话模型配置")
    value = json.loads(path.read_text())
    for key in ("codexHome", "codexExecutable", "codexNativeExecutable", "model", "modelProvider", "reasoningEffort"):
        if not value.get(key):
            raise ApiProblem(503, "codex_unconfigured", "Codex CLI 模型配置不完整")
    return value


def execute(directory, prompt_path, schema_path, output_directory, timeout=10800, *, browser_access=False):
    runtime(directory)
    capacity = ModelCapacity(ROOT / "data")
    with capacity.acquire("collector" if browser_access else "analysis") as slot:
        return execute_reserved(directory, prompt_path, schema_path, output_directory, timeout,
                                browser_access=browser_access, capacity=capacity, slot=slot)


def execute_reserved(directory, prompt_path, schema_path, output_directory, timeout, *, browser_access, capacity, slot):
    config = runtime(directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    last = output_directory / "answer.json"
    if last.exists():
        raise ApiProblem(409, "codex_output_exists", "任务输出已经存在，请核对原任务")
    work = directory / "work/codex"
    work.mkdir(parents=True, exist_ok=True)
    local_home = output_directory / "codex-home"
    local_home.mkdir(mode=0o700, exist_ok=True)
    source_home = Path(config["codexHome"])
    source_config = tomllib.loads((source_home / "config.toml").read_text())
    provider = source_config["model_providers"][config["modelProvider"]]
    configuration = {"model_providers": {config["modelProvider"]: provider}}
    selected_config = local_home / "config.toml"
    selected_config.write_text(tomli_w.dumps(configuration))
    selected_config.chmod(0o600)
    for name in ("auth.json", "models_cache.json"):
        source = source_home / name
        if source.is_file():
            target = local_home / name
            shutil.copyfile(source, target)
            target.chmod(0o600)
    command = [config["codexNativeExecutable"], "--ask-for-approval", "never", "--disable", "multi_agent", "exec", "--json", "--sandbox", "danger-full-access" if browser_access else "read-only",
        "--model", config["model"], "-c", f'model_provider={json.dumps(config["modelProvider"])}',
        "-c", f'model_reasoning_effort={json.dumps(config["reasoningEffort"])}',
        "-c", f'model_context_window={int(config.get("contextWindow", 1000000))}',
        "-c", f'model_auto_compact_token_limit={int(config.get("autoCompactTokenLimit", 900000))}',
        "-C", str(ROOT), "--output-schema", str(schema_path), "--output-last-message", str(last), "-"]
    environment = {**os.environ, "CODEX_HOME": str(local_home), "TMPDIR": str(work)}
    for key in ("CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"):
        environment.pop(key, None)
    with prompt_path.open("rb") as source:
        process = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, cwd=ROOT, start_new_session=True)
    started = subprocess.run(["ps", "-p", str(process.pid), "-o", "lstart="], check=False, capture_output=True, text=True).stdout.strip()
    capacity.bind(slot, process.pid, process_start(process.pid))
    (output_directory / "process.json").write_text(dump({"pid": process.pid, "processStart": started, "model": config["model"], "provider": config["modelProvider"], "reasoningEffort": config["reasoningEffort"]}))
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    selector.register(process.stderr, selectors.EVENT_READ)
    started = time.monotonic()
    total = 0
    diagnostic = set()
    def classify(value):
        lowered = value.lower()
        for marker, category in ((b"429", "rate_limit"), (b"rate limit", "rate_limit"), (b"subscription", "subscription_required"), (b"invalid value", "invalid_configuration"), (b"unknown model", "unknown_model"), (b"401", "authentication_failed"), (b"403", "access_denied")):
            if marker in lowered:
                diagnostic.add(category)
    buffer = b""
    events = output_directory / "events.jsonl"
    with events.open("w") as log:
        while selector.get_map():
            if time.monotonic() - started > timeout:
                terminate(process)
                raise ApiProblem(504, "codex_timeout", "Codex CLI 运行超时，请核对本次文件和采集记录")
            for selected, _ in selector.select(timeout=1):
                chunk = os.read(selected.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(selected.fileobj)
                    continue
                total += len(chunk)
                if selected.fileobj is process.stderr:
                    classify(chunk)
                if total > 64 * 1024 * 1024:
                    terminate(process)
                    raise ApiProblem(502, "codex_output_limit", "Codex CLI 输出超过单次限制")
                if log.tell() < 128 * 1024:
                    log.write(dump({"stream": "stdout" if selected.fileobj is process.stdout else "stderr", "bytes": len(chunk)}) + "\n")
                if selected.fileobj is process.stdout:
                    buffer += chunk
                    lines = buffer.split(b"\n")
                    buffer = lines.pop()
                    for line in lines:
                        if not line.startswith(b"{") or len(line) > 2 * 1024 * 1024:
                            continue
                        event = json.loads(line)
                        if event.get("type") in ("error", "turn.failed"):
                            classify(line)
                        if event.get("type") == "thread.started":
                            (output_directory / "session.json").write_text(dump({"threadId": event["thread_id"]}))
                        if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
                            (output_directory / "usage.json").write_text(dump(event["usage"]))
                        if log.tell() < 128 * 1024:
                            log.write(dump({"event": event.get("type")}) + "\n")
                    if len(buffer) > 2 * 1024 * 1024:
                        buffer = b""
        selector.close()
    code = process.wait(timeout=20)
    (output_directory / "status.json").write_text(dump({"exitCode": code, "diagnostics": sorted(diagnostic)}))
    if code or not last.is_file():
        raise ApiProblem(502, "codex_failed", f"Codex CLI 未完成任务，退出状态 {code}，诊断 {','.join(sorted(diagnostic)) or '无模型完成结果'}")
    if last.stat().st_size > 8 * 1024 * 1024:
        raise ApiProblem(502, "codex_output_limit", "Codex CLI 最终输出超过限制")
    return json.loads(last.read_text())


def terminate(process):
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=20)
