import { useSyncExternalStore } from "react"
import type { AlertKind, Level, Line, Movement, Pool } from "@spec/contract"

export type PageKey = "week" | "customers" | "touches" | "templates" | "analysis" | "data" | "report" | "enterprise" | "playground" | "export"
export type EntTab = "profile" | "data" | "tasks" | "notes"
export type EntScope = "all" | Line
export type TplKind = "official" | "custom"
export type TplPane = "opportunities" | "drafts" | "live"

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
  tab: EntTab
  scope: EntScope | null
  section: string | null
  tags: string[]
  noted: "any" | "recent" | null
  kind: TplKind
  pane: TplPane
  tpl: string | null
  run: string | null
}

const pages: PageKey[] = ["week", "customers", "touches", "templates", "analysis", "data", "report", "enterprise", "playground", "export"]

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
    tab: (["profile", "data", "tasks", "notes"].includes(s.get("tab") ?? "") ? s.get("tab") : "profile") as EntTab,
    scope: (["all", "inspiration", "video"].includes(s.get("scope") ?? "") ? s.get("scope") : null) as EntScope | null,
    section: s.get("sec"),
    tags: s.get("tags")?.split(",").filter(Boolean) ?? [],
    noted: (s.get("noted") as "any" | "recent") || null,
    kind: s.get("kind") === "custom" ? "custom" : "official",
    pane: (["opportunities", "drafts", "live"].includes(s.get("pane") ?? "") ? s.get("pane") : "opportunities") as TplPane,
    tpl: page === "playground" ? seg[1] ?? s.get("tpl") : s.get("tpl"),
    run: s.get("run"),
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
  if (r.tab !== "profile" && (r.ent || r.page === "enterprise")) s.set("tab", r.tab)
  if (r.scope && (r.ent || r.page === "enterprise")) s.set("scope", r.scope)
  if (r.section) s.set("sec", r.section)
  if (r.tags.length) s.set("tags", r.tags.join(","))
  if (r.noted) s.set("noted", r.noted)
  if (r.page === "templates" || r.page === "playground") {
    if (r.kind !== "official") s.set("kind", r.kind)
    if (r.pane !== "opportunities" && r.page === "templates") s.set("pane", r.pane)
    if (r.tpl && r.page === "templates") s.set("tpl", r.tpl)
  }
  if (r.run) s.set("run", r.run)
  const path = r.page === "enterprise" ? `/enterprise/${r.ent ?? ""}` : r.page === "playground" ? `/playground/${r.tpl ?? ""}` : r.page === "week" ? "/" : `/${r.page}`
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
  const entChanged = patch.ent !== undefined && patch.ent !== current.ent
  const base = entChanged && patch.tab === undefined ? { ...next, tab: "profile" as EntTab, section: patch.section ?? null } : next
  write(
    filtersReset
      ? { ...base, ent: patch.ent ?? null, level: patch.level ?? null, movement: patch.movement ?? null, alert: patch.alert ?? null, owner: patch.owner ?? null, q: patch.q ?? "", pool: patch.pool ?? "all", tags: patch.tags ?? [], noted: patch.noted ?? null, section: patch.section ?? null, run: patch.run ?? null, tpl: patch.tpl ?? (patch.page === "playground" ? current.tpl : null) }
      : base,
    opts.replace ?? false,
  )
}

export const getRoute = () => current
