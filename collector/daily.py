import argparse
import fcntl
import json
import os
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict

from fd_desk.account_collection import collect_accounts
from fd_desk.codex_runner import execute, runtime
from fd_desk.core import ROOT, ZONE, ApiProblem, dump, now
from fd_desk.ingest import fingerprint, import_file, load_validation
from fd_desk.store import Store

START = date(2026, 9, 10)
SCOPE = ROOT / "collector/scope.json"
SKILL = ROOT / "skills/fddata/SKILL.md"


class ExportResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str
    outputFile: str | None
    reason: str | None


def write_state(path, state):
    temporary = path.with_suffix(".partial")
    temporary.write_text(dump(state))
    temporary.replace(path)


def days_between(start, end):
    return [start + timedelta(days=index) for index in range(max(0, (end - start).days + 1))]


def plan(store, state, today):
    yesterday = today - timedelta(days=1)
    with store.connection() as conn:
        coverage = {line: {row[0] for row in conn.execute("SELECT day FROM coverage WHERE line=?", (line,))} for line in ("inspiration", "video")}
    known = coverage["inspiration"] & coverage["video"]
    missing = {day for day in days_between(START, yesterday) if day.isoformat() not in known}
    recent = set(days_between(max(START, yesterday - timedelta(days=13)), yesterday))
    refresh = {day for day in recent if state.get("days", {}).get(day.isoformat(), {}).get("refreshedFor") != today.isoformat()}
    return sorted(missing) + sorted(refresh - missing)


def seed_verified_freshness(store, state):
    checked = set(state.get("checkedSources", []))
    inbox = store.directory / "inbox"
    for path in inbox.glob("*.csv.gz"):
        report_path = path.with_suffix(".validation.json")
        if not report_path.is_file():
            continue
        report = json.loads(report_path.read_text())
        checksum = report["csv_sha256"]
        if checksum in checked:
            continue
        with store.connection() as conn:
            imported = conn.execute("SELECT value FROM metadata WHERE key=?", (f"source:{checksum}",)).fetchone()
        if not imported:
            continue
        validated = load_validation(path, fingerprint(path), SCOPE)
        for batch in validated["batches"]:
            if not batch.get("started_ms") or not batch["start"].endswith("00:00:00") or not batch["end"].endswith("23:59:59"):
                continue
            extracted = datetime.fromtimestamp(batch["started_ms"] / 1000, ZONE).date().isoformat()
            for day in days_between(date.fromisoformat(batch["start"][:10]), date.fromisoformat(batch["end"][:10])):
                entry = state.setdefault("days", {}).setdefault(day.isoformat(), {})
                if entry.get("refreshedFor", "") < extracted:
                    entry.update(state="done", refreshedFor=extracted, source=str(path.resolve()), sha256=checksum, rows=validated["days"].get(day.isoformat(), 0))
        checked.add(checksum)
    state["checkedSources"] = sorted(checked)


