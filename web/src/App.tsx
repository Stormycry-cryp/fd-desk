import { useEffect, useState } from "react"
import { useCtx } from "./lib/ctx"
import { navigate, type PageKey } from "./lib/route"
import { useKey } from "./lib/useKey"
import { Shell } from "./shell/Shell"
import { Palette } from "./shell/Palette"
import { Toaster } from "./ui/overlays"
import { WeekPage } from "./pages/WeekPage"
import { CustomersPage } from "./pages/CustomersPage"
import { TouchesPage } from "./pages/TouchesPage"
import { TemplatesPage } from "./pages/TemplatesPage"
import { AnalysisPage } from "./pages/AnalysisPage"
import { DataPage } from "./pages/DataPage"
import { ReportPage } from "./pages/ReportPage"
import { EnterprisePage } from "./pages/EnterprisePage"
import { EnterpriseDrawer } from "./pages/enterprise/EnterpriseView"
import { KitPage } from "./pages/KitPage"
import { ProfilePreview } from "./pages/kit/ProfilePreview"
import { PlaygroundPage } from "./pages/PlaygroundPage"
import { ExportPage } from "./pages/ExportPage"
import { useJobWatcher } from "./api/next"
import { Button } from "./ui/controls"
import { Empty, ErrorState } from "./ui/display"
import { PageSkeleton } from "./pages/common"

const pages: Record<PageKey | "kit", () => React.ReactNode> = {
  week: WeekPage,
  customers: CustomersPage,
  touches: TouchesPage,
  templates: TemplatesPage,
  analysis: AnalysisPage,
  data: DataPage,
  report: ReportPage,
  enterprise: EnterprisePage,
  playground: PlaygroundPage,
  export: ExportPage,
  kit: KitPage,
}

const order: PageKey[] = ["week", "customers", "touches", "templates", "analysis", "data"]

export const App = () => {
  const { route, meta, metaError, metaLoading, refreshMeta, week } = useCtx()
  const [palette, setPalette] = useState(false)
  useJobWatcher()
  const kit = location.pathname.startsWith("/kit")
  useKey(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((v) => !v)
      }
    },
    [],
    true,
  )
  useKey((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === "1") navigate({ line: "inspiration" }, { replace: true })
    if (e.key === "2") navigate({ line: "video" }, { replace: true })
    if (e.key === "/") (e.preventDefault(), setPalette(true))
    if (e.key === "g") {
      const f = (ev: KeyboardEvent) => {
        const map: Record<string, PageKey> = { w: "week", c: "customers", t: "touches", m: "templates", a: "analysis", d: "data", r: "report" }
        if (map[ev.key]) navigate({ page: map[ev.key] })
      }
      window.addEventListener("keydown", f, { once: true })
    }
  })
  useEffect(() => {
    const titles: Record<string, string> = { week: "本周", customers: "客户", touches: "触达", templates: "模板", analysis: "分析", data: "数据", report: "周报", enterprise: "企业" }
    document.title = `${titles[route.page] ?? ""} · FD 客户台`
    window.scrollTo({ top: 0 })
  }, [route.page])
  const Page = kit ? (location.pathname.startsWith("/kit/profile") ? ProfilePreview : pages.kit) : pages[route.page]
  const content = metaError ? <ErrorState error={metaError} retry={() => refreshMeta()} /> : metaLoading || !meta ? <PageSkeleton /> : !week && route.page !== "data" && !kit ? <Empty title="尚未导入数据" action={<Button onClick={() => navigate({ page: "data" })}>导入数据</Button>} /> : <Page key={kit ? "kit" : route.page} />
  return (
    <>
      {route.page === "report" && !kit ? (
        content
      ) : (
        <Shell onSearch={() => setPalette(true)} order={order}>
          {content}
        </Shell>
      )}
      {!kit && route.ent && route.page !== "enterprise" && <EnterpriseDrawer id={route.ent} />}
      <Palette open={palette} onClose={() => setPalette(false)} />
      <Toaster />
    </>
  )
}
