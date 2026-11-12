import type { Annotation, Line } from "@spec/contract"
import type { CaseFilters, CaseOutcome, CaseSampleStrategy, CaseSort, CaseTag, Processed, Review, Row, Step, StepResult } from "./types"

export const outcomeName: Record<CaseOutcome, string> = { bad: "bad", grind: "磨合", good: "good" }
export const outcomeLong: Record<CaseOutcome, string> = { bad: "没下载", grind: "改了几次才下载", good: "一次就下载" }
export const outcomeOrder: CaseOutcome[] = ["bad", "grind", "good"]
export const resultName: Record<StepResult, string> = { downloaded: "已下载", not_downloaded: "未下载", failed: "失败", deleted: "已删除" }
export const processedName: Record<Processed, string> = { todo: "没看", done: "已处理", noted: "只评论" }
export const stepsBuckets = ["1", "2-3", "4+"] as const
export const sortName: Record<Exclude<CaseSort, "processed">, string> = { bad_first: "bad 优先", newest: "最新", oldest: "最早", steps: "步数最多", points: "耗点最多" }
export const strategyName: Record<CaseSampleStrategy, string> = { stratified: "分层", problems: "只看问题", per_enterprise: "每家几条", per_intent: "每类几条" }

export const FALSE_ALARM = "false_alarm"
export const isFalseAlarm = (t: Pick<CaseTag, "id" | "label">) => t.id === FALSE_ALARM || t.label === "其实没问题"

export const stepsBucket = (n: number) => (n <= 1 ? "1" : n <= 3 ? "2-3" : "4+")

export interface Lookup {
  review: (r: Row) => Review | null
  stepReview: (r: Row, s: Step) => Review | null
  notes: (r: Row) => number
  processed: (r: Row) => Processed
  inPool: (r: Row) => boolean
}

export const thumbOf = (r: Row) => {
  const m = r.last.outputs[0] ?? r.first.inputs[0]
  return m ? (m.kind === "video" ? m.poster ?? m.thumb : m.thumb) : null
}

export const stepsLabel = (r: Row) => {
  if (r.unit === "task" || r.stepCount === 1) return r.outcome === "good" ? "已下载" : resultName[r.last.result]
  if (r.downloadedAt == null) return `${r.stepCount} 步没下载`
  return r.downloadedAt === 0 ? `${r.stepCount} 步 · 第 1 步下载` : `第 ${r.downloadedAt + 1}/${r.stepCount} 步下载`
}

