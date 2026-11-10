import io
import json
from datetime import datetime
from statistics import median
from urllib.parse import urlencode, urlsplit
from uuid import uuid4
from zipfile import BadZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.utils.exceptions import InvalidFileException

from .analysis import cluster_indices, conversion
from .core import ZONE, ApiProblem, digest, now, shift_week, validate_week, week_key
from .engine import rate, ref

SLOTS = ("mon", "wed", "fri")
HEADERS = ["企业", "超管手机号", "联系人", "负责人", "目的", "依据", "带去的东西", "模板链接", "话术", "渠道", "状态", "客户回复", "日期", "卡片ID"]


def authored(text, source):
    return {"text": text, "source": source, "updatedAt": now()}


def protected(current, source):
    if current["source"] == "manual" and source != "manual":
        raise ApiProblem(409, "manual_locked", "手工内容受到保护", current=current)


def link_for(settings, template_id=None, source=None):
    base = settings["siteBaseUrl"].rstrip("/")
    if not base.endswith("/plus-fd"):
        base += "/plus-fd"
    result = base + "/workbench/chatting-image/inspiration"
    if template_id:
        query = {"templateId": template_id}
        if source in ("managed", "shared"):
            query["templateSource"] = source
        result += "?" + urlencode(query)
    return result


