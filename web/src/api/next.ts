import { useEffect, useRef } from "react"
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import type { Line, Pool } from "@spec/contract"
import type { Annotation, AnnotationKind, ApiNext, Job, JobKind, OpportunityState, Profile, TagDimension, TemplateKind, TemplateState, TrialRun } from "@spec/contract.next"
import { call, RequestError, type CallOpts } from "./client"
import { toast } from "../ui/overlays"

type K = keyof ApiNext

const key = <T extends K>(k: T, opts: CallOpts<T> = {}) => [k, opts.params ?? null, opts.query ?? null] as QueryKey

const q = <T extends K>(k: T, opts: CallOpts<T> = {}, enabled = true) => ({
  queryKey: key(k, opts),
  queryFn: () => call(k, opts),
  enabled,
  retry: (n: number, e: unknown) => !(e instanceof RequestError && (e.missing || e.status < 500)) && n < 2,
})

export const errorText = (e: unknown, fallback = "操作失败") => (e instanceof RequestError ? (e.missing ? "后端尚未提供" : e.message) : fallback)

export const useProfile = (id: string | null) => useQuery({ ...q("GET /api/profiles/:id", { params: { id: id ?? "" } }, !!id), staleTime: 30000 })
export const useProfileVersions = (id: string | null, enabled = true) => useQuery(q("GET /api/profiles/:id/versions", { params: { id: id ?? "" } }, !!id && enabled))
export const useRosterExtra = (line: Line, week: string | null) => useQuery({ ...q("GET /api/profiles/roster", { query: { line, week: week ?? "" } }, !!week), staleTime: 30000 })
export const useTags = (line?: Line) => useQuery({ ...q("GET /api/tags", { query: { line } }), staleTime: 60000 })
export const useAnnotations = (enterprise: string | null) => useQuery(q("GET /api/annotations", { query: { enterprise: enterprise ?? undefined } }, !!enterprise))
export const useMovements = (line: Line, week: string | null) => useQuery(q("GET /api/movements", { query: { line, week: week ?? "" } }, !!week))
export const useOpportunities = (line: Line, kind: TemplateKind, state?: OpportunityState) => useQuery(q("GET /api/templates/opportunities", { query: { line, kind, state } }))
export const useTemplates = (line: Line, kind: TemplateKind, state?: TemplateState) => useQuery(q("GET /api/templates", { query: { line, kind, state } }))
export const useTemplate = (id: string | null) => useQuery(q("GET /api/templates/:id", { params: { id: id ?? "" } }, !!id))
export const useMonitor = (line: Line, kind: TemplateKind) => useQuery(q("GET /api/templates/monitor", { query: { line, kind } }))
export const useTrialBudget = () => useQuery({ ...q("GET /api/trials/budget"), staleTime: 15000 })
export const useTrials = (template: string | null) => useQuery(q("GET /api/trials", { query: { template: template ?? undefined } }, !!template))
export const useFollowups = (line: Line, week: string | null) => useQuery(q("GET /api/followups", { query: { line, week: week ?? "" } }, !!week))
export const usePipeline = () =>
  useQuery({ ...q("GET /api/pipeline"), refetchInterval: (query) => (query.state.data?.latest && !query.state.data.latest.finishedAt ? 2000 : false) })

export const useTrial = (id: string | null) =>
  useQuery({
    ...q("GET /api/trials/:id", { params: { id: id ?? "" } }, !!id),
    refetchInterval: (query) => {
      const r = query.state.data as TrialRun | undefined
      return r && (r.state === "queued" || r.state === "running") ? 900 : false
    },
  })

const done = (s: Job["state"]) => s === "done" || s === "failed" || s === "cancelled"

const affects: Record<JobKind, QueryKey[]> = {
  facts: [["GET /api/profiles/:id"], ["GET /api/profiles/roster"]],
  profiles: [["GET /api/profiles/:id"], ["GET /api/profiles/roster"], ["GET /api/tags"], ["GET /api/profiles/:id/versions"]],
  movement: [["GET /api/movements"], ["GET /api/profiles/roster"], ["GET /api/profiles/:id"]],
  opportunities: [["GET /api/templates/opportunities"]],
  followups: [["GET /api/followups"]],
  monitor: [["GET /api/templates/monitor"]],
  draft_write: [["GET /api/templates"], ["GET /api/templates/:id"], ["GET /api/templates/opportunities"]],
  finding_recheck: [["GET /api/findings"]],
  export: [],
}

const watching = new Map<string, { kind: JobKind; onDone?: (j: Job) => void }>()
let timer: number | null = null

