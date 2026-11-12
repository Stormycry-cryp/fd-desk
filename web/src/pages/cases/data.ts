import { useEffect, useMemo, useRef } from "react"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Annotation, Line } from "@spec/contract"
import { call, isMissing, rawUrl, request, RequestError } from "../../api/client"
import { errorText, watchJob } from "../../api/next"
import { lineName } from "../../lib/labels"
import { download } from "../../lib/download"
import { navigate } from "../../lib/route"
import { toast } from "../../ui/overlays"
import type { CaseAnalysis, CaseBatch, CaseFilters, CaseLibraryStats, CasePage, CaseRef, CaseSort, CaseTag, CaseUnit, PoolEntry, Processed, Review, Row, Step } from "./types"
import { caseKey } from "./types"
import { FALSE_ALARM, computeStats, filtersToQuery, isFalseAlarm, passLocal, type LibraryStats, type Lookup } from "./model"
import * as S from "./store"

const retry = (n: number, e: unknown) => !(e instanceof RequestError && (e.missing || e.status < 500)) && n < 2

type RawReview = { tags?: string[]; effectiveTags?: string[]; inherited?: boolean; processedAt?: string | null; updatedAt?: string } | null

const normReview = (v: RawReview, step: boolean): Review | null => {
  if (!v) return null
  const own = step && v.inherited ? [] : v.tags ?? []
  return { tags: own, effectiveTags: v.effectiveTags ?? v.tags ?? [], inherited: !!v.inherited, processedAt: v.processedAt ?? (own.length ? v.updatedAt ?? null : null), updatedAt: v.updatedAt ?? "" }
}

const normStep = (s: Step): Step => ({ ...s, review: normReview(s.review as RawReview, true) })

export const normRow = (r: Row): Row => ({ ...r, review: normReview(r.review as RawReview, false), first: normStep(r.first), last: normStep(r.last), steps: r.steps ? r.steps.map(normStep) : null })

export const useProbe = (line: Line, week: string | null) => {
  const q = useQuery({
    queryKey: ["cases-probe", line, week],
    enabled: !!week,
    staleTime: 60000,
    retry,
    queryFn: () => request<CasePage>("GET /api/cases", { query: { line, week, limit: 1 } }),
  })
  const legacy = q.data ? !("processed" in (q.data.facets as object)) : true
  return { ready: q.isSuccess, error: q.error, legacy, retry: () => q.refetch() }
}

export const useAllAnnotations = () => useQuery({ queryKey: ["GET /api/annotations", "cases-all"], queryFn: () => call("GET /api/annotations", { query: {} }), staleTime: 30000 })

export const useLookup = (anns: Annotation[] | undefined, pool: Set<string>): Lookup => {
  const v = S.useStore()
  const noteMap = useMemo(() => {
    const m = new Map<string, number>()
    ;(anns ?? []).forEach((a) => {
      const b = a.anchor?.block ?? ""
      if (b.startsWith("case:") || b.startsWith("record:")) m.set(b, (m.get(b) ?? 0) + 1)
    })
    return m
  }, [anns])
  return useMemo<Lookup>(() => {
    const ownOf = (r: Row) => S.ownOverlay(caseKey(r))?.tags ?? r.review?.tags ?? []
    const review = (r: Row): Review | null => {
      const o = S.ownOverlay(caseKey(r))
      if (!o && !S.stepOverlay(r.id)) return r.review
      const own = o?.tags ?? r.review?.tags ?? []
      const fromSteps = new Set((r.review?.effectiveTags ?? []).filter((t) => !(r.review?.tags ?? []).includes(t)))
      S.stepOverlay(r.id)?.forEach((ts) => ts.forEach((t) => fromSteps.add(t)))
      const eff = [...new Set([...own, ...fromSteps])]
      return { tags: own, effectiveTags: eff, inherited: false, processedAt: eff.length ? r.review?.processedAt ?? o?.at ?? null : null, updatedAt: o?.at ?? r.review?.updatedAt ?? "" }
    }
    const stepReview = (r: Row, s: Step): Review | null => {
      const k = `task:${s.rowKey}`
      const o = S.ownOverlay(k)
      const own = o?.tags ?? s.review?.tags ?? []
      if (own.length) return { tags: own, effectiveTags: own, inherited: false, processedAt: s.review?.processedAt ?? o?.at ?? null, updatedAt: o?.at ?? s.review?.updatedAt ?? "" }
      const chain = ownOf(r)
      return chain.length ? { tags: [], effectiveTags: chain, inherited: true, processedAt: null, updatedAt: "" } : null
    }
    const notes = (r: Row) => {
      let n = noteMap.get(r.unit === "chain" ? `case:${r.id}` : `record:${r.id}`) ?? 0
      ;(r.steps ?? []).forEach((s) => (n += noteMap.get(`record:${s.rowKey}`) ?? 0))
      return Math.max(n, r.annotationCount + S.extraNotes(caseKey(r)))
    }
    const processed = (r: Row): Processed => {
      const eff = review(r)?.effectiveTags ?? []
      if (eff.length) return "done"
      return notes(r) > 0 ? "noted" : "todo"
    }
    return { review, stepReview, notes, processed, inPool: (r) => !!r.pool || pool.has(caseKey(r)) }
  }, [noteMap, pool, v])
}