class Workflow:
    def __init__(self, engine):
        self.engine = engine
        self.store = engine.store
        self.outcome_contexts = {}

    def drafts(self, line=None):
        items = self.store.items("drafts")
        for item in items:
            item["link"] = link_for(self.store.settings(), item["fdTemplateId"], item["fdTemplateSource"]) if item["fdTemplateId"] else None
            item["pushes"] = [{key: value for key, value in push.items() if not key.startswith("_")} for push in self.store.items("pushes") if push["draftId"] == item["id"]]
        return [item for item in items if line is None or item["line"] == line]

    def create_draft(self, body, *, conn=None):
        self.engine.refresh()
        owners = []
        if body.clusterId:
            indices = cluster_indices(self.engine, body.line, body.clusterId)
            owners = [ref(self.engine.enterprises[eid]) for eid in sorted(set(self.engine.frame.loc[indices].enterprise_id))]
        scope = body.scope or ("owner" if owners else "general")
        if scope == "owner" and not owners:
            raise ApiProblem(422, "source_enterprises_required", "仅来源企业的草稿需要提供真实提示词簇")
        if owners and scope == "general" and body.source != "manual":
            raise ApiProblem(409, "manual_scope_required", "通用范围需要手工确认")
        item = {"id": uuid4().hex, "line": body.line, "title": authored(body.title, body.source), "prompt": authored(body.prompt, body.source),
            "slots": body.slots, "scene": body.scene, "clusterId": body.clusterId, "status": "draft", "scope": scope,
            "sourceEnterprises": owners, "fdTemplateId": None, "fdTemplateSource": None, "link": None, "pushedTo": [], "pushes": [], "createdAt": now()}
        self.store.save("drafts", item, conn)
        return item

    def patch_draft(self, key, body):
        item = self.store.item("drafts", key)
        changes = body.model_dump(exclude_unset=True, exclude={"source"})
        content_changed = any(field in changes and changes[field] != (item[field]["text"] if field in ("title", "prompt") else item[field]) for field in ("title", "prompt", "slots"))
        if changes.get("scope") == "general" and item["scope"] == "owner" and body.source != "manual":
            raise ApiProblem(409, "manual_scope_required", "通用范围需要手工确认")
        for field in ("title", "prompt"):
            if field in changes:
                protected(item[field], body.source)
                changes[field] = authored(changes[field], body.source)
        if "pushedTo" in changes:
            changes["pushedTo"] = [ref(self.store.enterprise(eid)) for eid in dict.fromkeys(changes["pushedTo"])]
        if content_changed and item["fdTemplateId"] and "fdTemplateId" not in changes:
            changes.update(fdTemplateId=None, fdTemplateSource=None, link=None, status="draft", pushedTo=[])
        item.update(changes)
        if bool(item["fdTemplateId"]) != bool(item["fdTemplateSource"]):
            raise ApiProblem(422, "template_source_required", "模板 ID 和来源必须一起填写或清空")
        if item["status"] in ("published", "pushed") and not item["fdTemplateId"]:
            raise ApiProblem(422, "template_required", "上线或推送状态需要真实模板 ID")
        item["link"] = link_for(self.store.settings(), item["fdTemplateId"], item["fdTemplateSource"]) if item["fdTemplateId"] else None
        self.store.save("drafts", item)
        return next(value for value in self.drafts() if value["id"] == key)

    def validate_offer(self, offer, enterprise_id, line):
        if offer["link"] and (urlsplit(offer["link"]).scheme not in ("https", "http") or not urlsplit(offer["link"]).netloc):
            raise ApiProblem(422, "invalid_link", "链接必须是完整的 HTTP 地址")
        if offer["draftId"]:
            draft = self.store.item("drafts", offer["draftId"])
            if draft["line"] != line or (draft["scope"] == "owner" and enterprise_id not in {item["id"] for item in draft["sourceEnterprises"]}):
                raise ApiProblem(409, "owner_scope", "该模板不允许用于所选企业")
        if offer["rerunId"]:
            rerun = self.store.item("reruns", offer["rerunId"])
            if rerun["enterprise"]["id"] != enterprise_id or rerun["sourceTask"]["line"] != line:
                raise ApiProblem(409, "owner_scope", "重跑结果仅允许用于来源企业")

    def create_touch(self, body, *, key=None, suggested=False, conn=None):
        enterprise = self.store.enterprise(body.enterprise)
        validate_week(body.week)
        offer = body.offer.model_dump() if body.offer else {"kind": "question", "draftId": None, "rerunId": None, "link": None, "text": None}
        self.validate_offer(offer, body.enterprise, body.line)
        item = {"id": key or uuid4().hex, "line": body.line, "week": body.week, "slot": body.slot, "enterprise": ref(enterprise),
            "goal": body.goal, "evidence": body.evidence, "offer": offer, "draft": authored(body.draft, body.source), "owner": body.owner,
            "channel": None, "status": "draft", "suggested": suggested, "sentAt": None, "reply": None, "outcome": None}
        self.store.save("touches", item, conn)
        return item

    def patch_touch(self, key, body):
        item = self.store.item("touches", key)
        changes = body.model_dump(exclude_unset=True, exclude={"source"})
        if "draft" in changes:
            protected(item["draft"], body.source)
            changes["draft"] = authored(changes["draft"], body.source)
        if "offer" in changes:
            self.validate_offer(changes["offer"], item["enterprise"]["id"], item["line"])
        if changes.get("suggested") is True:
            raise ApiProblem(409, "suggestion_protected", "已经处理的卡片不能重新设为建议")
        item.update(changes)
        item["suggested"] = False
        if item["status"] in ("sent", "replied") and item["sentAt"] is None:
            item["sentAt"] = now()
        self.store.save("touches", item)
        return self.with_outcome(item)

    def suggestions(self, line, week):
        from .models import TouchCreate
        latest = next((item["id"] for item in self.store.import_jobs() if item["state"] == "done"), "empty")
        marker = f"suggestions:{line}:{week}"
        signature = digest(latest + json.dumps(self.store.settings(), sort_keys=True))
        with self.store.connection() as conn:
            previous = conn.execute("SELECT value FROM metadata WHERE key=?", (marker,)).fetchone()
        if previous and previous[0] == signature:
            return
        rows = self.roster(line, week)
        existing = {item["id"]: item for item in self.store.items("touches")}
        generated = set()
        with self.store.connection() as conn:
            for row in rows:
                if row["pool"] not in ("retain", "recall", "help", "nurture", "convert") or row["excluded"]:
                    continue
                eid = row["enterprise"]["id"]
                key = digest(f"suggestion|{line}|{week}|{eid}")
                generated.add(key)
                if key in existing and (not existing[key]["suggested"] or existing[key]["draft"]["source"] != "rule"):
                    continue
                evidence = [f"本周任务 {row['tasks']} 个，使用 {row['activeDays']} 天"]
                if row["pool"] == "convert":
                    evidence = [f"其他场景 {scene['scene']} 已使用 {scene['tasks']} 个任务" for scene in row["scenes"][:3]]
                if row["comparable"]:
                    evidence.append(f"同星期用量 {row['comparable']['previous']} → {row['comparable']['current']}")
                if row["downloadRate"] is not None:
                    evidence.append(f"下载率 {row['downloadRate']:.1%}")
                action = row["nextAction"]["text"] if row["nextAction"] else "结合现有任务介绍该产品线的用法"
                self.create_touch(TouchCreate(line=line, week=week, slot="fri" if row["pool"] in ("recall", "convert") else "mon" if row["pool"] == "retain" else "wed",
                    enterprise=eid, goal=row["pool"], evidence=evidence, draft=action, owner=row["owner"]["afterSales"] or row["owner"]["sales"], source="rule"),
                    key=key, suggested=True, conn=conn)
            for key, item in existing.items():
                if item["line"] == line and item["week"] == week and item["suggested"] and item["draft"]["source"] == "rule" and key not in generated:
                    conn.execute("DELETE FROM touches WHERE id=?", (key,))
            conn.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (marker, signature))

    def with_outcome(self, item):
        item = dict(item)
        self.engine.refresh()
        week, line, eid = week_key(item["sentAt"]) if item["sentAt"] else item["week"], item["line"], item["enterprise"]["id"]
        following = shift_week(week, 1)
        if item["sentAt"] is None or not self.engine.coverage(line, following)["complete"] or not self.engine.coverage(line, week)["complete"]:
            item["outcome"] = None
            return item
        previous = self.engine.group(line, week, eid)
        current = self.engine.group(line, following, eid)
        touched = {touch["enterprise"]["id"] for touch in self.store.items("touches") if touch["line"] == line and touch["sentAt"] and week_key(touch["sentAt"]) == week}
        signature = (self.engine.version, tuple(sorted(touched)))
        key = (line, week)
        context = self.outcome_contexts.get(key)
        if context is None or context["signature"] != signature:
            baseline = self.roster(line, week)
            context = {"signature": signature, "pools": {row["enterprise"]["id"]: row["pool"] for row in baseline}, "controls": {}}
            for row in baseline:
                other = row["enterprise"]["id"]
                if other not in touched and not row["excluded"]:
                    change = len(self.engine.group(line, following, other)) - len(self.engine.group(line, week, other))
                    context["controls"].setdefault(row["pool"], []).append((other, change))
            self.outcome_contexts[key] = context
        pool = context["pools"].get(eid, item["goal"])
        changes = [change for other, change in context["controls"].get(pool, []) if other != eid]
        item["outcome"] = {"week": following, "tasks": {"current": len(current), "previous": len(previous)},
            "downloadRate": {"current": rate(current) if len(current) else None, "previous": rate(previous) if len(previous) else None},
            "templateUsed": None, "control": {"enterprises": len(changes), "medianTaskChange": float(median(changes))} if changes else None}
        return item

    def touches(self, line=None, week=None, enterprise=None):
        return [self.with_outcome(item) for item in self.store.items("touches") if (line is None or item["line"] == line) and (week is None or item["week"] == week) and (enterprise is None or item["enterprise"]["id"] == enterprise)]

    def board(self, line, week):
        self.suggestions(line, week)
        items = self.touches(line, week)
        return {"line": line, "week": week, "suggestions": [item for item in items if item["suggested"]],
            "slots": {slot: [item for item in items if not item["suggested"] and item["slot"] == slot] for slot in SLOTS}}

    def export_touches(self, line, week, owner=None):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "触达清单"
        sheet.append(HEADERS)
        for item in self.touches(line, week):
            if item["suggested"] or (owner is not None and item["owner"] != owner):
                continue
            enterprise = self.store.enterprise(item["enterprise"]["id"])
            group = self.engine.group(line, week, enterprise["id"])
            names = group[group.user_phone == enterprise["admin_phone"]].user_name
            sheet.append([enterprise["name"], enterprise["admin_phone"], str(names.iloc[-1]) if len(names) else None,
                item["owner"], item["goal"], "；".join(item["evidence"]), item["offer"]["text"], item["offer"]["link"], item["draft"]["text"], item["channel"], None, None, None, item["id"]])
            for cell in sheet[sheet.max_row]:
                if isinstance(cell.value, str):
                    cell.data_type = "s"
        sheet.column_dimensions["N"].hidden = True
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        output = io.BytesIO()
        workbook.save(output)
        workbook.close()
        return output.getvalue()

    def import_touches(self, content):
        try:
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
        except (BadZipFile, InvalidFileException, ValueError):
            raise ApiProblem(422, "invalid_touch_sheet", "文件不是有效的触达 Excel 清单") from None
        sheet = workbook.active
        rows = sheet.iter_rows(values_only=False)
        header = next(rows, None)
        if header is None or [cell.value for cell in header] != HEADERS:
            workbook.close()
            raise ApiProblem(422, "invalid_touch_sheet", "表格列与触达清单不一致")
        known = {item["id"]: item for item in self.store.items("touches")}
        pending, errors, seen = [], [], set()
        skipped = 0
        states = {"已发送": "sent", "已回复": "replied", "无回应": "sent", "sent": "sent", "replied": "replied"}
        for number, cells in enumerate(rows, 2):
            values = [cell.value for cell in cells]
            key = values[13]
            if key not in known:
                skipped += 1
                continue
            if key in seen:
                errors.append(f"第 {number} 行卡片 ID 重复")
                continue
            seen.add(key)
            if any(cell.data_type == "f" for cell in cells):
                errors.append(f"第 {number} 行包含公式")
                continue
            status, reply, sent_at = values[10:13]
            if status is None and reply is None and sent_at is None:
                continue
            if status not in states or sent_at is None or (reply is not None and not isinstance(reply, str)):
                errors.append(f"第 {number} 行的状态、回复或日期无效")
                continue
            if isinstance(sent_at, datetime):
                parsed = sent_at
            else:
                try:
                    parsed = datetime.fromisoformat(str(sent_at))
                except ValueError:
                    errors.append(f"第 {number} 行的日期格式无效")
                    continue
            timestamp = parsed.replace(tzinfo=ZONE) if parsed.tzinfo is None else parsed.astimezone(ZONE)
            if timestamp > datetime.now(ZONE):
                errors.append(f"第 {number} 行的发送日期晚于当前时间")
                continue
            pending.append({**known[key], "status": states[status], "reply": reply, "sentAt": timestamp.isoformat(timespec="seconds"), "suggested": False})
        workbook.close()
        if errors:
            return {"updated": 0, "skipped": skipped, "errors": errors}
        with self.store.connection() as conn:
            for item in pending:
                self.store.save("touches", item, conn)
        return {"updated": len(pending), "skipped": skipped, "errors": []}

    def roster(self, line, week):
        rows = [dict(item) for item in self.engine.base_roster(line, week)]
        known = {item["enterprise"]["id"] for item in rows}
        for candidate in conversion(self.engine, line, week):
            if candidate["enterprise"]["id"] in known:
                continue
            rows.append({**candidate, "excluded": False, "level": None, "movement": "new", "pool": "convert", "tasks": 0, "points": 0,
                "activeDays": 0, "users": 0, "comparable": None, "downloadRate": None, "downloadSignalReliable": True, "weeksActive": 0,
                "spark": [self.engine.week_point(line, shift_week(week, offset), candidate["enterprise"]["id"]) for offset in range(-11, 1)],
                "alerts": [], "nextAction": None, "lastTouch": None, "inspiration": None, "video": None})
        touches = self.store.items("touches")
        for row in rows:
            matches = [item for item in touches if item["line"] == line and item["week"] <= week and item["enterprise"]["id"] == row["enterprise"]["id"] and not item["suggested"]]
            latest = max(matches, key=lambda item: (item["week"], item["sentAt"] or "", SLOTS.index(item["slot"])), default=None)
            row["lastTouch"] = {key: latest[key] for key in ("id", "week", "slot", "status")} if latest else None
        return rows
