export type Scope = "all" | Line
export type Confidence = "high" | "medium" | "low"
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled"
export type JobKind = "facts" | "profiles" | "movement" | "opportunities" | "followups" | "monitor" | "draft_write" | "finding_recheck" | "record_analysis" | "export"
export type PipelineJobKind = "facts" | "profiles" | "movement" | "opportunities" | "followups" | "monitor"
export type PageKey = "week" | "customers" | "enterprise" | "templates" | "playground" | "followups" | "analysis" | "data" | "export"
export type ProfileTab = "profile" | "data" | "tasks" | "notes"

export interface Job {
  id: Id
  kind: JobKind
  state: JobState
  progress: { done: number; total: number }
  result: { draftId?: Id; movementId?: Id; analysisId?: Id; url?: string } | null
  error: ApiError | null
  createdAt: Timestamp
  finishedAt: Timestamp | null
}
export interface Locator {
  page: PageKey
  line?: Line
  week?: WeekKey
  enterprise?: Id
  tab?: ProfileTab
  section?: string
  filters?: Record<string, string>
  task?: Id
  draft?: Id
  run?: Id
}
export interface Evidence { label: string; value: string | null; target: Locator | null }
export interface Retention { base: number; kept: number; rate: number | null }
export type TagDimension = "category" | "role" | "purpose" | "rhythm" | "skill"
export type RhythmKind = "continuous" | "batch" | "occasional"
export type ProfileState = "none" | "facts_only" | "ready" | "stale" | "generating" | "failed"
export type InsightKey = "business" | "usage" | "workflow" | "skill" | "pain" | "opportunity"
export interface ProfileTag { dimension: TagDimension; value: string; source: Source }
export interface TagOption { dimension: TagDimension; values: { value: string; count: number }[] }
export interface ProfileFacts {
  scope: Scope
  totals: { tasks: number; recentTasks: number; points: number; recentPoints: number; downloadRate: number | null; recentDownloadRate: number | null; activeWeeks: number; stableWeeks: number; firstSeenAt: Timestamp; lastActiveAt: Timestamp | null }
  weekly: WeekPoint[]
  hours: number[][]
  primeHours: { from: number; to: number } | null
  weekendShare: number
  scenes: { scene: string; line: Line | "other"; tasks: number; share: number; recentShare: number }[]
  intents: { key: string; tasks: number; share: number; downloadRate: number | null }[]
  models: { model: string; tasks: number; share: number; downloadRate: number | null; firstUsedAt: DateKey; lastUsedAt: DateKey }[]
  inputs: { imageCounts: { count: number; share: number }[]; promptLengthMedian: number; ratios: { key: string; share: number }[]; resolutions: { key: string; share: number }[] }
  quality: { stuckShare: number | null; batchShare: number | null; failed: number; failures: { category: FailureCategory; count: number }[]; unresolvedChains: number }
  rhythm: { kind: RhythmKind; batchGapWeeks: number | null; currentGapWeeks: number; trend: TrendKind | null }
  members: { id: Id; name: string; phone: string; tasks: number; downloadRate: number | null; lastActiveAt: Timestamp }[]
}
export interface ProfileInsight { id: Id; key: InsightKey; text: string; confidence: Confidence; evidence: Evidence[]; opportunityId: Id | null }
export type AnnotationKind = "followup" | "special" | "other"
export interface AnnotationAnchor { block: string; insightId: Id | null; quote: string | null; stale: boolean }
export interface AnnotationEntry { id: Id; text: string; createdAt: Timestamp; editedAt: Timestamp | null }
export interface Annotation { id: Id; enterprise: EnterpriseRef; kind: AnnotationKind | null; anchor: AnnotationAnchor | null; entries: AnnotationEntry[]; resolved: boolean; createdAt: Timestamp; updatedAt: Timestamp }
export interface MovementAnalysis { id: Id; enterprise: EnterpriseRef; line: Line; week: WeekKey; direction: "up" | "down"; change: Pair; headline: string; reasons: { text: string; evidence: Evidence }[]; action: string | null; confidence: Confidence; trigger: "auto" | "manual"; state: JobState; error: ApiError | null; createdAt: Timestamp }
export interface Profile { enterprise: EnterpriseRef; adminPhone: string; state: ProfileState; version: number; generatedAt: Timestamp | null; headline: Authored | null; insights: ProfileInsight[]; tags: ProfileTag[]; change: string | null; facts: Record<Scope, ProfileFacts | null>; samples: Task[]; annotations: Annotation[]; movements: MovementAnalysis[] }
export interface ProfileVersion { version: number; generatedAt: Timestamp; headline: string | null; change: string | null }
export interface RosterExtra { enterpriseId: Id; profileState: ProfileState; headline: string | null; tags: ProfileTag[]; annotationCount: number; lastAnnotation: { text: string; at: Timestamp; kind: AnnotationKind | null } | null; movement: { id: Id; direction: "up" | "down"; headline: string; state: JobState } | null }
export type TemplateKind = "official" | "custom"
export type Priority = "high" | "medium" | "low"
export type OpportunityState = "open" | "adopted" | "shelved" | "dismissed"
export type TemplateState = "draft" | "tried" | "exported" | "live" | "retired"
export type Mark = "better" | "same" | "worse"
export interface Opportunity { id: Id; line: Line; kind: TemplateKind; target: EnterpriseRef | null; title: string; value: string; reason: string; priority: Priority; evidence: { uses: number; enterprises: number; weeks: number; downloadRate: number | null; peerDownloadRate: number | null; retryShare: number | null; officialCovered: boolean }; clusterIds: Id[]; sampleTasks: Task[]; state: OpportunityState; draftId: Id | null; week: WeekKey; createdAt: Timestamp }
export interface TemplateVariable { name: string; default: string; options: string[] }
export interface TemplateSlot { name: string; required: boolean; requirement: string }
export interface TemplateContent { title: string; task: string; prompt: string; variables: TemplateVariable[]; slots: TemplateSlot[]; model: string | null; ratio: string | null; resolution: string | null; fits: string; avoids: string }
export interface TemplateVersion { version: number; content: TemplateContent; source: Source; note: string | null; createdAt: Timestamp }
export type CheckKey = "identity" | "slots" | "variables" | "length" | "duplicate"
export interface TemplateReview { checks: { key: CheckKey; ok: boolean; message: string | null }[]; trial: { runId: Id; cases: number; usable: number; better: number; same: number; worse: number } | null; comment: Authored | null; suggestedState: TemplateState | null }
export interface Template { id: Id; line: Line; kind: TemplateKind; target: EnterpriseRef | null; scene: string | null; state: TemplateState; current: TemplateVersion; versions: TemplateVersion[]; cover: { input: Media | null; output: Media } | null; origin: { opportunityId: Id | null; clusterIds: Id[]; uses: number; enterprises: number; downloadRate: number | null; originalPrompt: string | null }; review: TemplateReview; fdTemplateId: number | null; exportedAt: Timestamp | null; liveAt: Timestamp | null; createdAt: Timestamp; updatedAt: Timestamp }
export type ReviseKind = "shorter" | "general" | "specific" | "from_trial" | "custom"
export interface TemplateMonitor { templateId: Id; title: string; kind: TemplateKind; target: EnterpriseRef | null; fdTemplateId: number | null; liveAt: Timestamp | null; estimated: boolean; weekly: { week: WeekKey; uses: number; enterprises: number; downloadRate: number | null }[]; baseline: { uses: number; downloadRate: number | null } | null; targetEffect: { retryShare: { before: number | null; after: number | null }; downloadRate: { before: number | null; after: number | null } } | null; revisions: { version: number; at: Timestamp }[] }
export interface TrialArm { id: Id; label: string; prompt: string; model: string; templateVersion: number | null }
export interface TrialCell { armId: Id; state: JobState; outputs: Media[]; cost: number | null; error: ApiError | null; mark: Mark | null; usable: boolean | null }
export interface TrialCase { id: Id; task: Task; cells: TrialCell[] }
export interface TrialRun { id: Id; templateId: Id | null; arms: TrialArm[]; cases: TrialCase[]; state: JobState; cost: { estimated: number; spent: number; currency: "CNY" | "USD" }; summary: { armId: Id; done: number; total: number; better: number; same: number; worse: number; usable: number }[]; fidelity: { level: "exact" | "close" | "direct"; note: string }; createdAt: Timestamp }
export interface TrialBudget { currency: "CNY" | "USD"; dailyLimit: number; spentToday: number; maxCases: number; maxArms: number; models: { id: string; label: string; fdModels: string[]; unitCost: number }[] }
export type FollowupState = "todo" | "contacted" | "replied" | "shelved"
export type AttachmentKind = "template" | "opportunity" | "chain" | "movement" | "trial"
export interface Followup { id: Id; line: Line; week: WeekKey; enterprise: EnterpriseRef; goal: Pool; reason: string; evidence: Evidence[]; attachments: { kind: AttachmentKind; id: Id; label: string; target: Locator }[]; script: Authored; state: FollowupState; reply: string | null; contactedAt: Timestamp | null; outcome: TouchOutcome | null; suggested: boolean; rank: number | null }
export interface PipelineStep { kind: JobKind; state: JobState; progress: { done: number; total: number }; detail: string | null; error: ApiError | null; startedAt: Timestamp | null; finishedAt: Timestamp | null }
export interface PipelineRun { id: Id; trigger: "collector" | "manual"; week: WeekKey | null; steps: PipelineStep[]; startedAt: Timestamp; finishedAt: Timestamp | null }
export interface AskContext { page: PageKey | "report"; line: Line; week: WeekKey | null; excluded: boolean; enterprise: Id | null; tab: string | null; filters: Record<string, string>; selection: { kind: "chart" | "row" | "cell" | "insight" | "template"; label: string; data: Record<string, string | number | null> } | null }
export type AskBlock =
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string; delta: string | null; target: Locator | null }
  | { type: "chart"; kind: "line" | "bar"; title: string; points: { label: string; value: number | null }[]; target: Locator | null }
  | { type: "list"; title: string | null; items: { label: string; value: string | null; target: Locator | null }[] }
  | { type: "clarify"; question: string; options: string[] }
