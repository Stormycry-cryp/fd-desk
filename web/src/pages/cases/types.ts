import type { CaseOutcome, CasePoolEntry, CaseProcessed, CaseReview, CaseRow, CaseStep, StepResult, Task } from "@spec/contract"

export type { CaseAnalysis, CaseBatch, CaseCluster, CaseIssue, CaseLibraryStats, CaseOutcome, CasePage, CaseQuery, CaseRef, CaseSampleStrategy, CaseSummary, CaseTag, CaseUnit, StepResult } from "@spec/contract"

export type Review = CaseReview
export type Processed = CaseProcessed
export type PoolEntry = CasePoolEntry

export type Step = Omit<CaseStep, "annotationCount" | "lastAnnotation"> & { task?: Task; annotationCount?: number; lastAnnotation?: CaseStep["lastAnnotation"] }
export type Row = Omit<CaseRow, "steps" | "first" | "last" | "processed" | "pool"> & {
  first: Step
  last: Step
  steps: Step[] | null
  processed?: Processed
  pool?: PoolEntry | null
}
export type CaseSort = "bad_first" | "newest" | "oldest" | "steps" | "points" | "processed"

export interface CaseFilters {
  q: string
  outcome: CaseOutcome[]
  result: StepResult[]
  intent: string[]
  pattern: string[]
  model: string[]
  mode: string[]
  enterprise: string[]
  level: string[]
  movement: string[]
  steps: string[]
  tag: string[]
  processed: Processed[]
  slow: boolean
  noted: boolean
}

export const emptyFilters: CaseFilters = { q: "", outcome: [], result: [], intent: [], pattern: [], model: [], mode: [], enterprise: [], level: [], movement: [], steps: [], tag: [], processed: [], slow: false, noted: false }

export const caseKey = (x: { id: string; unit: string }) => `${x.unit}:${x.id}`

export type Target = { row: Row; step: Step | null }
