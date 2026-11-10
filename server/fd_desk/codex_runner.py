import json
import os
import selectors
import subprocess

from .core import ROOT, ApiProblem, dump


def runtime(directory):
    path = directory / "runtime.json"
    if not path.is_file():
        raise ApiProblem(503, "codex_unconfigured", "缺少 data/runtime.json 中的当前会话模型配置")
    value = json.loads(path.read_text())
    for key in ("codexHome", "codexExecutable", "model", "modelProvider", "reasoningEffort"):
        if not value.get(key):
            raise ApiProblem(503, "codex_unconfigured", "Codex CLI 模型配置不完整")
    return value


def execute(directory, prompt_path, schema_path, output_directory, timeout=10800, *, browser_access=False):
    config = runtime(directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    last = output_directory / "answer.json"
    if last.exists():
        raise ApiProblem(409, "codex_output_exists", "任务输出已经存在，请核对原任务")
    work = directory / "work/codex"
    work.mkdir(parents=True, exist_ok=True)
    command = [config["codexExecutable"], "--ask-for-approval", "never", "exec", "--json", "--sandbox", "danger-full-access" if browser_access else "workspace-write",
        "--model", config["model"], "-c", f'model_provider={json.dumps(config["modelProvider"])}',
        "-c", f'model_reasoning_effort={json.dumps(config["reasoningEffort"])}',
        "-C", str(ROOT), "--output-schema", str(schema_path), "--output-last-message", str(last), "-"]
    environment = {**os.environ, "CODEX_HOME": config["codexHome"], "TMPDIR": str(work)}
    for key in ("CODEX_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"):
        environment.pop(key, None)
    with prompt_path.open("rb") as source:
        process = subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, cwd=ROOT)
    started = subprocess.run(["ps", "-p", str(process.pid), "-o", "lstart="], check=False, capture_output=True, text=True).stdout.strip()
    (output_directory / "process.json").write_text(dump({"pid": process.pid, "processStart": started, "model": config["model"], "provider": config["modelProvider"], "reasoningEffort": config["reasoningEffort"]}))
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    selector.register(process.stderr, selectors.EVENT_READ)
    import time
    started = time.monotonic()
    total = 0
    diagnostic = set()
    buffer = b""
    events = output_directory / "events.jsonl"
    with events.open("w") as log:
        while selector.get_map():
            if time.monotonic() - started > timeout:
                process.terminate()
                process.wait(timeout=20)
                raise ApiProblem(504, "codex_timeout", "Codex CLI 运行超时，请核对本次文件和采集记录")
            for selected, _ in selector.select(timeout=1):
                chunk = os.read(selected.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(selected.fileobj)
                    continue
                total += len(chunk)
                lowered = chunk.lower()
                for marker, category in ((b"429", "rate_limit"), (b"rate limit", "rate_limit"), (b"subscription", "subscription_required"), (b"invalid value", "invalid_configuration"), (b"unknown model", "unknown_model"), (b"401", "authentication_failed"), (b"403", "access_denied")):
                    if marker in lowered:
                        diagnostic.add(category)
                if total > 64 * 1024 * 1024:
                    process.terminate()
                    process.wait(timeout=20)
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
                        if event.get("type") == "thread.started":
                            (output_directory / "session.json").write_text(dump({"threadId": event["thread_id"]}))
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