export const durText = (s: number | null | undefined) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${Math.round(s)}秒`)

export const filtersToQuery = (f: CaseFilters, legacy: boolean) => {
  const j = (xs: string[]) => (xs.length ? xs.join(",") : undefined)
  const q: Record<string, string | boolean | undefined> = {
    q: f.q.trim() || undefined,
    outcome: j(f.outcome),
    result: j(f.result),
    intent: j(f.intent),
    pattern: j(f.pattern),
    model: j(f.model),
    mode: j(f.mode),
    enterprise: j(f.enterprise),
    level: j(f.level),
    movement: j(f.movement),
    steps: j(f.steps),
    tag: j(f.tag),
    slow: f.slow || undefined,
    noted: f.noted ? "any" : undefined,
  }
  if (!legacy) q.processed = j(f.processed)
  else if (f.processed.length === 1 && f.processed[0] === "noted") q.noted = "any"
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as typeof q
}

export const passLocal = (r: Row, f: CaseFilters, L: Lookup) => !f.processed.length || f.processed.includes(L.processed(r))

const weekOf = (t: string) => {
  const d = new Date(new Date(t).getTime() + 8 * 3600e3)
  const wd = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - wd * 86400e3).toISOString().slice(0, 10)
}

export interface TagStat {
  tag: CaseTag
  cases: number
  enterprises: number
  weekly: { week: string; cases: number }[]
  samples: Row[]
  top: { enterprise: Row["enterprise"]; cases: number }[]
}

export interface LibraryStats {
  processed: number
  outcomes: Record<CaseOutcome, number>
  falseAlarm: { cases: number; rate: number | null }
  tags: TagStat[]
  weeks: { week: string; processed: number; falseAlarm: number }[]
  intents: string[]
  matrix: Map<string, number>
  enterprises: { enterprise: Row["enterprise"]; cases: number; tags: { tag: string; cases: number }[] }[]
  thisWeek: number
}

export const computeStats = (rows: Row[], tags: CaseTag[], L: Lookup, nowWeek: string | null): LibraryStats => {
  const tagById = new Map(tags.map((t) => [t.id, t]))
  const outcomes = { bad: 0, grind: 0, good: 0 }
  const byTag = new Map<string, Row[]>()
  const weeks = new Map<string, { processed: number; falseAlarm: number }>()
  const matrix = new Map<string, number>()
  const intentN = new Map<string, number>()
  const ents = new Map<string, { enterprise: Row["enterprise"]; cases: number; tags: Map<string, number> }>()
  let fa = 0
  let faBad = 0
  let badN = 0
  let thisWeek = 0
  rows.forEach((r) => {
    const eff = L.review(r)?.effectiveTags ?? []
    if (!eff.length) return
    outcomes[r.outcome]++
    const w = weekOf(r.startedAt)
    if (w === nowWeek) thisWeek++
    const isFa = eff.some((id) => {
      const t = tagById.get(id)
      return t ? isFalseAlarm(t) : id === FALSE_ALARM
    })
    if (r.outcome === "bad") {
      badN++
      if (isFa) faBad++
    }
    if (isFa) fa++
    const wk = weeks.get(w) ?? { processed: 0, falseAlarm: 0 }
    wk.processed++
    if (isFa) wk.falseAlarm++
    weeks.set(w, wk)
    const ik = r.intent ?? "其他"
    intentN.set(ik, (intentN.get(ik) ?? 0) + 1)
    const e = ents.get(r.enterprise.id) ?? { enterprise: r.enterprise, cases: 0, tags: new Map<string, number>() }
    e.cases++
    eff.forEach((id) => {
      byTag.set(id, [...(byTag.get(id) ?? []), r])
      matrix.set(`${id}|${ik}`, (matrix.get(`${id}|${ik}`) ?? 0) + 1)
      e.tags.set(id, (e.tags.get(id) ?? 0) + 1)
    })
    ents.set(r.enterprise.id, e)
  })
  const processed = outcomes.bad + outcomes.grind + outcomes.good
  const stats: TagStat[] = [...byTag]
    .map(([id, rs]) => {
      const tag = tagById.get(id) ?? { id, group: "", label: id, lines: [] as Line[], tone: "bad" as const, order: 999, archived: false, uses: 0 }
      const wk = new Map<string, number>()
      const en = new Map<string, { enterprise: Row["enterprise"]; cases: number }>()
      rs.forEach((r) => {
        const w = weekOf(r.startedAt)
        wk.set(w, (wk.get(w) ?? 0) + 1)
        const e = en.get(r.enterprise.id) ?? { enterprise: r.enterprise, cases: 0 }
        e.cases++
        en.set(r.enterprise.id, e)
      })
      return {
        tag,
        cases: rs.length,
        enterprises: en.size,
        weekly: [...wk].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([week, cases]) => ({ week, cases })),
        samples: rs.slice(0, 4),
        top: [...en.values()].sort((a, b) => b.cases - a.cases).slice(0, 3),
      }
    })
    .sort((a, b) => b.cases - a.cases)
  return {
    processed,
    outcomes,
    falseAlarm: { cases: fa, rate: badN ? faBad / badN : null },
    tags: stats,
    weeks: [...weeks].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12).map(([week, v]) => ({ week, ...v })),
    intents: [...intentN].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k),
    matrix,
    enterprises: [...ents.values()]
      .sort((a, b) => b.cases - a.cases)
      .slice(0, 8)
      .map((e) => ({ enterprise: e.enterprise, cases: e.cases, tags: [...e.tags].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, cases]) => ({ tag, cases })) })),
    thisWeek,
  }
}

export const notesFor = (anns: Annotation[], blocks: Set<string>) => anns.filter((a) => blocks.has(a.anchor?.block ?? "")).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

export const blocksOf = (r: Row) => new Set([r.unit === "chain" ? `case:${r.id}` : `record:${r.id}`, ...(r.steps ?? []).map((s) => `record:${s.rowKey}`)])

export const blockOf = (r: Row, s: Step | null) => (s || r.unit === "task" ? `record:${s ? s.rowKey : r.id}` : `case:${r.id}`)
