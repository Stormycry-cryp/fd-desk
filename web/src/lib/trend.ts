import type { Line, RosterRow, Settings, WeekPoint } from "@spec/contract"
import type { Trend, TrendKind } from "@spec/contract"

export const trendName: Record<TrendKind, string> = { churned: "流失", sliding: "连续下滑", fading: "明显回落" }
export const trendOrder: TrendKind[] = ["churned", "sliding", "fading"]

const stable = (p: WeekPoint) => p.level === "heavy" || p.level === "medium"

export const computeTrend = (id: string, line: Line, spark: WeekPoint[], base: number): Trend | null => {
  const w = spark.filter((p) => p.complete)
  const t = w.map((p) => p.tasks)
  if (t.length < 4) return null
  const series = w.slice(-8).map((p) => ({ week: p.week, tasks: p.tasks }))
  let gap = 0
  for (let i = t.length - 1; i >= 0 && t[i] === 0; i--) gap++
  if (gap >= 2) {
    const before = w.slice(-8, w.length - gap)
    const peak = before.reduce((a, b) => (b.tasks > a.tasks ? b : a), before[0] ?? w[0])
    return w.slice(-8).filter(stable).length >= 2 ? { enterpriseId: id, line, kind: "churned", weeks: gap, from: peak?.tasks ?? 0, to: 0, peakWeek: peak?.week ?? null, series } : null
  }
  let k = 0
  for (let i = t.length - 1; i > 0 && t[i] < t[i - 1]; i--) k++
  const start = t[t.length - 1 - k]
  const last = t[t.length - 1]
  if (k >= 3 && start >= base && last <= start * 0.6) return { enterpriseId: id, line, kind: "sliding", weeks: k, from: start, to: last, peakWeek: w[w.length - 1 - k].week, series }
  if (t.length >= 6) {
    const prior = t.slice(-6, -2)
    const avg = prior.reduce((a, b) => a + b, 0) / 4
    const rec = (t[t.length - 1] + t[t.length - 2]) / 2
    if (prior.filter((x) => x > 0).length >= 3 && avg >= base && rec < avg * 0.5 && last <= avg * 0.5) return { enterpriseId: id, line, kind: "fading", weeks: 2, from: Math.round(avg), to: last, peakWeek: w[w.length - 6].week, series }
  }
  return null
}

export const localTrends = (rows: RosterRow[], line: Line, settings: Settings | undefined) => {
  const base = settings?.thresholds[line].moverBase ?? (line === "inspiration" ? 50 : 10)
  return rows.map((r) => computeTrend(r.enterprise.id, line, r.spark, base)).filter(Boolean) as Trend[]
}

export const trendText = (t: Trend) => (t.kind === "churned" ? `已 ${t.weeks} 周没用，此前最高 ${t.from}` : t.kind === "sliding" ? `连续 ${t.weeks} 周下滑，${t.from} → ${t.to}` : `近 2 周回落，${t.from} → ${t.to}`)