export interface AskMessage { id: Id; role: "user" | "assistant"; text: string | null; blocks: AskBlock[]; context: AskContext | null; state: "streaming" | "done" | "failed"; createdAt: Timestamp }
export interface AskSession { id: Id; title: string; messages: AskMessage[]; createdAt: Timestamp; updatedAt: Timestamp }
export type AskEvent = { type: "status"; text: string } | { type: "delta"; index: number; text: string } | { type: "block"; index: number; block: AskBlock } | { type: "done"; message: AskMessage } | { type: "error"; error: ApiError }
export type ExportKind = "roster" | "annotations" | "movements" | "templates_official" | "templates_custom" | "opportunities" | "monitor" | "followups" | "analysis_matrix" | "analysis_failures" | "tasks" | "records"
export interface ExportItem { kind: ExportKind; params: Record<string, string> }
export interface FindingRecheck { at: Timestamp; verdict: Verdict; evidence: string; sample: string; changed: boolean }
export interface ContractAdditions {
  Task: { fdUrl: string | null }
  Overview: { retention: Retention | null }
  HistoryPoint: { retention: number | null }
  Finding: { rechecks: FindingRecheck[] }
  Settings: { pipeline: Settings["pipeline"]; trials: Settings["trials"]; followups: Settings["followups"]; trends: Settings["trends"] }
  Removed: ["/api/drafts", "/api/pushes", "/api/fd-account/check", "/api/reruns", "/api/automation/analysis"]
}

