import type { Annotation, Chain, Level, Line, Movement, RosterRow, Task } from "@spec/contract"
import type { CaseFilters, CaseOutcome, CaseRating, CaseReview, CaseSampleStrategy, CaseSort, CaseSummary, CaseTag, CaseUnit, Row, Step, StepResult } from "./types"
import type { CasePage } from "@spec/contract"

export const outcomeName: Record<CaseOutcome, string> = { bad: "bad", grind: "磨合", good: "good" }
export const outcomeLong: Record<CaseOutcome, string> = { bad: "没下载", grind: "改了几次才下载", good: "一次就下载" }
export const outcomeOrder: CaseOutcome[] = ["bad", "grind", "good"]
export const resultName: Record<StepResult, string> = { downloaded: "已下载", not_downloaded: "未下载", failed: "失败", deleted: "已删除" }
export const ratingName: Record<CaseRating, string> = { good: "好", ok: "一般", bad: "差" }
export const ratingOrder: CaseRating[] = ["good", "ok", "bad"]
export const statusName = { todo: "待看", seen: "已看", done: "已处理" } as const
export const stepsBuckets = ["1", "2-3", "4+"] as const
export const sortName: Record<CaseSort, string> = { bad_first: "bad 优先", newest: "最新", oldest: "最早", steps: "步数最多", points: "耗点最多" }
export const strategyName: Record<CaseSampleStrategy, string> = { stratified: "分层", problems: "只看问题", per_enterprise: "每家几条", per_intent: "每类几条" }

const preset: [string, string, Line[], CaseTag["tone"]][] = [
  ["没听懂", "指令没执行", [], "bad"],
  ["没听懂", "执行错了", [], "bad"],
  ["没听懂", "改了不该改的", [], "bad"],
  ["没保住", "款式变了", [], "bad"],
  ["没保住", "面料或印花变形", [], "bad"],
  ["没保住", "颜色偏", [], "bad"],
  ["没保住", "人脸或身材变了", [], "bad"],
  ["质量差", "糊或有瑕疵", [], "bad"],
  ["质量差", "文字乱码", [], "bad"],
  ["质量差", "比例或裁切不对", [], "bad"],
  ["视频", "动作僵或崩", ["video"], "bad"],
  ["视频", "人物和服装不一致", ["video"], "bad"],
  ["视频", "时长或节奏不对", ["video"], "bad"],
  ["不是模型的问题", "客户输入有问题", [], "neutral"],
  ["不是模型的问题", "需求超出能力", [], "neutral"],
  ["值得关注", "可做模板", [], "good"],
]

export const tagId = (group: string, label: string) => `local:${group}/${label}`

export const presetTags: CaseTag[] = preset.map(([group, label, lines, tone], i) => ({ id: tagId(group, label), group, label, lines: lines.length ? lines : ["inspiration", "video"], tone, order: i, archived: false }))

export const stepResult = (t: Task): StepResult => (t.status === "deleted" ? "deleted" : t.failed ? "failed" : t.downloaded ? "downloaded" : "not_downloaded")

const mostCommon = <T,>(xs: T[]): T | null => {
  const m = new Map<T, number>()
  let best: T | null = null
  let n = 0
  xs.forEach((x) => {
    if (x == null || x === "") return
    const c = (m.get(x) ?? 0) + 1
    m.set(x, c)
    if (c > n) (best = x), (n = c)
  })
  return best
}

const toStep = (t: Task, i: number): Step => ({ rowKey: t.rowKey, index: i, result: stepResult(t), pattern: t.pattern, createdAt: t.createdAt, prompt: t.prompt, inputs: t.inputs, outputs: t.outputs, durationSeconds: t.durationSeconds, points: t.points, review: null, task: t })

type Ent = { level: Level | null; movement: Movement | null }

const rowOf = (id: string, unit: CaseUnit, tasks: Task[], ent: Map<string, Ent>, outcome?: CaseOutcome): Row => {
  const steps = tasks.map(toStep)
  const at = steps.findIndex((s) => s.result === "downloaded")
  const first = tasks[0]
  const e = ent.get(first.enterprise.id)
  const durs = tasks.map((t) => t.durationSeconds).filter((x): x is number => x != null)
  return {
    id,
    unit,
    line: first.line,
    enterprise: { ...first.enterprise, level: e?.level ?? null, movement: e?.movement ?? null },
    user: first.user,
    outcome: outcome ?? (at < 0 ? "bad" : at === 0 ? "good" : "grind"),
    startedAt: first.createdAt,
    endedAt: tasks[tasks.length - 1].createdAt,
    stepCount: steps.length,
    downloadedAt: at < 0 ? null : at,
    intent: mostCommon(tasks.map((t) => (t.line === "video" ? t.mode : t.intent))) ?? first.intent,
    mode: mostCommon(tasks.map((t) => t.mode)) ?? first.mode,
    model: mostCommon(tasks.map((t) => t.model)) ?? first.model,
    config: first.config,
    points: tasks.reduce((s, t) => s + t.points, 0),
    durationSeconds: durs.length ? durs.reduce((a, b) => a + b, 0) : null,
    slow: false,
    failure: tasks.find((t) => t.failure)?.failure ?? null,
    first: steps[0],
    last: steps[steps.length - 1],
    steps,
    fdUrl: tasks[tasks.length - 1].fdUrl ?? first.fdUrl,
    review: null,
    annotationCount: 0,
    lastAnnotation: null,
    collections: [],
  }
}

