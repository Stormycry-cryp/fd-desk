from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .core import Line, Source

Kind = Literal["customer", "internal", "agency", "unknown"]
Contract = Literal["active", "trial", "internal", "expired", "unknown"]
Pattern = Literal["retry", "tweak", "batch", "adapt", "rework", "new", "agent", "none"]
AlertKind = Literal["drop", "vanished", "stuck", "cold_start", "mismatch", "waste", "failures", "reuse", "surge"]
Pool = Literal["retain", "recall", "help", "keep", "nurture", "convert"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Owner(Input):
    sales: str | None = None
    afterSales: str | None = None


class EnterprisePatch(Input):
    kind: Kind | None = None
    contract: Contract | None = None
    owner: Owner | None = None
    summary: str | None = None
    source: Source | None = None

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("企业字段不能设置为 null")
        if self.summary is not None and self.source is None:
            raise ValueError("写入小结必须指定 source")
        return self


class NextAction(Input):
    line: Line
    text: str
    source: Source


class NoteInput(Input):
    text: str = Field(min_length=1, max_length=10000)


class AlertPatch(Input):
    dismissed: bool


class Tier(Input):
    tasks: int = Field(ge=1)
    days: int = Field(ge=1, le=7)


class Thresholds(Input):
    heavy: Tier
    medium: Tier
    moverBase: int = Field(ge=1)

    @model_validator(mode="after")
    def validate_tiers(self):
        if self.heavy.tasks < self.medium.tasks or self.heavy.days < self.medium.days:
            raise ValueError("重度门槛不能低于中度门槛")
        return self


class StuckParams(Input):
    minTasks: int = Field(ge=1)
    stuckShare: float = Field(ge=0, le=1)
    downloadRate: float = Field(ge=0, le=1)


class ColdParams(Input):
    minTasks: int = Field(ge=1)


class WasteParams(Input):
    minPoints: int = Field(ge=1)
    downloadRate: float = Field(ge=0, le=1)


class FailureParams(Input):
    minCount: int = Field(ge=1)


class ReuseParams(Input):
    minUses: int = Field(ge=1)


class AlertParams(Input):
    stuck: StuckParams
    coldStart: ColdParams
    mismatch: ColdParams
    waste: WasteParams
    failures: FailureParams
    reuse: ReuseParams


class HelpParams(Input):
    stuckShare: float = Field(ge=0, le=1)
    downloadRate: float = Field(ge=0, le=1)


class RecallParams(Input):
    minPeakTasks: int = Field(ge=1)


class UnreliableParams(Input):
    minTasks: int = Field(ge=1)
    downloadRate: float = Field(ge=0, le=1)


class PoolParams(Input):
    help: HelpParams
    recall: RecallParams
    unreliable: UnreliableParams


class ClusterParams(Input):
    similarity: float = Field(ge=0, le=1)
    candidateMinUses: int = Field(ge=1)


class LineThresholds(Input):
    inspiration: Thresholds
    video: Thresholds


class Excluded(Input):
    inspiration: list[str]
    video: list[str]


class Settings(Input):
    thresholds: LineThresholds
    alerts: AlertParams
    pools: PoolParams
    clusters: ClusterParams
    excluded: Excluded
    siteBaseUrl: str = Field(pattern=r"^https?://[^\s]+$")
    rerunDailyPointLimit: int = Field(ge=0)
    pushDailyLimit: int = Field(ge=0)


class SettingsPatch(Input):
    thresholds: LineThresholds | None = None
    alerts: AlertParams | None = None
    pools: PoolParams | None = None
    clusters: ClusterParams | None = None
    excluded: Excluded | None = None
    siteBaseUrl: str | None = None
    rerunDailyPointLimit: int | None = None
    pushDailyLimit: int | None = None

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("设置字段不能设置为 null")
        return self


class ReportInput(Input):
    week: str
    done: str | None = None
    next: str | None = None
    source: Source

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError("周报字段不能设置为 null")
        return self
