import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { call, request } from "../../api/client"
import { errorText } from "../../api/next"
import { num, time, weekShort } from "../../lib/format"
import { navigate } from "../../lib/route"
import { Button, IconButton, Input, Segmented, Switch, cx } from "../../ui/controls"
import { Empty, Skel, Thumb } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { Menu, Popover, Tooltip, toast } from "../../ui/overlays"
import { JobProgress } from "../../ui/insight"
import type { CaseBatch, CaseCollection, CaseSampleStrategy, Row } from "./types"
import { caseKey } from "./types"
import { outcomeName, ratingName, sampleLocal, strategyName, thumbOf } from "./model"
import { createBatch, deleteAnalysis, deleteBatch, estimate, startAnalysis, useBatchRows, useBatches, useCollectionRows, useIssues, useLocalPool, type ViewAnalysis } from "./data"
import { CaseList, ListSkeleton, NameModal, type Page } from "./CasesPage"
import type { useCollectionOps } from "./data"

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
            estimate(rows, p.server).then(setEst)
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
            <span className="faint num">{est ? `约 ${num(est.images)} 张图${est.estimated != null ? ` · 约 ${est.currency === "CNY" ? "¥" : "$"}${est.estimated.toFixed(1)}` : ""}` : "估算中"}</span>
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
                  await startAnalysis(p.line, rows, q.trim(), p.server)
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
  const tally = { good: 0, ok: 0, bad: 0 }
  a.perCase.forEach((x) => tally[x.rating]++)
  const unrated = a.rows.filter((r) => !p.L.review(r)?.rating && a.perCase.some((x) => x.id === r.id))
  const adoptAll = () => {
    const groups = new Map<string, Row[]>()
    unrated.forEach((r) => {
      const v = a.perCase.find((x) => x.id === r.id)!
      const k = JSON.stringify([v.rating, v.tags])
      groups.set(k, [...(groups.get(k) ?? []), r])
    })
    groups.forEach((rs, k) => {
      const [rating, tags] = JSON.parse(k)
      p.rate(rs, { rating, addTags: tags })
    })
    toast(`已把 ${unrated.length} 条的 AI 初判写进评价`)
  }
  return (
    <div className="cx-ana-card">
      <div className="cx-ana-h">
        <Icon name="wand" size="sm" />
        <span className="num">{time(a.createdAt)}</span>
        <span className="faint num">{a.items.length} 条</span>
        {a.question && <span className="cx-ana-q ellipsis">“{a.question}”</span>}
        <span className="spacer" />
        {a.state === "done" && a.perCase.length > 0 && (
          <span className="cx-ana-tally num">
            {(["good", "ok", "bad"] as const).map((r) => (
              <span key={r} className={cx("cx-chipr", r)}>
                {ratingName[r]} {tally[r]}
              </span>
            ))}
          </span>
        )}
        {a.state === "done" && unrated.length > 0 && (
          <Tooltip content="只写进还没评价的记录，之后可以逐条改">
            <Button size="xs" variant="soft" onClick={adoptAll}>
              采纳初判 · {unrated.length}
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
                          <Thumb media={r.last.outputs[0] ?? r.first.inputs[0]} w={40} ratio={1} radius={6} />
                        </button>
                      ))}
                      {rs.length > 8 && <span className="faint num">+{rs.length - 8}</span>}
                    </div>
                    <span className="spacer" />
                    {c.tags.map((t) => p.tagMap.get(t)).filter(Boolean).map((t) => (
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
  const batches = useBatches(p.line, p.server)
  const [strategy, setStrategy] = useState<CaseSampleStrategy>("problems")
  const [size, setSize] = useState("20")
  const [per, setPer] = useState("3")
  const [skip, setSkip] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(initial)
  const pool = useLocalPool(p.line, p.week, p.unit, p.server === false)
  const filtered = p.pool ?? pool
  const opened = batches.find((b) => b.id === openId) ?? null
  const rows = useBatchRows(opened, p.server)
  const anyFilter = JSON.stringify(p.filters) !== JSON.stringify({ ...p.filters, q: "", outcome: [], result: [], intent: [], pattern: [], model: [], mode: [], enterprise: [], level: [], movement: [], steps: [], rating: [], tag: [], status: [], collection: null, slow: false, noted: false })
  const per2 = strategy === "per_enterprise" || strategy === "per_intent"
  const go = async () => {
    if (!p.week) return
    setBusy(true)
    try {
      const n = Number(size)
      const { batch, rows } = await createBatch({
        line: p.line,
        week: p.week,
        from: p.week,
        to: weekEnd(p.week),
        unit: p.unit,
        filters: p.filters,
        strategy,
        size: n,
        perGroup: Number(per),
        name: `${weekShort(p.week)} · ${strategyName[strategy]} ${per2 ? `每组 ${per}` : `${n} 条`}`,
        server: p.server,
        pool: filtered,
        L: p.L,
        sample: (xs) => sampleLocal(xs, { strategy, size: n, perGroup: Number(per), seed: Math.floor(Math.random() * 1e9), skipRated: skip }, p.L),
      })
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
  const reviewed = (b: CaseBatch, rs: Row[] | null) => (rs ? rs.filter((r) => p.L.review(r)?.rating).length : b.reviewed)
  return (
    <div className="cx-batches">
      <div className="cx-sampler">
        <div className="cx-sampler-h">
          <b>抽一批来评</b>
          <span className="faint">{anyFilter ? "按「全部」页当前的筛选来抽" : `从 ${p.week ? weekShort(p.week) : ""} 这周的全部记录里抽`}</span>
        </div>
        <div className="cx-sampler-r">
          <Segmented
            value={strategy}
            onChange={setStrategy}
            options={(Object.keys(strategyName) as CaseSampleStrategy[]).map((s) => ({ value: s, label: strategyName[s] }))}
          />
          {per2 ? (
            <Segmented size="sm" value={per} onChange={setPer} options={["1", "3", "5"].map((n) => ({ value: n, label: `每组 ${n}` }))} />
          ) : (
            <Segmented size="sm" value={size} onChange={setSize} options={["10", "20", "40"].map((n) => ({ value: n, label: `${n} 条` }))} />
          )}
          <Switch checked={skip} onChange={setSkip}>
            跳过已评
          </Switch>
          <span className="spacer" />
          <Button variant="primary" icon="sparkle" loading={busy || (p.server === false && !filtered)} onClick={go}>
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
            const rs = b.id === openId ? rows : "rows" in b ? (b as CaseBatch & { rows: Row[] }).rows : null
            const n = reviewed(b, rs)
            return (
              <div key={b.id} className={cx("cx-b", b.id === openId && "on")} onClick={() => setOpenId(b.id === openId ? null : b.id)}>
                <div className="cx-b-th">
                  {(rs ?? []).slice(0, 4).map((r) => (
                    <Thumb key={caseKey(r)} media={r.last.outputs[0] ?? r.first.inputs[0]} w={34} ratio={1} radius={6} />
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
                    const first = rs.findIndex((r) => !p.L.review(r)?.rating)
                    p.open(rs, Math.max(0, first), b.name)
                  }}
                >
                  {n < b.items.length ? "继续评" : "再看"}
                </Button>
                <Menu width={140} trigger={({ toggle, ref }) => <IconButton ref={ref as never} size="sm" icon="more" label="更多" onClick={(e) => (e.stopPropagation(), toggle())} />} items={[{ key: "del", label: "删除这批", icon: "trash", danger: true, onSelect: () => void deleteBatch(b).then(() => qc.invalidateQueries({ queryKey: ["GET /api/cases/batches"] })) }]} />
              </div>
            )
          })}
        </div>
      ) : (
        <Empty icon="sparkle" title="还没有抽过" compact />
      )}
      {opened && (
        <div className="cx-bdetail">
          <div className="cx-sum-h">{opened.name}</div>
          {rows ? <CaseList rows={rows} grid={false} L={p.L} tagMap={p.tagMap} sel={new Map()} focus={-1} toggle={() => {}} onOpen={(i) => p.open(rows, i, opened.name)} rate={p.rate} /> : <ListSkeleton />}
        </div>
      )}
    </div>
  )
}

