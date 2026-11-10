import type { Cluster, ConversionCandidate, ImportJob, InspirationAnalysis, Line, MatrixCell, Offer, Pool, TemplateDraft, Touch, TouchSlot, TouchStatus, VideoAnalysis, VideoCell } from "@spec/contract"
import { PROMPTS } from "./prompts"
import { hash, median, pick, rng } from "./rand"
import { state } from "./state"
import { queryTasks } from "./tasks"
import { activeDays, entState, facts, failureStats, overview, type EntState } from "./views"
import { ENTS, IMAGE_MODELS, INTENTS, NOW, OWNERS, VIDEO_MODES, WEEKS, cellAt, type Cell, type Ent } from "./world"

const slotOf: Record<Pool, TouchSlot> = { retain: "mon", keep: "mon", help: "wed", nurture: "wed", recall: "fri", convert: "fri" }

const draftText = (s: EntState) => {
  const name = s.ent.members[0].name
  const c = s.cell
  switch (s.pool) {
    case "retain":
      return `${name}您好，看到这周灵感成款用得比上周少了不少，是这批款做完了，还是生成效果哪里不满意？有问题我这边可以直接帮您调。`
    case "help":
      return `${name}您好，我用您这周的原图换了一种写法重新跑了几张，效果对比发您看看，觉得合适可以直接存成模板用。`
    case "recall":
      return `${name}您好，您之前常用的那几句提示词我整理成了模板，下批款上新时点一下就能直接出图。`
    case "keep":
      return `${name}您好，您这周有一句提示词用了 ${Math.round((c?.tasks ?? 0) * (c?.batch ?? 0.3))} 次，我帮您存成了团队模板，组里其他同事也能直接用。`
    case "nurture":
      return `${name}您好，给您发两个同类客户常用的写法，换色和上身图都比较稳定，可以先试试。`
    case "convert":
      return `${name}您好，您最近在自由改款做的那批款，我用灵感成款做了一遍，出图更快，发您对比一下。`
    default:
      return ""
  }
}

const offerOf = (s: EntState, r: () => number): Offer => {
  switch (s.pool) {
    case "keep":
    case "recall":
      return { kind: "template", draftId: state.drafts[Math.floor(r() * state.drafts.length)]?.id ?? null, rerunId: null, link: null, text: null }
    case "help":
      return { kind: "comparison", draftId: null, rerunId: null, link: null, text: "3 组原图重跑对比" }
    case "retain":
      return { kind: "question", draftId: null, rerunId: null, link: null, text: "是活做完了，还是效果不满意" }
    default:
      return { kind: "tip", draftId: null, rerunId: null, link: null, text: "同类客户的两种写法" }
  }
}

