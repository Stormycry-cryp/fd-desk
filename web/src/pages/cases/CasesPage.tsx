import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Line } from "@spec/contract"
import { useCtx } from "../../lib/ctx"
import { levelName, levelOrder, lineName, movementName, patternName } from "../../lib/labels"
import { num, pct, weekLabel } from "../../lib/format"
import { navigate } from "../../lib/route"
import { useKey } from "../../lib/useKey"
import { Button, Checkbox, IconButton, Input, Segmented, Tabs, cx } from "../../ui/controls"
import { Empty, ErrorState, Skel } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { FilterChip, Menu, Modal, Tooltip, toast } from "../../ui/overlays"
import type { CaseAnalysis, CaseFilters, CaseOutcome, CaseRating, CaseSort, CaseSummary, CaseTag, CaseUnit, Row } from "./types"
import { caseKey, emptyFilters } from "./types"
import { outcomeLong, outcomeName, outcomeOrder, ratingName, ratingOrder, resultName, sortName, statusName, stepsBuckets, type Lookup } from "./model"
import { exportCases, stepReview, useAddTag, useAllAnnotations, useAnalyses, useCaseDetail, useCaseList, useCaseTags, useCollectionOps, useCollections, useLookup, useReview, useServer, useStepReview, useSyncLocal } from "./data"
import { CaseCard, CaseLine } from "./CaseRow"
import { CaseViewer, type ViewerCtx } from "./CaseViewer"
import { AnalysesPanel, AnalyzeButton, BatchesPanel, CollectionsPanel, IssuesPanel } from "./Panels"

type Tab = "list" | "issues" | "batches" | "analyses" | "collections"

export interface Page {
  line: Line
  week: string | null
  server: boolean | null
  L: Lookup
  tags: CaseTag[]
  tagMap: Map<string, CaseTag>
  open: (rows: Row[], i: number, title?: string) => void
  rate: (rows: Row[], p: Parameters<ReturnType<typeof useReview>>[1]) => void
  filters: CaseFilters
  setFilters: (f: CaseFilters) => void
  setTab: (t: Tab) => void
  unit: CaseUnit
  pool: Row[] | null
  anns: ReturnType<typeof useAllAnnotations>["data"]
}

export const CasesPage = () => {
  const { route, line, week } = useCtx()
  return <CasesBody key={line} line={line} week={week} init={route} />
}

