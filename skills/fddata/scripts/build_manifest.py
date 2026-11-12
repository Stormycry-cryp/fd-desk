import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path

from fddata_common import SCOPE_FIELDS, load_scope, parse_time, require, scope_from_record, scopes_equal


def parse_count(value, label):
    require(type(value) is int and value >= 0, f"{label}须为非负整数")
    return value


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("--runs", type=Path, required=True)
parser.add_argument("--reports-dir", type=Path)
parser.add_argument("--scope", type=Path)
parser.add_argument("--expected-total", type=int)
parser.add_argument("--weekly-ui-totals", type=Path)
parser.add_argument("--start", required=True)
parser.add_argument("--end", required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()

requested_start = parse_time(args.start)
requested_end = parse_time(args.end, end_of_day=True)
require(requested_start <= requested_end, "请求开始时间晚于结束时间")
require(args.expected_total is not None or args.weekly_ui_totals is not None, "须提供完整范围页面总数或分段页面总数")
if args.expected_total is not None:
    parse_count(args.expected_total, "expected-total")
output = args.output.resolve()
require(output.parent.is_dir(), f"输出目录不存在：{output.parent}")
require(not os.path.lexists(output), f"清单文件已存在：{output}")
runs_path = args.runs.resolve()
runs = json.loads(runs_path.read_text(encoding="utf-8"))
require(isinstance(runs, list), "运行记录须为数组")
parsed_runs = []
for run in runs:
    run_start = parse_time(run["start"])
    run_end = parse_time(run["end"], end_of_day=True)
    require(run_start <= run_end, "运行记录开始时间晚于结束时间")
    parse_count(run["count"], "运行记录 count")
    if "startedMs" in run:
        parse_count(run["startedMs"], "运行记录 startedMs")
    parsed_runs.append((run_start, run_end, run))

weekly_totals = []
if args.weekly_ui_totals is not None:
    weekly_totals = json.loads(args.weekly_ui_totals.read_text(encoding="utf-8"))
    require(isinstance(weekly_totals, list) and weekly_totals, "分段页面总数须为非空数组")
    periods = []
    for period in weekly_totals:
        period_start = parse_time(period["start"])
        period_end = parse_time(period["end"], end_of_day=True)
        require(period_start <= period_end, "分段开始时间晚于结束时间")
        parse_count(period["expected_rows"], "分段 expected_rows")
        periods.append((period_start, period_end, period))
    periods.sort(key=lambda item: item[0])
    require(periods[0][0] == requested_start and periods[-1][1] == requested_end, "页面总数分段未覆盖请求范围")
    for previous, current in zip(periods, periods[1:]):
        require(current[0] == previous[1] + datetime.timedelta(seconds=1), "页面总数分段存在间隔或重叠")
    weekly_totals = [
        {**period, "start": start.isoformat(sep=" "), "end": end.isoformat(sep=" ")}
        for start, end, period in periods
    ]

reports_dir = args.reports_dir.resolve() if args.reports_dir else runs_path.parent
require(reports_dir.is_dir(), f"报告目录不存在：{reports_dir}")
explicit_scope = load_scope(args.scope) if args.scope is not None else None
required_fields = {"source", "requested_start", "requested_end", "expected_rows_ui"}
batches = []
matched_run_indexes = set()
source_identities = set()
manifest_scope = None
legacy_scope_provided = False
for report_path in sorted(reports_dir.glob("*.json")):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(report, dict) or not required_fields.issubset(report):
        continue
    start = parse_time(report["requested_start"])
    end = parse_time(report["requested_end"], end_of_day=True)
    require(start <= end, f"报告开始时间晚于结束时间：{report_path}")
    if end < requested_start or start > requested_end:
        continue
    require(requested_start <= start and end <= requested_end, f"报告跨越请求范围边界：{report_path}")
    count = parse_count(report["expected_rows_ui"], "报告 expected_rows_ui")
    require(report["actual_rows"] == count, f"报告实际行数与页面总数不一致：{report_path}")
    require(report["exact_duplicate_rows"] == 0, f"报告存在重复行：{report_path}")
    report_scope = scope_from_record(report, explicit_scope, f"报告 {report_path}")
    if manifest_scope is None:
        manifest_scope = report_scope
    require(scopes_equal(manifest_scope, report_scope), f"各批报告范围不一致：{report_path}")
    if any(field not in report for field in SCOPE_FIELDS):
        legacy_scope_provided = True
    source = Path(report["source"]).resolve()
    require(source.is_file(), f"报告引用的源文件不存在：{source}")
    stat = source.stat()
    identity = (stat.st_dev, stat.st_ino)
    require(identity not in source_identities, f"报告引用重复源文件：{source}")
    source_identities.add(identity)
    require(file_sha256(source) == report["sha256"], f"源文件校验值与报告不一致：{source}")
    matching = [
        (index, run) for index, (run_start, run_end, run) in enumerate(parsed_runs)
        if run_start == start
        and run_end == end
        and run["count"] == count
        and ("started_ms" not in report or run.get("startedMs") == report["started_ms"])
    ]
    require(len(matching) == 1, f"运行记录与报告的时间范围、数量及已有提交时间匹配结果须唯一：{report_path}，匹配数 {len(matching)}")
    run_index, run = matching[0]
    require(run_index not in matched_run_indexes, f"多个报告匹配同一条运行记录：{report_path}")
    matched_run_indexes.add(run_index)
    if "started_ms" in report:
        parse_count(report["started_ms"], "报告 started_ms")
    if "seconds_to_file" in report:
        require("startedMs" in run, f"报告包含下载耗时，但运行记录缺少提交时间：{report_path}")
        elapsed = round(stat.st_mtime - run["startedMs"] / 1000, 3)
        require(elapsed == report["seconds_to_file"], f"源文件时间与运行记录不一致：{report_path}")
    batch = {
        "start": start.isoformat(sep=" "),
        "end": end.isoformat(sep=" "),
        "file": str(source),
        "report": str(report_path.resolve()),
        "expected_rows": count,
    }
    if "startedMs" in run:
        batch["started_ms"] = run["startedMs"]
    batches.append(batch)

require(batches, "请求范围没有成功校验报告")
batches.sort(key=lambda batch: batch["start"])
require(parse_time(batches[0]["start"]) == requested_start, "批次未覆盖请求开始时间")
require(parse_time(batches[-1]["end"]) == requested_end, "批次未覆盖请求结束时间")
for previous, current in zip(batches, batches[1:]):
    previous_end = parse_time(previous["end"])
    current_start = parse_time(current["start"])
    require(current_start == previous_end + datetime.timedelta(seconds=1), "批次存在重复、间隔或重叠")
if args.expected_total is not None:
    require(sum(batch["expected_rows"] for batch in batches) == args.expected_total, "批次页面数量合计与完整范围页面总数不一致")

manifest = {
    "requested_start": requested_start.isoformat(sep=" "),
    "requested_end": requested_end.isoformat(sep=" "),
    **manifest_scope,
    "runs_file": str(runs_path),
    "batches": batches,
}
if legacy_scope_provided:
    manifest["scope_explicit_for_legacy_reports"] = True
if args.expected_total is not None:
    manifest["expected_total_ui"] = args.expected_total
if weekly_totals:
    manifest["weekly_ui_totals"] = weekly_totals
with output.open("x", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(json.dumps({"manifest": str(output), "batches": len(batches), "expected_batch_rows": sum(batch["expected_rows"] for batch in batches)}, ensure_ascii=False))