def prompt_for(day, directory):
    return f"""使用本机 fddata Skill 完成真实每日采集。先完整读取 {SKILL} 及其要求的参考资料。
目标日期：{day.isoformat()} 00:00:00 至 23:59:59，Asia/Shanghai。
范围配置：{SCOPE}。保持在约、体验客户和指定全部场景，其他筛选为空。
可写范围仅为 {directory}。不得修改项目源码、web、zy-web、客户资料或后台记录。
使用已有登录页面，通过页面文本或 DOM 确认筛选和数据；禁止视觉操作、截图、提取凭据另行请求接口。
本机已经验证 Chrome 的 Apple Events JavaScript 可以使用。DOM 工具命令为 uv run --directory {ROOT / 'server'} python {ROOT / 'collector/browser.py'}，它维护此任务专用的 FD 生成记录标签页。工具自身维护 {ROOT / 'data/collector/browser.json'} 的标签页编号已经获得授权，可以直接运行。
需要操作控件时，将 JavaScript 源码写入本次 data 目录，然后使用 browser.py --script <脚本路径> --output <结果路径>。通过原生 DOM 查询和点击操作已有页面，禁止读取 Cookie、浏览器存储或自行发送接口请求。
可以读取浏览器默认下载目录，检查本次点击之后实际生成的文件，并仅将本次成功核验的原始文件移入 {directory}；不得修改其他下载文件。
先检查目录中已有的 runs、manifest、校验报告、实际下载文件和未完成请求。复用有效文件，继续缺失范围。
串行导出，单批建议不超过15000条，必要时按小时分拆。文件没有核验完成不得提交重复导出。
独立查询整天页面总数，不能使用导出行数冒充。使用 Skill 的 validate_export.py、build_manifest.py、combine_exports.py 核验并合并。
输出文件名 FD_在约体验_{day:%Y%m%d}-{day:%Y%m%d}.csv.gz，保留同目录 csv.validation.json、原始xlsx、runs、manifest和实际页面筛选证据。
完成状态 done 仅用于真实导出和独立页面总数核验全部通过。登录失效、缺少 DOM 浏览器工具、权限或连续导出失败时返回 blocked 和准确原因。
不得生成测试数据、修改报告中的条数或将未完成操作称为完成。不得输出客户名称、手机号、图片链接、Base64。
使用 data/work 作为临时目录，禁止读写 /tmp。不要安装周期任务；调度由调用程序负责。
最终只输出符合 schema 的 JSON：state、outputFile、reason。outputFile 使用实际合并文件的绝对路径。
"""


