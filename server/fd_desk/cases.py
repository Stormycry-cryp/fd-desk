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
Rating = Literal["good", "ok", "bad"]
Status = Literal["todo", "seen", "done"]

PRESETS = (
    ("instruction_ignored", "没听懂", "指令没执行", [], "bad"),
    ("instruction_wrong", "没听懂", "执行错了", [], "bad"),
    ("unwanted_change", "没听懂", "改了不该改的", [], "bad"),
    ("style_changed", "没保住", "款式变了", [], "bad"),
    ("fabric_distorted", "没保住", "面料或印花变形", [], "bad"),
    ("color_shift", "没保住", "颜色偏", [], "bad"),
    ("identity_changed", "没保住", "人脸或身材变了", [], "bad"),
    ("quality_defect", "质量差", "糊或有瑕疵", [], "bad"),
    ("text_garbled", "质量差", "文字乱码", [], "bad"),
    ("composition_wrong", "质量差", "比例或裁切不对", [], "bad"),
    ("motion_stiff", "视频", "动作僵或崩", ["video"], "bad"),
    ("video_inconsistent", "视频", "人物和服装不一致", ["video"], "bad"),
    ("video_pacing", "视频", "时长或节奏不对", ["video"], "bad"),
    ("input_issue", "不是模型的问题", "客户输入有问题", [], "neutral"),
    ("capability_limit", "不是模型的问题", "需求超出能力", [], "neutral"),
    ("template_candidate", "值得关注", "可做模板", [], "good"),
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
    rating: str | None = None
    tag: str | None = None
    status: str | None = None
    collection: str | None = None
    noted: Literal["any", "none"] | None = None
    q: str | None = None
    sort: Literal["bad_first", "newest", "oldest", "steps", "points"] = "bad_first"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=200)

    @model_validator(mode="after")
    def dates(self):
        if bool(self.from_) != bool(self.to) or self.from_ and self.from_ > self.to:
            raise ValueError("请提供有效的开始和结束日期")
        if not self.from_ and self.week:
            validate_week(self.week)
        allowed = {"outcome": {"bad", "grind", "good"}, "result": {"downloaded", "not_downloaded", "failed", "deleted"},
                   "rating": {"good", "ok", "bad", "none"}, "status": {"todo", "seen", "done"}, "steps": {"1", "2-3", "4+"}}
        for key, values in allowed.items():
            if getattr(self, key) and not split(getattr(self, key)) <= values:
                raise ValueError(f"{key} 筛选无效")
        return self


class ExportQuery(CaseQuery):
    ids: str | None = None


class CaseRef(Strict):
    id: str = Field(min_length=1)
    unit: Unit


class Selection(Strict):
    items: list[CaseRef] = Field(min_length=1, max_length=500)


class ReviewInput(Selection):
    rating: Rating | None = None
    addTags: list[str] = Field(default_factory=list)
    removeTags: list[str] = Field(default_factory=list)
    status: Status | None = None


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


class CollectionCreate(Strict):
    line: Line
    name: str = Field(min_length=1, max_length=200)


class CollectionPatch(Strict):
    name: str = Field(min_length=1, max_length=200)


