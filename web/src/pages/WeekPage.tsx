import { useState } from "react"
import type { AlertKind, Line, Mover, Overview } from "@spec/contract"
import { useOverview } from "../api/hooks"
import { useCtx, isoWeek } from "../lib/ctx"
import { alertName, failureName, lineName, patternName } from "../lib/labels"
import { navigate } from "../lib/route"
import { compact, num, pct, ratio, time, weekLabel, weekdaysLabel } from "../lib/format"
import { Button, Tabs } from "../ui/controls"
import { Badge, Card, CoverageDots, Delta, ErrorState, Rate, Sev, Stat } from "../ui/display"
import { BarList, LevelBar, StackBar, TrendChart } from "../ui/charts"
import { Icon } from "../ui/icons"
import { Hint, Tooltip } from "../ui/overlays"
import { CmpFoot, PageSkeleton, fmt, trimHistory, weekPoint } from "./common"

export const WeekPage = () => {
  const { line, week, excluded, coverage } = useCtx()
  const q = useOverview(line, week)
  if (!week || q.isLoading) return <PageSkeleton />
  if (q.error || !q.data) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>
  const o = q.data
  return (
    <div className="page" key={`${line}-${week}`}>
      <div className="page-head">
        <div>
          <h1>第 {isoWeek(week)} 周</h1>
          <div className="meta">
            <span className="num">{weekLabel(week)}</span>
            {coverage && <CoverageDots days={coverage.days} week={week} />}
            <span>{coverage?.complete ? "整周数据" : `覆盖 ${coverage?.days.length ?? 0} 天`}</span>
            {o.previousCoverage && !o.previousCoverage.complete && <Badge tone="outline">上周只有 {weekdaysLabel(o.comparableWeekdays)}，对比只用这几天</Badge>}
            <span className="faint">更新于 {time(o.coverage.refreshedAt)}</span>
          </div>
        </div>
        <div className="actions">
          <Button icon="users" onClick={() => navigate({ page: "customers" })}>
            客户名单
          </Button>
          <Button icon="report" variant="primary" onClick={() => navigate({ page: "report" })}>
            周报
          </Button>
        </div>
      </div>
      <div className="grid">
        <Hero o={o} excluded={excluded} />
        <Tiles o={o} excluded={excluded} />
        <Concentration o={o} />
        <Movers o={o} />
        <Alerts o={o} line={line} />
        {o.inspiration && <InspirationBlocks o={o} />}
        {o.video && <VideoBlocks o={o} />}
      </div>
    </div>
  )
}

const Hero = ({ o, excluded }: { o: Overview; excluded: boolean }) => {
  const hist = trimHistory(o.history)
  const hasStable = hist.some((h) => h.stable != null)
  const pts = hist.map((h) => ({ label: weekPoint(h.week), value: hasStable ? h.stable : h.activeEnterprises, partial: !h.complete, note: h.complete ? `重度 ${h.heavy ?? "—"} · 中度 ${h.medium ?? "—"}` : `活跃 ${h.activeEnterprises} 家` }))
  const valid = pts.filter((p) => p.value != null)
  const sparse = valid.length < 3
  const th = o.line === "inspiration" ? "任务 ≥ 20 且 ≥ 3 天" : "任务 ≥ 5 且 ≥ 2 天"
  return (
    <Card className="span-7" style={{ minHeight: 280 }}>
      <div className="hero">
        <div className="left">
          {o.stable ? (
            <Stat
              size="lg"
              label="稳定使用企业"
              hint={`重度 + 中度。中度：${th}；重度：${o.line === "inspiration" ? "任务 ≥ 100 且 ≥ 4 天" : "任务 ≥ 20 且 ≥ 3 天"}`}
              value={o.stable.value}
              unit="家"
              foot={o.stable.comparable ? <span className="row" style={{ gap: 6 }}><Delta pair={o.stable.comparable} pill /><span>比上周</span></span> : <span>上周不完整，无法对比</span>}
            />
          ) : (
            <Stat size="lg" label="稳定使用企业" value="—" foot={<span>本周未结束，层级在整周后计算</span>} />
          )}
          {o.levels && <LevelBar levels={o.levels} onPick={(l) => navigate({ page: "customers", level: l })} />}
          <div className="row" style={{ gap: 16, marginTop: "auto" }}>
            <Stat size="xs" label="活跃企业" value={num(o.activeEnterprises.value)} />
            <Stat size="xs" label="活跃账号" value={num(o.users.value)} />
            <Stat size="xs" label={o.line === "inspiration" ? "最大客户任务占比" : "最大客户耗点占比"} value={pct(o.line === "inspiration" ? o.concentration.top1TaskShare : o.concentration.top1PointShare)} />
          </div>
        </div>
        <div className="chart-wrap">
          <div className="k">
            {hasStable ? "稳定使用企业 · 近 12 周" : "活跃企业 · 近 12 周"}
            {sparse && <span className="faint">数据积累中</span>}
            {excluded && <Badge tone="accent">对比不含最大客户</Badge>}
          </div>
          <TrendChart points={pts} height={210} kind={sparse ? "bar" : "line"} highlight={pts.length - 1} />
        </div>
      </div>
    </Card>
  )
}

