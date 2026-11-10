import hashlib
import json
import re
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from uuid import uuid4

import pandas as pd

from .core import LINES, ZONE, ApiProblem, digest, dump, now, week_key

VIDEO_SCENES = {"自由创作", "图生视频", "多图参考", "首尾帧", "故事板", "故事板视频", "动作跟随", "全能替换", "实况图"}
IMPORT_SUFFIXES = (".xlsx", ".csv.gz")
REQUIRED = {"id", "时间", "企业", "用户", "生成场景", "提示词", "输入", "输出", "配置项", "状态", "下载状态", "扣点", "失败原因", "耗时"}
FAILURE_RULES = (
    ("moderation", r"Sensitive|sensitive|copyright|Risk label|敏感|风险"),
    ("material", r"帧率|DURATION|duration|时长|尺寸|分辨率|宽高"),
    ("timeout", r"超时|timed out|TIMEOUT|Timeout"),
    ("upstream", r"502|UPSTREAM|unexpected error|No image data|Bad Gateway|素材处理失败|预处理失败"),
)


def text(value):
    return "" if pd.isna(value) else str(value)


def split_lines(value):
    return [part.strip() for part in text(value).splitlines() if part.strip()]


def parse_failure(value):
    raw = text(value).strip()
    if not raw:
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        return {"category": "other", "userMessage": None, "providerMessage": raw}
    if not isinstance(info, dict):
        raise TypeError("失败原因必须是 JSON 对象")
    message = str(info.get("providerErrorMsg") or info.get("message") or "")
    category = "other"
    for label, pattern in FAILURE_RULES:
        subject = message + str(info.get("code")) if label == "timeout" else message
        if re.search(pattern, subject):
            category = label
            break
    return {"category": category, "userMessage": info.get("userErrorMsg"), "providerMessage": message or None}


