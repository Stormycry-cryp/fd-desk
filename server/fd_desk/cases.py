import io
import json
import math
import random
from collections import Counter, OrderedDict, defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import FastAPI, Query
from fastapi.responses import Response
from openpyxl import Workbook
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .case_index import step_result
from .core import ApiProblem, Line, dump, now, shift_week, validate_week, week_key
from .engine import ref

Unit = Literal["chain", "task"]
BATCH_PRESENTATION = {"line", "from", "to", "unit", "sort", "offset", "limit"}

PRESETS = (
    ("style_changed", "没保住", "款式变了", [], "bad"),
    ("fabric_distorted", "没保住", "面料或印花变形", [], "bad"),
    ("color_shift", "没保住", "颜色偏", [], "bad"),
    ("identity_changed", "没保住", "人脸或身材变了", [], "bad"),
    ("instruction_ignored", "没听懂", "指令没执行", [], "bad"),
    ("instruction_wrong", "没听懂", "执行错了", [], "bad"),
    ("unwanted_change", "没听懂", "改了不该改的", [], "bad"),
    ("quality_defect", "质量差", "糊或有瑕疵", [], "bad"),
    ("text_garbled", "质量差", "文字乱码", [], "bad"),
    ("composition_wrong", "质量差", "比例或裁切不对", [], "bad"),
    ("motion_stiff", "视频", "动作僵或崩", ["video"], "bad"),
    ("video_inconsistent", "视频", "人物和服装不一致", ["video"], "bad"),
    ("video_pacing", "视频", "时长或节奏不对", ["video"], "bad"),
    ("input_issue", "不是模型的问题", "客户输入有问题", [], "neutral"),
    ("capability_limit", "不是模型的问题", "需求超出能力", [], "neutral"),
    ("false_alarm", "判断", "其实没问题", [], "good"),
)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CaseQuery(Strict):
    line: Line
    week: str | None = None
    from_: date | None = Field(default=None, alias="from")
    to: date | None = None
    unit: Unit | None = None
    enterprise: str | None = None
    outcome: str | None = None
    result: str | None = None
    intent: str | None = None
    pattern: str | None = None
    model: str | None = None
    mode: str | None = None
    level: str | None = None
    movement: str | None = None
    slow: bool = False
    steps: str | None = None
    tag: str | None = None
    processed: str | None = None
    scope: Literal["week", "library"] = "week"
    pool: Literal["any", "none"] | None = None
    noted: Literal["any", "none"] | None = None
    q: str | None = None
    sort: Literal["bad_first", "newest", "oldest", "steps", "points", "processed"] | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=200)

    @model_validator(mode="before")
    @classmethod
    def library_dates(cls, values):
        if isinstance(values, dict) and values.get("scope") == "library":
            values = {key: value for key, value in values.items() if key not in ("week", "from", "from_", "to")}
        return values

    @model_validator(mode="after")
    def dates(self):
        if bool(self.from_) != bool(self.to) or self.from_ and self.from_ > self.to:
            raise ValueError("请提供有效的开始和结束日期")
        if not self.from_ and self.week:
            validate_week(self.week)
        allowed = {"outcome": {"bad", "grind", "good"}, "result": {"downloaded", "not_downloaded", "failed", "deleted"},
                   "processed": {"todo", "done", "noted"}, "steps": {"1", "2-3", "4+"}}
        for key, values in allowed.items():
            if getattr(self, key) and not split(getattr(self, key)) <= values:
                raise ValueError(f"{key} 筛选无效")
        return self


class ExportQuery(CaseQuery):
    ids: str | None = None


class LibraryQuery(CaseQuery):
    weeks: int = Field(default=12, ge=1)


class CaseRef(Strict):
    id: str = Field(min_length=1)
    unit: Unit


class Selection(Strict):
    items: list[CaseRef] = Field(min_length=1, max_length=500)


class ReviewInput(Selection):
    addTags: list[str] = Field(default_factory=list)
    removeTags: list[str] = Field(default_factory=list)
    setTags: list[str] | None = None

    @model_validator(mode="before")
    @classmethod
    def legacy_fields(cls, values):
        if isinstance(values, dict):
            return {key: value for key, value in values.items() if key not in ("rating", "status")}
        return values


class TagCreate(Strict):
    group: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=100)
    lines: list[Line] = Field(default_factory=list)
    tone: Literal["bad", "good", "neutral"]


class TagPatch(Strict):
    group: str | None = Field(default=None, min_length=1, max_length=100)
    label: str | None = Field(default=None, min_length=1, max_length=100)
    lines: list[Line] | None = None
    tone: Literal["bad", "good", "neutral"] | None = None
    order: int | None = None
    archived: bool | None = None


class PoolNote(Strict):
    ref: CaseRef
    text: str | None


class PoolInput(Strict):
    line: Line
    add: list[CaseRef] = Field(default_factory=list)
    remove: list[CaseRef] = Field(default_factory=list)
    note: PoolNote | None = None


class BatchInput(Strict):
    line: Line
    from_: date = Field(alias="from")
    to: date
    unit: Unit
    filters: dict[str, str] = Field(default_factory=dict)
    strategy: Literal["stratified", "problems", "per_enterprise", "per_intent"]
    size: int = Field(ge=1, le=500)
    perGroup: int = Field(default=3, ge=1, le=500)
    seed: int = 0
    name: str | None = Field(default=None, min_length=1, max_length=200)
    skipProcessed: bool = True

    @model_validator(mode="before")
    @classmethod
    def legacy_skip(cls, values):
        if not isinstance(values, dict):
            return values
        values = dict(values)
        for key in ("skipReviewed", "skipRated"):
            if key in values:
                values.setdefault("skipProcessed", values.pop(key))
        return values


def split(value):
    return {item.strip() for item in (value or "").split(",") if item.strip()}