export interface LocalData {
  chains: Row[]
  tasks: Row[]
}

export const buildLocal = (chains: Chain[], extra: Task[], roster: RosterRow[] | undefined): LocalData => {
  const ent = new Map<string, Ent>((roster ?? []).map((r) => [r.enterprise.id, { level: r.level, movement: r.movement }]))
  const seen = new Set<string>()
  const cs: Row[] = []
  const ts: Row[] = []
  chains.forEach((c) => {
    const tasks = [...c.tasks].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const row = rowOf(c.id, "chain", tasks, ent)
    cs.push(row)
    tasks.forEach((t) => {
      seen.add(t.rowKey)
      const s = stepResult(t)
      ts.push({ ...rowOf(t.rowKey, "task", [t], ent, s === "downloaded" ? "good" : "bad"), chainOutcome: row.outcome, chainId: c.id } as Row)
    })
  })
  extra.forEach((t) => {
    if (seen.has(t.rowKey)) return
    seen.add(t.rowKey)
    const s = stepResult(t)
    cs.push(rowOf(t.rowKey, "chain", [t], ent))
    ts.push(rowOf(t.rowKey, "task", [t], ent, s === "downloaded" ? "good" : "bad"))
  })
  const p90 = new Map<string, number>()
  const byModel = new Map<string, number[]>()
  ts.forEach((r) => {
    const d = r.first.durationSeconds
    if (d == null) return
    const k = r.model ?? ""
    byModel.set(k, [...(byModel.get(k) ?? []), d])
  })
  byModel.forEach((xs, k) => {
    if (xs.length < 20) return
    xs.sort((a, b) => a - b)
    p90.set(k, xs[Math.floor(xs.length * 0.9)])
  })
  const slowStep = (s: Step, model: string | null) => s.durationSeconds != null && p90.has(model ?? "") && s.durationSeconds > p90.get(model ?? "")!
  ts.forEach((r) => (r.slow = slowStep(r.first, r.model)))
  cs.forEach((r) => (r.slow = (r.steps ?? []).some((s) => slowStep(s, s.task?.model ?? r.model))))
  return { chains: cs, tasks: ts }
}

export const chainOf = (r: Row) => (r as Row & { chainId?: string }).chainId ?? null
export const chainOutcomeOf = (r: Row) => (r as Row & { chainOutcome?: CaseOutcome }).chainOutcome ?? null

export const stepsBucket = (n: number) => (n <= 1 ? "1" : n <= 3 ? "2-3" : "4+")

export interface Lookup {
  review: (r: Row) => CaseReview | null
  notes: (r: Row) => { n: number; last: Annotation | null }
  inCollection: (r: Row) => string[]
}

const dims = ["q", "outcome", "result", "intent", "pattern", "model", "mode", "enterprise", "level", "movement", "steps", "rating", "tag", "status", "collection", "slow", "noted"] as const
type Dim = (typeof dims)[number]

const preds = (f: CaseFilters, L: Lookup): Partial<Record<Dim, (r: Row) => boolean>> => {
  const p: Partial<Record<Dim, (r: Row) => boolean>> = {}
  const s = f.q.trim().toLowerCase()
  if (s) p.q = (r) => r.enterprise.name.toLowerCase().includes(s) || (r.steps ?? [r.first, r.last]).some((x) => x.prompt.toLowerCase().includes(s))
  if (f.outcome.length) p.outcome = (r) => f.outcome.includes(r.outcome)
  if (f.result.length) p.result = (r) => (r.steps ?? [r.first, r.last]).some((x) => f.result.includes(x.result))
  if (f.intent.length) p.intent = (r) => f.intent.includes(r.intent ?? "")
  if (f.pattern.length) p.pattern = (r) => (r.steps ?? [r.first, r.last]).some((x) => f.pattern.includes(x.pattern))
  if (f.model.length) p.model = (r) => f.model.includes(r.model ?? "")
  if (f.mode.length) p.mode = (r) => f.mode.includes(r.mode)
  if (f.enterprise.length) p.enterprise = (r) => f.enterprise.includes(r.enterprise.id)
  if (f.level.length) p.level = (r) => f.level.includes(r.enterprise.level ?? "")
  if (f.movement.length) p.movement = (r) => f.movement.includes(r.enterprise.movement ?? "")
  if (f.steps.length) p.steps = (r) => f.steps.includes(stepsBucket(r.stepCount))
  if (f.rating.length) p.rating = (r) => f.rating.includes(L.review(r)?.rating ?? "none")
  if (f.tag.length) p.tag = (r) => (L.review(r)?.tags ?? []).some((t) => f.tag.includes(t))
  if (f.status.length) p.status = (r) => f.status.includes(L.review(r)?.status ?? "todo")
  if (f.collection) p.collection = (r) => L.inCollection(r).includes(f.collection!)
  if (f.slow) p.slow = (r) => r.slow
  if (f.noted) p.noted = (r) => L.notes(r).n > 0
  return p
}

