import type { Api, Authored, Finding, Line, Meta, Note, Pool, Source, TemplateDraft, TemplatePush, Touch, TouchSlot } from "@spec/contract"
import { clusters, conversion, imports, initExtras, inspirationAnalysis, videoAnalysis } from "./extras"
import { hash } from "./rand"
import { state } from "./state"
import { chainsOf, queryTasks } from "./tasks"
import { alertsFor, coverage, detail, entRef, overview, report, roster } from "./views"
import { BY_ID, ENTS, NOW, WEEKS, cellAt } from "./world"

export class MockError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

type Ctx = { params: Record<string, string>; query: Record<string, string>; body: any }
type Handler = (c: Ctx) => unknown

const now = () => new Date().toISOString()

const author = (prev: Authored | null | undefined, text: string, source: Source): Authored => {
  if (prev && prev.source === "manual" && source !== "manual") throw new MockError(409, "manual_locked", "已有手工内容")
  return { text, source, updatedAt: now() }
}

const bool = (v?: string) => (v == null ? undefined : v === "true" || v === "1")

let inited = false
const init = () => {
  if (inited) return
  inited = true
  for (const line of ["inspiration", "video"] as Line[]) {
    const w = 11
    const key = line === "video" ? "points" : "tasks"
    const cells = ENTS.map((e) => [e, cellAt(e, line, w)] as const).filter(([, c]) => c)
    const total = cells.reduce((s, [, c]) => s + c![key], 0)
    const top = cells.sort((a, b) => b[1]![key] - a[1]![key])[0]
    if (top && top[1]![key] / total >= 0.2) state.settings.excluded[line] = [top[0].ref.id]
  }
  initExtras()
}

const meta = (): Meta => ({
  lines: ["inspiration", "video"],
  weeks: [...WEEKS],
  coverage: (["inspiration", "video"] as Line[]).flatMap((l) => WEEKS.map((_, i) => coverage(l, i))),
  latestWeek: { inspiration: WEEKS[11], video: WEEKS[11] },
  excluded: state.settings.excluded,
  lastImportAt: "2026-11-10T09:12:00+08:00",
  siteBaseUrl: state.settings.siteBaseUrl,
  fdAccount: { ready: true, userName: "陈云哲", externalShareAllowed: true, checkedAt: NOW },
})

const patchTouch = (id: string, body: Partial<Touch> & { draft?: string; source?: Source }) => {
  const hit = state.findTouch(id)
  if (!hit) throw new MockError(404, "not_found", "触达不存在")
  const t = hit.list[hit.i]
  const { draft, source, ...rest } = body
  const next: Touch = { ...t, ...rest, draft: draft != null ? author(t.draft, draft, source ?? "manual") : t.draft }
  if (rest.status && ["sent", "replied", "closed"].includes(rest.status) && !t.sentAt) next.sentAt = now()
  hit.list[hit.i] = next
  return next
}

const draftLink = (fd: number | null, src: TemplateDraft["fdTemplateSource"]) => (fd ? `${state.settings.siteBaseUrl}/workbench/chatting-image/inspiration?templateId=${fd}${src && src !== "official" ? `&templateSource=${src}` : ""}` : null)

