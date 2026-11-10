from uuid import uuid4

import httpx

from .core import ApiProblem, digest, dump, now
from .engine import ref
from .fd_client import FDClient
from .workflow import link_for


def public(item):
    return {key: value for key, value in item.items() if not key.startswith("_")}


def draft_signature(item):
    return digest(dump({key: item[key] for key in ("title", "prompt", "slots", "scope", "sourceEnterprises", "fdTemplateId", "fdTemplateSource")}))


class Pushes:
    def __init__(self, workflow):
        self.workflow = workflow
        self.store = workflow.store
        self.engine = workflow.engine
        self.client = FDClient(self.store.directory)

    def publish(self, key, body):
        item = self.store.item("drafts", key)
        if item["line"] != "inspiration":
            raise ApiProblem(409, "unsupported_fd_template", "当前 FD 模板分享接口仅支持灵感成款")
        if item["fdTemplateId"]:
            return next(value for value in self.workflow.drafts() if value["id"] == key)
        marker = f"publication:{key}:{digest(dump([item['title'], item['prompt'], item['slots'], body.model_dump()]))}"
        with self.store.connection() as conn:
            state = conn.execute("SELECT value FROM metadata WHERE key=?", (marker,)).fetchone()
            if state:
                raise ApiProblem(409, "publication_uncertain", "该草稿已有创建记录，需要在 FD 核对后回填真实模板 ID")
        if len(item["slots"]) > 5:
            raise ApiProblem(422, "too_many_slots", "FD 团队模板最多支持五张输入图片")
        self.client.credentials()
        with self.store.connection() as conn:
            conn.execute("INSERT INTO metadata VALUES (?,?)", (marker, "creating"))
        template_id = self.client.request("POST", "/clothing-ai/chatting-template-manage/create", {
            "title": item["title"]["text"], "sceneId": body.sceneId, "inputImageCount": len(item["slots"]),
            "templateImg": body.templateImg, "model": body.model, "promptContent": item["prompt"]["text"]})
        if not isinstance(template_id, int) or isinstance(template_id, bool) or template_id < 1:
            raise ApiProblem(502, "publication_uncertain", "创建结果没有真实模板 ID，需要在 FD 核对")
        item.update(fdTemplateId=template_id, fdTemplateSource="managed", status="published", link=link_for(self.store.settings(), template_id, "managed"))
        with self.store.connection() as conn:
            self.store.save("drafts", item, conn)
            conn.execute("UPDATE metadata SET value=? WHERE key=?", (dump({"state": "published", "templateId": template_id}), marker))
        return public(item)

    def preview(self, key, body):
        draft = self.store.item("drafts", key)
        if draft["line"] != "inspiration":
            raise ApiProblem(409, "unsupported_fd_template", "当前 FD 模板分享接口仅支持灵感成款")
        if body.touchId:
            touch = self.store.item("touches", body.touchId)
            if touch["line"] != draft["line"] or touch["enterprise"]["id"] not in body.enterprises:
                raise ApiProblem(409, "invalid_touch", "触达卡片与推送范围不一致")
        allowed = {item["id"] for item in draft["sourceEnterprises"]}
        blocked, enterprises = [], []
        for eid in dict.fromkeys(body.enterprises):
            enterprise = self.store.enterprise(eid)
            if draft["scope"] == "owner" and eid not in allowed:
                blocked.append({"enterprise": ref(enterprise), "reason": "该模板仅允许用于来源企业"})
            else:
                enterprises.append(enterprise)
        item = {"id": uuid4().hex, "draftId": key, "touchId": body.touchId, "state": "preview", "notify": body.notify,
            "receivers": [], "blocked": blocked, "fdTemplateId": draft["fdTemplateId"], "batchId": None, "result": None,
            "createdAt": now(), "confirmedAt": None, "finishedAt": None, "_signature": draft_signature(draft), "_targets": {}, "_selected": []}
        if enterprises:
            if not draft["fdTemplateId"] or draft["fdTemplateSource"] != "managed":
                raise ApiProblem(409, "managed_template_required", "请先通过草稿发布接口创建自己的 FD 团队模板，再查询分享候选")
            account = self.client.check()
            if not account["externalShareAllowed"]:
                raise ApiProblem(403, "external_share_denied", "当前 FD 账号没有外部分享权限")
            self.engine.refresh()
            for enterprise in enterprises:
                phones = set(self.engine.frame.loc[self.engine.frame.enterprise_id == enterprise["id"], "user_phone"].dropna()) | {enterprise["admin_phone"]}
                found = {}
                for phone in sorted(phones):
                    result = self.client.request("POST", "/clothing-ai/chatting-template-manage/share/candidates/page", {
                        "templateIds": [draft["fdTemplateId"]], "scope": "EXTERNAL", "keyword": phone, "pageNo": 1, "pageSize": 200})
                    for candidate in result["resultList"]:
                        if candidate.get("teamName", "").strip() != enterprise["name"].strip() or not candidate.get("teamId") or not candidate.get("userId"):
                            continue
                        uid = candidate["userId"]
                        target = {"receiverUserId": uid, "receiverTeamId": candidate["teamId"]}
                        if str(uid) in item["_targets"] and item["_targets"][str(uid)] != target:
                            raise ApiProblem(409, "ambiguous_membership", "同一成员属于多个目标团队，需要分别创建推送")
                        item["_targets"][str(uid)] = target
                        found[uid] = {"enterprise": ref(enterprise), "fdUserId": uid, "userName": candidate.get("userName") or "",
                            "maskedPhone": candidate.get("maskedPhone") or "", "selectable": candidate.get("selectable") is True,
                            "disabledReason": candidate.get("disabledReason"), "missingModels": candidate.get("missingModels") or []}
                if not found:
                    item["blocked"].append({"enterprise": ref(enterprise), "reason": "未找到可以确认属于该企业的分享候选"})
                item["receivers"].extend(found.values())
        self.store.save("pushes", item)
        return public(item)

    def confirm(self, key, receivers):
        item = self.store.item("pushes", key)
        if item["state"] != "preview":
            return public(item), False
        draft = self.store.item("drafts", item["draftId"])
        if draft_signature(draft) != item["_signature"]:
            raise ApiProblem(409, "preview_expired", "草稿已经修改，请重新生成推送预览")
        selected = list(dict.fromkeys(receivers))
        available = {receiver["fdUserId"] for receiver in item["receivers"] if receiver["selectable"]}
        if not set(selected) <= available:
            raise ApiProblem(422, "invalid_receivers", "只能选择预览中允许分享的成员")
        used = sum(len(push.get("_selected", [])) for push in self.store.items("pushes") if (push.get("confirmedAt") or "").startswith(now()[:10]))
        if used + len(selected) > self.store.settings()["pushDailyLimit"]:
            raise ApiProblem(409, "push_daily_limit", "当天接收成员数量超过上限")
        self.client.credentials()
        item.update(state="confirmed", confirmedAt=now(), _selected=selected)
        self.store.save("pushes", item)
        return public(item), True

    def execute(self, key):
        with self.store.lock:
            item = self.store.item("pushes", key)
            if item["state"] != "confirmed":
                return
            item["state"] = "sharing"
            self.store.save("pushes", item)
        try:
            result = self.client.request("POST", "/clothing-ai/chatting-template-manage/share", {
                "clientRequestId": item["id"], "templateIds": [item["fdTemplateId"]], "receiverUserIds": item["_selected"],
                "receiverTargets": [item["_targets"][str(uid)] for uid in item["_selected"]], "notifyEnabled": item["notify"]})
            if not result.get("batchId"):
                raise ApiProblem(502, "invalid_fd_result", "FD 没有返回分享批次 ID")
            item["batchId"] = str(result["batchId"])
            self.apply_result(item, result)
        except (httpx.HTTPError, ApiProblem, ValueError, KeyError, TypeError):
            item["state"] = "uncertain"
        with self.store.lock:
            self.store.save("pushes", item)

    def apply_result(self, item, result):
        item["result"] = {"success": int(result["successCount"]), "failed": int(result["failedCount"]), "pending": int(result["pendingCount"]),
            "failures": [{"fdUserId": receiver["receiverUserId"], "code": failure.get("failureCode"), "message": failure.get("failureMessage")}
                for receiver in result["receiverResults"] for failure in receiver.get("failures") or []]}
        summary = item["result"]
        item["state"] = "sharing" if summary["pending"] else "partial" if summary["failed"] and summary["success"] else "failed" if summary["failed"] else "done"
        if not summary["pending"]:
            item["finishedAt"] = now()
        successful = {receiver["receiverUserId"] for receiver in result["receiverResults"] if receiver.get("successCount", 0) > 0}
        if successful:
            with self.store.lock:
                draft = self.store.item("drafts", item["draftId"])
                enterprises = {value["id"]: value for value in draft["pushedTo"]}
                enterprises.update({receiver["enterprise"]["id"]: receiver["enterprise"] for receiver in item["receivers"] if receiver["fdUserId"] in successful})
                draft.update(pushedTo=list(enterprises.values()), status="pushed")
                self.store.save("drafts", draft)
                if item["touchId"]:
                    touch = self.store.item("touches", item["touchId"])
                    if touch["enterprise"]["id"] in enterprises:
                        touch["offer"] = {"kind": "template", "draftId": draft["id"], "rerunId": None, "link": link_for(self.store.settings()), "text": draft["title"]["text"]}
                        self.store.save("touches", touch)

    def get(self, key):
        item = self.store.item("pushes", key)
        if item["batchId"] and item["state"] in ("sharing", "uncertain"):
            result = self.client.request("GET", "/clothing-ai/chatting-template-manage/share/result/" + item["batchId"])
            self.apply_result(item, result)
            self.store.save("pushes", item)
        return public(item)

    def cancel(self, key):
        item = self.store.item("pushes", key)
        if item["state"] == "preview":
            item.update(state="cancelled", finishedAt=now())
            self.store.save("pushes", item)
        elif item["state"] != "cancelled":
            raise ApiProblem(409, "push_already_confirmed", "已经确认的推送不能取消")
        return public(item)