def collect_day(store, state, state_path, day, today):
    key = day.isoformat()
    entry = state.setdefault("days", {}).setdefault(key, {})
    day_directory = (store.directory / "collector" / key).resolve()
    directory = day_directory / today.isoformat()
    prior = entry.get("activeRun") or (entry.get("lastRun") if entry.get("state") == "blocked" else None)
    if prior:
        previous = Path(prior).resolve()
        if not previous.is_relative_to(day_directory) or not previous.name.startswith("codex-") or previous.parent.parent != day_directory:
            raise ApiProblem(422, "invalid_collector_state", "上次采集目录不属于目标日期")
        directory = previous.parent
    directory.mkdir(parents=True, exist_ok=True)
    process_path = Path(prior) / "process.json" if prior else None
    if process_path and process_path.is_file():
        process = json.loads(process_path.read_text())
        started = subprocess.run(["ps", "-p", str(process["pid"]), "-o", "lstart="], check=False, capture_output=True, text=True).stdout.strip()
        if started and started == process.get("processStart"):
            raise ApiProblem(409, "collection_still_running", "上次 Codex CLI 进程仍在执行，需要等待原任务完成")
    answer = Path(prior) / "answer.json" if prior else None
    result = None
    if answer and answer.is_file():
        result = ExportResult.model_validate_json(answer.read_text())
    if result is None or result.state != "done":
        run_directory = directory / ("codex-" + uuid4().hex)
        run_directory.mkdir()
        entry.update(state="running", activeRun=str(run_directory), lastRun=str(run_directory), startedAt=now())
        write_state(state_path, state)
        prompt_path = run_directory / "prompt.txt"
        prompt_path.write_text(prompt_for(day, directory))
        schema = run_directory / "schema.json"
        schema.write_text(dump(ExportResult.model_json_schema()))
        result = ExportResult.model_validate(execute(store.directory, prompt_path, schema, run_directory, browser_access=True))
    if result.state != "done" or not result.outputFile:
        entry.update(state="blocked", error=result.reason or "采集未完成")
        entry.pop("activeRun", None)
        write_state(state_path, state)
        raise ApiProblem(503, "collection_blocked", entry["error"])
    source = Path(result.outputFile).resolve()
    if not source.is_relative_to(directory.resolve()) or not source.name.endswith(".csv.gz"):
        raise ApiProblem(422, "invalid_collector_output", "采集结果超出本次数据目录")
    checksum = fingerprint(source)
    report = load_validation(source, checksum, SCOPE)
    if not report or report["requested_start"] != key + " 00:00:00" or report["requested_end"] != key + " 23:59:59":
        raise ApiProblem(422, "invalid_collector_output", "采集报告未覆盖目标完整日期")
    if report.get("expected_total_ui") != report["actual_rows"]:
        raise ApiProblem(422, "independent_count_required", "每日采集必须具有独立页面总数并与导出相符")
    extraction_times = [batch.get("started_ms") for batch in report["batches"]]
    current_ms = int(datetime.now(ZONE).timestamp() * 1000)
    if not extraction_times or any(type(value) is not int or not 0 < value <= current_ms for value in extraction_times):
        raise ApiProblem(422, "invalid_extraction_time", "采集报告缺少有效的实际提取时间")
    refreshed_for = datetime.fromtimestamp(min(extraction_times) / 1000, ZONE).date().isoformat()
    job = import_file(store, source, replace_range=True, scope=SCOPE)
    inbox = store.directory / "inbox"
    inbox.mkdir(exist_ok=True)
    for path in (source, source.with_suffix(".validation.json")):
        target = inbox / path.name
        if target.is_symlink():
            if not target.resolve().is_relative_to((store.directory / "collector").resolve()):
                raise ApiProblem(409, "inbox_conflict", "每日导入路径已有其他来源的引用")
            target.unlink()
        elif target.exists():
            raise ApiProblem(409, "inbox_conflict", "每日导入路径已有文件")
        target.symlink_to(path)
    entry.update(state="done", refreshedFor=refreshed_for, completedAt=now(), source=str(source), sha256=checksum, importId=job["id"], rows=job["rows"])
    entry.pop("activeRun", None)
    entry.pop("error", None)
    write_state(state_path, state)
    return {"day": key, "rows": job["rows"], "state": "done"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--date", type=date.fromisoformat)
    args = parser.parse_args()
    store = Store()
    directory = store.directory / "collector"
    directory.mkdir(exist_ok=True)
    os.environ["TMPDIR"] = str(store.directory / "work")
    state_path = directory / "state.json"
    today = datetime.now(ZONE).date()
    with (directory / "collector.lock").open("a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(dump({"state": "already_running"}))
            return
        for name in ("daily.log", "error.log"):
            log = directory / "logs" / name
            if log.is_file() and not log.is_symlink() and log.stat().st_size > 1024 * 1024:
                with log.open("rb") as source:
                    source.seek(-65536, os.SEEK_END)
                    retained = source.read()
                log.write_bytes(retained)
        state = json.loads(state_path.read_text()) if state_path.is_file() else {"days": {}}
        seed_verified_freshness(store, state)
        dates = [args.date] if args.date else plan(store, state, today)
        if any(day < START or day >= today for day in dates):
            parser.error("采集日期必须在 2026-09-10 至昨天之间")
        if args.plan:
            config = runtime(store.directory)
            print(dump({"days": [day.isoformat() for day in dates], "model": config["model"], "reasoningEffort": config["reasoningEffort"]}))
            return
        for day in dates:
            try:
                print(dump(collect_day(store, state, state_path, day, today)), flush=True)
            except ApiProblem as error:
                state.update(lastError=error.payload, lastAttemptAt=now())
                write_state(state_path, state)
                print(dump({"day": day.isoformat(), **error.payload}), flush=True)
                raise SystemExit(1) from None
        state.update(lastSuccessAt=now(), lastError=None)
        write_state(state_path, state)
        try:
            account_result = collect_accounts(store)
        except Exception as error:  # noqa: BLE001 账户采集单独记录失败，保留已经完成的生成记录导入。
            detail = error.payload if isinstance(error, ApiProblem) else {"code": "accounts_collection_failed", "message": f"账户采集失败：{type(error).__name__}"}
            state.update(accountsError=detail, accountsAttemptAt=now())
            write_state(state_path, state)
            print(dump({"accounts": detail}), flush=True)
            if dates:
                from fd_desk.pipeline import queue_event
                queue_event(store)
            raise SystemExit(1) from None
        state.update(accountsError=None, accountsAttemptAt=now())
        write_state(state_path, state)
        print(dump({"accounts": account_result}), flush=True)
        if dates or account_result["state"] == "done":
            from fd_desk.pipeline import queue_event
            queue_event(store)


if __name__ == "__main__":
    main()