export interface CaseList {
  rows: Row[]
  total: number
  loaded: number
  summary: CasePage["summary"] | null
  facets: CasePage["facets"] | null
  loading: boolean
  fetching: boolean
  error: unknown
  more: boolean
  loadMore: () => void
  retry: () => void
}

const PAGE = 40
const FAR = { from: "2020-01-01", to: "2099-12-31" }

export const libraryQuery = (line: Line, unit: CaseUnit, legacy: boolean, tags: CaseTag[]) =>
  legacy ? { line, unit, ...FAR, tag: tags.map((t) => t.id).join(",") || "none" } : { line, unit, scope: "library", processed: "done" }

export const useCaseList = (o: { line: Line; week: string | null; unit: CaseUnit; filters: CaseFilters; sort: CaseSort; scope: "week" | "library"; legacy: boolean; ready: boolean; hide: boolean; tags: CaseTag[]; L: Lookup }): CaseList => {
  const f = o.hide && !o.filters.processed.length ? { ...o.filters, processed: ["todo", "noted"] as Processed[] } : o.filters
  const base = o.scope === "library" ? libraryQuery(o.line, o.unit, o.legacy, o.tags) : { line: o.line, week: o.week ?? undefined, unit: o.unit }
  const fq = filtersToQuery(f, o.legacy)
  if (o.scope === "library" && o.legacy && fq.tag) delete (base as { tag?: string }).tag
  const sort = o.sort === "processed" ? (o.legacy ? "newest" : undefined) : o.sort
  const sq = { ...base, ...fq, sort }
  const q = useInfiniteQuery({
    queryKey: ["GET /api/cases", sq],
    enabled: o.ready && (o.scope === "library" || !!o.week) && (o.scope !== "library" || !o.legacy || o.tags.length > 0),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const p = await request<CasePage>("GET /api/cases", { query: { ...sq, offset: pageParam, limit: PAGE } })
      return { ...p, items: (p.items as unknown as Row[]).map(normRow) }
    },
    getNextPageParam: (last, all) => {
      const n = all.reduce((s, p) => s + p.items.length, 0)
      return n < last.total ? n : undefined
    },
    retry,
  })
  const pages = q.data?.pages ?? []
  const all = pages.flatMap((p) => p.items)
  const rows = o.legacy ? all.filter((r) => passLocal(r, f, o.L)) : all
  const more = !!q.hasNextPage
  const fetchNext = q.fetchNextPage
  const fetching = q.isFetchingNextPage
  useEffect(() => {
    if (more && !fetching && rows.length < 12 && all.length > 0) fetchNext()
  }, [more, fetching, rows.length, all.length])
  return {
    rows,
    total: pages[0]?.total ?? 0,
    loaded: all.length,
    summary: pages[0]?.summary ?? null,
    facets: pages[0]?.facets ?? null,
    loading: !o.ready || q.isLoading,
    fetching,
    error: q.error,
    more,
    loadMore: () => fetchNext(),
    retry: () => q.refetch(),
  }
}

export const useCaseDetail = (row: Row | null, week: string | null, enabled = true) =>
  useQuery({
    queryKey: ["GET /api/cases/:id", row?.id, row?.unit, week],
    enabled: enabled && !!row && (row.unit === "chain" ? row.stepCount > 1 || !row.steps : false),
    staleTime: 30000,
    queryFn: async () => normRow(await request<Row>("GET /api/cases/:id", { params: { id: row!.id }, query: { unit: row!.unit, week: week ?? undefined } })),
  })

