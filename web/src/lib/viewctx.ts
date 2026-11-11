import { useSyncExternalStore } from "react"
import type { AskContext } from "@spec/contract"
import { getRoute } from "./route"

type Selection = AskContext["selection"]

let selection: Selection = null
let stamp = 0
const subs = new Set<() => void>()

export const select = (s: Selection) => {
  selection = s
  stamp++
  subs.forEach((f) => f())
}

export const clearSelection = () => select(null)

export const useSelection = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => selection,
  )

export const snapshot = (week: string | null): AskContext => {
  const r = getRoute()
  const filters: Record<string, string> = {}
  if (r.pool !== "all") filters.pool = r.pool
  if (r.level.length) filters.level = r.level.join(",")
  if (r.movement.length) filters.movement = r.movement.join(",")
  if (r.alert.length) filters.alert = r.alert.join(",")
  if (r.q) filters.q = r.q
  if (r.tags.length) filters.tags = r.tags.join(",")
  if (r.noted.length) filters.noted = r.noted.join(",")
  if (r.page === "templates") Object.assign(filters, { kind: r.kind, pane: r.pane })
  const page = r.page === "touches" ? "followups" : r.page === "enterprise" ? "enterprise" : r.page
  return {
    page: page as AskContext["page"],
    line: r.line,
    week,
    excluded: r.excluded,
    enterprise: r.ent,
    tab: r.ent ? r.tab : r.page === "templates" ? r.pane : null,
    filters,
    selection,
  }
}

export const selectionStamp = () => stamp
