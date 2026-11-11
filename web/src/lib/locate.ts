import { useEffect } from "react"
import type { Locator } from "@spec/contract"
import { navigate, useRoute, type EntTab, type PageKey } from "./route"

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
}

export const locate = (l: Locator) => {
  const page = pageMap[l.page]
  const f = l.filters ?? {}
  navigate({
    page: l.page === "enterprise" && !l.enterprise ? "customers" : page,
    ...(l.line ? { line: l.line } : {}),
    ...(l.week ? { week: l.week } : {}),
    ...(l.enterprise ? { ent: l.enterprise, tab: (l.tab ?? (l.task ? "tasks" : "profile")) as EntTab } : {}),
    ...(l.section ? { section: l.section } : { section: null }),
    ...(l.draft ? { tpl: l.draft, pane: "drafts" as const } : {}),
    ...(l.run ? { run: l.run } : {}),
    ...(f.level ? { level: f.level.split(",") as never } : {}),
    ...(f.movement ? { movement: f.movement.split(",") as never } : {}),
    ...(f.alert ? { alert: f.alert.split(",") as never } : {}),
    ...(f.trend ? { trend: f.trend.split(",") as never } : {}),
    ...(f.pool ? { pool: f.pool as never } : {}),
    ...(f.tags ? { tags: f.tags.split(",") } : {}),
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
