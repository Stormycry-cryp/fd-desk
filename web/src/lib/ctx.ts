import { useMeta } from "../api/hooks"
import { useRoute } from "./route"

export const useCtx = () => {
  const route = useRoute()
  const meta = useMeta()
  const m = meta.data
  const weeks = m?.weeks ?? []
  const cov = (w: string) => m?.coverage.find((c) => c.line === route.line && c.week === w)
  const fallback = m?.latestWeek[route.line] ?? weeks[weeks.length - 1] ?? null
  const week = route.week && weeks.includes(route.week) ? route.week : fallback
  return { route, line: route.line, week, meta: m, metaLoading: meta.isLoading, coverage: week ? cov(week) : undefined, cov, excluded: route.excluded, exIds: m?.excluded[route.line] ?? [] }
}

export const isoWeek = (w: string) => {
  const d = new Date(`${w}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 3)
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((d.getTime() - y.getTime()) / 86400000 - 3 + ((y.getUTCDay() + 6) % 7)) / 7)
}
