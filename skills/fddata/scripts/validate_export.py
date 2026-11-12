import argparse
import collections
import hashlib
import json
import os
from pathlib import Path

import openpyxl

from fddata_common import HEADERS, load_scope, parse_time, require


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


parser = argparse.ArgumentParser()
parser.add_argument("file", type=Path)
parser.add_argument("--expected", type=int, required=True)
parser.add_argument("--start", required=True)
parser.add_argument("--end", required=True)
parser.add_argument("--started-ms", type=int)
parser.add_argument("--scope", type=Path)
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()

require(args.expected >= 0, "expected 须为非负整数")
require(args.started_ms is None or args.started_ms >= 0, "started-ms 须为非负整数")
start = parse_time(args.start)
end = parse_time(args.end, end_of_day=True)
require(start <= end, "请求开始时间晚于结束时间")
scope = load_scope(args.scope)
require(args.file.is_file(), f"源文件不存在：{args.file}")
require(args.report.parent.is_dir(), f"报告目录不存在：{args.report.parent}")
require(not os.path.lexists(args.report), f"报告文件已存在：{args.report}")

workbook = openpyxl.load_workbook(args.file, read_only=True, data_only=True)
sheet = workbook["生成记录"]
declared_dimensions = sheet.calculate_dimension()
sheet.reset_dimensions()
iterator = sheet.iter_rows(values_only=True)
headers = next(iterator, ())
require(list(headers) == HEADERS, "导出列结构发生变化，请现场核查")
rows = list(iterator)
require(all(len(row) == len(HEADERS) for row in rows), "导出行列数发生变化，请现场核查")
require(len(rows) == args.expected, f"导出行数与页面总数不一致：{len(rows)} / {args.expected}")
require(len(set(rows)) == len(rows), "存在完全相同的重复行")
records = [dict(zip(headers, row)) for row in rows]
scenes = collections.Counter(record["生成场景"] for record in records)
require(set(scenes).issubset(scope["allowed_export_scenes"]), f"记录包含范围之外的场景：{set(scenes) - set(scope['allowed_export_scenes'])}")
times = [parse_time(record["时间"]) for record in records]
require(all(start <= value <= end for value in times), "记录时间超出筛选范围")
for record in records:
    if record["配置项"] not in (None, ""):
        json.loads(record["配置项"])

summary = {
    "source": str(args.file.resolve()),
    "sheet": sheet.title,
    "declared_dimensions": declared_dimensions,
    "headers": headers,
    "requested_start": start.isoformat(sep=" "),
    "requested_end": end.isoformat(sep=" "),
    **scope,
    "customer_status_in_export": "导出字段不包含客户状态，依赖导出前的页面筛选确认",
    "expected_rows_ui": args.expected,
    "actual_rows": len(rows),
    "exact_duplicate_rows": len(rows) - len(set(rows)),
    "unique_id_values": len({record["id"] for record in records}),
    "unique_id_note": "id存在重复值，禁止只按此字段去重",
    "scenes": dict(scenes),
    "days": dict(sorted(collections.Counter(value.date().isoformat() for value in times).items())),
    "states": dict(collections.Counter(record["状态"] for record in records)),
    "minimum_time": min(times).isoformat(sep=" ") if times else None,
    "maximum_time": max(times).isoformat(sep=" ") if times else None,
    "size_bytes": args.file.stat().st_size,
    "sha256": file_sha256(args.file),
}
if args.started_ms is not None:
    summary["started_ms"] = args.started_ms
    summary["seconds_to_file"] = round(args.file.stat().st_mtime - args.started_ms / 1000, 3)
workbook.close()
with args.report.open("x", encoding="utf-8") as handle:
    json.dump(summary, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(json.dumps(summary, ensure_ascii=False))
