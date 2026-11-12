import datetime
import json
from pathlib import Path


HEADERS = [
    "id", "生成场景", "用户", "企业", "时间", "输入", "提示词", "输出", "配置项",
    "耗时", "扣点", "状态", "失败原因", "下载状态", "备注",
]
DEFAULT_SCOPE = {
    "customer_filter_ui": ["在约", "体验"],
    "scene_selection_ui": [
        "灵感成款-快速", "灵感成款-Agent", "自由改款", "自由创作", "图生视频", "首尾帧",
        "多图参考", "故事版", "故事版视频", "动作跟随", "全能替换", "实况图",
    ],
    "allowed_export_scenes": [
        "灵感成款", "灵感成款-快速", "灵感成款-Agent", "自由改款", "自由创作", "图生视频",
        "首尾帧", "多图参考", "故事版", "故事版视频", "故事板", "故事板视频", "动作跟随",
        "全能替换", "实况图",
    ],
}
SCOPE_FIELDS = tuple(DEFAULT_SCOPE)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse_time(value, end_of_day=False):
    value = str(value)
    if len(value) == 10:
        date = datetime.date.fromisoformat(value)
        require(date.isoformat() == value, f"日期格式须为 YYYY-MM-DD：{value}")
        return datetime.datetime.combine(date, datetime.time(23, 59, 59) if end_of_day else datetime.time())
    result = datetime.datetime.fromisoformat(value)
    require(
        result.tzinfo is None and result.microsecond == 0
        and len(value) == 19 and value.replace("T", " ") == result.isoformat(sep=" "),
        f"时间须为 YYYY-MM-DD HH:MM:SS，且不带时区：{value}",
    )
    return result


def validate_scope(scope, label):
    require(isinstance(scope, dict) and set(scope) == set(SCOPE_FIELDS), f"{label}须包含三个范围字段：{', '.join(SCOPE_FIELDS)}")
    for field in SCOPE_FIELDS:
        values = scope[field]
        require(isinstance(values, list) and values, f"{label}的 {field} 须为非空数组")
        require(all(isinstance(value, str) and value.strip() == value and value for value in values), f"{label}的 {field} 须为非空字符串数组")
        require(len(values) == len(set(values)), f"{label}的 {field} 存在重复值")
    return scope


def load_scope(path):
    if path is None:
        return validate_scope(DEFAULT_SCOPE, "默认范围")
    return validate_scope(json.loads(Path(path).read_text(encoding="utf-8")), f"范围文件 {path}")


def scopes_equal(first, second):
    return all(set(first[field]) == set(second[field]) for field in SCOPE_FIELDS)


def scope_from_record(record, fallback=None, label="报告"):
    present = {field: record[field] for field in SCOPE_FIELDS if field in record}
    missing = set(SCOPE_FIELDS) - set(present)
    require(not missing or fallback is not None, f"{label}缺少范围字段 {sorted(missing)}，须显式提供 --scope")
    scope = {field: present[field] if field in present else fallback[field] for field in SCOPE_FIELDS}
    validate_scope(scope, label)
    if fallback is not None:
        require(scopes_equal(scope, fallback), f"{label}范围与提供的范围不一致")
    return scope