const count = (rows: Row[], key: (r: Row) => string | string[] | null | undefined) => {
  const m = new Map<string, number>()
  rows.forEach((r) => {
    const k = key(r)
    ;(Array.isArray(k) ? [...new Set(k)] : [k]).forEach((x) => x != null && x !== "" && m.set(x, (m.get(x) ?? 0) + 1))
  })
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

export const rank: Record<CaseOutcome, number> = { bad: 0, grind: 1, good: 2 }

export const sortRows = (rows: Row[], sort: CaseSort) => {
  const t = (r: Row) => r.startedAt
  const xs = [...rows]
  if (sort === "newest") xs.sort((a, b) => (t(a) < t(b) ? 1 : -1))
  else if (sort === "oldest") xs.sort((a, b) => (t(a) < t(b) ? -1 : 1))
  else if (sort === "steps") xs.sort((a, b) => b.stepCount - a.stepCount || (t(a) < t(b) ? 1 : -1))
  else if (sort === "points") xs.sort((a, b) => b.points - a.points || (t(a) < t(b) ? 1 : -1))
  else xs.sort((a, b) => rank[a.outcome] - rank[b.outcome] || (t(a) < t(b) ? 1 : -1))
  return xs
}

export const summarize = (rows: Row[], L: Lookup): CaseSummary => {
  const outcomes = { bad: 0, grind: 0, good: 0 }
  const ratings = { good: 0, ok: 0, bad: 0 }
  const intents = new Map<string, { key: string; total: number; bad: number; grind: number }>()
  const ents = new Map<string, { enterprise: Row["enterprise"]; total: number; bad: number; grind: number }>()
  let rated = 0
  rows.forEach((r) => {
    outcomes[r.outcome]++
    const v = L.review(r)?.rating
    if (v) (ratings[v]++, rated++)
    const ik = r.intent ?? "其他"
    const i = intents.get(ik) ?? { key: ik, total: 0, bad: 0, grind: 0 }
    i.total++
    if (r.outcome === "bad") i.bad++
    if (r.outcome === "grind") i.grind++
    intents.set(ik, i)
    const e = ents.get(r.enterprise.id) ?? { enterprise: r.enterprise, total: 0, bad: 0, grind: 0 }
    e.total++
    if (r.outcome === "bad") e.bad++
    if (r.outcome === "grind") e.grind++
    ents.set(r.enterprise.id, e)
  })
  return {
    total: rows.length,
    outcomes,
    byIntent: [...intents.values()].sort((a, b) => b.total - a.total),
    byEnterprise: [...ents.values()].sort((a, b) => b.bad - a.bad || b.total - a.total).slice(0, 20),
    rated,
    ratings,
  }
}

export const queryLocal = (all: Row[], f: CaseFilters, L: Lookup): { items: Row[]; facets: CasePage["facets"] } => {
  const p = preds(f, L)
  const active = Object.entries(p) as [Dim, (r: Row) => boolean][]
  const pass = (r: Row, skip?: Dim) => active.every(([d, fn]) => d === skip || fn(r))
  const items = all.filter((r) => pass(r))
  const without = (d: Dim) => (p[d] ? all.filter((r) => pass(r, d)) : items)
  const ents = new Map<string, { id: string; name: string; count: number }>()
  without("enterprise").forEach((r) => {
    const e = ents.get(r.enterprise.id) ?? { id: r.enterprise.id, name: r.enterprise.name, count: 0 }
    e.count++
    ents.set(r.enterprise.id, e)
  })
  const facets: CasePage["facets"] = {
    outcomes: count(without("outcome"), (r) => r.outcome),
    results: count(without("result"), (r) => (r.steps ?? [r.first, r.last]).map((x) => x.result)),
    intents: count(without("intent"), (r) => r.intent),
    patterns: count(without("pattern"), (r) => (r.steps ?? [r.first, r.last]).map((x) => x.pattern)),
    models: count(without("model"), (r) => r.model),
    modes: count(without("mode"), (r) => r.mode),
    enterprises: [...ents.values()].sort((a, b) => b.count - a.count),
    levels: count(without("level"), (r) => r.enterprise.level),
    movements: count(without("movement"), (r) => r.enterprise.movement),
    steps: count(without("steps"), (r) => stepsBucket(r.stepCount)),
    ratings: count(without("rating"), (r) => L.review(r)?.rating ?? "none"),
    tags: count(without("tag"), (r) => L.review(r)?.tags ?? []),
    statuses: count(without("status"), (r) => L.review(r)?.status ?? "todo"),
    slow: without("slow").filter((r) => r.slow).length,
    noted: without("noted").filter((r) => L.notes(r).n > 0).length,
  }
  return { items, facets }
}

const rng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffle = <T,>(xs: T[], r: () => number) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const sampleLocal = (pool: Row[], o: { strategy: CaseSampleStrategy; size: number; perGroup: number; seed: number; skipRated: boolean }, L: Lookup): Row[] => {
  const r = rng(o.seed)
  const base = shuffle(o.skipRated ? pool.filter((x) => !L.review(x)?.rating) : pool, r)
  const cap = Math.max(1, Math.ceil(o.size * 0.25))
  const take = (xs: Row[], n: number, out: Row[], perEnt = new Map<string, number>()) => {
    for (const x of xs) {
      if (out.length >= n) break
      if (out.includes(x)) continue
      const c = perEnt.get(x.enterprise.id) ?? 0
      if (c >= cap) continue
      perEnt.set(x.enterprise.id, c + 1)
      out.push(x)
    }
    return out
  }
  const problemScore = (x: Row) => (x.slow ? 2 : 0) + (x.stepCount >= 3 ? 2 : 0) + ((x.steps ?? [x.first, x.last]).some((s) => s.result === "failed" || s.result === "deleted") ? 3 : 0) + (x.outcome === "bad" ? 1 : 0)
  if (o.strategy === "problems") {
    const xs = base.filter((x) => x.outcome !== "good").sort((a, b) => problemScore(b) - problemScore(a))
    return take(xs, o.size, [])
  }
  if (o.strategy === "per_enterprise" || o.strategy === "per_intent") {
    const groups = new Map<string, Row[]>()
    base.forEach((x) => {
      const k = o.strategy === "per_enterprise" ? x.enterprise.id : x.intent ?? "其他"
      groups.set(k, [...(groups.get(k) ?? []), x])
    })
    const out: Row[] = []
    ;[...groups.values()]
      .sort((a, b) => b.filter((x) => x.outcome === "bad").length - a.filter((x) => x.outcome === "bad").length)
      .forEach((g) => out.push(...[...g].sort((a, b) => rank[a.outcome] - rank[b.outcome]).slice(0, o.perGroup)))
    return out.slice(0, Math.max(o.size, o.perGroup))
  }
  const want: Record<CaseOutcome, number> = { bad: Math.round(o.size * 0.5), grind: Math.round(o.size * 0.3), good: 0 }
  want.good = o.size - want.bad - want.grind
  const perEnt = new Map<string, number>()
  const out: Row[] = []
  outcomeOrder.forEach((k) => {
    const xs = base.filter((x) => x.outcome === k)
    const byIntent = new Map<string, Row[]>()
    xs.forEach((x) => byIntent.set(x.intent ?? "", [...(byIntent.get(x.intent ?? "") ?? []), x]))
    const lanes = [...byIntent.values()]
    const mixed: Row[] = []
    for (let i = 0; mixed.length < xs.length; i++) lanes.forEach((l) => l[i] && mixed.push(l[i]))
    const before = out.length
    take(mixed, before + want[k], out, perEnt)
  })
  if (out.length < o.size) take(base, o.size, out, perEnt)
  return out
}

export const slim = (r: Row): Row => {
  const strip = (s: Step): Step => {
    const { task: _t, ...rest } = s
    return rest
  }
  return { ...r, first: strip(r.first), last: strip(r.last), steps: r.steps && r.steps.length <= 8 ? r.steps.map(strip) : null }
}

export const thumbOf = (r: Row) => {
  const m = r.last.outputs[0] ?? r.first.inputs[0]
  return m ? (m.kind === "video" ? m.poster ?? m.thumb : m.thumb) : null
}

export const filtersToQuery = (f: CaseFilters) => {
  const j = (xs: string[]) => (xs.length ? xs.join(",") : undefined)
  return {
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
    rating: j(f.rating),
    tag: j(f.tag),
    status: j(f.status),
    collection: f.collection ?? undefined,
    slow: f.slow || undefined,
    noted: f.noted ? ("any" as const) : undefined,
  }
}