def step_group(count):
    return "1" if count == 1 else "2-3" if count <= 3 else "4+"


def checked_query(values, model=CaseQuery):
    try:
        return model.model_validate(values)
    except ValidationError as error:
        raise ApiProblem(422, "invalid_case_query", "Case 筛选字段或日期范围无效") from error


class Cases:
    def __init__(self, context):
        self.context, self.store, self.engine, self.repo = context, context.store, context.engine, context.repo
        self.version = None
        self.pages = OrderedDict()
        self.statistics = OrderedDict()
        with self.store.connection() as conn:
            conn.executescript(Path(__file__).with_name("cases.sql").read_text())
            for table in ("case_reviews", "case_tags", "case_pool", "case_processing", "case_sample_history"):
                for action in ("INSERT", "UPDATE", "DELETE"):
                    conn.execute(f"CREATE TRIGGER IF NOT EXISTS analytics_{table}_{action} AFTER {action} ON {table} BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'; END")
            for order, (key, group, label, lines, tone) in enumerate(PRESETS):
                conn.execute("INSERT OR IGNORE INTO case_tags VALUES (?,?,?,?,?,?,0)", (key, group, label, dump(lines), tone, order))
                if lines == ["video"]:
                    conn.execute("UPDATE case_tags SET lines_json=? WHERE id=? AND lines_json<>?", (dump(lines), key, dump(lines)))
            for row in conn.execute("SELECT * FROM case_reviews WHERE EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value='template_candidate')").fetchall():
                conn.execute("INSERT OR IGNORE INTO case_pool(id,unit,line,enterprise_id,added_at) VALUES (?,?,?,?,?)", (row["id"], row["unit"], row["line"], row["enterprise_id"], row["updated_at"]))
                labels = [key for key in json.loads(row["tags_json"]) if key != "template_candidate"]
                conn.execute("UPDATE case_reviews SET tags_json=? WHERE unit=? AND id=?", (dump(labels), row["unit"], row["id"]))
            conn.execute("UPDATE case_tags SET archived=1 WHERE id='template_candidate' AND archived=0")
            if conn.execute("SELECT 1 FROM metadata WHERE key='case_review_round2'").fetchone() is None:
                old_order = ("instruction_ignored", "instruction_wrong", "unwanted_change", "style_changed", "fabric_distorted", "color_shift", "identity_changed")
                positions = {value[0]: index for index, value in enumerate(PRESETS)}
                for old, key in enumerate(old_order):
                    conn.execute("UPDATE case_tags SET position=? WHERE id=? AND position=?", (positions[key], key, old))
                conn.execute("INSERT INTO metadata VALUES ('case_review_round2','1')")
            for item in self.repo.find("case_batch"):
                filters = item["filters"]
                item.setdefault("range", {key: filters[key] for key in ("from", "to") if key in filters})
                item.setdefault("unit", filters.get("unit", "task" if item["line"] == "video" else "chain"))
                item["filters"] = {key: value for key, value in filters.items() if key not in BATCH_PRESENTATION | {"rating", "status", "collection"}}
                item.pop("reviewed", None)
                self.repo.save("case_batch", item, conn=conn)
            exists = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('case_collections','case_collection_items')")}
            for table in exists:
                if conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]:
                    raise ApiProblem(409, "collection_data_present", "收藏夹包含数据，需要先保全这些记录")
            conn.execute("DROP TABLE IF EXISTS case_collection_items")
            conn.execute("DROP TABLE IF EXISTS case_collections")

    def refresh(self):
        self.engine.refresh()
        version = self.store.generation
        if self.version == version:
            return
        self.index = self.engine.case_index
        self.reviews, self.pool_entries, self.notes = {}, {}, defaultdict(dict)
        with self.store.connection() as conn:
            for row in conn.execute("SELECT id,unit,tags_json,updated_at FROM case_reviews"):
                self.reviews[row["unit"], row["id"]] = {"tags": json.loads(row["tags_json"]), "updatedAt": row["updated_at"]}
            for row in conn.execute("SELECT * FROM case_pool"):
                self.pool_entries[row["unit"], row["id"]] = self.pool_entry(row)
            processing = {(row["unit"], row["id"]): row["processed_at"] for row in conn.execute("SELECT * FROM case_processing")}
        touched = set(self.reviews)
        for unit, key in list(touched):
            fact = self.index.facts.get((unit, key))
            if fact is None:
                continue
            if unit == "chain":
                touched.update(("task", self.index.rows[index].row_key) for index in fact.indices)
            else:
                touched.add(("chain", self.index.task_chains[key]))
        self.effective_reviews = {}
        for unit, key in touched:
            fact = self.index.facts.get((unit, key))
            if fact is None:
                continue
            own = self.reviews.get((unit, key), {})
            sources = [own] if own.get("tags") else []
            if unit == "chain":
                sources.extend(value for index in fact.indices if (value := self.reviews.get(("task", self.index.rows[index].row_key))) and value["tags"])
            elif not sources:
                parent = self.reviews.get(("chain", self.index.task_chains[key]))
                if parent and parent["tags"]:
                    sources.append(parent)
            labels = list(dict.fromkeys(label for value in sources for label in value["tags"]))
            if labels:
                updated = max(value["updatedAt"] for value in sources)
                self.effective_reviews[unit, key] = {"tags": own.get("tags", []), "effectiveTags": labels,
                    "inherited": unit == "task" and not own.get("tags"), "processedAt": processing.get((unit, key), updated), "updatedAt": updated}
        with self.store.connection() as conn:
            for unit, key in processing.keys() - self.effective_reviews.keys():
                conn.execute("DELETE FROM case_processing WHERE unit=? AND id=?", (unit, key))
            for (unit, key), value in self.effective_reviews.items():
                if (unit, key) not in processing:
                    conn.execute("INSERT INTO case_processing(id,unit,processed_at) VALUES (?,?,?)", (key, unit, value["processedAt"]))
        for note in self.context.profiles.annotations():
            block = (note.get("anchor") or {}).get("block", "")
            if not block.startswith(("case:", "record:")):
                continue
            key = block.split(":", 1)[1]
            if block.startswith("case:") and ("chain", key) in self.index.facts:
                self.notes["chain", key][note["id"]] = note
            elif ("task", key) in self.index.facts:
                self.notes["task", key][note["id"]] = note
                self.notes["chain", self.index.task_chains[key]][note["id"]] = note
        self.notes = {key: sorted(values.values(), key=lambda note: (note["updatedAt"], note["id"]), reverse=True) for key, values in self.notes.items()}
        self.annotation_metadata = {}
        for key, notes in self.notes.items():
            entries = sorted((entry for note in notes for entry in note["entries"]), key=lambda entry: entry.get("editedAt") or entry["createdAt"], reverse=True)
            self.annotation_metadata[key] = {"annotationCount": len(notes), "lastAnnotation": {"text": entries[0]["text"], "at": entries[0].get("editedAt") or entries[0]["createdAt"]} if entries else None}
        self.pages.clear()
        self.statistics.clear()
        self.version = self.store.generation

    def fact(self, key, unit=None):
        self.refresh()
        fact = self.index.facts.get((unit, key)) if unit else self.index.facts.get(("chain", key)) or self.index.facts.get(("task", key))
        if fact is None:
            raise ApiProblem(404, "case_not_found", "Case 不存在或来源记录已移除")
        return fact

    def selected(self, items, line=None):
        keys = [(item.unit, item.id) for item in items]
        if len(keys) != len(set(keys)):
            raise ApiProblem(422, "duplicate_cases", "Case 不能重复选择")
        facts = [self.fact(key, unit) for unit, key in keys]
        if line and any(fact.line != line for fact in facts):
            raise ApiProblem(422, "case_line_mismatch", "所选 Case 与产品线不一致")
        return facts

    def review(self, fact):
        return self.effective_reviews.get((fact.unit, fact.id))

    def processed(self, fact):
        return "done" if self.review(fact) else "noted" if self.notes.get((fact.unit, fact.id)) else "todo"

    def annotations(self, fact):
        return self.notes.get((fact.unit, fact.id), [])

    def annotation_info(self, fact):
        return self.annotation_metadata.get((fact.unit, fact.id), {"annotationCount": 0, "lastAnnotation": None})

    def roster(self, line, week):
        return self.engine.customer_statuses(line, week)

    def step(self, index, position):
        task = self.engine.task(self.engine.frame.iloc[index])
        fact = self.index.facts["task", task["rowKey"]]
        return {"rowKey": task["rowKey"], "index": position, "result": step_result(self.index.rows[index]),
                **{field: task[field] for field in ("pattern", "createdAt", "prompt", "inputs", "outputs", "durationSeconds", "points")},
                "review": self.review(fact), **self.annotation_info(fact)}

    def row(self, fact, week=None, detail=False, roster=None):
        roster = self.roster(fact.line, week or fact.week) if roster is None else roster
        enterprise = self.engine.enterprises[fact.enterprise]
        status = roster.get(fact.enterprise, {})
        first_task = self.engine.task(self.engine.frame.iloc[fact.indices[0]])
        notes = self.annotations(fact)
        first, last = self.step(fact.indices[0], 0), self.step(fact.indices[-1], len(fact.indices) - 1)
        failure = next((self.index.rows[index].failure for index in reversed(fact.indices) if self.index.rows[index].failure), None)
        result = {"id": fact.id, "unit": fact.unit, "line": fact.line,
                  "enterprise": {**ref(enterprise), "level": status.get("level"), "movement": status.get("movement")},
                  "user": first_task["user"], "outcome": fact.outcome, "startedAt": fact.started, "endedAt": fact.ended,
                  "stepCount": len(fact.indices), "downloadedAt": fact.downloaded_at, "intent": fact.intent, "mode": fact.mode, "model": fact.model,
                  "config": first_task["config"], "points": fact.points, "durationSeconds": fact.duration, "slow": fact.slow, "failure": failure,
                  "first": first, "last": last, "steps": [self.step(index, position) for position, index in enumerate(fact.indices)] if detail else None,
                  "fdUrl": first_task["fdUrl"], "review": self.review(fact), **self.annotation_info(fact),
                  "processed": self.processed(fact), "pool": self.pool_entries.get((fact.unit, fact.id))}
        if detail:
            result["annotations"] = notes
        return result

    def source(self, key, unit=None):
        fact = self.fact(key, unit)
        first = self.index.rows[fact.indices[0]]
        thumb = self.engine.media((first.outputs or first.inputs)[0], first.config)["thumb"] if first.outputs or first.inputs else None
        return {"id": fact.id, "unit": fact.unit, "thumb": thumb}

    def scope(self, query, *, all_dates=False):
        self.refresh()
        unit = query.unit or ("task" if query.line == "video" else "chain")
        start, end = query.from_, query.to
        if query.scope == "library":
            facts = [self.index.facts[key] for key in self.effective_reviews if key[0] == unit and key in self.index.facts and self.index.facts[key].line == query.line]
            week = max((fact.week for fact in self.index.by_line[query.line, unit]), default=None)
            dates = {"from": min(fact.day for fact in facts), "to": max(fact.day for fact in facts)} if facts else None
            return facts, dates, week
        if query.pool == "any" and not start and not query.week:
            all_dates = True
        if start is None and not all_dates:
            week = query.week or max((row.week for row in self.index.by_line[query.line, unit]), default=None)
            if week is None:
                return [], None, None
            start, end = date.fromisoformat(week), date.fromisoformat(shift_week(week, 1)) - timedelta(days=1)
        week = week_key(end) if end else query.week or max((row.week for row in self.index.by_line[query.line, unit]), default=None)
        if start is None:
            facts = list(self.index.by_line[query.line, unit])
        else:
            facts = []
            for line, kind, day in self.index.by_day:
                if line == query.line and kind == unit and start.isoformat() <= day <= end.isoformat():
                    facts.extend(self.index.by_day[line, kind, day])
        return facts, {"from": start.isoformat(), "to": end.isoformat()} if start else None, week

    def query(self, query):
        facts, dates, week = self.scope(query)
        roster = self.roster(query.line, week) if week else {}
        dimensions = {key: defaultdict(set) for key in ("outcome", "result", "intent", "pattern", "model", "mode", "enterprise", "level", "movement", "steps", "processed", "tag", "slow", "noted", "pool", "q")}
        search = (query.q or "").casefold().strip()
        for position, fact in enumerate(facts):
            review, customer = self.review(fact) or {}, roster.get(fact.enterprise, {})
            noted = bool(self.notes.get((fact.unit, fact.id)))
            values = {"outcome": [fact.outcome], "result": fact.results, "intent": [fact.intent], "pattern": fact.patterns,
                      "model": [fact.model], "mode": [fact.mode], "enterprise": [fact.enterprise], "level": [customer.get("level")],
                      "movement": [customer.get("movement")], "steps": [step_group(len(fact.indices))], "processed": [self.processed(fact)],
                      "tag": review.get("effectiveTags", []), "slow": ["true" if fact.slow else "false"],
                      "noted": ["any" if noted else "none"], "pool": ["any" if (fact.unit, fact.id) in self.pool_entries else "none"]}
            for key, tokens in values.items():
                for token in tokens:
                    if token is not None and token != "":
                        dimensions[key][token].add(position)
            if search and (search in self.engine.enterprises[fact.enterprise]["name"].casefold() or any(search in self.index.rows[index].prompt.casefold() for index in fact.indices)):
                dimensions["q"][search].add(position)
        universe = set(range(len(facts)))
        masks = {}
        for key, buckets in dimensions.items():
            value = "true" if key == "slow" and query.slow else search if key == "q" else getattr(query, key)
            if value:
                selected = {value} if key == "q" else split(value)
                masks[key] = set().union(*(buckets.get(token, set()) for token in selected))

        def included(ignore=None):
            result = universe.copy()
            for key, mask in masks.items():
                if key != ignore:
                    result.intersection_update(mask)
            return result

        matches = [facts[index] for index in included()]
        summary_facts = [facts[index] for index in (masks.get("enterprise", universe))]
        facets = {}
        for key, label in {"outcome": "outcomes", "result": "results", "intent": "intents", "pattern": "patterns", "model": "models", "mode": "modes", "level": "levels", "movement": "movements", "steps": "steps", "processed": "processed", "tag": "tags"}.items():
            candidates = included(key)
            facets[label] = [{"key": token, "count": count} for token, positions in sorted(dimensions[key].items()) if (count := len(positions & candidates))]
        candidates = included("enterprise")
        facets["enterprises"] = [{"id": key, "name": self.engine.enterprises[key]["name"], "count": count} for key, positions in dimensions["enterprise"].items() if (count := len(positions & candidates))]
        facets["enterprises"].sort(key=lambda item: (-item["count"], item["id"]))
        facets["slow"] = len(dimensions["slow"].get("true", set()) & included("slow"))
        facets["noted"] = len(dimensions["noted"].get("any", set()) & included("noted"))
        self.sort(matches, query.sort or ("processed" if query.scope == "library" else "bad_first"))
        return matches, self.summary(summary_facts), facets, dates, week, roster

    def sort(self, facts, order):
        facts.sort(key=lambda fact: (fact.started, fact.id), reverse=order != "oldest")
        if order == "bad_first":
            facts.sort(key=lambda fact: {"bad": 0, "grind": 1, "good": 2}[fact.outcome])
        elif order in ("steps", "points"):
            facts.sort(key=lambda fact: len(fact.indices) if order == "steps" else fact.points, reverse=True)
        elif order == "processed":
            facts.sort(key=lambda fact: (self.review(fact) or {}).get("processedAt") or "", reverse=True)

    def summary(self, facts):
        outcomes, processed = Counter(), Counter()
        intents, enterprises = defaultdict(Counter), defaultdict(Counter)
        for fact in facts:
            outcomes[fact.outcome] += 1
            processed[self.processed(fact)] += 1
            for bucket in (intents[fact.intent or "未分类"], enterprises[fact.enterprise]):
                bucket["total"] += 1
                bucket[fact.outcome] += 1
        return {"total": len(facts), "outcomes": {key: outcomes[key] for key in ("bad", "grind", "good")},
                "byIntent": [{"key": key, "total": counts["total"], "bad": counts["bad"], "grind": counts["grind"]} for key, counts in sorted(intents.items(), key=lambda item: (-item[1]["bad"], item[0]))],
                "byEnterprise": [{"enterprise": ref(self.engine.enterprises[key]), "total": counts["total"], "bad": counts["bad"], "grind": counts["grind"]} for key, counts in sorted(enterprises.items(), key=lambda item: (-item[1]["bad"], item[0]))[:20]],
                "processed": processed["done"], "noted": processed["noted"]}

    def page(self, query):
        self.refresh()
        key = query.model_dump_json()
        if key in self.pages:
            self.pages.move_to_end(key)
            return self.pages[key]
        facts, summary, facets, dates, week, roster = self.query(query)
        result = {"items": [self.row(fact, week, roster=roster) for fact in facts[query.offset:query.offset + query.limit]], "total": len(facts), "summary": summary, "facets": facets, "range": dates}
        if len(self.pages) >= 48:
            self.pages.popitem(last=False)
        self.pages[key] = result
        return result

    def tags(self, line=None, all_=False):
        self.refresh()
        uses = Counter()
        for selected_line in ([line] if line else ("inspiration", "video")):
            unit = "task" if selected_line == "video" else "chain"
            week = max((fact.week for fact in self.index.by_line[selected_line, unit]), default=None)
            if week:
                for key, review in self.effective_reviews.items():
                    fact = self.index.facts[key]
                    if fact.line == selected_line and fact.unit == unit and shift_week(week, -7) <= fact.week <= week:
                        uses.update(review["effectiveTags"])
        with self.store.connection() as conn:
            values = [{"id": row["id"], "group": row["group_name"], "label": row["label"], "lines": json.loads(row["lines_json"]), "tone": row["tone"], "order": row["position"], "archived": bool(row["archived"]), "uses": uses[row["id"]]} for row in conn.execute("SELECT * FROM case_tags")]
        return sorted((tag for tag in values if (all_ or not tag["archived"]) and (not line or not tag["lines"] or line in tag["lines"])), key=lambda tag: (-tag["uses"], tag["order"], tag["id"]))

    def save_tag(self, body, key=None):
        if key:
            item = next((tag for tag in self.tags(all_=True) if tag["id"] == key), None)
            if item is None:
                raise ApiProblem(404, "not_found", "标签不存在")
            changes = body.model_dump(exclude_unset=True)
            if any(value is None for value in changes.values()):
                raise ApiProblem(422, "invalid_tag", "标签字段不能为空")
            item.update(changes)
        else:
            item = {**body.model_dump(), "id": uuid4().hex, "order": max((tag["order"] for tag in self.tags(all_=True)), default=-1) + 1, "archived": False}
        if any(key == preset[0] and preset[3] == ["video"] for preset in PRESETS) and item["lines"] != ["video"]:
            raise ApiProblem(422, "invalid_tag_line", "视频预置标签仅适用于视频业务线")
        if key == "template_candidate" and not item["archived"]:
            raise ApiProblem(422, "invalid_tag", "可做模板通过模板池管理")
        with self.store.connection() as conn:
            conn.execute("INSERT INTO case_tags VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_name=excluded.group_name,label=excluded.label,lines_json=excluded.lines_json,tone=excluded.tone,position=excluded.position,archived=excluded.archived", (item["id"], item["group"], item["label"], dump(list(dict.fromkeys(item["lines"]))), item["tone"], item["order"], item["archived"]))
        return next(tag for tag in self.tags(all_=True) if tag["id"] == item["id"])

    def write_reviews(self, body, clear=False):
        facts = self.selected(body.items)
        if not clear:
            fields = body.model_fields_set - {"items"}
            if not fields:
                return {"updated": 0}
            if "setTags" in fields and body.setTags is None:
                raise ApiProblem(422, "invalid_tags", "整体替换标签时请提供标签数组")
            if "setTags" in fields and fields & {"addTags", "removeTags"}:
                raise ApiProblem(422, "invalid_tags", "整体替换标签不能同时添加或移除标签")
            if set(body.addTags) & set(body.removeTags):
                raise ApiProblem(422, "invalid_tags", "同一个标签不能同时添加和移除")
            tags = {tag["id"]: tag for tag in self.tags(all_=True)}
            added = body.setTags if body.setTags is not None else body.addTags
            for key in set(added + body.removeTags):
                if key not in tags:
                    raise ApiProblem(422, "invalid_tag", "所选标签不存在")
            for fact in facts:
                current = self.reviews.get((fact.unit, fact.id), {}).get("tags", [])
                if any((tags[key]["archived"] and key not in current) or tags[key]["lines"] and fact.line not in tags[key]["lines"] for key in added):
                    raise ApiProblem(422, "invalid_tag", "标签已归档或不适用于所选产品线")
        stamp = now()
        with self.store.connection() as conn:
            for fact in facts:
                current = self.reviews.get((fact.unit, fact.id), {}).get("tags", [])
                labels = [] if clear else list(dict.fromkeys(body.setTags if body.setTags is not None else [key for key in current if key not in body.removeTags] + body.addTags))
                if not labels:
                    conn.execute("DELETE FROM case_reviews WHERE unit=? AND id=?", (fact.unit, fact.id))
                    continue
                conn.execute("INSERT INTO case_reviews(id,unit,line,enterprise_id,tags_json,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(unit,id) DO UPDATE SET tags_json=excluded.tags_json,updated_at=excluded.updated_at WHERE case_reviews.tags_json<>excluded.tags_json", (fact.id, fact.unit, fact.line, fact.enterprise, dump(labels), stamp))
        self.refresh()
        return {"updated": len(facts)}

    @staticmethod
    def pool_entry(row):
        return {"id": row["id"], "unit": row["unit"], "line": row["line"], "note": row["note"], "templateId": row["template_id"], "addedAt": row["added_at"]}

    def pool(self, line, unit=None):
        self.refresh()
        entries = sorted((item for key, item in self.pool_entries.items() if item["line"] == line and (unit is None or item["unit"] == unit) and key in self.index.facts), key=lambda item: (item["addedAt"], item["unit"], item["id"]), reverse=True)
        return {"entries": entries, "rows": [self.row(self.index.facts[item["unit"], item["id"]]) for item in entries]}

    def write_pool(self, body):
        added = self.selected(body.add, body.line)
        removed = self.selected(body.remove, body.line)
        if {(item.unit, item.id) for item in body.add} & {(item.unit, item.id) for item in body.remove}:
            raise ApiProblem(422, "invalid_selection", "不能同时添加和移除同一个 Case")
        note_fact = self.selected([body.note.ref], body.line)[0] if body.note else None
        adding = {(fact.unit, fact.id) for fact in added}
        removing = {(fact.unit, fact.id) for fact in removed}
        if note_fact and ((note_fact.unit, note_fact.id) in removing or (note_fact.unit, note_fact.id) not in self.pool_entries and (note_fact.unit, note_fact.id) not in adding):
            raise ApiProblem(422, "case_not_in_pool", "只能为模板池中的 Case 添加备注")
        changed = adding | removing
        with self.store.connection() as conn:
            for fact in added:
                conn.execute("INSERT OR IGNORE INTO case_pool(id,unit,line,enterprise_id,added_at) VALUES (?,?,?,?,?)", (fact.id, fact.unit, fact.line, fact.enterprise, now()))
            for fact in removed:
                conn.execute("DELETE FROM case_pool WHERE unit=? AND id=?", (fact.unit, fact.id))
            if note_fact:
                conn.execute("UPDATE case_pool SET note=? WHERE unit=? AND id=?", (body.note.text, note_fact.unit, note_fact.id))
                changed.add((note_fact.unit, note_fact.id))
        return {"updated": len(changed)}

    def batch(self, key, detail=False):
        self.refresh()
        item = self.repo.get("case_batch", key)
        facts = [self.fact(value["id"], value["unit"]) for value in item["items"]]
        item["processed"] = sum(self.processed(fact) == "done" for fact in facts)
        if detail:
            query = checked_query({**item["filters"], **item.get("range", {}), "line": item["line"], "unit": item.get("unit")})
            _, _, week = self.scope(query)
            roster = self.roster(item["line"], week) if week else {}
            item["rows"] = [self.row(fact, week, roster=roster) for fact in facts]
        return {key: value for key, value in item.items() if key not in ("range", "unit", "reviewed")}

    def batches(self, line):
        items = sorted(self.repo.find("case_batch", line=line), key=lambda item: (item["createdAt"], item["id"]), reverse=True)[:30]
        return [self.batch(item["id"]) for item in items]

    def sample(self, body):
        filters = {key: value for key, value in body.filters.items() if key not in BATCH_PRESENTATION}
        query = checked_query({**filters, "line": body.line, "from": body.from_, "to": body.to, "unit": body.unit})
        candidates = self.query(query)[0]
        with self.store.connection() as conn:
            sampled = {row[0] for row in conn.execute("SELECT row_key FROM case_sample_history")}
        candidates = [fact for fact in candidates if not any(self.index.rows[index].row_key in sampled for index in fact.indices) and (not body.skipProcessed or self.processed(fact) != "done")]
        rng = random.Random(body.seed)
        candidates.sort(key=lambda fact: fact.id)
        rng.shuffle(candidates)
        picked = []
        priority = {"bad": 0, "grind": 1, "good": 2}
        if body.strategy == "problems":
            candidates = [fact for fact in candidates if fact.outcome in ("bad", "grind")]
            candidates.sort(key=lambda fact: (-int(fact.slow), -int(len(fact.indices) >= 3), -int(bool(fact.results & {"failed", "deleted"})), priority[fact.outcome]))
            picked = candidates[:body.size]
        elif body.strategy in ("per_enterprise", "per_intent"):
            groups = defaultdict(list)
            for fact in candidates:
                groups[fact.enterprise if body.strategy == "per_enterprise" else fact.intent or "未分类"].append(fact)
            for values in groups.values():
                values.sort(key=lambda fact: priority[fact.outcome])
            # 每组按轮次取样，size 限制不会让首个分组占满全部名额。
            for index in range(body.perGroup):
                for key in sorted(groups):
                    if index < len(groups[key]) and len(picked) < body.size:
                        picked.append(groups[key][index])
        else:
            pools = defaultdict(list)
            for fact in candidates:
                pools[fact.outcome, fact.intent or "未分类"].append(fact)
            enterprise_counts = Counter()
            ceiling = max(1, math.floor(body.size * 0.25))
            schedule = ["bad"] * 5 + ["grind"] * 3 + ["good"] * 2
            rng.shuffle(schedule)
            cursor = Counter()
            while pools and len(picked) < body.size:
                wanted = schedule[len(picked) % len(schedule)]
                available = sorted(pools, key=lambda key: (key[0] != wanted, cursor[key], key))
                found = None
                for bucket in available:
                    pool = pools[bucket]
                    while pool and enterprise_counts[pool[-1].enterprise] >= ceiling:
                        pool.pop()
                    if not pool:
                        del pools[bucket]
                        continue
                    found = pool.pop()
                    cursor[bucket] += 1
                    break
                if found:
                    picked.append(found)
                    enterprise_counts[found.enterprise] += 1
        key, stamp = uuid4().hex, now()
        filters = {key: str(value).lower() if isinstance(value, bool) else str(value) for key, value in query.model_dump(by_alias=True, exclude_none=True, exclude_defaults=True).items() if key not in BATCH_PRESENTATION}
        item = {"id": key, "line": body.line, "name": body.name or f"{body.from_} 抽样", "strategy": body.strategy, "filters": filters,
                "range": {"from": body.from_.isoformat(), "to": body.to.isoformat()}, "unit": body.unit,
                "items": [{"id": fact.id, "unit": fact.unit} for fact in picked], "createdAt": stamp}
        with self.store.connection() as conn:
            self.repo.save("case_batch", item, conn=conn)
            for fact in picked:
                for index in fact.indices:
                    conn.execute("INSERT OR IGNORE INTO case_sample_history VALUES (?,?,?)", (self.index.rows[index].row_key, key, stamp))
        return self.batch(key)

    def library_stats(self, query):
        self.refresh()
        key = query.model_dump_json()
        if key in self.statistics:
            self.statistics.move_to_end(key)
            return self.statistics[key]
        filters = query.model_dump(by_alias=True, exclude={"weeks"})
        facts, _, _, _, week, _ = self.query(checked_query({**filters, "scope": "library"}))
        weeks = [shift_week(week, offset) for offset in range(1 - query.weeks, 1)] if week else []
        groups, weekly, matrix, customers = defaultdict(list), defaultdict(Counter), Counter(), defaultdict(Counter)
        false_alarm = 0
        outcomes = Counter(fact.outcome for fact in facts)
        for fact in facts:
            labels = self.review(fact)["effectiveTags"]
            false = fact.outcome == "bad" and "false_alarm" in labels
            false_alarm += false
            weekly[fact.week]["processed"] += 1
            weekly[fact.week]["falseAlarm"] += false
            customers[fact.enterprise]["cases"] += 1
            for tag in labels:
                groups[tag].append(fact)
                weekly[fact.week]["tag:" + tag] += 1
                customers[fact.enterprise]["tag:" + tag] += 1
                matrix[tag, fact.intent or "未分类"] += 1
        tags = {tag["id"]: tag for tag in self.tags(all_=True)}
        linked = {"followups": self.repo.find("followup", line=query.line), "opportunities": self.repo.find("opportunity", line=query.line), "templates": self.repo.find("template", line=query.line)}

        def reference_ids(item):
            values = item.get("sourceCases", []) + item.get("caseIds", [])
            return {value["id"] if isinstance(value, dict) else value for value in values} | {value["id"] for value in item.get("attachments", []) if value["kind"] == "case"}

        issues = []
        for tag, members in groups.items():
            ids = {fact.id for fact in members}
            enterprises = Counter(fact.enterprise for fact in members)
            counts = {kind: sum(bool(ids & reference_ids(item)) for item in objects) for kind, objects in linked.items()}
            opportunities = {item["origin"]["opportunityId"] for item in linked["templates"] if ids & reference_ids(item) and item.get("origin", {}).get("opportunityId")}
            counts["opportunities"] = sum(item["id"] in opportunities or bool(ids & reference_ids(item)) for item in linked["opportunities"])
            members.sort(key=lambda fact: (fact.outcome != "bad", fact.id))
            issues.append({"tag": tags[tag], "cases": len(members), "enterprises": len(enterprises),
                           "topEnterprises": [{"enterprise": ref(self.engine.enterprises[enterprise]), "cases": count} for enterprise, count in enterprises.most_common(20)],
                           "weekly": [{"week": value, "cases": weekly[value]["tag:" + tag]} for value in weeks],
                           "samples": [self.source(fact.id, fact.unit) for fact in members[:4]], "linked": counts})
        result = {"processed": len(facts), "outcomes": {key: outcomes[key] for key in ("bad", "grind", "good")},
                  "falseAlarm": {"cases": false_alarm, "rate": false_alarm / outcomes["bad"] if outcomes["bad"] else None},
                  "tags": sorted(issues, key=lambda value: (-value["cases"], value["tag"]["order"], value["tag"]["id"])),
                  "weekly": [{"week": value, "processed": weekly[value]["processed"], "falseAlarm": weekly[value]["falseAlarm"], "byTag": {tag: weekly[value]["tag:" + tag] for tag in groups}} for value in weeks],
                  "matrix": [{"tag": tag, "intent": intent, "cases": count} for (tag, intent), count in sorted(matrix.items())],
                  "enterprises": [{"enterprise": ref(self.engine.enterprises[enterprise]), "cases": counts["cases"], "tags": [{"tag": key.removeprefix("tag:"), "cases": count} for key, count in sorted(counts.items()) if key.startswith("tag:")]} for enterprise, counts in sorted(customers.items(), key=lambda value: (-value[1]["cases"], value[0]))[:10]]}
        if len(self.statistics) >= 48:
            self.statistics.popitem(last=False)
        self.statistics[key] = result
        return result

    def issues(self, query):
        return self.library_stats(LibraryQuery.model_validate({**query.model_dump(by_alias=True), "weeks": 8}))["tags"]

    def render_export(self, params):
        query = checked_query(params, ExportQuery)
        if query.ids:
            facts, _dates, week = self.scope(query, all_dates=not query.week and not query.from_)
            ids = split(query.ids)
            selected = {fact.id: fact for fact in facts}
            if not ids or not ids <= selected.keys():
                raise ApiProblem(422, "invalid_export_selection", "导出选择包含当前范围以外的 Case")
            facts = [selected[key] for key in sorted(ids)]
            self.sort(facts, query.sort or ("processed" if query.scope == "library" else "bad_first"))
            roster = None
        else:
            facts, _, _, _dates, week, roster = self.query(query)
        if len(facts) > 5000:
            raise ApiProblem(422, "export_case_limit", "导出不能超过 5000 个 Case，请缩小范围")
        book = Workbook()
        sheet = book.active
        sheet.title = "记录"
        sheet.append(["企业", "层级", "动向", "账号", "开始时间", "意图", "模式", "模型", "比例/清晰度或时长", "步数", "结局", "第几步下载", "耗时", "耗点", "第一步提示词", "最后一步提示词", "输入图链接", "最终结果链接", "FD 链接", "处理时间", "生效标签", "批注数", "最近3条批注", "是否在可做模板池", "池备注"])
        steps = book.create_sheet("步骤") if (query.unit or ("task" if query.line == "video" else "chain")) == "chain" else None
        if steps:
            steps.append(["case id", "步序", "结果", "修改方式", "提示词", "输入链接", "结果链接", "生效标签", "批注"])
        tags = {tag["id"]: tag["label"] for tag in self.tags(all_=True)}
        for fact in facts:
            row = self.row(fact, week or fact.week, detail=True, roster=roster)
            review = row["review"] or {}
            notes = sorted((entry for note in row["annotations"] for entry in note["entries"]), key=lambda entry: entry.get("editedAt") or entry["createdAt"], reverse=True)[:3]
            config = row["config"]
            sheet.append([row["enterprise"]["name"], row["enterprise"]["level"], row["enterprise"]["movement"], (row["user"] or {}).get("name"), row["startedAt"], row["intent"], row["mode"], row["model"], " / ".join(str(config[key]) for key in ("ratio", "resolution", "videoDuration") if config[key] is not None), row["stepCount"], row["outcome"], row["downloadedAt"] + 1 if row["downloadedAt"] is not None else None, row["durationSeconds"], row["points"], row["first"]["prompt"], row["last"]["prompt"], "\n".join(media["url"] for media in row["first"]["inputs"]), "\n".join(media["url"] for media in row["last"]["outputs"]), row["fdUrl"], review.get("processedAt"), "\n".join(tags[key] for key in review.get("effectiveTags", [])), row["annotationCount"], "\n".join(f'{(entry.get("editedAt") or entry["createdAt"])[:10]} {entry["text"]}' for entry in notes), "是" if row["pool"] else "否", row["pool"]["note"] if row["pool"] else None])
            if steps:
                for step in row["steps"]:
                    step_fact = self.index.facts["task", step["rowKey"]]
                    comments = sorted((entry for note in self.annotations(step_fact) for entry in note["entries"]), key=lambda entry: entry.get("editedAt") or entry["createdAt"], reverse=True)[:3]
                    steps.append([fact.id, step["index"] + 1, step["result"], step["pattern"], step["prompt"], "\n".join(media["url"] for media in step["inputs"]), "\n".join(media["url"] for media in step["outputs"]), "\n".join(tags[key] for key in (step["review"] or {}).get("effectiveTags", [])), "\n".join(f'{(entry.get("editedAt") or entry["createdAt"])[:10]} {entry["text"]}' for entry in comments)])
        for tab in book:
            tab.freeze_panes = "A2"
            tab.auto_filter.ref = tab.dimensions
            for row in tab:
                for cell in row:
                    if isinstance(cell.value, str):
                        cell.data_type = "s"
        output = io.BytesIO()
        book.save(output)
        book.close()
        return output.getvalue()


