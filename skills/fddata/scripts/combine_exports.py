import argparse
import collections
import csv
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path

import openpyxl

from fddata_common import HEADERS, SCOPE_FIELDS, parse_time, require, scope_from_record

TIME_INDEX = HEADERS.index("时间")
SCENE_INDEX = HEADERS.index("生成场景")
CONFIG_INDEX = HEADERS.index("配置项")
STATE_INDEX = HEADERS.index("状态")


def parse_count(value, label):
    require(type(value) is int and value >= 0, f"{label}须为非负整数")
    return value


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_row_digest(digest, row):
    values = ["" if value is None else str(value) for value in row]
    digest.update(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    digest.update(b"\n")


def write_new_json(path, value):
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def publish_new(partial, target):
    os.link(partial, target)
    partial.unlink()


def check_ranges(items, requested_start, requested_end, label):
    require(bool(items), f"{label}不能为空")
    ranges = []
    for item in items:
        start = parse_time(item["start"])
        end = parse_time(item["end"])
        require(start <= end, f"{label}开始时间晚于结束时间：{item}")
        ranges.append((start, end, item))
    ranges.sort(key=lambda entry: entry[0])
    require(ranges[0][0] == requested_start, f"{label}开始时间与请求范围不一致")
    require(ranges[-1][1] == requested_end, f"{label}结束时间与请求范围不一致")
    for previous, current in zip(ranges, ranges[1:]):
        require(current[0] == previous[1] + datetime.timedelta(seconds=1), f"{label}时间存在间隔或重叠")
    return ranges


parser = argparse.ArgumentParser()
parser.add_argument("manifest", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--archive-dir", type=Path)
args = parser.parse_args()

manifest_path = args.manifest.resolve()
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
manifest_scope = scope_from_record(manifest, label="清单")
allowed_scenes = set(manifest_scope["allowed_export_scenes"])
requested_start = parse_time(manifest["requested_start"])
requested_end = parse_time(manifest["requested_end"])
require(requested_start <= requested_end, "请求开始时间晚于结束时间")
batch_ranges = check_ranges(manifest["batches"], requested_start, requested_end, "导出批次")
expected_total = manifest.get("expected_total_ui")
if expected_total is not None:
    parse_count(expected_total, "expected_total_ui")
weekly_totals = manifest.get("weekly_ui_totals", [])
require(expected_total is not None or bool(weekly_totals), "须提供完整范围页面总数或覆盖全范围的分段页面总数")
weekly_ranges = check_ranges(weekly_totals, requested_start, requested_end, "页面总数分段") if weekly_totals else []
for _, _, item in weekly_ranges:
    parse_count(item["expected_rows"], "分段 expected_rows")
weekly_actual = [0] * len(weekly_ranges)

output = args.output.resolve()
require(output.name.endswith(".csv.gz"), "输出文件须以 .csv.gz 结尾")
require(output.parent.is_dir(), f"输出目录不存在：{output.parent}")
output_partial = output.with_name(output.name + ".partial")
validation_path = output.with_suffix(".validation.json")
validation_partial = validation_path.with_name(validation_path.name + ".partial")
planned_new_paths = {output, output_partial, validation_path, validation_partial}
require(len(planned_new_paths) == 4, "输出路径存在冲突")
for path in planned_new_paths:
    require(not os.path.lexists(path), f"输出文件或暂存文件已存在：{path}")

archive_dir = args.archive_dir.resolve() if args.archive_dir is not None else None
if archive_dir is not None:
    archive_dir.mkdir(parents=True, exist_ok=True)
    require(archive_dir.is_dir(), f"归档路径不是目录：{archive_dir}")
archive_manifest = archive_dir / f"{manifest_path.stem}.archived.json" if archive_dir else None
manifest_partial = archive_manifest.with_name(archive_manifest.name + ".partial") if archive_dir else None
sources = []
report_paths = []
archive_targets = []
archive_reports = []
report_partials = []
input_identities = set()
for start, end, batch in batch_ranges:
    expected_rows = parse_count(batch["expected_rows"], "批次 expected_rows")
    source = Path(batch["file"]).resolve()
    report_path = Path(batch["report"]).resolve()
    require(source.is_file(), f"源文件不存在：{source}")
    require(report_path.is_file(), f"单批校验报告不存在：{report_path}")
    stat = source.stat()
    identity = (stat.st_dev, stat.st_ino)
    require(identity not in input_identities, f"源文件重复：{source}")
    input_identities.add(identity)
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    require(Path(report["source"]).resolve() == source, f"报告引用的源文件不一致：{report_path}")
    require(parse_time(report["requested_start"]) == start and parse_time(report["requested_end"], end_of_day=True) == end, f"报告日期与批次不一致：{report_path}")
    require(report["headers"] == HEADERS, f"报告列结构不一致：{report_path}")
    require(report["expected_rows_ui"] == expected_rows and report["actual_rows"] == expected_rows, f"报告行数与批次不一致：{report_path}")
    if any(field not in report for field in SCOPE_FIELDS):
        require(manifest.get("scope_explicit_for_legacy_reports") is True, f"旧报告缺少范围依据：{report_path}")
    scope_from_record(report, manifest_scope, f"报告 {report_path}")
    require(report["exact_duplicate_rows"] == 0, f"单批报告存在重复行：{report_path}")
    if "started_ms" in report:
        require(batch.get("started_ms") == report["started_ms"], f"报告提交时间与清单不一致：{report_path}")
    source_hash = file_sha256(source)
    require(report["sha256"] == source_hash, f"源文件校验值与报告不一致：{source}")
    sources.append({"path": source, "stat": stat, "sha256": source_hash, "report": report, "report_bytes": report_bytes})
    report_paths.append(report_path)
    if archive_dir is not None:
        require(stat.st_dev == archive_dir.stat().st_dev, f"源文件与归档目录不在同一文件系统：{source}")
        name = f"FD_{start:%Y%m%dT%H%M%S}_{end:%Y%m%dT%H%M%S}.xlsx"
        target = archive_dir / name
        archive_targets.append(target)
        archived_report = target.with_suffix(".validation.json")
        archive_reports.append(archived_report)
        report_partials.append(archived_report.with_name(archived_report.name + ".partial"))

protected_paths = {manifest_path, *report_paths, *(item["path"] for item in sources)}
require(len(report_paths) == len(set(report_paths)), "单批校验报告路径重复")
require(len(protected_paths) == 1 + len(report_paths) + len(sources), "清单、报告或源文件路径冲突")
require(not planned_new_paths & protected_paths, "输出路径与输入路径冲突")
if archive_dir is not None:
    archive_new_paths = [archive_manifest, manifest_partial, *archive_reports, *report_partials, *archive_targets]
    require(len(archive_new_paths) == len(set(archive_new_paths)), "归档目标或暂存路径重复")
    require(not set(archive_new_paths) & (protected_paths | planned_new_paths), "归档路径与其他路径冲突")
    for path in archive_new_paths:
        require(not os.path.lexists(path), f"归档目标或暂存文件已存在：{path}")

days = collections.Counter()
scenes = collections.Counter()
states = collections.Counter()
final_batches = []
source_digest = hashlib.sha256()
actual_rows = 0
previous_time = None
same_time_rows = set()
weekly_index = 0
with gzip.open(output_partial, "xt", encoding="utf-8-sig", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(HEADERS)
    for (start, end, batch), source_info, report_path in zip(batch_ranges, sources, report_paths):
        path = source_info["path"]
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheet = workbook["生成记录"]
        declared_dimensions = sheet.calculate_dimension()
        sheet.reset_dimensions()
        iterator = sheet.iter_rows(values_only=True)
        require(list(next(iterator)) == HEADERS, f"导出列结构不一致：{path}")
        rows = []
        batch_days = collections.Counter()
        batch_scenes = collections.Counter()
        for row in iterator:
            require(len(row) == len(HEADERS), f"导出行列数不一致：{path}")
            timestamp = parse_time(row[TIME_INDEX])
            require(start <= timestamp <= end, f"记录超出批次时间范围：{path} {timestamp}")
            scene = row[SCENE_INDEX]
            require(scene in allowed_scenes, f"记录包含范围之外的场景：{scene}")
            if row[CONFIG_INDEX] not in (None, ""):
                json.loads(row[CONFIG_INDEX])
            rows.append((timestamp, row))
            batch_days[timestamp.date().isoformat()] += 1
            batch_scenes[scene] += 1
        workbook.close()
        require(len(rows) == batch["expected_rows"], f"文件行数与页面总数不一致：{path} {len(rows)}")
        require(dict(batch_days) == source_info["report"]["days"], f"批次每日行数与报告不一致：{path}")
        require(dict(batch_scenes) == source_info["report"]["scenes"], f"批次场景行数与报告不一致：{path}")
        require(file_sha256(path) == source_info["sha256"], f"处理过程中源文件发生变化：{path}")
        rows.sort(key=lambda entry: entry[0])
        for timestamp, row in rows:
            require(previous_time is None or timestamp >= previous_time, "合并记录的时间顺序错误")
            if timestamp != previous_time:
                same_time_rows.clear()
            require(row not in same_time_rows, f"合并数据存在完全相同的重复行：{timestamp}")
            same_time_rows.add(row)
            previous_time = timestamp
            if weekly_ranges:
                while weekly_index < len(weekly_ranges) and timestamp > weekly_ranges[weekly_index][1]:
                    weekly_index += 1
                require(weekly_index < len(weekly_ranges) and weekly_ranges[weekly_index][0] <= timestamp, "记录超出页面总数分段范围")
                weekly_actual[weekly_index] += 1
            writer.writerow(row)
            normalized_row_digest(source_digest, row)
            actual_rows += 1
            days[timestamp.date().isoformat()] += 1
            scenes[row[SCENE_INDEX]] += 1
            states["" if row[STATE_INDEX] is None else str(row[STATE_INDEX])] += 1
        result_batch = {
            **batch,
            "file": str(path),
            "report": str(report_path),
            "actual_rows": len(rows),
            "minimum_time": rows[0][0].isoformat(sep=" ") if rows else None,
            "maximum_time": rows[-1][0].isoformat(sep=" ") if rows else None,
            "declared_dimensions": declared_dimensions,
            "size_bytes": source_info["stat"].st_size,
            "sha256": source_info["sha256"],
            "days": dict(sorted(batch_days.items())),
            "scenes": dict(batch_scenes),
        }
        if "started_ms" in batch:
            result_batch["seconds_to_file"] = round(source_info["stat"].st_mtime - batch["started_ms"] / 1000, 3)
        elif "seconds_to_file" in source_info["report"]:
            result_batch["seconds_to_file"] = source_info["report"]["seconds_to_file"]
        if archive_dir is not None:
            result_batch["download_path"] = str(path)
            result_batch["file"] = str(archive_targets[len(final_batches)])
            result_batch["original_report"] = str(report_path)
            result_batch["report"] = str(archive_reports[len(final_batches)])
        final_batches.append(result_batch)

if expected_total is not None:
    require(actual_rows == expected_total, f"合计与完整范围页面总数不一致：{actual_rows} / {expected_total}")
weekly_checks = []
for (_, _, period), count in zip(weekly_ranges, weekly_actual):
    require(count == period["expected_rows"], f"分段行数与页面总数不一致：{period['start']} {count} / {period['expected_rows']}")
    weekly_checks.append({**period, "actual_rows": count})

with gzip.open(output_partial, "rb") as handle:
    require(handle.read(3) == b"\xef\xbb\xbf", "输出文件缺少 UTF-8 BOM")
output_digest = hashlib.sha256()
output_rows = 0
output_previous_time = None
with gzip.open(output_partial, "rt", encoding="utf-8-sig", newline="") as handle:
    reader = csv.reader(handle)
    require(next(reader) == HEADERS, "输出文件列结构不一致")
    for row in reader:
        require(len(row) == len(HEADERS), "输出文件行列数不一致")
        timestamp = parse_time(row[TIME_INDEX])
        require(output_previous_time is None or timestamp >= output_previous_time, "输出文件时间顺序错误")
        output_previous_time = timestamp
        normalized_row_digest(output_digest, row)
        output_rows += 1
require(output_rows == actual_rows and output_digest.digest() == source_digest.digest(), "输出文件与源记录内容不一致")

summary = {
    **manifest,
    "batches": final_batches,
    "actual_rows": actual_rows,
    "csv": str(output),
    "csv_format": "UTF-8 BOM, gzip",
    "csv_size_bytes": output_partial.stat().st_size,
    "csv_sha256": file_sha256(output_partial),
    "columns": HEADERS,
    "days": dict(sorted(days.items())),
    "scenes": dict(scenes),
    "states": dict(states),
    "weekly_ui_checks": weekly_checks,
    "exact_duplicate_rows": 0,
    "duplicate_check": "按时间排序后检查所有同一时间的完整行，并跨批次保持当前时间的记录",
    "output_verification": "完整读取解压后的 CSV，核对列数、时间顺序、行数与逐行内容校验值",
    "customer_status_in_export": "导出字段不包含客户状态，依赖提取时的页面筛选记录",
    "scene_scope_in_export": "页面选择和导出场景的对应关系依赖提取时的筛选记录",
    "ui_count_source_note": "页面总数及其独立查询过程由提取记录提供",
}
if archive_dir is not None:
    summary["archive_manifest"] = str(archive_manifest)
write_new_json(validation_partial, summary)

if archive_dir is not None:
    updated_manifest = {**manifest, "batches": final_batches}
    write_new_json(manifest_partial, updated_manifest)
    for info, report_partial, target in zip(sources, report_partials, archive_targets):
        report = {**info["report"], **manifest_scope, "source": str(target), "download_path": str(info["path"])}
        write_new_json(report_partial, report)
    require(manifest_path.read_bytes() == manifest_bytes, "清单在处理过程中发生变化")
    for info, report_path, target in zip(sources, report_paths, archive_targets):
        current = info["path"].stat()
        original = info["stat"]
        require((current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) == (original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns), f"源文件在处理过程中发生变化：{info['path']}")
        require(report_path.read_bytes() == info["report_bytes"], f"单批报告在处理过程中发生变化：{report_path}")
        require(not os.path.lexists(target), f"归档目标已存在：{target}")
    for info, target in zip(sources, archive_targets):
        os.link(info["path"], target)
    for report_partial, archived_report in zip(report_partials, archive_reports):
        publish_new(report_partial, archived_report)
    publish_new(manifest_partial, archive_manifest)

publish_new(output_partial, output)
publish_new(validation_partial, validation_path)
if archive_dir is not None:
    for info, target in zip(sources, archive_targets):
        require(os.path.samefile(info["path"], target), f"归档文件与源文件不一致：{target}")

print(json.dumps({"csv": str(output), "validation": str(validation_path), "rows": actual_rows, "days": len(days), "batches": len(final_batches), "scenes": dict(scenes)}, ensure_ascii=False))