const localFalseAlarm: CaseTag = { id: `pending:${FALSE_ALARM}`, group: "判断", label: "其实没问题", lines: [], tone: "good", order: 999, archived: false, uses: 0 }

export const useCaseTags = (line: Line, ready: boolean, legacy: boolean) => {
  const q = useQuery({ queryKey: ["GET /api/cases/tags", line], enabled: ready, staleTime: 60000, queryFn: () => request<(Omit<CaseTag, "uses"> & { uses?: number })[]>("GET /api/cases/tags", { query: { line } }) })
  const list = useMemo(() => (q.data ?? []).map((t) => ({ ...t, uses: t.uses ?? -1 })).filter((t) => !t.archived && (!t.lines.length || t.lines.includes(line)) && !(t.group === "值得关注" && t.label === "可做模板")), [q.data, line])
  const needUses = ready && list.length > 0 && list.every((t) => t.uses < 0)
  const usage = useQuery({
    queryKey: ["GET /api/cases", "tag-uses", line],
    enabled: needUses,
    staleTime: 5 * 60000,
    queryFn: () => request<CasePage>("GET /api/cases", { query: { ...libraryQuery(line, "chain", legacy, list), limit: 1 } }),
  })
  const uses = useMemo(() => {
    const m = new Map<string, number>()
    list.forEach((t) => t.uses >= 0 && m.set(t.id, t.uses))
    usage.data?.facets.tags.forEach((x) => m.set(x.key, x.count))
    return m
  }, [list, usage.data])
  const frozen = useRef<string[] | null>(null)
  const sorted = useMemo(() => {
    const xs = [...list]
    if (!xs.some(isFalseAlarm)) xs.push(localFalseAlarm)
    const rankOf = (t: CaseTag) => (isFalseAlarm(t) ? -1 : uses.get(t.id) ?? 0)
    const fresh = [...xs].sort((a, b) => rankOf(b) - rankOf(a) || a.order - b.order)
    if (!frozen.current && (!needUses || usage.isFetched)) frozen.current = fresh.map((t) => t.id)
    const order = frozen.current ?? fresh.map((t) => t.id)
    const pos = new Map(order.map((id, i) => [id, i]))
    return [...xs].sort((a, b) => (pos.get(a.id) ?? 1e4 + a.order) - (pos.get(b.id) ?? 1e4 + b.order))
  }, [list, uses, needUses, usage.isFetched])
  return { tags: sorted, loading: q.isLoading || (needUses && usage.isLoading), uses }
}

export const useEnsureTag = (line: Line) => {
  const qc = useQueryClient()
  return async (t: CaseTag | { group: string; label: string; tone?: CaseTag["tone"] }): Promise<CaseTag | null> => {
    if ("id" in t && !t.id.startsWith("pending:")) return t
    try {
      const made = await request<CaseTag>("POST /api/cases/tags", { body: { group: t.group, label: t.label, lines: "lines" in t && t.lines.length ? t.lines : [line], tone: t.tone ?? "bad" } })
      qc.invalidateQueries({ queryKey: ["GET /api/cases/tags"] })
      return made
    } catch (e) {
      toast(errorText(e, "标签没建成"), { tone: "error" })
      return null
    }
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null

export const useTagOps = (L: Lookup) => {
  const qc = useQueryClient()
  const soft = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["GET /api/cases/batches"] })
      qc.invalidateQueries({ queryKey: ["cases-library"] })
    }, 1200)
  }
  const send = async (items: CaseRef[], body: { addTags?: string[]; removeTags?: string[]; setTags?: string[] }, undo: () => void) => {
    try {
      for (let i = 0; i < items.length; i += 500) await request("PUT /api/cases/reviews", { body: { items: items.slice(i, i + 500), ...body } })
      soft()
    } catch (e) {
      undo()
      toast(errorText(e, "标签没保存"), { tone: "error" })
    }
  }
  const apply = (cur: string[], p: { add?: string[]; remove?: string[] }) => {
    const s = new Set(cur)
    p.add?.forEach((t) => s.add(t))
    p.remove?.forEach((t) => s.delete(t))
    return [...s]
  }
  const rows = (rs: Row[], p: { add?: string[]; remove?: string[] }) => {
    if (!rs.length) return
    const keys = rs.map(caseKey)
    rs.forEach((r) => S.setOwn(caseKey(r), apply(L.review(r)?.tags ?? [], p), null))
    void send(rs.map((r) => ({ id: r.id, unit: r.unit })), { addTags: p.add, removeTags: p.remove }, () => keys.forEach(S.dropOwn))
  }
  const step = (r: Row, s: Step, next: string[], hadOwn: boolean) => {
    const k = `task:${s.rowKey}`
    const cur = L.stepReview(r, s)
    const base = hadOwn ? cur?.tags ?? [] : []
    S.setOwn(k, next, r.id)
    const add = next.filter((t) => !base.includes(t))
    const remove = base.filter((t) => !next.includes(t))
    void send([{ id: s.rowKey, unit: "task" }], hadOwn ? { addTags: add, removeTags: remove } : { setTags: next }, () => S.dropOwn(k))
  }
  return { rows, step }
}

