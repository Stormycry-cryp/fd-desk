import { useEffect, useState, type ReactNode } from "react"
import { useAlerts, useOverview } from "../api/hooks"
import { useFollowups } from "../api/next"
import { useCtx, isoWeek } from "../lib/ctx"
import { lineName } from "../lib/labels"
import { navigate, type PageKey } from "../lib/route"
import { weekLabel, time } from "../lib/format"
import { Segmented, Kbd, cx } from "../ui/controls"
import { Icon, type IconName } from "../ui/icons"
import { Tooltip } from "../ui/overlays"
import { CoverageDots } from "../ui/display"
import { WeekPicker } from "./WeekPicker"

const nav: { key: PageKey; label: string; icon: IconName; k: string }[] = [
  { key: "week", label: "本周", icon: "home", k: "W" },
  { key: "customers", label: "客户", icon: "users", k: "C" },
  { key: "touches", label: "跟进", icon: "send", k: "T" },
  { key: "templates", label: "模板", icon: "template", k: "M" },
  { key: "analysis", label: "分析", icon: "chart", k: "A" },
  { key: "data", label: "数据", icon: "database", k: "D" },
]

const crumbs: Record<PageKey, string> = { week: "本周", customers: "客户", touches: "跟进", templates: "模板", analysis: "分析", data: "数据", report: "周报", enterprise: "企业", playground: "试验台", export: "导出", print: "打印" }

export const Shell = ({ children, onSearch }: { children: ReactNode; onSearch: () => void; order: PageKey[] }) => {
  const { route, line, week, meta, metaError, coverage, exIds } = useCtx()
  const ov = useOverview(line, week)
  const fu = useFollowups(line, week)
  const alerts = useAlerts(line, week)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 4)
    window.addEventListener("scroll", f, { passive: true })
    return () => window.removeEventListener("scroll", f)
  }, [])
  const alertN = alerts.data?.filter((a) => a.severity === 3 && !a.dismissed).length ?? ov.data?.alerts.filter((a) => a.severity === 3).reduce((s, a) => s + a.count, 0)
  const todo = fu.data ? fu.data.items.filter((t) => t.state === "todo").length : null
  const counts: Partial<Record<PageKey, { n: number; alert?: boolean } | null>> = {
    customers: alertN ? { n: alertN, alert: true } : null,
    touches: todo ? { n: todo } : null,
  }
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="mark-logo">
            <Icon name="logo" size="sm" style={{ strokeWidth: 2.4 }} />
          </span>
          <div className="stack" style={{ lineHeight: 1.25 }}>
            <b>FD 客户台</b>
            <span className="faint">灵感成款 · AI视频</span>
          </div>
        </div>
        <Segmented block size="sm" value={line} onChange={(v) => navigate({ line: v }, { replace: true })} options={[{ value: "inspiration", label: lineName.inspiration }, { value: "video", label: lineName.video }]} />
        <nav className="nav">
          {nav.map((n) => {
            const c = counts[n.key]
            return (
              <a
                key={n.key}
                href={n.key === "week" ? "/" : `/${n.key}`}
                className={cx((route.page === n.key || (n.key === "customers" && route.page === "enterprise")) && "on")}
                onClick={(e) => {
                  e.preventDefault()
                  navigate({ page: n.key })
                }}
              >
                <Icon name={n.icon} />
                {n.label}
                {c ? <span className={cx("n", c.alert && "alert")}>{c.n}</span> : <Kbd keys={["G", n.k]} />}
              </a>
            )
          })}
        </nav>
        <div className="nav-label">导出</div>
        <nav className="nav">
          <a
            href="/report"
            onClick={(e) => {
              e.preventDefault()
              navigate({ page: "report" })
            }}
          >
            <Icon name="report" />
            周报
            <Kbd keys={["G", "R"]} />
          </a>
          <a
            href="/export"
            className={cx(route.page === "export" && "on")}
            onClick={(e) => {
              e.preventDefault()
              navigate({ page: "export" })
            }}
          >
            <Icon name="download" />
            导出中心
            <Kbd keys={["G", "E"]} />
          </a>
        </nav>
        <div className="side-foot">
          <Tooltip content={metaError ? "本机后端连接失败" : "使用本机后端的真实导入数据"}>
            <div className={cx("src-mode", !!metaError && "error")}>
              <i />
              <span className="stack">
                <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>{metaError ? "连接失败" : meta ? "本机后端" : "连接中"}</span>
                <span className="faint" style={{ fontSize: 12 }}>
                  {meta?.lastImportAt ? `导入于 ${time(meta.lastImportAt)}` : "—"}
                </span>
              </span>
            </div>
          </Tooltip>
        </div>
      </aside>
      <div className="main">
        <header className={cx("top", scrolled && "scrolled")}>
          <div className="crumb">
            <span>{crumbs[route.page]}</span>
            <span className="sep">/</span>
            <span className="muted">{lineName[line]}</span>
          </div>
          <div className="spacer" />
          {week && coverage && !coverage.complete && (
            <Tooltip content={`本周数据覆盖 ${coverage.days.length} 天，层级在完整周后计算`}>
              <span className="badge warn" style={{ gap: 6 }}>
                <CoverageDots days={coverage.days} week={week} />
                不完整
              </span>
            </Tooltip>
          )}
          <WeekPicker />
          <Tooltip content={exIds.length ? `对比数字排除名单中的 ${exIds.length} 家企业` : "没有设置排除企业"}>
            <button
              className={cx("chip", route.excluded ? "on" : "idle")}
              disabled={!exIds.length}
              style={{ opacity: exIds.length ? 1 : 0.5 }}
              onClick={() => navigate({ excluded: !route.excluded }, { replace: true })}
            >
              <Icon name={route.excluded ? "check" : "filter"} size="xs" />
              应用排除名单
            </button>
          </Tooltip>
          <button className="search-btn" onClick={onSearch}>
            <Icon name="search" size="sm" />
            <span>搜索企业</span>
            <Kbd keys={["⌘", "K"]} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

export const weekTitle = (w: string) => `第 ${isoWeek(w)} 周 · ${weekLabel(w)}`