def mount(app: FastAPI, context):
    cases = context.cases

    @app.get("/api/cases")
    def page(query: Annotated[CaseQuery, Query()]):
        with context.store.lock:
            return cases.page(query)

    @app.get("/api/cases/export")
    def export(query: Annotated[ExportQuery, Query()]):
        with context.store.lock:
            content = cases.render_export(query.model_dump(by_alias=True, exclude_none=True))
            _, dates, _ = cases.scope(query, all_dates=bool(query.ids and not query.week and not query.from_))
            if dates is None and query.ids:
                unit = query.unit or ("task" if query.line == "video" else "chain")
                selected = [cases.fact(key, unit) for key in split(query.ids)]
                dates = {"from": min(fact.day for fact in selected), "to": max(fact.day for fact in selected)}
            dates = dates or {"from": "全部", "to": "全部"}
        line = "灵感成款" if query.line == "inspiration" else "视频"
        name = f'案例集_{line}_{now()[:10]}.xlsx' if query.scope == "library" else f'可做模板_{line}_{now()[:10]}.xlsx' if query.pool == "any" else f'记录_{line}_{dates["from"]}-{dates["to"]}.xlsx'
        return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})

    @app.get("/api/cases/tags")
    def tags(line: Line, all: bool = False):
        with context.store.lock:
            return cases.tags(line, all)

    @app.post("/api/cases/tags")
    def create_tag(body: TagCreate):
        with context.store.lock:
            return cases.save_tag(body)

    @app.patch("/api/cases/tags/{key}")
    def patch_tag(key: str, body: TagPatch):
        with context.store.lock:
            return cases.save_tag(body, key)

    @app.put("/api/cases/reviews")
    def review(body: ReviewInput):
        with context.store.lock:
            return cases.write_reviews(body)

    @app.delete("/api/cases/reviews")
    def clear_review(body: Selection):
        with context.store.lock:
            return cases.write_reviews(body, clear=True)

    @app.get("/api/cases/pool")
    def pool(line: Line, unit: Unit | None = None):
        with context.store.lock:
            return cases.pool(line, unit)

    @app.put("/api/cases/pool")
    def write_pool(body: PoolInput):
        with context.store.lock:
            return cases.write_pool(body)

    @app.get("/api/cases/library/stats")
    def library_stats(query: Annotated[LibraryQuery, Query()]):
        with context.store.lock:
            return cases.library_stats(query)

    @app.get("/api/cases/batches")
    def batches(line: Line):
        with context.store.lock:
            return cases.batches(line)

    @app.post("/api/cases/batches")
    def sample(body: BatchInput):
        with context.store.lock:
            return cases.sample(body)

    @app.get("/api/cases/batches/{key}")
    def batch(key: str):
        with context.store.lock:
            return cases.batch(key, detail=True)

    @app.delete("/api/cases/batches/{key}", status_code=204)
    def delete_batch(key: str):
        with context.store.lock:
            cases.repo.delete("case_batch", key)

    @app.get("/api/cases/issues")
    def issues(query: Annotated[CaseQuery, Query()]):
        with context.store.lock:
            return cases.issues(query)

    @app.get("/api/cases/{key}")
    def detail(key: str, unit: Unit | None = None, week: str | None = None):
        with context.store.lock:
            if key == "collections":
                raise ApiProblem(404, "not_found", "接口不存在")
            if unit is None:
                raise ApiProblem(422, "missing_case_unit", "请指定 chain 或 task")
            if week:
                validate_week(week)
            return cases.row(cases.fact(key, unit), week, detail=True)
