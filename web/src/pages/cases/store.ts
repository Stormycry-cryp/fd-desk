import { useSyncExternalStore } from "react"
import type { Line } from "@spec/contract"
import type { Row, Step } from "./types"
import { caseKey } from "./types"

interface Own {
  tags: string[]
  at: string
  chain: string | null
}

interface PoolItem {
  id: string
  unit: "chain" | "task"
  line: string
  note: string | null
  templateId: string | null
  addedAt: string
  row: Row
}

interface Persist {
  pool: PoolItem[]
  auto: boolean
  hide: boolean
}

const KEY = "fd-desk.cases.v2"

const load = (): Persist => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { pool: [], auto: false, hide: false, ...JSON.parse(raw) }
  } catch {}
  return { pool: [], auto: false, hide: false }
}

let persist = load()
const overlay = new Map<string, Own>()
const steps = new Map<string, Map<string, string[]>>()
const notes = new Map<string, number>()
let version = 0
const subs = new Set<() => void>()

const emit = () => {
  version++
  subs.forEach((f) => f())
}

const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(persist))
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

export const ownOverlay = (k: string) => overlay.get(k)

export const stepOverlay = (chainId: string) => steps.get(chainId)

export const setOwn = (k: string, tags: string[], chain: string | null) => {
  overlay.set(k, { tags, at: new Date().toISOString(), chain })
  if (chain) {
    const m = steps.get(chain) ?? new Map<string, string[]>()
    m.set(k, tags)
    steps.set(chain, m)
  }
  emit()
}

export const dropOwn = (k: string) => {
  const o = overlay.get(k)
  overlay.delete(k)
  if (o?.chain) steps.get(o.chain)?.delete(k)
  emit()
}

export const bumpNotes = (k: string, d = 1) => {
  notes.set(k, (notes.get(k) ?? 0) + d)
  emit()
}

export const extraNotes = (k: string) => notes.get(k) ?? 0

export const slim = (r: Row): Row => {
  const strip = (s: Step): Step => {
    const { task: _t, ...rest } = s
    return rest
  }
  return { ...r, first: strip(r.first), last: strip(r.last), steps: r.steps && r.steps.length <= 8 ? r.steps.map(strip) : null }
}

export const localPool = (line: Line) => persist.pool.filter((p) => p.line === line)

export const localPoolEntry = (r: { id: string; unit: string }) => persist.pool.find((p) => p.id === r.id && p.unit === r.unit) ?? null

export const togglePoolLocal = (rows: Row[], on: boolean) => {
  const keys = new Set(rows.map(caseKey))
  const rest = persist.pool.filter((p) => !keys.has(caseKey(p)))
  const now = new Date().toISOString()
  persist = { ...persist, pool: on ? [...rows.map((r): PoolItem => ({ id: r.id, unit: r.unit, line: r.line, note: localPoolEntry(r)?.note ?? null, templateId: localPoolEntry(r)?.templateId ?? null, addedAt: now, row: slim(r) })), ...rest] : rest }
  save()
}

export const notePoolLocal = (r: { id: string; unit: string }, note: string | null) => {
  persist = { ...persist, pool: persist.pool.map((p) => (p.id === r.id && p.unit === r.unit ? { ...p, note } : p)) }
  save()
}

export const markPoolTemplate = (refs: { id: string; unit: string }[], templateId: string) => {
  const keys = new Set(refs.map(caseKey))
  persist = { ...persist, pool: persist.pool.map((p) => (keys.has(caseKey(p)) ? { ...p, templateId } : p)) }
  save()
}

export const pref = () => persist

export const setPref = (p: Partial<Pick<Persist, "auto" | "hide">>) => {
  persist = { ...persist, ...p }
  save()
}