export type TrendKind = "churned" | "sliding" | "fading"
export interface Trend {
  enterpriseId: Id
  line: Line
  kind: TrendKind
  weeks: number
  from: number
  to: number
  peakWeek: WeekKey | null
  series: { week: WeekKey; tasks: number }[]
}
export type RecordResult = "downloaded" | "not_downloaded" | "failed"
export type RecordSort = "newest" | "oldest"
export type RecordNoted = "any" | "none"
export interface RecordQuery {
  enterprise: Id
  scope: Scope
  from?: DateKey
  to?: DateKey
  result?: RecordResult
  intent?: string
  mode?: string
  model?: string
  user?: Id
  pattern?: Pattern
  noted?: RecordNoted
  q?: string
  sort?: RecordSort
  offset?: number
  limit?: number
}
export interface RecordRow { task: Task; annotationCount: number; lastAnnotation: { text: string; at: Timestamp } | null; sampleReason: SampleStratum | null }
export interface RecordFacet { key: string; count: number }
export interface RecordPage {
  items: RecordRow[]
  total: number
  facets: { lines: { line: Line; count: number }[]; results: { result: RecordResult; count: number }[]; intents: RecordFacet[]; modes: RecordFacet[]; models: RecordFacet[]; users: { id: Id; name: string; count: number }[]; noted: number }
  range: { from: DateKey; to: DateKey } | null
}
export type SampleStratum = "stuck_tail" | "not_downloaded" | "downloaded" | "failed" | "batch" | "agent" | "rare_intent" | "new_model" | "member" | "recent" | "annotated"
export interface SampleRequest { enterprise: Id; scope: Scope; from?: DateKey; to?: DateKey; size?: number; seed?: number; exclude?: Id[] }
export interface SampleResult {
  seed: number
  items: RecordRow[]
  coverage: { stratum: SampleStratum; picked: number; available: number }[]
  dims: { intents: number; models: number; users: number; weeks: number; lines: Line[] }
}
export interface RecordFinding { id: Id; text: string; confidence: Confidence; rowKeys: Id[]; evidence: Evidence[] }
export interface RecordAnalysis {
  id: Id
  enterprise: EnterpriseRef
  rowKeys: Id[]
  records: RecordRow[]
  question: string | null
  state: JobState
  headline: string
  findings: RecordFinding[]
  perRecord: { rowKey: Id; verdict: "good" | "ok" | "bad"; note: string }[]
  suggestions: string[]
  error: ApiError | null
  createdAt: Timestamp
  finishedAt: Timestamp | null
}
export interface ApiRecords {
  "GET /api/trends": { query: { line: Line; week: WeekKey }; response: Trend[] }
  "GET /api/records": { query: RecordQuery; response: RecordPage }
  "POST /api/records/sample": { body: SampleRequest; response: SampleResult }
  "GET /api/records/analyses": { query: { enterprise: Id }; response: RecordAnalysis[] }
  "POST /api/records/analyses": { body: { enterprise: Id; rowKeys: Id[]; question?: string }; response: RecordAnalysis }
  "GET /api/records/analyses/:id": { response: RecordAnalysis }
  "DELETE /api/records/analyses/:id": { response: null }
  "GET /api/records/export": { query: { enterprise: Id; scope: Scope; rowKeys?: string; from?: DateKey; to?: DateKey }; response: Blob }
}