def fingerprint(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def frames(path):
    if path.name.endswith(".xlsx"):
        yield pd.read_excel(path, sheet_name=0)
    elif path.name.endswith(".csv.gz"):
        with pd.read_csv(path, compression="gzip", encoding="utf-8-sig", dtype=str,
                         keep_default_na=False, chunksize=2000) as chunks:
            yield from chunks
    else:
        raise ApiProblem(422, "invalid_import", "导入文件必须是 xlsx 或 csv.gz 文件")


def raw_rows(path):
    for frame in frames(path):
        if not REQUIRED.issubset(frame.columns):
            raise ApiProblem(422, "invalid_import", "导出文件缺少必要列")
        yield from frame.to_dict("records")


def parse_rows(path):
    occurrences = Counter()
    for row_no, raw in enumerate(raw_rows(path)):
        created = pd.Timestamp(raw["时间"])
        if pd.isna(created):
            raise ApiProblem(422, "invalid_import", f"第 {row_no + 2} 行缺少生成时间")
        created = created.tz_localize(ZONE) if created.tzinfo is None else created.tz_convert(ZONE)
        enterprise_parts = split_lines(raw["企业"])
        if len(enterprise_parts) < 2:
            raise ApiProblem(422, "invalid_import", f"第 {row_no + 2} 行缺少企业标识")
        admin = enterprise_parts[-1].replace("超管", "").strip()
        user_parts = split_lines(raw["用户"])
        config = json.loads(raw["配置项"])
        if not isinstance(config, dict):
            raise ApiProblem(422, "invalid_import", f"第 {row_no + 2} 行配置必须是 JSON 对象")
        scene = text(raw["生成场景"])
        prompt = text(raw["提示词"])
        inputs, outputs = split_lines(raw["输入"]), split_lines(raw["输出"])
        source_id = str(raw["id"])
        output_key = "\n".join(outputs) if outputs else prompt + "|" + "\n".join(inputs)
        base = f"{source_id}|{raw['时间']}|{output_key}"
        base_key = digest(base)
        occurrence = occurrences[base_key]
        occurrences[base_key] += 1
        failure = parse_failure(raw["失败原因"])
        status = {"成功": "success", "失败": "failed", "已删除": "deleted"}.get(text(raw["状态"]), "unknown")
        durations = re.findall(r"(\d+)(小时|分|秒)", text(raw["耗时"]))
        duration = sum(int(n) * {"小时": 3600, "分": 60, "秒": 1}[unit] for n, unit in durations) if durations else None
        yield {
            "row_key": digest(f"{base}|{occurrence}"), "source_id": source_id,
            "created_at": created.isoformat(), "day": created.date().isoformat(),
            "week": week_key(created), "weekday": created.weekday(), "row_no": row_no,
            "enterprise_id": digest(admin, 10), "enterprise_name": enterprise_parts[0].strip(),
            "admin_phone": admin, "user_phone": user_parts[-1] if user_parts else None,
            "user_name": user_parts[0] if len(user_parts) > 1 else "",
            "line": "inspiration" if scene == "灵感成款" else "video" if scene in VIDEO_SCENES else "other",
            "scene": scene, "mode": config.get("modeLabel"), "model": config.get("model"),
            "config": config, "prompt": prompt, "inputs": inputs, "outputs": outputs,
            "status": status, "downloaded": text(raw["下载状态"]) not in ("", "否"),
            "download_via": split_lines(raw["下载状态"]) if text(raw["下载状态"]) not in ("", "否") else [],
            "points": int(raw["扣点"]) if text(raw["扣点"]).strip() else 0,
            "failure": failure, "failed": status == "failed" or (status == "deleted" and failure is not None),
            "duration_seconds": duration,
        }


def declared_range(path, minimum, maximum, validation=None):
    match = re.fullmatch(r"(?:FD生成记录导出_|FD_在约体验_)(\d{8})-(\d{8})\.(?:xlsx|csv\.gz)", path.name)
    warning = None
    if validation:
        start = date.fromisoformat(validation["requested_start"][:10])
        end = date.fromisoformat(validation["requested_end"][:10])
        if match and (start != date.fromisoformat(match[1]) or end != date.fromisoformat(match[2])):
            raise ApiProblem(422, "invalid_import_range", "文件名日期范围与校验报告不一致")
    elif match:
        start = date.fromisoformat(match[1])
        end = date.fromisoformat(match[2])
    else:
        start = date.fromisoformat(minimum)
        end = date.fromisoformat(maximum)
        warning = "文件名未声明日期范围，已采用任务时间的最早和最晚日期"
    if start > end or (minimum is not None and (minimum < start.isoformat() or maximum > end.isoformat())):
        raise ApiProblem(422, "invalid_import_range", "文件日期范围与任务时间不一致")
    return start, end, warning


def load_validation(path, checksum, scope=None):
    report_path = path.with_suffix(".validation.json")
    if not path.name.endswith(".csv.gz") or not report_path.is_file():
        return None
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if scope is not None:
        declared_scope = json.loads(Path(scope).read_text(encoding="utf-8"))
        for field in ("customer_filter_ui", "scene_selection_ui"):
            if set(report[field]) != set(declared_scope[field]):
                raise ApiProblem(422, "invalid_validation", "显式采集范围与 fddata 校验报告不一致")
        if ("allowed_export_scenes" in report
                and set(report["allowed_export_scenes"]) != set(declared_scope["allowed_export_scenes"])):
            raise ApiProblem(422, "invalid_validation", "显式导出场景与 fddata 校验报告不一致")
        report["allowed_export_scenes"] = declared_scope["allowed_export_scenes"]
    if not report.get("allowed_export_scenes"):
        raise ApiProblem(422, "validation_scope_required", "旧版 fddata 校验报告需要通过 --scope 显式提供已核实的采集范围")
    if (report["csv_sha256"] != checksum or report["csv_size_bytes"] != path.stat().st_size
            or report["exact_duplicate_rows"] != 0):
        raise ApiProblem(422, "invalid_validation", "文件内容与 fddata 校验报告不一致")
    if (not report["requested_start"].endswith("00:00:00")
            or not report["requested_end"].endswith("23:59:59")):
        raise ApiProblem(422, "invalid_validation", "日覆盖需要完整日期范围的校验报告")
    return report


def initialize_exclusions(conn):
    settings = json.loads(conn.execute("SELECT value FROM settings WHERE id=1").fetchone()[0])
    for line in LINES:
        key = f"excluded_initialized:{line}"
        if conn.execute("SELECT 1 FROM metadata WHERE key=?", (key,)).fetchone():
            continue
        weeks = Counter(week_key(row[0]) for row in conn.execute("SELECT day FROM coverage WHERE line=?", (line,)))
        complete = [week for week, days in weeks.items() if days == 7]
        if not complete:
            continue
        week = max(complete)
        measure = "SUM(json_extract(payload, '$.points'))" if line == "video" else "COUNT(*)"
        values = list(conn.execute(f"SELECT enterprise_id, {measure} AS value FROM tasks WHERE line=? AND week=? GROUP BY enterprise_id", (line, week)))
        total = sum(row["value"] for row in values)
        defaults = {row["enterprise_id"] for row in values if total and row["value"] / total >= 0.2}
        settings["excluded"][line] = sorted(set(settings["excluded"][line]) | defaults)
        conn.execute("INSERT INTO metadata VALUES (?, ?)", (key, "true"))
    conn.execute("UPDATE settings SET value=? WHERE id=1", (dump(settings),))


def import_file(store, path, *, replace_range=False, scope=None):
    path = Path(path)
    checksum = fingerprint(path)
    job = {
        "id": uuid4().hex, "file": path.name, "state": "running", "from": None, "to": None,
        "rows": 0, "inserted": 0, "updated": 0,
        "byLine": {"inspiration": 0, "video": 0, "other": 0}, "error": None, "createdAt": now(),
    }
    with store.lock:
        with store.connection() as conn:
            conn.execute("INSERT INTO imports VALUES (?, ?, ?)", (job["id"], checksum, dump(job)))
        try:
            validation = load_validation(path, checksum, scope)
            if replace_range and validation is None:
                raise ApiProblem(422, "validation_required", "覆盖日期范围需要 fddata 的完整合并校验报告")
            days, scenes = Counter(), Counter()
            with store.connection() as conn:
                if replace_range:
                    conn.execute("PRAGMA temp_store=MEMORY")
                    conn.execute("CREATE TEMP TABLE incoming_rows (row_key TEXT PRIMARY KEY)")
                file_order = conn.execute("SELECT COALESCE(MAX(file_order), -1) + 1 FROM tasks").fetchone()[0]
                for row in parse_rows(path):
                    existing = conn.execute("SELECT 1 FROM tasks WHERE row_key=?", (row["row_key"],)).fetchone()
                    job["rows"] += 1
                    job["updated" if existing else "inserted"] += 1
                    job["byLine"][row["line"]] += 1
                    days[row["day"]] += 1
                    scenes[row["scene"]] += 1
                    if replace_range:
                        conn.execute("INSERT INTO incoming_rows VALUES (?)", (row["row_key"],))
                    conn.execute(
                        "INSERT INTO enterprises(id, name, admin_phone) VALUES (?, ?, ?) "
                        "ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                        (row["enterprise_id"], row["enterprise_name"], row["admin_phone"]),
                    )
                    conn.execute(
                        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(row_key) DO UPDATE SET "
                        "enterprise_id=excluded.enterprise_id, line=excluded.line, week=excluded.week, "
                        "created_at=excluded.created_at, row_no=excluded.row_no, payload=excluded.payload",
                        (row["row_key"], row["enterprise_id"], row["line"], row["week"], row["created_at"], file_order, row["row_no"], dump(row)),
                    )
                if validation:
                    if (job["rows"] != validation["actual_rows"] or dict(days) != validation["days"]
                            or dict(scenes) != validation["scenes"]
                            or not set(scenes).issubset(validation["allowed_export_scenes"])):
                        raise ApiProblem(422, "invalid_validation", "实际记录数量、日期或场景与 fddata 校验报告不一致")
                elif not job["rows"]:
                    raise ApiProblem(422, "empty_import", "导出文件没有任务")
                start, end, warning = declared_range(path, min(days, default=None), max(days, default=None), validation)
                job.update({"from": start.isoformat(), "to": end.isoformat(), "error": warning})
                if replace_range:
                    allowed_scenes = validation["allowed_export_scenes"]
                    placeholders = ",".join("?" for _ in allowed_scenes)
                    removed = conn.execute(
                        "DELETE FROM tasks WHERE created_at>=? AND created_at<? "
                        f"AND json_extract(payload, '$.scene') IN ({placeholders}) "
                        "AND row_key NOT IN (SELECT row_key FROM incoming_rows)",
                        (start.isoformat(), (end + timedelta(days=1)).isoformat(), *allowed_scenes),
                    ).rowcount
                    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (
                        f"source:{checksum}", dump({"from": start.isoformat(), "to": end.isoformat(),
                            "rows": job["rows"], "replacedRows": removed,
                            "customerFilter": validation["customer_filter_ui"],
                            "scenes": allowed_scenes, "importedAt": job["createdAt"]}),
                    ))
                present_lines = {line for line in LINES if job["byLine"][line]}
                if validation:
                    allowed = set(validation["allowed_export_scenes"])
                    present_lines |= {"inspiration"} if "灵感成款" in allowed else set()
                    present_lines |= {"video"} if allowed & VIDEO_SCENES else set()
                day = start
                while day <= end:
                    for line in present_lines:
                        conn.execute("INSERT OR REPLACE INTO coverage VALUES (?, ?, ?)", (line, day.isoformat(), now()))
                    day += timedelta(days=1)
                initialize_exclusions(conn)
                job["state"] = "done"
                conn.execute("UPDATE imports SET job=? WHERE id=?", (dump(job), job["id"]))
        except (ApiProblem, ValueError, TypeError, KeyError, OSError, EOFError) as error:
            job.update({"state": "failed", "inserted": 0, "updated": 0, "error": "导入失败，请检查文件格式、日期和配置字段"})
            with store.connection() as conn:
                conn.execute("UPDATE imports SET job=? WHERE id=?", (dump(job), job["id"]))
            if isinstance(error, ApiProblem):
                raise
            raise ApiProblem(422, "invalid_import", job["error"]) from None
        store.changed()
    return job


def scan(store):
    inbox = store.directory / "inbox"
    inbox.mkdir(exist_ok=True)
    with store.lock:
        with store.connection() as conn:
            imported = {
                row[0] for row in conn.execute("SELECT fingerprint FROM imports WHERE json_extract(job, '$.state')='done'")
            }
        jobs = []
        paths = [path for path in inbox.iterdir() if path.is_file() and path.name.endswith(IMPORT_SUFFIXES)]
        for path in sorted(paths, key=lambda item: (item.stat().st_mtime_ns, item.name)):
            checksum = fingerprint(path)
            if checksum not in imported:
                jobs.append(import_file(store, path))
                imported.add(checksum)
        return jobs