const Tiles = ({ o, excluded }: { o: Overview; excluded: boolean }) => {
  const wd = o.comparableWeekdays
  const insp = o.line === "inspiration"
  const v = o.video
  return (
    <Card className="span-5" flush>
      <div className="tiles">
        <div className="tile">
          <Stat label={insp ? "任务" : "耗点"} hint={insp ? "导出的行数，与后台一致" : "点数合计，失败任务不扣点"} value={insp ? num(o.tasks.value) : compact(o.points.value)} foot={<CmpFoot m={insp ? o.tasks : o.points} excluded={excluded} weekdays={wd} />} />
        </div>
        <div className="tile">
          <Stat label="下载率" hint="下载过的任务 / 全部任务。是满意度的近似" value={pct(o.downloadRate.value, 1)} foot={<CmpFoot m={o.downloadRate} excluded={excluded} weekdays={wd} kind="pct" />} />
        </div>
        <div className="tile">
          <Stat label="活跃企业" value={num(o.activeEnterprises.value)} foot={<CmpFoot m={o.activeEnterprises} excluded={excluded} weekdays={wd} />} />
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
        </div>
      </div>
    </Card>
  )
}

const Concentration = ({ o }: { o: Overview }) => {
  const t = o.tasks
  const pair = t.comparable
  const ex = t.comparableExcluded
  const unit = o.line === "inspiration" ? "任务" : "耗点"
  const m = o.line === "inspiration" ? o.tasks : o.points
  const p = m.comparable
  const pe = m.comparableExcluded
  const row = (label: React.ReactNode, x: { current: number; previous: number } | null) => (
    <tr>
      <td>{label}</td>
      <td className="num">{x ? num(x.previous) : "—"}</td>
      <td className="num">{x ? num(x.current) : "—"}</td>
      <td style={{ width: 72 }}>{x ? <Delta pair={x} /> : <span className="faint">—</span>}</td>
    </tr>
  )
  void pair
  void ex
  return (
    <Card className="span-4" title="集中度" sub={`同星期${unit}`} actions={<Badge tone="outline">前 10 家占 {pct(o.concentration.top10TaskShare)}</Badge>}>
      <table className="cmp-table">
        <thead>
          <tr>
            <th />
            <th>上周</th>
            <th>本周</th>
            <th>变化</th>
          </tr>
        </thead>
        <tbody>
          {row("全部", p)}
          {row(
            <span className="row" style={{ gap: 6 }}>
              不含最大客户
              {!pe && <Tooltip content="在数据页设置排除企业后显示"><Icon name="info" size="xs" className="faint" /></Tooltip>}
            </span>,
            pe,
          )}
        </tbody>
      </table>
      <div className="divider" />
      <div
        className="alert-row"
        style={{ margin: "0 -16px", paddingTop: 4, paddingBottom: 4 }}
        onClick={() => navigate({ ent: o.concentration.top1.id })}
      >
        <span className="faint" style={{ fontSize: 12, width: 52 }}>最大客户</span>
        <span className="name">{o.concentration.top1.name}</span>
        <span className="num">{pct(o.line === "inspiration" ? o.concentration.top1TaskShare : o.concentration.top1PointShare)}</span>
        <Icon name="chevRight" size="sm" className="arrow" />
      </div>
      <div className="mini-legend">
        <span>
          上涨 <b>{o.moverCounts.rising}</b>
        </span>
        <span>
          下跌 <b>{o.moverCounts.falling}</b>
        </span>
        <span>
          <Hint text={`上周同星期 ${o.line === "inspiration" ? "≥ 50 个任务" : "≥ 10 个任务"}的企业`}>大客户</Hint> <b>{o.moverCounts.largeAccounts}</b>
        </span>
        <span>
          其中减半 <b className={o.moverCounts.largeAccountsHalved ? "down" : ""}>{o.moverCounts.largeAccountsHalved}</b>
        </span>
      </div>
    </Card>
  )
}

