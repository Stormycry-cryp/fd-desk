import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { call } from "../../api/client"
import { errorText } from "../../api/next"
import { num, pct, time, weekShort } from "../../lib/format"
import { navigate } from "../../lib/route"
import { Button, Checkbox, IconButton, Input, Segmented, Switch, cx } from "../../ui/controls"
import { Empty, Skel } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { Menu, Popover, Tooltip, toast } from "../../ui/overlays"
import { JobProgress } from "../../ui/insight"
import { TrendChart } from "../../ui/charts"
import type { CaseBatch, CaseFilters, CaseSampleStrategy, CaseTag, Row } from "./types"
import { caseKey, emptyFilters } from "./types"
import { strategyName } from "./model"
import { createBatch, deleteAnalysis, deleteBatch, estimate, exportCases, makeTemplate, startAnalysis, useBatchRows, useBatches, useLibraryStats, type ViewAnalysis } from "./data"
import { Pic } from "./CaseRow"
import type { Page } from "./CasesPage"
import { StickyBar } from "../../ui/stickybar"

const weekEnd = (w: string) => new Date(new Date(`${w}T00:00:00+08:00`).getTime() + 6 * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10)

export const AnalyzeButton = ({ p, rows, onDone, label = "AI 分析", variant = "ghost" }: { p: Page; rows: Row[]; onDone?: () => void; label?: string; variant?: "ghost" | "soft" | "primary" }) => {
  const [est, setEst] = useState<{ cases: number; images: number; estimated: number | null; currency: string } | null>(null)
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const over = rows.length > 40
  return (
    <Popover
      width={320}
      placement="top-start"
      trigger={({ toggle, ref }) => (
        <Button
          ref={ref as never}
          size="sm"
          variant={variant}
          icon="wand"
          onClick={() => {
            toggle()
            setEst(null)
            estimate(rows).then(setEst)
          }}
        >
          {label}
        </Button>
      )}
    >
      {(close) => (
        <div className="cx-ai-pop">
          <div className="cx-ai-h">
            <b>AI 看这 {rows.length} 条</b>
            <span className="faint num">{est ? `约 ${num(est.images)} 张图${est.estimated != null ? ` · 约 ${est.currency === "USD" ? "$" : "¥"}${est.estimated.toFixed(1)}` : ""}` : "估算中"}</span>
          </div>
          {over && <div className="cx-ai-warn">一次最多 40 条，先缩小范围</div>}
          <Input size="sm" placeholder="想重点看什么（可不填）" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button size="sm" variant="ghost" onClick={close}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={over || !rows.length}
              onClick={async () => {
                setBusy(true)
                try {
                  await startAnalysis(p.line, rows, q.trim())
                  qc.invalidateQueries({ queryKey: ["GET /api/cases/analyses"] })
                  toast("已开始分析")
                  close()
                  setQ("")
                  onDone?.()
                } catch (e) {
                  toast(errorText(e, "没能开始分析"), { tone: "error" })
                } finally {
                  setBusy(false)
                }
              }}
            >
              开始
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}

const sevName = { high: "严重", medium: "常见", low: "零星" }

export const AnalysesPanel = ({ p, list }: { p: Page; list: ViewAnalysis[] }) => {
  if (!list.length) return <Empty icon="wand" title="还没有分析" text="在列表里选中几条，点「AI 分析」" action={<Button size="sm" onClick={() => p.setTab("list")}>去选记录</Button>} />
  return (
    <div className="cx-ana">
      {list.map((a) => (
        <AnalysisCard key={a.id} a={a} p={p} />
      ))}
    </div>
  )
}

const AnalysisCard = ({ a, p }: { a: ViewAnalysis; p: Page }) => {
  const qc = useQueryClient()
  const byId = useMemo(() => new Map(a.rows.map((r) => [r.id, r])), [a.rows])
  const running = a.state === "queued" || a.state === "running"
  const todo = a.rows.filter((r) => p.L.processed(r) !== "done" && (a.perCase.find((x) => x.id === r.id)?.tags.length ?? 0) > 0)
  const adoptAll = () => {
    todo.forEach((r) => {
      const v = a.perCase.find((x) => x.id === r.id)!
      v.tags.forEach((id) => {
        const t = p.shared.tagMap.get(id)
        if (t) p.ops.addTags([r], t)
      })
    })
    toast(`已把 ${todo.length} 条的 AI 判断写进标签`)
  }
  const tagCount = new Map<string, number>()
  a.perCase.forEach((x) => x.tags.forEach((t) => tagCount.set(t, (tagCount.get(t) ?? 0) + 1)))
  return (
    <div className="cx-ana-card">
      <div className="cx-ana-h">
        <Icon name="wand" size="sm" />
        <span className="num">{time(a.createdAt)}</span>
        <span className="faint num">{a.items.length} 条</span>
        {a.question && <span className="cx-ana-q ellipsis">“{a.question}”</span>}
        <span className="spacer" />
        {a.state === "done" &&
          [...tagCount]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .map(([id, n]) => (
              <span key={id} className={cx("cx-tag", p.shared.tagMap.get(id)?.tone)}>
                {p.shared.tagMap.get(id)?.label ?? id} {n}
              </span>
            ))}
        {a.state === "done" && todo.length > 0 && (
          <Tooltip content="只写进还没处理的记录">
            <Button size="xs" variant="soft" onClick={adoptAll}>
              采纳 · {todo.length}
            </Button>
          </Tooltip>
        )}
        <IconButton size="xs" icon="trash" label="删除" onClick={async () => (await deleteAnalysis(a), qc.invalidateQueries({ queryKey: ["GET /api/cases/analyses"] }))} />
      </div>
      {running ? (
        <JobProgress state={a.state} label="模型正在看这些记录" />
      ) : a.state === "failed" ? (
        <div className="mv-fail">
          <Icon name="alert" size="xs" />
          {a.error?.message ?? "分析失败"}
        </div>
      ) : (
        <>
          {a.headline && <div className="cx-ana-head">{a.headline}</div>}
          <div className="cx-clusters">
            {a.clusters.map((c, i) => {
              const rs = c.caseIds.map((id) => byId.get(id)).filter((r): r is Row => !!r)
              return (
                <div key={i} className={cx("cx-cl", c.severity)}>
                  <div className="cx-cl-h">
                    <span className={cx("cx-sev", c.severity)}>{sevName[c.severity]}</span>
                    <b>{c.title}</b>
                  </div>
                  {c.summary && <p>{c.summary}</p>}
                  <div className="cx-cl-f">
                    <div className="cx-cl-th">
                      {rs.slice(0, 8).map((r, j) => (
                        <button key={r.id} onClick={() => p.open(rs, j, c.title.slice(0, 14))}>
                          <Pic m={r.last.outputs[0] ?? r.first.inputs[0]} />
                        </button>
                      ))}
                      {rs.length > 8 && <span className="faint num">+{rs.length - 8}</span>}
                    </div>
                    <span className="spacer" />
                    {c.tags.map((t) => p.shared.tagMap.get(t)).filter(Boolean).map((t) => (
                      <span key={t!.id} className={cx("cx-tag", t!.tone)}>
                        {t!.label}
                      </span>
                    ))}
                    <span className="faint num">
                      {c.caseIds.length} 条 · {c.enterprises.length} 家
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          {a.suggestions.length > 0 && (
            <div className="cx-sugs">
              {a.suggestions.map((s, i) => (
                <div key={i} className="mv-action">
                  <Icon name="target" size="xs" />
                  <span className="grow">{s}</span>
                </div>
              ))}
            </div>
          )}
          {a.rows.length > 0 && (
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="ghost" icon="eye" onClick={() => p.open(a.rows, 0, "这次分析")}>
                逐个看这 {a.rows.length} 条
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export const BatchesPanel = ({ p, initial }: { p: Page; initial: string | null }) => {
  const qc = useQueryClient()
  const batches = useBatches(p.line, p.ready)
  const [strategy, setStrategy] = useState<CaseSampleStrategy>("problems")
  const [size, setSize] = useState("20")
  const [per, setPer] = useState("3")
  const [skip, setSkip] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(initial)
  const rows = useBatchRows(openId)
  const opened = batches.find((b) => b.id === openId) ?? null
  const anyFilter = JSON.stringify(p.filters) !== JSON.stringify(emptyFilters)
  const per2 = strategy === "per_enterprise" || strategy === "per_intent"
  const go = async () => {
    if (!p.week) return
    setBusy(true)
    try {
      const n = Number(size)
      const { batch, rows } = await createBatch({ line: p.line, from: p.week, to: weekEnd(p.week), unit: p.unit, filters: p.filters, legacy: p.legacy, strategy, size: n, perGroup: Number(per), name: `${weekShort(p.week)} · ${strategyName[strategy]} ${per2 ? `每组 ${per}` : `${n} 条`}`, skip })
      qc.invalidateQueries({ queryKey: ["GET /api/cases/batches"] })
      if (!rows.length) return toast("这个范围抽不出记录", { tone: "error" })
      setOpenId(batch.id)
      p.open(rows, 0, batch.name)
    } catch (e) {
      toast(errorText(e, "抽样失败"), { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cx-batches">
      <div className="cx-sampler">
        <div className="cx-sampler-h">
          <b>抽一批来看</b>
          <span className="faint">{anyFilter ? "按「全部」页当前的筛选来抽" : `从 ${p.week ? weekShort(p.week) : ""} 这周的全部记录里抽`}</span>
        </div>
        <div className="cx-sampler-r">
          <Segmented value={strategy} onChange={setStrategy} options={(Object.keys(strategyName) as CaseSampleStrategy[]).map((s) => ({ value: s, label: strategyName[s] }))} />
          {per2 ? <Segmented size="sm" value={per} onChange={setPer} options={["1", "3", "5"].map((n) => ({ value: n, label: `每组 ${n}` }))} /> : <Segmented size="sm" value={size} onChange={setSize} options={["10", "20", "40"].map((n) => ({ value: n, label: `${n} 条` }))} />}
          <Switch checked={skip} onChange={setSkip}>
            跳过已处理
          </Switch>
          <span className="spacer" />
          <Button variant="primary" icon="sparkle" loading={busy} onClick={go}>
            抽样并开始
          </Button>
        </div>
        <div className="cx-sampler-hint faint">
          {
            {
              stratified: "bad、磨合、good 按 5:3:2 抽，各种意图都覆盖到，单家企业不超过四分之一",
              problems: "只抽 bad 和磨合，优先抽耗时异常、改了 3 次以上、失败或被删除的",
              per_enterprise: "bad 最多的企业排前面，每家抽几条",
              per_intent: "每种意图抽几条，bad 优先",
            }[strategy]
          }
        </div>
      </div>
      {batches.length ? (
        <div className="cx-blist">
          {batches.map((b) => {
            const rs = b.id === openId ? rows : null
            const n = rs ? rs.filter((r) => p.L.processed(r) === "done").length : b.processed ?? b.reviewed ?? 0
            return (
              <div key={b.id} className={cx("cx-b", b.id === openId && "on")} onClick={() => setOpenId(b.id === openId ? null : b.id)}>
                <div className="cx-b-th">
                  {(rs ?? []).slice(0, 4).map((r) => (
                    <Pic key={caseKey(r)} m={r.last.outputs[0] ?? r.first.inputs[0]} peek={false} />
                  ))}
                </div>
                <div className="cx-b-m">
                  <b className="ellipsis">{b.name}</b>
                  <span className="faint num">{time(b.createdAt)}</span>
                </div>
                <div className="cx-b-p">
                  <span className="track">
                    <i style={{ width: `${(n / Math.max(1, b.items.length)) * 100}%` }} />
                  </span>
                  <span className="num">
                    {n}/{b.items.length}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={n < b.items.length ? "soft" : "ghost"}
                  icon="eye"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!rs) return setOpenId(b.id)
                    const first = rs.findIndex((r) => p.L.processed(r) !== "done")
                    p.open(rs, Math.max(0, first), b.name)
                  }}
                >
                  {n < b.items.length ? "继续" : "再看"}
                </Button>
                <Menu width={140} trigger={({ toggle, ref }) => <IconButton ref={ref as never} size="sm" icon="more" label="更多" onClick={(e) => (e.stopPropagation(), toggle())} />} items={[{ key: "del", label: "删除这批", icon: "trash", danger: true, onSelect: () => void deleteBatch(b as CaseBatch).then(() => qc.invalidateQueries({ queryKey: ["GET /api/cases/batches"] })) }]} />
              </div>
            )
          })}
        </div>
      ) : (
        <Empty icon="sparkle" title="还没有抽过" compact />
      )}
      {opened && rows && (
        <div className="cx-bdetail">
          <div className="cx-sum-h">{opened.name}</div>
          <MiniGrid rows={rows} p={p} title={opened.name} />
        </div>
      )}
    </div>
  )
}

const MiniGrid = ({ rows, p, title }: { rows: Row[]; p: Page; title: string }) => (
  <div className="rv-mini">
    {rows.map((r, i) => {
      const eff = p.L.review(r)?.effectiveTags ?? []
      return (
        <button key={caseKey(r)} className={cx("rv-mini-i", r.outcome, eff.length > 0 && "done")} onClick={() => p.open(rows, i, title)}>
          <Pic m={r.last.outputs[0] ?? r.first.inputs[0]} peek={false} />
          <span className="rv-mini-b">
            <span className="ellipsis">{r.enterprise.name}</span>
            {eff.length > 0 ? <span className="rv-mini-t ellipsis">{eff.map((id) => p.shared.tagMap.get(id)?.label).filter(Boolean).join("、")}</span> : <span className="faint">没看</span>}
          </span>
        </button>
      )
    })}
  </div>
)

export const LibraryStatsView = ({ p, filters, setFilters }: { p: Page; filters: CaseFilters; setFilters: (f: CaseFilters) => void }) => {
  const { stats, loading } = useLibraryStats(p.line, p.unit, filters, p.legacy, p.ready, p.tags.filter((t) => !t.id.startsWith("pending:")), p.L, p.week)
  const [follow, setFollow] = useState<string | null>(null)
  if (loading || !stats)
    return (
      <div className="lib">
        <div className="lib-big">
          {[0, 1, 2, 3].map((i) => (
            <Skel key={i} h={78} r={12} />
          ))}
        </div>
        <div className="lib-grid">
          <Skel h={260} r={12} />
          <Skel h={260} r={12} />
        </div>
      </div>
    )
  if (!stats.processed) return null
  const pickTag = (id: string) => setFilters({ ...filters, tag: filters.tag.length === 1 && filters.tag[0] === id ? [] : [id] })
  const pickEnt = (id: string) => setFilters({ ...filters, enterprise: filters.enterprise.length === 1 && filters.enterprise[0] === id ? [] : [id] })
  const max = Math.max(1, ...stats.tags.map((t) => t.cases))
  const top = stats.tags.slice(0, 10)
  const cellMax = Math.max(1, ...stats.matrix.values())
  const ents = new Set(stats.tags.flatMap((t) => t.top.map((e) => e.enterprise.id)))
  const addFollow = async (ent: { id: string; name: string }, label: string) => {
    if (!p.week) return
    setFollow(ent.id)
    try {
      await call("POST /api/followups", { body: { line: p.line, week: p.week, enterprise: ent.id, goal: "help", reason: `案例集里反复出现「${label}」` } })
      toast(`已把 ${ent.name} 加入跟进`, { action: { label: "去看", run: () => navigate({ page: "touches" }) } })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setFollow(null)
    }
  }
  return (
    <div className="lib">
      <div className="lib-big">
        <div className="lib-n">
          <span className="k">已处理</span>
          <b className="num">{num(stats.processed)}</b>
          <span className="faint num">这周 +{num(stats.thisWeek)}</span>
        </div>
        <div className="lib-n">
          <span className="k">问题最多</span>
          <b className="ellipsis">{stats.tags.find((t) => t.tag.tone === "bad")?.tag.label ?? "—"}</b>
          <span className="faint num">{stats.tags.find((t) => t.tag.tone === "bad")?.cases ?? 0} 条</span>
        </div>
        <div className="lib-n">
          <span className="k">误判率</span>
          <b className="num">{stats.falseAlarm.rate == null ? "—" : pct(stats.falseAlarm.rate, 1)}</b>
          <span className="faint num">{stats.falseAlarm.cases} 条判 bad 其实没问题</span>
        </div>
        <div className="lib-n">
          <span className="k">涉及企业</span>
          <b className="num">{num(ents.size)}</b>
          <span className="faint num">bad {stats.outcomes.bad} · 磨合 {stats.outcomes.grind}</span>
        </div>
      </div>
      <div className="lib-grid">
        <div className="lib-card">
          <div className="lib-h">问题排行</div>
          <div className="lib-rank">
            {top.map((t) => (
              <button key={t.tag.id} className={cx("lib-r", filters.tag.includes(t.tag.id) && "on")} onClick={() => pickTag(t.tag.id)}>
                <span className={cx("dot", t.tag.tone)} />
                <span className="n ellipsis">{t.tag.label}</span>
                <span className="bar">
                  <i className={t.tag.tone} style={{ width: `${(t.cases / max) * 100}%` }} />
                </span>
                <b className="num">{t.cases}</b>
                <span className="faint num">{t.enterprises} 家</span>
              </button>
            ))}
          </div>
        </div>
        <div className="lib-card">
          <div className="lib-h">每周处理</div>
          {stats.weeks.length > 1 ? (
            <TrendChart kind="bar" height={150} points={stats.weeks.map((w) => ({ label: weekShort(w.week), value: w.processed, note: w.falseAlarm ? `其中其实没问题 ${w.falseAlarm}` : undefined }))} />
          ) : (
            <div className="lib-one num">
              <b>{stats.weeks[0]?.processed ?? 0}</b>
              <span className="faint">{stats.weeks[0] ? weekShort(stats.weeks[0].week) : ""} 这周</span>
            </div>
          )}
          <div className="lib-h" style={{ marginTop: 14 }}>
            问题集中的企业
          </div>
          <div className="lib-ents">
            {stats.enterprises.slice(0, 5).map((e) => (
              <div key={e.enterprise.id} className={cx("lib-e", filters.enterprise.includes(e.enterprise.id) && "on")}>
                <button className="n ellipsis" onClick={() => pickEnt(e.enterprise.id)}>
                  {e.enterprise.name}
                </button>
                <span className="t ellipsis">{e.tags.map((x) => p.shared.tagMap.get(x.tag)?.label).filter(Boolean).join("、")}</span>
                <b className="num">{e.cases}</b>
                <Tooltip content="加入跟进">
                  <IconButton size="xs" icon="send" label="加入跟进" disabled={follow === e.enterprise.id} onClick={() => addFollow(e.enterprise, p.shared.tagMap.get(e.tags[0]?.tag ?? "")?.label ?? "问题")} />
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      </div>
      {stats.intents.length > 1 && top.length > 1 && (
        <div className="lib-card">
          <div className="lib-h">问题 × {p.line === "video" ? "模式" : "意图"}</div>
          <div className="lib-mx" style={{ gridTemplateColumns: `160px repeat(${stats.intents.length}, minmax(56px, 1fr))` }}>
            <span />
            {stats.intents.map((k) => (
              <span key={k} className="lib-mx-h ellipsis">
                {k}
              </span>
            ))}
            {top.slice(0, 8).map((t) => (
              <MatrixRow key={t.tag.id} tag={t.tag} intents={stats.intents} matrix={stats.matrix} max={cellMax} on={(intent) => setFilters({ ...filters, tag: [t.tag.id], intent: [intent] })} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const MatrixRow = ({ tag, intents, matrix, max, on }: { tag: CaseTag; intents: string[]; matrix: Map<string, number>; max: number; on: (intent: string) => void }) => (
  <>
    <span className="lib-mx-r ellipsis">{tag.label}</span>
    {intents.map((k) => {
      const v = matrix.get(`${tag.id}|${k}`) ?? 0
      return (
        <button key={k} className={cx("lib-mx-c", tag.tone, !v && "z")} style={{ "--a": v ? 0.12 + (v / max) * 0.78 : 0 } as React.CSSProperties} onClick={() => v && on(k)}>
          {v || ""}
        </button>
      )
    })}
  </>
)

export const PoolPanel = ({ p }: { p: Page }) => {
  const rows = p.pool.rows.filter((r) => r.unit === p.unit || true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const picked = rows.filter((r) => sel.has(caseKey(r)))
  const ents = new Set(picked.map((r) => r.enterprise.id))
  const toggle = (r: Row) =>
    setSel((s) => {
      const n = new Set(s)
      const k = caseKey(r)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })
  const make = (kind: "official" | "custom") => makeTemplate({ line: p.line, rows: picked, kind, target: kind === "custom" ? picked[0]?.enterprise.id ?? null : null, remote: p.pool.remote, onStart: () => setBusy(true), onDone: () => (setBusy(false), setSel(new Set())) })
  if (p.pool.loading)
    return (
      <div className="pool-grid">
        {[0, 1, 2, 3].map((i) => (
          <Skel key={i} h={380} r={14} />
        ))}
      </div>
    )
  if (!rows.length) return <Empty icon="template" title="还没有可做模板的记录" text="看记录时按 P，或点卡片上的「可做模板」" action={<Button size="sm" onClick={() => p.setTab("list")}>去看记录</Button>} />
  const made = rows.filter((r) => r.pool?.templateId).length
  return (
    <div className="pool">
      <StickyBar className="cx-bar">
        <Checkbox checked={picked.length === rows.length} mixed={picked.length > 0 && picked.length < rows.length} onChange={(on) => setSel(on ? new Set(rows.map(caseKey)) : new Set())} />
        <span className="faint num">
          {rows.length} 条{made ? ` · 已生成 ${made}` : ""}
          {picked.length ? ` · 已选 ${picked.length}` : ""}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon="download" onClick={() => exportCases({ line: p.line, week: p.week, unit: p.unit, rows: picked.length ? picked : rows, filters: emptyFilters, legacy: p.legacy, scope: "pool", tags: p.tags })}>
          导出
        </Button>
        {picked.length > 0 && (
          <Button size="sm" variant="ghost" icon="x" onClick={() => (p.poolOps.toggle(picked, false), setSel(new Set()))}>
            移出
          </Button>
        )}
        <Popover
          width={280}
          placement="bottom-end"
          trigger={({ toggle: t, ref }) => (
            <Button ref={ref as never} size="sm" variant="primary" icon="sparkle" loading={busy} disabled={!picked.length} onClick={t}>
              生成模板{picked.length ? ` · ${picked.length}` : ""}
            </Button>
          )}
        >
          {(close) => (
            <div className="pool-make">
              <button onClick={() => (close(), make("official"))}>
                <b>官方模板</b>
                <span className="faint">所有客户都能用</span>
              </button>
              <button disabled={ents.size !== 1} onClick={() => (close(), make("custom"))}>
                <b>定制模板</b>
                <span className="faint">{ents.size === 1 ? `给 ${picked[0].enterprise.name}` : "选同一家企业的记录才能定制"}</span>
              </button>
            </div>
          )}
        </Popover>
      </StickyBar>
      <div className="pool-grid">
        {rows.map((r, i) => (
          <PoolCard key={caseKey(r)} r={r} p={p} on={sel.has(caseKey(r))} onToggle={() => toggle(r)} onOpen={() => p.open(rows, i, "可做模板")} />
        ))}
      </div>
    </div>
  )
}

const PoolCard = ({ r, p, on, onToggle, onOpen }: { r: Row; p: Page; on: boolean; onToggle: () => void; onOpen: () => void }) => {
  const [note, setNote] = useState(r.pool?.note ?? "")
  const eff = p.L.review(r)?.effectiveTags ?? []
  return (
    <div className={cx("pool-card", on && "on")} onClick={onToggle}>
      <div className="pool-m" onClick={(e) => (e.stopPropagation(), onOpen())}>
        <Pic m={r.last.outputs[0] ?? r.first.inputs[0]} peek={false} />
        <span className="pool-ins">
          {r.first.inputs.slice(0, 3).map((m, i) => (
            <Pic key={i} m={m} />
          ))}
        </span>
        <span className="pool-ck" onClick={(e) => (e.stopPropagation(), onToggle())}>
          <Checkbox checked={on} onChange={onToggle} />
        </span>
        {r.pool?.templateId && (
          <button className="pool-made" onClick={(e) => (e.stopPropagation(), navigate({ page: "templates", tpl: r.pool!.templateId, pane: "drafts" }))}>
            <Icon name="check" size="xs" />
            已生成模板
          </button>
        )}
      </div>
      <div className="pool-b">
        <div className="pool-e ellipsis">
          {r.enterprise.name}
          {r.intent && <span className="faint"> · {r.intent}</span>}
        </div>
        <div className="pool-p">{r.last.prompt || r.first.prompt || "—"}</div>
        {eff.length > 0 && (
          <div className="pool-t">
            {eff.slice(0, 3).map((id) => {
              const t = p.shared.tagMap.get(id)
              return t ? (
                <span key={id} className={cx("cx-tag", t.tone)}>
                  {t.label}
                </span>
              ) : null
            })}
          </div>
        )}
        <input
          className="pool-note"
          value={note}
          placeholder="为什么适合做模板"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          onBlur={() => note !== (r.pool?.note ?? "") && p.poolOps.note(r, note.trim() || null)}
        />
      </div>
    </div>
  )
}
