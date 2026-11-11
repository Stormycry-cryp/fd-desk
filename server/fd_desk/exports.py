import io
import re
from typing import Literal
from urllib.parse import quote
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from openpyxl import Workbook
from pydantic import BaseModel, ConfigDict, Field

from . import analysis, views
from .core import LINES, ApiProblem, dump, now, validate_week

KINDS = ("roster", "annotations", "movements", "templates_official", "templates_custom", "opportunities", "monitor", "followups", "analysis_matrix", "analysis_failures", "tasks", "records")
ExportKind = Literal["roster", "annotations", "movements", "templates_official", "templates_custom", "opportunities", "monitor", "followups", "analysis_matrix", "analysis_failures", "tasks", "records"]
MAX_BUNDLE_BYTES = 250 * 1024 * 1024


class ExportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: ExportKind
    params: dict[str, str] = Field(default_factory=dict, max_length=30)


class BundleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ExportItem] = Field(min_length=1, max_length=22)


def spreadsheet(title, columns, rows):
    book = Workbook()
    sheet = book.active
    sheet.title = title[:31]
    sheet.append(columns)
    for values in rows:
        sheet.append([dump(value) if isinstance(value, (dict, list)) else value for value in values])
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    output = io.BytesIO()
    book.save(output)
    book.close()
    return output.getvalue()


def clean(value):
    text = dump(value) if isinstance(value, (dict, list)) else str(value) if value is not None else ""
    return re.sub(r"https?://[^\s<>\[\]{}\"']+", "", text)