export const useJobWatcher = () => {
  const qc = useQueryClient()
  const ref = useRef(qc)
  ref.current = qc
  useEffect(() => {
    const tick = async () => {
      timer = null
      const ids = [...watching.keys()]
      await Promise.all(
        ids.map(async (id) => {
          try {
            const j = await call("GET /api/jobs/:id", { params: { id } })
            ref.current.setQueryData(key("GET /api/jobs/:id", { params: { id } }), j)
            if (done(j.state)) {
              const w = watching.get(id)
              watching.delete(id)
              affects[j.kind].forEach((k) => ref.current.invalidateQueries({ queryKey: k }))
              w?.onDone?.(j)
            }
          } catch (e) {
            if (e instanceof RequestError && e.status === 404) watching.delete(id)
          }
        }),
      )
      if (watching.size) timer = window.setTimeout(tick, 1500)
    }
    const kick = () => {
      if (timer == null && watching.size) timer = window.setTimeout(tick, 900)
    }
    window.addEventListener("fd-job", kick)
    kick()
    return () => window.removeEventListener("fd-job", kick)
  }, [])
}

export const watchJob = (j: Job, onDone?: (j: Job) => void) => {
  if (done(j.state)) return onDone?.(j)
  watching.set(j.id, { kind: j.kind, onDone })
  window.dispatchEvent(new Event("fd-job"))
}

export const useJob = (id: string | null) => useQuery({ queryKey: key("GET /api/jobs/:id", { params: { id: id ?? "" } }), queryFn: () => call("GET /api/jobs/:id", { params: { id: id! } }), enabled: false })

const touchProfile = (qc: ReturnType<typeof useQueryClient>, id: string, fn: (p: Profile) => Profile) => {
  const k = key("GET /api/profiles/:id", { params: { id } })
  const prev = qc.getQueryData<Profile>(k)
  if (prev) qc.setQueryData<Profile>(k, fn(prev))
  return () => prev && qc.setQueryData(k, prev)
}

export const useRefreshProfile = () =>
  useMutation({
    mutationFn: (id: string) => call("POST /api/profiles/:id/refresh", { params: { id } }),
    onSuccess: (j, id) => {
      toast("正在重新生成档案")
      watchJob(j, (r) => toast(r.state === "done" ? "档案已更新" : `档案生成失败：${r.error?.message ?? ""}`, { tone: r.state === "done" ? "ok" : "error" }))
      void id
    },
    onError: (e) => toast(errorText(e), { tone: "error" }),
  })

export const useSetTag = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { dimension: TagDimension; value: string | null }) => call("PUT /api/profiles/:id/tags", { params: { id }, body: b }),
    onMutate: (b) =>
      touchProfile(qc, id, (p) => ({
        ...p,
        tags: [...p.tags.filter((t) => t.dimension !== b.dimension), ...(b.value ? [{ dimension: b.dimension, value: b.value, source: "manual" as const }] : [])],
      })),
    onError: (e, _b, undo) => (undo?.(), toast(errorText(e), { tone: "error" })),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["GET /api/profiles/:id"] })
      qc.invalidateQueries({ queryKey: ["GET /api/profiles/roster"] })
      qc.invalidateQueries({ queryKey: ["GET /api/tags"] })
    },
  })
}

export const useSetHeadline = (id: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => call("PUT /api/profiles/:id/headline", { params: { id }, body: { text } }),
    onMutate: (text) => touchProfile(qc, id, (p) => ({ ...p, headline: { text, source: "manual", updatedAt: new Date().toISOString() } })),
    onError: (e, _t, undo) => (undo?.(), toast(errorText(e), { tone: "error" })),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["GET /api/profiles/:id"] })
      qc.invalidateQueries({ queryKey: ["GET /api/profiles/roster"] })
    },
  })
}

const annKey = (enterprise: string) => key("GET /api/annotations", { query: { enterprise } })