const build = (line: Line, week: string): Touch[] => {
  const w = WEEKS.indexOf(week)
  if (w < 0) return []
  const r = rng(`touch${line}${week}`)
  const states = ENTS.map((e) => entState(e, line, w)).filter((s) => s.pool && s.pool !== "nurture")
  const pools: Pool[] = ["retain", "help", "recall", "keep", "convert"]
  const picked: EntState[] = []
  for (const p of pools) {
    const list = states.filter((s) => s.pool === p).sort((a, b) => (b.cell?.tasks ?? b.prev?.tasks ?? 0) - (a.cell?.tasks ?? a.prev?.tasks ?? 0))
    picked.push(...list.slice(0, p === "keep" ? 4 : p === "convert" ? 2 : 4))
  }
  const statuses: TouchStatus[] = w === 11 ? ["draft", "assigned", "assigned", "sent", "draft", "sent", "replied"] : ["sent", "replied", "replied", "closed", "sent"]
  return picked.map((s, i) => {
    const suggested = w === 11 && i % 3 === 2
    const status = suggested ? "draft" : statuses[i % statuses.length]
    const next = cellAt(s.ent, line, w + 1) as Cell | null
    const outcome =
      w < 11 && !suggested
        ? {
            week: WEEKS[w + 1],
            tasks: { current: next?.tasks ?? 0, previous: s.cell?.tasks ?? 0 },
            downloadRate: { current: next?.downloadRate ?? null, previous: s.cell?.downloadRate ?? null },
            templateUsed: s.pool === "keep" || s.pool === "recall" ? r() < 0.5 : null,
            control: { enterprises: 6 + Math.floor(r() * 10), medianTaskChange: -0.1 + r() * 0.15 },
          }
        : null
    return {
      id: `t${hash(`${line}${week}${s.ent.ref.id}`).toString(36)}`,
      line,
      week,
      slot: slotOf[s.pool!],
      enterprise: s.ent.ref,
      goal: s.pool!,
      evidence: facts(s).slice(0, 3),
      offer: offerOf(s, r),
      draft: { text: draftText(s), source: "agent", updatedAt: NOW },
      owner: suggested ? null : s.ent.owner.sales ?? pick(r, OWNERS),
      channel: suggested ? null : pick(r, ["微信", "企业微信", "电话"]),
      status,
      suggested,
      sentAt: status === "sent" || status === "replied" || status === "closed" ? NOW : null,
      reply: status === "replied" ? pick(r, ["这批款做完了，下周还有一批", "最近在用别的工具，效果对比一下再说", "好的，我让设计试试", "模板收到了，挺好用"]) : null,
      outcome,
    }
  })
}

export const initExtras = () => {
  state.drafts = seedDrafts()
  state.setBuilder(build)
  for (const line of ["inspiration", "video"] as Line[]) {
    state.touchesFor(line, WEEKS[10])
    state.touchesFor(line, WEEKS[11])
  }
}

const topEnts = (line: Line, seed: string, n: number) => {
  const w = 11
  const r = rng(seed)
  return ENTS.filter((e) => cellAt(e, line, w))
    .map((e) => [e, r()] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([e]) => e)
    .slice(0, n)
    .map((e, i) => ({ enterprise: e.ref, uses: Math.max(2, Math.round((cellAt(e, line, w)?.tasks ?? 10) * (0.4 - i * 0.08))) }))
}

let clusterCache: Record<Line, Cluster[]> | null = null

export const clusters = (line: Line, enterprise?: string, candidate?: boolean): Cluster[] => {
  if (!clusterCache) {
    const make = (line: Line): Cluster[] => {
      const r = rng(`clusters${line}`)
      const keys = line === "inspiration" ? [...INTENTS] : [...VIDEO_MODES]
      return Array.from({ length: line === "inspiration" ? 22 : 12 }, (_, i) => {
        const intent = keys[i % keys.length]
        const sample = pick(r, PROMPTS[intent])(r)
        const uses = Math.round(320 / (i + 1.6) + r() * 12)
        const matched = i % 5 === 1 ? { id: 1000 + i, name: `官方·${intent}${i}` } : null
        const tops = topEnts(line, `c${line}${i}`, 1 + Math.floor(r() * 4))
        return {
          id: `k${hash(`${line}${i}`).toString(36)}`,
          line,
          sample,
          uses,
          enterprises: tops.length,
          downloadRate: Math.min(0.95, 0.3 + r() * 0.6),
          intent: line === "inspiration" ? intent : null,
          matchedTemplate: matched,
          candidate: !matched && uses >= 5,
          topEnterprises: tops,
          draftId: null,
        }
      })
    }
    clusterCache = { inspiration: make("inspiration"), video: make("video") }
  }
  return clusterCache[line]
    .map((c) => ({ ...c, draftId: state.drafts.find((d) => d.clusterId === c.id)?.id ?? null }))
    .filter((c) => (!enterprise || c.topEnterprises.some((t) => t.enterprise.id === enterprise)) && (candidate == null || c.candidate === candidate))
}

