import { useEffect, useMemo, useRef, useState } from "react"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Annotation, Chain, Line, Page, RecordAnalysis, Task } from "@spec/contract"
import { call, isMissing, request, rawUrl, RequestError } from "../../api/client"
import { useRoster } from "../../api/hooks"
import { errorText } from "../../api/next"
import { lineName } from "../../lib/labels"
import { download } from "../../lib/download"
import { toast } from "../../ui/overlays"
import type { CaseAnalysis, CaseBatch, CaseCollection, CaseFilters, CaseIssue, CasePage, CaseRef, CaseSort, CaseSummary, CaseTag, CaseUnit, Row } from "./types"
import { caseKey } from "./types"
import { buildLocal, chainOf, filtersToQuery, outcomeName, presetTags, queryLocal, ratingName, resultName, sortRows, statusName, summarize, thumbOf, type Lookup } from "./model"
import * as S from "./store"

const retry = (n: number, e: unknown) => !(e instanceof RequestError && (e.missing || e.status < 500)) && n < 2

export const useServer = (line: Line, week: string | null) => {
  const q = useQuery({
    queryKey: ["cases-probe", line, week],
    enabled: !!week,
    staleTime: 60000,
    retry,
    queryFn: () => request<CasePage>("GET /api/cases", { query: { line, week, limit: 1 } }),
  })
  return { server: q.isSuccess ? true : q.isError ? (isMissing(q.error) ? false : true) : null, probe: q }
}

const useLocalData = (line: Line, week: string | null, enabled: boolean) => {
  const roster = useRoster(line, week)
  const q = useQuery({
    queryKey: ["cases-local", line, week],
    enabled: enabled && !!week,
    staleTime: 5 * 60000,
    gcTime: 10 * 60000,
    queryFn: async () => {
      const chains = await call("GET /api/chains", { query: { line, week: week!, minLength: 1 } })
      const extra: Task[] = []
      if (line === "inspiration") {
        for (let offset = 0; offset < 4000; offset += 200) {
          const p: Page<Task> = await call("GET /api/tasks", { query: { line, week: week!, pattern: "agent", limit: 200, offset } })
          extra.push(...p.items)
          if (extra.length >= p.total || !p.items.length) break
        }
      }
      return { chains: (chains as Page<Chain>).items, extra }
    },
  })
  const data = useMemo(() => (q.data ? buildLocal(q.data.chains, q.data.extra, roster.data?.rows) : null), [q.data, roster.data])
  return { data, q }
}

export const useAllAnnotations = () => useQuery({ queryKey: ["GET /api/annotations", "cases-all"], queryFn: () => call("GET /api/annotations", { query: {} }), staleTime: 30000 })

export const useLookup = (server: boolean | null, anns: Annotation[] | undefined): Lookup => {
  const v = S.useStore()
  const notes = useMemo(() => {
    const m = new Map<string, { n: number; last: Annotation | null }>()
    ;(anns ?? []).forEach((a) => {
      const b = a.anchor?.block ?? ""
      const k = b.startsWith("case:") ? `chain:${b.slice(5)}` : b.startsWith("record:") ? `task:${b.slice(7)}` : null
      if (!k) return
      const cur = m.get(k) ?? { n: 0, last: null }
      m.set(k, { n: cur.n + 1, last: !cur.last || a.updatedAt > cur.last.updatedAt ? a : cur.last })
    })
    return m
  }, [anns])
  return useMemo<Lookup>(() => {
    const noteOf = (r: Row) => {
      const own = notes.get(caseKey(r))
      if (r.unit === "task" || !r.steps) return own ?? (server ? { n: r.annotationCount, last: null } : { n: 0, last: null })
      let n = own?.n ?? 0
      let last = own?.last ?? null
      r.steps.forEach((s) => {
        const x = notes.get(`task:${s.rowKey}`)
        if (!x) return
        n += x.n
        if (x.last && (!last || x.last.updatedAt > last.updatedAt)) last = x.last
      })
      return { n: Math.max(n, server ? r.annotationCount : 0), last }
    }
    if (server)
      return {
        review: (r) => (S.hasOverlay(caseKey(r)) ? S.getOverlay(caseKey(r)) ?? null : r.review),
        notes: noteOf,
        inCollection: (r) => r.collections,
      }
    return { review: (r) => S.localReview(r), notes: noteOf, inCollection: (r) => S.localMembership(r) }
  }, [server, notes, v])
}

