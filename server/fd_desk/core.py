import hashlib
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "spec"
ZONE = ZoneInfo("Asia/Shanghai")
LINES = ("inspiration", "video")
LEVELS = ("heavy", "medium", "burst", "light", "trial")
POOLS = ("retain", "recall", "help", "keep", "nurture", "convert")
Line = Literal["inspiration", "video"]
Source = Literal["rule", "agent", "manual"]


class ApiProblem(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any):
        self.status = status
        self.payload = {"code": code, "message": message, **extra}
        super().__init__(message)


def now() -> str:
    return datetime.now(ZONE).isoformat(timespec="seconds")


def digest(value: str, length: int = 40) -> str:
    return hashlib.sha1(value.encode()).hexdigest()[:length]


def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def read_spec(name: str) -> Any:
    return json.loads((SPEC / name).read_text(encoding="utf-8"))


def week_key(value: str | date | datetime) -> str:
    day = date.fromisoformat(value[:10]) if isinstance(value, str) else value
    return (day - timedelta(days=day.weekday())).strftime("%Y-%m-%d")


def validate_week(value: str) -> str:
    try:
        day = date.fromisoformat(value)
    except ValueError:
        raise ApiProblem(422, "invalid_week", "周日期必须使用 YYYY-MM-DD 格式") from None
    if day.isoformat() != value or day.weekday() != 0:
        raise ApiProblem(422, "invalid_week", "周日期必须是星期一")
    return value


def shift_week(week: str, offset: int) -> str:
    return (date.fromisoformat(week) + timedelta(weeks=offset)).isoformat()


def ratio(numerator: float, denominator: float) -> float:
    return float(numerator / denominator) if denominator else 0.0


def data_path(value: str | Path | None = None) -> Path:
    path = Path(value or os.environ.get("FD_DESK_DATA_DIR", ROOT / "data")).resolve()
    if not path.is_relative_to(ROOT / "data"):
        raise ValueError("数据目录必须位于项目 data/ 内")
    path.mkdir(parents=True, exist_ok=True)
    return path
