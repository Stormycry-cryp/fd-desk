import type { Pattern, Alert, AlertCount, AlertKind, Breakdown, Coverage, EnterpriseDetail, EnterpriseRef, FailureCategory, FailureStat, HistoryPoint, IntentStat, Level, LineDetail, Line, Metric, ModeStat, Movement, Mover, Overview, Pool, Report, ReportLine, Roster, RosterRow, Severity, WeekPoint } from "@spec/contract"
import { BY_ID, COVER, ENTS, INTENTS, LATEST, NOW, WEEKS, cellAt, comparable, lastActive, type Cell, type Ent } from "./world"
import { hash, median } from "./rand"
import { state } from "./state"

const TH = {
  inspiration: { heavy: [100, 4], medium: [20, 3], base: 50 },
  video: { heavy: [20, 3], medium: [5, 2], base: 10 },
} as const

const dayStr = (w: number, d: number) => {
  const t = new Date(`${WEEKS[w]}T00:00:00+08:00`).getTime() + d * 86400000 + 8 * 3600000
  return new Date(t).toISOString().slice(0, 10)
}

export const coverage = (line: Line, w: number): Coverage => ({
  line,
  week: WEEKS[w],
  days: COVER[w].map((d) => dayStr(w, d)),
  complete: COVER[w].length === 7,
  refreshedAt: NOW,
})

export const activeDays = (c: Cell | null) => (c ? c.days.filter((v) => v > 0).length : 0)

export const levelOf = (line: Line, c: Cell | null, w: number): Level | null => {
  if (!c || COVER[w].length < 7) return null
  const t = TH[line]
  const d = activeDays(c)
  if (c.tasks >= t.heavy[0] && d >= t.heavy[1]) return "heavy"
  if (c.tasks >= t.medium[0] && d >= t.medium[1]) return "medium"
  if (c.tasks >= t.medium[0]) return "burst"
  if (d >= 2) return "light"
  return "trial"
}

const stable = (l: Level | null) => l === "heavy" || l === "medium"

export interface EntState {
  ent: Ent
  line: Line
  w: number
  cell: Cell | null
  prev: Cell | null
  level: Level | null
  movement: Movement
  pool: Pool | null
  cmp: { current: number; previous: number }
  alerts: AlertKind[]
  history: boolean
  reliable: boolean
}

const cache = new Map<string, EntState>()

export const entState = (ent: Ent, line: Line, w: number): EntState => {
  const key = `${ent.ref.id}|${line}|${w}`
  const hit = cache.get(key)
  if (hit) return hit
  const cell = cellAt(ent, line, w)
  const prev = cellAt(ent, line, w - 1)
  const before = Array.from({ length: Math.max(0, w - 1) }, (_, i) => cellAt(ent, line, i)).some(Boolean)
  const cmp = comparable(cell, prev, w)
  const base = TH[line].base
  const level = levelOf(line, cell, w)
  let movement: Movement = "steady"
  if (!cell && !prev && before) movement = "lost"
  else if (!cell && prev) movement = "silent"
  else if (cell && cmp.previous >= base && cmp.current < cmp.previous / 2) movement = "drop"
  else if (cell && cmp.current >= base && cmp.current >= cmp.previous * 2) movement = "surge"
  else if (cell && !prev && before) movement = "returned"
  else if (cell && !prev && !before) movement = "new"
  const reliable = !(cell && cell.tasks >= 30 && cell.downloadRate < 0.05)
  const peak = Math.max(0, ...Array.from({ length: w + 1 }, (_, i) => cellAt(ent, line, i)?.tasks ?? 0))
  const history = peak > 0
  let pool: Pool | null = null
  const medTasks = TH[line].medium[0]
  if (movement === "drop") pool = "retain"
  else if ((movement === "silent" || movement === "lost") && peak >= 20) pool = "recall"
  else if (cell && reliable && cell.tasks >= medTasks && (cell.downloadRate < 0.35 || (line === "inspiration" && cell.stuck >= 0.25))) pool = "help"
  else if (stable(level)) pool = "keep"
  else if (cell) pool = "nurture"
  else if (!history && ent.contract === "active" && (ent.otherFunctions || cellAt(ent, line === "inspiration" ? "video" : "inspiration", w))) pool = "convert"
  const alerts: AlertKind[] = []
  if (movement === "drop") alerts.push("drop")
  if (movement === "silent" && (prev?.tasks ?? 0) >= base) alerts.push("vanished")
  if (cell && line === "inspiration" && reliable && cell.tasks >= 20 && (cell.stuck >= 0.3 || cell.downloadRate < 0.25)) alerts.push("stuck")
  if (movement === "new" && cell && cell.tasks >= 3 && cell.downloaded === 0) alerts.push("cold_start")
  if (cell && line === "inspiration" && ent.lines.inspiration?.model === "nano_banana_pro" && ent.lines.inspiration.intents[0][0] === "印花面料" && cell.tasks >= 8) alerts.push("mismatch")
  if (cell && line === "video" && cell.points >= 1000 && cell.downloadRate < 0.35) alerts.push("waste")
  if (cell && line === "video" && Object.values(cell.failures).some((n) => (n ?? 0) >= 3)) alerts.push("failures")
  if (cell && cell.tasks >= 60 && (line === "video" ? cell.tasks >= 20 : cell.batch >= 0.35)) alerts.push("reuse")
  if (movement === "surge") alerts.push("surge")
  const s: EntState = { ent, line, w, cell, prev, level, movement, pool, cmp, alerts, history, reliable }
  cache.set(key, s)
  return s
}

