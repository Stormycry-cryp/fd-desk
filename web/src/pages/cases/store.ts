import { useSyncExternalStore } from "react"
import type { CaseAnalysis, CaseBatch, CaseRating, CaseRef, CaseReview, CaseSampleStrategy, CaseStatus, CaseTag, Row } from "./types"
import type { Line } from "@spec/contract"
import { caseKey } from "./types"
import { chainOf, slim } from "./model"

export interface ReviewPatch {
  rating?: CaseRating | null
  addTags?: string[]
  removeTags?: string[]
  status?: CaseStatus
}

interface LocalReview extends CaseReview {
  snap: Row
}

interface LocalCollection {
  id: string
  name: string
  line: Line
  rows: Row[]
  createdAt: string
  updatedAt: string
}

export interface LocalBatch extends CaseBatch {
  rows: Row[]
  week: string | null
  local: true
}

export interface LocalAnalysis {
  id: string
  line: Line
  items: CaseRef[]
  question: string | null
  createdAt: string
  parts: { enterprise: string; name: string; analysisId: string; rowKeys: Record<string, string> }[]
  rows: Row[]
}

interface State {
  reviews: Record<string, LocalReview>
  tags: CaseTag[]
  collections: LocalCollection[]
  batches: LocalBatch[]
  analyses: LocalAnalysis[]
}

const KEY = "fd-desk.cases.v1"

const load = (): State => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { reviews: {}, tags: [], collections: [], batches: [], analyses: [], ...JSON.parse(raw) }
  } catch {}
  return { reviews: {}, tags: [], collections: [], batches: [], analyses: [] }
}

let state = load()
let version = 0
const subs = new Set<() => void>()
const emit = () => {
  version++
  subs.forEach((f) => f())
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {}
  emit()
}

export const useStore = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => version,
  )

export const getState = () => state

const overlay = new Map<string, CaseReview | null>()
export const getOverlay = (k: string) => overlay.get(k)
export const hasOverlay = (k: string) => overlay.has(k)
export const clearOverlay = () => {
  if (!overlay.size) return
  overlay.clear()
  emit()
}

const applyPatch = (cur: CaseReview | null, p: ReviewPatch): CaseReview => {
  const base: CaseReview = cur && !cur.inherited ? cur : { rating: cur?.rating ?? null, tags: cur?.tags ?? [], status: cur?.status ?? "todo", inherited: false, updatedAt: "" }
  const tags = new Set(base.tags)
  p.addTags?.forEach((t) => tags.add(t))
  p.removeTags?.forEach((t) => tags.delete(t))
  return { rating: p.rating !== undefined ? p.rating : base.rating, tags: [...tags], status: p.status ?? (base.status === "todo" && (p.rating || p.addTags?.length) ? "seen" : base.status), inherited: false, updatedAt: new Date().toISOString() }
}

export const localReview = (r: Pick<Row, "id" | "unit"> & Partial<Row>): CaseReview | null => {
  const own = state.reviews[caseKey(r)]
  if (own) return own
  if (r.unit === "task") {
    const c = chainOf(r as Row)
    const ch = c ? state.reviews[`chain:${c}`] : null
    if (ch) return { ...ch, inherited: true }
  }
  return null
}

export const localStepReview = (chainId: string, rowKey: string): CaseReview | null => {
  const own = state.reviews[`task:${rowKey}`]
  if (own) return own
  const ch = state.reviews[`chain:${chainId}`]
  return ch ? { ...ch, inherited: true } : null
}

export const writeLocal = (rows: Row[], p: ReviewPatch) => {
  rows.forEach((r) => {
    const k = caseKey(r)
    const next = applyPatch(localReview(r), p)
    state.reviews[k] = { ...next, snap: slim(r) }
  })
  state = { ...state, reviews: { ...state.reviews } }
  save()
}

export const writeStepLocal = (row: Row, rowKey: string, p: ReviewPatch) => {
  const k = `task:${rowKey}`
  const cur = localStepReview(row.id, rowKey)
  const step = (row.steps ?? []).find((s) => s.rowKey === rowKey) ?? row.last
  const snap: Row = { ...slim(row), id: rowKey, unit: "task", stepCount: 1, first: step, last: step, steps: null }
  state = { ...state, reviews: { ...state.reviews, [k]: { ...applyPatch(cur, p), snap } } }
  save()
}