export const IssuesPanel = ({ p }: { p: Page }) => {
  const { list, loading } = useIssues(p.line, p.week, p.server, p.tags)
  const max = Math.max(1, ...(list ?? []).map((x) => x.cases))
  const pool = p.pool
  const remote = useQuery({ queryKey: ["GET /api/cases", "unrated-bad", p.line, p.week], enabled: p.server === true && !!p.week, queryFn: () => request<{ total: number }>("GET /api/cases", { query: { line: p.line, week: p.week, unit: p.unit, outcome: "bad", rating: "none", limit: 1 } }) })
  const unattributed = pool ? pool.filter((r) => r.outcome === "bad" && !p.L.review(r)?.rating).length : remote.data?.total ?? null
  const follow = async (ent: { id: string; name: string }, label: string) => {
    if (!p.week) return
    try {
      await call("POST /api/followups", { body: { line: p.line, week: p.week, enterprise: ent.id, goal: "help", reason: `记录里反复出现「${label}」` } })
      toast(`已把 ${ent.name} 加入跟进`, { action: { label: "去看", run: () => navigate({ page: "touches" }) } })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  const showTag = (id: string) => {
    p.setFilters({ ...p.filters, tag: [id], rating: [], outcome: [] })
    p.setTab("list")
  }
  return (
    <div className="cx-issues">
      {unattributed != null && unattributed > 0 && (
        <div className="cx-callout">
          <Icon name="flag" size="sm" />
          <span className="grow">
            这周有 <b className="num">{num(unattributed)}</b> 条 bad 还没评
          </span>
          <Button size="sm" variant="soft" onClick={() => (p.setFilters({ ...p.filters, outcome: ["bad"], tag: [], rating: ["none"] }), p.setTab("list"))}>
            去看
          </Button>
          <Button size="sm" variant="primary" onClick={() => p.setTab("batches")}>
            抽一批来评
          </Button>
        </div>
      )}
      {loading ? (
        <div className="cx-issue-grid">
          {[0, 1, 2].map((i) => (
            <Skel key={i} h={200} r={12} />
          ))}
        </div>
      ) : list && list.length ? (
        <div className="cx-issue-grid">
          {list.map((x) => (
            <div key={x.tag.id} className={cx("cx-issue", x.tag.tone)}>
              <div className="cx-issue-h">
                <span className={cx("cx-tag", x.tag.tone)}>{x.tag.group || "标签"}</span>
                <b>{x.tag.label}</b>
                <span className="spacer" />
                <Button size="xs" variant="ghost" iconRight="arrowRight" onClick={() => showTag(x.tag.id)}>
                  全部
                </Button>
              </div>
              <div className="cx-issue-n">
                <b className="num">{x.cases}</b>
                <span className="faint">条 · {x.enterprises} 家企业</span>
                <span className="spacer" />
                <div className="cx-issue-w">
                  {x.weekly.map((w) => (
                    <Tooltip key={w.week} content={`${weekShort(w.week)} · ${w.cases} 条`}>
                      <i style={{ height: `${Math.max(8, (w.cases / Math.max(...x.weekly.map((y) => y.cases))) * 100)}%` }} />
                    </Tooltip>
                  ))}
                </div>
              </div>
              <span className="cx-issue-bar">
                <i style={{ width: `${(x.cases / max) * 100}%` }} />
              </span>
              <div className="cx-issue-s">
                {x.samples.map((s) => {
                  const rs = (x as typeof x & { rows?: Row[] }).rows
                  const i = rs?.findIndex((r) => r.id === s.id && r.unit === s.unit) ?? -1
                  return (
                    <button key={s.id} onClick={() => (rs && i >= 0 ? p.open(rs, i, x.tag.label) : showTag(x.tag.id))}>
                      {s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : <Icon name="image" />}
                    </button>
                  )
                })}
              </div>
              <div className="cx-issue-e">
                {x.topEnterprises.slice(0, 3).map((e) => (
                  <div key={e.enterprise.id} className="cx-issue-er">
                    <button className="n ellipsis" onClick={() => navigate({ ent: e.enterprise.id, tab: "profile" })}>
                      {e.enterprise.name}
                    </button>
                    <span className="faint num">{e.cases}</span>
                    <Tooltip content="加入跟进">
                      <IconButton size="xs" icon="send" label="加入跟进" onClick={() => follow(e.enterprise, x.tag.label)} />
                    </Tooltip>
                  </div>
                ))}
              </div>
              {(x.linked.followups > 0 || x.linked.opportunities > 0 || x.linked.templates > 0) && (
                <div className="cx-issue-l faint num">
                  {[x.linked.followups && `跟进 ${x.linked.followups}`, x.linked.opportunities && `模板机会 ${x.linked.opportunities}`, x.linked.templates && `模板 ${x.linked.templates}`].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="flag" title="还没有问题标签" text="评价时给 bad 贴上标签，这里会按问题汇总" action={<Button size="sm" onClick={() => p.setTab("batches")}>抽一批来评</Button>} />
      )}
    </div>
  )
}

export const CollectionsPanel = ({ p, collections, ops }: { p: Page; collections: CaseCollection[]; ops: ReturnType<typeof useCollectionOps> }) => {
  const [openId, setOpenId] = useState<string | null>(null)
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null)
  const rows = useCollectionRows(openId, p.line, p.week, p.server)
  const opened = collections.find((c) => c.id === openId) ?? null
  useEffect(() => {
    if (openId && !collections.some((c) => c.id === openId)) setOpenId(null)
  }, [collections, openId])
  return (
    <div className="cx-cols">
      <div className="cx-col-grid">
        {collections.map((c) => (
          <ColCard key={c.id} c={c} on={c.id === openId} p={p} onOpen={() => setOpenId(c.id === openId ? null : c.id)} onRename={() => setNaming({ id: c.id, name: c.name })} onDelete={() => void ops.remove(c.id)} />
        ))}
        <button className="cx-col new" onClick={() => setNaming({ id: null, name: "" })}>
          <Icon name="plus" />
          <span>新建收藏夹</span>
        </button>
      </div>
      {opened && (
        <div className="cx-bdetail">
          <div className="cx-sum-h">
            {opened.name}
            <span className="faint num"> · {opened.count} 条</span>
          </div>
          {rows ? rows.length ? <CaseList rows={rows} grid L={p.L} tagMap={p.tagMap} sel={new Map()} focus={-1} toggle={() => {}} onOpen={(i) => p.open(rows, i, opened.name)} rate={p.rate} /> : <Empty icon="book" title="还是空的" text="在查看器里点「收藏」，或在列表里选中后加入" compact /> : <ListSkeleton grid />}
        </div>
      )}
      <NameModal
        open={!!naming}
        title={naming?.id ? "重命名" : "新建收藏夹"}
        initial={naming?.name ?? ""}
        onClose={() => setNaming(null)}
        onSave={async (name) => {
          if (naming?.id) await ops.rename(naming.id, name)
          else await ops.create(name)
          setNaming(null)
        }}
      />
    </div>
  )
}

const ColCard = ({ c, on, p, onOpen, onRename, onDelete }: { c: CaseCollection; on: boolean; p: Page; onOpen: () => void; onRename: () => void; onDelete: () => void }) => {
  const rows = useCollectionRows(c.id, p.line, p.week, p.server)
  return (
    <div className={cx("cx-col", on && "on")} onClick={onOpen}>
      <div className="cx-col-th">
        {[0, 1, 2, 3].map((i) => {
          const r = rows?.[i]
          const t = r ? thumbOf(r) : null
          return <span key={i}>{t && <img src={t} alt="" loading="lazy" />}</span>
        })}
      </div>
      <div className="cx-col-f">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <b className="ellipsis">{c.name}</b>
          <span className="faint num">
            {c.count} 条{rows && rows.length ? ` · ${outcomeName.bad} ${rows.filter((r) => r.outcome === "bad").length}` : ""}
          </span>
        </div>
        <span className="spacer" />
        <Menu
          width={140}
          trigger={({ toggle, ref }) => <IconButton ref={ref as never} size="sm" icon="more" label="更多" onClick={(e) => (e.stopPropagation(), toggle())} />}
          items={[
            { key: "rename", label: "重命名", icon: "edit", onSelect: onRename },
            { key: "del", label: "删除", icon: "trash", danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </div>
  )
}