const moverTabs = ["falling", "rising", "silent", "new", "returned"] as const
const moverName: Record<(typeof moverTabs)[number], string> = { falling: "下跌", rising: "上涨", silent: "沉默", new: "新增", returned: "回归" }

const Movers = ({ o }: { o: Overview }) => {
  const [tab, setTab] = useState<(typeof moverTabs)[number]>("falling")
  const list: Mover[] = o.movers[tab]
  return (
    <Card className="span-4 movers" flush title="变动" actions={<Button size="xs" variant="ghost" iconRight="chevRight" onClick={() => navigate({ page: "customers", movement: tab === "falling" ? "drop" : tab === "rising" ? "surge" : tab })}>全部</Button>}>
      <Tabs value={tab} onChange={setTab} options={moverTabs.map((k) => ({ value: k, label: moverName[k], count: o.movers[k].length || undefined }))} />
      <div style={{ padding: "4px 0 8px" }}>
        {list.length ? (
          list.slice(0, 7).map((m) => (
            <div key={m.enterprise.id} className="row-item" onClick={() => navigate({ ent: m.enterprise.id })}>
              <span className="name">{m.enterprise.name}</span>
              <span className="nums">
                {tab === "new" || tab === "returned" ? (
                  <b>{num(m.current)}</b>
                ) : tab === "silent" ? (
                  <>上周 <b>{num(m.previous)}</b></>
                ) : (
                  <>
                    {num(m.previous)} → <b>{num(m.current)}</b>
                  </>
                )}
              </span>
              {tab === "rising" || tab === "falling" ? <Delta current={m.current} previous={m.previous} /> : <span style={{ width: 52 }} />}
            </div>
          ))
        ) : (
          <div className="empty compact">
            <span className="d">这一类没有企业</span>
          </div>
        )}
      </div>
    </Card>
  )
}

const Alerts = ({ o, line }: { o: Overview; line: Line }) => {
  const total = o.alerts.reduce((s, a) => s + a.count, 0)
  return (
    <Card className="span-4" flush title="预警" sub={`${total} 条`} actions={<Button size="xs" variant="ghost" iconRight="chevRight" onClick={() => navigate({ page: "customers" })}>客户</Button>}>
      <div style={{ padding: "0 0 8px" }}>
        {o.alerts.length ? (
          [...o.alerts]
            .sort((a, b) => b.severity - a.severity || b.count - a.count)
            .map((a) => (
              <div key={a.kind} className="alert-row" onClick={() => navigate({ page: "customers", alert: a.kind as AlertKind })}>
                <Sev s={a.severity} />
                <span className="name">{alertName[a.kind]}</span>
                <span className="count">{a.count}</span>
                <Icon name="chevRight" size="sm" className="arrow" />
              </div>
            ))
        ) : (
          <div className="empty compact">
            <span className="d">{lineName[line]}本周没有预警</span>
          </div>
        )}
      </div>
    </Card>
  )
}

