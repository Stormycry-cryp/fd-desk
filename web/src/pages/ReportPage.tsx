import type { Line, ReportLine } from "@spec/contract"
import { useReport, useCall } from "../api/hooks"
import { useCtx, isoWeek } from "../lib/ctx"
import { lineName } from "../lib/labels"
import { navigate } from "../lib/route"
import { compact, num, pct, weekLabel, weekdaysLabel } from "../lib/format"
import { Button } from "../ui/controls"
import { Delta, ErrorState, InlineEdit, Skel, SourceTag, Stat } from "../ui/display"
import { Toaster, toast } from "../ui/overlays"
import { WeekPicker } from "../shell/WeekPicker"
import { pickPair } from "./common"
import { useOverview } from "../api/hooks"
import { Activity, Hero, Tiles } from "./weekBlocks"
import { useMovements } from "../api/next"

export const ReportPage = () => {
  const { week, excluded } = useCtx()
  const q = useReport(week)
  const put = useCall("PUT /api/report", ["GET /api/report"])
  const r = q.data
  const save = (k: "done" | "next", text: string) => put.mutate({ body: { week: week!, [k]: text, source: "manual" } }, { onSuccess: () => toast("已保存", { tone: "ok", ms: 1500 }), onError: (e: any) => toast(e.message, { tone: "error" }) })
  return (
    <>
      <div className="report-bar no-print">
        <Button size="sm" variant="ghost" icon="chevLeft" onClick={() => navigate({ page: "week" })}>
          返回
        </Button>
        <span className="spacer" />
        <WeekPicker />
        <Button size="sm" variant="primary" icon="printer" onClick={() => window.print()}>
          打印
        </Button>
      </div>
      <div className="report">
        {!week || q.isLoading ? (
          <Skel h={600} />
        ) : q.error || !r ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            <h1>FD 灵感成款 · AI视频 周报</h1>
            <div className="lead num">
              第 {isoWeek(week)} 周 · {weekLabel(week)}
            </div>
            {r.lines.map((l) => (
              <LineBlock key={l.line} l={l} excluded={excluded} week={week} />
            ))}
            <h2>
              本周做了什么 <SourceTag a={r.done} />
            </h2>
            <InlineEdit value={r.done?.text ?? ""} placeholder="写下本周的动作" onSave={(v) => save("done", v)} />
            <div className="row" style={{ gap: 24, marginTop: 12, fontSize: 13.5, color: "var(--ink-3)" }}>
              <span>
                跟进已联系 <b className="num" style={{ color: "var(--ink)" }}>{r.touches.sent}</b>
              </span>
              <span>
                已回复 <b className="num" style={{ color: "var(--ink)" }}>{r.touches.replied}</b>
              </span>
              <span>
                有结果 <b className="num" style={{ color: "var(--ink)" }}>{r.touches.withOutcome}</b>
              </span>
            </div>
            <h2>
              下周做什么 <SourceTag a={r.next} />
            </h2>
            <InlineEdit value={r.next?.text ?? ""} placeholder="写下下周计划" onSave={(v) => save("next", v)} />
          </>
        )}
      </div>
      <Toaster />
    </>
  )
}

const LineBlock = ({ l, excluded, week }: { l: ReportLine; excluded: boolean; week: string }) => {
  const ov = useOverview(l.line as Line, week)
  const mv = useMovements(l.line as Line, week)
  const why = new Map((mv.data ?? []).filter((m) => m.state === "done" && m.headline).map((m) => [m.enterprise.id, m.headline]))
  const wd = ov.data?.comparableWeekdays ?? []
  const insp = l.line === "inspiration"
  const p = pickPair(insp ? l.tasks : l.points, false)
  const pe = l.withoutTop1
  const cmpLabel = wd.length === 7 ? "比上周" : `同星期（${weekdaysLabel(wd)}）`
  return (
    <>
      <section className="rp-line">
      <h2>{lineName[l.line]}</h2>
      {ov.data ? (
        <div className="grid rp-grid">
          <Hero o={ov.data} excluded={excluded} />
          <Tiles o={ov.data} excluded={excluded} />
          <Activity o={ov.data} report />
        </div>
      ) : ov.error ? (
        <div className="metrics">
          <Stat label="稳定使用企业" value={l.stable?.value ?? "—"} unit={l.stable ? "家" : undefined} foot={l.stable?.comparable ? <Delta pair={l.stable.comparable} pill /> : <span>上周不完整</span>} />
          <Stat label="活跃企业" value={num(l.activeEnterprises.value)} foot={<Delta pair={pickPair(l.activeEnterprises, excluded)} pill />} />
          <Stat label={insp ? "任务" : "耗点"} value={insp ? num(l.tasks.value) : compact(l.points.value)} foot={<Delta pair={p} pill />} />
          <Stat label="下载率" value={pct(l.downloadRate.value, 1)} foot={<Delta pair={pickPair(l.downloadRate, excluded)} rate pill />} />
        </div>
      ) : (
        <Skel h={560} r={12} />
      )}
      <table className="cmp-table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>{cmpLabel}</th>
            <th>上周</th>
            <th>本周</th>
            <th>变化</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>全部</td>
            <td className="num">{p ? num(p.previous) : "—"}</td>
            <td className="num">{p ? num(p.current) : "—"}</td>
            <td>{p ? <Delta pair={p} /> : "—"}</td>
          </tr>
          <tr>
            <td>不含最大客户（占 {pct(l.top1Share)}）</td>
            <td className="num">{pe ? num(pe.previous) : "—"}</td>
            <td className="num">{pe ? num(pe.current) : "—"}</td>
            <td>{pe ? <Delta pair={pe} /> : "—"}</td>
          </tr>
        </tbody>
      </table>
      <div className="movers-2">
        <div>
          <div className="label">下跌</div>
          {l.falling.map((m) => (
            <div key={m.enterprise.id} className="mv">
              <div className="mv-t">
                <span className="n ellipsis">{m.enterprise.name}</span>
                <span className="num">
                  {num(m.previous)} → <b>{num(m.current)}</b>
                </span>
              </div>
              {(why.get(m.enterprise.id) ?? m.reason) && <span className={why.has(m.enterprise.id) ? "r why" : "r"}>{why.get(m.enterprise.id) ?? m.reason}</span>}
            </div>
          ))}
          {!l.falling.length && <span className="faint">无</span>}
        </div>
        <div>
          <div className="label">上涨</div>
          {l.rising.map((m) => (
            <div key={m.enterprise.id} className="mv">
              <div className="mv-t">
                <span className="n ellipsis">{m.enterprise.name}</span>
                <span className="num">
                  {num(m.previous)} → <b>{num(m.current)}</b>
                </span>
              </div>
              {(why.get(m.enterprise.id) ?? m.reason) && <span className={why.has(m.enterprise.id) ? "r why" : "r"}>{why.get(m.enterprise.id) ?? m.reason}</span>}
            </div>
          ))}
          {!l.rising.length && <span className="faint">无</span>}
        </div>
      </div>
      </section>
    </>
  )
}
