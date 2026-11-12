import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

from .core import ApiProblem, data_path, dump, now, read_spec

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enterprises (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, admin_phone TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'unknown', contract TEXT NOT NULL DEFAULT 'unknown',
    sales TEXT, after_sales TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
    row_key TEXT PRIMARY KEY, enterprise_id TEXT NOT NULL REFERENCES enterprises(id),
    line TEXT NOT NULL, week TEXT NOT NULL, created_at TEXT NOT NULL,
    file_order INTEGER NOT NULL, row_no INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_line_week ON tasks(line, week);
CREATE INDEX IF NOT EXISTS tasks_enterprise_week ON tasks(enterprise_id, week);
CREATE INDEX IF NOT EXISTS tasks_line_time ON tasks(line, created_at, file_order, row_no DESC);
CREATE INDEX IF NOT EXISTS tasks_enterprise_history ON tasks(enterprise_id, week, created_at);
CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, job TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_fingerprint ON imports(fingerprint);
CREATE TABLE IF NOT EXISTS coverage (
    line TEXT NOT NULL, day TEXT NOT NULL, refreshed_at TEXT NOT NULL,
    PRIMARY KEY(line, day)
);
CREATE TABLE IF NOT EXISTS authored (
    scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(scope, key)
);
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, enterprise_id TEXT NOT NULL REFERENCES enterprises(id),
    text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_enterprise_time ON notes(enterprise_id, created_at DESC);
CREATE TABLE IF NOT EXISTS alert_state (
    id TEXT PRIMARY KEY, dismissed INTEGER NOT NULL, line TEXT NOT NULL, week TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS touches (id TEXT PRIMARY KEY, line TEXT NOT NULL, week TEXT NOT NULL, enterprise_id TEXT NOT NULL REFERENCES enterprises(id), value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS touches_line_week ON touches(line,week);
CREATE INDEX IF NOT EXISTS touches_enterprise_week ON touches(enterprise_id, week);
CREATE TABLE IF NOT EXISTS pushes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reruns (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

ITEM_TABLES = {"drafts", "touches", "pushes", "reruns", "automation_jobs", "findings"}


class Store:
    def __init__(self, path: str | Path | None = None):
        self.directory = data_path(path)
        self.path = self.directory / "fd-desk.db"
        self.lock = RLock()
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_xinfo(tasks)")}
            for column, field in (("scene", "scene"), ("user_phone", "user_phone"), ("downloaded", "downloaded"), ("failed", "failed"), ("points", "points")):
                if column not in columns:
                    value_type = "INTEGER" if column in ("downloaded", "failed", "points") else "TEXT"
                    conn.execute(f"ALTER TABLE tasks ADD COLUMN {column} {value_type} GENERATED ALWAYS AS (json_extract(payload, '$.{field}')) VIRTUAL")
            conn.execute("CREATE INDEX IF NOT EXISTS tasks_conversion ON tasks(enterprise_id, line, week, scene, created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS tasks_members ON tasks(enterprise_id, user_phone)")
            conn.execute("CREATE INDEX IF NOT EXISTS tasks_free_design_stats ON tasks(enterprise_id,week,created_at,user_phone,downloaded,failed,points) WHERE scene='自由改款'")
            conn.execute("DROP INDEX IF EXISTS tasks_free_design")
            if not conn.execute("SELECT 1 FROM settings").fetchone():
                conn.execute("INSERT INTO settings VALUES (1, ?)", (dump(read_spec("settings.default.json")),))
                for i, item in enumerate(read_spec("seeds.json")["findings"]):
                    value = {**item, "id": f"seed-{i + 1}", "rule": item.get("rule"), "updatedAt": now()}
                    conn.execute("INSERT INTO findings VALUES (?, ?)", (value["id"], dump(value)))
            settings = json.loads(conn.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])
            if "rerunDailyBudget" not in settings:
                settings.update(rerunDailyBudget=0, rerunCurrency="CNY")
                conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(settings),))
            defaults = read_spec("settings.default.json")
            for section in ("pipeline", "trials", "followups", "trends"):
                settings[section] = {**defaults[section], **settings.get(section, {})}
            settings["pipeline"].pop("dailyJobs", None)
            conn.execute("UPDATE settings SET value=? WHERE id=1 AND value<>?", (dump(settings), dump(settings)))
            conn.execute("INSERT OR IGNORE INTO metadata VALUES ('analytics_revision','0')")
            conn.execute("INSERT OR IGNORE INTO metadata VALUES ('facts_revision','0')")
            for table in ("tasks", "enterprises", "settings", "findings", "authored", "coverage", "notes", "alert_state", "imports", "drafts", "touches", "pushes", "reruns", "automation_jobs"):
                for action in ("INSERT", "UPDATE", "DELETE"):
                    conn.execute(f"CREATE TRIGGER IF NOT EXISTS analytics_{table}_{action} AFTER {action} ON {table} BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'; END")
            for table in ("tasks", "coverage"):
                for action in ("INSERT", "UPDATE", "DELETE"):
                    conn.execute(f"CREATE TRIGGER IF NOT EXISTS facts_{table}_{action} AFTER {action} ON {table} BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='facts_revision'; END")
            for action in ("INSERT", "UPDATE", "DELETE"):
                record = "old" if action == "DELETE" else "new"
                conn.execute(f"CREATE TRIGGER IF NOT EXISTS account_{action} AFTER {action} ON metadata WHEN {record}.key='fd_account' BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'; END")
            conn.execute("PRAGMA optimize=0x10002")
        self.observer = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA mmap_size=268435456")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def settings(self):
        with self.connection() as conn:
            return json.loads(conn.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])

    def changed(self):
        with self.connection() as conn:
            conn.execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'")

    @property
    def generation(self):
        return self.observer.execute("SELECT CAST(value AS INTEGER) FROM metadata WHERE key='analytics_revision'").fetchone()[0]

    def revisions(self):
        return dict(self.observer.execute("SELECT key, CAST(value AS INTEGER) FROM metadata WHERE key IN ('analytics_revision','facts_revision')"))

    def close(self):
        with self.lock:
            self.observer.close()

    def enterprise(self, enterprise_id):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM enterprises WHERE id=?", (enterprise_id,)).fetchone()
        if row is None:
            raise ApiProblem(404, "not_found", "企业不存在")
        return dict(row)

    def authored(self, scope, key):
        with self.connection() as conn:
            return self.authored_in(conn, scope, key)

    def authored_in(self, conn, scope, key):
        row = conn.execute("SELECT value FROM authored WHERE scope=? AND key=?", (scope, key)).fetchone()
        return json.loads(row[0]) if row else None

    def write_authored(self, conn, scope, key, text, source):
        current = self.authored_in(conn, scope, key)
        if current and current["source"] == "manual" and source != "manual":
            raise ApiProblem(409, "manual_locked", "手工内容受到保护", current=current)
        value = {"text": text, "source": source, "updatedAt": now()}
        conn.execute("INSERT OR REPLACE INTO authored VALUES (?, ?, ?)", (scope, key, dump(value)))
        return value

    def import_jobs(self):
        with self.connection() as conn:
            return [json.loads(row[0]) for row in conn.execute("SELECT job FROM imports ORDER BY rowid DESC")]

    def items(self, table, *, line=None, week=None, enterprise=None):
        if table not in ITEM_TABLES:
            raise ValueError("业务表名称无效")
        filters = {"line": line, "week": week, "enterprise_id": enterprise}
        selected = {key: value for key, value in filters.items() if value is not None}
        if selected and table != "touches":
            raise ValueError("该业务表不支持触达筛选")
        where = " WHERE " + " AND ".join(f"{key}=?" for key in selected) if selected else ""
        with self.connection() as conn:
            return [json.loads(row[0]) for row in conn.execute(f"SELECT value FROM {table}{where} ORDER BY rowid DESC", tuple(selected.values()))]

    def item(self, table, key):
        if table not in ITEM_TABLES:
            raise ValueError("业务表名称无效")
        with self.connection() as conn:
            row = conn.execute(f"SELECT value FROM {table} WHERE id=?", (key,)).fetchone()
        return json.loads(row[0]) if row else self.missing()

    def missing(self):
        raise ApiProblem(404, "not_found", "记录不存在")

    def save(self, table, value, conn=None):
        if conn is None:
            with self.connection() as connection:
                self.save(table, value, connection)
            return
        if table == "touches":
            conn.execute("INSERT INTO touches VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET line=excluded.line,week=excluded.week,enterprise_id=excluded.enterprise_id,value=excluded.value", (value["id"], value["line"], value["week"], value["enterprise"]["id"], dump(value)))
        elif table in {"drafts", "pushes", "reruns", "automation_jobs", "findings"}:
            conn.execute(f"INSERT INTO {table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", (value["id"], dump(value)))
        else:
            raise ValueError("业务表名称无效")