const InspirationBlocks = ({ o }: { o: Overview }) => {
  const i = o.inspiration!
  const other = Math.max(0, 1 - i.batchShare - i.stuckShare)
  return (
    <>
      <Card className="span-6" title="使用方式" sub="快速模式">
        <StackBar
          segments={[
            { key: "batch", value: i.batchShare, color: "var(--accent-weak-2)", ink: "var(--accent-ink)", label: `批量 ${pct(i.batchShare)}` },
            { key: "stuck", value: i.stuckShare, color: "var(--down-weak)", ink: "var(--down)", label: `卡住 ${pct(i.stuckShare)}` },
            { key: "other", value: other, color: "rgba(24,24,27,.05)", label: `其他 ${pct(other)}` },
          ]}
        />
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginTop: 18 }}>
          <Stat size="sm" label={<Hint text="同一句提示词连续换图生成">批量</Hint>} value={pct(i.batchShare, 1)} foot={<span className="row" style={{ gap: 6 }}>下载率 <Rate value={i.batchDownloadRate} /></span>} />
          <Stat size="sm" label={<Hint text="同一张图重试或只改几个字">卡住</Hint>} value={pct(i.stuckShare, 1)} foot={<span className="row" style={{ gap: 6 }}>下载率 <Rate value={i.stuckDownloadRate} /></span>} />
          <Stat
            size="sm"
            label={<Hint text="提示词包含官方模板文本的前或后 16 个字">官方模板</Hint>}
            value={pct(i.officialTemplates.matched / Math.max(1, i.officialTemplates.quickTasks), 1)}
            foot={<span>{i.officialTemplates.used}/{i.officialTemplates.total} 个被用到，前 3 占 {pct(i.officialTemplates.top3Share)}</span>}
          />
        </div>
        <div className="divider" />
        <div className="row" style={{ gap: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
          <span>
            Agent <b className="num" style={{ color: "var(--ink)" }}>{num(i.agent.rows)}</b> 行 · {num(i.agent.turns)} 次提交 · {i.agent.enterprises} 家
          </span>
          <span>
            <Hint text="单个账号贡献的 Agent 行数">最大账号</Hint> <b className="num" style={{ color: "var(--ink)" }}>{num(i.agent.topUserRows)}</b>
          </span>
          <span className="spacer" />
          <span>出图 <b className="num" style={{ color: "var(--ink)" }}>{num(i.outputs)}</b> 张</span>
        </div>
      </Card>
      <Card className="span-6" title="任务类型" sub="按任务数" actions={<Button size="xs" variant="ghost" iconRight="chevRight" onClick={() => navigate({ page: "analysis" })}>分析</Button>}>
        <BarList
          items={i.intents.slice(0, 8).map((t) => ({
            key: t.intent,
            label: t.intent,
            value: t.tasks,
            display: <span className="num">{num(t.tasks)}</span>,
            secondary: <Rate value={t.downloadRate} width={36} />,
          }))}
        />
      </Card>
    </>
  )
}

const VideoBlocks = ({ o }: { o: Overview }) => {
  const v = o.video!
  const failTotal = v.failures.reduce((s, f) => s + f.count, 0)
  return (
    <>
      <Card className="span-7" title="模式" sub="按耗点" actions={<Button size="xs" variant="ghost" iconRight="chevRight" onClick={() => navigate({ page: "analysis" })}>分析</Button>}>
        <StackBar
          height={10}
          segments={v.modes.map((m, k) => ({ key: m.mode, value: m.points, color: ["var(--accent)", "var(--accent-3)", "var(--accent-4)", "#ece9df", "#e2ded3", "#d8d3c6"][k] ?? "#ddd", title: `${m.mode} ${pct(m.pointShare)}` }))}
        />
        <table className="table compact" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>模式</th>
              <th className="r">任务</th>
              <th className="r">耗点</th>
              <th className="r">占比</th>
              <th>下载率</th>
              <th className="r">失败</th>
            </tr>
          </thead>
          <tbody>
            {v.modes.map((m) => (
              <tr key={m.mode}>
                <td>{m.mode}</td>
                <td className="r num">{num(m.tasks)}</td>
                <td className="r num">{compact(m.points)}</td>
                <td className="r num faint">{pct(m.pointShare)}</td>
                <td>
                  <Rate value={m.downloadRate} />
                </td>
                <td className="r num">{m.failed ? <span className="down">{m.failed}</span> : <span className="faint">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="span-5" title="失败" sub={`${failTotal} 次`}>
        <BarList
          items={v.failures.map((f) => ({
            key: f.category,
            label: failureName[f.category],
            value: f.count,
            tone: f.category === "material" ? "var(--down-weak)" : undefined,
            display: <span className="num">{f.count}</span>,
            secondary: <span className="faint">{f.enterprises} 家</span>,
          }))}
        />
        {v.failures.some((f) => f.genericMessage > 0) && (
          <div className="banner" style={{ marginTop: 14 }}>
            <Icon name="alert" size="sm" />
            <span>
              {v.failures.filter((f) => f.genericMessage).reduce((s, f) => s + f.genericMessage, 0)} 次素材不合规，客户只看到“处理失败，请稍后重试”
            </span>
          </div>
        )}
        <div className="mini-legend" style={{ marginTop: 14 }}>
          <span>
            失败率 <b>{pct(o.failed.value / Math.max(1, o.tasks.value), 1)}</b>
          </span>
          <span>
            任务 <b>{num(o.tasks.value)}</b>
          </span>
          <span>
            <Delta current={o.failed.comparable?.current} previous={o.failed.comparable?.previous} invert /> 同星期
          </span>
        </div>
      </Card>
    </>
  )
}

export { patternName, ratio }
