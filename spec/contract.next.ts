import type { ApiError, Authored, DateKey, EnterpriseRef, FailureCategory, Id, Line, Media, Pair, Pool, Source, Task, Timestamp, TouchOutcome, Verdict, WeekKey, WeekPoint } from "./contract"

export type Scope = "all" | Line
export type Confidence = "high" | "medium" | "low"
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled"
export type JobKind = "facts" | "profiles" | "movement" | "opportunities" | "followups" | "monitor" | "draft_write" | "finding_recheck" | "export"
export type PageKey = "week" | "customers" | "enterprise" | "templates" | "playground" | "followups" | "analysis" | "data" | "export"
export type ProfileTab = "profile" | "data" | "tasks" | "notes"

export interface Job {
  id: Id
  kind: JobKind
  state: JobState
  progress: { done: number; total: number }
  result: { draftId?: Id; movementId?: Id; url?: string } | null
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

export interface Evidence {
  label: string
  value: string | null
  target: Locator | null
}

export interface Retention {
  base: number
  kept: number
  rate: number | null
}

export type TagDimension = "category" | "role" | "purpose" | "rhythm" | "skill"
export type RhythmKind = "continuous" | "batch" | "occasional"
export type ProfileState = "none" | "facts_only" | "ready" | "stale" | "generating" | "failed"
export type InsightKey = "business" | "usage" | "workflow" | "skill" | "pain" | "opportunity"

export interface ProfileTag {
  dimension: TagDimension
  value: string
  source: Source
}

export interface TagOption {
  dimension: TagDimension
  values: { value: string; count: number }[]
}

export interface ProfileFacts {
  scope: Scope
  totals: {
    tasks: number
    recentTasks: number
    points: number
    recentPoints: number
    downloadRate: number | null
    recentDownloadRate: number | null
    activeWeeks: number
    stableWeeks: number
    firstSeenAt: Timestamp
    lastActiveAt: Timestamp | null
  }
  weekly: WeekPoint[]
  hours: number[][]
  primeHours: { from: number; to: number } | null
  weekendShare: number
  scenes: { scene: string; line: Line | "other"; tasks: number; share: number; recentShare: number }[]
  intents: { key: string; tasks: number; share: number; downloadRate: number | null }[]
  models: { model: string; tasks: number; share: number; downloadRate: number | null; firstUsedAt: DateKey; lastUsedAt: DateKey }[]
  inputs: {
    imageCounts: { count: number; share: number }[]
    promptLengthMedian: number
    ratios: { key: string; share: number }[]
    resolutions: { key: string; share: number }[]
  }
  quality: {
    stuckShare: number | null
    batchShare: number | null
    failed: number
    failures: { category: FailureCategory; count: number }[]
    unresolvedChains: number
  }
  rhythm: { kind: RhythmKind; batchGapWeeks: number | null; currentGapWeeks: number }
  members: { id: Id; name: string; phone: string; tasks: number; downloadRate: number | null; lastActiveAt: Timestamp }[]
}

export interface ProfileInsight {
  id: Id
  key: InsightKey
  text: string
  confidence: Confidence
  evidence: Evidence[]
  opportunityId: Id | null
}

export type AnnotationKind = "followup" | "special" | "other"

export interface AnnotationAnchor {
  block: string
  insightId: Id | null
  quote: string | null
  stale: boolean
}

export interface AnnotationEntry {
  id: Id
  text: string
  createdAt: Timestamp
  editedAt: Timestamp | null
}

export interface Annotation {
  id: Id
  enterprise: EnterpriseRef
  kind: AnnotationKind | null
  anchor: AnnotationAnchor | null
  entries: AnnotationEntry[]
  resolved: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MovementAnalysis {
  id: Id
  enterprise: EnterpriseRef
  line: Line
  week: WeekKey
  direction: "up" | "down"
  change: Pair
  headline: string
  reasons: { text: string; evidence: Evidence }[]
  action: string | null
  confidence: Confidence
  trigger: "auto" | "manual"
  state: JobState
  error: ApiError | null
  createdAt: Timestamp
}

export interface Profile {
  enterprise: EnterpriseRef
  adminPhone: string
  state: ProfileState
  version: number
  generatedAt: Timestamp | null
  headline: Authored | null
  insights: ProfileInsight[]
  tags: ProfileTag[]
  change: string | null
  facts: Record<Scope, ProfileFacts | null>
  samples: Task[]
  annotations: Annotation[]
  movements: MovementAnalysis[]
}

export interface ProfileVersion {
  version: number
  generatedAt: Timestamp
  headline: string | null
  change: string | null
}

export interface RosterExtra {
  enterpriseId: Id
  profileState: ProfileState
  headline: string | null
  tags: ProfileTag[]
  annotationCount: number
  lastAnnotation: { text: string; at: Timestamp; kind: AnnotationKind | null } | null
  movement: { id: Id; direction: "up" | "down"; headline: string; state: JobState } | null
}

export type TemplateKind = "official" | "custom"
export type Priority = "high" | "medium" | "low"
export type OpportunityState = "open" | "adopted" | "shelved" | "dismissed"
export type TemplateState = "draft" | "tried" | "exported" | "live" | "retired"
export type Mark = "better" | "same" | "worse"

export interface Opportunity {
  id: Id
  line: Line
  kind: TemplateKind
  target: EnterpriseRef | null
  title: string
  value: string
  reason: string
  priority: Priority
  evidence: {
    uses: number
    enterprises: number
    weeks: number
    downloadRate: number | null
    peerDownloadRate: number | null
    retryShare: number | null
    officialCovered: boolean
  }
  clusterIds: Id[]
  sampleTasks: Task[]
  state: OpportunityState
  draftId: Id | null
  week: WeekKey
  createdAt: Timestamp
}

export interface TemplateVariable {
  name: string
  default: string
  options: string[]
}

export interface TemplateSlot {
  name: string
  required: boolean
  requirement: string
}

export interface TemplateContent {
  title: string
  task: string
  prompt: string
  variables: TemplateVariable[]
  slots: TemplateSlot[]
  model: string | null
  ratio: string | null
  resolution: string | null
  fits: string
  avoids: string
}

export interface TemplateVersion {
  version: number
  content: TemplateContent
  source: Source
  note: string | null
  createdAt: Timestamp
}

export type CheckKey = "identity" | "slots" | "variables" | "length" | "duplicate"

export interface TemplateReview {
  checks: { key: CheckKey; ok: boolean; message: string | null }[]
  trial: { runId: Id; cases: number; usable: number; better: number; same: number; worse: number } | null
  comment: Authored | null
  suggestedState: TemplateState | null
}

export interface Template {
  id: Id
  line: Line
  kind: TemplateKind
  target: EnterpriseRef | null
  scene: string | null
  state: TemplateState
  current: TemplateVersion
  versions: TemplateVersion[]
  cover: { input: Media | null; output: Media } | null
  origin: {
    opportunityId: Id | null
    clusterIds: Id[]
    uses: number
    enterprises: number
    downloadRate: number | null
    originalPrompt: string | null
  }
  review: TemplateReview
  fdTemplateId: number | null
  exportedAt: Timestamp | null
  liveAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type ReviseKind = "shorter" | "general" | "specific" | "from_trial" | "custom"

export interface TemplateMonitor {
  templateId: Id
  title: string
  kind: TemplateKind
  target: EnterpriseRef | null
  fdTemplateId: number | null
  liveAt: Timestamp | null
  estimated: boolean
  weekly: { week: WeekKey; uses: number; enterprises: number; downloadRate: number | null }[]
  baseline: { uses: number; downloadRate: number | null } | null
  targetEffect: { retryShare: { before: number | null; after: number | null }; downloadRate: { before: number | null; after: number | null } } | null
  revisions: { version: number; at: Timestamp }[]
}

export interface TrialArm {
  id: Id
  label: string
  prompt: string
  model: string
  templateVersion: number | null
}

export interface TrialCell {
  armId: Id
  state: JobState
  outputs: Media[]
  cost: number | null
  error: ApiError | null
  mark: Mark | null
  usable: boolean | null
}

export interface TrialCase {
  id: Id
  task: Task
  cells: TrialCell[]
}

export interface TrialRun {
  id: Id
  templateId: Id | null
  arms: TrialArm[]
  cases: TrialCase[]
  state: JobState
  cost: { estimated: number; spent: number; currency: "CNY" | "USD" }
  summary: { armId: Id; done: number; total: number; better: number; same: number; worse: number; usable: number }[]
  fidelity: { level: "exact" | "close" | "direct"; note: string }
  createdAt: Timestamp
}

export interface TrialBudget {
  currency: "CNY" | "USD"
  dailyLimit: number
  spentToday: number
  maxCases: number
  maxArms: number
  models: { id: string; label: string; fdModels: string[]; unitCost: number }[]
}

export type FollowupState = "todo" | "contacted" | "replied" | "shelved"
export type AttachmentKind = "template" | "opportunity" | "chain" | "movement" | "trial"

export interface Followup {
  id: Id
  line: Line
  week: WeekKey
  enterprise: EnterpriseRef
  goal: Pool
  reason: string
  evidence: Evidence[]
  attachments: { kind: AttachmentKind; id: Id; label: string; target: Locator }[]
  script: Authored
  state: FollowupState
  reply: string | null
  contactedAt: Timestamp | null
  outcome: TouchOutcome | null
  suggested: boolean
  rank: number | null
}

export interface PipelineStep {
  kind: JobKind
  state: JobState
  progress: { done: number; total: number }
  detail: string | null
  error: ApiError | null
  startedAt: Timestamp | null
  finishedAt: Timestamp | null
}

export interface PipelineRun {
  id: Id
  trigger: "collector" | "manual"
  week: WeekKey | null
  steps: PipelineStep[]
  startedAt: Timestamp
  finishedAt: Timestamp | null
}

export interface AskContext {
  page: PageKey | "report"
  line: Line
  week: WeekKey | null
  excluded: boolean
  enterprise: Id | null
  tab: string | null
  filters: Record<string, string>
  selection: { kind: "chart" | "row" | "cell" | "insight" | "template"; label: string; data: Record<string, string | number | null> } | null
}

export type AskBlock =
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string; delta: string | null; target: Locator | null }
  | { type: "chart"; kind: "line" | "bar"; title: string; points: { label: string; value: number | null }[]; target: Locator | null }
  | { type: "list"; title: string | null; items: { label: string; value: string | null; target: Locator | null }[] }
  | { type: "clarify"; question: string; options: string[] }

export interface AskMessage {
  id: Id
  role: "user" | "assistant"
  text: string | null
  blocks: AskBlock[]
  context: AskContext | null
  state: "streaming" | "done" | "failed"
  createdAt: Timestamp
}

export interface AskSession {
  id: Id
  title: string
  messages: AskMessage[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type AskEvent =
  | { type: "status"; text: string }
  | { type: "delta"; index: number; text: string }
  | { type: "block"; index: number; block: AskBlock }
  | { type: "done"; message: AskMessage }
  | { type: "error"; error: ApiError }

export type ExportKind =
  | "roster"
  | "annotations"
  | "movements"
  | "templates_official"
  | "templates_custom"
  | "opportunities"
  | "monitor"
  | "followups"
  | "analysis_matrix"
  | "analysis_failures"
  | "tasks"

export interface ExportItem {
  kind: ExportKind
  params: Record<string, string>
}

export interface FindingRecheck {
  at: Timestamp
  verdict: Verdict
  evidence: string
  sample: string
  changed: boolean
}

export interface ContractAdditions {
  Task: { fdUrl: string | null }
  Overview: { retention: Retention | null }
  HistoryPoint: { retention: number | null }
  Finding: { rechecks: FindingRecheck[] }
  Settings: {
    pipeline: { concurrency: number; profilesPerRun: number; profileMinTasks: number; profileMaxAgeDays: number }
    trials: { dailyLimit: number; currency: "CNY" | "USD"; maxCases: number; maxArms: number; concurrency: number }
    followups: { suggestionsPerWeek: number }
  }
  Removed: ["/api/drafts", "/api/pushes", "/api/fd-account/check", "/api/reruns", "/api/touches", "/api/enterprises/:id/notes", "/api/notes/:id", "/api/automation/analysis"]
}

export interface ApiNext {
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
  "POST /api/templates": {
    body: { line: Line; kind: TemplateKind; target?: Id; opportunityId?: Id; clusterIds?: Id[]; content?: Partial<TemplateContent>; write: boolean }
    response: { template: Template; job: Job | null }
  }
  "PATCH /api/templates/:id": {
    body: Partial<{ kind: TemplateKind; target: Id | null; state: TemplateState; content: TemplateContent; fdTemplateId: number | null; cover: { runId: Id; caseId: Id; armId: Id } | null }>
    response: Template
  }
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

  "GET /api/followups": { query: { line: Line; week: WeekKey }; response: { items: Followup[]; suggestions: Followup[] } }
  "POST /api/followups": { body: { line: Line; week: WeekKey; enterprise: Id; goal: Pool; reason?: string; script?: string }; response: Followup }
  "PATCH /api/followups/:id": { body: Partial<{ goal: Pool; state: FollowupState; script: string; reply: string | null; suggested: boolean; attachments: { kind: AttachmentKind; id: Id }[] }>; response: Followup }
  "DELETE /api/followups/:id": { response: null }

  "GET /api/pipeline": { response: { latest: PipelineRun | null; history: PipelineRun[]; limits: { profilesPerRun: number; concurrency: number } } }
  "POST /api/pipeline/run": { body: { steps?: JobKind[]; week?: WeekKey }; response: PipelineRun }
  "GET /api/jobs/:id": { response: Job }

  "POST /api/findings/:id/recheck": { response: Job }

  "GET /api/ask/sessions": { response: Omit<AskSession, "messages">[] }
  "POST /api/ask/sessions": { response: AskSession }
  "GET /api/ask/sessions/:id": { response: AskSession }
  "DELETE /api/ask/sessions/:id": { response: null }
  "POST /api/ask/sessions/:id/messages": { body: { text: string; context: AskContext }; response: AskEvent }
  "POST /api/ask/sessions/:id/stop": { response: null }

  "GET /api/export/:kind": { query: Record<string, string>; response: Blob }
  "POST /api/export/bundle": { body: { items: ExportItem[] }; response: Job }
}