export interface ApiNext extends ApiRecords {
  "POST /api/profiles/init": { response: PipelineRun }
  "GET /api/profiles/:id": { response: Profile }
  "GET /api/profiles": { query: { ids: string }; response: Profile[] }
  "GET /api/profiles/:id/versions": { response: ProfileVersion[] }
  "POST /api/profiles/:id/refresh": { response: Job }
  "PUT /api/profiles/:id/tags": { body: { dimension: TagDimension; value: string | null }; response: Profile }
  "PUT /api/profiles/:id/headline": { body: { text: string }; response: Profile }
  "GET /api/profiles/roster": { query: { line: Line; week: WeekKey }; response: RosterExtra[] }
  "GET /api/tags": { query: { line?: Line }; response: TagOption[] }
  "GET /api/annotations": { query: { enterprise?: Id; from?: DateKey; to?: DateKey; resolved?: boolean }; response: Annotation[] }
  "POST /api/annotations": { body: { enterprise: Id; text: string; kind?: AnnotationKind; anchor?: { block: string; insightId?: Id; quote?: string } }; response: Annotation }
  "POST /api/annotations/:id/entries": { body: { text: string }; response: Annotation }
  "PATCH /api/annotations/:id": { body: Partial<{ kind: AnnotationKind | null; resolved: boolean }>; response: Annotation }
  "PATCH /api/annotations/:id/entries/:entryId": { body: { text: string }; response: Annotation }
  "DELETE /api/annotations/:id": { response: null }
  "DELETE /api/annotations/:id/entries/:entryId": { response: Annotation }
  "GET /api/movements": { query: { line: Line; week: WeekKey; trigger?: "auto" | "manual" }; response: MovementAnalysis[] }
  "POST /api/movements": { body: { enterprise: Id; line: Line; week: WeekKey }; response: MovementAnalysis }
  "GET /api/movements/:id": { response: MovementAnalysis }
  "GET /api/templates/opportunities": { query: { line: Line; kind?: TemplateKind; state?: OpportunityState; enterprise?: Id }; response: Opportunity[] }
  "PATCH /api/templates/opportunities/:id": { body: { state: OpportunityState }; response: Opportunity }
  "POST /api/templates/opportunities/refresh": { body: { line: Line; week: WeekKey }; response: Job }
  "GET /api/templates": { query: { line: Line; kind?: TemplateKind; state?: TemplateState; enterprise?: Id }; response: Template[] }
  "GET /api/templates/:id": { response: Template }
  "POST /api/templates": { body: { line: Line; kind: TemplateKind; target?: Id; opportunityId?: Id; clusterIds?: Id[]; content?: Partial<TemplateContent>; write: boolean }; response: { template: Template; job: Job | null } }
  "PATCH /api/templates/:id": { body: Partial<{ kind: TemplateKind; target: Id | null; state: TemplateState; content: TemplateContent; fdTemplateId: number | null; cover: { runId: Id; caseId: Id; armId: Id } | null }>; response: Template }
  "POST /api/templates/:id/revise": { body: { kind: ReviseKind; instruction?: string; runId?: Id }; response: Job }
  "POST /api/templates/:id/restore": { body: { version: number }; response: Template }
  "POST /api/templates/:id/review": { response: Job }
  "DELETE /api/templates/:id": { response: null }
  "GET /api/templates/monitor": { query: { line: Line; kind?: TemplateKind }; response: TemplateMonitor[] }
  "GET /api/trials/budget": { response: TrialBudget }
  "GET /api/trials/candidates": { query: { template?: Id; cluster?: Id; enterprise?: Id; chain?: Id; limit?: number }; response: Task[] }
  "GET /api/trials": { query: { template?: Id; enterprise?: Id }; response: TrialRun[] }
  "POST /api/trials": { body: { templateId?: Id; taskRowKeys: Id[]; arms: { label: string; prompt: string; model: string; templateVersion?: number }[] }; response: TrialRun }
  "GET /api/trials/:id": { response: TrialRun }
  "POST /api/trials/:id/arms": { body: { label: string; prompt: string; model: string; templateVersion?: number }; response: TrialRun }
  "POST /api/trials/:id/cases": { body: { taskRowKeys: Id[] }; response: TrialRun }
  "POST /api/trials/:id/retry": { body: { caseId: Id; armId: Id }; response: TrialRun }
  "PATCH /api/trials/:id/cells": { body: { caseId: Id; armId: Id; mark?: Mark | null; usable?: boolean | null }; response: TrialRun }
  "POST /api/trials/:id/cancel": { response: TrialRun }
  "POST /api/trials/:id/adopt": { body: { armId: Id; cover?: { caseId: Id } }; response: Template }
  "GET /api/trials/:id/media/:caseId/:armId/:name": { response: Blob }
  "GET /api/followups": { query: { line: Line; week: WeekKey }; response: { items: Followup[]; suggestions: Followup[] } }
  "POST /api/followups": { body: { line: Line; week: WeekKey; enterprise: Id; goal: Pool; reason?: string; script?: string }; response: Followup }
  "PATCH /api/followups/:id": { body: Partial<{ goal: Pool; state: FollowupState; script: string; reply: string | null; suggested: boolean; attachments: { kind: AttachmentKind; id: Id }[] }>; response: Followup }
  "DELETE /api/followups/:id": { response: null }
  "GET /api/pipeline": { response: { latest: PipelineRun | null; history: PipelineRun[]; limits: { profilesPerRun: number; concurrency: number }; initialization: { id: string; state: "running" | "waiting" | "daily_limit" | "complete"; requestedAt: Timestamp; nextAttemptAt: Timestamp | null; eligible: number; completed: number; remaining: number } | null; capacity: { totalLimit: number; reservedSlots: number; serviceLimit: number; backgroundLimit: number; running: number; queued: number; categories: { category: string; state: "queued" | "running"; count: number }[] } } }
  "POST /api/pipeline/run": { body: { steps?: PipelineJobKind[]; week?: WeekKey }; response: PipelineRun }
  "GET /api/jobs/:id": { response: Job }
  "POST /api/findings/:id/recheck": { response: Job }
  "GET /api/ask/sessions": { response: Omit<AskSession, "messages">[] }
  "POST /api/ask/sessions": { response: AskSession }
  "GET /api/ask/sessions/:id": { response: AskSession }
  "DELETE /api/ask/sessions/:id": { response: null }
  "POST /api/ask/sessions/:id/messages": { body: { text: string; context: AskContext }; response: ReadableStream<Uint8Array> }
  "POST /api/ask/sessions/:id/stop": { response: null }
  "GET /api/export/:kind": { query: Record<string, string>; response: Blob }
  "POST /api/export/bundle": { body: { items: ExportItem[] }; response: Job }
  "GET /api/export/download/:id": { response: Blob }
}