const seedDrafts = (): TemplateDraft[] => {
  const cl = clusters("inspiration").filter((c) => c.candidate)
  const mk = (i: number, status: TemplateDraft["status"], title: string, slots: string[], scope: TemplateDraft["scope"], fd: number | null): TemplateDraft => {
    const c = cl[i]
    return {
      id: `d${i + 1}`,
      line: "inspiration",
      title: { text: title, source: "agent", updatedAt: NOW },
      prompt: { text: c.sample, source: "rule", updatedAt: NOW },
      slots,
      scene: c.intent,
      clusterId: c.id,
      status,
      scope,
      sourceEnterprises: c.topEnterprises.map((t) => t.enterprise),
      fdTemplateId: fd,
      fdTemplateSource: fd ? "managed" : null,
      link: fd ? `${state.settings.siteBaseUrl}/workbench/chatting-image/inspiration?templateId=${fd}&templateSource=managed` : null,
      pushedTo: status === "pushed" ? c.topEnterprises.slice(0, 1).map((t) => t.enterprise) : [],
      pushes: [],
      createdAt: NOW,
    }
  }
  return [mk(0, "pushed", `${cl[0].intent}·保持款式`, ["服装图"], "owner", 48213), mk(1, "tested", `${cl[1].intent}·通用`, ["服装图", "模特图"], "general", null), mk(2, "draft", `${cl[2].intent}`, ["服装图", "参考图"], "owner", null)]
}

export const inspirationAnalysis = (week: string, excluded: boolean): InspirationAnalysis => {
  const w = WEEKS.indexOf(week)
  const skip = new Set(excluded ? state.settings.excluded.inspiration : [])
  const acc = new Map<string, { tasks: number; dl: number; per: Map<string, { t: number; dl: number }> }>()
  for (const e of ENTS) {
    if (skip.has(e.ref.id)) continue
    const c = cellAt(e, "inspiration", w)
    const p = e.lines.inspiration
    if (!c || !p) continue
    for (const [intent, si] of p.intents)
      for (const [model, sm] of p.models) {
        const t = Math.round(c.tasks * si * sm)
        if (!t) continue
        const bias = intent === "印花面料" && model === "nano_banana_pro" ? -0.3 : ((hash(`${intent}${model}`) % 30) - 15) / 100
        const rate = Math.min(0.97, Math.max(0.02, c.downloadRate + bias))
        const k = `${intent}|${model}`
        const a = acc.get(k) ?? { tasks: 0, dl: 0, per: new Map() }
        a.tasks += t
        a.dl += t * rate
        a.per.set(e.ref.id, { t, dl: rate })
        acc.set(k, a)
      }
  }
  const matrix: MatrixCell[] = [...acc].map(([k, a]) => {
    const [intent, model] = k.split("|")
    const per = [...a.per.values()]
    return {
      intent,
      model,
      tasks: a.tasks,
      enterprises: per.length,
      downloadRate: a.tasks ? a.dl / a.tasks : 0,
      enterpriseMedianDownloadRate: median(per.filter((x) => x.t >= 8).map((x) => x.dl)),
      dominantEnterpriseShare: Math.max(...per.map((x) => x.t)) / a.tasks,
    }
  })
  const o = overview("inspiration", week)
  const ins = o.inspiration!
  const total = o.tasks.value || 1
  const patterns = [
    { pattern: "batch" as const, share: ins.batchShare, downloadRate: ins.batchDownloadRate },
    { pattern: "retry" as const, share: ins.stuckShare * 0.47, downloadRate: ins.stuckDownloadRate - 0.03 },
    { pattern: "tweak" as const, share: ins.stuckShare * 0.53, downloadRate: ins.stuckDownloadRate + 0.03 },
    { pattern: "adapt" as const, share: 0.07, downloadRate: 0.66 },
    { pattern: "rework" as const, share: 0.12, downloadRate: 0.52 },
    { pattern: "new" as const, share: Math.max(0, 1 - ins.batchShare - ins.stuckShare - 0.19), downloadRate: 0.49 },
  ].map((p) => ({ ...p, tasks: Math.round(total * p.share), enterprises: 20 + (hash(p.pattern) % 80) }))
  return { week, intents: ins.intents, models: [...IMAGE_MODELS], matrix, patterns, unclassifiedShare: 0.071 }
}

