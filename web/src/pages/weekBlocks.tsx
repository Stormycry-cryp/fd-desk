import { useState } from "react"
import type { Overview } from "@spec/contract"
import { useDaily } from "../api/hooks"
import { useCtx } from "../lib/ctx"
import { navigate } from "../lib/route"
import { compact, num, pct } from "../lib/format"
import { Segmented } from "../ui/controls"
import { Badge, Card, Delta, ErrorState, Stat } from "../ui/display"
import { BarList, Heatmap, LevelBar, MiniArea, TrendChart } from "../ui/charts"
import { Hint } from "../ui/overlays"
import { CmpFoot, fmt, trimHistory, weekPoint } from "./common"

export const Hero = ({ o, excluded }: { o: Overview; excluded: boolean }) => {
  const hist = trimHistory(o.history)
  const pts = hist.map((h) => ({ label: weekPoint(h.week), value: h.activeEnterprises, partial: !h.complete, note: h.stable != null ? `稳定 ${h.stable} 家` : undefined }))
  const stable = hist.map((h) => h.stable)
  const hasStable = stable.some((v) => v != null)
  const sparse = pts.filter((p) => p.value != null).length < 3
  const th = o.line === "inspiration" ? "任务 ≥ 20 且 ≥ 3 天" : "任务 ≥ 5 且 ≥ 2 天"
  return (
    <Card className="span-7" style={{ minHeight: 280 }}>
      <div className="hero">
        <div className="left">
          <Stat size="lg" label="活跃企业" hint="这周至少有一个任务的企业" value={num(o.activeEnterprises.value)} unit="家" foot={<CmpFoot m={o.activeEnterprises} excluded={excluded} weekdays={o.comparableWeekdays} />} />
          {o.levels && <LevelBar levels={o.levels} onPick={(l) => navigate({ page: "customers", level: [l] })} />}
          <div className="hero-mini">
            <Stat
              size="xs"
              label={<Hint text={`重度 + 中度。中度：${th}；重度：${o.line === "inspiration" ? "任务 ≥ 100 且 ≥ 4 天" : "任务 ≥ 20 且 ≥ 3 天"}`}>稳定使用</Hint>}
              value={o.stable ? o.stable.value : "—"}
              unit={o.stable?.comparable ? <Delta pair={o.stable.comparable} /> : undefined}
            />
            <Stat size="xs" label={<Hint text="上周稳定使用的企业，本周仍稳定使用的比例">稳定留存</Hint>} value={o.retention?.rate != null ? pct(o.retention.rate) : "—"} unit={o.retention?.rate != null ? <span className="faint num">{o.retention.kept}/{o.retention.base}</span> : undefined} />
            <Stat size="xs" label="活跃账号" value={num(o.users.value)} />
          </div>
        </div>
        <div className="chart-wrap">
          <div className="k">
            <span className="nowrap">近 12 周</span>
            {hasStable && (
              <span className="act-legend">
                <i className="d" />
                活跃企业
                <i className="a" />
                稳定使用
              </span>
            )}
            {sparse && <span className="faint">数据积累中</span>}
            {excluded && <Badge tone="accent">对比采用排除名单</Badge>}
          </div>
          <TrendChart points={pts} compare={hasStable ? stable : undefined} height={210} kind={sparse ? "bar" : "line"} highlight={pts.length - 1} />
        </div>
      </div>
    </Card>
  )
}

export const Tiles = ({ o, excluded }: { o: Overview; excluded: boolean }) => {
  const wd = o.comparableWeekdays
  const insp = o.line === "inspiration"
  const v = o.video
  const hist = trimHistory(o.history, 6)
  const labels = hist.map((h) => weekPoint(h.week))
  const partial = hist.map((h) => !h.complete)
  const trend = (vals: (number | null)[], f: (n: number) => string) => <MiniArea values={vals} partial={partial} labels={labels} format={f} />
  return (
    <Card className="span-5" flush>
      <div className="tiles">
        <div className="tile">
          <Stat label={insp ? "任务" : "耗点"} hint={insp ? "导出的行数，与后台一致" : "点数合计，失败任务不扣点"} value={insp ? num(o.tasks.value) : compact(o.points.value)} foot={<CmpFoot m={insp ? o.tasks : o.points} excluded={excluded} weekdays={wd} />} />
          {trend(hist.map((h) => (insp ? h.tasks : h.points)), (n) => (insp ? num(n) : compact(n)))}
        </div>
        <div className="tile">
          <Stat label="下载率" hint="下载过的任务 / 全部任务。是满意度的近似" value={pct(o.downloadRate.value, 1)} foot={<CmpFoot m={o.downloadRate} excluded={excluded} weekdays={wd} kind="pct" />} />
          {trend(hist.map((h) => (h.tasks ? h.downloadRate : null)), (n) => pct(n, 1))}
        </div>
        <div className="tile">
          <Stat
            label={<Hint text="重度 + 中度企业">稳定使用企业</Hint>}
            value={o.stable ? num(o.stable.value) : "—"}
            foot={o.stable?.comparable ? <span className="row" style={{ gap: 6 }}><Delta pair={o.stable.comparable} pill /><span>比上周</span></span> : <span>{o.stable ? "上周不完整" : "整周后计算"}</span>}
          />
          {trend(hist.map((h) => h.stable), num)}
        </div>
        <div className="tile">
          {insp ? (
            <Stat label="耗点" value={compact(o.points.value)} foot={<CmpFoot m={o.points} excluded={excluded} weekdays={wd} />} />
          ) : (
            <Stat
              label="未下载耗点"
              hint="没被下载的任务消耗的点数"
              value={pct(v?.notDownloadedShare ?? null)}
              foot={
                <span className="row" style={{ gap: 6 }}>
                  <span className="num">{compact(v?.pointsNotDownloaded)} 点</span>
                  <span className="faint">·</span>
                  <Hint text="耗点合计 / 被下载的视频数">每条被下载 {fmt(v?.pointsPerDownloaded, "dec")} 点</Hint>
                </span>
              }
            />
          )}
          {trend(hist.map((h) => (insp ? h.points : h.tasks)), insp ? compact : num)}
        </div>
      </div>
    </Card>
  )
}

