import { useEffect } from "react"
import type { Locator } from "@spec/contract"
import { navigate, useRoute, type EntTab, type PageKey, type Route } from "./route"

const pageMap: Record<Locator["page"], PageKey> = {
  week: "week",
  customers: "customers",
  enterprise: "customers",
  templates: "templates",
  playground: "playground",
  followups: "touches",
  analysis: "analysis",
  data: "data",
  export: "export",
  cases: "cases",
}

export const locate = (l: Locator) => {
  const page = pageMap[l.page]
  const f = l.filters ?? {}
  const values = (key: string) => f[key]?.split(",").filter(Boolean) ?? []
  navigate({
    page: l.page === "enterprise" && !l.enterprise ? "customers" : page,
    ...(l.line ? { line: l.line } : {}),
    ...(l.week ? { week: l.week } : {}),
    ...(l.enterprise ? { ent: l.enterprise, tab: (l.tab ?? (l.task ? "tasks" : "profile")) as EntTab } : {}),
    ...(l.section ? { section: l.section } : { section: null }),
    ...(l.draft ? { tpl: l.draft, pane: "drafts" as const } : {}),
    ...(l.run ? { run: l.run } : {}),
    level: values("level") as Route["level"],
    movement: values("movement") as Route["movement"],
    alert: values("alert") as Route["alert"],
    trend: values("trend") as Route["trend"],
    models: values("models"),
    intent: values("intent"),
    pool: (f.pool ?? "all") as Route["pool"],
    tags: values("tags"),
    noted: values("noted") as Route["noted"],
    q: f.q ?? "",
  })
}

export const useSectionFocus = () => {
  const { section, ent, tab } = useRoute()
  useEffect(() => {
    if (!section) return
    let tries = 0
    const t = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-section="${CSS.escape(section)}"]`)
      tries++
      if (el) {
        window.clearInterval(t)
        el.scrollIntoView({ block: "center", behavior: "smooth" })
        el.classList.remove("flash")
        void el.offsetWidth
        el.classList.add("flash")
        window.setTimeout(() => navigate({ section: null }, { replace: true }), 1600)
      } else if (tries > 30) window.clearInterval(t)
    }, 100)
    return () => window.clearInterval(t)
  }, [section, ent, tab])
}
