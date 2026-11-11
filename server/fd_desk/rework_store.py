import json

from .core import ApiProblem, dump


class Repo:
    def __init__(self, store):
        self.store = store
        with store.connection() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS rework_objects (
                    kind TEXT NOT NULL, id TEXT NOT NULL, enterprise_id TEXT,
                    line TEXT, week TEXT, state TEXT, value TEXT NOT NULL,
                    PRIMARY KEY(kind, id)
                );
                CREATE INDEX IF NOT EXISTS rework_line_week ON rework_objects(kind,line,week,state);
                CREATE INDEX IF NOT EXISTS rework_enterprise ON rework_objects(kind,enterprise_id);
                CREATE INDEX IF NOT EXISTS rework_job_signature ON rework_objects(json_extract(value,'$.signature'),state) WHERE kind='job';
                CREATE INDEX IF NOT EXISTS rework_job_date ON rework_objects(substr(json_extract(value,'$.job.createdAt'),1,10)) WHERE kind='job';
            """)
            for action in ("INSERT", "UPDATE", "DELETE"):
                record = "old" if action == "DELETE" else "new"
                condition = f"{record}.kind NOT IN ('job','pipeline')"
                if action == "INSERT":
                    condition += " OR new.kind='job'"
                elif action == "UPDATE":
                    condition += " OR (new.kind='job' AND new.state<>old.state)"
                conn.execute(f"DROP TRIGGER IF EXISTS analytics_rework_{action}")
                conn.execute(f"CREATE TRIGGER analytics_rework_{action} AFTER {action} ON rework_objects WHEN {condition} BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'; END")

    def get(self, kind, key):
        with self.store.connection() as conn:
            row = conn.execute("SELECT value FROM rework_objects WHERE kind=? AND id=?", (kind, key)).fetchone()
        if row is None:
            raise ApiProblem(404, "not_found", "记录不存在")
        return json.loads(row[0])

    def find(self, kind, **filters):
        columns = {"enterprise": "enterprise_id", "line": "line", "week": "week", "state": "state"}
        if filters.keys() - columns.keys():
            raise ValueError("查询筛选字段无效")
        selected = {columns[key]: value for key, value in filters.items() if value is not None}
        where = "".join(f" AND {column}=?" for column in selected)
        with self.store.connection() as conn:
            rows = conn.execute(f"SELECT value FROM rework_objects WHERE kind=?{where} ORDER BY rowid DESC", (kind, *selected.values()))
            return [json.loads(row[0]) for row in rows]

    def save(self, kind, value, *, enterprise=None, line=None, week=None, state=None, conn=None):
        if conn is None:
            with self.store.lock, self.store.connection() as connection:
                return self.save(kind, value, enterprise=enterprise, line=line, week=week, state=state, conn=connection)
        entity = value.get("enterprise") or value.get("target")
        if enterprise is None and entity:
            enterprise = entity["id"] if isinstance(entity, dict) else entity
        conn.execute("""
            INSERT INTO rework_objects(kind,id,enterprise_id,line,week,state,value) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(kind,id) DO UPDATE SET enterprise_id=excluded.enterprise_id,
                line=excluded.line,week=excluded.week,state=excluded.state,value=excluded.value
            WHERE rework_objects.value<>excluded.value
        """, (kind, value["id"], enterprise, line or value.get("line"), week or value.get("week"), state or value.get("state"), dump(value)))
        return value

    def delete(self, kind, key, conn=None):
        if conn is None:
            with self.store.lock, self.store.connection() as connection:
                return self.delete(kind, key, connection)
        if not conn.execute("DELETE FROM rework_objects WHERE kind=? AND id=?", (kind, key)).rowcount:
            raise ApiProblem(404, "not_found", "记录不存在")
