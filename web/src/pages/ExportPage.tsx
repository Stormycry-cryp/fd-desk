import { useMemo, useState } from "react"
import type { ExportItem, ExportKind, Line } from "@spec/contract"
import { useCtx } from "../lib/ctx"
import { lineName } from "../lib/labels"
import { navigate } from "../lib/route"
import { weekLabel } from "../lib/format"
import { exportBundle, exportKindName, exportOne } from "../lib/download"
import { Button, Checkbox, Segmented, cx } from "../ui/controls"
import { Icon, type IconName } from "../ui/icons"
import { JobProgress } from "../ui/insight"
import { Select } from "../ui/overlays"

interface Def { kind: ExportKind; icon: IconName; group: string; desc: string; params: ("line" | "week")[] }

const defs: Def[] = [
  { kind: "roster", icon: "users", group: "客户", desc: "当前周的全部企业、层级、变动、标签和档案一句话", params: ["line", "week"] },
  { kind: "annotations", icon: "edit", group: "客户", desc: "全部批注，含追加记录和锚点位置", params: [] },
  { kind: "movements", icon: "chart", group: "客户", desc: "涨跌原因分析：结论、原因、证据、建议动作", params: ["line", "week"] },
  { kind: "followups", icon: "send", group: "客户", desc: "跟进清单：目的、原因、话术、回复和下一周变化", params: ["line", "week"] },
  { kind: "records", icon: "layers", group: "客户", desc: "全部生成记录与记录上的批注", params: ["line"] },
  { kind: "templates_official", icon: "template", group: "模板", desc: "官方模板配置表，交给运营上线", params: ["line"] },
  { kind: "templates_custom", icon: "building", group: "模板", desc: "定制模板配置表，按目标企业", params: ["line"] },
  { kind: "opportunities", icon: "sparkle", group: "模板", desc: "模板机会与证据数字", params: ["line", "week"] },
  { kind: "monitor", icon: "chart", group: "模板", desc: "已上线模板的每周使用和下载率", params: ["line"] },
  { kind: "analysis_matrix", icon: "chart", group: "分析", desc: "任务类型 × 模型的任务数和下载率", params: ["line", "week"] },
  { kind: "analysis_failures", icon: "alert", group: "分析", desc: "失败明细：客户看到的提示和真实原因", params: ["line", "week"] },
  { kind: "tasks", icon: "database", group: "分析", desc: "本周全部任务明细", params: ["line", "week"] },
]

const prints: { key: string; icon: IconName; label: string; desc: string; go: () => void }[] = [
  { key: "report", icon: "report", label: "周报", desc: "两条线的数字、图表、涨跌和下周计划", go: () => navigate({ page: "report" }) },
  { key: "profiles", icon: "printer", label: "客户档案", desc: "在客户列表勾选企业后点「打印档案」", go: () => navigate({ page: "customers" }) },
  { key: "movements", icon: "chart", label: "涨跌原因", desc: "本周全部涨跌原因，一周一页", go: () => window.open(`/print/movements${location.search}`, "_blank") },
]