export const useAnnotate = (enterprise: string) => {
  const qc = useQueryClient()
  const sync = () => {
    qc.invalidateQueries({ queryKey: ["GET /api/annotations"] })
    qc.invalidateQueries({ queryKey: ["GET /api/profiles/:id"] })
    qc.invalidateQueries({ queryKey: ["GET /api/profiles/roster"] })
  }
  const patchList = (fn: (xs: Annotation[]) => Annotation[]) => {
    const k = annKey(enterprise)
    const prev = qc.getQueryData<Annotation[]>(k)
    if (prev) qc.setQueryData<Annotation[]>(k, fn(prev))
    const pk = key("GET /api/profiles/:id", { params: { id: enterprise } })
    const pp = qc.getQueryData<Profile>(pk)
    if (pp) qc.setQueryData<Profile>(pk, { ...pp, annotations: fn(pp.annotations) })
    return () => {
      if (prev) qc.setQueryData(k, prev)
      if (pp) qc.setQueryData(pk, pp)
    }
  }
  const replace = (a: Annotation) => (xs: Annotation[]) => (xs.some((x) => x.id === a.id) ? xs.map((x) => (x.id === a.id ? a : x)) : [a, ...xs])
  const fail = (e: unknown, undo?: () => void) => (undo?.(), toast(errorText(e, "保存失败"), { tone: "error" }))
  const create = useMutation({
    mutationFn: (b: { text: string; kind?: AnnotationKind; anchor?: { block: string; insightId?: string; quote?: string } }) => call("POST /api/annotations", { body: { enterprise, ...b } }),
    onMutate: (b) => {
      const now = new Date().toISOString()
      const temp: Annotation = {
        id: `tmp-${Date.now()}`,
        enterprise: { id: enterprise, name: "", kind: "unknown" },
        kind: b.kind ?? null,
        anchor: b.anchor ? { block: b.anchor.block, insightId: b.anchor.insightId ?? null, quote: b.anchor.quote ?? null, stale: false } : null,
        entries: [{ id: "tmp", text: b.text, createdAt: now, editedAt: null }],
        resolved: false,
        createdAt: now,
        updatedAt: now,
      }
      return { undo: patchList((xs) => [temp, ...xs]), temp: temp.id }
    },
    onSuccess: (a, _b, ctx) => patchList((xs) => xs.map((x) => (x.id === ctx?.temp ? a : x))),
    onError: (e, _b, ctx) => fail(e, ctx?.undo),
    onSettled: sync,
  })
  const append = useMutation({
    mutationFn: (b: { id: string; text: string }) => call("POST /api/annotations/:id/entries", { params: { id: b.id }, body: { text: b.text } }),
    onMutate: (b) => patchList((xs) => xs.map((x) => (x.id === b.id ? { ...x, entries: [...x.entries, { id: `tmp-${Date.now()}`, text: b.text, createdAt: new Date().toISOString(), editedAt: null }] } : x))),
    onSuccess: (a) => patchList(replace(a)),
    onError: (e, _b, undo) => fail(e, undo),
    onSettled: sync,
  })
  const update = useMutation({
    mutationFn: (b: { id: string; kind?: AnnotationKind | null; resolved?: boolean }) => call("PATCH /api/annotations/:id", { params: { id: b.id }, body: { kind: b.kind, resolved: b.resolved } }),
    onMutate: (b) => patchList((xs) => xs.map((x) => (x.id === b.id ? { ...x, ...(b.kind !== undefined ? { kind: b.kind } : {}), ...(b.resolved !== undefined ? { resolved: b.resolved } : {}) } : x))),
    onSuccess: (a) => patchList(replace(a)),
    onError: (e, _b, undo) => fail(e, undo),
    onSettled: sync,
  })
  const editEntry = useMutation({
    mutationFn: (b: { id: string; entryId: string; text: string }) => call("PATCH /api/annotations/:id/entries/:entryId", { params: { id: b.id, entryId: b.entryId }, body: { text: b.text } }),
    onMutate: (b) => patchList((xs) => xs.map((x) => (x.id === b.id ? { ...x, entries: x.entries.map((en) => (en.id === b.entryId ? { ...en, text: b.text, editedAt: new Date().toISOString() } : en)) } : x))),
    onSuccess: (a) => patchList(replace(a)),
    onError: (e, _b, undo) => fail(e, undo),
    onSettled: sync,
  })
  const removeEntry = useMutation({
    mutationFn: (b: { id: string; entryId: string }) => call("DELETE /api/annotations/:id/entries/:entryId", { params: { id: b.id, entryId: b.entryId } }),
    onMutate: (b) => patchList((xs) => xs.map((x) => (x.id === b.id ? { ...x, entries: x.entries.filter((en) => en.id !== b.entryId) } : x))),
    onSuccess: (a) => patchList(replace(a)),
    onError: (e, _b, undo) => fail(e, undo),
    onSettled: sync,
  })
  const remove = useMutation({
    mutationFn: (id: string) => call("DELETE /api/annotations/:id", { params: { id } }),
    onMutate: (id) => patchList((xs) => xs.filter((x) => x.id !== id)),
    onError: (e, _id, undo) => fail(e, undo),
    onSettled: sync,
  })
  return { create, append, update, editEntry, removeEntry, remove }
}

export const useAnalyzeMovement = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { enterprise: string; line: Line; week: string }) => call("POST /api/movements", { body: b }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["GET /api/movements"] })
      qc.invalidateQueries({ queryKey: ["GET /api/profiles/roster"] })
    },
    onError: (e) => toast(errorText(e), { tone: "error" }),
  })
}

export const useMovementPoll = (ids: string[]) => {
  const qc = useQueryClient()
  useEffect(() => {
    if (!ids.length) return
    const t = window.setInterval(async () => {
      const rs = await Promise.all(ids.map((id) => call("GET /api/movements/:id", { params: { id } }).catch(() => null)))
      if (rs.some((r) => r && (r.state === "done" || r.state === "failed"))) {
        qc.invalidateQueries({ queryKey: ["GET /api/movements"] })
        qc.invalidateQueries({ queryKey: ["GET /api/profiles/roster"] })
      }
    }, 2000)
    return () => window.clearInterval(t)
  }, [ids.join()])
}

export const useNext = <T extends K>(k: T, invalidate: K[] = [], opts: { ok?: string } = {}) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (o: CallOpts<T>) => call(k, o),
    onSuccess: () => {
      invalidate.forEach((x) => qc.invalidateQueries({ queryKey: [x] }))
      if (opts.ok) toast(opts.ok, { tone: "ok", ms: 1600 })
    },
    onError: (e) => toast(errorText(e), { tone: "error" }),
  })
}

export type { Pool }
