from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from . import analysis
from .codex_runner import execute, runtime
from .core import ApiProblem, dump, now, validate_week
from .models import DraftCreate
from .workflow import authored


class EnterpriseUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterpriseId: str
    summary: str
    nextAction: str


class TouchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    touchId: str
    draft: str


class DraftProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    clusterId: str
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=50000)
    slots: list[str]


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprises: list[EnterpriseUpdate] = Field(max_length=100)
    touches: list[TouchUpdate] = Field(max_length=100)
    templates: list[DraftProposal] = Field(max_length=20)


class Automation:
    def __init__(self, workflow):
        self.workflow = workflow
        self.store = workflow.store
        self.engine = workflow.engine

    def create(self, body):
        runtime(self.store.directory)
        validate_week(body.week)
        item = {"id": uuid4().hex, "state": "queued", "error": None, "line": body.line, "week": body.week, "createdAt": now()}
        self.store.save("automation_jobs", item)
        return item

    def execute(self, key):
        item = self.store.item("automation_jobs", key)
        with self.store.lock:
            if item["state"] != "queued":
                return
            item["state"] = "running"
            self.store.save("automation_jobs", item)
        try:
            self.analyze(item)
        except ApiProblem as error:
            with self.store.lock:
                item.update(state="failed", error=error.payload)
                self.store.save("automation_jobs", item)
            raise
        finally:
            if item["state"] == "running":
                with self.store.lock:
                    item.update(state="failed", error={"code": "analysis_failed", "message": "分析任务未完成，请核对本次任务的输出与服务记录"})
                    self.store.save("automation_jobs", item)

    def analyze(self, item):
        key = item["id"]
        directory = self.store.directory / "automation" / key
        directory.mkdir(parents=True, exist_ok=False)
        with self.store.lock:
            line, week = item["line"], item["week"]
            rows = self.engine.base_roster(line, week)
            clusters = analysis.clusters(self.engine, line, week, candidate=True)[:20]
            touches = self.workflow.board(line, week)
            touch_items = touches["suggestions"] + [touch for values in touches["slots"].values() for touch in values]
            safe_rows = [{key: row[key] for key in ("tasks", "points", "activeDays", "downloadRate", "comparable", "pool", "movement", "inspiration", "video")} | {"enterpriseId": row["enterprise"]["id"]} for row in rows if not row["excluded"]]
            payload = {"line": line, "week": week, "enterprises": safe_rows,
                "clusters": [{key: cluster[key] for key in ("id", "sample", "uses", "downloadRate", "intent")} for cluster in clusters],
                "touches": [{"id": touch["id"], "enterpriseId": touch["enterprise"]["id"], "evidence": touch["evidence"], "draft": touch["draft"]["text"]} for touch in touch_items]}
        source = directory / "input.json"
        source.write_text(dump(payload))
        schema = directory / "schema.json"
        schema.write_text(dump(AnalysisResult.model_json_schema()))
        prompt = directory / "prompt.txt"
        prompt.write_text(f"读取 {source}，根据真实指标撰写简洁中文企业小结、下一步、触达话术和模板草稿。只使用输入中的 ID 和证据，不添加客户背景、合同状态或未经证实的因果。下载表示结果被保存，不能称为最终采用。企业数量较多时优先处理掉量、卡住、召回和可复用提示词。模板保留原任务需求和图片槽位，不混合不同来源的客户素材。只输出符合 schema 的 JSON。不得调用网络、访问浏览器、发送通知、生图、修改源码或数据库。无需输出的数组使用空数组。")
        result = AnalysisResult.model_validate(execute(self.store.directory, prompt, schema, directory, timeout=3600))
        enterprise_ids = {row["enterpriseId"] for row in safe_rows}
        touch_ids = {touch["id"] for touch in touch_items}
        cluster_ids = {cluster["id"] for cluster in clusters}
        if any(update.enterpriseId not in enterprise_ids for update in result.enterprises) or any(update.touchId not in touch_ids for update in result.touches) or any(proposal.clusterId not in cluster_ids for proposal in result.templates):
            raise ApiProblem(422, "invalid_analysis_reference", "模型输出引用了输入范围之外的记录")
        proposals = [DraftCreate(line=line, title=proposal.title, prompt=proposal.prompt, slots=proposal.slots, clusterId=proposal.clusterId, source="agent") for proposal in result.templates]
        with self.store.lock:
            existing = {draft.get("clusterId") for draft in self.workflow.drafts(line)}
            with self.store.connection() as conn:
                for update in result.enterprises:
                    for scope, field_key, text in (("summary", update.enterpriseId, update.summary), ("next_action", f"{update.enterpriseId}:{line}", update.nextAction)):
                        current = self.store.authored_in(conn, scope, field_key)
                        if current is None or current["source"] != "manual":
                            self.store.write_authored(conn, scope, field_key, text, "agent")
                for update in result.touches:
                    touch = self.store.item("touches", update.touchId)
                    if touch["draft"]["source"] != "manual" and touch["suggested"]:
                        touch["draft"] = authored(update.draft, "agent")
                        self.store.save("touches", touch, conn)
                for proposal in proposals:
                    if proposal.clusterId not in existing:
                        self.workflow.create_draft(proposal, conn=conn)
                        existing.add(proposal.clusterId)
                self.store.save("automation_jobs", {**item, "state": "done"}, conn)
            item["state"] = "done"
            self.store.changed()