export const useQuickNote = () => {
  const qc = useQueryClient()
  return async (r: Row, s: Step | null, text: string, block: string) => {
    const t = text.trim()
    if (!t) return
    S.bumpNotes(caseKey(r))
    try {
      const a = await call("POST /api/annotations", { body: { enterprise: r.enterprise.id, text: t, anchor: { block, quote: (s?.prompt ?? r.last.prompt ?? r.enterprise.name).slice(0, 60) } } })
      qc.setQueryData<Annotation[]>(["GET /api/annotations", "cases-all"], (xs) => (xs ? [a, ...xs] : xs))
      S.bumpNotes(caseKey(r), -1)
      qc.invalidateQueries({ queryKey: ["GET /api/annotations"] })
    } catch (e) {
      S.bumpNotes(caseKey(r), -1)
      toast(errorText(e, "评论没保存"), { tone: "error" })
    }
  }
}

export const usePool = (line: Line, ready: boolean) => {
  S.useStore()
  const q = useQuery({
    queryKey: ["GET /api/cases/pool", line],
    enabled: ready,
    retry,
    staleTime: 15000,
    queryFn: async () => {
      const r = await request<{ entries: PoolEntry[]; rows: Row[] }>("GET /api/cases/pool", { query: { line } })
      return { entries: r.entries, rows: r.rows.map(normRow) }
    },
  })
  const remote = q.isSuccess
  const local = S.localPool(line)
  const rows: Row[] = remote ? q.data.rows : local.map((p): Row => ({ ...p.row, pool: { id: p.id, unit: p.unit, line: p.line as Line, note: p.note, templateId: p.templateId, addedAt: p.addedAt } }))
  const keys = useMemo(() => new Set(rows.map(caseKey)), [rows.map(caseKey).join("|")])
  return { rows, keys, remote, loading: ready && q.isLoading && !q.isError }
}

export const usePoolOps = (line: Line, remote: boolean) => {
  const qc = useQueryClient()
  const sync = () => {
    qc.invalidateQueries({ queryKey: ["GET /api/cases/pool"] })
    qc.invalidateQueries({ queryKey: ["GET /api/cases"] })
  }
  return {
    toggle: async (rows: Row[], on: boolean) => {
      if (!remote) return S.togglePoolLocal(rows, on)
      try {
        await request("PUT /api/cases/pool", { body: { line, [on ? "add" : "remove"]: rows.map((r) => ({ id: r.id, unit: r.unit })) } })
        sync()
      } catch (e) {
        toast(errorText(e), { tone: "error" })
      }
    },
    note: async (r: Row, text: string | null) => {
      if (!remote) return S.notePoolLocal(r, text)
      try {
        await request("PUT /api/cases/pool", { body: { line, note: { ref: { id: r.id, unit: r.unit }, text } } })
        sync()
      } catch (e) {
        toast(errorText(e), { tone: "error" })
      }
    },
  }
}