export const ExportPage = () => {
  const { line: ctxLine, week, meta } = useCtx()
  const [line, setLine] = useState<Line | "both">(ctxLine)
  const [wk, setWk] = useState(week ?? "")
  const [sel, setSel] = useState<Set<ExportKind>>(new Set())
  const [busy, setBusy] = useState(false)
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null)
  const lines: Line[] = line === "both" ? ["inspiration", "video"] : [line]
  const items = useMemo<ExportItem[]>(
    () =>
      [...sel].flatMap((k) => {
        const d = defs.find((x) => x.kind === k)!
        if (!d.params.includes("line")) return [{ kind: k, params: {} }]
        return lines.map((l) => ({ kind: k, params: { line: l, ...(d.params.includes("week") && wk ? { week: wk } : {}) } }))
      }),
    [sel, line, wk],
  )
  const toggle = (k: ExportKind) => setSel((s) => {
    const n = new Set(s)
    n.has(k) ? n.delete(k) : n.add(k)
    return n
  })
  const bundle = async () => {
    setBusy(true)
    setProg(null)
    await exportBundle(items, (done, total) => setProg({ done, total }))
    setBusy(false)
  }
  const one = (d: Def) =>
    Promise.all(
      (d.params.includes("line") ? lines : [null]).map((l) => exportOne(d.kind, { line: l ?? undefined, week: d.params.includes("week") ? wk : undefined }, `${exportKindName[d.kind]}${l ? `_${lineName[l]}` : ""}${d.params.includes("week") && wk ? `_${wk}` : ""}`)),
    )
  const groups = [...new Set(defs.map((d) => d.group))]
  const weeks = [...(meta?.weeks ?? [])].reverse()
  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page-head">
        <div>
          <h1>导出</h1>
          <div className="meta">
            <span>表格交给运营，打印页用于汇报</span>
          </div>
        </div>
        <div className="actions">
          <Segmented value={line} onChange={setLine} options={[{ value: "inspiration", label: lineName.inspiration }, { value: "video", label: lineName.video }, { value: "both", label: "两条线" }]} />
          <Select value={wk} onChange={setWk} prefix="周" options={weeks.map((w) => ({ value: w, label: weekLabel(w) }))} />
        </div>
      </div>
      <div className="ex-layout">
        <div className="stack" style={{ gap: 22 }}>
          {groups.map((g) => (
            <section key={g}>
              <h3 className="ex-g">{g}</h3>
              <div className="ex-grid">
                {defs
                  .filter((d) => d.group === g)
                  .map((d) => (
                    <div key={d.kind} className={cx("ex-item", sel.has(d.kind) && "on")} onClick={() => toggle(d.kind)}>
                      <Checkbox checked={sel.has(d.kind)} onChange={() => toggle(d.kind)} />
                      <span className="ex-ic">
                        <Icon name={d.icon} size="sm" />
                      </span>
                      <div className="stack" style={{ gap: 3, minWidth: 0 }}>
                        <b>{exportKindName[d.kind]}</b>
                        <span className="ex-d">{d.desc}</span>
                        <span className="ex-p">{d.params.length ? d.params.map((p) => (p === "line" ? (line === "both" ? "两条线" : lineName[line]) : wk ? weekLabel(wk) : "—")).join(" · ") : "全部"}</span>
                      </div>
                      <Button size="xs" variant="ghost" icon="download" onClick={(e) => (e.stopPropagation(), one(d))} />
                    </div>
                  ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="ex-side">
          <div className="ex-cart">
            <div className="row" style={{ gap: 8 }}>
              <b>打包下载</b>
              <span className="spacer" />
              {sel.size > 0 && (
                <Button size="xs" variant="ghost" onClick={() => setSel(new Set())}>
                  清空
                </Button>
              )}
            </div>
            {items.length ? (
              <div className="ex-list">
                {items.map((it, i) => (
                  <div key={i} className="ex-li">
                    <span className="ellipsis">{exportKindName[it.kind]}</span>
                    <span className="faint">{it.params.line ? lineName[it.params.line as Line] : "全部"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="faint" style={{ fontSize: 13 }}>勾选左侧的内容</span>
            )}
            {busy ? <JobProgress state="running" done={prog?.done} total={prog?.total || undefined} label="打包中" /> : (
              <Button variant="primary" icon="download" disabled={!items.length} onClick={bundle}>
                {items.length ? `下载 ${items.length} 个文件` : "打包下载"}
              </Button>
            )}
          </div>
          <div className="ex-cart">
            <b>打印</b>
            {prints.map((p) => (
              <button key={p.key} className="ex-print" onClick={p.go}>
                <Icon name={p.icon} size="sm" />
                <div className="stack" style={{ gap: 2, minWidth: 0, textAlign: "left" }}>
                  <span>{p.label}</span>
                  <span className="ex-d">{p.desc}</span>
                </div>
                <Icon name="chevRight" size="sm" className="faint" />
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
