import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Line, MovementAnalysis, Profile, ProfileFacts, Scope } from "@spec/contract"
import { call } from "../../api/client"
import { useMovements } from "../../api/next"
import { useCtx, isoWeek } from "../../lib/ctx"
import { lineName } from "../../lib/labels"
import { navigate } from "../../lib/route"
import { ago, num, pct, time, weekLabel, weekShort } from "../../lib/format"
import { Button, Checkbox } from "../../ui/controls"
import { ErrorState, Skel, Thumb } from "../../ui/display"
import { TrendChart } from "../../ui/charts"
import { ConfidenceDot, HourHeat, tagDimName } from "../../ui/insight"
import { Toaster } from "../../ui/overlays"
import { insightName, rhythmName } from "../enterprise/Profile"
import { kindName as annKindName } from "../../ui/annotate"

const Bar = ({ children, back }: { children?: React.ReactNode; back: () => void }) => (
  <div className="report-bar no-print">
    <Button size="sm" variant="ghost" icon="chevLeft" onClick={back}>
      返回
    </Button>
    <span className="spacer" />
    {children}
    <Button size="sm" variant="primary" icon="printer" onClick={() => window.print()}>
      打印
    </Button>
  </div>
)

const back = () => (history.length > 1 ? history.back() : navigate({ page: "customers" }))

export const PrintPage = () => {
  const { route } = useCtx()
  useEffect(() => {
    document.title = route.tpl === "movements" ? "涨跌原因 · 打印" : "客户档案 · 打印"
  }, [route.tpl])
  return (
    <>
      {route.tpl === "movements" ? <PrintMovements /> : <PrintProfiles ids={route.ids} />}
      <Toaster />
    </>
  )
}

const PrintProfiles = ({ ids }: { ids: string[] }) => {
  const [images, setImages] = useState(false)
  const [notes, setNotes] = useState(true)
  const q = useQuery({ queryKey: ["GET /api/profiles", ids.join()], queryFn: () => call("GET /api/profiles", { query: { ids: ids.join(",") } }), enabled: ids.length > 0 })
  return (
    <>
      <Bar back={back}>
        <Checkbox checked={notes} onChange={setNotes}>
          包含批注
        </Checkbox>
        <Checkbox checked={images} onChange={setImages}>
          包含客户图片
        </Checkbox>
        <span className="faint" style={{ fontSize: 13 }}>{ids.length} 家</span>
      </Bar>
      <div className="print-doc">
        {!ids.length ? (
          <div className="faint">在客户列表勾选企业后打印</div>
        ) : q.isLoading ? (
          <Skel h={800} />
        ) : q.error || !q.data ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : (
          q.data.map((p) => <ProfileSheet key={p.enterprise.id} p={p} images={images} notes={notes} />)
        )}
      </div>
    </>
  )
}

const pickScope = (p: Profile): Scope => (p.facts.all ? "all" : p.facts.inspiration ? "inspiration" : "video")