export const severity: Record<AlertKind, Severity> = { drop: 3, vanished: 3, waste: 3, stuck: 2, cold_start: 2, mismatch: 2, failures: 2, reuse: 1, surge: 1 }

const window12 = (w: number) => Array.from({ length: 12 }, (_, i) => w - 11 + i)

export const spark = (ent: Ent, line: Line, w: number): WeekPoint[] =>
  window12(w).map((i) => {
    if (i < 0) {
      const t = new Date(`${WEEKS[0]}T00:00:00+08:00`).getTime() + i * 7 * 86400000 + 8 * 3600000
      return { week: new Date(t).toISOString().slice(0, 10), complete: false, tasks: 0, points: 0, activeDays: 0, downloadRate: null, level: null }
    }
    const c = cellAt(ent, line, i)
    return { week: WEEKS[i], complete: COVER[i].length === 7, tasks: c?.tasks ?? 0, points: c?.points ?? 0, activeDays: activeDays(c), downloadRate: c ? c.downloadRate : null, level: levelOf(line, c, i) }
  })

export const excludedIds = (line: Line) => state.settings.excluded[line]

const intentRows = (ent: Ent, c: Cell) => {
  const p = ent.lines.inspiration
  if (!p) return []
  return p.intents.map(([intent, share]) => {
    const k = ((hash(`${ent.ref.id}${intent}`) % 100) / 100 - 0.5) * 0.3
    return { intent, tasks: Math.round(c.tasks * share), share, downloadRate: Math.min(0.98, Math.max(0, c.downloadRate + k)) }
  })
}

const modeRows = (ent: Ent, c: Cell) => {
  const p = ent.lines.video
  if (!p) return []
  return p.modes.map(([mode, share]) => {
    const k = ((hash(`${ent.ref.id}${mode}`) % 100) / 100 - 0.5) * 0.3
    return { mode, tasks: Math.round(c.tasks * share), share, points: Math.round(c.points * share), downloadRate: Math.min(0.98, Math.max(0, c.downloadRate + k)), failed: Math.round(c.failed * share) }
  })
}

