import fcntl
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .core import ROOT, ZONE, ApiProblem, dump, now
from .model_capacity import process_start

ACCOUNT_URL = "https://new-backstage.zhiyitech.cn/fd-plus/generation-analytics"


class AccountRow(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    name: str = Field(min_length=1)
    phone: str | None
    sales: str | None
    afterSales: str | None
    total: float
    used7d: float = Field(ge=0)
    usedYesterday: float = Field(ge=0)
    remaining: float


class AccountPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    number: int = Field(ge=1)
    total: int = Field(ge=0)
    rows: list[AccountRow]


class AccountSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str
    takenAt: datetime
    expectedTotal: int = Field(ge=0)
    pages: list[AccountPage] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_snapshot(self):
        if self.source != ACCOUNT_URL or self.takenAt.tzinfo is None:
            raise ValueError("账户快照必须来自指定页面，并包含时区")
        if self.takenAt > datetime.now(ZONE) + timedelta(minutes=5):
            raise ValueError("账户快照时间不能晚于当前时间")
        if [page.number for page in self.pages] != list(range(1, len(self.pages) + 1)):
            raise ValueError("账户快照的页面必须连续且从第一页开始")
        if any(page.total != self.expectedTotal for page in self.pages):
            raise ValueError("采集期间页面总数发生变化")
        rows = [row for page in self.pages for row in page.rows]
        if len(rows) != self.expectedTotal or any(not page.rows for page in self.pages) and self.expectedTotal:
            raise ValueError("账户快照行数与页面总数不一致")
        keys = [(row.phone.strip() if row.phone else None, row.name.strip()) for row in rows]
        if len(keys) != len(set(keys)):
            raise ValueError("账户快照存在重复账号")
        return self


def is_low(account):
    return account is not None and ((account["daysLeft"] is not None and account["daysLeft"] <= 7) or account["remaining"] < account["used7d"])


def run_value(row):
    return {"id": row["id"], "state": row["state"], "startedAt": row["started_at"],
            "finishedAt": row["finished_at"], "takenAt": row["taken_at"], "rows": row["rows"],
            "matched": row["matched"], "unmatched": row["unmatched"],
            "error": json.loads(row["error"]) if row["error"] else None}


class Accounts:
    def __init__(self, store):
        self.store = store
        self.cache = {}
        self.version = None

    def status(self):
        with self.store.connection() as conn:
            latest = conn.execute("SELECT * FROM account_runs ORDER BY started_at DESC,rowid DESC LIMIT 1").fetchone()
            successful = conn.execute("SELECT MAX(taken_at) FROM account_runs WHERE state='done'").fetchone()[0]
        return {"latest": run_value(latest) if latest else None, "lastSuccessAt": successful}

    def begin(self):
        key = uuid4().hex
        with self.store.lock, self.store.connection() as conn:
            conn.execute("INSERT INTO account_runs(id,started_at,state) VALUES (?,?,'running')", (key, now()))
        return key

    def failed(self, key, error):
        with self.store.lock, self.store.connection() as conn:
            conn.execute("UPDATE account_runs SET state='failed',finished_at=?,error=? WHERE id=?", (now(), dump(error), key))

    def resume(self, key):
        with self.store.lock, self.store.connection() as conn:
            updated = conn.execute("UPDATE account_runs SET state='running',finished_at=NULL,error=NULL WHERE id=? AND state<>'done'", (key,))
            if not updated.rowcount:
                raise ApiProblem(409, "invalid_account_run", "账户采集运行不存在或已经完成")

    def ingest(self, path, run_id=None):
        path = Path(path).resolve()
        if not path.is_relative_to(self.store.directory.resolve()):
            raise ApiProblem(422, "invalid_account_source", "账户快照必须保存在项目数据目录")
        content = path.read_bytes()
        snapshot = AccountSnapshot.model_validate_json(content)
        fingerprint = hashlib.sha256(content).hexdigest()
        taken = snapshot.takenAt.astimezone(ZONE).isoformat(timespec="seconds")
        rows = [row for page in snapshot.pages for row in page.rows]
        key = run_id or uuid4().hex
        with self.store.lock, self.store.connection() as conn:
            previous = conn.execute("SELECT * FROM account_runs WHERE fingerprint=?", (fingerprint,)).fetchone()
            if previous:
                if run_id and run_id != previous["id"]:
                    conn.execute("DELETE FROM account_runs WHERE id=? AND state IN ('queued','running')", (run_id,))
                return run_value(previous)
            successful = conn.execute("SELECT MAX(taken_at) FROM account_runs WHERE state='done'").fetchone()[0]
            enterprises = [dict(row) for row in conn.execute("SELECT * FROM enterprises")]
            by_phone = {row["admin_phone"]: row for row in enterprises}
            by_name = defaultdict(list)
            for entity in enterprises:
                by_name[entity["name"]].append(entity)
            matched = []
            unmatched = []
            for row in rows:
                phone = row.phone.strip() if row.phone else None
                entity = by_phone.get(phone)
                if entity is None:
                    names = by_name.get(row.name.strip(), [])
                    entity = names[0] if len(names) == 1 else None
                if entity is None:
                    unmatched.append({"name": row.name.strip(), "phone": phone, "sales": row.sales,
                                      "afterSales": row.afterSales, "remaining": row.remaining,
                                      "used7d": row.used7d, "takenAt": taken})
                else:
                    matched.append((entity, row))
            if len({entity["id"] for entity, _ in matched}) != len(matched):
                raise ApiProblem(422, "ambiguous_accounts", "多个账户匹配到同一家企业，需要核对来源账号")
            conn.execute("INSERT OR IGNORE INTO account_runs(id,started_at,state) VALUES (?,?,'running')", (key, now()))
            for entity, row in matched:
                internal = any(value and value.strip() in ("测试人员", "测试") for value in (row.sales, row.afterSales))
                conn.execute("INSERT INTO account_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (entity["id"], taken, row.sales, row.afterSales, row.total, row.used7d,
                              row.usedYesterday, row.remaining, int(internal), key))
                if not entity["owner_manual"] and (successful is None or taken >= successful):
                    conn.execute("UPDATE enterprises SET sales=?,after_sales=? WHERE id=?", (row.sales, row.afterSales, entity["id"]))
            conn.executemany("INSERT INTO account_unmatched VALUES (?,?,?)", [(key, index, dump(row)) for index, row in enumerate(unmatched)])
            conn.execute("UPDATE account_runs SET state='done',finished_at=?,taken_at=?,rows=?,matched=?,unmatched=?,fingerprint=?,source=?,error=NULL WHERE id=?",
                         (now(), taken, len(rows), len(matched), len(unmatched), fingerprint, str(path), key))
            result = conn.execute("SELECT * FROM account_runs WHERE id=?", (key,)).fetchone()
        return run_value(result)

    def unmatched(self):
        with self.store.connection() as conn:
            return [json.loads(row[0]) for row in conn.execute("SELECT u.value FROM account_unmatched u WHERE u.run_id=(SELECT id FROM account_runs WHERE state='done' ORDER BY taken_at DESC,rowid DESC LIMIT 1) ORDER BY u.row_no")]

    def all(self, *, enterprise=None, points=8, at=None):
        end = at or datetime.now(ZONE).isoformat(timespec="seconds")
        day = end[:10]
        with self.store.connection() as conn:
            revision = conn.execute("SELECT value FROM metadata WHERE key='accounts_revision'").fetchone()[0]
        version = (revision, day)
        if self.version != version:
            self.cache.clear()
            self.version = version
        key = (enterprise, points, at)
        if key in self.cache:
            return self.cache[key]
        condition = " AND enterprise_id=?" if enterprise else ""
        params = (end, enterprise) if enterprise else (end,)
        start = (datetime.fromisoformat(end) - timedelta(days=29)).date().isoformat()
        with self.store.connection() as conn:
            latest = conn.execute("SELECT * FROM account_snapshots WHERE run_id=(SELECT id FROM account_runs WHERE state='done' AND taken_at<=? ORDER BY taken_at DESC,rowid DESC LIMIT 1)" + condition, params).fetchall()
            daily = conn.execute("SELECT enterprise_id,substr(taken_at,1,10) AS day,remaining FROM (SELECT enterprise_id,taken_at,remaining,row_number() OVER (PARTITION BY enterprise_id,substr(taken_at,1,10) ORDER BY taken_at DESC) AS n FROM account_snapshots WHERE taken_at>=? AND taken_at<=?" + condition + ") WHERE n=1 ORDER BY day", (start, *params)).fetchall()
        trends = defaultdict(list)
        for row in daily:
            trends[row["enterprise_id"]].append({"date": row["day"], "remaining": row["remaining"]})
        result = {row["enterprise_id"]: {"remaining": row["remaining"], "total": row["total_points"],
                  "used7d": row["used_7d"], "usedYesterday": row["used_yesterday"],
                  "daysLeft": row["remaining"] / (row["used_7d"] / 7) if row["used_7d"] else None,
                  "trend": trends[row["enterprise_id"]][-points:], "internal": bool(row["internal"]),
                  "takenAt": row["taken_at"]} for row in latest}
        self.cache[key] = result
        return result

    def get(self, enterprise, *, points=30, at=None):
        account = self.all(points=points, at=at).get(enterprise)
        if account is not None and self.store.enterprise(enterprise)["kind"] == "internal":
            account = {**account, "internal": True}
        return account

    def owners(self, line):
        with self.store.connection() as conn:
            rows = conn.execute("SELECT sales,after_sales FROM enterprises e WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.enterprise_id=e.id AND t.line=?) OR (e.kind<>'internal' AND e.contract NOT IN ('expired','internal') AND EXISTS (SELECT 1 FROM tasks t WHERE t.enterprise_id=e.id AND t.line<>?))", (line, line)).fetchall()
        counts = Counter((role, row[column]) for row in rows for role, column in (("sales", "sales"), ("after_sales", "after_sales")) if row[column])
        return [{"name": name, "role": role, "enterprises": count} for (role, name), count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]

    def request(self):
        directory = self.store.directory / "collector/accounts"
        directory.mkdir(parents=True, exist_ok=True)
        with self.store.lock:
            with self.store.connection() as conn:
                active = conn.execute("SELECT * FROM account_runs WHERE state IN ('queued','running') ORDER BY started_at DESC LIMIT 1").fetchone()
            if active:
                with (directory / "collection.lock").open("a+") as handle:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return run_value(active)
                process_path = directory / "process.json"
                process = json.loads(process_path.read_text()) if process_path.is_file() else None
                if process and process.get("run") == active["id"] and process_start(process["pid"]) == process.get("processStart"):
                    return run_value(active)
                active_path = directory / "active.json"
                if active_path.is_file():
                    progress = json.loads(active_path.read_text())
                    run_directory = Path(progress["directory"]).resolve()
                    if not run_directory.is_relative_to(directory.resolve()):
                        raise ApiProblem(422, "invalid_account_run", "账户采集目录超出本项目数据目录")
                    child_path = run_directory / "process.json"
                    child = json.loads(child_path.read_text()) if child_path.is_file() else None
                    if child and process_start(child["pid"]) == child["processStart"]:
                        return run_value(active)
                self.failed(active["id"], {"code": "collection_interrupted", "message": "上次账户采集已中断，重新读取当前快照"})
            key = self.begin()
            try:
                process = subprocess.Popen([sys.executable, str(ROOT / "collector/accounts.py"), "--run-id", key, "--force"],
                                           cwd=ROOT, env={**os.environ, "FD_DESK_DATA_DIR": str(self.store.directory)},
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                           start_new_session=True)
            except OSError:
                self.failed(key, {"code": "collection_start_failed", "message": "账户采集进程启动失败"})
                raise
            (directory / "process.json").write_text(dump({"pid": process.pid, "processStart": process_start(process.pid), "run": key}))
        with self.store.connection() as conn:
            return run_value(conn.execute("SELECT * FROM account_runs WHERE id=?", (key,)).fetchone())