export interface CaseList {
  rows: Row[]
  total: number
  summary: CaseSummary | null
  facets: CasePage["facets"] | null
  loading: boolean
  fetching: boolean
  error: unknown
  more: boolean
  loadMore: () => void
  retry: () => void
  all: Row[] | null
}

const PAGE = 60

export const useCaseList = (line: Line, week: string | null, unit: CaseUnit, f: CaseFilters, sort: CaseSort, server: boolean | null, L: Lookup): CaseList => {
  const sq = { line, week: week ?? undefined, unit, sort, ...filtersToQuery(f) }
  const remote = useInfiniteQuery({
    queryKey: ["GET /api/cases", sq],
    enabled: server === true && !!week,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => request<CasePage>("GET /api/cases", { query: { ...sq, offset: pageParam, limit: PAGE } }),
    getNextPageParam: (last: CasePage, all) => {
      const n = all.reduce((s, p) => s + p.items.length, 0)
      return n < last.total ? n : undefined
    },
    retry,
  })
  const local = useLocalData(line, week, server === false)
  const [shown, setShown] = useState(PAGE)
  const fk = JSON.stringify([line, week, unit, f, sort])
  useEffect(() => setShown(PAGE), [fk])
  const base = local.data ? (unit === "chain" ? local.data.chains : local.data.tasks) : null
  const res = useMemo(() => (base ? queryLocal(base, f, L) : null), [base, fk, L])
  const sorted = useMemo(() => (res ? sortRows(res.items, sort) : null), [res, sort])
  const summary = useMemo(() => (base ? summarize(f.enterprise.length ? base.filter((r) => f.enterprise.includes(r.enterprise.id)) : base, L) : null), [base, f.enterprise.join(), L])
  if (server === true) {
    const pages = remote.data?.pages ?? []
    return {
      rows: pages.flatMap((p) => p.items) as Row[],
      total: pages[0]?.total ?? 0,
      summary: pages[0]?.summary ?? null,
      facets: pages[0]?.facets ?? null,
      loading: remote.isLoading,
      fetching: remote.isFetchingNextPage,
      error: remote.error,
      more: !!remote.hasNextPage,
      loadMore: () => remote.fetchNextPage(),
      retry: () => remote.refetch(),
      all: null,
    }
  }
  return {
    rows: sorted ? sorted.slice(0, shown) : [],
    total: sorted?.length ?? 0,
    summary,
    facets: res?.facets ?? null,
    loading: server === null || local.q.isLoading,
    fetching: false,
    error: local.q.error,
    more: !!sorted && shown < sorted.length,
    loadMore: () => setShown((n) => n + PAGE),
    retry: () => local.q.refetch(),
    all: sorted,
  }
}

export const useLocalPool = (line: Line, week: string | null, unit: CaseUnit, enabled: boolean) => {
  const local = useLocalData(line, week, enabled)
  return local.data ? (unit === "chain" ? local.data.chains : local.data.tasks) : null
}

export const useCaseDetail = (row: Row | null, server: boolean | null, week: string | null) =>
  useQuery({
    queryKey: ["GET /api/cases/:id", row?.id, row?.unit, week],
    enabled: server === true && !!row,
    staleTime: 30000,
    queryFn: () => request<Row & { annotations: Annotation[] }>("GET /api/cases/:id", { params: { id: row!.id }, query: { unit: row!.unit, week: week ?? undefined } }),
  })

export const useCaseTags = (line: Line, server: boolean | null) => {
  S.useStore()
  const q = useQuery({ queryKey: ["GET /api/cases/tags", line], enabled: server === true, staleTime: 60000, queryFn: () => request<CaseTag[]>("GET /api/cases/tags", { query: { line } }) })
  const list = server === true && q.data ? q.data : [...presetTags, ...S.getState().tags]
  return useMemo(() => list.filter((t) => !t.archived && (!t.lines.length || t.lines.includes(line))).sort((a, b) => a.order - b.order), [list, line])
}