export const rosterRow = (ent: Ent, line: Line, w: number): RosterRow => {
  const s = entState(ent, line, w)
  const c = s.cell
  const touches = state.touchesFor(line, WEEKS[w]).filter((t) => t.enterprise.id === ent.ref.id && !t.suggested)
  const last = touches[0] ?? null
  const totalPoints = ENTS.reduce((acc, e) => acc + (cellAt(e, line, w)?.points ?? 0), 0)
  const na = state.nextActions.get(`${ent.ref.id}|${line}`) ?? null
  const ir = c ? intentRows(ent, c) : []
  const mr = c ? modeRows(ent, c) : []
  return {
    enterprise: { ...ent.ref, kind: state.kinds.get(ent.ref.id) ?? ent.ref.kind },
    contract: ent.contract,
    owner: state.owners.get(ent.ref.id) ?? ent.owner,
    excluded: excludedIds(line).includes(ent.ref.id),
    level: s.level,
    movement: s.movement,
    pool: s.pool,
    tasks: c?.tasks ?? 0,
    points: c?.points ?? 0,
    activeDays: activeDays(c),
    users: c?.users ?? 0,
    comparable: s.prev || c ? s.cmp : null,
    downloadRate: c ? c.downloadRate : null,
    downloadSignalReliable: s.reliable,
    lastActiveAt: lastActive(ent, line, w),
    weeksActive: Array.from({ length: w + 1 }, (_, i) => cellAt(ent, line, i)).filter(Boolean).length,
    spark: spark(ent, line, w),
    alerts: s.alerts,
    nextAction: na ?? (s.pool ? { text: defaultAction(s), source: "rule", updatedAt: NOW } : null),
    lastTouch: last ? { id: last.id, week: last.week, slot: last.slot, status: last.status } : null,
    inspiration:
      line === "inspiration"
        ? {
            topIntent: ir[0]?.intent ?? null,
            topIntentShare: ir[0]?.share ?? 0,
            batchShare: c?.batch ?? 0,
            stuckShare: c?.stuck ?? 0,
            agentShare: c ? c.agentRows / Math.max(1, c.tasks) : 0,
            mainModel: ent.lines.inspiration?.model ?? null,
          }
        : null,
    video:
      line === "video"
        ? {
            topMode: mr[0]?.mode ?? null,
            topModeShare: mr[0]?.share ?? 0,
            pointShare: c && totalPoints ? c.points / totalPoints : 0,
            pointsPerDownloaded: c && c.downloaded ? c.points / c.downloaded : null,
            notDownloadedPoints: c ? c.points - c.pointsDownloaded : 0,
            failed: c?.failed ?? 0,
            mainModel: ent.lines.video?.model ?? null,
          }
        : null,
  }
}

const defaultAction = (s: EntState) => {
  const c = s.cell
  switch (s.pool) {
    case "retain":
      return `同星期 ${s.cmp.previous} → ${s.cmp.current}，先问清是活做完了还是遇到问题`
    case "recall":
      return "上一批用过的提示词整理成模板，等下一批活时发过去"
    case "help":
      return c && s.line === "inspiration" && c.stuck >= 0.25 ? `卡住占比 ${Math.round(c.stuck * 100)}%，挑 3 条卡住的链重跑对比` : `下载率 ${Math.round((c?.downloadRate ?? 0) * 100)}%，用他的原图跑一组对比`
    case "keep":
      return s.line === "inspiration" ? "把重复用的提示词存成团队模板" : "整理他常用的镜头写法做成模板"
    case "nurture":
      return "发同类客户的用法和两个入门模板"
    case "convert":
      return "用这条线把他最近的任务做一遍给他看"
    default:
      return ""
  }
}

export const roster = (line: Line, week: string): Roster => {
  const w = WEEKS.indexOf(week)
  const rows = ENTS.filter((e) => {
    const s = entState(e, line, w)
    return s.history || s.pool === "convert"
  }).map((e) => rosterRow(e, line, w))
  const poolCounts = { retain: 0, recall: 0, help: 0, keep: 0, nurture: 0, convert: 0 } as Record<Pool, number>
  rows.forEach((r) => r.pool && poolCounts[r.pool]++)
  return { line, week, rows, poolCounts }
}

const sumCells = (line: Line, w: number, skip: Set<string>) => {
  const cells = ENTS.filter((e) => !skip.has(e.ref.id)).map((e) => [e, cellAt(e, line, w)] as const).filter(([, c]) => c) as [Ent, Cell][]
  const tasks = cells.reduce((s, [, c]) => s + c.tasks, 0)
  return {
    cells,
    tasks,
    points: cells.reduce((s, [, c]) => s + c.points, 0),
    downloaded: cells.reduce((s, [, c]) => s + c.downloaded, 0),
    failed: cells.reduce((s, [, c]) => s + c.failed, 0),
    users: cells.reduce((s, [, c]) => s + c.users, 0),
    enterprises: cells.length,
  }
}

