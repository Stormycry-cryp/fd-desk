import { useMemo, useRef, useState } from "react"
import type { Line } from "@spec/contract"
import type { InsightKey, Profile, ProfileFacts, ProfileInsight, RhythmKind, Scope } from "@spec/contract.next"
import { useDaily } from "../../api/hooks"
import { useRefreshProfile } from "../../api/next"
import { useCtx } from "../../lib/ctx"
import { failureName } from "../../lib/labels"
import { ago, compact, num, pct, time, weekShort } from "../../lib/format"
import { Button, cx } from "../../ui/controls"
import { Avatar, Empty, Phone } from "../../ui/display"
import { BarList, Heatmap } from "../../ui/charts"
import { Icon } from "../../ui/icons"
import { Tooltip } from "../../ui/overlays"
import { Annotatable, useQuoteSelection } from "../../ui/annotate"
import { BigStat, ConfidenceDot, EvidenceChip, HourHeat, JobProgress, Segments } from "../../ui/insight"

export const insightName: Record<InsightKey, string> = { business: "做什么生意", usage: "用 FD 做什么", workflow: "怎么工作", skill: "熟练程度", pain: "痛点", opportunity: "机会" }
export const rhythmName: Record<RhythmKind, string> = { continuous: "连续", batch: "按批次", occasional: "偶尔" }
export const blockName: Record<string, string> = {
  "facts.core": "核心数字",
  "facts.weekly": "走势",
  "facts.hours": "使用时段",
  "facts.daily": "每日使用",
  "facts.scenes": "功能版图",
  "facts.intents": "任务类型",
  "facts.models": "模型",
  "facts.quality": "结果质量",
  "facts.members": "成员",
  headline: "一句话",
  ...Object.fromEntries(Object.entries({ business: 1, usage: 1, workflow: 1, skill: 1, pain: 1, opportunity: 1 }).map(([k]) => [`insight.${k}`, insightName[k as InsightKey]])),
}

const sceneColors = ["#5f57e6", "#a6a1f1", "#d6d4f8", "#9bb8ab", "#e0c48f", "#d9d6cf", "#c7b8d6", "#b9c7d9"]
const order: InsightKey[] = ["business", "usage", "workflow", "skill", "pain", "opportunity"]

export const ProfileTab = ({ p, scope }: { p: Profile; scope: Scope }) => {
  const f = p.facts[scope] ?? p.facts.all
  const wrap = useRef<HTMLDivElement>(null)
  const quote = useQuoteSelection(wrap)
  if (!f) return <Empty icon="layers" title="这个范围没有任务" />
  return (
    <div ref={wrap} className="profile">
      <Core f={f} />
      <Insights p={p} />
      <Habits f={f} id={p.enterprise.id} scope={scope} />
      <Doing f={f} />
      <Models f={f} />
      <Quality f={f} />
      <Members f={f} />
      {quote}
    </div>
  )
}

const Core = ({ f }: { f: ProfileFacts }) => {
  const w = f.weekly.filter((_, i, a) => i >= a.findIndex((y) => y.tasks > 0))
  const labels = w.map((x) => weekShort(x.week))
  const partial = w.map((x) => !x.complete)
  const t = f.totals
  const r = f.rhythm
  const gap = r.currentGapWeeks
  return (
    <Annotatable block="facts.core" label="核心数字" className="pf-block">
      <div className="pf-core">
        <BigStat label="近 4 周任务" value={num(t.recentTasks)} sub={<span>累计 {num(t.tasks)}</span>} trend={w.map((x) => x.tasks)} partial={partial} labels={labels} format={num} />
        <BigStat
          label="下载率"
          value={t.recentDownloadRate == null ? "—" : pct(t.recentDownloadRate, 0)}
          tone={t.recentDownloadRate != null && t.recentDownloadRate < 0.35 ? "down" : undefined}
          sub={<span>累计 {pct(t.downloadRate, 0)}</span>}
          trend={w.map((x) => (x.tasks ? x.downloadRate : null))}
          partial={partial}
          labels={labels}
          format={(n) => pct(n, 1)}
        />
        <BigStat label="稳定周数" value={t.stableWeeks} unit={`/ ${t.activeWeeks} 周`} sub={<span>首次 {weekShort(t.firstSeenAt)}</span>} hint="达到稳定使用层级的完整周数 / 有使用的周数" />
        <BigStat
          label="使用节奏"
          value={rhythmName[r.kind]}
          tone={gap >= 2 ? "down" : undefined}
          sub={<span>{gap > 0 ? `已 ${gap} 周没用` : `最近 ${ago(t.lastActiveAt)}`}{r.batchGapWeeks != null ? ` · 批次间隔约 ${r.batchGapWeeks} 周` : ""}</span>}
        />
      </div>
    </Annotatable>
  )
}