export const useAddTag = (line: Line, server: boolean | null) => {
  const qc = useQueryClient()
  return async (group: string, label: string, tone: CaseTag["tone"] = "bad") => {
    if (server) {
      try {
        const t = await request<CaseTag>("POST /api/cases/tags", { body: { group, label, lines: [line], tone } })
        qc.invalidateQueries({ queryKey: ["GET /api/cases/tags"] })
        return t
      } catch (e) {
        toast(errorText(e), { tone: "error" })
        return null
      }
    }
    return S.addLocalTag({ group, label, lines: [line], tone })
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null
const useSoftRefresh = () => {
  const qc = useQueryClient()
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["GET /api/cases/issues"] })
      qc.invalidateQueries({ queryKey: ["GET /api/cases/batches"] })
      qc.invalidateQueries({ queryKey: ["GET /api/cases", "unrated-bad"] })
    }, 1500)
  }
}

export const useReview = (server: boolean | null) => {
  const soft = useSoftRefresh()
  return async (rows: Row[], p: S.ReviewPatch) => {
    if (!rows.length) return
    if (!server) return S.writeLocal(rows, p)
    S.setOverlay(rows, p)
    const keys = rows.map(caseKey)
    try {
      for (let i = 0; i < rows.length; i += 500) await request("PUT /api/cases/reviews", { body: { items: rows.slice(i, i + 500).map((r) => ({ id: r.id, unit: r.unit })), ...p } })
      soft()
    } catch (e) {
      S.dropOverlay(keys)
      toast(errorText(e, "评价没保存"), { tone: "error" })
    }
  }
}

export const useStepReview = (server: boolean | null) => {
  return async (row: Row, rowKey: string, p: S.ReviewPatch) => {
    if (!server) return S.writeStepLocal(row, rowKey, p)
    const step = (row.steps ?? []).find((s) => s.rowKey === rowKey)
    S.setOverlay([{ id: rowKey, unit: "task", review: step?.review ?? null }], p)
    try {
      await request("PUT /api/cases/reviews", { body: { items: [{ id: rowKey, unit: "task" }], ...p } })
    } catch (e) {
      S.dropOverlay([`task:${rowKey}`])
      toast(errorText(e, "评价没保存"), { tone: "error" })
    }
  }
}

export const stepReview = (row: Row, rowKey: string, server: boolean | null) => {
  if (!server) return S.localStepReview(row.unit === "chain" ? row.id : chainOf(row) ?? row.id, rowKey)
  const k = `task:${rowKey}`
  if (S.hasOverlay(k)) return S.getOverlay(k) ?? null
  return (row.steps ?? []).find((s) => s.rowKey === rowKey)?.review ?? null
}

export const useCollections = (line: Line, server: boolean | null) => {
  S.useStore()
  const q = useQuery({ queryKey: ["GET /api/cases/collections", line], enabled: server === true, queryFn: () => request<CaseCollection[]>("GET /api/cases/collections", { query: { line } }) })
  if (server === true) return q.data ?? []
  return S.collectionsLocal(line).map((c): CaseCollection => ({ id: c.id, name: c.name, line: c.line, count: c.rows.length, createdAt: c.createdAt, updatedAt: c.updatedAt }))
}

export const useCollectionOps = (line: Line, server: boolean | null) => {
  const qc = useQueryClient()
  const sync = () => {
    qc.invalidateQueries({ queryKey: ["GET /api/cases/collections"] })
    qc.invalidateQueries({ queryKey: ["GET /api/cases"] })
  }
  const guard = async <T,>(fn: () => Promise<T>) => {
    try {
      const r = await fn()
      sync()
      return r
    } catch (e) {
      toast(errorText(e), { tone: "error" })
      return null
    }
  }
  return {
    create: (name: string) => (server ? guard(() => request<CaseCollection>("POST /api/cases/collections", { body: { line, name } })) : Promise.resolve(S.createCollectionLocal(line, name) as unknown as CaseCollection)),
    rename: (id: string, name: string) => (server ? guard(() => request("PATCH /api/cases/collections/:id", { params: { id }, body: { name } })) : Promise.resolve(S.renameCollectionLocal(id, name))),
    remove: (id: string) => (server ? guard(() => request("DELETE /api/cases/collections/:id", { params: { id } })) : Promise.resolve(S.deleteCollectionLocal(id))),
    edit: (id: string, add: Row[], remove: CaseRef[]) => (server ? guard(() => request("PUT /api/cases/collections/:id/items", { params: { id }, body: { add: add.map((r) => ({ id: r.id, unit: r.unit })), remove } })) : Promise.resolve(S.editCollectionLocal(id, add, remove))),
  }
}

