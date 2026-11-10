import io
import tempfile
from pathlib import Path
from threading import RLock
from typing import Annotated
from urllib.parse import quote
from uuid import uuid4

from fastapi import FastAPI, File, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from openpyxl import Workbook
from pydantic import ValidationError
from starlette.exceptions import HTTPException

from . import views
from .core import LINES, ROOT, ApiProblem, Line, dump, now, validate_week
from .engine import Engine
from .ingest import import_file, scan
from .media import Thumbnails
from .models import (
    AlertKind,
    AlertPatch,
    EnterprisePatch,
    NextAction,
    NoteInput,
    Pattern,
    Pool,
    ReportInput,
    Settings,
    SettingsPatch,
)
from .store import Store

MAX_UPLOAD_BYTES = 64 * 1024 * 1024


def create_app(directory=None):
    store = Store(directory)
    work = store.directory / "work"
    work.mkdir(exist_ok=True)
    tempfile.tempdir = str(work)
    engine = Engine(store)
    thumbnails = Thumbnails(store.directory)
    lock = RLock()
    app = FastAPI(title="FD 客户中台", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.engine = engine

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
    def get_meta():
        with store.lock, lock:
            return views.meta(engine)

    @app.get("/api/overview")
    def get_overview(line: Line, week: str):
        with store.lock, lock:
            return views.overview(engine, line, checked_week(week))

    @app.get("/api/enterprises")
    def get_enterprises(line: Line, week: str):
        with store.lock, lock:
            return views.roster(engine, line, checked_week(week))

    @app.get("/api/enterprises/export")
    def export_enterprises(line: Line, week: str, pool: Pool | None = None):
        with store.lock, lock:
            result = views.roster(engine, line, checked_week(week))
            workbook = Workbook()
            sheet = workbook.active
            sheet.title = "客户名单"
            sheet.append(["企业", "类型", "在约状态", "对应运营", "对应售后", "层级", "变动", "所属池", "任务数", "耗点", "使用天数", "下载率", "下载信号可靠", "同星期本周", "同星期上周", "最近活跃", "下一步"])
            for row in result["rows"]:
                if pool is not None and row["pool"] != pool:
                    continue
                values = [row["enterprise"]["name"], row["enterprise"]["kind"], row["contract"], row["owner"]["sales"], row["owner"]["afterSales"], row["level"], row["movement"], row["pool"], row["tasks"], row["points"], row["activeDays"], row["downloadRate"], row["downloadSignalReliable"], row["comparable"]["current"] if row["comparable"] else None, row["comparable"]["previous"] if row["comparable"] else None, row["lastActiveAt"], row["nextAction"]["text"] if row["nextAction"] else None]
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
                    conn.execute("UPDATE enterprises SET sales=?, after_sales=? WHERE id=?", (body.owner.sales, body.owner.afterSales, enterprise_id))
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
            return result

    @app.delete("/api/notes/{note_id}", status_code=204)
    def delete_note(note_id: str):
        with store.lock, store.connection() as conn:
            if conn.execute("DELETE FROM notes WHERE id=?", (note_id,)).rowcount == 0:
                raise ApiProblem(404, "not_found", "备注不存在")
        return Response(status_code=204)

    @app.get("/api/tasks")
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

    @app.get("/api/report")
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
    def get_imports():
        return store.import_jobs()

    @app.post("/api/imports")
    def post_import(file: Annotated[UploadFile, File()]):
        name = file.filename or ""
        if Path(name).name != name or not name.endswith(".xlsx"):
            raise ApiProblem(422, "invalid_import", "导入文件必须是 xlsx 文件")
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