const cmpSum = (line: Line, w: number, skip: Set<string>) => {
  const days = COVER[w].filter((d) => w > 0 && COVER[w - 1].includes(d))
  const frac = (c: Cell | null) => (c && c.tasks ? days.reduce((s, d) => s + c.days[d], 0) / c.tasks : 0)
  const agg = (wi: number) => {
    let tasks = 0, points = 0, downloaded = 0, failed = 0, users = 0, ents = 0
    for (const e of ENTS) {
      if (skip.has(e.ref.id)) continue
      const c = cellAt(e, line, wi)
      const f = frac(c)
      if (!c || f === 0) continue
      tasks += Math.round(c.tasks * f)
      points += Math.round(c.points * f)
      downloaded += Math.round(c.downloaded * f)
      failed += Math.round(c.failed * f)
      users += Math.max(1, Math.round(c.users * Math.min(1, f + 0.2)))
      ents++
    }
    return { tasks, points, downloaded, failed, users, ents, rate: tasks ? downloaded / tasks : 0 }
  }
  return { cur: agg(w), prev: w > 0 ? agg(w - 1) : null }
}

export const overview = (line: Line, week: string): Overview => {
  const w = WEEKS.indexOf(week)
  const none = new Set<string>()
  const ex = new Set(excludedIds(line))
  const now = sumCells(line, w, none)
  const full = cmpSum(line, w, none)
  const exc = ex.size ? cmpSum(line, w, ex) : null
  const metric = (value: number, pick: (x: NonNullable<typeof full.prev>) => number): Metric => ({
    value,
    comparable: full.prev ? { current: pick(full.cur), previous: pick(full.prev) } : null,
    comparableExcluded: exc && exc.prev ? { current: pick(exc.cur), previous: pick(exc.prev) } : null,
  })
  const complete = COVER[w].length === 7
  const levels = { heavy: 0, medium: 0, burst: 0, light: 0, trial: 0 } as Record<Level, number>
  now.cells.forEach(([, c]) => {
    const l = levelOf(line, c, w)
    if (l) levels[l]++
  })
  const prevComplete = w > 0 && COVER[w - 1].length === 7
  const prevStable = prevComplete ? sumCells(line, w - 1, none).cells.filter(([, c]) => stable(levelOf(line, c, w - 1))).length : 0
  const history: HistoryPoint[] = window12(w).map((i) => {
    if (i < 0) return { week: WEEKS[0], complete: false, stable: null, heavy: null, medium: null, activeEnterprises: 0, tasks: 0, points: 0, downloadRate: 0 }
    const s = sumCells(line, i, none)
    const lv = s.cells.map(([, c]) => levelOf(line, c, i))
    const comp = COVER[i].length === 7
    return {
      week: WEEKS[i],
      complete: comp,
      stable: comp ? lv.filter(stable).length : null,
      heavy: comp ? lv.filter((l) => l === "heavy").length : null,
      medium: comp ? lv.filter((l) => l === "medium").length : null,
      activeEnterprises: s.enterprises,
      tasks: s.tasks,
      points: s.points,
      downloadRate: s.tasks ? s.downloaded / s.tasks : 0,
    }
  })
  const states = ENTS.map((e) => entState(e, line, w))
  const unit = line === "inspiration" ? "tasks" : "points"
  const mover = (s: EntState): Mover => ({ enterprise: s.ent.ref, current: s.cmp.current, previous: s.cmp.previous, unit: "tasks" })
  const live = states.filter((s) => s.cell && s.prev)
  const rising = live.filter((s) => s.cmp.current > s.cmp.previous).sort((a, b) => b.cmp.current - b.cmp.previous - (a.cmp.current - a.cmp.previous))
  const falling = live.filter((s) => s.cmp.current < s.cmp.previous).sort((a, b) => a.cmp.current - a.cmp.previous - (b.cmp.current - b.cmp.previous))
  const base = TH[line].base
  const large = states.filter((s) => s.cmp.previous >= base)
  const counts = new Map<AlertKind, number>()
  states.forEach((s) => s.alerts.forEach((a) => counts.set(a, (counts.get(a) ?? 0) + 1)))
  const alerts: AlertCount[] = [...counts].map(([kind, count]) => ({ kind, severity: severity[kind], count })).sort((a, b) => b.severity - a.severity || b.count - a.count)
  const byTasks = [...now.cells].sort((a, b) => b[1].tasks - a[1].tasks)
  const byPoints = [...now.cells].sort((a, b) => b[1].points - a[1].points)
  const top = (line === "video" ? byPoints : byTasks)[0]
  const insp =
    line === "inspiration"
      ? (() => {
          const w8 = now.cells
          const t = now.tasks || 1
          const batch = w8.reduce((s, [, c]) => s + c.tasks * c.batch, 0) / t
          const stuck = w8.reduce((s, [, c]) => s + c.tasks * c.stuck, 0) / t
          const agg = new Map<string, { tasks: number; ents: Set<string>; dl: number }>()
          w8.forEach(([e, c]) =>
            intentRows(e, c).forEach((r) => {
              const a = agg.get(r.intent) ?? { tasks: 0, ents: new Set(), dl: 0 }
              a.tasks += r.tasks
              a.ents.add(e.ref.id)
              a.dl += r.tasks * r.downloadRate
              agg.set(r.intent, a)
            }),
          )
          const intents: IntentStat[] = [...agg]
            .map(([intent, a]) => ({ intent, tasks: a.tasks, enterprises: a.ents.size, share: a.tasks / t, downloadRate: a.tasks ? a.dl / a.tasks : 0 }))
            .sort((a, b) => b.tasks - a.tasks)
          const agentRows = w8.reduce((s, [, c]) => s + c.agentRows, 0)
          return {
            outputs: w8.reduce((s, [, c]) => s + c.outputs, 0),
            batchShare: batch,
            batchDownloadRate: Math.min(0.95, now.downloaded / t + 0.2),
            stuckShare: stuck,
            stuckDownloadRate: Math.max(0.05, now.downloaded / t - 0.17),
            intents,
            agent: { rows: agentRows, turns: Math.round(agentRows * 0.42), enterprises: w8.filter(([, c]) => c.agentRows > 0).length, topUserRows: Math.round(agentRows * 0.86) },
            officialTemplates: { quickTasks: t - agentRows, matched: Math.round((t - agentRows) * 0.101), used: 16, total: 50, top3Share: 0.915 },
          }
        })()
      : null
  const vid =
    line === "video"
      ? (() => {
          const cells = now.cells
          const pd = cells.reduce((s, [, c]) => s + c.pointsDownloaded, 0)
          const agg = new Map<string, ModeStat & { ents: Set<string>; dl: number }>()
          cells.forEach(([e, c]) =>
            modeRows(e, c).forEach((r) => {
              const a = agg.get(r.mode) ?? { mode: r.mode, tasks: 0, enterprises: 0, points: 0, pointShare: 0, downloadRate: 0, failed: 0, ents: new Set<string>(), dl: 0 }
              a.tasks += r.tasks
              a.points += r.points
              a.failed += r.failed
              a.dl += r.tasks * r.downloadRate
              a.ents.add(e.ref.id)
              agg.set(r.mode, a)
            }),
          )
          const modes: ModeStat[] = [...agg.values()]
            .map(({ ents, dl, ...m }) => ({ ...m, enterprises: ents.size, pointShare: now.points ? m.points / now.points : 0, downloadRate: m.tasks ? dl / m.tasks : 0 }))
            .sort((a, b) => b.points - a.points)
          return { pointsDownloaded: pd, pointsNotDownloaded: now.points - pd, notDownloadedShare: now.points ? (now.points - pd) / now.points : 0, pointsPerDownloaded: now.downloaded ? now.points / now.downloaded : 0, modes, failures: failureStats(cells) }
        })()
      : null
  return {
    line,
    week,
    coverage: coverage(line, w),
    previousCoverage: w > 0 ? coverage(line, w - 1) : null,
    comparableWeekdays: COVER[w].filter((d) => w > 0 && COVER[w - 1].includes(d)),
    stable: complete ? { value: levels.heavy + levels.medium, comparable: prevComplete ? { current: levels.heavy + levels.medium, previous: prevStable } : null, comparableExcluded: null } : null,
    levels: complete ? levels : null,
    activeEnterprises: metric(now.enterprises, (x) => x.ents),
    users: metric(now.users, (x) => x.users),
    tasks: metric(now.tasks, (x) => x.tasks),
    points: metric(now.points, (x) => x.points),
    downloadRate: metric(now.tasks ? now.downloaded / now.tasks : 0, (x) => x.rate),
    failed: metric(now.failed, (x) => x.failed),
    concentration: {
      top1: top ? top[0].ref : { id: "", name: "—", kind: "unknown" },
      top1TaskShare: byTasks[0] ? byTasks[0][1].tasks / (now.tasks || 1) : 0,
      top10TaskShare: byTasks.slice(0, 10).reduce((s, [, c]) => s + c.tasks, 0) / (now.tasks || 1),
      top1PointShare: byPoints[0] ? byPoints[0][1].points / (now.points || 1) : 0,
    },
    history,
    movers: {
      rising: rising.slice(0, 8).map(mover),
      falling: falling.slice(0, 8).map(mover),
      new: states.filter((s) => s.movement === "new").sort((a, b) => (b.cell?.tasks ?? 0) - (a.cell?.tasks ?? 0)).slice(0, 8).map((s) => ({ enterprise: s.ent.ref, current: s.cell?.tasks ?? 0, previous: 0, unit: "tasks" as const })),
      returned: states.filter((s) => s.movement === "returned").slice(0, 8).map((s) => ({ enterprise: s.ent.ref, current: s.cell?.tasks ?? 0, previous: 0, unit: "tasks" as const })),
      silent: states.filter((s) => s.movement === "silent").sort((a, b) => (b.prev?.tasks ?? 0) - (a.prev?.tasks ?? 0)).slice(0, 8).map((s) => ({ enterprise: s.ent.ref, current: 0, previous: s.prev?.tasks ?? 0, unit: "tasks" as const })),
    },
    moverCounts: { rising: rising.length, falling: falling.length, largeAccounts: large.length, largeAccountsHalved: large.filter((s) => s.cmp.current < s.cmp.previous / 2).length },
    alerts,
    inspiration: insp,
    video: vid,
  }
  void unit
}

