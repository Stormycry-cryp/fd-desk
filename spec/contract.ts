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
export type AlertKind = "drop" | "vanished" | "stuck" | "cold_start" | "mismatch" | "waste" | "failures" | "reuse" | "surge"
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

export interface Api {
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
  "GET /api/drafts": { query: { line: Line }; response: TemplateDraft[] }
  "POST /api/drafts": {
    body: { line: Line; title: string; prompt: string; slots: string[]; scene?: string; clusterId?: Id; scope?: DraftScope; source: Source }
    response: TemplateDraft
  }
  "PATCH /api/drafts/:id": {
    body: Partial<{
      title: string
      prompt: string
      slots: string[]
      status: DraftStatus
      fdTemplateId: number | null
      fdTemplateSource: TemplateSource | null
      scope: DraftScope
      pushedTo: Id[]
      source: Source
    }>
    response: TemplateDraft
  }
  "POST /api/drafts/:id/publish": { body: { sceneId: number; model: string; templateImg?: string }; response: TemplateDraft }

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

  "POST /api/drafts/:id/pushes": { body: { enterprises: Id[]; touchId?: Id; notify?: boolean }; response: TemplatePush }
  "GET /api/pushes/:id": { response: TemplatePush }
  "POST /api/pushes/:id/confirm": { body: { receiverUserIds: number[] }; response: TemplatePush }
  "POST /api/pushes/:id/cancel": { response: TemplatePush }
  "POST /api/fd-account/check": { response: Meta["fdAccount"] }

  "GET /api/findings": { query: { line?: Line }; response: Finding[] }
  "POST /api/findings": { body: Omit<Finding, "id" | "updatedAt">; response: Finding }
  "PATCH /api/findings/:id": { body: Partial<Omit<Finding, "id" | "updatedAt">>; response: Finding }

  "GET /api/report": { query: { week: WeekKey }; response: Report }
  "PUT /api/report": { body: { week: WeekKey; done?: string; next?: string; source: Source }; response: Report }

  "GET /api/imports": { response: ImportJob[] }
  "POST /api/imports": { body: FormData; response: ImportJob }
  "POST /api/imports/scan": { response: ImportJob[] }

  "GET /api/settings": { response: Settings }
  "PUT /api/settings": { body: Partial<Settings>; response: Settings }

  "GET /api/reruns": { query: { enterprise?: Id }; response: Rerun[] }
  "POST /api/reruns": { body: { sourceRowKey: Id; prompt: string; model: string }; response: Rerun }
  "POST /api/reruns/:id/confirm": { response: Rerun }

  "GET /api/conversion": { query: { line: Line }; response: ConversionCandidate[] }
  "GET /api/cross-line": { query: { week: WeekKey }; response: CrossLineUsage }
  "POST /api/automation/analysis": { body: { line: Line; week: WeekKey }; response: { id: Id; state: "queued" | "running" | "done" | "failed" } }
  "GET /api/automation/analysis/:id": { response: { id: Id; state: "queued" | "running" | "done" | "failed"; error: ApiError | null } }
  "GET /api/daily": { query: { line: Line; from: DateKey; to: DateKey; enterprise?: Id }; response: DailyPoint[] }
}