const Insights = ({ p }: { p: Profile }) => {
  const refresh = useRefreshProfile()
  const [more, setMore] = useState(false)
  const items = useMemo(() => [...p.insights].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)), [p.insights])
  const main = items.filter((i) => i.confidence !== "low")
  const low = items.filter((i) => i.confidence === "low")
  const busy = p.state === "generating" || refresh.isPending
  return (
    <section className="pf-sec">
      <header className="pf-h">
        <h4>判断</h4>
        {p.generatedAt && <span className="faint num">{time(p.generatedAt)} · 第 {p.version} 版</span>}
        <span className="spacer" />
        {busy ? <JobProgress state="running" label="生成中" /> : (
          <Button size="xs" variant="ghost" icon="refresh" onClick={() => refresh.mutate(p.enterprise.id)} disabled={p.state === "facts_only"}>
            重新生成
          </Button>
        )}
      </header>
      {p.change && (
        <div className="pf-change">
          <Icon name="sparkle" size="xs" />
          <span>{p.change}</span>
        </div>
      )}
      {p.state === "facts_only" ? (
        <div className="pf-note">累计任务不足 20 个，暂不生成判断</div>
      ) : p.state === "none" ? (
        <div className="pf-note">还没有生成</div>
      ) : p.state === "failed" ? (
        <div className="pf-note bad">上次生成失败</div>
      ) : (
        <>
          {p.state === "stale" && <div className="pf-note warn">数据有明显变化，下次更新时会重新生成</div>}
          <div className="pf-insights">
            {main.map((i) => (
              <InsightCard key={i.id} i={i} />
            ))}
          </div>
          {low.length > 0 && (
            <>
              <button className="pf-more" onClick={() => setMore(!more)}>
                <Icon name={more ? "chevUp" : "chevDown"} size="xs" />
                把握较低的 {low.length} 条
              </button>
              {more && (
                <div className="pf-insights">
                  {low.map((i) => (
                    <InsightCard key={i.id} i={i} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

const InsightCard = ({ i }: { i: ProfileInsight }) => {
  const accent = i.key === "pain" ? "pain" : i.key === "opportunity" ? "opp" : null
  const block = `insight.${i.key}${["pain", "opportunity"].includes(i.key) ? `.${i.id}` : ""}`
  return (
    <Annotatable block={block} label={insightName[i.key]} className={cx("pf-insight", accent)} insightId={i.id}>
      <div className="pi-h">
        <span className="pi-k">{insightName[i.key]}</span>
        <ConfidenceDot c={i.confidence} />
      </div>
      <p className="pi-t" data-quote-block={block} data-insight={i.id}>
        {i.text}
      </p>
      {i.evidence.length > 0 && (
        <div className="pi-ev">
          {i.evidence.slice(0, 3).map((e, k) => (
            <EvidenceChip key={k} e={e} />
          ))}
        </div>
      )}
    </Annotatable>
  )
}

const pickLine = (f: ProfileFacts, scope: Scope): Line => {
  if (scope !== "all") return scope
  const insp = f.scenes.filter((s) => s.line === "inspiration").reduce((a, s) => a + s.tasks, 0)
  const vid = f.scenes.filter((s) => s.line === "video").reduce((a, s) => a + s.tasks, 0)
  return vid > insp ? "video" : "inspiration"
}

const Habits = ({ f, id, scope }: { f: ProfileFacts; id: string; scope: Scope }) => {
  const { meta } = useCtx()
  const line = pickLine(f, scope)
  const cov = meta?.coverage.filter((c) => c.line === line).flatMap((c) => c.days).sort() ?? []
  const q = useDaily(line, meta?.weeks[0] ?? null, cov[cov.length - 1] ?? null, id)
  const days = q.data ?? []
  const insp = line === "inspiration"
  return (
    <section className="pf-sec">
      <header className="pf-h">
        <h4>使用习惯</h4>
        <span className="faint">
          {f.primeHours ? `主要在 ${f.primeHours.from}:00–${f.primeHours.to}:00` : ""}
          {f.primeHours ? " · " : ""}周末占 {pct(f.weekendShare)}
        </span>
      </header>
      <div className="pf-habits">
        <Annotatable block="facts.daily" label="每日使用" className="pf-block pf-pad">
          <div className="pf-k">每日{scope === "all" ? ` · ${insp ? "灵感成款" : "AI视频"}` : ""}</div>
          {q.isLoading ? (
            <div className="skel" style={{ height: 150, borderRadius: 8 }} />
          ) : days.length ? (
            <Heatmap days={days.map((d) => ({ date: d.date, covered: d.covered, value: insp ? d.tasks : d.points, note: d.covered && d.tasks ? `${num(d.tasks)} 任务 · ${compact(d.points)} 点` : undefined }))} format={(n) => (insp ? `${num(n)} 个任务` : `${compact(n)} 点`)} maxCell={16} />
          ) : (
            <div className="faint" style={{ fontSize: 13 }}>没有数据</div>
          )}
        </Annotatable>
        <Annotatable block="facts.hours" label="使用时段" className="pf-block pf-pad">
          <div className="pf-k">星期 × 小时</div>
          <HourHeat grid={f.hours} prime={f.primeHours} compact />
        </Annotatable>
      </div>
    </section>
  )
}

const Doing = ({ f }: { f: ProfileFacts }) => {
  const scenes = f.scenes.slice(0, 8)
  const shift = scenes.filter((s) => Math.abs(s.recentShare - s.share) >= 0.15)
  const dist = (title: string, xs: { key: string; share: number }[]) => (
    <div className="pf-dist">
      <div className="pf-k">{title}</div>
      {xs.slice(0, 3).map((x) => (
        <div key={x.key} className="pf-dist-r">
          <span>{x.key}</span>
          <span className="pf-dist-t">
            <i style={{ width: `${x.share * 100}%` }} />
          </span>
          <span className="num">{pct(x.share)}</span>
        </div>
      ))}
    </div>
  )
  return (
    <section className="pf-sec">
      <header className="pf-h">
        <h4>在做什么</h4>
      </header>
      <Annotatable block="facts.scenes" label="功能版图" className="pf-block pf-pad">
        <div className="pf-k">
          功能版图
          {shift.length > 0 && (
            <span className="pf-shift">
              近 4 周 {shift.map((s) => `${s.scene} ${s.recentShare > s.share ? "↑" : "↓"}${Math.round(Math.abs(s.recentShare - s.share) * 100)}pt`).join("，")}
            </span>
          )}
        </div>
        <Segments items={scenes.map((s, k) => ({ key: s.scene, label: s.scene, value: s.tasks, color: sceneColors[k % sceneColors.length] }))} />
      </Annotatable>
      <div className="pf-two">
        <Annotatable block="facts.intents" label="任务类型" className="pf-block pf-pad">
          <div className="pf-k">任务类型 · 下载率</div>
          <BarList items={f.intents.slice(0, 6).map((i) => ({ key: i.key, label: i.key, value: i.tasks, display: <span className="num">{pct(i.share)}</span>, secondary: <span className={cx("num", i.downloadRate != null && i.downloadRate < 0.35 && "down")}>{pct(i.downloadRate)}</span> }))} />
        </Annotatable>
        <div className="pf-block pf-pad pf-dists">
          {dist("输入图张数", f.inputs.imageCounts.map((x) => ({ key: `${x.count} 张`, share: x.share })))}
          {dist("比例", f.inputs.ratios)}
          {dist("清晰度", f.inputs.resolutions)}
          <div className="pf-dist">
            <div className="pf-k">提示词长度</div>
            <div className="pf-big num">
              {f.inputs.promptLengthMedian}
              <span> 字</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const Models = ({ f }: { f: ProfileFacts }) => (
  <section className="pf-sec">
    <header className="pf-h">
      <h4>用什么模型</h4>
    </header>
    <Annotatable block="facts.models" label="模型" className="pf-block pf-pad">
      <div className="pf-models">
        {f.models.slice(0, 6).map((m) => (
          <div key={m.model} className="pf-model">
            <span className="pm-n ellipsis">{m.model}</span>
            <span className="pm-bar">
              <i style={{ width: `${m.share * 100}%` }} />
            </span>
            <span className="num pm-s">{pct(m.share)}</span>
            <Tooltip content="下载率">
              <span className={cx("num pm-d", m.downloadRate != null && m.downloadRate < 0.35 && "down")}>{pct(m.downloadRate)}</span>
            </Tooltip>
            <span className="faint num pm-f">{m.firstUsedAt.slice(5).replace("-", "/")} 起</span>
          </div>
        ))}
      </div>
    </Annotatable>
  </section>
)

const Quality = ({ f }: { f: ProfileFacts }) => {
  const q = f.quality
  return (
    <section className="pf-sec">
      <header className="pf-h">
        <h4>结果质量</h4>
      </header>
      <Annotatable block="facts.quality" label="结果质量" className="pf-block pf-pad">
        <div className="pf-quality">
          <BigStat label="卡住占比" value={q.stuckShare == null ? "—" : pct(q.stuckShare)} tone={q.stuckShare != null && q.stuckShare >= 0.3 ? "down" : undefined} hint="同一张图重试或只改几个字" />
          <BigStat label="批量占比" value={q.batchShare == null ? "—" : pct(q.batchShare)} hint="同一句提示词换图" />
          <BigStat label="没出图的连续尝试" value={q.unresolvedChains} unit="条" tone={q.unresolvedChains >= 5 ? "down" : undefined} hint="近 4 周，同一张图连续 3 次以上且没有下载" />
          <BigStat label="失败" value={q.failed} unit="次" />
        </div>
        {q.failures.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <BarList items={q.failures.map((x) => ({ key: x.category, label: failureName[x.category], value: x.count, tone: x.category === "material" ? "var(--down-weak)" : undefined, display: <span className="num">{x.count}</span> }))} />
          </div>
        )}
      </Annotatable>
    </section>
  )
}

const Members = ({ f }: { f: ProfileFacts }) => {
  if (!f.members.length) return null
  const max = Math.max(1, ...f.members.map((m) => m.tasks))
  return (
    <section className="pf-sec">
      <header className="pf-h">
        <h4>成员</h4>
        <span className="faint">{f.members.length} 人</span>
      </header>
      <Annotatable block="facts.members" label="成员" className="pf-block">
        <table className="table compact flush">
          <tbody>
            {f.members.map((m) => (
              <tr key={m.id}>
                <td style={{ width: "30%" }}>
                  <span className="row" style={{ gap: 8 }}>
                    <Avatar name={m.name} size={22} />
                    <span className="ellipsis">{m.name}</span>
                  </span>
                </td>
                <td>
                  <Phone value={m.phone} />
                </td>
                <td style={{ width: 160 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="pf-mbar">
                      <i style={{ width: `${(m.tasks / max) * 100}%` }} />
                    </span>
                    <span className="num" style={{ minWidth: 40, textAlign: "right" }}>{num(m.tasks)}</span>
                  </span>
                </td>
                <td className="r num faint">{pct(m.downloadRate)}</td>
                <td className="r faint">{ago(m.lastActiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Annotatable>
    </section>
  )
}