export type Line = "inspiration" | "video"
export type Level = "heavy" | "medium" | "burst" | "light" | "trial"
export type Movement = "lost" | "silent" | "drop" | "surge" | "returned" | "new" | "steady"
export type Pool = "retain" | "recall" | "help" | "keep" | "nurture" | "convert"
export type Pattern = "retry" | "tweak" | "batch" | "adapt" | "rework" | "new" | "agent" | "none"
export type TaskStatus = "success" | "failed" | "deleted" | "unknown"
export type FailureCategory = "moderation" | "material" | "timeout" | "upstream" | "other"
export type EnterpriseKind = "customer" | "internal" | "agency" | "unknown"
export type ContractState = "active" | "trial" | "internal" | "expired" | "unknown"
export type Source = "rule" | "agent" | "manual"
export type AlertKind = "drop" | "vanished" | "stuck" | "cold_start" | "mismatch" | "waste" | "failures" | "reuse" | "surge" | "trend"
export type Severity = 1 | 2 | 3
export type TouchSlot = "mon" | "wed" | "fri"
export type TouchStatus = "draft" | "assigned" | "sent" | "replied" | "closed"
export type OfferKind = "template" | "comparison" | "tip" | "question"
export type Verdict = "confirmed" | "refuted" | "open"
export type DraftStatus = "draft" | "tested" | "published" | "pushed"
export type TemplateSource = "official" | "managed" | "shared"
export type SampleReason = "stuck" | "batch" | "downloaded" | "not_downloaded" | "failed"
export type ImportState = "queued" | "running" | "done" | "failed"
export type RerunState = "estimated" | "confirmed" | "running" | "done" | "failed" | "uncertain"
export type PushState = "preview" | "confirmed" | "creating" | "sharing" | "done" | "partial" | "failed" | "uncertain" | "cancelled"
export type DraftScope = "owner" | "general"

export type WeekKey = string
export type DateKey = string
export type Timestamp = string
export type Id = string

export interface ApiError {
  code: string
  message: string
}

export interface Page<T> {
  items: T[]
  total: number
}

export interface Authored {
  text: string
  source: Source
  updatedAt: Timestamp
}

export interface Pair {
  current: number
  previous: number
}

export interface Metric {
  value: number
  comparable: Pair | null
  comparableExcluded: Pair | null
}

export interface Coverage {
  line: Line
  week: WeekKey
  days: DateKey[]
  complete: boolean
  refreshedAt: Timestamp
}

export interface Meta {
  lines: Line[]
  weeks: WeekKey[]
  coverage: Coverage[]
  latestWeek: Record<Line, WeekKey | null>
  excluded: Record<Line, Id[]>
  lastImportAt: Timestamp | null
  siteBaseUrl: string
  fdAccount: { ready: boolean; userName: string | null; externalShareAllowed: boolean; checkedAt: Timestamp | null }
}

export interface EnterpriseRef {
  id: Id
  name: string
  kind: EnterpriseKind
}

export interface Owner {
  sales: string | null
  afterSales: string | null
}

export interface WeekPoint {
  week: WeekKey
  complete: boolean
  tasks: number
  points: number
  activeDays: number
  downloadRate: number | null
  level: Level | null
}

export interface HistoryPoint {
  week: WeekKey
  complete: boolean
  stable: number | null
  heavy: number | null
  medium: number | null
  activeEnterprises: number
  tasks: number
  points: number
  downloadRate: number
  retention: number | null
}

export interface Mover {
  enterprise: EnterpriseRef
  current: number
  previous: number
  unit: "tasks" | "points"
}

export interface AlertCount {
  kind: AlertKind
  severity: Severity
  count: number
}

export interface IntentStat {
  intent: string
  tasks: number
  enterprises: number
  share: number
  downloadRate: number
}

export interface ModeStat {
  mode: string
  tasks: number
  enterprises: number
  points: number
  pointShare: number
  downloadRate: number
  failed: number
}

export interface FailureStat {
  category: FailureCategory
  count: number
  enterprises: number
  genericMessage: number
}

export interface InspirationOverview {
  outputs: number
  batchShare: number
  batchDownloadRate: number
  stuckShare: number
  stuckDownloadRate: number
  intents: IntentStat[]
  agent: { rows: number; turns: number; enterprises: number; topUserRows: number }
  officialTemplates: { quickTasks: number; matched: number; used: number; total: number; top3Share: number }
}

export interface VideoOverview {
  pointsDownloaded: number
  pointsNotDownloaded: number
  notDownloadedShare: number
  pointsPerDownloaded: number
  modes: ModeStat[]
  failures: FailureStat[]
}

export interface Overview {
  line: Line
  week: WeekKey
  coverage: Coverage
  previousCoverage: Coverage | null
  retention: Retention | null
  comparableWeekdays: number[]
  stable: Metric | null
  levels: Record<Level, number> | null
  activeEnterprises: Metric
  users: Metric
  tasks: Metric
  points: Metric
  downloadRate: Metric
  failed: Metric
  concentration: { top1: EnterpriseRef; top1TaskShare: number; top10TaskShare: number; top1PointShare: number; top10PointShare: number; withoutTop1: Pair | null }
  history: HistoryPoint[]
  movers: Record<"rising" | "falling" | "new" | "returned" | "silent", Mover[]>
  moverCounts: { rising: number; falling: number; largeAccounts: number; largeAccountsHalved: number }
  alerts: AlertCount[]
  inspiration: InspirationOverview | null
  video: VideoOverview | null
}

export interface TouchBrief {
  id: Id
  week: WeekKey
  slot: TouchSlot
  status: TouchStatus
}

export interface RosterRow {
  enterprise: EnterpriseRef
  contract: ContractState
  owner: Owner
  excluded: boolean
  level: Level | null
  movement: Movement
  pool: Pool | null
  tasks: number
  points: number
  activeDays: number
  users: number
  comparable: Pair | null
  downloadRate: number | null
  downloadSignalReliable: boolean
  lastActiveAt: Timestamp | null
  weeksActive: number
  spark: WeekPoint[]
  alerts: AlertKind[]
  nextAction: Authored | null
  lastTouch: TouchBrief | null
  inspiration: {
    topIntent: string | null
    topIntentShare: number
    batchShare: number
    stuckShare: number
    agentShare: number
    mainModel: string | null
  } | null
  video: {
    topMode: string | null
    topModeShare: number
    pointShare: number
    pointsPerDownloaded: number | null
    notDownloadedPoints: number
    failed: number
    mainModel: string | null
  } | null
  conversion?: ConversionEvidence | null
}