const CasesBody = ({ line, week, init }: { line: Line; week: string | null; init: ReturnType<typeof useCtx>["route"] }) => {
  const { server } = useServer(line, week)
  useSyncLocal(server, line)
  const annsQ = useAllAnnotations()
  const anns = annsQ.data ?? []
  const L = useLookup(server, annsQ.data)
  const tags = useCaseTags(line, server)
  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const addTag = useAddTag(line, server)
  const review = useReview(server)
  const reviewStep = useStepReview(server)
  const collections = useCollections(line, server)
  const colOps = useCollectionOps(line, server)
  const analyses = useAnalyses(line, server)
  const ai = useMemo(() => {
    const m = new Map<string, CaseAnalysis["perCase"][number]>()
    ;[...analyses].reverse().filter((a) => a.state === "done").forEach((a) => a.perCase.forEach((p) => m.set(p.id, p)))
    return m
  }, [analyses])
  const [tab, setTab] = useState<Tab>(init.batch ? "batches" : "list")
  const [unit, setUnit] = useState<CaseUnit>(init.unit ?? (line === "video" ? "task" : "chain"))
  const [sort, setSort] = useState<CaseSort>("bad_first")
  const [f, setF] = useState<CaseFilters>({ ...emptyFilters, enterprise: init.ents, outcome: init.outcome as CaseOutcome[], level: init.level, movement: init.movement, intent: init.intent, model: init.models, q: init.q })
  const [grid, setGrid] = useState(false)
  const [more, setMore] = useState(false)
  const [sel, setSel] = useState<Map<string, Row>>(new Map())
  const [focus, setFocus] = useState(-1)
  const [view, setView] = useState<{ rows: Row[]; i: number; title?: string } | null>(null)
  const [naming, setNaming] = useState<{ rows: Row[] } | null>(null)
  const list = useCaseList(line, week, unit, f, sort, server, L)
  const set = <K extends keyof CaseFilters>(k: K, v: CaseFilters[K]) => setF((x) => ({ ...x, [k]: v }))
  useEffect(() => setSel(new Map()), [unit, week])
  useEffect(() => setFocus(-1), [JSON.stringify(f), unit, sort, week])
  useEffect(() => {
    if (init.ents.length || init.outcome.length) navigate({ ents: [], outcome: [] }, { replace: true })
  }, [])
  const toggle = useCallback((r: Row) => setSel((s) => {
    const n = new Map(s)
    const k = caseKey(r)
    n.has(k) ? n.delete(k) : n.set(k, r)
    return n
  }), [])
  const open = useCallback((rows: Row[], i: number, title?: string) => setView({ rows, i, title }), [])
  const rate = useCallback((rows: Row[], p: Parameters<typeof review>[1]) => void review(rows, p), [review])
  const detailQ = useCaseDetail(view ? view.rows[view.i] : null, server, week)
  const ctx: ViewerCtx = {
    review: L.review,
    stepReview: (r, k) => stepReview(r, k, server),
    rate: (r, p) => void review([r], p),
    rateStep: (r, k, p) => void reviewStep(r, k, p),
    tags,
    addTag: (label) => addTag("自定义", label),
    anns,
    collections,
    inCollection: L.inCollection,
    toggleCollection: (r, id, on) => void (on ? colOps.edit(id, [r], []) : colOps.edit(id, [], [{ id: r.id, unit: r.unit }])),
    newCollection: (r) => setNaming({ rows: [r] }),
    selected: new Set(sel.keys()),
    toggleSelect: toggle,
    ai,
    detail: (r) => (detailQ.data && detailQ.data.id === r.id ? (detailQ.data as Row) : null),
  }
  const rows = list.rows
  useKey(
    (e) => {
      if (tab !== "list" || view || naming || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector(".pop, .modal-scrim, .drawer")) return
      const k = e.key
      const move = (d: number) => {
        e.preventDefault()
        setFocus((v) => {
          const n = Math.max(0, Math.min(rows.length - 1, v + d))
          document.querySelector(`[data-key="${rows[n] ? caseKey(rows[n]) : ""}"]`)?.scrollIntoView({ block: "nearest" })
          if (n >= rows.length - 6 && list.more) list.loadMore()
          return n
        })
      }
      if (k === "j" || k === "ArrowDown") move(grid ? 4 : 1)
      else if (k === "k" || k === "ArrowUp") move(grid ? -4 : -1)
      else if (grid && k === "ArrowRight") move(1)
      else if (grid && k === "ArrowLeft") move(-1)
      else if (k === "Enter" && rows[focus]) open(rows, focus)
      else if ((k === "x" || k === "X") && rows[focus]) toggle(rows[focus])
      else if ((k === "1" || k === "2" || k === "3") && rows[focus]) {
        const r: CaseRating = k === "1" ? "good" : k === "2" ? "ok" : "bad"
        const cur = L.review(rows[focus])?.rating
        rate([rows[focus]], { rating: cur === r ? null : r })
      }
    },
    [tab, view, naming, rows, focus, grid, list.more, L],
  )
  const fc = list.facets
  const opts = (xs: { key: string; count: number }[] | undefined, name?: (k: string) => string) => (xs ?? []).map((x) => ({ value: x.key, label: name ? name(x.key) : x.key, count: x.count }))
  const active = JSON.stringify(f) !== JSON.stringify(emptyFilters)
  const secondary = f.result.length + f.pattern.length + f.model.length + f.mode.length + f.level.length + f.movement.length + f.steps.length + f.status.length + (f.collection ? 1 : 0)
  const page: Page = { line, week, server, L, tags, tagMap, open, rate, filters: f, setFilters: setF, setTab, unit, pool: list.all, anns: annsQ.data }
  const selRows = [...sel.values()]
  const tally = view?.title ? view.rows.filter((r) => L.review(r)?.rating).length : 0
  const exportNow = (rs: Row[] | null) => exportCases({ line, week, unit, rows: rs ?? list.all ?? (server ? null : rows), filters: f, server, L, tags, anns })
  return (
    <div className="page cx-page">
      <div className="page-head">
        <div>
          <h1>记录</h1>
          <div className="meta">
            <span>{lineName[line]}</span>
            {week && <span className="num">{weekLabel(week)}</span>}
            {list.summary && (
              <span className="faint num">
                {num(list.summary.total)} {unit === "chain" ? "条修改链" : "条记录"} · 已评 {num(list.summary.rated)}
              </span>
            )}
            {server === false && (
              <Tooltip content="评价、收藏和抽样先存在这台电脑上，后端接口上线后自动同步">
                <span className="cx-localtag">仅本机</span>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="actions">
          <Segmented
            value={unit}
            onChange={setUnit}
            options={[
              { value: "chain", label: "按修改链" },
              { value: "task", label: "按单条" },
            ]}
          />
        </div>
      </div>
      <div className="cx-tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "list" as Tab, label: "全部" },
            { value: "issues" as Tab, label: "问题" },
            { value: "batches" as Tab, label: "抽样" },
            { value: "analyses" as Tab, label: "AI 分析", count: analyses.filter((a) => a.state === "running" || a.state === "queued").length || undefined },
            { value: "collections" as Tab, label: "收藏", count: collections.length || undefined },
          ]}
        />
      </div>
      {tab === "list" && (
        <>
          <Summary s={list.summary} f={f} set={set} loading={list.loading} />
          <div className="cx-filters">
            <Input icon="search" size="sm" quiet placeholder="提示词或企业" value={f.q} onChange={(e) => set("q", e.target.value)} onClear={() => set("q", "")} style={{ width: 180 }} />
            <FilterChip label="结局" multi value={f.outcome} onChange={(v) => set("outcome", v as CaseOutcome[])} options={outcomeOrder.map((o) => ({ value: o, label: outcomeName[o], hint: outcomeLong[o], count: fc?.outcomes.find((x) => x.key === o)?.count }))} />
            <FilterChip label={line === "video" ? "模式" : "意图"} multi search value={f.intent} onChange={(v) => set("intent", v)} options={opts(fc?.intents)} />
            <FilterChip label="企业" multi search value={f.enterprise} onChange={(v) => set("enterprise", v)} options={(fc?.enterprises ?? []).map((e) => ({ value: e.id, label: e.name, count: e.count }))} />
            <FilterChip label="评价" multi value={f.rating} onChange={(v) => set("rating", v)} options={[...ratingOrder.map((r) => ({ value: r as string, label: ratingName[r] })), { value: "none", label: "未评" }].map((o) => ({ ...o, count: fc?.ratings.find((x) => x.key === o.value)?.count }))} />
            <FilterChip label="标签" multi search value={f.tag} onChange={(v) => set("tag", v)} options={tags.map((t) => ({ value: t.id, label: t.label, group: t.group, count: fc?.tags.find((x) => x.key === t.id)?.count }))} />
            <button className={cx("chip", f.slow ? "on" : "idle")} onClick={() => set("slow", !f.slow)}>
              <Icon name="clock" size="xs" />
              <span>耗时异常</span>
              {fc && <span className="faint num">{fc.slow}</span>}
            </button>
            <button className={cx("chip", f.noted ? "on" : "idle")} onClick={() => set("noted", !f.noted)}>
              <Icon name="edit" size="xs" />
              <span>有批注</span>
              {fc && fc.noted > 0 && <span className="faint num">{fc.noted}</span>}
            </button>
            <button className={cx("chip", "idle", (more || secondary > 0) && "open")} onClick={() => setMore(!more)}>
              <Icon name="sliders" size="xs" />
              <span>更多{secondary ? ` · ${secondary}` : ""}</span>
            </button>
            {active && (
              <Button size="xs" variant="ghost" onClick={() => setF(emptyFilters)}>
                清除
              </Button>
            )}
          </div>
          {(more || secondary > 0) && (
            <div className="cx-filters sub">
              <FilterChip label="单步结果" multi value={f.result} onChange={(v) => set("result", v as CaseFilters["result"])} options={(["downloaded", "not_downloaded", "failed", "deleted"] as const).map((r) => ({ value: r, label: resultName[r], count: fc?.results.find((x) => x.key === r)?.count }))} />
              {line === "inspiration" && <FilterChip label="修改方式" multi value={f.pattern} onChange={(v) => set("pattern", v)} options={opts(fc?.patterns, (k) => patternName[k as keyof typeof patternName] ?? k)} />}
              <FilterChip label="步数" multi value={f.steps} onChange={(v) => set("steps", v)} options={stepsBuckets.map((b) => ({ value: b, label: `${b} 步`, count: fc?.steps.find((x) => x.key === b)?.count }))} />
              <FilterChip label="模型" multi search value={f.model} onChange={(v) => set("model", v)} options={opts(fc?.models)} />
              {line === "inspiration" && <FilterChip label="模式" multi value={f.mode} onChange={(v) => set("mode", v)} options={opts(fc?.modes)} />}
              <FilterChip label="客户层级" multi value={f.level} onChange={(v) => set("level", v)} options={levelOrder.map((l) => ({ value: l as string, label: levelName[l], count: fc?.levels.find((x) => x.key === l)?.count }))} />
              <FilterChip label="动向" multi value={f.movement} onChange={(v) => set("movement", v)} options={opts(fc?.movements, (k) => movementName[k as keyof typeof movementName] ?? k)} />
              <FilterChip label="状态" multi value={f.status} onChange={(v) => set("status", v)} options={(["todo", "seen", "done"] as const).map((s) => ({ value: s, label: statusName[s], count: fc?.statuses.find((x) => x.key === s)?.count }))} />
              {collections.length > 0 && <FilterChip label="收藏夹" value={f.collection ? [f.collection] : []} onChange={(v) => set("collection", v[0] ?? null)} options={collections.map((c) => ({ value: c.id, label: c.name, count: c.count }))} />}
            </div>
          )}
          <div className="cx-bar">
            <Checkbox checked={rows.length > 0 && rows.every((r) => sel.has(caseKey(r)))} mixed={rows.some((r) => sel.has(caseKey(r))) && !rows.every((r) => sel.has(caseKey(r)))} onChange={(on) => setSel((s) => {
              const n = new Map(s)
              rows.forEach((r) => (on ? n.set(caseKey(r), r) : n.delete(caseKey(r))))
              return n
            })} />
            <span className="faint num">{list.loading ? "加载中" : `${num(list.total)} 条${rows.length < list.total ? ` · 已显示 ${num(rows.length)}` : ""}`}</span>
            <span className="spacer" />
            <Menu width={160} trigger={({ toggle: t, ref }) => <Button ref={ref as never} size="sm" variant="ghost" iconRight="chevDown" onClick={t}>{sortName[sort]}</Button>} items={(Object.keys(sortName) as CaseSort[]).map((k) => ({ key: k, label: sortName[k], icon: k === sort ? ("check" as const) : undefined, onSelect: () => setSort(k) }))} />
            <Tooltip content={grid ? "列表" : "宫格"}>
              <IconButton size="sm" icon={grid ? "layers" : "image"} label={grid ? "列表" : "宫格"} onClick={() => setGrid(!grid)} />
            </Tooltip>
            <Button size="sm" variant="ghost" icon="download" onClick={() => exportNow(null)}>
              导出
            </Button>
          </div>
          {list.loading ? (
            <ListSkeleton grid={grid} />
          ) : list.error ? (
            <ErrorState error={list.error} retry={list.retry} />
          ) : rows.length ? (
            <CaseList rows={rows} grid={grid} L={L} tagMap={tagMap} sel={sel} focus={focus} toggle={toggle} onOpen={(i) => open(rows, i)} rate={rate} more={list.more} fetching={list.fetching} loadMore={list.loadMore} />
          ) : (
            <Empty icon="layers" title={active ? "没有符合条件的记录" : "这周没有记录"} action={active ? <Button size="sm" onClick={() => setF(emptyFilters)}>清除筛选</Button> : undefined} />
          )}
        </>
      )}
      {tab === "issues" && <IssuesPanel p={page} />}
      {tab === "batches" && <BatchesPanel p={page} initial={init.batch} />}
      {tab === "analyses" && <AnalysesPanel p={page} list={analyses} />}
      {tab === "collections" && <CollectionsPanel p={page} collections={collections} ops={colOps} />}
      {sel.size > 0 && (
        <div className="cx-selbar">
          <span className="num">
            已选 <b>{sel.size}</b>
          </span>
          <span className="sep" />
          <div className="cx-rate sm">
            {ratingOrder.map((r) => (
              <button key={r} className={r} onClick={() => (rate(selRows, { rating: r }), toast(`已把 ${sel.size} 条评为「${ratingName[r]}」`))}>
                {ratingName[r]}
              </button>
            ))}
          </div>
          <Menu
            width={220}
            trigger={({ toggle: t, ref }) => (
              <Button ref={ref as never} size="sm" variant="ghost" icon="flag" onClick={t}>
                标签
              </Button>
            )}
            items={tags.map((t, i) => ({ key: t.id, label: t.label, hint: t.group, sep: i > 0 && tags[i - 1].group !== t.group, onSelect: () => (rate(selRows, { addTags: [t.id] }), toast(`已给 ${sel.size} 条贴上「${t.label}」`)) }))}
          />
          <Menu
            width={160}
            trigger={({ toggle: t, ref }) => (
              <Button ref={ref as never} size="sm" variant="ghost" icon="check" onClick={t}>
                状态
              </Button>
            )}
            items={(["todo", "seen", "done"] as const).map((s) => ({ key: s, label: statusName[s], onSelect: () => rate(selRows, { status: s }) }))}
          />
          <Menu
            width={220}
            trigger={({ toggle: t, ref }) => (
              <Button ref={ref as never} size="sm" variant="ghost" icon="book" onClick={t}>
                收藏
              </Button>
            )}
            items={[
              ...collections.map((c) => ({ key: c.id, label: c.name, hint: num(c.count), onSelect: () => void colOps.edit(c.id, selRows, []).then(() => toast(`已加入「${c.name}」`)) })),
              { key: "__new", label: "新建收藏夹", icon: "plus" as const, sep: collections.length > 0, onSelect: () => setNaming({ rows: selRows }) },
            ]}
          />
          <span className="sep" />
          <AnalyzeButton p={page} rows={selRows} onDone={() => (setSel(new Map()), setTab("analyses"))} />
          <Button size="sm" icon="download" onClick={() => exportNow(selRows)}>
            导出
          </Button>
          <Button size="sm" variant="primary" icon="eye" onClick={() => open(selRows, 0, "已选")}>
            逐个看
          </Button>
          <IconButton size="sm" icon="x" label="取消选择" onClick={() => setSel(new Map())} />
        </div>
      )}
      {view && <CaseViewer rows={view.rows} index={view.i} setIndex={(i) => setView((v) => (v ? { ...v, i } : v))} onClose={() => setView(null)} ctx={ctx} title={view.title ? `${view.title} · 已评 ${tally}/${view.rows.length}` : undefined} />}
      <NameModal
        open={!!naming}
        onClose={() => setNaming(null)}
        onSave={async (name) => {
          const c = await colOps.create(name)
          if (c && naming?.rows.length) await colOps.edit(c.id, naming.rows, [])
          if (c) toast(`已建「${name}」${naming?.rows.length ? `，加入 ${naming.rows.length} 条` : ""}`)
          setNaming(null)
        }}
      />
    </div>
  )
}