export const makeTemplate = async (o: { line: Line; rows: Row[]; kind: "official" | "custom"; target: string | null; remote: boolean; onStart: () => void; onDone: () => void }) => {
  const refs = o.rows.map((r) => ({ id: r.id, unit: r.unit }))
  const body = (caseIds: unknown) => ({ line: o.line, kind: o.kind, target: o.target ?? undefined, caseIds, write: true })
  o.onStart()
  try {
    let r: { template: { id: string }; job: Parameters<typeof watchJob>[0] | null }
    try {
      r = await request("POST /api/templates", { body: body(refs) })
    } catch (e) {
      if (e instanceof RequestError && e.status === 422) r = await request("POST /api/templates", { body: body(refs.map((x) => x.id)) })
      else throw e
    }
    if (!o.remote) S.markPoolTemplate(refs, r.template.id)
    const open = () => navigate({ page: "templates", tpl: r.template.id, pane: "drafts" })
    if (r.job)
      watchJob(r.job, (j) => {
        o.onDone()
        if (j.state === "done") toast("模板草稿写好了", { tone: "ok", action: { label: "打开", run: open } })
        else toast(`撰写失败：${j.error?.message ?? ""}`, { tone: "error" })
      })
    else {
      o.onDone()
      open()
    }
    toast(`已用 ${o.rows.length} 条记录开始写模板`)
  } catch (e) {
    o.onDone()
    toast(errorText(e, "没能生成模板"), { tone: "error" })
  }
}

const fromServer = (x: CaseLibraryStats, tags: CaseTag[], week: string | null): LibraryStats => {
  const tagById = new Map(tags.map((t) => [t.id, t]))
  const intentN = new Map<string, number>()
  x.matrix.forEach((m) => intentN.set(m.intent, (intentN.get(m.intent) ?? 0) + m.cases))
  const weeks = x.weekly.filter((w, i) => w.processed > 0 || i >= x.weekly.length - 4)
  return {
    processed: x.processed,
    outcomes: x.outcomes,
    falseAlarm: x.falseAlarm,
    tags: x.tags.map((t) => ({ tag: tagById.get(t.tag.id) ?? t.tag, cases: t.cases, enterprises: t.enterprises, weekly: t.weekly, samples: [], top: t.topEnterprises as LibraryStats["tags"][number]["top"] })),
    weeks: weeks.map((w) => ({ week: w.week, processed: w.processed, falseAlarm: w.falseAlarm })),
    intents: [...intentN].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k),
    matrix: new Map(x.matrix.map((m) => [`${m.tag}|${m.intent}`, m.cases])),
    enterprises: x.enterprises as LibraryStats["enterprises"],
    thisWeek: x.weekly.find((w) => w.week === week)?.processed ?? 0,
  }
}

export const useLibraryStats = (line: Line, unit: CaseUnit, filters: CaseFilters, legacy: boolean, ready: boolean, tags: CaseTag[], L: Lookup, week: string | null) => {
  const fq = filtersToQuery({ ...filters, processed: [] }, legacy)
  const base = libraryQuery(line, unit, legacy, tags)
  if (legacy && fq.tag) delete (base as { tag?: string }).tag
  const v = S.useStore()
  const q = useQuery({
    queryKey: ["cases-library", line, unit, base, fq, legacy],
    enabled: ready && tags.length > 0,
    staleTime: 15000,
    queryFn: async (): Promise<{ server: CaseLibraryStats | null; rows: Row[] | null }> => {
      if (!legacy) {
        try {
          return { server: await request<CaseLibraryStats>("GET /api/cases/library/stats", { query: { line, unit, ...fq, weeks: 12 } }), rows: null }
        } catch (e) {
          if (!isMissing(e)) throw e
        }
      }
      const out: Row[] = []
      for (let offset = 0; offset < 2000; offset += 200) {
        const p = await request<CasePage>("GET /api/cases", { query: { ...base, ...fq, sort: "newest", offset, limit: 200 } })
        out.push(...(p.items as unknown as Row[]).map(normRow))
        if (out.length >= p.total || !p.items.length) break
      }
      return { server: null, rows: out }
    },
  })
  const stats = useMemo(() => (q.data?.server ? fromServer(q.data.server, tags, week) : q.data?.rows ? computeStats(q.data.rows, tags, L, week) : null), [q.data, tags, week, q.data?.rows ? v : 0])
  return { stats, loading: q.isLoading, error: q.error }
}

export const useBatches = (line: Line, ready: boolean) => {
  const q = useQuery({ queryKey: ["GET /api/cases/batches", line], enabled: ready, refetchOnMount: "always", queryFn: () => request<(Omit<CaseBatch, "processed"> & { processed?: number; reviewed?: number })[]>("GET /api/cases/batches", { query: { line } }) })
  return q.data ?? []
}