export interface Roster {
  line: Line
  week: WeekKey
  rows: RosterRow[]
  poolCounts: Record<Pool, number>
  models: string[]
}

export interface Member {
  id: Id
  name: string
  phone: string
  tasks: number
  downloadRate: number | null
  lastActiveAt: Timestamp
}

export interface Breakdown {
  key: string
  tasks: number
  share: number
  points: number
  downloadRate: number | null
  peerMedianDownloadRate: number | null
  peerEnterprises: number
  mainModel: string | null
}

export interface Alert {
  id: Id
  kind: AlertKind
  severity: Severity
  line: Line
  week: WeekKey
  enterprise: EnterpriseRef
  facts: string[]
  suggestedPool: Pool | null
  dismissed: boolean
}

export interface Note {
  id: Id
  text: string
  createdAt: Timestamp
}

export interface LineDetail {
  line: Line
  week: WeekKey
  level: Level | null
  movement: Movement
  pool: Pool | null
  tasks: number
  points: number
  activeDays: number
  downloadRate: number | null
  downloadSignalReliable: boolean
  history: WeekPoint[]
  breakdown: Breakdown[]
  patterns: { pattern: Pattern; tasks: number; share: number; downloadRate: number | null }[]
  models: { model: string; tasks: number; downloadRate: number | null }[]
  failures: FailureStat[]
  members: Member[]
  nextAction: Authored | null
}

export interface EnterpriseDetail {
  enterprise: EnterpriseRef
  adminPhone: string
  contract: ContractState
  owner: Owner
  firstSeenAt: Timestamp
  lastActiveAt: Timestamp | null
  summary: Authored | null
  lines: Record<Line, LineDetail | null>
  alerts: Alert[]
  touches: Touch[]
  notes: Note[]
}

export interface Media {
  kind: "image" | "video"
  url: string
  thumb: string
  poster: string | null
}

export interface Task {
  rowKey: Id
  fdUrl: string | null
  sourceId: string
  turnKey: string | null
  line: Line
  scene: string
  mode: string
  createdAt: Timestamp
  enterprise: EnterpriseRef
  user: { id: Id; name: string } | null
  model: string | null
  prompt: string
  inputs: Media[]
  outputs: Media[]
  points: number
  status: TaskStatus
  failed: boolean
  downloaded: boolean
  downloadVia: string[]
  failure: { category: FailureCategory; userMessage: string | null; providerMessage: string | null } | null
  durationSeconds: number | null
  intent: string | null
  pattern: Pattern
  chainId: Id | null
  sampleReason: SampleReason | null
  config: {
    resolution: string | null
    ratio: string | null
    videoDuration: number | null
    audio: boolean | null
    referenceImages: number
    hasReferenceVideo: boolean
  }
}

export interface Chain {
  id: Id
  line: Line
  enterprise: EnterpriseRef
  user: { id: Id; name: string } | null
  startedAt: Timestamp
  endedAt: Timestamp
  length: number
  downloaded: boolean
  points: number
  tasks: Task[]
}

export interface MatrixCell {
  intent: string
  model: string
  tasks: number
  enterprises: number
  downloadRate: number
  enterpriseMedianDownloadRate: number | null
  dominantEnterpriseShare: number
}

export interface InspirationAnalysis {
  week: WeekKey
  intents: IntentStat[]
  models: string[]
  matrix: MatrixCell[]
  patterns: { pattern: Pattern; tasks: number; share: number; downloadRate: number; enterprises: number }[]
  unclassifiedShare: number
}

export interface VideoCell {
  mode: string
  model: string
  tasks: number
  enterprises: number
  points: number
  downloadRate: number
  failed: number
  pointsPerDownloaded: number | null
}

export interface VideoAnalysis {
  week: WeekKey
  modes: ModeStat[]
  matrix: VideoCell[]
  failures: FailureStat[]
  failureSamples: Task[]
  rerollChains: number
}

export interface Cluster {
  id: Id
  line: Line
  sample: string
  uses: number
  enterprises: number
  downloadRate: number
  intent: string | null
  matchedTemplate: { id: number; name: string } | null
  candidate: boolean
  topEnterprises: { enterprise: EnterpriseRef; uses: number }[]
  draftId: Id | null
}

export interface TemplateDraft {
  id: Id
  line: Line
  title: Authored
  prompt: Authored
  slots: string[]
  scene: string | null
  clusterId: Id | null
  status: DraftStatus
  scope: DraftScope
  sourceEnterprises: EnterpriseRef[]
  fdTemplateId: number | null
  fdTemplateSource: TemplateSource | null
  link: string | null
  pushedTo: EnterpriseRef[]
  pushes: TemplatePush[]
  createdAt: Timestamp
}

export interface PushReceiver {
  enterprise: EnterpriseRef
  fdUserId: number
  userName: string
  maskedPhone: string
  selectable: boolean
  disabledReason: string | null
  missingModels: string[]
}

export interface TemplatePush {
  id: Id
  draftId: Id
  touchId: Id | null
  state: PushState
  notify: boolean
  receivers: PushReceiver[]
  blocked: { enterprise: EnterpriseRef; reason: string }[]
  fdTemplateId: number | null
  batchId: string | null
  result: { success: number; failed: number; pending: number; failures: { fdUserId: number; code: string | null; message: string | null }[] } | null
  createdAt: Timestamp
  confirmedAt: Timestamp | null
  finishedAt: Timestamp | null
}