const ProfileSheet = ({ p, images, notes }: { p: Profile; images: boolean; notes: boolean }) => {
  const f = p.facts[pickScope(p)] as ProfileFacts | null
  const w = f ? f.weekly.filter((_, i, a) => i >= a.findIndex((y) => y.tasks > 0)) : []
  const anns = p.annotations.filter((a) => !a.resolved).slice(0, 8)
  const insights = p.insights.filter((i) => i.confidence !== "low")
  return (
    <section className="sheet">
      <header className="sh-h">
        <div>
          <h1>{p.enterprise.name}</h1>
          {p.headline && <p className="sh-lead">{p.headline.text}</p>}
        </div>
        <div className="sh-meta num">
          <span>{p.generatedAt ? `档案 ${time(p.generatedAt)} · 第 ${p.version} 版` : "仅统计"}</span>
          <span>打印于 {time(new Date().toISOString())}</span>
        </div>
      </header>
      {p.tags.length > 0 && (
        <div className="sh-tags">
          {p.tags.map((t) => (
            <span key={t.dimension}>
              <i>{tagDimName[t.dimension]}</i>
              {t.value}
            </span>
          ))}
        </div>
      )}
      {f && (
        <>
          <div className="sh-kpi">
            <div>
              <span>近 4 周任务</span>
              <b className="num">{num(f.totals.recentTasks)}</b>
              <em className="num">累计 {num(f.totals.tasks)}</em>
            </div>
            <div>
              <span>下载率</span>
              <b className="num">{pct(f.totals.recentDownloadRate, 0)}</b>
              <em className="num">累计 {pct(f.totals.downloadRate, 0)}</em>
            </div>
            <div>
              <span>稳定周数</span>
              <b className="num">
                {f.totals.stableWeeks}
                <small>/ {f.totals.activeWeeks} 周</small>
              </b>
              <em className="num">首次 {weekShort(f.totals.firstSeenAt)}</em>
            </div>
            <div>
              <span>使用节奏</span>
              <b>{rhythmName[f.rhythm.kind]}</b>
              <em>{f.rhythm.currentGapWeeks > 0 ? `已 ${f.rhythm.currentGapWeeks} 周没用` : `最近 ${ago(f.totals.lastActiveAt)}`}</em>
            </div>
          </div>
          <div className="sh-row">
            <div className="sh-box">
              <div className="sh-k">每周任务</div>
              <TrendChart kind="bar" height={150} points={w.map((x) => ({ label: weekShort(x.week), value: x.tasks, partial: !x.complete }))} highlight={w.length - 1} format={num} />
            </div>
            <div className="sh-box">
              <div className="sh-k">使用时段{f.primeHours ? ` · 主要 ${f.primeHours.from}–${f.primeHours.to} 点` : ""}</div>
              <HourHeat grid={f.hours} prime={f.primeHours} compact />
            </div>
          </div>
        </>
      )}
      {insights.length > 0 && (
        <div className="sh-ins">
          {insights.map((i) => (
            <div key={i.id} className="sh-in">
              <span className="sh-ik">
                <ConfidenceDot c={i.confidence} />
                {insightName[i.key]}
              </span>
              <span>{i.text}</span>
            </div>
          ))}
        </div>
      )}
      {f && (
        <div className="sh-row three">
          <div className="sh-box">
            <div className="sh-k">任务类型</div>
            {f.intents.slice(0, 6).map((x) => (
              <div key={x.key} className="sh-li">
                <span className="ellipsis">{x.key}</span>
                <span className="num">{pct(x.share, 0)}</span>
                <span className="num faint">下载 {pct(x.downloadRate, 0)}</span>
              </div>
            ))}
          </div>
          <div className="sh-box">
            <div className="sh-k">模型</div>
            {f.models.slice(0, 6).map((x) => (
              <div key={x.model} className="sh-li">
                <span className="ellipsis">{x.model}</span>
                <span className="num">{pct(x.share, 0)}</span>
                <span className="num faint">下载 {pct(x.downloadRate, 0)}</span>
              </div>
            ))}
          </div>
          <div className="sh-box">
            <div className="sh-k">成员</div>
            {f.members.slice(0, 6).map((x) => (
              <div key={x.id} className="sh-li">
                <span className="ellipsis">{x.name}</span>
                <span className="num">{num(x.tasks)}</span>
                <span className="num faint">下载 {pct(x.downloadRate, 0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {p.movements.filter((m) => m.state === "done").slice(0, 2).map((m) => (
        <div key={m.id} className="sh-mv">
          <b>{m.direction === "down" ? "下跌" : "上涨"}原因 · {weekShort(m.week)} 周 · {num(m.change.previous)} → {num(m.change.current)}</b>
          <span>{m.headline}</span>
          {m.action && <em>{m.action}</em>}
        </div>
      ))}
      {images && p.samples.length > 0 && (
        <div className="sh-imgs">
          {p.samples.slice(0, 8).map((t) => (
            <Thumb key={t.rowKey} media={t.outputs[0] ?? t.inputs[0]} w="100%" ratio={1} radius={6} />
          ))}
        </div>
      )}
      {notes && anns.length > 0 && (
        <div className="sh-notes">
          <div className="sh-k">批注</div>
          {anns.map((a) => (
            <div key={a.id} className="sh-note">
              <span className="num faint">{time(a.updatedAt).split(" ")[0]}</span>
              {a.kind && <i>{annKindName[a.kind]}</i>}
              <span>{a.entries.map((e) => e.text).join(" / ")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

const PrintMovements = () => {
  const { week } = useCtx()
  return (
    <>
      <Bar back={() => (history.length > 1 ? history.back() : navigate({ page: "week" }))} />
      <div className="print-doc">
        {week ? (["inspiration", "video"] as Line[]).map((l) => <MovementSheet key={l} line={l} week={week} />) : null}
      </div>
    </>
  )
}

const MovementSheet = ({ line, week }: { line: Line; week: string }) => {
  const q = useMovements(line, week)
  const list = useMemo(() => (q.data ?? []).filter((m) => m.state === "done").sort((a, b) => (a.direction === b.direction ? Math.abs(b.change.current - b.change.previous) - Math.abs(a.change.current - a.change.previous) : a.direction === "down" ? -1 : 1)), [q.data])
  return (
    <section className="sheet">
      <header className="sh-h">
        <div>
          <h1>{lineName[line]} · 涨跌原因</h1>
          <p className="sh-lead num">
            第 {isoWeek(week)} 周 · {weekLabel(week)}
          </p>
        </div>
        <div className="sh-meta num">
          <span>{list.length} 家</span>
        </div>
      </header>
      {q.isLoading ? <Skel h={400} /> : list.length ? <div className="sh-mvs">{list.map((m) => <MvItem key={m.id} m={m} />)}</div> : <div className="faint">这周没有分析过的企业</div>}
    </section>
  )
}

const MvItem = ({ m }: { m: MovementAnalysis }) => (
  <div className={`sh-mvi ${m.direction}`}>
    <div className="sh-mvh">
      <b>{m.enterprise.name}</b>
      <span className="num">
        {num(m.change.previous)} → {num(m.change.current)}
      </span>
      <ConfidenceDot c={m.confidence} />
    </div>
    <div className="sh-mvt">{m.headline}</div>
    <ol>
      {m.reasons.map((r, i) => (
        <li key={i}>
          {r.text}
          {r.evidence.value && <span className="faint num"> · {r.evidence.label} {r.evidence.value}</span>}
        </li>
      ))}
    </ol>
    {m.action && <em>{m.action}</em>}
  </div>
)