const routes: Record<string, Handler> = {
  "GET /api/meta": () => meta(),
  "GET /api/overview": ({ query }) => overview(query.line as Line, query.week),
  "GET /api/enterprises": ({ query }) => roster(query.line as Line, query.week),
  "GET /api/enterprises/export": () => ({ __blob: "enterprises.xlsx" }),
  "GET /api/enterprises/:id": ({ params, query }) => {
    const d = detail(params.id, query.week)
    if (!d) throw new MockError(404, "not_found", "企业不存在")
    return d
  },
  "PATCH /api/enterprises/:id": ({ params, query, body }) => {
    if (body.kind) state.kinds.set(params.id, body.kind)
    if (body.owner) state.owners.set(params.id, body.owner)
    if (body.summary != null) state.summaries.set(params.id, author(state.summaries.get(params.id), body.summary, body.source ?? "manual"))
    if (body.kind === "internal") for (const l of ["inspiration", "video"] as Line[]) if (!state.settings.excluded[l].includes(params.id)) state.settings.excluded[l].push(params.id)
    return detail(params.id, query.week ?? WEEKS[11])
  },
  "PUT /api/enterprises/:id/next-action": ({ params, body }) => {
    const k = `${params.id}|${body.line}`
    const a = author(state.nextActions.get(k), body.text, body.source)
    state.nextActions.set(k, a)
    return a
  },
  "POST /api/enterprises/:id/notes": ({ params, body }) => {
    const n: Note = { id: `n${Date.now().toString(36)}`, text: body.text, createdAt: now() }
    state.notes.set(params.id, [n, ...(state.notes.get(params.id) ?? [])])
    return n
  },
  "DELETE /api/notes/:id": ({ params }) => {
    for (const [k, list] of state.notes) state.notes.set(k, list.filter((n) => n.id !== params.id))
    return null
  },
  "GET /api/tasks": ({ query }) =>
    queryTasks({
      line: query.line as Line,
      week: query.week,
      enterprise: query.enterprise,
      pattern: query.pattern as never,
      intent: query.intent,
      mode: query.mode,
      model: query.model,
      downloaded: bool(query.downloaded),
      failed: bool(query.failed),
      sample: query.sample ? Number(query.sample) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    }),
  "GET /api/chains": ({ query }) => chainsOf(query.line as Line, query.week, query.enterprise, query.minLength ? Number(query.minLength) : 3, bool(query.downloaded)),
  "GET /api/alerts": ({ query }) => alertsFor(query.line as Line, query.week, query.kind as never),
  "PATCH /api/alerts/:id": ({ params, body }) => {
    if (body.dismissed) state.dismissed.add(params.id)
    else state.dismissed.delete(params.id)
    return { id: params.id, dismissed: body.dismissed }
  },
  "GET /api/analysis/inspiration": ({ query }) => inspirationAnalysis(query.week, bool(query.excluded) ?? false),
  "GET /api/analysis/video": ({ query }) => videoAnalysis(query.week, bool(query.excluded) ?? false),
  "GET /api/clusters": ({ query }) => clusters(query.line as Line, query.enterprise, bool(query.candidate)),
  "GET /api/drafts": ({ query }) => state.drafts.filter((d) => d.line === query.line),
  "POST /api/drafts": ({ body }) => {
    const c = body.clusterId ? clusters(body.line).find((x) => x.id === body.clusterId) : null
    const d: TemplateDraft = {
      id: `d${Date.now().toString(36)}`,
      line: body.line,
      title: { text: body.title, source: body.source, updatedAt: now() },
      prompt: { text: body.prompt, source: body.source, updatedAt: now() },
      slots: body.slots ?? [],
      scene: body.scene ?? c?.intent ?? null,
      clusterId: body.clusterId ?? null,
      status: "draft",
      scope: "owner",
      sourceEnterprises: c ? c.topEnterprises.map((t) => t.enterprise) : [],
      fdTemplateId: null,
      fdTemplateSource: null,
      link: null,
      pushedTo: [],
      pushes: [],
      createdAt: now(),
    }
    state.drafts.unshift(d)
    return d
  },
  "PATCH /api/drafts/:id": ({ params, body }) => {
    const i = state.drafts.findIndex((d) => d.id === params.id)
    if (i < 0) throw new MockError(404, "not_found", "草稿不存在")
    const d = state.drafts[i]
    const src: Source = body.source ?? "manual"
    const next: TemplateDraft = {
      ...d,
      title: body.title != null ? author(d.title, body.title, src) : d.title,
      prompt: body.prompt != null ? author(d.prompt, body.prompt, src) : d.prompt,
      slots: body.slots ?? d.slots,
      status: body.status ?? d.status,
      scope: body.scope ?? d.scope,
      fdTemplateId: body.fdTemplateId !== undefined ? body.fdTemplateId : d.fdTemplateId,
      fdTemplateSource: body.fdTemplateSource !== undefined ? body.fdTemplateSource : d.fdTemplateSource,
      pushedTo: body.pushedTo ? body.pushedTo.map((id: string) => entRef(id)).filter(Boolean) : d.pushedTo,
    }
    next.link = draftLink(next.fdTemplateId, next.fdTemplateSource)
    state.drafts[i] = next
    return next
  },
  "POST /api/drafts/:id/pushes": ({ params, body }) => {
    const d = state.drafts.find((x) => x.id === params.id)
    if (!d) throw new MockError(404, "not_found", "草稿不存在")
    const allowed = new Set(d.sourceEnterprises.map((e) => e.id))
    const receivers: TemplatePush["receivers"] = []
    const blocked: TemplatePush["blocked"] = []
    for (const id of body.enterprises as string[]) {
      const e = BY_ID.get(id)
      if (!e) continue
      if (d.scope === "owner" && !allowed.has(id)) {
        blocked.push({ enterprise: e.ref, reason: "模板来自其他企业的提示词，需改为通用后才能推送" })
        continue
      }
      e.members.slice(0, 3).forEach((m, i) =>
        receivers.push({
          enterprise: e.ref,
          fdUserId: hash(m.id) % 900000 + 100000,
          userName: m.name,
          maskedPhone: `${m.phone.slice(0, 3)}****${m.phone.slice(-4)}`,
          selectable: i < 2,
          disabledReason: i < 2 ? null : "该成员没有可用的模型权限",
          missingModels: i < 2 ? [] : ["gpt-image-2.5-flare"],
        }),
      )
    }
    const p: TemplatePush = { id: `p${Date.now().toString(36)}`, draftId: d.id, touchId: body.touchId ?? null, state: "preview", notify: body.notify ?? true, receivers, blocked, fdTemplateId: d.fdTemplateId, batchId: null, result: null, createdAt: now(), confirmedAt: null, finishedAt: null }
    state.pushes.set(p.id, p)
    return p
  },
  "GET /api/pushes/:id": ({ params }) => {
    const p = state.pushes.get(params.id)
    if (!p) throw new MockError(404, "not_found", "推送不存在")
    if (p.state === "sharing" && Date.now() - new Date(p.confirmedAt!).getTime() > 1600) {
      const done: TemplatePush = { ...p, state: "done", finishedAt: now(), result: { success: p.result!.pending, failed: 0, pending: 0, failures: [] } }
      state.pushes.set(p.id, done)
      const d = state.drafts.find((x) => x.id === p.draftId)
      if (d) {
        const ents = [...new Map(p.receivers.map((r) => [r.enterprise.id, r.enterprise])).values()]
        const fd = d.fdTemplateId ?? 40000 + (hash(d.id) % 9999)
        Object.assign(d, { status: "pushed", fdTemplateId: fd, fdTemplateSource: "managed", link: draftLink(fd, "managed"), pushedTo: [...d.pushedTo, ...ents.filter((e) => !d.pushedTo.some((x) => x.id === e.id))], pushes: [done, ...d.pushes.filter((x) => x.id !== p.id)] })
      }
      return done
    }
    return p
  },
  "POST /api/pushes/:id/confirm": ({ params, body }) => {
    const p = state.pushes.get(params.id)
    if (!p || p.state !== "preview") throw new MockError(409, "invalid_state", "该推送已处理")
    const ids = new Set(body.receiverUserIds as number[])
    const n = p.receivers.filter((r) => r.selectable && ids.has(r.fdUserId)).length
    const next: TemplatePush = { ...p, state: "sharing", confirmedAt: now(), batchId: `b${Date.now().toString(36)}`, receivers: p.receivers.filter((r) => ids.has(r.fdUserId)), result: { success: 0, failed: 0, pending: n, failures: [] } }
    state.pushes.set(p.id, next)
    return next
  },
  "POST /api/pushes/:id/cancel": ({ params }) => {
    const p = state.pushes.get(params.id)
    if (!p) throw new MockError(404, "not_found", "推送不存在")
    const next = { ...p, state: "cancelled" as const }
    state.pushes.set(p.id, next)
    return next
  },
  "POST /api/fd-account/check": () => meta().fdAccount,
  "GET /api/touches": ({ query }) => {
    const all = state.touchesFor(query.line as Line, query.week)
    const slots = { mon: [], wed: [], fri: [] } as Record<TouchSlot, Touch[]>
    all.filter((t) => !t.suggested).forEach((t) => slots[t.slot].push(t))
    return { line: query.line, week: query.week, suggestions: all.filter((t) => t.suggested), slots }
  },
  "POST /api/touches": ({ body }) => {
    const e = entRef(body.enterprise)
    if (!e) throw new MockError(404, "not_found", "企业不存在")
    const t: Touch = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      line: body.line,
      week: body.week,
      slot: body.slot,
      enterprise: e,
      goal: body.goal as Pool,
      evidence: body.evidence ?? [],
      offer: body.offer ?? { kind: "question", draftId: null, rerunId: null, link: null, text: null },
      draft: { text: body.draft ?? "", source: body.source, updatedAt: now() },
      owner: body.owner ?? null,
      channel: null,
      status: "draft",
      suggested: false,
      sentAt: null,
      reply: null,
      outcome: null,
    }
    state.touchesFor(body.line, body.week).unshift(t)
    return t
  },
  "PATCH /api/touches/:id": ({ params, body }) => patchTouch(params.id, body),
  "DELETE /api/touches/:id": ({ params }) => {
    const hit = state.findTouch(params.id)
    if (hit) hit.list.splice(hit.i, 1)
    return null
  },
  "GET /api/touches/export": () => ({ __blob: "touches.xlsx" }),
  "POST /api/touches/import": () => ({ updated: 6, skipped: 1, errors: [] }),
  "GET /api/findings": ({ query }) => state.findings.filter((f) => !query.line || f.line === query.line),
  "POST /api/findings": ({ body }) => {
    const f: Finding = { ...body, id: `f${Date.now().toString(36)}`, updatedAt: now() }
    state.findings.unshift(f)
    return f
  },
  "PATCH /api/findings/:id": ({ params, body }) => {
    const i = state.findings.findIndex((f) => f.id === params.id)
    if (i < 0) throw new MockError(404, "not_found", "结论不存在")
    state.findings[i] = { ...state.findings[i], ...body, updatedAt: now() }
    return state.findings[i]
  },
  "GET /api/report": ({ query }) => report(query.week),
  "PUT /api/report": ({ body }) => {
    const r = state.reports.get(body.week) ?? { done: report(body.week).done, next: report(body.week).next }
    if (body.done != null) r.done = author(r.done, body.done, body.source)
    if (body.next != null) r.next = author(r.next, body.next, body.source)
    state.reports.set(body.week, r)
    return report(body.week)
  },
  "GET /api/imports": () => imports(),
  "POST /api/imports": ({ body }) => ({ ...imports()[0], id: `i${Date.now()}`, file: (body as FormData)?.get?.("file") instanceof File ? ((body as FormData).get("file") as File).name : "upload.xlsx", state: "done", inserted: 0, updated: 1384, createdAt: now() }),
  "POST /api/imports/scan": () => [],
  "GET /api/settings": () => state.settings,
  "PUT /api/settings": ({ body }) => {
    state.settings = { ...state.settings, ...body }
    return state.settings
  },
  "GET /api/reruns": () => [],
  "POST /api/reruns": () => {
    throw new MockError(501, "not_implemented", "重跑对比在 M4 实现")
  },
  "POST /api/reruns/:id/confirm": () => {
    throw new MockError(501, "not_implemented", "重跑对比在 M4 实现")
  },
  "GET /api/conversion": ({ query }) => conversion(query.line as Line),
}

const compiled = Object.entries(routes).map(([key, fn]) => {
  const [method, path] = key.split(" ")
  const names: string[] = []
  const re = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`)
  return { method, re, names, fn, static: !names.length }
})
compiled.sort((a, b) => Number(b.static) - Number(a.static))

export const mockFetch = async (method: string, url: string, body: unknown) => {
  init()
  const u = new URL(url, "http://x")
  const m = compiled.find((r) => r.method === method && r.re.test(u.pathname))
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 160))
  if (!m) throw new MockError(404, "not_implemented", `${method} ${u.pathname}`)
  const match = u.pathname.match(m.re)!
  const params = Object.fromEntries(m.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]))
  const query = Object.fromEntries(u.searchParams)
  const out = m.fn({ params, query, body })
  return structuredClone(out) as unknown
}

export type { Api }
