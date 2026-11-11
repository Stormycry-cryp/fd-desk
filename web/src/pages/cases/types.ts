import type { CaseOutcome, CaseRow, CaseStep, StepResult, Task } from "@spec/contract"

export type { CaseAnalysis, CaseBatch, CaseCluster, CaseCollection, CaseIssue, CaseOutcome, CasePage, CaseQuery, CaseRating, CaseRef, CaseReview, CaseSampleStrategy, CaseStatus, CaseSummary, CaseTag, CaseUnit, StepResult } from "@spec/contract"

export type Step = CaseStep & { task?: Task }
export type Row = Omit<CaseRow, "steps" | "first" | "last"> & { first: Step; last: Step; steps: Step[] | null }
export type CaseSort = "bad_first" | "newest" | "oldest" | "steps" | "points"

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
  rating: string[]
  tag: string[]
  status: string[]
  collection: string | null
  slow: boolean
  noted: boolean
}

export const emptyFilters: CaseFilters = { q: "", outcome: [], result: [], intent: [], pattern: [], model: [], mode: [], enterprise: [], level: [], movement: [], steps: [], rating: [], tag: [], status: [], collection: null, slow: false, noted: false }

export const caseKey = (x: { id: string; unit: string }) => `${x.unit}:${x.id}`