export const videoAnalysis = (week: string, excluded: boolean): VideoAnalysis => {
  const w = WEEKS.indexOf(week)
  const skip = new Set(excluded ? state.settings.excluded.video : [])
  const acc = new Map<string, VideoCell & { ents: Set<string>; dlw: number; dl: number }>()
  const cells: [Ent, Cell][] = []
  for (const e of ENTS) {
    if (skip.has(e.ref.id)) continue
    const c = cellAt(e, "video", w)
    const p = e.lines.video
    if (!c || !p) continue
    cells.push([e, c])
    for (const [mode, si] of p.modes)
      for (const [model, sm] of p.models) {
        const t = Math.round(c.tasks * si * sm)
        if (!t) continue
        const k = `${mode}|${model}`
        const a = acc.get(k) ?? { mode, model, tasks: 0, enterprises: 0, points: 0, downloadRate: 0, failed: 0, pointsPerDownloaded: null, ents: new Set<string>(), dlw: 0, dl: 0 }
        a.tasks += t
        a.points += Math.round(c.points * si * sm)
        a.failed += Math.round(c.failed * si * sm)
        a.dlw += t * c.downloadRate
        a.dl += Math.round(c.downloaded * si * sm)
        a.ents.add(e.ref.id)
        acc.set(k, a)
      }
  }
  const matrix = [...acc.values()].map(({ ents, dlw, dl, ...m }) => ({ ...m, enterprises: ents.size, downloadRate: m.tasks ? dlw / m.tasks : 0, pointsPerDownloaded: dl ? m.points / dl : null }))
  const o = overview("video", week)
  const samples = queryTasks({ line: "video", week, failed: true, limit: 12 }).items
  return { week, modes: o.video!.modes, matrix, failures: failureStats(cells), failureSamples: samples, rerollChains: 14 + (hash(week) % 9) }
}

export const imports = (): ImportJob[] => [
  { id: "i3", file: "FD生成记录导出_20261109-20261109.xlsx", state: "done", from: "2026-11-09", to: "2026-11-09", rows: 1384, inserted: 1384, updated: 0, byLine: { inspiration: 1262, video: 122, other: 0 }, error: null, createdAt: "2026-11-10T09:12:00+08:00" },
  { id: "i2", file: "FD生成记录导出_20261102-20261108.xlsx", state: "done", from: "2026-11-02", to: "2026-11-08", rows: 9958, inserted: 9958, updated: 0, byLine: { inspiration: 9077, video: 881, other: 0 }, error: null, createdAt: "2026-11-09T22:40:00+08:00" },
  { id: "i1", file: "FD生成记录导出_20261029-20261101.xlsx", state: "done", from: "2026-10-29", to: "2026-11-01", rows: 4299, inserted: 4299, updated: 0, byLine: { inspiration: 4007, video: 292, other: 0 }, error: null, createdAt: "2026-11-02T10:05:00+08:00" },
]

export const conversion = (line: Line): ConversionCandidate[] =>
  ENTS.filter((e) => entState(e, line, 11).pool === "convert").map((e) => ({
    enterprise: e.ref,
    contract: e.contract,
    owner: e.owner,
    scenes: [
      { scene: "自由改款", tasks: 20 + (hash(e.ref.id) % 120) },
      { scene: "图片翻新", tasks: hash(e.ref.name) % 40 },
    ],
    lastActiveAt: NOW,
    suggestedDraftId: state.drafts[0]?.id ?? null,
  }))

export { activeDays }