class CollectionItems(Strict):
    add: list[CaseRef] = Field(default_factory=list)
    remove: list[CaseRef] = Field(default_factory=list)


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
        with self.store.connection() as conn:
            conn.executescript(Path(__file__).with_name("cases.sql").read_text())
            for table in ("case_reviews", "case_tags", "case_collections", "case_collection_items", "case_sample_history"):
                for action in ("INSERT", "UPDATE", "DELETE"):
                    conn.execute(f"CREATE TRIGGER IF NOT EXISTS analytics_{table}_{action} AFTER {action} ON {table} BEGIN UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'; END")
            for order, (key, group, label, lines, tone) in enumerate(PRESETS):
                conn.execute("INSERT OR IGNORE INTO case_tags VALUES (?,?,?,?,?,?,0)", (key, group, label, dump(lines), tone, order))

    def refresh(self):
        self.engine.refresh()
        version = self.store.generation
        if self.version == version:
            return
        self.index = self.engine.case_index
        self.reviews, self.memberships, self.notes = {}, defaultdict(list), defaultdict(list)
        with self.store.connection() as conn:
            for row in conn.execute("SELECT * FROM case_reviews"):
                self.reviews[row["unit"], row["id"]] = {"rating": row["rating"], "tags": json.loads(row["tags_json"]), "status": row["status"], "inherited": False, "updatedAt": row["updated_at"]}
            for row in conn.execute("SELECT * FROM case_collection_items ORDER BY collection_id"):
                self.memberships[row["unit"], row["id"]].append(row["collection_id"])
        for note in self.context.profiles.annotations():
            block = (note.get("anchor") or {}).get("block", "")
            if block.startswith(("case:", "record:")):
                self.notes[block].append(note)
        self.pages.clear()
        self.version = version

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
        value = self.reviews.get((fact.unit, fact.id))
        if value is None and fact.unit == "task":
            value = self.reviews.get(("chain", self.index.task_chains.get(fact.id)))
            if value:
                return {**value, "inherited": True}
        return value

    def annotations(self, fact):
        blocks = {"case:" + fact.id}
        blocks.update("record:" + self.index.rows[index].row_key for index in fact.indices)
        blocks.update("case:" + self.index.rows[index].row_key for index in fact.indices)
        if fact.unit == "task":
            blocks.add("case:" + self.index.task_chains[fact.id])
        values = {note["id"]: note for block in blocks for note in self.notes.get(block, [])}
        return sorted(values.values(), key=lambda note: (note["updatedAt"], note["id"]), reverse=True)

    def roster(self, line, week):
        return self.engine.customer_statuses(line, week)

    def step(self, index, position):
        task = self.engine.task(self.engine.frame.iloc[index])
        fact = self.index.facts["task", task["rowKey"]]
        return {"rowKey": task["rowKey"], "index": position, "result": step_result(self.index.rows[index]),
                **{field: task[field] for field in ("pattern", "createdAt", "prompt", "inputs", "outputs", "durationSeconds", "points")}, "review": self.review(fact)}

    def row(self, fact, week=None, detail=False, roster=None):
        roster = self.roster(fact.line, week or fact.week) if roster is None else roster
        enterprise = self.engine.enterprises[fact.enterprise]
        status = roster.get(fact.enterprise, {})
        first_task = self.engine.task(self.engine.frame.iloc[fact.indices[0]])
        notes = self.annotations(fact)
        entries = sorted((entry for note in notes for entry in note["entries"]), key=lambda entry: entry.get("editedAt") or entry["createdAt"], reverse=True)
        first, last = self.step(fact.indices[0], 0), self.step(fact.indices[-1], len(fact.indices) - 1)
        failure = next((self.index.rows[index].failure for index in reversed(fact.indices) if self.index.rows[index].failure), None)
        result = {"id": fact.id, "unit": fact.unit, "line": fact.line,
                  "enterprise": {**ref(enterprise), "level": status.get("level"), "movement": status.get("movement")},
                  "user": first_task["user"], "outcome": fact.outcome, "startedAt": fact.started, "endedAt": fact.ended,
                  "stepCount": len(fact.indices), "downloadedAt": fact.downloaded_at, "intent": fact.intent, "mode": fact.mode, "model": fact.model,
                  "config": first_task["config"], "points": fact.points, "durationSeconds": fact.duration, "slow": fact.slow, "failure": failure,
                  "first": first, "last": last, "steps": [self.step(index, position) for position, index in enumerate(fact.indices)] if detail else None,
                  "fdUrl": first_task["fdUrl"], "review": self.review(fact), "annotationCount": len(notes),
                  "lastAnnotation": {"text": entries[0]["text"], "at": entries[0].get("editedAt") or entries[0]["createdAt"]} if entries else None,
                  "collections": self.memberships.get((fact.unit, fact.id), [])}
        if detail:
            result["annotations"] = notes
        return result

    def source(self, key):
        fact = self.fact(key)
        first = self.index.rows[fact.indices[0]]
        thumb = self.engine.media((first.outputs or first.inputs)[0], first.config)["thumb"] if first.outputs or first.inputs else None
        return {"id": fact.id, "unit": fact.unit, "thumb": thumb}

    def scope(self, query, *, all_dates=False):
        self.refresh()
        unit = query.unit or ("task" if query.line == "video" else "chain")
        start, end = query.from_, query.to
        if start is None and not all_dates:
            week = query.week or max((row.week for row in self.index.by_line[query.line, unit]), default=None)
            if week is None:
                return [], None, None
            start, end = date.fromisoformat(week), date.fromisoformat(shift_week(week, 1)) - timedelta(days=1)
        week = week_key(end) if end else query.week
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
        dimensions = {key: defaultdict(set) for key in ("outcome", "result", "intent", "pattern", "model", "mode", "enterprise", "level", "movement", "steps", "rating", "tag", "status", "slow", "noted", "collection", "q")}
        search = (query.q or "").casefold().strip()
        for position, fact in enumerate(facts):
            review, customer = self.review(fact) or {}, roster.get(fact.enterprise, {})
            noted = bool(self.annotations(fact))
            values = {"outcome": [fact.outcome], "result": fact.results, "intent": [fact.intent], "pattern": fact.patterns,
                      "model": [fact.model], "mode": [fact.mode], "enterprise": [fact.enterprise], "level": [customer.get("level")],
                      "movement": [customer.get("movement")], "steps": [step_group(len(fact.indices))], "rating": [review.get("rating") or "none"],
                      "tag": review.get("tags", []), "status": [review.get("status", "todo")], "slow": ["true" if fact.slow else "false"],
                      "noted": ["any" if noted else "none"], "collection": self.memberships.get((fact.unit, fact.id), [])}
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
                selected = {value} if key in ("q", "collection") else split(value)
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
        for key, label in {"outcome": "outcomes", "result": "results", "intent": "intents", "pattern": "patterns", "model": "models", "mode": "modes", "level": "levels", "movement": "movements", "steps": "steps", "rating": "ratings", "tag": "tags", "status": "statuses"}.items():
            candidates = included(key)
            facets[label] = [{"key": token, "count": count} for token, positions in sorted(dimensions[key].items()) if (count := len(positions & candidates))]
        candidates = included("enterprise")
        facets["enterprises"] = [{"id": key, "name": self.engine.enterprises[key]["name"], "count": count} for key, positions in dimensions["enterprise"].items() if (count := len(positions & candidates))]
        facets["enterprises"].sort(key=lambda item: (-item["count"], item["id"]))
        facets["slow"] = len(dimensions["slow"].get("true", set()) & included("slow"))
        facets["noted"] = len(dimensions["noted"].get("any", set()) & included("noted"))
        self.sort(matches, query.sort)
        return matches, self.summary(summary_facts), facets, dates, week, roster

    @staticmethod
    def sort(facts, order):
        facts.sort(key=lambda fact: (fact.started, fact.id), reverse=order != "oldest")
        if order == "bad_first":
            facts.sort(key=lambda fact: {"bad": 0, "grind": 1, "good": 2}[fact.outcome])
        elif order in ("steps", "points"):
            facts.sort(key=lambda fact: len(fact.indices) if order == "steps" else fact.points, reverse=True)

    def summary(self, facts):
        outcomes, ratings = Counter(), Counter()
        intents, enterprises = defaultdict(Counter), defaultdict(Counter)
        for fact in facts:
            outcomes[fact.outcome] += 1
            review = self.review(fact)
            if review and review["rating"]:
                ratings[review["rating"]] += 1
            for bucket in (intents[fact.intent or "未分类"], enterprises[fact.enterprise]):
                bucket["total"] += 1
                bucket[fact.outcome] += 1
        return {"total": len(facts), "outcomes": {key: outcomes[key] for key in ("bad", "grind", "good")},
                "byIntent": [{"key": key, "total": counts["total"], "bad": counts["bad"], "grind": counts["grind"]} for key, counts in sorted(intents.items(), key=lambda item: (-item[1]["bad"], item[0]))],
                "byEnterprise": [{"enterprise": ref(self.engine.enterprises[key]), "total": counts["total"], "bad": counts["bad"], "grind": counts["grind"]} for key, counts in sorted(enterprises.items(), key=lambda item: (-item[1]["bad"], item[0]))[:20]],
                "rated": sum(ratings.values()), "ratings": {key: ratings[key] for key in ("good", "ok", "bad")}}

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
        with self.store.connection() as conn:
            values = [{"id": row["id"], "group": row["group_name"], "label": row["label"], "lines": json.loads(row["lines_json"]), "tone": row["tone"], "order": row["position"], "archived": bool(row["archived"])} for row in conn.execute("SELECT * FROM case_tags ORDER BY position,id")]
        return [tag for tag in values if (all_ or not tag["archived"]) and (not line or not tag["lines"] or line in tag["lines"])]

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
        with self.store.connection() as conn:
            conn.execute("INSERT INTO case_tags VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET group_name=excluded.group_name,label=excluded.label,lines_json=excluded.lines_json,tone=excluded.tone,position=excluded.position,archived=excluded.archived", (item["id"], item["group"], item["label"], dump(list(dict.fromkeys(item["lines"]))), item["tone"], item["order"], item["archived"]))
        return item

    def write_reviews(self, body, clear=False):
        facts = self.selected(body.items)
        if not clear:
            fields = body.model_fields_set - {"items"}
            if not fields or "status" in fields and body.status is None:
                raise ApiProblem(422, "invalid_review", "请指定需要修改的评价字段")
            if set(body.addTags) & set(body.removeTags):
                raise ApiProblem(422, "invalid_tags", "同一个标签不能同时添加和移除")
            tags = {tag["id"]: tag for tag in self.tags(all_=True)}
            for key in set(body.addTags + body.removeTags):
                if key not in tags:
                    raise ApiProblem(422, "invalid_tag", "所选标签不存在")
            for fact in facts:
                if any(tags[key]["archived"] or tags[key]["lines"] and fact.line not in tags[key]["lines"] for key in body.addTags):
                    raise ApiProblem(422, "invalid_tag", "标签已归档或不适用于所选产品线")
        stamp = now()
        with self.store.connection() as conn:
            for fact in facts:
                if clear:
                    conn.execute("DELETE FROM case_reviews WHERE unit=? AND id=?", (fact.unit, fact.id))
                    continue
                current = self.review(fact) or {"rating": None, "tags": [], "status": "todo"}
                rating = body.rating if "rating" in fields else current["rating"]
                status = body.status if "status" in fields else current["status"]
                labels = list(dict.fromkeys([key for key in current["tags"] if key not in body.removeTags] + body.addTags))
                conn.execute("INSERT INTO case_reviews VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(unit,id) DO UPDATE SET rating=excluded.rating,tags_json=excluded.tags_json,status=excluded.status,updated_at=excluded.updated_at", (fact.id, fact.unit, fact.line, fact.enterprise, rating, dump(labels), status, stamp))
        return {"updated": len(facts)}

    def collections(self, line):
        with self.store.connection() as conn:
            return [self.collection_row(row) for row in conn.execute("SELECT c.*,count(i.id) AS count FROM case_collections c LEFT JOIN case_collection_items i ON i.collection_id=c.id WHERE c.line=? GROUP BY c.id ORDER BY c.updated_at DESC,c.id", (line,))]

    @staticmethod
    def collection_row(row):
        return {"id": row["id"], "line": row["line"], "name": row["name"], "count": row["count"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    def collection(self, key):
        with self.store.connection() as conn:
            row = conn.execute("SELECT c.*,count(i.id) AS count FROM case_collections c LEFT JOIN case_collection_items i ON i.collection_id=c.id WHERE c.id=? GROUP BY c.id", (key,)).fetchone()
        if row is None:
            raise ApiProblem(404, "not_found", "收藏夹不存在")
        return self.collection_row(row)

    def create_collection(self, body):
        key, stamp = uuid4().hex, now()
        with self.store.connection() as conn:
            conn.execute("INSERT INTO case_collections VALUES (?,?,?,?,?)", (key, body.line, body.name, stamp, stamp))
        return self.collection(key)

    def patch_collection(self, key, body):
        self.collection(key)
        with self.store.connection() as conn:
            conn.execute("UPDATE case_collections SET name=?,updated_at=? WHERE id=?", (body.name, now(), key))
        return self.collection(key)

    def delete_collection(self, key):
        self.collection(key)
        with self.store.connection() as conn:
            conn.execute("DELETE FROM case_collections WHERE id=?", (key,))

    def collection_items(self, key, body):
        collection = self.collection(key)
        added = self.selected(body.add, collection["line"])
        if {(item.unit, item.id) for item in body.add} & {(item.unit, item.id) for item in body.remove}:
            raise ApiProblem(422, "invalid_selection", "不能同时添加和移除同一个 Case")
        with self.store.connection() as conn:
            for fact in added:
                conn.execute("INSERT OR IGNORE INTO case_collection_items VALUES (?,?,?)", (key, fact.id, fact.unit))
            for item in body.remove:
                conn.execute("DELETE FROM case_collection_items WHERE collection_id=? AND unit=? AND id=?", (key, item.unit, item.id))
            conn.execute("UPDATE case_collections SET updated_at=? WHERE id=?", (now(), key))
        return self.collection(key)

    def batch(self, key, detail=False):
        self.refresh()
        item = self.repo.get("case_batch", key)
        facts = [self.fact(value["id"], value["unit"]) for value in item["items"]]
        item["reviewed"] = sum(bool((self.review(fact) or {}).get("rating")) for fact in facts)
        if detail:
            query = checked_query({**item["filters"], "line": item["line"]})
            _, _, week = self.scope(query)
            roster = self.roster(item["line"], week) if week else {}
            item["rows"] = [self.row(fact, week, roster=roster) for fact in facts]
        return item

    def batches(self, line):
        items = sorted(self.repo.find("case_batch", line=line), key=lambda item: (item["createdAt"], item["id"]), reverse=True)[:30]
        return [self.batch(item["id"]) for item in items]

    def sample(self, body):
        query = checked_query({**body.filters, "line": body.line, "from": body.from_, "to": body.to, "unit": body.unit, "offset": 0})
        candidates = self.query(query)[0]
        with self.store.connection() as conn:
            sampled = {row[0] for row in conn.execute("SELECT row_key FROM case_sample_history")}
        candidates = [fact for fact in candidates if not any(self.index.rows[index].row_key in sampled for index in fact.indices) and (query.rating or not (self.review(fact) or {}).get("rating"))]
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
        filters = {key: str(value).lower() if isinstance(value, bool) else str(value) for key, value in query.model_dump(by_alias=True, exclude_none=True).items()}
        item = {"id": key, "line": body.line, "name": body.name or f"{body.from_} 抽样", "strategy": body.strategy, "filters": filters,
                "items": [{"id": fact.id, "unit": fact.unit} for fact in picked], "reviewed": 0, "createdAt": stamp}
        with self.store.connection() as conn:
            self.repo.save("case_batch", item, conn=conn)
            for fact in picked:
                for index in fact.indices:
                    conn.execute("INSERT OR IGNORE INTO case_sample_history VALUES (?,?,?)", (self.index.rows[index].row_key, key, stamp))
        return self.batch(key)

    def issues(self, query):
        _, dates, week = self.scope(query)
        if not week:
            return []
        weeks = [shift_week(week, offset) for offset in range(-7, 1)]
        enterprise_ids = split(query.enterprise)
        groups, history = defaultdict(list), defaultdict(Counter)
        for (unit, key), review in self.reviews.items():
            fact = self.index.facts.get((unit, key))
            if fact is None or fact.line != query.line or enterprise_ids and fact.enterprise not in enterprise_ids:
                continue
            for tag in set(review["tags"]):
                if fact.week in weeks:
                    history[tag][fact.week] += 1
                if dates["from"] <= fact.day <= dates["to"]:
                    groups[tag].append(fact)
        tags = {tag["id"]: tag for tag in self.tags(all_=True)}
        linked = {"followups": self.repo.find("followup", line=query.line), "opportunities": self.repo.find("opportunity", line=query.line), "templates": self.repo.find("template", line=query.line)}
        result = []
        for key, facts in groups.items():
            customers = Counter(fact.enterprise for fact in facts)
            ids = {fact.id for fact in facts}
            counts = {}
            for kind, objects in linked.items():
                counts[kind] = sum(bool(ids & ({value["id"] for value in item.get("attachments", []) if value["kind"] == "case"} | {value["id"] for value in item.get("sourceCases", [])} | set(item.get("caseIds", [])))) for item in objects)
            opportunity_ids = {item["origin"]["opportunityId"] for item in linked["templates"] if ids & {value["id"] for value in item.get("sourceCases", [])} and item["origin"].get("opportunityId")}
            counts["opportunities"] = sum(item["id"] in opportunity_ids or bool(ids & ({value["id"] for value in item.get("sourceCases", [])} | set(item.get("caseIds", [])))) for item in linked["opportunities"])
            facts.sort(key=lambda fact: ((self.reviews[fact.unit, fact.id]["rating"] != "bad"), fact.id))
            result.append({"tag": tags[key], "cases": len(facts), "enterprises": len(customers),
                           "topEnterprises": [{"enterprise": ref(self.engine.enterprises[customer]), "cases": count} for customer, count in customers.most_common(20)],
                           "weekly": [{"week": value, "cases": history[key][value]} for value in weeks],
                           "samples": [self.source(fact.id) for fact in facts[:4]], "linked": counts})
        return sorted(result, key=lambda item: (-item["cases"], item["tag"]["order"], item["tag"]["id"]))

    def render_export(self, params):
        query = checked_query(params, ExportQuery)
        if query.ids:
            facts, _dates, week = self.scope(query, all_dates=not query.week and not query.from_)
            ids = split(query.ids)
            selected = {fact.id: fact for fact in facts}
            if not ids or not ids <= selected.keys():
                raise ApiProblem(422, "invalid_export_selection", "导出选择包含当前范围以外的 Case")
            facts = [selected[key] for key in sorted(ids)]
            self.sort(facts, query.sort)
            roster = None
        else:
            facts, _, _, _dates, week, roster = self.query(query)
        if len(facts) > 5000:
            raise ApiProblem(422, "export_case_limit", "导出不能超过 5000 个 Case，请缩小范围")
        book = Workbook()
        sheet = book.active
        sheet.title = "记录"
        sheet.append(["企业", "层级", "动向", "账号", "开始时间", "意图", "模式", "模型", "比例/清晰度或时长", "步数", "结局", "第几步下载", "耗时", "耗点", "第一步提示词", "最后一步提示词", "输入图链接", "最终结果链接", "FD 链接", "评价", "标签", "状态", "收藏夹", "批注"])
        steps = book.create_sheet("步骤") if (query.unit or ("task" if query.line == "video" else "chain")) == "chain" else None
        if steps:
            steps.append(["case id", "步序", "结果", "修改方式", "提示词", "输入链接", "结果链接", "评价"])
        tags = {tag["id"]: tag["label"] for tag in self.tags(all_=True)}
        collections = {value["id"]: value["name"] for value in self.collections(query.line)}
        for fact in facts:
            row = self.row(fact, week or fact.week, detail=True, roster=roster)
            review = row["review"] or {}
            notes = sorted((entry for note in row["annotations"] for entry in note["entries"]), key=lambda entry: entry.get("editedAt") or entry["createdAt"], reverse=True)[:3]
            config = row["config"]
            sheet.append([row["enterprise"]["name"], row["enterprise"]["level"], row["enterprise"]["movement"], (row["user"] or {}).get("name"), row["startedAt"], row["intent"], row["mode"], row["model"], " / ".join(str(config[key]) for key in ("ratio", "resolution", "videoDuration") if config[key] is not None), row["stepCount"], row["outcome"], row["downloadedAt"] + 1 if row["downloadedAt"] is not None else None, row["durationSeconds"], row["points"], row["first"]["prompt"], row["last"]["prompt"], "\n".join(media["url"] for media in row["first"]["inputs"]), "\n".join(media["url"] for media in row["last"]["outputs"]), row["fdUrl"], review.get("rating"), "\n".join(tags[key] for key in review.get("tags", [])), review.get("status", "todo"), "\n".join(collections[key] for key in row["collections"]), "\n".join(f'{(entry.get("editedAt") or entry["createdAt"])[:10]} {entry["text"]}' for entry in notes)])
            if steps:
                for step in row["steps"]:
                    steps.append([fact.id, step["index"] + 1, step["result"], step["pattern"], step["prompt"], "\n".join(media["url"] for media in step["inputs"]), "\n".join(media["url"] for media in step["outputs"]), (step["review"] or {}).get("rating")])
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
        name = f'记录_{"灵感成款" if query.line == "inspiration" else "视频"}_{dates["from"]}-{dates["to"]}.xlsx'
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

    @app.get("/api/cases/collections")
    def collections(line: Line):
        with context.store.lock:
            return cases.collections(line)

    @app.post("/api/cases/collections")
    def create_collection(body: CollectionCreate):
        with context.store.lock:
            return cases.create_collection(body)

    @app.patch("/api/cases/collections/{key}")
    def patch_collection(key: str, body: CollectionPatch):
        with context.store.lock:
            return cases.patch_collection(key, body)

    @app.delete("/api/cases/collections/{key}", status_code=204)
    def delete_collection(key: str):
        with context.store.lock:
            cases.delete_collection(key)

    @app.put("/api/cases/collections/{key}/items")
    def collection_items(key: str, body: CollectionItems):
        with context.store.lock:
            return cases.collection_items(key, body)

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
    def detail(key: str, unit: Unit, week: str | None = None):
        with context.store.lock:
            if week:
                validate_week(week)
            return cases.row(cases.fact(key, unit), week, detail=True)