const FAIL_USER: Record<FailureCategory, string> = { moderation: "内容可能违规，请修改后重试", material: "处理失败，请稍后重试", timeout: "生成超时，请稍后重试", upstream: "处理失败，请稍后重试", other: "处理失败，请稍后重试" }

export const failureStats = (cells: [Ent, Cell][]): FailureStat[] => {
  const agg = new Map<FailureCategory, { count: number; ents: Set<string> }>()
  cells.forEach(([e, c]) =>
    Object.entries(c.failures).forEach(([k, n]) => {
      const a = agg.get(k as FailureCategory) ?? { count: 0, ents: new Set() }
      a.count += n ?? 0
      a.ents.add(e.ref.id)
      agg.set(k as FailureCategory, a)
    }),
  )
  return [...agg].map(([category, a]) => ({ category, count: a.count, enterprises: a.ents.size, genericMessage: category === "material" ? a.count : 0 })).sort((a, b) => b.count - a.count)
}

export const failUser = FAIL_USER

export const alertsFor = (line: Line, week: string, kind?: AlertKind): Alert[] => {
  const w = WEEKS.indexOf(week)
  const out: Alert[] = []
  for (const e of ENTS) {
    const s = entState(e, line, w)
    for (const k of s.alerts) {
      if (kind && k !== kind) continue
      const id = `a${hash(`${e.ref.id}${line}${week}${k}`).toString(36)}`
      out.push({ id, kind: k, severity: severity[k], line, week, enterprise: e.ref, facts: facts(s, k), suggestedPool: s.pool, dismissed: state.dismissed.has(id) })
    }
  }
  return out.sort((a, b) => b.severity - a.severity)
}

