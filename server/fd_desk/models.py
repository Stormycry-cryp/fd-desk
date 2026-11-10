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
    rerunDailyBudget: float = Field(ge=0)
    rerunCurrency: Literal["CNY", "USD"]


class SettingsPatch(Input):
    thresholds: LineThresholds | None = None
    alerts: AlertParams | None = None
    pools: PoolParams | None = None
    clusters: ClusterParams | None = None
    excluded: Excluded | None = None
    siteBaseUrl: str | None = None
    rerunDailyPointLimit: int | None = None
    pushDailyLimit: int | None = None
    rerunDailyBudget: float | None = None
    rerunCurrency: Literal["CNY", "USD"] | None = None

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


Slot = Literal["mon", "wed", "fri"]
TouchStatus = Literal["draft", "assigned", "sent", "replied", "closed"]


class Offer(Input):
    kind: Literal["template", "comparison", "tip", "question"]
    draftId: str | None = None
    rerunId: str | None = None
    link: str | None = None
    text: str | None = None


class TouchCreate(Input):
    line: Line
    week: str
    slot: Slot
    enterprise: str
    goal: Pool
    evidence: list[str] = Field(default_factory=list)
    offer: Offer | None = None
    draft: str = ""
    owner: str | None = None
    source: Source


class TouchPatch(Input):
    slot: Slot | None = None
    goal: Pool | None = None
    evidence: list[str] | None = None
    offer: Offer | None = None
    draft: str | None = None
    owner: str | None = None
    channel: str | None = None
    status: TouchStatus | None = None
    reply: str | None = None
    suggested: bool | None = None
    source: Source = "manual"

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, name) is None for name in self.model_fields_set - {"owner", "channel", "reply"}):
            raise ValueError("触达字段不能设置为 null")
        return self


class DraftCreate(Input):
    line: Line
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=50000)
    slots: list[str]
    scene: str | None = None
    clusterId: str | None = None
    scope: Literal["owner", "general"] | None = None
    source: Source


class DraftPatch(Input):
    title: str | None = Field(None, min_length=1, max_length=200)
    prompt: str | None = Field(None, min_length=1, max_length=50000)
    slots: list[str] | None = None
    status: Literal["draft", "tested", "published", "pushed"] | None = None
    fdTemplateId: int | None = Field(None, ge=1)
    fdTemplateSource: Literal["official", "managed", "shared"] | None = None
    scope: Literal["owner", "general"] | None = None
    pushedTo: list[str] | None = None
    source: Source = "manual"

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, name) is None for name in self.model_fields_set - {"fdTemplateId", "fdTemplateSource"}):
            raise ValueError("草稿字段不能设置为 null")
        return self


class FindingRule(Input):
    kind: Literal["mismatch"]
    intent: str
    model: str


class FindingCreate(Input):
    line: Line
    claim: str = Field(min_length=1)
    verdict: Literal["confirmed", "refuted", "open"]
    evidence: str
    sample: str
    caveat: str | None = None
    rule: FindingRule | None = None


class FindingPatch(Input):
    line: Line | None = None
    claim: str | None = Field(None, min_length=1)
    verdict: Literal["confirmed", "refuted", "open"] | None = None
    evidence: str | None = None
    sample: str | None = None
    caveat: str | None = None
    rule: FindingRule | None = None

    @model_validator(mode="after")
    def validate_fields(self):
        if any(getattr(self, name) is None for name in self.model_fields_set - {"caveat", "rule"}):
            raise ValueError("结论字段不能设置为 null")
        return self


class PushCreate(Input):
    enterprises: list[str] = Field(min_length=1, max_length=100)
    touchId: str | None = None
    notify: bool = True


class PushConfirm(Input):
    receiverUserIds: list[int] = Field(min_length=1, max_length=100)


class RerunCreate(Input):
    sourceRowKey: str
    prompt: str = Field(min_length=1, max_length=50000)
    model: str = Field(min_length=1)


class AnalysisCreate(Input):
    line: Line
    week: str


class DraftPublish(Input):
    sceneId: int = Field(ge=1)
    model: str = Field(min_length=1)
    templateImg: str | None = None
