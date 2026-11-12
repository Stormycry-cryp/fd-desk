import fcntl
import json
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict

from .accounts import ACCOUNT_URL, Accounts, AccountSnapshot
from .codex_runner import execute
from .core import ROOT, ZONE, ApiProblem, dump, now
from .model_capacity import process_start


class CollectionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str
    outputFile: str | None
    reason: str | None


def prompt_for(directory):
    return f"""使用本机 fddata Skill，通过已登录 Chrome 的 DOM 采集真实账户快照。
先读取 {ROOT / 'skills/fddata/SKILL.md'} 和该 Skill 目录下的 references/browser-export.md。
目标页面 {ACCOUNT_URL}，页面下方的客户点数记录表。不需要筛选日期。
只操作此任务专用标签页：uv run --directory {ROOT / 'server'} python {ROOT / 'collector/browser.py'} --page accounts。
首次先读取页面 DOM、实际表头和总数，确认登录状态。不要操作生成记录标签页。
JavaScript 源码通过 apply_patch 写入 {directory}，再调用 browser.py --page accounts --script 路径 --output 路径。
只用 DOM 读取表格和点击分页。禁止截图、读取 Cookie、浏览器存储或额外发送接口请求。
取企业名称、超管手机号、销售名称、售后名称、总点数、过去7日消耗点数、昨日消耗点数、剩余点数。
不要取生成任务数、下载任务数、下载率。数据保持页面实际值，数值删除千分位逗号后转换，空负责人或手机号写 null。
从第一页顺序读取至最后一页。每次确认当前页码、加载状态和内容更新后再读取。保留每页独立 DOM 结果用于核验。
每一页保存页面当时的共N条。最终所有页的总数必须一致，行数之和必须等于独立页面总数。不能使用行数代替页面总数。
最终 JSON 必须符合 {directory / 'snapshot-schema.json'}，source 为目标地址，takenAt 为真实采集时间且含 +08:00。
结构为 source,takenAt,expectedTotal,pages；pages 的每项为 number,total,rows；每行字段为 name,phone,sales,afterSales,total,used7d,usedYesterday,remaining。
将完整结果保存为 {directory / 'snapshot.json'}。不要输出客户名称、手机号或账户余额到对话和日志。
采集文件只写入 {directory}。browser.py 自身维护 {ROOT / 'data/collector/accounts-browser.json'} 的标签页编号已经获得授权，直接运行即可，不需要修改标准库、启动环境或浏览器工具。不得修改项目源码、前端、客户信息和后台数据，不得创建假数据。
中断恢复时检查目录已有页面记录并核对当前总数，不能混用不同时间的快照。缺失、重复、登录失效或分页失败时报告准确问题。
临时文件只能放在此 data 目录，禁止读写 /tmp。不要安装调度，不要使用其他模型或子代理。
最终只输出符合 schema 的 JSON：state、outputFile、reason。完成时 state 为 done，outputFile 为实际快照绝对路径；遇到阻塞为 blocked。
"""


def collect_accounts(store, *, force=False, run_id=None):
    directory = store.directory / "collector/accounts"
    directory.mkdir(parents=True, exist_ok=True)
    accounts = Accounts(store)
    with (directory / "collection.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"state": "already_running"}
        today = datetime.now(ZONE).date().isoformat()
        latest = accounts.status()["lastSuccessAt"]
        if not force and latest and latest[:10] >= today:
            return {"state": "already_done", "takenAt": latest}
        state_path = directory / "active.json"
        previous = json.loads(state_path.read_text()) if state_path.is_file() else None
        if previous:
            with store.connection() as conn:
                completed = conn.execute("SELECT 1 FROM account_runs WHERE id=? AND state='done'", (previous["run"],)).fetchone()
            if completed:
                state_path.unlink()
                previous = None
        run = None
        if previous:
            run = Path(previous["directory"]).resolve()
            if not run.is_relative_to(directory.resolve()):
                raise ApiProblem(422, "invalid_account_run", "账户采集目录超出本项目数据目录")
            process_path = run / "process.json"
            if process_path.is_file():
                process = json.loads(process_path.read_text())
                started = process_start(process["pid"])
                if started and started == process["processStart"]:
                    return {"state": "already_running"}
        key = run_id or (previous["run"] if previous else accounts.begin())
        accounts.resume(key)
        try:
            answer = run / "answer.json" if run else None
            result = CollectionResult.model_validate_json(answer.read_text()) if answer and answer.is_file() else None
            if result is None or result.state != "done":
                run = directory / today / ("codex-" + uuid4().hex)
                run.mkdir(parents=True)
                state_path.write_text(dump({"directory": str(run), "run": key, "startedAt": now()}))
                (run / "snapshot-schema.json").write_text(dump(AccountSnapshot.model_json_schema()))
                (run / "schema.json").write_text(dump(CollectionResult.model_json_schema()))
                (run / "prompt.txt").write_text(prompt_for(run))
                result = CollectionResult.model_validate(execute(store.directory, run / "prompt.txt", run / "schema.json", run, browser_access=True))
            if result.state != "done" or not result.outputFile:
                raise ApiProblem(503, "accounts_collection_blocked", result.reason or "账户采集尚未完成")
            source = Path(result.outputFile).resolve()
            if not source.is_relative_to(run.resolve()):
                raise ApiProblem(422, "invalid_account_source", "账户采集输出超出本次运行目录")
            result = accounts.ingest(source, key)
            state_path.unlink(missing_ok=True)
            return result
        except Exception as error:
            detail = error.payload if isinstance(error, ApiProblem) else {"code": "accounts_collection_failed", "message": f"账户采集失败：{type(error).__name__}"}
            accounts.failed(key, detail)
            raise