export const useCollectionRows = (id: string | null, line: Line, week: string | null, server: boolean | null) => {
  S.useStore()
  const q = useInfiniteQuery({
    queryKey: ["GET /api/cases", "collection", id, line],
    enabled: server === true && !!id,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => request<CasePage>("GET /api/cases", { query: { line, collection: id, unit: "chain", from: "2020-01-01", to: "2099-12-31", offset: pageParam, limit: 200 } }),
    getNextPageParam: () => undefined,
  })
  void week
  if (!id) return null
  if (server === true) return (q.data?.pages.flatMap((p) => p.items) as Row[]) ?? null
  return S.getState().collections.find((c) => c.id === id)?.rows ?? []
}

export const useBatches = (line: Line, server: boolean | null) => {
  S.useStore()
  const q = useQuery({ queryKey: ["GET /api/cases/batches", line], enabled: server === true, refetchOnMount: "always", queryFn: () => request<CaseBatch[]>("GET /api/cases/batches", { query: { line } }) })
  const local = S.getState().batches.filter((b) => b.line === line)
  return [...(server === true ? q.data ?? [] : []), ...local].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export const useBatchRows = (b: CaseBatch | null, server: boolean | null) => {
  S.useStore()
  const isLocal = !!b && "local" in b
  const q = useQuery({ queryKey: ["GET /api/cases/batches/:id", b?.id], enabled: server === true && !!b && !isLocal, queryFn: () => request<CaseBatch & { rows: Row[] }>("GET /api/cases/batches/:id", { params: { id: b!.id } }) })
  if (!b) return null
  if (isLocal) return (b as S.LocalBatch).rows
  return q.data?.rows ?? null
}

export const createBatch = async (o: { line: Line; week: string | null; from: string; to: string; unit: CaseUnit; filters: CaseFilters; strategy: CaseBatch["strategy"]; size: number; perGroup: number; name: string; server: boolean | null; pool: Row[] | null; L: Lookup; sample: (pool: Row[]) => Row[] }) => {
  const fq = Object.fromEntries(Object.entries(filtersToQuery(o.filters)).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  if (o.server) {
    const b = await request<CaseBatch>("POST /api/cases/batches", { body: { line: o.line, from: o.from, to: o.to, unit: o.unit, filters: fq, strategy: o.strategy, size: o.size, perGroup: o.perGroup, seed: Math.floor(Math.random() * 1e9), name: o.name } })
    const full = await request<CaseBatch & { rows: Row[] }>("GET /api/cases/batches/:id", { params: { id: b.id } })
    return { batch: full as CaseBatch, rows: full.rows }
  }
  const rows = o.sample(o.pool ?? [])
  const batch = S.addBatchLocal({ line: o.line, name: o.name, strategy: o.strategy, filters: fq, rows, week: o.week })
  return { batch: batch as CaseBatch, rows: batch.rows }
}

export const deleteBatch = async (b: CaseBatch) => {
  if ("local" in b) return S.deleteBatchLocal(b.id)
  try {
    await request("DELETE /api/cases/batches/:id", { params: { id: b.id } })
  } catch (e) {
    toast(errorText(e), { tone: "error" })
  }
}

export interface ViewAnalysis extends Omit<CaseAnalysis, "cost"> {
  cost: CaseAnalysis["cost"] | null
  rows: Row[]
  local: boolean
}

const mergeLocal = (a: S.LocalAnalysis, parts: (RecordAnalysis | undefined)[]): ViewAnalysis => {
  const done = parts.filter((p): p is RecordAnalysis => !!p)
  const states = done.map((p) => p.state)
  const state = states.length < a.parts.length || states.some((s) => s === "queued" || s === "running") ? (states.some((s) => s === "running") ? "running" : "queued") : states.every((s) => s === "failed") ? "failed" : "done"
  const toCase = (pi: number, rk: string) => a.parts[pi]?.rowKeys[rk] ?? rk
  const per = new Map<string, { id: string; rating: "good" | "ok" | "bad"; tags: string[]; note: string }>()
  const worse = { good: 0, ok: 1, bad: 2 }
  done.forEach((p, pi) =>
    p.perRecord.forEach((x) => {
      const id = toCase(pi, x.rowKey)
      const cur = per.get(id)
      if (!cur || worse[x.verdict] > worse[cur.rating]) per.set(id, { id, rating: x.verdict, tags: [], note: x.note })
    }),
  )
  return {
    id: a.id,
    line: a.line,
    items: a.items,
    question: a.question,
    state,
    headline: done.map((p) => p.headline).filter(Boolean).join("；"),
    clusters: done.flatMap((p, pi) =>
      p.findings.map((x) => ({
        title: x.text,
        summary: "",
        tags: [],
        caseIds: [...new Set(x.rowKeys.map((k) => toCase(pi, k)))],
        enterprises: [p.enterprise],
        severity: x.confidence === "high" ? ("high" as const) : x.confidence === "medium" ? ("medium" as const) : ("low" as const),
      })),
    ),
    perCase: [...per.values()],
    suggestions: done.flatMap((p) => p.suggestions).slice(0, 6),
    cost: null,
    error: done.find((p) => p.error)?.error ?? null,
    createdAt: a.createdAt,
    finishedAt: null,
    rows: a.rows,
    local: true,
  }
}

export const useAnalyses = (line: Line, server: boolean | null) => {
  S.useStore()
  const remote = useQuery({
    queryKey: ["GET /api/cases/analyses", line],
    enabled: server === true,
    queryFn: () => request<(CaseAnalysis & { rows?: Row[] })[]>("GET /api/cases/analyses", { query: { line } }),
    refetchInterval: (q) => ((q.state.data ?? []).some((a) => a.state === "queued" || a.state === "running") ? 3000 : false),
  })
  const locals = S.getState().analyses.filter((a) => a.line === line)
  const ids = locals.flatMap((a) => a.parts.map((p) => p.analysisId))
  const parts = useQuery({
    queryKey: ["case-analyses", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const out = await Promise.all(ids.map((id) => call("GET /api/records/analyses/:id", { params: { id } }).catch(() => undefined)))
      return new Map(ids.map((id, i) => [id, out[i]]))
    },
    refetchInterval: (q) => ([...(q.state.data?.values() ?? [])].some((a) => a && (a.state === "queued" || a.state === "running")) ? 3000 : false),
  })
  const list: ViewAnalysis[] = [
    ...(server === true ? (remote.data ?? []).map((a) => ({ ...a, rows: a.rows ?? [], local: false })) : []),
    ...locals.map((a) => mergeLocal(a, a.parts.map((p) => parts.data?.get(p.analysisId)))),
  ]
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export const imagesOf = (rows: Row[]) => rows.reduce((s, r) => s + r.first.inputs.length + Math.min(3, r.stepCount), 0)

export const estimate = async (rows: Row[], server: boolean | null) => {
  if (server) {
    try {
      return await request<{ cases: number; images: number; estimated: number; currency: string }>("POST /api/cases/analyses/estimate", { body: { items: rows.map((r) => ({ id: r.id, unit: r.unit })) } })
    } catch {}
  }
  return { cases: rows.length, images: imagesOf(rows), estimated: null as number | null, currency: "CNY" }
}

const pickKeys = (r: Row) => {
  const steps = r.steps ?? [r.first, r.last]
  const keep = new Set([steps[0], steps[steps.length - 1], steps.find((s) => s.result === "downloaded")].filter(Boolean).map((s) => s!.rowKey))
  return [...keep]
}

export const startAnalysis = async (line: Line, rows: Row[], question: string, server: boolean | null) => {
  if (server) {
    await request("POST /api/cases/analyses", { body: { line, items: rows.map((r) => ({ id: r.id, unit: r.unit })), question: question || undefined } })
    return
  }
  const groups = new Map<string, Row[]>()
  rows.forEach((r) => groups.set(r.enterprise.id, [...(groups.get(r.enterprise.id) ?? []), r]))
  const parts: S.LocalAnalysis["parts"] = []
  for (const [ent, rs] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
    const map: Record<string, string> = {}
    const keys: string[] = []
    rs.forEach((r) => pickKeys(r).forEach((k) => keys.length < 40 && ((map[k] = r.id), keys.push(k))))
    const a = await call("POST /api/records/analyses", { body: { enterprise: ent, rowKeys: keys, question: question || undefined } })
    parts.push({ enterprise: ent, name: rs[0].enterprise.name, analysisId: a.id, rowKeys: map })
  }
  S.addAnalysisLocal({ id: `local-${Date.now().toString(36)}`, line, items: rows.map((r) => ({ id: r.id, unit: r.unit })), question: question || null, createdAt: new Date().toISOString(), parts, rows: rows.map((r) => ({ ...r, steps: r.steps?.map(({ task: _t, ...s }) => s) ?? null })) })
}

export const deleteAnalysis = async (a: ViewAnalysis) => {
  if (a.local) {
    const la = S.getState().analyses.find((x) => x.id === a.id)
    la?.parts.forEach((p) => call("DELETE /api/records/analyses/:id", { params: { id: p.analysisId } }).catch(() => undefined))
    return S.deleteAnalysisLocal(a.id)
  }
  try {
    await request("DELETE /api/cases/analyses/:id", { params: { id: a.id } })
  } catch (e) {
    toast(errorText(e), { tone: "error" })
  }
}

const weekOf = (t: string) => {
  const d = new Date(new Date(t).getTime() + 8 * 3600e3)
  const wd = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - wd * 86400e3).toISOString().slice(0, 10)
}

export const useIssues = (line: Line, week: string | null, server: boolean | null, tags: CaseTag[]) => {
  const v = S.useStore()
  const q = useQuery({ queryKey: ["GET /api/cases/issues", line, week], enabled: server === true && !!week, queryFn: () => request<CaseIssue[]>("GET /api/cases/issues", { query: { line, week: week ?? undefined } }) })
  const local = useMemo(() => {
    if (server !== false) return null
    const byTag = new Map<string, Row[]>()
    Object.values(S.getState().reviews).forEach((r) => {
      if (r.snap.line !== line) return
      r.tags.forEach((t) => byTag.set(t, [...(byTag.get(t) ?? []), { ...r.snap, review: r }]))
    })
    return [...byTag]
      .map(([id, rows]): CaseIssue & { rows: Row[] } => {
        const tag = tags.find((t) => t.id === id) ?? { id, group: "", label: id.replace(/^local:.*\//, ""), lines: [line], tone: "bad", order: 999, archived: false }
        const ents = new Map<string, { enterprise: Row["enterprise"]; cases: number }>()
        rows.forEach((r) => {
          const e = ents.get(r.enterprise.id) ?? { enterprise: r.enterprise, cases: 0 }
          e.cases++
          ents.set(r.enterprise.id, e)
        })
        const weeks = new Map<string, number>()
        rows.forEach((r) => weeks.set(weekOf(r.startedAt), (weeks.get(weekOf(r.startedAt)) ?? 0) + 1))
        return {
          tag,
          cases: rows.length,
          enterprises: ents.size,
          topEnterprises: [...ents.values()].sort((a, b) => b.cases - a.cases).slice(0, 5),
          weekly: [...weeks].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-8).map(([week, cases]) => ({ week, cases })),
          samples: [...rows].sort((a, b) => (a.review?.rating === "bad" ? -1 : 0) - (b.review?.rating === "bad" ? -1 : 0)).slice(0, 4).map((r) => ({ id: r.id, unit: r.unit, thumb: thumbOf(r) })),
          linked: { followups: 0, opportunities: 0, templates: 0 },
          rows,
        }
      })
      .sort((a, b) => b.cases - a.cases)
  }, [server, line, tags, v])
  return { list: server === true ? q.data ?? null : local, loading: server === true ? q.isLoading : server === null, error: q.error }
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const exportCases = async (o: { line: Line; week: string | null; unit: CaseUnit; rows: Row[] | null; filters: CaseFilters; server: boolean | null; L: Lookup; tags: CaseTag[]; anns: Annotation[]; fileTag?: string }) => {
  const range = o.week ? `${o.week}` : ""
  const name = `记录_${lineName[o.line]}_${o.fileTag ?? range}`
  if (o.server) {
    const query = o.rows ? { line: o.line, week: o.week ?? undefined, unit: o.unit, ids: o.rows.map((r) => r.id).join(",") } : { line: o.line, week: o.week ?? undefined, unit: o.unit, ...filtersToQuery(o.filters) }
    return download(rawUrl("GET /api/cases/export", query), `${name}.xlsx`)
  }
  const rows = o.rows ?? []
  if (!rows.length) return toast("没有可导出的记录", { tone: "error" })
  const tagName = new Map(o.tags.map((t) => [t.id, t.label]))
  const notesOf = (r: Row) => {
    const blocks = new Set([r.unit === "chain" ? `case:${r.id}` : `record:${r.id}`, ...(r.steps ?? []).map((s) => `record:${s.rowKey}`)])
    return o.anns
      .filter((a) => blocks.has(a.anchor?.block ?? ""))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 3)
      .map((a) => `${a.updatedAt.slice(5, 10)} ${a.entries.map((e) => e.text).join(" / ")}`)
      .join("\n")
  }
  const head = ["企业", "层级", "动向", "账号", "开始时间", "意图", "模式", "模型", "规格", "步数", "结局", "第几步下载", "耗时(秒)", "耗点", "第一步提示词", "最后一步提示词", "输入图", "最终结果", "FD 链接", "评价", "标签", "状态", "批注"]
  const lines = rows.map((r) => {
    const rv = o.L.review(r)
    return [
      r.enterprise.name,
      r.enterprise.level ?? "",
      r.enterprise.movement ?? "",
      r.user?.name ?? "",
      r.startedAt.replace("T", " ").slice(0, 16),
      r.intent ?? "",
      r.mode,
      r.model ?? "",
      [r.config.resolution, r.config.ratio, r.config.videoDuration ? `${r.config.videoDuration}s` : null].filter(Boolean).join(" "),
      r.stepCount,
      outcomeName[r.outcome],
      r.downloadedAt == null ? "" : r.downloadedAt + 1,
      r.durationSeconds == null ? "" : Math.round(r.durationSeconds),
      r.points,
      r.first.prompt,
      r.last.prompt,
      r.first.inputs.map((m) => m.url).join("\n"),
      r.last.outputs.map((m) => m.url).join("\n") || resultName[r.last.result],
      r.fdUrl ?? "",
      rv?.rating ? ratingName[rv.rating] : "",
      (rv?.tags ?? []).map((t) => tagName.get(t) ?? t).join("\n"),
      statusName[rv?.status ?? "todo"],
      notesOf(r),
    ]
  })
  const csv = "\ufeff" + [head, ...lines].map((l) => l.map(csvCell).join(",")).join("\r\n")
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  a.download = `${name}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export const useSyncLocal = (server: boolean | null, line: Line) => {
  const qc = useQueryClient()
  const done = useRef(false)
  useEffect(() => {
    if (server !== true || done.current || !S.pendingSync()) return
    done.current = true
    ;(async () => {
      try {
        const st = S.getState()
        const remote = await request<CaseTag[]>("GET /api/cases/tags", { query: { line, all: true } })
        const map = new Map<string, string>()
        const all = [...presetTags, ...st.tags]
        for (const t of all) {
          const hit = remote.find((r) => r.label === t.label && r.group === t.group)
          if (hit) map.set(t.id, hit.id)
        }
        const groups = new Map<string, { items: CaseRef[]; body: S.ReviewPatch }>()
        for (const [k, r] of Object.entries(st.reviews)) {
          const tags: string[] = []
          for (const t of r.tags) {
            if (!map.has(t)) {
              const src = all.find((x) => x.id === t)
              if (src) {
                const made = await request<CaseTag>("POST /api/cases/tags", { body: { group: src.group, label: src.label, lines: src.lines, tone: src.tone } }).catch(() => null)
                if (made) map.set(t, made.id)
              }
            }
            if (map.has(t)) tags.push(map.get(t)!)
          }
          const body = { rating: r.rating, addTags: tags, status: r.status }
          const g = JSON.stringify(body)
          const [unit, ...rest] = k.split(":")
          const cur = groups.get(g) ?? { items: [] as CaseRef[], body }
          cur.items.push({ id: rest.join(":"), unit: unit as CaseUnit })
          groups.set(g, cur)
        }
        for (const g of groups.values()) for (let i = 0; i < g.items.length; i += 500) await request("PUT /api/cases/reviews", { body: { items: g.items.slice(i, i + 500), ...g.body } })
        for (const c of st.collections) {
          const made = await request<CaseCollection>("POST /api/cases/collections", { body: { line: c.line, name: c.name } })
          if (c.rows.length) await request("PUT /api/cases/collections/:id/items", { params: { id: made.id }, body: { add: c.rows.map((r) => ({ id: r.id, unit: r.unit })) } })
        }
        const n = Object.keys(st.reviews).length
        S.resetSynced(true, true)
        qc.invalidateQueries({ queryKey: ["GET /api/cases"] })
        qc.invalidateQueries({ queryKey: ["GET /api/cases/collections"] })
        if (n) toast(`本机的 ${n} 条评价已同步`)
      } catch (e) {
        done.current = false
        toast(errorText(e, "本机评价同步失败"), { tone: "error" })
      }
    })()
  }, [server, line])
}
