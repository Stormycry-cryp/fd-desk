import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import type { AlertKind, EnterpriseDetail, Line, Roster, Touch, TouchBoard, TouchSlot } from "@spec/contract"
import { call, RequestError, type CallOpts, type Res } from "./client"
import type { Api } from "@spec/contract"
import type { ApiNext } from "@spec/contract.next"

type Key = keyof (Api & ApiNext)

const q = <K extends Key>(key: K, opts: CallOpts<K> = {}, enabled = true) => ({
  queryKey: [key, opts.params ?? null, opts.query ?? null] as QueryKey,
  queryFn: () => call(key, opts),
  enabled,
  retry: (n: number, e: unknown) => !(e instanceof RequestError && (e.missing || e.status < 500)) && n < 2,
})

export const useMeta = () => useQuery({ ...q("GET /api/meta"), staleTime: 60000 })
export const useOverview = (line: Line, week?: string | null) => useQuery(q("GET /api/overview", { query: { line, week: week ?? "" } }, !!week))
export const useRoster = (line: Line, week?: string | null, model?: string) => useQuery(q("GET /api/enterprises", { query: { line, week: week ?? "", ...(model ? { model } : {}) } }, !!week))
export const useEnterprise = (id: string | null, week?: string | null) => useQuery(q("GET /api/enterprises/:id", { params: { id: id ?? "" }, query: { week: week ?? "" } }, !!id && !!week))
export const useTasks = (opts: CallOpts<"GET /api/tasks">["query"], enabled = true) => useQuery(q("GET /api/tasks", { query: opts }, enabled && !!opts?.week))
export const useChains = (opts: CallOpts<"GET /api/chains">["query"], enabled = true) => useQuery(q("GET /api/chains", { query: opts }, enabled && !!opts?.week))
export const useAlerts = (line: Line, week?: string | null, kind?: AlertKind) => useQuery(q("GET /api/alerts", { query: { line, week: week ?? "", kind } }, !!week))
export const useDaily = (line: Line, from: string | null, to: string | null, enterprise?: string) => useQuery({ ...q("GET /api/daily", { query: { line, from: from ?? "", to: to ?? "", enterprise } }, !!from && !!to), staleTime: 60000 })
export const useInspirationAnalysis = (week?: string | null, excluded = false) => useQuery(q("GET /api/analysis/inspiration", { query: { week: week ?? "", excluded } }, !!week))
export const useVideoAnalysis = (week?: string | null, excluded = false) => useQuery(q("GET /api/analysis/video", { query: { week: week ?? "", excluded } }, !!week))
export const useClusters = (line: Line, week?: string | null, enterprise?: string) => useQuery(q("GET /api/clusters", { query: { line, week: week ?? undefined, enterprise } }))
export const useDrafts = (line: Line) => useQuery(q("GET /api/drafts", { query: { line } }))
export const useTouches = (line: Line, week?: string | null) => useQuery(q("GET /api/touches", { query: { line, week: week ?? "" } }, !!week))
export const useFindings = (line?: Line) => useQuery(q("GET /api/findings", { query: { line } }))
export const useReport = (week?: string | null) => useQuery(q("GET /api/report", { query: { week: week ?? "" } }, !!week))
export const useImports = () => useQuery(q("GET /api/imports"))
export const useSettings = () => useQuery(q("GET /api/settings"))
export const useConversion = (line: Line) => useQuery(q("GET /api/conversion", { query: { line } }))
export const useCrossLine = (week?: string | null) => useQuery(q("GET /api/cross-line", { query: { week: week ?? "" } }, !!week))
export const useReruns = (enterprise: string) => useQuery({ ...q("GET /api/reruns", { query: { enterprise } }), refetchInterval: (query) => query.state.data?.some(r => r.state === "confirmed" || r.state === "running") ? 1500 : false })

export const useCall = <K extends Key>(key: K, invalidate: Key[] = [], extra?: { onSuccess?: (data: Res<K>, vars: CallOpts<K>) => void }) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (opts: CallOpts<K>) => call(key, opts),
    onSuccess: (data, vars) => {
      extra?.onSuccess?.(data, vars)
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] }))
    },
  })
}

const patchBoard = (b: TouchBoard, id: string, fn: (t: Touch) => Touch): TouchBoard => {
  let found: Touch | null = null
  const strip = (xs: Touch[]) => xs.filter((t) => (t.id === id ? ((found = fn(t)), false) : true))
  const slots = { mon: strip(b.slots.mon), wed: strip(b.slots.wed), fri: strip(b.slots.fri) } as Record<TouchSlot, Touch[]>
  const suggestions = strip(b.suggestions)
  if (!found) return b
  const t = found as Touch
  if (t.suggested) suggestions.unshift(t)
  else {
    const orig = [...b.slots[t.slot], ...b.suggestions].findIndex((x) => x.id === id)
    const list = slots[t.slot]
    const pos = b.slots[t.slot].findIndex((x) => x.id === id)
    if (pos >= 0) list.splice(pos, 0, t)
    else list.unshift(t)
    void orig
  }
  return { ...b, slots, suggestions }
}

export const usePatchTouch = (line: Line, week: string) => {
  const qc = useQueryClient()
  const key: QueryKey = ["GET /api/touches", null, { line, week }]
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CallOpts<"PATCH /api/touches/:id">["body"] }) => call("PATCH /api/touches/:id", { params: { id }, body }),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<TouchBoard>(key)
      if (prev && body) {
        const { draft, source, ...rest } = body
        qc.setQueryData<TouchBoard>(key, patchBoard(prev, id, (t) => ({ ...t, ...rest, draft: draft != null ? { text: draft, source: source ?? "manual", updatedAt: new Date().toISOString() } : t.draft })))
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises"] })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises/:id"] })
    },
  })
}

export const usePutNextAction = (line: Line, week: string) => {
  const qc = useQueryClient()
  const rosterKey: QueryKey = ["GET /api/enterprises", null, { line, week }]
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => call("PUT /api/enterprises/:id/next-action", { params: { id }, body: { line, text, source: "manual" } }),
    onMutate: async ({ id, text }) => {
      await qc.cancelQueries({ queryKey: rosterKey })
      const prev = qc.getQueryData<Roster>(rosterKey)
      if (prev) qc.setQueryData<Roster>(rosterKey, { ...prev, rows: prev.rows.map((r) => (r.enterprise.id === id ? { ...r, nextAction: { text, source: "manual", updatedAt: new Date().toISOString() } } : r)) })
      const dk: QueryKey = ["GET /api/enterprises/:id", { id }, { week }]
      const prevD = qc.getQueryData<EnterpriseDetail>(dk)
      if (prevD) {
        const ld = prevD.lines[line]
        if (ld) qc.setQueryData<EnterpriseDetail>(dk, { ...prevD, lines: { ...prevD.lines, [line]: { ...ld, nextAction: { text, source: "manual", updatedAt: new Date().toISOString() } } } })
      }
      return { prev, prevD, dk }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(rosterKey, ctx.prev)
      if (ctx?.prevD) qc.setQueryData(ctx.dk, ctx.prevD)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: rosterKey })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises/:id"] })
    },
  })
}