export const facts = (s: EntState, k?: AlertKind) => {
  const c = s.cell
  const f: string[] = []
  if (c) f.push(`本周任务 ${c.tasks} 个，使用 ${activeDays(c)} 天`)
  if (s.prev || c) f.push(`同星期用量 ${s.cmp.previous} → ${s.cmp.current} 个任务`)
  if (c && k !== "surge") f.push(`下载率 ${(c.downloadRate * 100).toFixed(1)}%`)
  if (k === "stuck" && c) f.push(`卡住占比 ${(c.stuck * 100).toFixed(1)}%`)
  if (k === "waste" && c) f.push(`未下载耗点 ${c.points - c.pointsDownloaded}`)
  if (!c && s.prev) f.push(`上周 ${s.prev.tasks} 个任务，本周没有使用`)
  return f
}

export const detail = (id: string, week: string): EnterpriseDetail | null => {
  const ent = BY_ID.get(id)
  if (!ent) return null
  const w = WEEKS.indexOf(week)
  const lineDetail = (line: Line): LineDetail | null => {
    const p = ent.lines[line]
    if (!p) return null
    const s = entState(ent, line, w)
    const c = s.cell
    const peers = ENTS.map((e) => cellAt(e, line, w)).filter(Boolean) as Cell[]
    const breakdown: Breakdown[] = c
      ? line === "inspiration"
        ? intentRows(ent, c).map((r) => ({
            key: r.intent,
            tasks: r.tasks,
            share: r.share,
            points: Math.round(c.points * r.share),
            downloadRate: r.downloadRate,
            peerMedianDownloadRate: median(peers.map((x) => x.downloadRate + ((hash(r.intent) % 20) - 10) / 100)),
            peerEnterprises: 20 + (hash(r.intent) % 50),
            mainModel: p.model,
          }))
        : modeRows(ent, c).map((r) => ({ key: r.mode, tasks: r.tasks, share: r.share, points: r.points, downloadRate: r.downloadRate, peerMedianDownloadRate: median(peers.map((x) => x.downloadRate)), peerEnterprises: 5 + (hash(r.mode) % 12), mainModel: p.model }))
      : []
    const patterns =
      c && line === "inspiration"
        ? (
            [
              ["batch", c.batch],
              ["retry", c.stuck * 0.48],
              ["tweak", c.stuck * 0.52],
              ["adapt", 0.08],
              ["rework", 0.1],
              ["agent", c.agentRows / Math.max(1, c.tasks)],
            ] as [Pattern, number][]
          )
            .map(([pattern, share]) => ({ pattern, share, tasks: Math.round(c.tasks * share), downloadRate: pattern === "batch" ? Math.min(0.95, c.downloadRate + 0.18) : pattern === "retry" || pattern === "tweak" ? Math.max(0.03, c.downloadRate - 0.2) : c.downloadRate }))
            .concat([{ pattern: "new" as Pattern, share: 0, tasks: 0, downloadRate: c.downloadRate }])
            .map((x, _, arr) => (x.pattern === "new" ? { ...x, share: Math.max(0, 1 - arr.reduce((s, y) => s + (y.pattern === "new" ? 0 : y.share), 0)), tasks: Math.max(0, c.tasks - arr.reduce((s, y) => s + (y.pattern === "new" ? 0 : y.tasks), 0)) } : x))
            .filter((x) => x.tasks > 0)
        : []
    return {
      line,
      week,
      level: s.level,
      movement: s.movement,
      pool: s.pool,
      tasks: c?.tasks ?? 0,
      points: c?.points ?? 0,
      activeDays: activeDays(c),
      downloadRate: c ? c.downloadRate : null,
      downloadSignalReliable: s.reliable,
      history: spark(ent, line, w),
      breakdown,
      patterns,
      models: c ? p.models.map(([model, share], i) => ({ model, tasks: Math.round(c.tasks * share), downloadRate: Math.min(0.97, Math.max(0, c.downloadRate + (i ? -0.08 : 0.03))) })) : [],
      failures: c ? failureStats([[ent, c]]) : [],
      members: ent.members
        .map((m, i) => ({ id: m.id, name: m.name, phone: m.phone, tasks: c ? Math.round((c.tasks * m.weight) / ent.members.reduce((s, x) => s + x.weight, 0)) : 0, downloadRate: c ? Math.min(0.98, Math.max(0, c.downloadRate + (i % 2 ? -0.06 : 0.04))) : null, lastActiveAt: lastActive(ent, line, w) ?? ent.firstSeen }))
        .sort((a, b) => b.tasks - a.tasks),
      nextAction: rosterRow(ent, line, w).nextAction,
    }
  }
  const lines = { inspiration: lineDetail("inspiration"), video: lineDetail("video") }
  return {
    enterprise: { ...ent.ref, kind: state.kinds.get(ent.ref.id) ?? ent.ref.kind },
    adminPhone: ent.adminPhone,
    contract: ent.contract,
    owner: state.owners.get(ent.ref.id) ?? ent.owner,
    firstSeenAt: ent.firstSeen,
    lastActiveAt: lastActive(ent, "inspiration", w) ?? lastActive(ent, "video", w),
    summary: state.summaries.get(id) ?? summaryFor(ent, w),
    lines,
    alerts: [...alertsFor("inspiration", week), ...alertsFor("video", week)].filter((a) => a.enterprise.id === id),
    touches: state.allTouches().filter((t) => t.enterprise.id === id && !t.suggested),
    notes: state.notes.get(id) ?? [],
  }
}

