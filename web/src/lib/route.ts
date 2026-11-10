import { useSyncExternalStore } from "react"
import type { AlertKind, Level, Line, Movement, Pool } from "@spec/contract"

export type PageKey = "week" | "customers" | "touches" | "templates" | "analysis" | "data" | "report" | "enterprise"

export interface Route {
  page: PageKey
  line: Line
  week: string | null
  excluded: boolean
  ent: string | null
  pool: Pool | "all"
  level: Level | null
  movement: Movement | null
  alert: AlertKind | null
  owner: string | null
  q: string
}

const pages: PageKey[] = ["week", "customers", "touches", "templates", "analysis", "data", "report", "enterprise"]

const read = (): Route => {
  const u = new URL(location.href)
  const seg = u.pathname.replace(/^\/+/, "").split("/")
  const page = (pages.includes(seg[0] as PageKey) ? seg[0] : "week") as PageKey
  const s = u.searchParams
  return {
    page,
    line: s.get("line") === "video" ? "video" : "inspiration",
    week: s.get("week"),
    excluded: s.get("ex") === "1",
    ent: page === "enterprise" ? seg[1] ?? null : s.get("ent"),
    pool: (s.get("pool") as Pool) || "all",
    level: (s.get("level") as Level) || null,
    movement: (s.get("mv") as Movement) || null,
    alert: (s.get("alert") as AlertKind) || null,
    owner: s.get("owner"),
    q: s.get("q") ?? "",
  }
}

let current = read()
const subs = new Set<() => void>()

const write = (r: Route, replace: boolean) => {
  const s = new URLSearchParams()
  if (r.line !== "inspiration") s.set("line", r.line)
  if (r.week) s.set("week", r.week)
  if (r.excluded) s.set("ex", "1")
  if (r.ent && r.page !== "enterprise") s.set("ent", r.ent)
  if (r.pool !== "all") s.set("pool", r.pool)
  if (r.level) s.set("level", r.level)
  if (r.movement) s.set("mv", r.movement)
  if (r.alert) s.set("alert", r.alert)
  if (r.owner) s.set("owner", r.owner)
  if (r.q) s.set("q", r.q)
  const path = r.page === "enterprise" ? `/enterprise/${r.ent ?? ""}` : r.page === "week" ? "/" : `/${r.page}`
  const qs = s.toString()
  const url = qs ? `${path}?${qs}` : path
  if (replace) history.replaceState(null, "", url)
  else history.pushState(null, "", url)
  current = r
  subs.forEach((f) => f())
}

window.addEventListener("popstate", () => {
  current = read()
  subs.forEach((f) => f())
})

export const useRoute = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => current,
  )

export const navigate = (patch: Partial<Route>, opts: { replace?: boolean } = {}) => {
  const next = { ...current, ...patch }
  const filtersReset = patch.page && patch.page !== current.page && patch.page !== "enterprise"
  write(filtersReset ? { ...next, ent: patch.ent ?? null, level: patch.level ?? null, movement: patch.movement ?? null, alert: patch.alert ?? null, owner: patch.owner ?? null, q: patch.q ?? "", pool: patch.pool ?? "all" } : next, opts.replace ?? false)
}

export const getRoute = () => current
