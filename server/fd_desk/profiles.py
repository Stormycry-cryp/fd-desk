import json
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

import pandas as pd
from fastapi import FastAPI, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .core import ZONE, ApiProblem, Line, digest, now, shift_week, validate_week, week_key
from .engine import ref
from .media import Thumbnails
from .profile_facts import calculate
from .views import roster as customer_roster

OPTIONS = {"category": ["女装", "男装", "童装", "内衣泳装", "面料辅料", "鞋包配饰", "综合"], "role": ["品牌商家", "工厂", "面料商", "设计工作室"], "purpose": ["换色出款", "印花面料", "上身图", "改款设计", "视频展示", "详情图"], "rhythm": ["连续", "按批次", "偶尔"], "skill": ["熟手", "一般", "新手"]}
Dimension = Literal["category", "role", "purpose", "rhythm", "skill"]
Kind = Literal["followup", "special", "other"]
PROFILE_CACHE_VERSION = 2


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class InsightOutput(Strict):
    key: Literal["business", "usage", "workflow", "skill", "pain", "opportunity"]
    text: str = Field(min_length=1, max_length=60)
    confidence: Literal["high", "medium", "low"]
    evidenceIds: list[str] = Field(min_length=1)

    @field_validator("text")
    @classmethod
    def check_sentences(cls, value):
        if len([sentence for sentence in re.split(r"[。！？!?]+", value) if sentence.strip()]) > 2:
            raise ValueError("判断不能超过两句")
        return value


class TagsOutput(Strict):
    category: Literal["女装", "男装", "童装", "内衣泳装", "面料辅料", "鞋包配饰", "综合"] | None
    role: Literal["品牌商家", "工厂", "面料商", "设计工作室"] | None
    purpose: Literal["换色出款", "印花面料", "上身图", "改款设计", "视频展示", "详情图"] | None
    skill: Literal["熟手", "一般", "新手"] | None


class ProfileOutput(Strict):
    headline: str | None = Field(max_length=30)
    insights: list[InsightOutput]
    tags: TagsOutput
    change: str | None = Field(max_length=60)

    @model_validator(mode="after")
    def check_counts(self):
        counts = Counter(item.key for item in self.insights)
        if any(count > (2 if key in ("pain", "opportunity") else 1) for key, count in counts.items()):
            raise ValueError("判断项数量超出限制")
        return self


class Text(Strict):
    text: str = Field(min_length=1, max_length=10000)


class TagInput(Strict):
    dimension: Dimension
    value: str | None


class AnchorInput(Strict):
    block: str
    insightId: str | None = None
    quote: str | None = None


class AnnotationInput(Text):
    enterprise: str
    kind: Kind | None = None
    anchor: AnchorInput | None = None


class AnnotationPatch(Strict):
    kind: Kind | None = None
    resolved: bool | None = None