class Exports:
    def __init__(self, context):
        self.context = context
        self.store = context.store
        self.repo = context.repo
        context.jobs.register("export_bundle", self.bundle)

    def options(self, params):
        line = params.get("line", "inspiration")
        if line not in LINES:
            raise ApiProblem(422, "invalid_line", "产品线参数无效")
        week = params.get("week")
        if week is None:
            week = views.meta(self.context.engine)["latestWeek"][line]
        if week is None:
            raise ApiProblem(404, "no_data", "当前产品线没有可导出的数据")
        return line, validate_week(week)

    def selected(self, values, params, key="id"):
        if "ids" not in params:
            return values
        ids = set(filter(None, params["ids"].split(",")))
        available = {item[key] for item in values}
        if not ids or not ids <= available:
            raise ApiProblem(422, "invalid_export_selection", "导出选择包含当前范围以外的记录")
        return [item for item in values if item[key] in ids]

    def render(self, kind, params):
        context = self.context
        if kind == "records":
            return context.records.render_export(params), []
        line, week = self.options(params)
        enterprise = params.get("enterprise")
        exports = []
        rows = []
        if kind == "roster":
            columns = ["企业编号", "企业名称", "层级", "变动", "所属池", "任务数", "耗点", "使用天数", "下载率", "标签", "档案摘要", "最近批注", "批注时间", "自由改款本周任务", "自由改款活跃天数", "自由改款下载率", "自由改款近四个完整周任务", "自由改款累计任务", "自由改款主要任务", "转化建议"]
            values = views.roster(context.engine, line, week)["rows"]
            values = [{**item, "id": item["enterprise"]["id"]} for item in values]
            values = self.selected(values, params)
            extras = {item["enterpriseId"]: item for item in context.profiles.roster(line, week)}
            for item in values:
                if enterprise and item["id"] != enterprise or params.get("pool") and item["pool"] != params["pool"]:
                    continue
                extra = extras[item["id"]]
                if params.get("level") and item["level"] != params["level"] or params.get("movement") and item["movement"] != params["movement"]:
                    continue
                tags = {tag["dimension"]: tag["value"] for tag in extra["tags"]}
                if any(params.get(key) and tags.get(key) != params[key] for key in ("category", "role", "purpose", "rhythm", "skill")):
                    continue
                if params.get("search") and params["search"].lower() not in item["enterprise"]["name"].lower():
                    continue
                annotation = extra["lastAnnotation"] or {}
                row = [item["id"], item["enterprise"]["name"], item["level"], item["movement"], item["pool"], item["tasks"], item["points"], item["activeDays"], item["downloadRate"], "; ".join(f"{key}:{value}" for key, value in tags.items()), clean(extra["headline"]), clean(annotation.get("text")), annotation.get("at")]
                evidence = item.get("conversion") or {}
                row.extend(evidence.get(key) for key in ("tasks", "activeDays", "downloadRate", "recentTasks", "totalTasks", "topIntent", "opportunity"))
                rows.append(row)
        elif kind == "annotations":
            columns = ["批注编号", "企业名称", "类型", "位置", "所选原文", "位置已经变化", "内容", "添加时间", "修改时间", "已解决"]
            values = context.profiles.annotations(enterprise=enterprise, from_=params.get("from"), to=params.get("to"), resolved=self.boolean(params, "resolved"))
            for item in self.selected(values, params):
                anchor = item["anchor"] or {}
                block = anchor.get("block")
                if block and block.startswith("record:"):
                    with self.store.connection() as conn:
                        record = conn.execute("SELECT json_extract(payload,'$.source_id') FROM tasks WHERE row_key=? AND enterprise_id=?", (block.removeprefix("record:"), item["enterprise"]["id"])).fetchone()
                    block = f"记录 {record[0]}" if record else "记录已移除"
                for entry in item["entries"]:
                    rows.append([item["id"], item["enterprise"]["name"], item["kind"], block, clean(anchor.get("quote")), anchor.get("stale"), clean(entry["text"]), entry["createdAt"], entry["editedAt"], item["resolved"]])
        elif kind == "movements":
            columns = ["企业名称", "产品线", "周", "方向", "本周用量", "上周用量", "结论", "原因及依据", "建议", "把握程度", "状态"]
            values = context.movements.list(line, week, params.get("trigger"))
            for item in self.selected(values, params):
                if enterprise and item["enterprise"]["id"] != enterprise:
                    continue
                rows.append([item["enterprise"]["name"], line, week, item["direction"], item["change"]["current"], item["change"]["previous"], clean(item["headline"]), clean("; ".join(f"{reason['text']} {reason['evidence']['label']}:{reason['evidence']['value']}" for reason in item["reasons"])), clean(item["action"]), item["confidence"], item["state"]])
        elif kind in ("templates_official", "templates_custom"):
            columns = ["模板名称", "提示词", "场景", "默认模型", "输入图片数量", "图片说明", "封面图链接", "可见客户范围", "备注"]
            values = context.templates.list(line, kind="official" if kind.endswith("official") else "custom", state=params.get("state"), enterprise=enterprise)
            for item in self.selected(values, params):
                content = item["current"]["content"]
                visible = "全部客户"
                if item["target"]:
                    entity = self.store.enterprise(item["target"]["id"])
                    visible = f"{entity['name']} {entity['admin_phone']}"
                cover = item["cover"]["output"]["url"] if item["cover"] else None
                if cover and not cover.startswith("/api/trials/"):
                    raise ApiProblem(422, "invalid_export_cover", "封面必须使用试验台生成的结果")
                rows.append([clean(content["title"]), clean(content["prompt"]), item["scene"], content["model"], len(content["slots"]), clean("; ".join(f"{slot['name']}（{'必填' if slot['required'] else '选填'}）：{slot['requirement']}" for slot in content["slots"])), cover, visible, clean(item["current"]["note"])])
                exports.append(item["id"])
        elif kind == "opportunities":
            columns = ["机会编号", "产品线", "周", "类型", "目标企业", "标题", "价值", "原因", "优先级", "使用次数", "企业数", "周数", "下载率", "同类中位下载率", "重试占比", "官方已覆盖", "状态"]
            values = context.templates.opportunities(line, kind=params.get("kind"), state=params.get("state"), enterprise=enterprise)
            for item in self.selected(values, params):
                if params.get("week") and item["week"] != week:
                    continue
                ev = item["evidence"]
                rows.append([item["id"], line, item["week"], item["kind"], (item["target"] or {}).get("name"), clean(item["title"]), clean(item["value"]), clean(item["reason"]), item["priority"], ev["uses"], ev["enterprises"], ev["weeks"], ev["downloadRate"], ev["peerDownloadRate"], ev["retryShare"], ev["officialCovered"], item["state"]])
        elif kind == "monitor":
            columns = ["模板编号", "模板名称", "类型", "目标企业", "FD模板编号", "上线时间", "估算数据", "周", "使用次数", "企业数", "下载率", "基准使用次数", "基准下载率"]
            values = [{**item, "id": item["templateId"]} for item in context.templates.monitor(line, kind=params.get("kind"))]
            for item in self.selected(values, params):
                if enterprise and (item["target"] or {}).get("id") != enterprise:
                    continue
                for point in item["weekly"]:
                    base = item["baseline"] or {}
                    rows.append([item["templateId"], clean(item["title"]), item["kind"], (item["target"] or {}).get("name"), item["fdTemplateId"], item["liveAt"], item["estimated"], point["week"], point["uses"], point["enterprises"], point["downloadRate"], base.get("uses"), base.get("downloadRate")])
        elif kind == "followups":
            columns = ["企业名称", "产品线", "周", "目的", "排序", "排序依据", "依据", "带去的内容", "话术草稿", "状态", "客户回复", "联系时间", "下一周变化", "建议"]
            board = context.followups.board(line, week)
            for item in self.selected(board["items"] + board["suggestions"], params):
                if enterprise and item["enterprise"]["id"] != enterprise or params.get("state") and item["state"] != params["state"]:
                    continue
                rows.append([item["enterprise"]["name"], line, week, item["goal"], item["rank"], clean(item["reason"]), clean("; ".join(f"{ev['label']}:{ev['value']}" for ev in item["evidence"])), clean("; ".join(value["label"] for value in item["attachments"])), clean(item["script"]["text"]), item["state"], clean(item["reply"]), item["contactedAt"], item["outcome"], item["suggested"]])
        elif kind == "analysis_matrix":
            result = getattr(analysis, line)(context.engine, week, self.boolean(params, "excluded") or False)
            values = result["matrix"]
            fields = ("intent", "model", "tasks", "enterprises", "downloadRate", "enterpriseMedianDownloadRate", "dominantEnterpriseShare") if line == "inspiration" else ("mode", "model", "tasks", "enterprises", "points", "downloadRate", "failed", "pointsPerDownloaded")
            columns = ["任务类型", "模型", "任务数", "企业数", "下载率", "企业中位下载率", "最大企业占比"] if line == "inspiration" else ["视频模式", "模型", "任务数", "企业数", "耗点", "下载率", "失败数", "每次下载耗点"]
            rows = [[item[field] for field in fields] for item in values if (not params.get("model") or item["model"] == params["model"]) and (not params.get("intent") or item.get("intent") == params["intent"]) and (not params.get("mode") or item.get("mode") == params["mode"])]
        else:
            columns = ["任务编号", "来源编号", "时间", "企业名称", "成员", "场景", "模式", "模型", "任务类型", "行为类型", "提示词", "耗点", "状态", "已下载", "失败原因", "FD会话地址"]
            query = {field: params[field] for field in ("enterprise", "user", "pattern", "intent", "mode", "model", "cluster") if field in params}
            query.update(line=line, week=week, limit=5000, offset=0)
            for field in ("downloaded", "failed"):
                query[field] = self.boolean(params, field)
            if kind == "analysis_failures":
                query["failed"] = True
            result = context.engine.task_list(query)
            if result["total"] > 5000:
                raise ApiProblem(422, "export_task_limit", f"当前筛选包含{result['total']}条任务，导出上限为5000条，请缩小筛选范围")
            for task in result["items"]:
                rows.append([task["rowKey"], task["sourceId"], task["createdAt"], task["enterprise"]["name"], (task["user"] or {}).get("name"), task["scene"], task["mode"], task["model"], task["intent"], task["pattern"], clean(task["prompt"]), task["points"], task["status"], task["downloaded"], clean(task["failure"]), task["fdUrl"]])
        return spreadsheet(kind, columns, rows), exports

    @staticmethod
    def boolean(params, field):
        value = params.get(field)
        if value is None:
            return None
        if value not in ("true", "false"):
            raise ApiProblem(422, "invalid_filter", f"{field}必须是true或false")
        return value == "true"

    def record_exports(self, ids):
        with self.store.connection() as conn:
            for key in set(ids):
                item = self.context.templates.get(key)
                if item["state"] in ("draft", "tried", "exported"):
                    item["state"] = "exported"
                item.update(exportedAt=now(), updatedAt=now())
                self.repo.save("template", item, conn=conn)

    def bundle(self, job_id, payload):
        directory = self.store.directory / "exports" / job_id
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "bundle.zip"
        partial = directory / "bundle.partial"
        ids = []
        size = 0
        try:
            with ZipFile(partial, "w", compression=ZIP_DEFLATED) as archive:
                for index, item in enumerate(payload["items"], 1):
                    with self.store.lock:
                        content, exported = self.render(item["kind"], item["params"])
                    size += len(content)
                    if size > MAX_BUNDLE_BYTES:
                        raise ApiProblem(413, "export_bundle_limit", "打包内容超过250MB上限，请减少导出项目")
                    archive.writestr(f"{index:02d}_{item['kind']}.xlsx", content)
                    ids.extend(exported)
                    self.context.jobs.progress(job_id, index, len(payload["items"]))
            partial.replace(target)
            with self.store.lock:
                self.record_exports(ids)
            self.retain(job_id)
            return {"url": f"/api/export/download/{job_id}"}
        finally:
            partial.unlink(missing_ok=True)

    def retain(self, current):
        completed = [item["id"] for item in self.repo.find("job") if item["operation"] == "export_bundle" and item["job"]["state"] == "done"]
        keep = {current, *completed[:1]}
        for key in completed:
            if key in keep:
                continue
            target = self.store.directory / "exports" / key / "bundle.zip"
            if target.is_file() and not target.is_symlink():
                target.unlink()
                target.parent.rmdir()


def mount(app: FastAPI, context):
    service = context.exports

    @app.post("/api/export/bundle")
    def create_bundle(body: BundleInput):
        return context.jobs.submit("export", "export_bundle", body.model_dump(), total=len(body.items))

    @app.get("/api/export/download/{key}")
    def download_bundle(key: str):
        job = context.jobs.get(key)
        if job["kind"] != "export" or job["state"] != "done":
            raise ApiProblem(409, "export_not_ready", "导出任务尚未完成")
        root = (context.store.directory / "exports").resolve()
        path = (root / key / "bundle.zip").resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ApiProblem(410, "export_expired", "导出文件已经退役，请重新生成")
        return FileResponse(path, filename="fd-desk.zip", media_type="application/zip")

    @app.get("/api/export/{kind}")
    def export(kind: ExportKind, request: Request):
        with context.store.lock:
            content, ids = service.render(kind, dict(request.query_params))
            service.record_exports(ids)
        filename = quote(f"{kind}_{now()[:10]}.xlsx")
        return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})