const summaryFor = (ent: Ent, w: number) => {
  const s = entState(ent, "inspiration", w)
  const v = entState(ent, "video", w)
  const main = s.cell ? s : v.cell ? v : null
  if (!main) return null
  const p = ent.lines[main.line]
  const what = main.line === "inspiration" ? p?.intents[0]?.[0] : p?.modes[0]?.[0]
  const c = main.cell!
  const tail = main.pool === "help" ? (c.downloadRate < 0.35 ? "下载率偏低，值得用他的原图跑一组对比。" : "同一张图反复重试的比例高，值得挑几条卡住的链重跑。") : main.pool === "retain" ? "用量明显下滑，需要问原因。" : main.pool === "keep" ? "用法稳定，重复的提示词适合存成模板。" : "仍在摸索阶段。"
  return { text: `主要做${what ?? "—"}，本周 ${c.tasks} 个任务、${activeDays(c)} 天，下载率 ${Math.round(c.downloadRate * 100)}%。${tail}`, source: "agent" as const, updatedAt: NOW }
}

export const report = (week: string): Report => {
  const lines: ReportLine[] = (["inspiration", "video"] as Line[]).map((line) => {
    const o = overview(line, week)
    const tag = (m: Mover) => ({ enterprise: m.enterprise, current: m.current, previous: m.previous, reason: state.reasons.get(`${line}|${week}|${m.enterprise.id}`) ?? null })
    return { line, stable: o.stable, activeEnterprises: o.activeEnterprises, tasks: o.tasks, points: o.points, downloadRate: o.downloadRate, top1Share: line === "video" ? o.concentration.top1PointShare : o.concentration.top1TaskShare, falling: o.movers.falling.slice(0, 5).map(tag), rising: o.movers.rising.slice(0, 5).map(tag) }
  })
  const touches = state.touchesFor("inspiration", week).concat(state.touchesFor("video", week)).filter((t) => !t.suggested)
  const r = state.reports.get(week)
  return {
    week,
    lines,
    touches: { sent: touches.filter((t) => t.status === "sent" || t.status === "replied" || t.status === "closed").length, replied: touches.filter((t) => t.status === "replied").length, withOutcome: touches.filter((t) => t.outcome).length },
    done: r?.done ?? { text: "整理了两条线的客户名单和两周对比；联系了 5 家掉量客户，2 家已回复；为 3 家稳定客户做了团队模板。", source: "agent", updatedAt: NOW },
    next: r?.next ?? { text: "把重跑对比带给 4 家卡住的客户；周五召回 3 家沉默客户；视频线跟进最大客户的下载情况。", source: "agent", updatedAt: NOW },
  }
}

export const entRef = (id: string): EnterpriseRef | null => BY_ID.get(id)?.ref ?? null

export const intentsList = INTENTS
export const latestWeek = WEEKS[LATEST]