export const clearLocal = (refs: CaseRef[]) => {
  const reviews = { ...state.reviews }
  refs.forEach((r) => delete reviews[caseKey(r)])
  state = { ...state, reviews }
  save()
}

export const setOverlay = (rows: { id: string; unit: string; review: CaseReview | null }[], p: ReviewPatch | null) => {
  rows.forEach((r) => {
    const k = caseKey(r)
    overlay.set(k, p ? applyPatch(overlay.has(k) ? overlay.get(k)! : r.review, p) : null)
  })
  emit()
}

export const dropOverlay = (keys: string[]) => {
  keys.forEach((k) => overlay.delete(k))
  emit()
}

export const addLocalTag = (t: Omit<CaseTag, "id" | "order" | "archived">) => {
  const tag: CaseTag = { ...t, id: `local:${t.group}/${t.label}`, order: 100 + state.tags.length, archived: false }
  state = { ...state, tags: [...state.tags.filter((x) => x.id !== tag.id), tag] }
  save()
  return tag
}

export const patchLocalTag = (id: string, p: Partial<CaseTag>) => {
  state = { ...state, tags: state.tags.map((t) => (t.id === id ? { ...t, ...p } : t)) }
  save()
}

export const collectionsLocal = (line: Line) => state.collections.filter((c) => c.line === line)

export const createCollectionLocal = (line: Line, name: string) => {
  const now = new Date().toISOString()
  const c: LocalCollection = { id: `local-${Date.now().toString(36)}`, name, line, rows: [], createdAt: now, updatedAt: now }
  state = { ...state, collections: [c, ...state.collections] }
  save()
  return c
}

export const renameCollectionLocal = (id: string, name: string) => {
  state = { ...state, collections: state.collections.map((c) => (c.id === id ? { ...c, name, updatedAt: new Date().toISOString() } : c)) }
  save()
}

export const deleteCollectionLocal = (id: string) => {
  state = { ...state, collections: state.collections.filter((c) => c.id !== id) }
  save()
}

export const editCollectionLocal = (id: string, add: Row[], remove: CaseRef[]) => {
  const rm = new Set(remove.map(caseKey))
  state = {
    ...state,
    collections: state.collections.map((c) => {
      if (c.id !== id) return c
      const have = new Set(c.rows.map(caseKey))
      const rows = [...add.filter((r) => !have.has(caseKey(r))).map(slim), ...c.rows].filter((r) => !rm.has(caseKey(r))).slice(0, 300)
      return { ...c, rows, updatedAt: new Date().toISOString() }
    }),
  }
  save()
}

export const localMembership = (r: CaseRef) => state.collections.filter((c) => c.rows.some((x) => x.id === r.id && x.unit === r.unit)).map((c) => c.id)

export const addBatchLocal = (b: { line: Line; name: string; strategy: CaseSampleStrategy; filters: Record<string, string>; rows: Row[]; week: string | null }) => {
  const batch: LocalBatch = { id: `local-${Date.now().toString(36)}`, line: b.line, name: b.name, strategy: b.strategy, filters: b.filters, items: b.rows.map((r) => ({ id: r.id, unit: r.unit })), reviewed: 0, createdAt: new Date().toISOString(), rows: b.rows.map(slim), week: b.week, local: true }
  state = { ...state, batches: [batch, ...state.batches].slice(0, 30) }
  save()
  return batch
}

export const deleteBatchLocal = (id: string) => {
  state = { ...state, batches: state.batches.filter((b) => b.id !== id) }
  save()
}

export const addAnalysisLocal = (a: LocalAnalysis) => {
  state = { ...state, analyses: [a, ...state.analyses].slice(0, 30) }
  save()
}

export const deleteAnalysisLocal = (id: string) => {
  state = { ...state, analyses: state.analyses.filter((a) => a.id !== id) }
  save()
}

export const localAnalysisToCase = (a: LocalAnalysis): Pick<CaseAnalysis, "id" | "line" | "items" | "question" | "createdAt"> => ({ id: a.id, line: a.line, items: a.items, question: a.question, createdAt: a.createdAt })

export const pendingSync = () => Object.keys(state.reviews).length + state.collections.reduce((s, c) => s + c.rows.length, 0)

export const resetSynced = (reviews: boolean, collections: boolean) => {
  state = { ...state, reviews: reviews ? {} : state.reviews, collections: collections ? [] : state.collections }
  save()
}