type ActMode = "day" | "week" | "cum"
type ActMetric = "tasks" | "points" | "enterprises"

export const Activity = ({ o, report }: { o: Overview; report?: boolean }) => {
  const { meta } = useCtx()
  const line = o.line
  const insp = line === "inspiration"
  const [mode, setMode] = useState<ActMode>("day")
  const [metric, setMetric] = useState<ActMetric>(insp ? "tasks" : "points")
  const cov = meta?.coverage.filter((c) => c.line === line) ?? []
  const allDays = cov.flatMap((c) => c.days).sort()
  const from = meta?.weeks[0] ?? null
  const last = allDays[allDays.length - 1] ?? null
  const end = new Date(new Date(`${o.week}T00:00:00+08:00`).getTime() + 6 * 864e5 + 8 * 3600e3).toISOString().slice(0, 10)
  const to = report && last && last > end ? end : last
  const q = useDaily(line, from, to)
  const days = q.data ?? []
  const val = (d: { tasks: number; points: number; enterprises: number }) => d[metric]
  const f = metric === "points" ? compact : num
  const unit = metric === "tasks" ? "个任务" : metric === "points" ? "点" : "家企业"
  const covered = days.filter((d) => d.covered)
  const total = covered.reduce((s, d) => s + val(d), 0)
  const best = covered.reduce<(typeof days)[number] | null>((b, d) => (!b || val(d) > val(b) ? d : b), null)
  const weekly = o.history.filter((_, i) => i >= o.history.findIndex((x) => x.tasks > 0))
  const wv = (h: (typeof weekly)[number]) => (metric === "tasks" ? h.tasks : metric === "points" ? h.points : h.activeEnterprises)
  let acc = 0
  const avg7 = covered.map((_, i) => (i < 6 ? null : covered.slice(i - 6, i + 1).reduce((a, d) => a + val(d), 0) / 7))
  const span = days.length ? Math.ceil((new Date(days[days.length - 1].date).getTime() - new Date(days[0].date).getTime()) / 864e5 / 7) + 2 : 10
  const mapWidth = 22 + span * 24 + (span - 1) * 4
  const cumDays = covered.map((d) => ((acc += val(d)), { label: d.date.slice(5).replace("-", "/"), value: acc }))
  return (
    <Card
      className="span-12"
      title="使用活跃度"
      sub={best ? `共 ${f(total)} ${unit} · 最高 ${best.date.slice(5).replace("-", "/")} ${f(val(best))}` : undefined}
      actions={
        report ? undefined : <div className="row" style={{ gap: 10 }}>
          <Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: "tasks", label: "任务" }, { value: "points", label: "耗点" }, { value: "enterprises", label: "企业" }]} />
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "day", label: "每天" }, { value: "week", label: "每周" }, { value: "cum", label: "累计" }]} />
        </div>
      }
    >
      {q.isLoading ? (
        <div className="skel" style={{ height: 196, borderRadius: 10 }} />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : mode === "day" ? (
        <div className="activity">
          <div className="act-map" style={{ width: mapWidth }}>
            <Heatmap
              days={days.map((d) => ({ date: d.date, covered: d.covered, value: val(d), note: d.covered ? `${num(d.tasks)} 任务 · ${compact(d.points)} 点 · ${d.enterprises} 家${d.downloadRate != null ? ` · 下载 ${pct(d.downloadRate)}` : ""}` : undefined }))}
              format={(n) => `${f(n)} ${unit}`}
              maxCell={24}
            />
          </div>
          <div className="act-line">
            <div className="act-k">
              每日走势
              <span className="act-legend"><i className="d" />每天<i className="a" />7 日均值</span>
            </div>
            <TrendChart height={176} points={covered.map((d) => ({ label: d.date.slice(5).replace("-", "/"), value: val(d) }))} compare={avg7} format={f} yTicks={3} />
          </div>
          <div className="act-side">
            <div className="act-k">按星期 · 日均</div>
            <BarList
              items={["一", "二", "三", "四", "五", "六", "日"].map((l, k) => {
                const ds = covered.filter((d) => (new Date(`${d.date}T12:00:00+08:00`).getUTCDay() + 6) % 7 === k)
                const avg = ds.length ? ds.reduce((a, d) => a + val(d), 0) / ds.length : 0
                return { key: l, label: `周${l}`, value: avg, tone: k >= 5 ? "var(--accent-4)" : "var(--accent-3)", display: <span className="num">{f(avg)}</span> }
              })}
            />
            <div className="act-stats">
              <Stat size="xs" label="日均" value={f(covered.length ? total / covered.length : 0)} />
              <Stat size="xs" label="有数据的天" value={`${covered.length}`} />
              <Stat size="xs" label="最近 7 天" value={f(covered.slice(-7).reduce((a, d) => a + val(d), 0))} />
            </div>
          </div>
        </div>
      ) : mode === "week" ? (
        <TrendChart kind="bar" height={196} points={weekly.map((h) => ({ label: weekPoint(h.week), value: wv(h), partial: !h.complete }))} highlight={weekly.length - 1} format={f} />
      ) : (
        <TrendChart height={196} points={cumDays} format={f} yTicks={4} />
      )}
    </Card>
  )
}