export interface Offer {
  kind: OfferKind
  draftId: Id | null
  rerunId: Id | null
  link: string | null
  text: string | null
}

export interface TouchOutcome {
  week: WeekKey
  tasks: Pair
  downloadRate: { current: number | null; previous: number | null }
  templateUsed: boolean | null
  control: { enterprises: number; medianTaskChange: number } | null
}

export interface Touch {
  id: Id
  line: Line
  week: WeekKey
  slot: TouchSlot
  enterprise: EnterpriseRef
  goal: Pool
  evidence: string[]
  offer: Offer
  draft: Authored
  owner: string | null
  channel: string | null
  status: TouchStatus
  suggested: boolean
  sentAt: Timestamp | null
  reply: string | null
  outcome: TouchOutcome | null
}

export interface TouchBoard {
  line: Line
  week: WeekKey
  suggestions: Touch[]
  slots: Record<TouchSlot, Touch[]>
}

export interface Finding {
  id: Id
  line: Line
  claim: string
  verdict: Verdict
  evidence: string
  sample: string
  caveat: string | null
  rule: { kind: "mismatch"; intent: string; model: string } | null
  updatedAt: Timestamp
  rechecks: FindingRecheck[]
}

export interface ReportLine {
  line: Line
  stable: Metric | null
  activeEnterprises: Metric
  tasks: Metric
  points: Metric
  downloadRate: Metric
  top1Share: number
  withoutTop1: Pair | null
  falling: { enterprise: EnterpriseRef; current: number; previous: number; reason: string | null }[]
  rising: { enterprise: EnterpriseRef; current: number; previous: number; reason: string | null }[]
}

export interface Report {
  week: WeekKey
  lines: ReportLine[]
  touches: { sent: number; replied: number; withOutcome: number }
  done: Authored | null
  next: Authored | null
}

export interface ImportJob {
  id: Id
  file: string
  state: ImportState
  from: DateKey | null
  to: DateKey | null
  rows: number
  inserted: number
  updated: number
  byLine: Record<Line | "other", number>
  error: string | null
  createdAt: Timestamp
}

export interface Thresholds {
  heavy: { tasks: number; days: number }
  medium: { tasks: number; days: number }
  moverBase: number
}

export interface AlertParams {
  stuck: { minTasks: number; stuckShare: number; downloadRate: number }
  coldStart: { minTasks: number }
  mismatch: { minTasks: number }
  waste: { minPoints: number; downloadRate: number }
  failures: { minCount: number }
  reuse: { minUses: number }
}

export interface PoolParams {
  help: { stuckShare: number; downloadRate: number }
  recall: { minPeakTasks: number }
  unreliable: { minTasks: number; downloadRate: number }
}

export interface Settings {
  thresholds: Record<Line, Thresholds>
  alerts: AlertParams
  pools: PoolParams
  clusters: { similarity: number; candidateMinUses: number }
  excluded: Record<Line, Id[]>
  siteBaseUrl: string
  rerunDailyPointLimit: number
  pushDailyLimit: number
  rerunDailyBudget: number
  rerunCurrency: "CNY" | "USD"
  pipeline: { concurrency: number; profilesPerRun: number; profileMinTasks: number; profileMaxAgeDays: number; dailyJobs: number }
  trials: { dailyLimit: number; currency: "CNY" | "USD"; maxCases: number; maxArms: number; concurrency: number }
  followups: { suggestionsPerWeek: number }
  trends: { churnGapWeeks: number; churnStableWeeks: number; slideWeeks: number; slideRatio: number; fadeRatio: number }
}

export interface Rerun {
  id: Id
  enterprise: EnterpriseRef
  sourceTask: Task
  prompt: string
  model: string
  estimatedPoints: number | null
  state: RerunState
  result: Media[]
  spentPoints: number | null
  createdAt: Timestamp
  provider: "litellm"
  estimatedCost: number | null
  spentCost: number | null
  currency: "CNY" | "USD" | null
  error: ApiError | null
}

export interface CrossLineUsage {
  week: WeekKey
  both: EnterpriseRef[]
  inspirationOnly: EnterpriseRef[]
  videoOnly: EnterpriseRef[]
}

export interface ConversionCandidate {
  enterprise: EnterpriseRef
  contract: ContractState
  owner: Owner
  scenes: { scene: string; tasks: number }[]
  lastActiveAt: Timestamp
  suggestedDraftId: Id | null
  conversion: ConversionEvidence
}

export interface ConversionEvidence {
  source: "自由改款"
  week: WeekKey
  tasks: number
  points: number
  activeDays: number
  users: number
  downloadRate: number | null
  failed: number
  totalTasks: number
  recentTasks: number
  comparable: Pair | null
  movement: Movement
  lastActiveAt: Timestamp | null
  topIntent: string | null
  topIntentShare: number
  mainModel: string | null
  models: { model: string; tasks: number }[]
  spark: WeekPoint[]
  opportunity: string
}

export interface TaskQuery {
  line: Line
  week?: WeekKey
  enterprise?: Id
  user?: Id
  pattern?: Pattern
  intent?: string
  mode?: string
  model?: string
  downloaded?: boolean
  failed?: boolean
  cluster?: Id
  sample?: number
  offset?: number
  limit?: number
}

export interface DailyPoint {
  date: DateKey
  covered: boolean
  tasks: number
  points: number
  enterprises: number
  downloadRate: number | null
}

