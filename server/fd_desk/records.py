import math
import random
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import FastAPI, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from .core import ApiProblem, now
from .engine import Engine

STRATA = {
    "stuck_tail": 4, "not_downloaded": 4, "downloaded": 3, "failed": 2,
    "batch": 2, "agent": 1, "rare_intent": 2, "new_model": 1,
    "member": 2, "annotated": 1, "recent": 2,
}
Scope = Literal["all", "inspiration", "video"]
Result = Literal["downloaded", "not_downloaded", "failed"]


class SampleInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    enterprise: str = Field(min_length=1)
    scope: Scope = "all"
    from_: date | None = Field(default=None, alias="from")
    to: date | None = None
    size: int = Field(default=24, ge=1, le=60)
    seed: int = 0
    exclude: list[str] = Field(default_factory=list)


def result_of(row):
    return "failed" if row.failed else "downloaded" if row.downloaded else "not_downloaded" if row.status == "success" else None


def validate_dates(start, end):
    if start and end and start > end:
        raise ApiProblem(422, "invalid_range", "开始日期不能晚于结束日期")


class Records:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.engine = context.engine
        self.local_key = None
        self.local_engine = None

    def data(self, enterprise, scope):
        self.store.enterprise(enterprise)
        revision = self.store.revisions()["facts_revision"]
        if getattr(self.engine, "facts_version", None) == revision and hasattr(self.engine, "frame"):
            self.engine.refresh()
            engine = self.engine
        else:
            key = enterprise
            if self.local_key != key:
                self.local_engine = Engine(self.store, enterprise=enterprise)
                self.local_key = key
            engine = self.local_engine
            engine.refresh()
        frame = engine.frame
        frame = frame.iloc[engine.enterprise_all_indices.get(enterprise, [])]
        frame = frame[frame.line.isin(("inspiration", "video") if scope == "all" else (scope,))].copy()
        frame["mode"] = frame["mode"].where(frame["mode"].notna() & frame["mode"].ne(""), frame.scene)
        return engine, frame

    def annotations(self, enterprise):
        grouped = defaultdict(list)
        for item in self.context.profiles.annotations(enterprise):
            block = (item.get("anchor") or {}).get("block") or ""
            if block.startswith("record:"):
                grouped[block[7:]].append(item)
        return grouped

    @staticmethod
    def row(engine, row, annotations, reason=None):
        notes = annotations.get(row.row_key, [])
        latest = next((note for note in notes if note["entries"]), None)
        return {"task": engine.task(row), "annotationCount": len(notes),
                "lastAnnotation": {"text": latest["entries"][-1]["text"], "at": latest["updatedAt"]} if latest else None,
                "sampleReason": reason}

    def page(self, enterprise, scope="all", start=None, end=None, result=None, intent=None, mode=None,
             model=None, user=None, pattern=None, noted=None, q=None, sort="newest", offset=0, limit=60):
        with self.store.lock:
            validate_dates(start, end)
            engine, frame = self.data(enterprise, scope)
            notes = self.annotations(enterprise)
            span = {"from": str(frame.day.min()), "to": str(frame.day.max())} if len(frame) else None
            masks = {}
            if start:
                masks["from"] = frame.day >= start.isoformat()
            if end:
                masks["to"] = frame.day <= end.isoformat()
            results = frame["result"]
            if result:
                masks["result"] = results == result
            for name, column, value in (("intent", "intent", intent), ("mode", "mode", mode), ("model", "model", model), ("user", "user_id", user), ("pattern", "pattern", pattern)):
                if value is not None:
                    masks[name] = frame[column].fillna("").eq(value)
            has_notes = frame.row_key.isin(notes)
            if noted:
                masks["noted"] = has_notes if noted == "any" else ~has_notes
            if q:
                masks["q"] = frame.prompt.str.contains(q, case=False, regex=False, na=False)

            def filtered(ignored=None):
                mask = frame.row_key.notna()
                for name, condition in masks.items():
                    if name != ignored:
                        mask &= condition
                return frame[mask]

            def counts(name, column):
                values = filtered(name)[column].dropna()
                values = values[values != ""].value_counts()
                return [{"key": str(key), "count": int(count)} for key, count in sorted(values.items())]

            selected = filtered()
            result_frame = filtered("result")
            result_counts = Counter(results.loc[result_frame.index])
            users_frame = filtered("user")
            users = []
            for key, group in users_frame.dropna(subset=["user_id"]).groupby("user_id", sort=True):
                users.append({"id": key, "name": str(group.iloc[-1].user_name or ""), "count": len(group)})
            facets = {
                "lines": [{"line": line, "count": int(count)} for line, count in sorted(selected.line.value_counts().items())],
                "results": [{"result": key, "count": result_counts[key]} for key in ("downloaded", "not_downloaded", "failed")],
                "intents": counts("intent", "intent"), "modes": counts("mode", "mode"),
                "models": counts("model", "model"), "users": users,
                "noted": int(filtered("noted").row_key.isin(notes).sum()),
            }
            selected = selected.sort_values(["created_at", "file_order", "row_no"], ascending=[sort == "oldest", sort == "oldest", sort != "oldest"], kind="stable")
            return {"items": [self.row(engine, row, notes) for _, row in selected.iloc[offset:offset + limit].iterrows()],
                    "total": len(selected), "facets": facets, "range": span}

    def sample(self, request):
        with self.store.lock:
            validate_dates(request.from_, request.to)
            engine, full = self.data(request.enterprise, request.scope)
            frame = full
            if request.from_:
                frame = frame[frame.day >= request.from_.isoformat()]
            if request.to:
                frame = frame[frame.day <= request.to.isoformat()]
            notes = self.annotations(request.enterprise)
            rows = {index: row for index, row in frame.iterrows()}
            ordered = list(rows)
            rng = random.Random(request.seed)
            excluded = set(request.exclude)
            target = min(request.size, len(rows))
            line_totals = Counter(row.line for row in rows.values())
            minimum = min(math.ceil(target * .25), target // 2) if request.scope == "all" and len(line_totals) == 2 else 0
            required = {line: min(minimum, count) for line, count in line_totals.items()}
            selected, reasons, line_counts = [], {}, Counter()
            category_counts = Counter((row.intent if row.line == "inspiration" else row["mode"]) for row in rows.values())
            first_models = defaultdict(list)
            for _, row in full.sort_values(["created_at", "file_order", "row_no"], kind="stable").iterrows():
                if row.model and len(first_models[row.model]) < 3:
                    first_models[row.model].append(row.row_key)
            new_models = {key for keys in first_models.values() for key in keys}
            recent_start = date.fromisoformat(now()[:10]) - timedelta(days=6)
            predicates = {
                "stuck_tail": lambda index, row: index in engine.stuck_tails,
                "not_downloaded": lambda index, row: result_of(row) == "not_downloaded",
                "downloaded": lambda index, row: result_of(row) == "downloaded",
                "failed": lambda index, row: result_of(row) == "failed",
                "batch": lambda index, row: row.pattern == "batch",
                "agent": lambda index, row: row.pattern == "agent",
                "rare_intent": lambda index, row: bool(row.intent if row.line == "inspiration" else row["mode"]) and category_counts[row.intent if row.line == "inspiration" else row["mode"]] / len(rows) < .1,
                "new_model": lambda index, row: row.row_key in new_models,
                "member": lambda index, row: bool(row.user_id),
                "annotated": lambda index, row: row.row_key in notes,
                "recent": lambda index, row: row.day >= recent_start.isoformat(),
            }
            candidates = {name: [index for index in ordered if predicate(index, rows[index])] for name, predicate in predicates.items()}
            quotas = {name: request.size * quota // 24 for name, quota in STRATA.items()}
            remainder = request.size - sum(quotas.values())
            ranked = sorted(STRATA, key=lambda name: -(request.size * STRATA[name] % 24))
            for name in ranked[:remainder]:
                quotas[name] += 1

            def choose(pool, count, reason, category=None):
                chosen_categories = set()
                while count and len(selected) < target:
                    available = [index for index in pool if index not in reasons]
                    if category:
                        available = [index for index in available if category(rows[index]) not in chosen_categories]
                    if not available:
                        break
                    remaining = target - len(selected)
                    deficits = {line: max(0, need - line_counts[line]) for line, need in required.items()}
                    if sum(deficits.values()) >= remaining:
                        available = [index for index in available if deficits.get(rows[index].line, 0)]
                    if not available:
                        break
                    unseen_left = sum(rows[index].row_key not in excluded for index in ordered if index not in reasons)
                    if unseen_left >= remaining:
                        unseen_lines = Counter(rows[index].line for index in ordered if index not in reasons and rows[index].row_key not in excluded)
                        available = [index for index in available if rows[index].row_key not in excluded or deficits.get(rows[index].line, 0) > unseen_lines[rows[index].line]]
                    if not available:
                        break
                    preferred = [index for index in available if rows[index].row_key not in excluded]
                    if preferred:
                        available = preferred
                    buckets = defaultdict(list)
                    for index in available:
                        row = rows[index]
                        extra = category(row) if category else (row.failure or {}).get("category", "") if reason == "failed" else ""
                        buckets[(row.week, extra)].append(index)
                    for bucket in buckets.values():
                        rng.shuffle(bucket)
                    keys = sorted(buckets, key=str)
                    rng.shuffle(keys)
                    used_weeks = Counter(rows[index].week for index in selected if reasons[index] == reason)
                    used_categories = Counter((rows[index].failure or {}).get("category", "") for index in selected if reasons[index] == reason) if reason == "failed" else Counter()
                    key = min(keys, key=lambda item: (used_weeks[item[0]], used_categories[item[1]]))
                    index = buckets[key][0]
                    selected.append(index)
                    reasons[index] = reason
                    line_counts[rows[index].line] += 1
                    if category:
                        chosen_categories.add(category(rows[index]))
                    count -= 1

            for name in STRATA:
                category = (lambda row: row.intent if row.line == "inspiration" else row["mode"]) if name == "rare_intent" else (lambda row: row.user_id) if name == "member" else None
                if name == "member":
                    already = {rows[index].user_id for index in selected}
                    pool = [index for index in candidates[name] if rows[index].user_id not in already]
                else:
                    pool = candidates[name]
                choose(pool, quotas[name], name, category)
            for name in ("not_downloaded", "stuck_tail", "downloaded"):
                choose(candidates[name], target - len(selected), name)
            while len(selected) < target:
                before = len(selected)
                choose(ordered, target - len(selected), None, lambda row: (row.intent if row.line == "inspiration" else row["mode"], row.model))
                if len(selected) == before:
                    break
            picked = Counter(reasons.values())
            chosen = [rows[index] for index in selected]
            return {"seed": request.seed, "items": [self.row(engine, row, notes, reasons[index]) for index, row in zip(selected, chosen)],
                    "coverage": [{"stratum": name, "picked": picked[name], "available": len(candidates[name])} for name in STRATA],
                    "dims": {"intents": len({row.intent if row.line == "inspiration" else row["mode"] for row in chosen} - {None, ""}),
                             "models": len({row.model for row in chosen} - {None, ""}), "users": len({row.user_id for row in chosen} - {None, ""}),
                             "weeks": len({row.week for row in chosen}), "lines": sorted({row.line for row in chosen})}}

    def render_export(self, params):
        from .exports import clean, spreadsheet

        with self.store.lock:
            enterprise = params.get("enterprise")
            if not enterprise:
                raise ApiProblem(422, "invalid_enterprise", "必须指定企业")
            scope = params.get("scope", "all")
            if scope not in ("all", "inspiration", "video"):
                raise ApiProblem(422, "invalid_scope", "产品线参数无效")
            try:
                start = date.fromisoformat(params["from"]) if params.get("from") else None
                end = date.fromisoformat(params["to"]) if params.get("to") else None
            except ValueError as error:
                raise ApiProblem(422, "invalid_range", "日期格式无效") from error
            validate_dates(start, end)
            engine, frame = self.data(enterprise, scope)
            if start:
                frame = frame[frame.day >= start.isoformat()]
            if end:
                frame = frame[frame.day <= end.isoformat()]
            if "rowKeys" in params:
                keys = set(params["rowKeys"].split(","))
                if not keys or "" in keys or not keys.issubset(set(frame.row_key)):
                    raise ApiProblem(422, "invalid_export_selection", "导出选择包含当前范围以外的记录")
                frame = frame[frame.row_key.isin(keys)]
            if len(frame) > 5000:
                raise ApiProblem(422, "export_task_limit", "导出记录不能超过5000条")
            notes = self.annotations(enterprise)
            frame = frame.sort_values(["created_at", "file_order", "row_no"], ascending=[False, False, True], kind="stable")
            values = []
            for _, row in frame.iterrows():
                task = engine.task(row)
                annotation = "\n".join(entry["text"] for item in notes.get(row.row_key, []) for entry in item["entries"])
                annotation = clean(annotation)
                result = {"downloaded": "已下载", "not_downloaded": "未下载", "failed": "失败", None: {"deleted": "已删除", "unknown": "未知"}.get(row.status, row.status)}[result_of(row)]
                values.append([task["createdAt"], "灵感成款" if row.line == "inspiration" else "视频", task["mode"], task["intent"], task["model"], (task["user"] or {}).get("name"), clean(task["prompt"]), result, clean(task["failure"]), task["points"], task["fdUrl"], annotation])
            return spreadsheet("生成记录", ["时间", "产品线", "模式", "任务类型", "模型", "成员", "提示词", "结果", "失败原因", "耗点", "FD 链接", "批注"], values)


def mount(app: FastAPI, context):
    records = context.records

    @app.get("/api/records")
    @context.cache.cached
    def get_records(enterprise: Annotated[str, Query(min_length=1)], scope: Scope = "all", from_: Annotated[date | None, Query(alias="from")] = None, to: date | None = None,
                    result: Result | None = None, intent: str | None = None, mode: str | None = None, model: str | None = None,
                    user: str | None = None, pattern: Literal["retry", "tweak", "batch", "adapt", "rework", "new", "agent", "none"] | None = None,
                    noted: Literal["any", "none"] | None = None, q: str | None = None, sort: Literal["newest", "oldest"] = "newest",
                    offset: int = Query(0, ge=0), limit: int = Query(60, ge=1, le=200)):
        return records.page(enterprise, scope, from_, to, result, intent, mode, model, user, pattern, noted, q, sort, offset, limit)

    @app.post("/api/records/sample")
    def sample_records(body: SampleInput):
        return records.sample(body)

    @app.get("/api/records/export")
    def export_records(enterprise: Annotated[str, Query(min_length=1)], scope: Scope = "all", rowKeys: str | None = None,
                       from_: Annotated[date | None, Query(alias="from")] = None, to: date | None = None):
        params = {key: value for key, value in {"enterprise": enterprise, "scope": scope, "rowKeys": rowKeys,
                  "from": from_.isoformat() if from_ else None, "to": to.isoformat() if to else None}.items() if value is not None}
        content = records.render_export(params)
        return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote('生成记录.xlsx')}"})