class Profiles:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        self.engine = context.engine
        self.facts_cache = {}
        self.snapshot_cache = {}
        self.roster_ids_cache = {}
        with self.store.lock, self.store.connection() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS profile_calculation_cache (
                enterprise TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
                facts_revision INTEGER NOT NULL, week TEXT NOT NULL, thresholds TEXT NOT NULL,
                value TEXT NOT NULL, PRIMARY KEY (enterprise, kind)
            )""")
        context.jobs.register("profile", self.analyze)
        self.migrate_notes()

    def migrate_notes(self):
        with self.store.lock, self.store.connection() as conn:
            rows = list(conn.execute("SELECT notes.*, enterprises.name, enterprises.kind FROM notes JOIN enterprises ON enterprises.id=notes.enterprise_id"))
            for row in rows:
                key = "note-" + row["id"]
                if conn.execute("SELECT 1 FROM rework_objects WHERE kind='note_migration' AND id=?", (key,)).fetchone():
                    continue
                stamp = row["created_at"]
                item = {"id": key, "enterprise": {"id": row["enterprise_id"], "name": row["name"], "kind": row["kind"]}, "kind": None, "anchor": None, "entries": [{"id": row["id"], "text": row["text"], "createdAt": stamp, "editedAt": None}], "resolved": False, "createdAt": stamp, "updatedAt": stamp}
                self.repo.save("annotation", item, conn=conn)
                self.repo.save("note_migration", {"id": key}, conn=conn)

    def calculation_key(self, enterprise):
        self.engine.refresh()
        dependencies = {key: self.engine.settings[key] for key in ("thresholds", "trends")}
        return (enterprise, PROFILE_CACHE_VERSION, self.store.revisions()["facts_revision"], week_key(datetime.now(ZONE)), json.dumps(dependencies, sort_keys=True))

    def cached_calculation(self, kind, key, memory, compute):
        with self.store.lock:
            if key not in memory:
                with self.store.connection() as conn:
                    row = conn.execute("SELECT value FROM profile_calculation_cache WHERE enterprise=? AND kind=? AND version=? AND facts_revision=? AND week=? AND thresholds=?", (key[0], kind, *key[1:])).fetchone()
                value = json.loads(row[0]) if row else compute()
                if row is None:
                    with self.store.connection() as conn:
                        conn.execute("""INSERT INTO profile_calculation_cache VALUES (?,?,?,?,?,?,?)
                            ON CONFLICT(enterprise,kind) DO UPDATE SET version=excluded.version,
                            facts_revision=excluded.facts_revision,week=excluded.week,
                            thresholds=excluded.thresholds,value=excluded.value""", (key[0], kind, *key[1:], json.dumps(value, ensure_ascii=False)))
                for old in list(memory):
                    if old[1:] != key[1:]:
                        del memory[old]
                memory[key] = value
            return memory[key]

    def facts(self, enterprise):
        with self.store.lock:
            key = self.calculation_key(enterprise)
            return self.cached_calculation("facts", key, self.facts_cache, lambda: calculate(self.engine, enterprise))

    def record(self, enterprise):
        try:
            return self.repo.get("profile", enterprise)
        except ApiProblem as error:
            if error.status != 404:
                raise
            return {"id": enterprise, "version": 0, "generatedAt": None, "headline": None, "insights": [], "tags": [], "manualTags": [], "change": None, "snapshot": None}

    def annotations(self, enterprise=None, from_=None, to=None, resolved=None):
        items = self.repo.find("annotation", enterprise=enterprise)
        migrated = [item["id"][5:] for item in items if item["id"].startswith("note-")]
        if migrated:
            with self.store.connection() as conn:
                existing = {row[0] for row in conn.execute("SELECT id FROM notes")}
            items = [item for item in items if not item["id"].startswith("note-") or item["id"][5:] in existing]
        return sorted((item for item in items if (from_ is None or item["createdAt"][:10] >= from_) and (to is None or item["createdAt"][:10] <= to) and (resolved is None or item["resolved"] == resolved)), key=lambda item: item["updatedAt"], reverse=True)

    def add_annotation(self, enterprise, text, kind=None, anchor=None):
        entity = self.store.enterprise(enterprise)
        stamp = now()
        if anchor:
            block = anchor["block"]
            if block.startswith("record:"):
                with self.store.connection() as conn:
                    record = conn.execute("SELECT 1 FROM tasks WHERE row_key=? AND enterprise_id=? AND line IN ('inspiration','video')", (block.removeprefix("record:"), enterprise)).fetchone()
                if record is None:
                    raise ApiProblem(422, "invalid_record_anchor", "记录批注必须关联当前企业的真实记录")
            anchor = {**anchor, "insightId": anchor.get("insightId"), "quote": anchor.get("quote"), "stale": False}
        item = {"id": uuid4().hex, "enterprise": ref(entity), "kind": kind, "anchor": anchor, "entries": [{"id": uuid4().hex, "text": text, "createdAt": stamp, "editedAt": None}], "resolved": False, "createdAt": stamp, "updatedAt": stamp}
        self.repo.save("annotation", item)
        return item

    def snapshot(self, enterprise):
        annotations = self.annotations(enterprise)
        return self.snapshot_stats(enterprise) | {"annotations": digest(json.dumps(annotations, ensure_ascii=False, sort_keys=True))}

    def snapshot_stats(self, enterprise):
        with self.store.lock:
            key = self.calculation_key(enterprise)
            return self.cached_calculation("snapshot", key, self.snapshot_cache, lambda: self.calculate_snapshot_stats(enterprise))

    def calculate_snapshot_stats(self, enterprise):
        frame = self.engine.frame.iloc[self.engine.enterprise_all_indices.get(enterprise, [])]
        current = week_key(datetime.now(ZONE))
        weeks = [shift_week(current, offset) for offset in range(-5, 0)]
        parts = [frame[frame.week == week] for week in weeks]
        def types(part):
            return Counter(str(row.intent or row.mode) for row in part.itertuples() if row.intent or row.mode)
        counts = [len(part) for part in parts]
        with self.store.connection() as conn:
            other = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM tasks WHERE enterprise_id=? AND line='other'", (enterprise,))]
        for index, week in enumerate(weeks):
            counts[index] += sum(item["week"] == week for item in other)
        recent_types = types(parts[-1])
        previous_types = types(frame[frame.week < weeks[-1]])
        recent_models = Counter(str(value) for value in parts[-1].model.dropna() if value)
        previous_models = Counter(str(value) for value in frame[frame.week < weeks[-1]].model.dropna() if value)
        for item in other:
            label = item.get("mode") or item.get("scene")
            if label and item["week"] == weeks[-1]:
                recent_types[str(label)] += 1
            elif label and item["week"] < weeks[-1]:
                previous_types[str(label)] += 1
            model = item.get("model")
            if model and item["week"] == weeks[-1]:
                recent_models[str(model)] += 1
            elif model and item["week"] < weeks[-1]:
                previous_models[str(model)] += 1
        result = {"weeks": counts, "model": recent_models.most_common(1)[0][0] if recent_models else None, "previousModel": previous_models.most_common(1)[0][0] if previous_models else None, "types": dict(recent_types), "previousTypes": dict(previous_types)}
        return result

    def is_pending(self, enterprise, record=None, snapshot=None, facts=None, settings=None):
        record = record or self.record(enterprise)
        facts = facts if facts is not None else self.facts(enterprise)["all"]
        settings = settings or self.store.settings()["pipeline"]
        if not facts or facts["totals"]["tasks"] < settings["profileMinTasks"]:
            return False
        if not record["generatedAt"]:
            return True
        if datetime.now(ZONE) - datetime.fromisoformat(record["generatedAt"]) > timedelta(days=settings["profileMaxAgeDays"]):
            return True
        snapshot = snapshot or self.snapshot(enterprise)
        old = record.get("snapshot") or {}
        if snapshot["annotations"] != old.get("annotations"):
            return True
        if snapshot == old:
            return False
        weeks = snapshot["weeks"]
        baseline = sum(weeks[:4]) / 4
        changed = (weeks[-1] > 0 if baseline == 0 else abs(weeks[-1] - baseline) / baseline > .5)
        model_changed = snapshot["model"] and snapshot["previousModel"] and snapshot["model"] != snapshot["previousModel"]
        new_type = any(count / weeks[-1] > .2 and key not in snapshot["previousTypes"] for key, count in snapshot["types"].items()) if weeks[-1] else False
        return bool(changed or model_changed or new_type or (weeks[-1] and not weeks[-2] and not weeks[-3]))

    def profile_state(self, enterprise, record, facts, running, settings, annotations=None):
        count = facts["totals"]["tasks"] if facts else 0
        snapshot = None
        if annotations is not None and record["generatedAt"]:
            snapshot = self.snapshot_stats(enterprise) | {"annotations": digest(json.dumps(annotations, ensure_ascii=False, sort_keys=True))}
        state = "facts_only" if count < settings["profileMinTasks"] else "none" if not record["version"] else "stale" if self.is_pending(enterprise, record, snapshot, facts, settings) else "ready"
        if running and running["job"]["state"] in ("queued", "running"):
            state = "generating"
        elif running and running["job"]["state"] == "failed" and not record["version"]:
            state = "failed"
        return state

    def profile_tags(self, record, facts):
        tags = [tag for tag in record["tags"] if tag["dimension"] != "rhythm"]
        if facts and "rhythm" not in record.get("manualTags", []):
            tags.append({"dimension": "rhythm", "value": {"continuous": "连续", "batch": "按批次", "occasional": "偶尔"}[facts["rhythm"]["kind"]], "source": "rule"})
        else:
            tags.extend(tag for tag in record["tags"] if tag["dimension"] == "rhythm")
        return tags

    def get(self, enterprise):
        entity = self.store.enterprise(enterprise)
        record = self.record(enterprise)
        facts = self.facts(enterprise)
        with self.store.connection() as conn:
            row = conn.execute("SELECT value FROM rework_objects WHERE kind='job' AND json_extract(value,'$.operation')='profile' AND json_extract(value,'$.payload.enterprise')=? ORDER BY rowid DESC LIMIT 1", (enterprise,)).fetchone()
        running = json.loads(row[0]) if row else None
        annotations = self.annotations(enterprise)
        state = self.profile_state(enterprise, record, facts["all"], running, self.store.settings()["pipeline"], annotations)
        tags = self.profile_tags(record, facts["all"])
        self.engine.refresh()
        frame = self.engine.frame.iloc[self.engine.enterprise_all_indices.get(enterprise, [])].tail(8)
        return {"enterprise": ref(entity), "adminPhone": entity["admin_phone"], "state": state, "version": record["version"], "generatedAt": record["generatedAt"], "headline": record["headline"], "insights": record["insights"], "tags": tags, "change": record["change"], "facts": facts, "samples": [self.engine.task(row) for _, row in frame.iterrows()], "annotations": annotations, "movements": self.repo.find("movement", enterprise=enterprise)}

    def pending(self, limit):
        if limit <= 0:
            return []
        with self.store.lock:
            self.engine.refresh()
            enterprises = list(self.engine.enterprises)
        with self.store.connection() as conn:
            initializing = conn.execute("SELECT 1 FROM rework_objects p JOIN rework_objects i ON i.kind='profile_init' AND i.id=p.id WHERE p.kind='pipeline' AND json_extract(p.value,'$.finishedAt') IS NULL LIMIT 1").fetchone() is not None
        active = set()
        if initializing:
            limit = min(limit, 10)
            instant = datetime.fromisoformat(now())
            for item in self.repo.find("job"):
                if item.get("operation") != "profile":
                    continue
                job = item["job"]
                waiting = job["state"] in ("queued", "running")
                cooling = job["state"] == "failed" and job["finishedAt"] and (instant - datetime.fromisoformat(job["finishedAt"])).total_seconds() < 600
                if waiting or cooling:
                    active.add(item.get("payload", {}).get("enterprise"))
        result = []
        for enterprise in enterprises:
            with self.store.lock:
                record = self.record(enterprise)
                if enterprise not in active and (not initializing or not record["version"]) and self.is_pending(enterprise, record):
                    result.append(enterprise)
                    if len(result) >= limit:
                        break
        return result

    def initialization_counts(self):
        with self.store.connection() as conn:
            row = conn.execute("""
                WITH eligible AS (
                    SELECT enterprise_id FROM tasks GROUP BY enterprise_id HAVING COUNT(*)>=?
                )
                SELECT COUNT(*) AS eligible,
                    COALESCE(SUM(COALESCE(json_extract(p.value,'$.version'),0)>0),0) AS completed
                FROM eligible e LEFT JOIN rework_objects p
                    ON p.kind='profile' AND p.enterprise_id=e.enterprise_id
            """, (self.store.settings()["pipeline"]["profileMinTasks"],)).fetchone()
        return {"eligible": row["eligible"], "completed": row["completed"], "remaining": row["eligible"] - row["completed"]}

    def initialize(self, limit=10):
        self.engine.refresh()
        items = []
        if limit <= 0:
            return items
        active = {item.get("payload", {}).get("enterprise") for item in self.repo.find("job") if item.get("operation") == "profile" and item["job"]["state"] in ("queued", "running")}
        for enterprise in self.engine.enterprises:
            if enterprise not in active and self.record(enterprise)["version"] == 0 and self.is_pending(enterprise):
                items.append(self.refresh(enterprise))
                if len(items) >= min(max(limit, 0), 10):
                    break
        return items

    def refresh(self, enterprise):
        self.store.enterprise(enterprise)
        facts = self.facts(enterprise)["all"]
        minimum = self.store.settings()["pipeline"]["profileMinTasks"]
        if not facts or facts["totals"]["tasks"] < minimum:
            raise ApiProblem(422, "insufficient_tasks", f"累计任务少于{minimum}个，无法生成判断层")
        for item in self.repo.find("job"):
            if item.get("operation") == "profile" and item.get("payload", {}).get("enterprise") == enterprise and item["job"]["state"] in ("queued", "running"):
                return item["job"]
        return self.context.jobs.submit("profiles", "profile", {"enterprise": enterprise})

    def roster(self, line, week):
        self.engine.refresh()
        revision = self.store.revisions()["facts_revision"]
        entity_key = tuple((key, item["kind"], item["contract"]) for key, item in self.engine.enterprises.items())
        key = (line, week, revision, entity_key)
        if key not in self.roster_ids_cache:
            self.roster_ids_cache = {item: value for item, value in self.roster_ids_cache.items() if item[2:] == key[2:]}
            self.roster_ids_cache[key] = [item["enterprise"]["id"] for item in customer_roster(self.engine, line, week)["rows"]]
        enterprises = self.roster_ids_cache[key]
        with self.store.connection() as conn:
            records = {}
            annotations_by_enterprise = defaultdict(list)
            jobs = {}
            movements = {}
            existing_notes = {row[0] for row in conn.execute("SELECT id FROM notes")}
            for row in conn.execute("SELECT kind,enterprise_id,value FROM rework_objects WHERE kind IN ('profile','annotation','movement') OR (kind='job' AND json_extract(value,'$.operation')='profile') ORDER BY rowid DESC"):
                item = json.loads(row["value"])
                kind = row["kind"]
                enterprise = row["enterprise_id"]
                if kind == "profile":
                    records[enterprise] = item
                elif kind == "annotation":
                    if not item["id"].startswith("note-") or item["id"][5:] in existing_notes:
                        annotations_by_enterprise[enterprise].append(item)
                elif kind == "job":
                    jobs.setdefault(item.get("payload", {}).get("enterprise"), item)
                elif item.get("line") == line and item.get("week") == week:
                    movements.setdefault(enterprise, item)
        settings = self.store.settings()["pipeline"]
        result = []
        for enterprise in enterprises:
            record = records.get(enterprise) or {"id": enterprise, "version": 0, "generatedAt": None, "headline": None, "insights": [], "tags": [], "manualTags": [], "change": None, "snapshot": None}
            facts = self.facts(enterprise)["all"]
            annotations = sorted(annotations_by_enterprise[enterprise], key=lambda item: item["updatedAt"], reverse=True)
            latest = annotations[0] if annotations else None
            movement = movements.get(enterprise)
            result.append({"enterpriseId": enterprise, "profileState": self.profile_state(enterprise, record, facts, jobs.get(enterprise), settings, annotations), "headline": record["headline"]["text"] if record["headline"] else None, "tags": self.profile_tags(record, facts), "annotationCount": len(annotations), "lastAnnotation": {"text": latest["entries"][-1]["text"].splitlines()[0], "at": latest["updatedAt"], "kind": latest["kind"]} if latest and latest["entries"] else None, "movement": {key: movement[key] for key in ("id", "direction", "headline", "state")} if movement else None})
        return result

    def analyze(self, job_id, payload):
        enterprise = payload["enterprise"]
        with self.store.lock:
            if self.repo.find("profile_applied", state=job_id):
                return
            profile = self.get(enterprise)
            snapshot = self.snapshot(enterprise)
            calculation_key = self.calculation_key(enterprise)
            frame = self.engine.frame.iloc[self.engine.enterprise_all_indices.get(enterprise, [])]
            with self.store.connection() as conn:
                other = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM tasks WHERE enterprise_id=? AND line='other'", (enterprise,))]
            if other:
                for item in other:
                    item["intent"] = None
                frame = pd.concat([frame, pd.DataFrame(other)], ignore_index=True)
            counts = frame.prompt[frame.prompt.fillna("") != ""].value_counts()
            prompts = [{"text": str(text), "count": int(count)} for text, count in counts.head(15).items()]
            catalog = {}
            for scope, facts in profile["facts"].items():
                if facts:
                    for name, value in facts["totals"].items():
                        catalog[f"{scope}.totals.{name}"] = {"label": name, "value": str(value) if value is not None else None, "target": {"page": "enterprise", "enterprise": enterprise, "tab": "profile", "section": "facts.core"}}
            candidates = frame[frame.inputs.map(bool) & frame.outputs.map(bool)].copy()
            annotations = defaultdict(list)
            for annotation in profile["annotations"]:
                block = (annotation.get("anchor") or {}).get("block", "")
                if block.startswith("record:"):
                    annotations[block.removeprefix("record:")].extend(entry["text"] for entry in annotation["entries"])
            candidates["annotated"] = candidates.row_key.isin(annotations)
            candidates["frequency"] = candidates.prompt.map(counts)
            candidates = candidates.sort_values(["annotated", "frequency", "created_at"], ascending=[False, False, False])
            readable = candidates.inputs.map(lambda urls: not urlsplit(urls[0]).path.lower().endswith((".mp4", ".mov", ".webm", ".m4v"))) & candidates.outputs.map(lambda urls: not urlsplit(urls[0]).path.lower().endswith((".mp4", ".mov", ".webm", ".m4v")))
            candidates = candidates[readable].copy()
            candidates["stratum"] = candidates.intent.fillna(candidates["mode"]).fillna(candidates.scene)
            candidates = candidates.groupby("stratum", sort=False, dropna=False).head(8)
            strata = defaultdict(list)
            for _, row in candidates.iterrows():
                strata[str(row.stratum)].append(row)
            selected = [row for values in strata.values() for row in values if row.row_key in annotations][:8]
            selected_keys = {row.row_key for row in selected}
            strata = {key: [row for row in values if row.row_key not in selected_keys] for key, values in strata.items()}
            strata = {key: values for key, values in strata.items() if values}
            while strata and len(selected) < 8:
                for key in list(strata):
                    selected.append(strata[key].pop(0))
                    if not strata[key]:
                        del strata[key]
                    if len(selected) == 8:
                        break
            if len(selected) < 8:
                raise ApiProblem(422, "insufficient_profile_images", "可读取的输入和输出图片少于八组，无法完成看图分析")
            representative = frame[frame.prompt.isin([item["text"] for item in prompts])].drop_duplicates("prompt")
            task_rows = {str(row.row_key): row for _, row in representative.iterrows()}
            task_rows.update({str(row.row_key): row for row in selected})
            task_rows.update({str(row.row_key): row for _, row in frame[frame.row_key.isin(annotations)].iterrows()})
            for key, row in task_rows.items():
                target = {"page": "enterprise", "enterprise": enterprise, "tab": "profile", "section": "facts.core"} if row.line == "other" else {"page": "enterprise", "enterprise": enterprise, "line": row.line, "tab": "tasks", "task": key}
                catalog[key] = {"label": ("其他任务（见事实统计）：" if row.line == "other" else "任务：") + str(row.scene), "value": str(row.prompt), "target": target}
            old = {key: profile[key] for key in ("headline", "insights", "tags", "change")}
            annotated_records = frame[frame.row_key.isin(annotations)]
            inputs = {"enterprise": profile["enterprise"], "facts": profile["facts"], "prompts": prompts, "images": [], "annotations": profile["annotations"], "annotatedRecords": [{"row_key": row.row_key, "prompt": row.prompt, "annotations": annotations[row.row_key]} for _, row in annotated_records.iterrows()], "previous": old, "evidenceCatalog": catalog}
        directory = self.store.directory / "work" / "profile" / digest(enterprise) / job_id
        directory.mkdir(parents=True, exist_ok=True)
        try:
            thumbnails = Thumbnails(directory)
            for index, row in enumerate(selected):
                paths = {}
                for name, url in (("input", row.inputs[0]), ("output", row.outputs[0])):
                    path = directory / f"{index}-{name}.webp"
                    path.write_bytes(thumbnails.get(url, 480))
                    paths[name] = str(path.resolve())
                inputs["images"].append({"row_key": row.row_key, "type": row.intent or row["mode"] or row.scene, **paths})
            try:
                result = self.context.model.run("profile", inputs, ProfileOutput, job_id)
            except Exception as error:
                self.context.model.discarded(job_id, [{"reason": "模型调用或输出结构校验失败", "error": str(error)}])
                raise
            known_numbers = set(re.findall(r"\d+(?:\.\d+)?%?", " ".join(str(entry["value"] or "") for entry in catalog.values())))
            discarded = []
            for field, text in (("headline", result.headline), ("change", result.change)):
                if text and set(re.findall(r"\d+(?:\.\d+)?%?", text)) - known_numbers:
                    discarded.append({"field": field, "value": text, "reason": "数字无法由事实目录核验"})
            insights = []
            for item in result.insights:
                if any(key not in catalog for key in item.evidenceIds):
                    discarded.append({"insight": item.model_dump(), "reason": "判断引用了不存在的证据"})
                    continue
                evidence = [catalog[key] for key in item.evidenceIds]
                numbers = set(re.findall(r"\d+(?:\.\d+)?%?", item.text))
                available = set(re.findall(r"\d+(?:\.\d+)?%?", " ".join(str(entry["value"] or "") for entry in evidence)))
                if numbers - available:
                    discarded.append({"insight": item.model_dump(), "reason": "判断中的数字无法由证据核验"})
                    continue
                insights.append({"id": uuid4().hex, "key": item.key, "text": item.text, "confidence": item.confidence, "evidence": evidence, "opportunityId": None})
            self.context.model.discarded(job_id, discarded)
            if any("field" in item for item in discarded):
                raise ApiProblem(422, "invalid_evidence", "摘要中的数字无法由事实目录核验")
            with self.store.lock, self.store.connection() as conn:
                if conn.execute("SELECT 1 FROM rework_objects WHERE kind='profile_applied' AND id=?", (job_id,)).fetchone():
                    return
                current = self.record(enterprise)
                if current["version"] != profile["version"] or self.calculation_key(enterprise) != calculation_key or self.snapshot(enterprise) != snapshot:
                    raise ApiProblem(409, "profile_input_changed", "分析期间档案、输入数据或批注发生变化，请重新生成")
                stamp = now()
                if current["version"]:
                    old_version = {"id": f"{enterprise}:{current['version']}", "enterprise": enterprise, "version": current["version"], "generatedAt": current["generatedAt"], "headline": current["headline"]["text"] if current["headline"] else None, "change": current["change"]}
                    self.repo.save("profile_version", old_version, enterprise=enterprise, conn=conn)
                tags = [tag for tag in current["tags"] if tag["dimension"] in current.get("manualTags", [])]
                for dimension, value in result.tags.model_dump().items():
                    if value and dimension not in current.get("manualTags", []):
                        tags.append({"dimension": dimension, "value": value, "source": "agent"})
                headline = current["headline"] if current["headline"] and current["headline"]["source"] == "manual" else {"text": result.headline, "source": "agent", "updatedAt": stamp} if result.headline else None
                current.update(version=current["version"] + 1, generatedAt=stamp, headline=headline, insights=insights, tags=tags, change=result.change, snapshot=snapshot)
                annotations = self.annotations(enterprise)
                for annotation in annotations:
                    anchor = annotation.get("anchor")
                    if anchor and anchor.get("insightId"):
                        original = next((item for item in old["insights"] if item["id"] == anchor["insightId"]), None)
                        matching = next((item for item in insights if original and item["key"] == original["key"] and item["text"] == original["text"]), None)
                        if matching:
                            anchor["insightId"] = matching["id"]
                            anchor["stale"] = False
                        else:
                            anchor["stale"] = True
                        self.repo.save("annotation", annotation, conn=conn)
                current["snapshot"] = self.snapshot_stats(enterprise) | {"annotations": digest(json.dumps(annotations, ensure_ascii=False, sort_keys=True))}
                self.repo.save("profile", current, enterprise=enterprise, conn=conn)
                self.repo.save("profile_applied", {"id": job_id, "enterprise": enterprise}, state=job_id, conn=conn)
        finally:
            shutil.rmtree(directory)


def mount(app: FastAPI, context):
    profiles = context.profiles

    @app.get("/api/profiles/roster")
    def roster(line: Line, week: str):
        with context.store.lock:
            return profiles.roster(line, validate_week(week))

    @app.get("/api/profiles")
    def profiles_by_ids(ids: str):
        with context.store.lock:
            return [profiles.get(key) for key in ids.split(",") if key]

    @app.get("/api/tags")
    def tags(line: Line | None = None):
        with context.store.lock:
            profiles.engine.refresh()
            ids = profiles.engine.frame.loc[profiles.engine.frame.line == line, "enterprise_id"].unique() if line else profiles.engine.enterprises
            records = {item["id"]: item for item in profiles.repo.find("profile")}
            counts = Counter((tag["dimension"], tag["value"]) for key in ids for tag in profiles.profile_tags(records.get(key) or {"tags": []}, profiles.facts(key)["all"]))
            return [{"dimension": dimension, "values": [{"value": value, "count": counts[dimension, value]} for value in values]} for dimension, values in OPTIONS.items()]

    @app.get("/api/profiles/{key}/versions")
    def versions(key: str):
        context.store.enterprise(key)
        items = profiles.repo.find("profile_version", enterprise=key)
        record = profiles.record(key)
        if record["version"]:
            items.append({"version": record["version"], "generatedAt": record["generatedAt"], "headline": record["headline"]["text"] if record["headline"] else None, "change": record["change"]})
        return [{field: item[field] for field in ("version", "generatedAt", "headline", "change")} for item in sorted(items, key=lambda item: item["version"], reverse=True)]

    @app.post("/api/profiles/{key}/refresh")
    def refresh(key: str):
        with context.store.lock:
            return profiles.refresh(key)

    @app.put("/api/profiles/{key}/tags")
    def set_tag(key: str, body: TagInput):
        with context.store.lock:
            context.store.enterprise(key)
            if body.value is not None and body.value not in OPTIONS[body.dimension]:
                raise ApiProblem(422, "invalid_tag", "标签不在固定选项内")
            record = profiles.record(key)
            record["tags"] = [tag for tag in record["tags"] if tag["dimension"] != body.dimension]
            if body.value is not None:
                record["tags"].append({"dimension": body.dimension, "value": body.value, "source": "manual"})
            record["manualTags"] = sorted(set(record.get("manualTags", [])) | {body.dimension})
            profiles.repo.save("profile", record, enterprise=key)
            return profiles.get(key)

    @app.put("/api/profiles/{key}/headline")
    def set_headline(key: str, body: Text):
        with context.store.lock:
            context.store.enterprise(key)
            if len(body.text) > 30:
                raise ApiProblem(422, "invalid_headline", "一句话不能超过30字")
            record = profiles.record(key)
            record["headline"] = {"text": body.text, "source": "manual", "updatedAt": now()}
            profiles.repo.save("profile", record, enterprise=key)
            return profiles.get(key)

    @app.get("/api/profiles/{key}")
    def get_profile(key: str):
        with context.store.lock:
            return profiles.get(key)

    @app.get("/api/annotations")
    @context.cache.cached
    def get_annotations(enterprise: str | None = None, from_: str | None = Query(None, alias="from"), to: str | None = None, resolved: bool | None = None):
        return profiles.annotations(enterprise, from_, to, resolved)

    @app.post("/api/annotations")
    def create_annotation(body: AnnotationInput):
        with context.store.lock:
            return profiles.add_annotation(body.enterprise, body.text, body.kind, body.anchor.model_dump() if body.anchor else None)

    @app.post("/api/annotations/{key}/entries")
    def add_entry(key: str, body: Text):
        with context.store.lock:
            item = profiles.repo.get("annotation", key)
            stamp = now()
            item["entries"].append({"id": uuid4().hex, "text": body.text, "createdAt": stamp, "editedAt": None})
            item["updatedAt"] = stamp
            profiles.repo.save("annotation", item)
            return item

    @app.patch("/api/annotations/{key}")
    def edit_annotation(key: str, body: AnnotationPatch):
        with context.store.lock:
            item = profiles.repo.get("annotation", key)
            changes = body.model_dump(exclude_unset=True)
            if "resolved" in changes and changes["resolved"] is None:
                raise ApiProblem(422, "invalid_annotation", "处理状态不能为空")
            item.update(changes, updatedAt=now())
            profiles.repo.save("annotation", item)
            return item

    @app.patch("/api/annotations/{key}/entries/{entry_id}")
    def edit_entry(key: str, entry_id: str, body: Text):
        with context.store.lock:
            item = profiles.repo.get("annotation", key)
            entry = next((entry for entry in item["entries"] if entry["id"] == entry_id), None)
            if entry is None:
                raise ApiProblem(404, "not_found", "批注内容不存在")
            entry.update(text=body.text, editedAt=now())
            item["updatedAt"] = entry["editedAt"]
            profiles.repo.save("annotation", item)
            return item

    @app.delete("/api/annotations/{key}")
    def delete_annotation(key: str):
        with context.store.lock, context.store.connection() as conn:
            profiles.repo.get("annotation", key)
            profiles.repo.delete("annotation", key, conn=conn)
            if key.startswith("note-"):
                conn.execute("DELETE FROM notes WHERE id=?", (key[5:],))

    @app.delete("/api/annotations/{key}/entries/{entry_id}")
    def delete_entry(key: str, entry_id: str):
        with context.store.lock:
            item = profiles.repo.get("annotation", key)
            if not any(entry["id"] == entry_id for entry in item["entries"]):
                raise ApiProblem(404, "not_found", "批注内容不存在")
            item["entries"] = [entry for entry in item["entries"] if entry["id"] != entry_id]
            item["updatedAt"] = now()
            profiles.repo.save("annotation", item)
            return item
