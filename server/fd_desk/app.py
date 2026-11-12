import asyncio
import io
import tempfile
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from threading import RLock
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from openpyxl import Workbook
from pydantic import ValidationError
from starlette.exceptions import HTTPException

from . import analysis, views
from .accounts import is_low
from .automation import Automation
from .core import LINES, ROOT, ApiProblem, Line, dump, now, validate_week
from .engine import Engine
from .ingest import IMPORT_SUFFIXES, import_file, scan
from .media import Thumbnails
from .models import (
    AlertKind,
    AlertPatch,
    AnalysisCreate,
    DraftCreate,
    DraftPatch,
    DraftPublish,
    EnterprisePatch,
    FindingCreate,
    FindingPatch,
    NextAction,
    NoteInput,
    Pattern,
    Pool,
    PushConfirm,
    PushCreate,
    ReportInput,
    RerunCreate,
    Settings,
    SettingsPatch,
    TouchCreate,
    TouchPatch,
)
from .pushes import Pushes, public
from .query_cache import QueryCache
from .reruns import Reruns
from .rework import ReworkContext
from .rework import mount as mount_rework
from .store import Store
from .workflow import Workflow

MAX_UPLOAD_BYTES = 64 * 1024 * 1024


def create_app(directory=None):
    store = Store(directory)
    work = store.directory / "work"
    work.mkdir(exist_ok=True)
    tempfile.tempdir = str(work)
    engine = Engine(store)
    workflow = Workflow(engine)
    thumbnails = Thumbnails(store.directory)
    pushes = Pushes(workflow)
    reruns = Reruns(engine, thumbnails)
    automation = Automation(workflow)
    queries = QueryCache(store)
    context = ReworkContext(store, engine, thumbnails, queries)
    with store.connection() as conn:
        for table in ("pushes", "reruns", "automation_jobs"):
            for item in store.items(table):
                if item["state"] in ("queued", "running", "confirmed", "creating", "sharing"):
                    item["state"] = "failed" if table == "automation_jobs" else "uncertain"
                    store.save(table, item, conn)
    lock = RLock()
    @asynccontextmanager
    async def lifespan(app):
        await asyncio.to_thread(context.cases.refresh)
        context.start()
        try:
            yield
        finally:
            await context.close()
            store.close()

    app = FastAPI(title="FD 客户中台", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store = store
    app.state.engine = engine
    app.state.queries = queries
    app.state.rework = context

    @app.exception_handler(ApiProblem)
    async def api_problem(request, error):
        return JSONResponse(error.payload, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_problem(request, error):
        return JSONResponse({"code": "invalid_request", "message": "请求参数或字段不符合接口要求"}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_problem(request, error):
        return JSONResponse({"code": "not_found" if error.status_code == 404 else "http_error", "message": "接口或资源不存在" if error.status_code == 404 else "请求方法或资源不可用"}, status_code=error.status_code)

    @app.exception_handler(Exception)
    async def unexpected_problem(request, error):
        return JSONResponse({"code": "internal_error", "message": "服务处理失败"}, status_code=500)

    def checked_week(week):
        return validate_week(week)

    @app.get("/api/meta")
    @queries.cached
    def get_meta():
        with store.lock, lock:
            result = views.meta(engine)
            with store.connection() as conn:
                account = conn.execute("SELECT value FROM metadata WHERE key='fd_account'").fetchone()
            if account:
                import json
                result["fdAccount"] = json.loads(account[0])
            return result

    @app.get("/api/overview")
    @queries.cached
    def get_overview(line: Line, week: str):
        with store.lock, lock:
            return views.overview(engine, line, checked_week(week))

    @app.get("/api/daily")
    @queries.cached
    def get_daily(line: Line, from_: Annotated[date, Query(alias="from")], to: date, enterprise: str | None = None):
        with store.lock, lock:
            return views.daily(engine, line, from_, to, enterprise)

    @app.get("/api/enterprises")
    @queries.cached
    def get_enterprises(line: Line, week: str, model: str | None = None, owner: str | None = None, points: Literal["low"] | None = None):
        with store.lock, lock:
            result = views.roster(engine, line, checked_week(week))
            if model is not None:
                group = engine.group(line, week)
                selected = set(group.loc[group.model == model, "enterprise_id"])
                selected.update(row["enterprise"]["id"] for row in result["rows"] if any(item["model"] == model for item in (row.get("conversion") or {}).get("models", [])))
                result["rows"] = [row for row in result["rows"] if row["enterprise"]["id"] in selected]
            if owner is not None:
                result["rows"] = [row for row in result["rows"] if owner in row["owner"].values()]
            if points == "low":
                result["rows"] = [row for row in result["rows"] if is_low(row["account"])]
            return result

    @app.get("/api/owners")
    @queries.cached
    def get_owners(line: Line):
        return engine.accounts.owners(line)

    @app.get("/api/accounts/unmatched")
    @queries.cached
    def get_unmatched_accounts():
        return engine.accounts.unmatched()

    @app.post("/api/accounts/collect")
    def collect_accounts():
        return engine.accounts.request()

    @app.get("/api/enterprises/export")
    def export_enterprises(line: Line, week: str, pool: Pool | None = None, ids: str | None = None, owner: str | None = None, points: Literal["low"] | None = None):
        with store.lock, lock:
            result = views.roster(engine, line, checked_week(week))
            selected = set(ids.split(",")) if ids is not None else None
            if selected is not None and not selected <= {row["enterprise"]["id"] for row in result["rows"]}:
                raise ApiProblem(422, "invalid_enterprises", "导出名单包含当前范围以外的企业")
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "客户名单"
            sheet.append(["企业", "类型", "在约状态", "对应运营", "对应售后", "层级", "变动", "所属池", "任务数", "耗点", "使用天数", "下载率", "下载信号可靠", "同星期本周", "同星期上周", "最近活跃", "下一步", "自由改款本周任务", "自由改款活跃天数", "自由改款下载率", "自由改款近四个完整周任务", "自由改款累计任务", "自由改款主要任务", "转化建议"])
            sheet.cell(1, 4, "销售")
            sheet.cell(1, 5, "售后")
            for index, label in enumerate(("剩余点数", "近七日消耗", "预计可用天数"), 25):
                sheet.cell(1, index, label)
            for row in result["rows"]:
                if pool is not None and row["pool"] != pool:
                    continue
                if selected is not None and row["enterprise"]["id"] not in selected:
                    continue
                if owner is not None and owner not in row["owner"].values():
                    continue
                if points == "low" and not is_low(row["account"]):
                    continue
                values = [row["enterprise"]["name"], row["enterprise"]["kind"], row["contract"], row["owner"]["sales"], row["owner"]["afterSales"], row["level"], row["movement"], row["pool"], row["tasks"], row["points"], row["activeDays"], row["downloadRate"], row["downloadSignalReliable"], row["comparable"]["current"] if row["comparable"] else None, row["comparable"]["previous"] if row["comparable"] else None, row["lastActiveAt"], row["nextAction"]["text"] if row["nextAction"] else None]
                evidence = row.get("conversion") or {}
                values.extend(evidence.get(key) for key in ("tasks", "activeDays", "downloadRate", "recentTasks", "totalTasks", "topIntent", "opportunity"))
                account = row["account"] or {}
                values.extend(account.get(key) for key in ("remaining", "used7d", "daysLeft"))
                sheet.append(values)
                for cell in sheet[sheet.max_row]:
                    if isinstance(cell.value, str):
                        cell.data_type = "s"
            sheet.freeze_panes = "A2"
            sheet.auto_filter.ref = sheet.dimensions
            output = io.BytesIO()
            workbook.save(output)
            workbook.close()
            filename = quote(f"客户名单_{line}_{week}.xlsx")
            return Response(output.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"})

    @app.get("/api/enterprises/{enterprise_id}")
    @queries.cached
    def get_enterprise(enterprise_id: str, week: str):
        with store.lock, lock:
            return views.enterprise_detail(engine, enterprise_id, checked_week(week))

    @app.patch("/api/enterprises/{enterprise_id}")
    def patch_enterprise(enterprise_id: str, body: EnterprisePatch):
        with store.lock, lock:
            store.enterprise(enterprise_id)
            with store.connection() as conn:
                if body.summary is not None:
                    store.write_authored(conn, "summary", enterprise_id, body.summary, body.source)
                for field in ("kind", "contract"):
                    value = getattr(body, field)
                    if value is not None:
                        conn.execute(f"UPDATE enterprises SET {field}=? WHERE id=?", (value, enterprise_id))
                if body.owner is not None:
                    conn.execute("UPDATE enterprises SET sales=?, after_sales=?, owner_manual=1 WHERE id=?", (body.owner.sales, body.owner.afterSales, enterprise_id))
                if body.kind == "internal":
                    settings = store.settings()
                    for line in LINES:
                        settings["excluded"][line] = sorted(set(settings["excluded"][line]) | {enterprise_id})
                    conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(settings),))
            store.changed()
            latest = views.meta(engine)["weeks"]
            return views.enterprise_detail(engine, enterprise_id, latest[-1])

    @app.put("/api/enterprises/{enterprise_id}/next-action")
    def put_next_action(enterprise_id: str, body: NextAction):
        with store.lock, lock:
            store.enterprise(enterprise_id)
            with store.connection() as conn:
                result = store.write_authored(conn, "next_action", f"{enterprise_id}:{body.line}", body.text, body.source)
            store.changed()
            return result

    @app.post("/api/enterprises/{enterprise_id}/notes")
    def create_note(enterprise_id: str, body: NoteInput):
        with store.lock:
            store.enterprise(enterprise_id)
            result = {"id": uuid4().hex, "text": body.text, "createdAt": now()}
            with store.connection() as conn:
                conn.execute("INSERT INTO notes VALUES (?, ?, ?, ?)", (result["id"], enterprise_id, body.text, result["createdAt"]))
            context.profiles.migrate_notes()
            return result

    @app.delete("/api/notes/{note_id}", status_code=204)
    def delete_note(note_id: str):
        with store.lock, store.connection() as conn:
            if conn.execute("DELETE FROM notes WHERE id=?", (note_id,)).rowcount == 0:
                raise ApiProblem(404, "not_found", "备注不存在")
            conn.execute("DELETE FROM rework_objects WHERE kind='annotation' AND id=?", ("note-" + note_id,))
        return Response(status_code=204)

    @app.get("/api/tasks")
    @queries.cached
    def get_tasks(line: Line, week: str | None = None, enterprise: str | None = None, user: str | None = None,
                  pattern: Pattern | None = None, intent: str | None = None, mode: str | None = None,
                  model: str | None = None, downloaded: bool | None = None, failed: bool | None = None,
                  cluster: str | None = None, sample: int | None = Query(None, ge=1, le=200),
                  offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
        query = {"line": line, "week": checked_week(week) if week is not None else None, "enterprise": enterprise, "user": user,
            "pattern": pattern, "intent": intent, "mode": mode, "model": model, "downloaded": downloaded, "failed": failed,
            "cluster": cluster, "sample": sample, "offset": offset, "limit": limit}
        with store.lock, lock:
            return engine.task_list(query)

    @app.get("/api/chains")
    @queries.cached
    def get_chains(line: Line, week: str, enterprise: str | None = None,
                   minLength: int = Query(3, ge=1), downloaded: bool | None = None):
        with store.lock, lock:
            return engine.chain_list(line, checked_week(week), enterprise, minLength, downloaded)

    @app.get("/api/media/thumb")
    def get_thumbnail(url: str, w: int):
        if w not in (240, 480, 1200):
            raise ApiProblem(422, "invalid_width", "缩略图宽度必须是 240、480 或 1200")
        return Response(thumbnails.get(url, w), media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.get("/api/alerts")
    @queries.cached
    def get_alerts(line: Line, week: str, kind: AlertKind | None = None):
        with store.lock, lock:
            alerts = engine.alerts(line, checked_week(week))
            return [item for item in alerts if kind is None or item["kind"] == kind]

    @app.patch("/api/alerts/{alert_id}")
    def patch_alert(alert_id: str, body: AlertPatch):
        with store.lock, lock:
            engine.refresh()
            for coverage in views.meta(engine)["coverage"]:
                item = next((item for item in engine.alerts(coverage["line"], coverage["week"]) if item["id"] == alert_id), None)
                if item:
                    with store.connection() as conn:
                        conn.execute("INSERT OR REPLACE INTO alert_state VALUES (?, ?, ?, ?)", (alert_id, int(body.dismissed), item["line"], item["week"]))
                    store.changed()
                    return {**item, "dismissed": body.dismissed}
            raise ApiProblem(404, "not_found", "预警不存在")

    @app.get("/api/analysis/inspiration")
    @queries.cached
    def get_inspiration_analysis(week: str, excluded: bool = False):
        with store.lock, lock:
            return analysis.inspiration(engine, checked_week(week), excluded)

    @app.get("/api/analysis/video")
    @queries.cached
    def get_video_analysis(week: str, excluded: bool = False):
        with store.lock, lock:
            return analysis.video(engine, checked_week(week), excluded)

    @app.get("/api/clusters")
    @queries.cached
    def get_clusters(line: Line, week: str | None = None, enterprise: str | None = None, candidate: bool | None = None):
        with store.lock, lock:
            return analysis.clusters(engine, line, checked_week(week) if week else None, enterprise, candidate)

    @app.get("/api/conversion")
    @queries.cached
    def get_conversion(line: Line, week: str | None = None):
        with store.lock, lock:
            return analysis.conversion(engine, line, checked_week(week) if week else None)

    @app.get("/api/cross-line")
    @queries.cached
    def get_cross_line(week: str):
        with store.lock, lock:
            return analysis.cross_line(engine, checked_week(week))

    @app.get("/api/findings")
    @queries.cached
    def get_findings(line: Line | None = None):
        return [item for item in store.items("findings") if line is None or item["line"] == line]

    @app.post("/api/findings")
    def post_finding(body: FindingCreate):
        with store.lock, lock:
            item = {**body.model_dump(), "id": uuid4().hex, "updatedAt": now(), "rechecks": []}
            store.save("findings", item)
            store.changed()
            return item

    @app.patch("/api/findings/{key}")
    def patch_finding(key: str, body: FindingPatch):
        with store.lock, lock:
            item = {**store.item("findings", key), **body.model_dump(exclude_unset=True), "updatedAt": now()}
            store.save("findings", item)
            store.changed()
            return item

    @app.get("/api/drafts")
    @queries.cached
    def get_drafts(line: Line):
        with store.lock, lock:
            return workflow.drafts(line)

    @app.post("/api/drafts")
    def post_draft(body: DraftCreate):
        with store.lock, lock:
            return workflow.create_draft(body)

    @app.patch("/api/drafts/{key}")
    def patch_draft(key: str, body: DraftPatch):
        with store.lock, lock:
            return workflow.patch_draft(key, body)

    @app.post("/api/drafts/{key}/publish")
    def publish_draft(key: str, body: DraftPublish):
        with store.lock, lock:
            return pushes.publish(key, body)

    @app.post("/api/fd-account/check")
    def check_fd_account():
        result = pushes.client.check()
        with store.connection() as conn:
            conn.execute("INSERT OR REPLACE INTO metadata VALUES ('fd_account',?)", (dump(result),))
        return result

    @app.post("/api/drafts/{key}/pushes")
    def preview_push(key: str, body: PushCreate):
        with store.lock, lock:
            return pushes.preview(key, body)

    @app.get("/api/pushes/{key}")
    def get_push(key: str):
        with store.lock, lock:
            return pushes.get(key)

    @app.post("/api/pushes/{key}/confirm")
    def confirm_push(key: str, body: PushConfirm, background: BackgroundTasks):
        with store.lock, lock:
            result, execute = pushes.confirm(key, body.receiverUserIds)
        if execute:
            background.add_task(pushes.execute, key)
        return result

    @app.post("/api/pushes/{key}/cancel")
    def cancel_push(key: str):
        with store.lock, lock:
            return pushes.cancel(key)

    @app.get("/api/reruns")
    def get_reruns(enterprise: str | None = None):
        return [public(item) for item in store.items("reruns") if enterprise is None or item["enterprise"]["id"] == enterprise]

    @app.post("/api/reruns")
    def post_rerun(body: RerunCreate):
        with store.lock, lock:
            return reruns.create(body)

    @app.post("/api/reruns/{key}/confirm")
    def confirm_rerun(key: str, background: BackgroundTasks):
        with store.lock, lock:
            result, execute = reruns.confirm(key)
        if execute:
            background.add_task(reruns.execute, key)
        return result

    @app.get("/api/reruns/{key}/media/{index}")
    def rerun_media(key: str, index: int):
        path, media_type = reruns.media(key, index)
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.post("/api/automation/analysis")
    def create_analysis(body: AnalysisCreate, background: BackgroundTasks):
        with store.lock, lock:
            result = automation.create(body)
        background.add_task(automation.execute, result["id"])
        return public(result)

    @app.get("/api/automation/analysis/{key}")
    def get_analysis(key: str):
        return public(store.item("automation_jobs", key))

    @app.get("/api/touches")
    @queries.cached
    def get_touches(line: Line, week: str):
        with store.lock, lock:
            return workflow.board(line, checked_week(week))

    @app.get("/api/touches/export")
    def export_touches(line: Line, week: str, owner: str | None = None):
        with store.lock, lock:
            content = workflow.export_touches(line, checked_week(week), owner)
        return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename=touches_{line}_{week}.xlsx"})

    @app.post("/api/touches/import")
    def import_touches(file: Annotated[UploadFile, File()]):
        content = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(content) > MAX_UPLOAD_BYTES:
            raise ApiProblem(413, "import_too_large", "表格超过 64 MB")
        with store.lock, lock:
            result = workflow.import_touches(content)
            if result["updated"]:
                for item in store.items("touches"):
                    context.followups.sync_legacy(item)
            return result

    @app.post("/api/touches")
    def post_touch(body: TouchCreate):
        with store.lock, lock:
            result = workflow.create_touch(body)
            context.followups.sync_legacy(result)
            return result

    @app.patch("/api/touches/{key}")
    def patch_touch(key: str, body: TouchPatch):
        with store.lock, lock:
            result = workflow.patch_touch(key, body)
            context.followups.sync_legacy(result)
            return result

    @app.delete("/api/touches/{key}", status_code=204)
    def delete_touch(key: str):
        with store.lock, store.connection() as conn:
            if not conn.execute("DELETE FROM touches WHERE id=?", (key,)).rowcount:
                raise ApiProblem(404, "not_found", "触达卡片不存在")
            conn.execute("DELETE FROM rework_objects WHERE kind='followup' AND id=?", (key,))
        return Response(status_code=204)

    @app.get("/api/report")
    @queries.cached
    def get_report(week: str):
        with store.lock, lock:
            return views.report(engine, checked_week(week))

    @app.put("/api/report")
    def put_report(body: ReportInput):
        week = checked_week(body.week)
        with store.lock, lock:
            with store.connection() as conn:
                for field in ("done", "next"):
                    if getattr(body, field) is not None:
                        store.write_authored(conn, f"report_{field}", week, getattr(body, field), body.source)
            store.changed()
            return views.report(engine, week)

    @app.get("/api/imports")
    @queries.cached
    def get_imports():
        return store.import_jobs()

    @app.post("/api/imports")
    def post_import(file: Annotated[UploadFile, File()]):
        name = file.filename or ""
        if Path(name).name != name or not name.endswith(IMPORT_SUFFIXES):
            raise ApiProblem(422, "invalid_import", "导入文件必须是 xlsx 或 csv.gz 文件")
        with tempfile.TemporaryDirectory(prefix="upload-", dir=work) as upload_directory:
            path = Path(upload_directory) / name
            total = 0
            with path.open("wb") as destination:
                while chunk := file.file.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise ApiProblem(413, "import_too_large", "导出文件超过 64 MB")
                    destination.write(chunk)
            return import_file(store, path)

    @app.post("/api/imports/scan")
    def post_scan():
        return scan(store)

    @app.get("/api/settings")
    @queries.cached
    def get_settings():
        return store.settings()

    @app.put("/api/settings")
    def put_settings(body: SettingsPatch):
        with store.lock, lock:
            candidate = {**store.settings(), **body.model_dump(exclude_unset=True)}
            try:
                validated = Settings.model_validate(candidate).model_dump()
            except ValidationError:
                raise ApiProblem(422, "invalid_settings", "设置字段或阈值不符合要求") from None
            with store.connection() as conn:
                internal = [row[0] for row in conn.execute("SELECT id FROM enterprises WHERE kind='internal'")]
                for line in LINES:
                    validated["excluded"][line] = sorted(set(validated["excluded"][line]) | set(internal))
                conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(validated),))
                if body.excluded is not None:
                    for line in LINES:
                        conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (f"excluded_initialized:{line}", "true"))
            store.changed()
            return validated

    mount_rework(app, context)
    from .ask_proxy import mount as mount_ask
    mount_ask(app, context)
    disabled = ("/api/pushes", "/api/fd-account", "/api/reruns", "/api/automation/analysis", "/api/drafts")
    app.router.routes[:] = [route for route in app.router.routes if not any(route.path == prefix or route.path.startswith(prefix + "/") for prefix in disabled)]

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    def missing_api(path: str):
        raise ApiProblem(404, "not_found", "接口不存在")

    @app.get("/{path:path}")
    def static(path: str, request: Request):
        if path == "api" or path.startswith("api/"):
            raise ApiProblem(404, "not_found", "接口不存在")
        directory = (ROOT / "web/dist").resolve()
        target = (directory / path).resolve()
        if not target.is_relative_to(directory):
            raise ApiProblem(404, "not_found", "资源不存在")
        if target.is_file():
            return FileResponse(target)
        index = directory / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise ApiProblem(404, "frontend_unavailable", "前端尚未构建")

    return app