export const useBatchRows = (id: string | null) => {
  const q = useQuery({ queryKey: ["GET /api/cases/batches/:id", id], enabled: !!id, queryFn: async () => (await request<CaseBatch & { rows: Row[] }>("GET /api/cases/batches/:id", { params: { id: id! } })).rows.map(normRow) })
  return q.data ?? null
}

export const createBatch = async (o: { line: Line; from: string; to: string; unit: CaseUnit; filters: CaseFilters; legacy: boolean; strategy: CaseBatch["strategy"]; size: number; perGroup: number; name: string; skip: boolean }) => {
  const fq = Object.fromEntries(Object.entries(filtersToQuery(o.filters, o.legacy)).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
  const b = await request<CaseBatch>("POST /api/cases/batches", { body: { line: o.line, from: o.from, to: o.to, unit: o.unit, filters: fq, strategy: o.strategy, size: o.size, perGroup: o.perGroup, seed: Math.floor(Math.random() * 1e9), name: o.name, skipProcessed: o.skip, skipRated: o.skip } })
  const full = await request<CaseBatch & { rows: Row[] }>("GET /api/cases/batches/:id", { params: { id: b.id } })
  return { batch: full as CaseBatch, rows: full.rows.map(normRow) }
}

export const deleteBatch = async (b: CaseBatch) => {
  try {
    await request("DELETE /api/cases/batches/:id", { params: { id: b.id } })
  } catch (e) {
    toast(errorText(e), { tone: "error" })
  }
}

export type ViewAnalysis = CaseAnalysis & { rows: Row[] }

export const useAnalyses = (line: Line, ready: boolean) => {
  const q = useQuery({
    queryKey: ["GET /api/cases/analyses", line],
    enabled: ready,
    queryFn: async () => (await request<(CaseAnalysis & { rows?: Row[] })[]>("GET /api/cases/analyses", { query: { line } })).map((a) => ({ ...a, rows: (a.rows ?? []).map(normRow) })),
    refetchInterval: (q) => ((q.state.data ?? []).some((a) => a.state === "queued" || a.state === "running") ? 3000 : false),
  })
  return (q.data ?? []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export const estimate = async (rows: Row[]) => {
  try {
    return await request<{ cases: number; images: number; estimated: number | null; currency: string }>("POST /api/cases/analyses/estimate", { body: { items: rows.map((r) => ({ id: r.id, unit: r.unit })) } })
  } catch {
    return { cases: rows.length, images: rows.reduce((s, r) => s + r.first.inputs.length + Math.min(3, r.stepCount), 0), estimated: null, currency: "" }
  }
}

export const startAnalysis = (line: Line, rows: Row[], question: string) => request("POST /api/cases/analyses", { body: { line, items: rows.map((r) => ({ id: r.id, unit: r.unit })), question: question || undefined } })

export const deleteAnalysis = async (a: ViewAnalysis) => {
  try {
    await request("DELETE /api/cases/analyses/:id", { params: { id: a.id } })
  } catch (e) {
    toast(errorText(e), { tone: "error" })
  }
}

export const exportCases = (o: { line: Line; week: string | null; unit: CaseUnit; rows: Row[] | null; filters: CaseFilters; legacy: boolean; scope: "week" | "library" | "pool"; tags: CaseTag[] }) => {
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  const name = o.scope === "library" ? `案例集_${lineName[o.line]}_${day}` : o.scope === "pool" ? `可做模板_${lineName[o.line]}_${day}` : `记录_${lineName[o.line]}_${o.week ?? day}`
  const base = o.scope === "week" ? { line: o.line, week: o.week ?? undefined, unit: o.unit } : { line: o.line, unit: o.unit, ...FAR }
  const query = o.rows ? { ...base, ids: o.rows.map((r) => r.id).join(",") } : o.scope === "library" ? { ...libraryQuery(o.line, o.unit, o.legacy, o.tags), ...filtersToQuery(o.filters, o.legacy) } : { ...base, ...filtersToQuery(o.filters, o.legacy) }
  return download(rawUrl("GET /api/cases/export", query), `${name}.xlsx`)
}

export const isMissingErr = isMissing