export interface ApiCompatibility {
  "GET /api/drafts": { query: { line: Line }; response: TemplateDraft[] }
  "POST /api/drafts": {
    body: { line: Line; title: string; prompt: string; slots: string[]; scene?: string; clusterId?: Id; scope?: DraftScope; source: Source }
    response: TemplateDraft
  }
  "PATCH /api/drafts/:id": {
    body: Partial<{ title: string; prompt: string; slots: string[]; status: DraftStatus; fdTemplateId: number | null; fdTemplateSource: TemplateSource | null; scope: DraftScope; pushedTo: Id[]; source: Source }>
    response: TemplateDraft
  }
  "POST /api/drafts/:id/publish": { body: { sceneId: number; model: string; templateImg?: string }; response: TemplateDraft }
  "POST /api/drafts/:id/pushes": { body: { enterprises: Id[]; touchId?: Id; notify?: boolean }; response: TemplatePush }
  "GET /api/pushes/:id": { response: TemplatePush }
  "POST /api/pushes/:id/confirm": { body: { receiverUserIds: number[] }; response: TemplatePush }
  "POST /api/pushes/:id/cancel": { response: TemplatePush }
  "POST /api/fd-account/check": { response: Meta["fdAccount"] }
  "GET /api/reruns": { query: { enterprise?: Id }; response: Rerun[] }
  "POST /api/reruns": { body: { sourceRowKey: Id; prompt: string; model: string }; response: Rerun }
  "POST /api/reruns/:id/confirm": { response: Rerun }
  "POST /api/automation/analysis": { body: { line: Line; week: WeekKey }; response: { id: Id; state: "queued" | "running" | "done" | "failed" } }
  "GET /api/automation/analysis/:id": { response: { id: Id; state: "queued" | "running" | "done" | "failed"; error: ApiError | null } }
}

export interface Api extends ApiNext, ApiCompatibility {
  "GET /api/meta": { response: Meta }

  "GET /api/overview": { query: { line: Line; week: WeekKey }; response: Overview }

  "GET /api/enterprises": { query: { line: Line; week: WeekKey; model?: string }; response: Roster }
  "GET /api/enterprises/:id": { query: { week: WeekKey }; response: EnterpriseDetail }
  "PATCH /api/enterprises/:id": {
    body: Partial<{ kind: EnterpriseKind; contract: ContractState; owner: Owner; summary: string; source: Source }>
    response: EnterpriseDetail
  }
  "PUT /api/enterprises/:id/next-action": { body: { line: Line; text: string; source: Source }; response: Authored }
  "POST /api/enterprises/:id/notes": { body: { text: string }; response: Note }
  "DELETE /api/notes/:id": { response: null }
  "GET /api/enterprises/export": { query: { line: Line; week: WeekKey; pool?: Pool; ids?: Id[] }; response: Blob }

  "GET /api/tasks": { query: TaskQuery; response: Page<Task> }
  "GET /api/chains": { query: { line: Line; week: WeekKey; enterprise?: Id; minLength?: number; downloaded?: boolean }; response: Page<Chain> }
  "GET /api/media/thumb": { query: { url: string; w: 240 | 480 | 1200 }; response: Blob }

  "GET /api/alerts": { query: { line: Line; week: WeekKey; kind?: AlertKind }; response: Alert[] }
  "PATCH /api/alerts/:id": { body: { dismissed: boolean }; response: Alert }

  "GET /api/analysis/inspiration": { query: { week: WeekKey; excluded?: boolean }; response: InspirationAnalysis }
  "GET /api/analysis/video": { query: { week: WeekKey; excluded?: boolean }; response: VideoAnalysis }

  "GET /api/clusters": { query: { line: Line; week?: WeekKey; enterprise?: Id; candidate?: boolean }; response: Cluster[] }
  "GET /api/touches": { query: { line: Line; week: WeekKey }; response: TouchBoard }
  "POST /api/touches": {
    body: {
      line: Line
      week: WeekKey
      slot: TouchSlot
      enterprise: Id
      goal: Pool
      evidence?: string[]
      offer?: Offer
      draft?: string
      owner?: string
      source: Source
    }
    response: Touch
  }
  "PATCH /api/touches/:id": {
    body: Partial<{
      slot: TouchSlot
      goal: Pool
      evidence: string[]
      offer: Offer
      draft: string
      owner: string | null
      channel: string | null
      status: TouchStatus
      reply: string | null
      suggested: boolean
      source: Source
    }>
    response: Touch
  }
  "DELETE /api/touches/:id": { response: null }
  "GET /api/touches/export": { query: { line: Line; week: WeekKey; owner?: string }; response: Blob }
  "POST /api/touches/import": { body: FormData; response: { updated: number; skipped: number; errors: string[] } }

  "GET /api/findings": { query: { line?: Line }; response: Finding[] }
  "POST /api/findings": { body: Omit<Finding, "id" | "updatedAt" | "rechecks">; response: Finding }
  "PATCH /api/findings/:id": { body: Partial<Omit<Finding, "id" | "updatedAt" | "rechecks">>; response: Finding }

  "GET /api/report": { query: { week: WeekKey }; response: Report }
  "PUT /api/report": { body: { week: WeekKey; done?: string; next?: string; source: Source }; response: Report }

  "GET /api/imports": { response: ImportJob[] }
  "POST /api/imports": { body: FormData; response: ImportJob }
  "POST /api/imports/scan": { response: ImportJob[] }

  "GET /api/settings": { response: Settings }
  "PUT /api/settings": { body: Partial<Settings>; response: Settings }

  "GET /api/conversion": { query: { line: Line; week?: WeekKey }; response: ConversionCandidate[] }
  "GET /api/cross-line": { query: { week: WeekKey }; response: CrossLineUsage }
  "GET /api/daily": { query: { line: Line; from: DateKey; to: DateKey; enterprise?: Id }; response: DailyPoint[] }
}