export const NameModal = ({ open, onClose, onSave, title = "新建收藏夹", initial = "" }: { open: boolean; onClose: () => void; onSave: (name: string) => void; title?: string; initial?: string }) => {
  const [v, setV] = useState(initial)
  useEffect(() => {
    if (open) setV(initial)
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>
            保存
          </Button>
        </>
      }
    >
      <Input autoFocus placeholder="比如：面料变形典型例" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && v.trim() && onSave(v.trim())} />
    </Modal>
  )
}

const Summary = ({ s, f, set, loading }: { s: CaseSummary | null; f: CaseFilters; set: <K extends keyof CaseFilters>(k: K, v: CaseFilters[K]) => void; loading: boolean }) => {
  if (loading || !s)
    return (
      <div className="cx-sum">
        <div className="cx-sum-a">
          <Skel w={160} h={14} />
          <Skel h={40} style={{ marginTop: 14 }} />
        </div>
        <div className="cx-sum-b">
          <Skel h={110} />
        </div>
        <div className="cx-sum-c">
          <Skel h={110} />
        </div>
      </div>
    )
  const pick = (o: CaseOutcome) => set("outcome", f.outcome.length === 1 && f.outcome[0] === o ? [] : [o])
  const max = Math.max(1, ...s.byIntent.slice(0, 6).map((x) => x.total))
  return (
    <div className="cx-sum">
      <div className="cx-sum-a">
        <div className="cx-tiles">
          {outcomeOrder.map((o) => (
            <button key={o} className={cx("cx-tile", o, f.outcome.includes(o) && "on", f.outcome.length > 0 && !f.outcome.includes(o) && "dim")} onClick={() => pick(o)}>
              <span className="k">{outcomeName[o]}</span>
              <b className="num">{num(s.outcomes[o])}</b>
              <span className="faint num">{pct(s.total ? s.outcomes[o] / s.total : 0, 1)}</span>
            </button>
          ))}
        </div>
        <div className="cx-stack">
          {outcomeOrder.map((o) => (
            <Tooltip key={o} content={`${outcomeLong[o]} · ${num(s.outcomes[o])}`}>
              <span className={cx(o, f.outcome.length > 0 && !f.outcome.includes(o) && "dim")} style={{ flexGrow: s.outcomes[o] || 0.0001 }} onClick={() => pick(o)} />
            </Tooltip>
          ))}
        </div>
        <div className="cx-rated faint num">
          已评 {num(s.rated)}
          {s.rated > 0 && (
            <>
              {" · "}
              {ratingOrder.map((r) => `${ratingName[r]} ${s.ratings[r]}`).join(" · ")}
            </>
          )}
        </div>
      </div>
      <div className="cx-sum-b">
        <div className="cx-sum-h">按意图 · bad 占比</div>
        {s.byIntent.slice(0, 6).map((x) => (
          <button key={x.key} className={cx("cx-int", f.intent.includes(x.key) && "on")} onClick={() => set("intent", f.intent.includes(x.key) ? f.intent.filter((k) => k !== x.key) : [...f.intent, x.key])}>
            <span className="n ellipsis">{x.key}</span>
            <span className="bar" style={{ width: `${(x.total / max) * 100}%` }}>
              <i className="bad" style={{ width: `${(x.bad / x.total) * 100}%` }} />
              <i className="grind" style={{ width: `${(x.grind / x.total) * 100}%` }} />
            </span>
            <span className="v num">
              <b>{pct(x.bad / x.total)}</b>
              <span className="faint">{num(x.total)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="cx-sum-c">
        <div className="cx-sum-h">bad 最多的客户</div>
        {s.byEnterprise.filter((e) => e.bad > 0).slice(0, 6).map((e) => (
          <button key={e.enterprise.id} className={cx("cx-ent-r", f.enterprise.includes(e.enterprise.id) && "on")} onClick={() => set("enterprise", f.enterprise.includes(e.enterprise.id) ? f.enterprise.filter((k) => k !== e.enterprise.id) : [...f.enterprise, e.enterprise.id])}>
            <span className="n ellipsis">{e.enterprise.name}</span>
            <span className="v num">
              <b>{e.bad}</b>
              <span className="faint">/ {e.total}</span>
            </span>
          </button>
        ))}
        {!s.byEnterprise.some((e) => e.bad > 0) && <span className="faint">没有 bad</span>}
      </div>
    </div>
  )
}

export const CaseList = ({ rows, grid, L, tagMap, sel, focus, toggle, onOpen, rate, more, fetching, loadMore }: { rows: Row[]; grid: boolean; L: Lookup; tagMap: Map<string, CaseTag>; sel: Map<string, Row>; focus: number; toggle: (r: Row) => void; onOpen: (i: number) => void; rate: (rows: Row[], p: { rating: CaseRating | null }) => void; more?: boolean; fetching?: boolean; loadMore?: () => void }) => {
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more || !loadMore) return
    const io = new IntersectionObserver((es) => es[0].isIntersecting && !fetching && loadMore(), { rootMargin: "600px" })
    io.observe(el)
    return () => io.disconnect()
  }, [more, fetching, loadMore, rows.length])
  return (
    <>
      {grid ? (
        <div className="cx-grid">
          {rows.map((r, i) => (
            <CaseCard key={caseKey(r)} r={r} rv={L.review(r)} notes={L.notes(r).n} on={sel.has(caseKey(r))} focus={i === focus} tags={tagMap} onOpen={() => onOpen(i)} onToggle={() => toggle(r)} />
          ))}
        </div>
      ) : (
        <div className="cx-list">
          {rows.map((r, i) => (
            <CaseLine key={caseKey(r)} r={r} rv={L.review(r)} notes={L.notes(r).n} on={sel.has(caseKey(r))} focus={i === focus} tags={tagMap} onOpen={() => onOpen(i)} onToggle={() => toggle(r)} onRate={(v) => rate([r], { rating: v })} onEnt={() => navigate({ ent: r.enterprise.id, tab: "profile" })} />
          ))}
        </div>
      )}
      {more && (
        <div ref={sentinel} className="cx-more-row">
          <Button size="sm" variant="ghost" loading={fetching} onClick={loadMore}>
            加载更多
          </Button>
        </div>
      )}
    </>
  )
}

export const ListSkeleton = ({ grid }: { grid?: boolean }) =>
  grid ? (
    <div className="cx-grid">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="stack" style={{ gap: 8 }}>
          <Skel h={180} r={10} />
          <Skel h={12} w="70%" />
        </div>
      ))}
    </div>
  ) : (
    <div className="cx-list">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="cx-row" style={{ cursor: "default" }}>
          <span />
          <div className="cx-media">
            <div className="cx-ins">
              <Skel w={56} h={56} r={7} />
              <Skel w={56} h={56} r={7} />
            </div>
            <Skel w={76} h={76} r={9} style={{ marginLeft: 26 }} />
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <Skel h={14} w="70%" />
            <Skel h={12} w="45%" />
          </div>
          <span />
          <span />
        </div>
      ))}
    </div>
  )
