import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Line } from "@spec/contract"
import { useCtx } from "../../lib/ctx"
import { levelName, levelOrder, lineName, movementName, patternName } from "../../lib/labels"
import { num, pct, weekLabel } from "../../lib/format"
import { navigate } from "../../lib/route"
import { useKey } from "../../lib/useKey"
import { fdUrl } from "../../lib/fd"
import { Button, Checkbox, IconButton, Input, Kbd, Segmented, Switch, Tabs, cx } from "../../ui/controls"
import { Empty, ErrorState, Skel } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { FilterChip, Menu, Tooltip, toast } from "../../ui/overlays"
import type { CaseFilters, CaseOutcome, CaseSort, CaseSummary, CaseTag, CaseUnit, Processed, Row, Step } from "./types"
import { caseKey, emptyFilters } from "./types"
import { outcomeLong, outcomeName, outcomeOrder, processedName, resultName, sortName, stepsBuckets, type Lookup } from "./model"
import { blockOf } from "./model"
import { exportCases, useAllAnnotations, useAnalyses, useCaseList, useCaseTags, useEnsureTag, useLookup, usePool, usePoolOps, useProbe, useQuickNote, useTagOps, type CaseList } from "./data"
import { CardSkeleton, CaseCard, type CardAct } from "./CaseRow"
import { CaseViewer, type ViewerCtx } from "./CaseViewer"
import { SharedCtx, buildShared, type Shared } from "./Review"
import { AnalysesPanel, AnalyzeButton, BatchesPanel, LibraryStatsView, PoolPanel } from "./Panels"
import * as S from "./store"

type Tab = "list" | "library" | "pool" | "batches" | "analyses"

export interface Page {
  line: Line
  week: string | null
  unit: CaseUnit
  legacy: boolean
  ready: boolean
  L: Lookup
  tags: CaseTag[]
  shared: Shared
  open: (rows: Row[], i: number, title?: string, step?: number | null) => void
  setTab: (t: Tab) => void
  filters: CaseFilters
  setFilters: (f: CaseFilters) => void
  ops: Ops
  pool: ReturnType<typeof usePool>
  poolOps: ReturnType<typeof usePoolOps>
}

export interface Ops {
  toggleTag: (r: Row, s: Step | null, t: CaseTag) => Promise<boolean>
  createTag: (r: Row, s: Step | null, label: string) => void
  addTags: (rows: Row[], t: CaseTag) => void
  removeTags: (rows: Row[], t: CaseTag) => void
  note: (r: Row, s: Step | null, text: string) => void
}

export const CasesPage = () => {
  const { route, line, week } = useCtx()
  return <CasesBody key={line} line={line} week={week} init={route} />
}

const CasesBody = ({ line, week, init }: { line: Line; week: string | null; init: ReturnType<typeof useCtx>["route"] }) => {
  const probe = useProbe(line, week)
  const annsQ = useAllAnnotations()
  const pool = usePool(line, probe.ready)
  const poolOps = usePoolOps(line, pool.remote)
  const L = useLookup(annsQ.data, pool.keys)
  const { tags } = useCaseTags(line, probe.ready, probe.legacy)
  const shared = useMemo(() => buildShared(tags, annsQ.data, week), [tags, annsQ.data, week])
  const ensure = useEnsureTag(line)
  const tagOps = useTagOps(L)
  const quickNote = useQuickNote()
  const analyses = useAnalyses(line, probe.ready)
  const ai = useMemo(() => {
    const m = new Map<string, { tags: string[]; note: string }>()
    ;[...analyses].reverse().filter((a) => a.state === "done").forEach((a) => a.perCase.forEach((p) => m.set(p.id, { tags: p.tags ?? [], note: p.note })))
    return m
  }, [analyses])
  const [tab, setTab] = useState<Tab>(init.batch ? "batches" : "list")
  const [unit, setUnit] = useState<CaseUnit>(init.unit ?? (line === "video" ? "task" : "chain"))
  const [f, setF] = useState<CaseFilters>({ ...emptyFilters, enterprise: init.ents, outcome: init.outcome as CaseOutcome[], level: init.level, movement: init.movement, intent: init.intent, model: init.models, q: init.q })
  const [lf, setLf] = useState<CaseFilters>(emptyFilters)
  const [sel, setSel] = useState<Map<string, Row>>(new Map())
  const [view, setView] = useState<{ rows: Row[]; i: number; title?: string; step: number | null } | null>(null)
  useEffect(() => setSel(new Map()), [unit, week, tab])
  useEffect(() => {
    if (init.ents.length || init.outcome.length) navigate({ ents: [], outcome: [] }, { replace: true })
  }, [])
  const select = useCallback(
    (r: Row) =>
      setSel((s) => {
        const n = new Map(s)
        const k = caseKey(r)
        n.has(k) ? n.delete(k) : n.set(k, r)
        return n
      }),
    [],
  )
  const resolve = async (t: CaseTag) => (t.id.startsWith("pending:") ? await ensure(t) : t)
  const ops: Ops = {
    toggleTag: async (r, s, t0) => {
      const t = await resolve(t0)
      if (!t) return false
      if (s) {
        const cur = L.stepReview(r, s)
        const eff = cur?.effectiveTags ?? []
        const on = eff.includes(t.id)
        tagOps.step(r, s, on ? eff.filter((x) => x !== t.id) : [...eff, t.id], !cur?.inherited && !!cur?.tags.length)
        return !on
      }
      const on = (L.review(r)?.tags ?? []).includes(t.id)
      tagOps.rows([r], on ? { remove: [t.id] } : { add: [t.id] })
      return !on
    },
    createTag: async (r, s, label) => {
      const t = await ensure({ group: "自定义", label })
      if (t) void ops.toggleTag(r, s, t)
    },
    addTags: async (rows, t0) => {
      const t = await resolve(t0)
      if (t) tagOps.rows(rows, { add: [t.id] })
    },
    removeTags: (rows, t) => tagOps.rows(rows, { remove: [t.id] }),
    note: (r, s, text) => void quickNote(r, s, text, blockOf(r, s)),
  }
  const opsRef = useRef(ops)
  opsRef.current = ops
  const open = useCallback((rows: Row[], i: number, title?: string, step: number | null = null) => setView({ rows, i, title, step }), [])
  const page: Page = { line, week, unit, legacy: probe.legacy, ready: probe.ready, L, tags, shared, open, setTab, filters: f, setFilters: setF, ops, pool, poolOps }
  const vctx: ViewerCtx = {
    review: L.review,
    stepReview: L.stepReview,
    toggleTag: (r, s, t) => void ops.toggleTag(r, s, t),
    createTag: ops.createTag,
    note: ops.note,
    inPool: L.inPool,
    pool: (r) => void poolOps.toggle([r], !L.inPool(r)),
    selected: new Set(sel.keys()),
    select,
    ai,
  }
  const selRows = [...sel.values()]
  const tally = view?.title ? view.rows.filter((r) => L.processed(r) === "done").length : 0
  if (probe.error && !probe.ready)
    return (
      <div className="page cx-page">
        <ErrorState error={probe.error} retry={probe.retry} />
      </div>
    )
  return (
    <SharedCtx.Provider value={shared}>
      <div className="page cx-page">
        <div className="page-head">
          <div>
            <h1>记录</h1>
            <div className="meta">
              <span>{lineName[line]}</span>
              {week && tab === "list" && <span className="num">{weekLabel(week)}</span>}
              {tab === "library" && <span>全部周</span>}
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
              { value: "library" as Tab, label: "案例集" },
              { value: "pool" as Tab, label: "可做模板", count: pool.rows.length || undefined },
              { value: "batches" as Tab, label: "抽样" },
              { value: "analyses" as Tab, label: "AI 分析", count: analyses.filter((a) => a.state === "running" || a.state === "queued").length || undefined },
            ]}
          />
        </div>
        {tab === "list" && <ListView key={`w-${unit}`} p={page} scope="week" filters={f} setFilters={setF} sel={sel} select={select} setSel={setSel} opsRef={opsRef} />}
        {tab === "library" && <ListView key={`l-${unit}`} p={page} scope="library" filters={lf} setFilters={setLf} sel={sel} select={select} setSel={setSel} opsRef={opsRef} />}
        {tab === "pool" && <PoolPanel p={page} />}
        {tab === "batches" && <BatchesPanel p={page} initial={init.batch} />}
        {tab === "analyses" && <AnalysesPanel p={page} list={analyses} />}
        {sel.size > 0 && (
          <div className="cx-selbar">
            <span className="num">
              已选 <b>{sel.size}</b>
            </span>
            <span className="sep" />
            <Menu
              width={240}
              trigger={({ toggle: t, ref }) => (
                <Button ref={ref as never} size="sm" variant="ghost" icon="flag" onClick={t}>
                  打标签
                </Button>
              )}
              items={tags.map((t, i) => ({ key: t.id, label: t.label, hint: t.group, sep: i > 0 && tags[i - 1].group !== t.group && i > 9, onSelect: () => (ops.addTags(selRows, t), toast(`已给 ${sel.size} 条打上「${t.label}」`)) }))}
            />
            <Button size="sm" variant="ghost" icon="plus" onClick={() => (poolOps.toggle(selRows, true), toast(`已把 ${sel.size} 条放进可做模板`))}>
              可做模板
            </Button>
            <span className="sep" />
            <AnalyzeButton p={page} rows={selRows} onDone={() => (setSel(new Map()), setTab("analyses"))} />
            <Button size="sm" icon="download" onClick={() => exportCases({ line, week, unit, rows: selRows, filters: f, legacy: probe.legacy, scope: tab === "library" ? "library" : "week", tags })}>
              导出
            </Button>
            <Button size="sm" variant="primary" icon="eye" onClick={() => open(selRows, 0, "已选")}>
              逐个看
            </Button>
            <IconButton size="sm" icon="x" label="取消选择" onClick={() => setSel(new Map())} />
          </div>
        )}
        {view && <CaseViewer rows={view.rows} index={view.i} step={view.step} setIndex={(i) => setView((v) => (v ? { ...v, i, step: null } : v))} onClose={() => setView(null)} ctx={vctx} title={view.title ? `${view.title} · 已处理 ${tally}/${view.rows.length}` : undefined} />}
      </div>
    </SharedCtx.Provider>
  )
}

const ListView = ({ p, scope, filters: f, setFilters: setF, sel, select, setSel, opsRef }: { p: Page; scope: "week" | "library"; filters: CaseFilters; setFilters: (f: CaseFilters) => void; sel: Map<string, Row>; select: (r: Row) => void; setSel: (fn: (s: Map<string, Row>) => Map<string, Row>) => void; opsRef: React.MutableRefObject<Ops> }) => {
  S.useStore()
  const prefs = S.pref()
  const hide = scope === "week" && prefs.hide
  const [sort, setSort] = useState<CaseSort>(scope === "library" ? "processed" : "bad_first")
  const [more, setMore] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [targets, setTargets] = useState<Map<string, number>>(new Map())
  const [searchKey, setSearchKey] = useState<string | null>(null)
  const registry = useRef(new Map<string, Step[] | null>())
  const kbd = useRef(0)
  const list = useCaseList({ line: p.line, week: p.week, unit: p.unit, filters: f, sort, scope, legacy: p.legacy, ready: p.ready, hide, tags: p.tags, L: p.L })
  const rows = list.rows
  const set = <K extends keyof CaseFilters>(k: K, v: CaseFilters[K]) => setF({ ...f, [k]: v })
  const version = S.useStore()
  const idx = rows.findIndex((r) => caseKey(r) === focusKey)
  const st = useRef({ rows, idx, focusKey, expanded, targets })
  st.current = { rows, idx, focusKey, expanded, targets }
  const focusAt = (i: number, scroll = true) => {
    const r = st.current.rows[Math.max(0, Math.min(st.current.rows.length - 1, i))]
    if (!r) return
    kbd.current = Date.now()
    setFocusKey(caseKey(r))
    if (scroll) requestAnimationFrame(() => document.querySelector(`[data-key="${caseKey(r)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }))
    if (i >= st.current.rows.length - 4 && list.more) list.loadMore()
  }
  const stepOf = (r: Row): Step | null => {
    const k = caseKey(r)
    const i = st.current.targets.get(k)
    if (i == null || !st.current.expanded.has(k)) return null
    return registry.current.get(k)?.[i] ?? null
  }
  const advance = (r: Row) => {
    if (!S.pref().auto) return
    const i = st.current.rows.findIndex((x) => caseKey(x) === caseKey(r))
    if (hide) setTimeout(() => focusAt(i, true), 0)
    else focusAt(i + 1)
  }
  const toggle = async (r: Row, s: Step | null, t: CaseTag) => {
    const added = await opsRef.current.toggleTag(r, s, t)
    if (added && !s) advance(r)
  }
  const actRef = useRef<CardAct>(null as unknown as CardAct)
  actRef.current = {
    open: (r, step) => {
      const i = st.current.rows.findIndex((x) => caseKey(x) === caseKey(r))
      p.open(st.current.rows, Math.max(0, i), undefined, step)
    },
    focus: (r) => {
      if (Date.now() - kbd.current < 400) return
      const k = caseKey(r)
      if (st.current.focusKey !== k) setFocusKey(k)
    },
    select,
    expand: (r) => {
      const k = caseKey(r)
      setExpanded((s) => {
        const n = new Set(s)
        n.has(k) ? n.delete(k) : n.add(k)
        return n
      })
      setTargets((m) => {
        const n = new Map(m)
        n.delete(k)
        return n
      })
    },
    target: (r, i) =>
      setTargets((m) => {
        const n = new Map(m)
        i == null ? n.delete(caseKey(r)) : n.set(caseKey(r), i)
        return n
      }),
    toggleTag: (r, s, t) => void toggle(r, s, t),
    createTag: (r, s, l) => opsRef.current.createTag(r, s, l),
    search: (r) => setSearchKey(r ? caseKey(r) : null),
    note: (r, s, t) => opsRef.current.note(r, s, t),
    pool: (r) => void p.poolOps.toggle([r], !p.L.inPool(r)),
    stepReview: (r, s) => p.L.stepReview(r, s),
    ent: (r) => navigate({ ent: r.enterprise.id, tab: "profile" }),
    register: (k, steps) => (steps ? registry.current.set(k, steps) : registry.current.delete(k)),
  }
  const act = useMemo<CardAct>(() => {
    const a = {} as CardAct
    ;(["open", "focus", "select", "expand", "target", "toggleTag", "createTag", "search", "note", "pool", "stepReview", "ent", "register"] as const).forEach((k) => {
      ;(a as unknown as Record<string, unknown>)[k] = (...args: unknown[]) => (actRef.current[k] as (...x: unknown[]) => unknown)(...args)
    })
    return a
  }, [])
  useKey(
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector(".cxv, .pop, .modal-scrim, .drawer")) return
      const el = e.target as HTMLElement
      if (el.closest("input, textarea, [contenteditable]")) return
      const k = e.key
      const cur = st.current.rows[st.current.idx] ?? null
      if (k === "j" || k === "ArrowDown") return e.preventDefault(), focusAt(st.current.idx < 0 ? 0 : st.current.idx + 1)
      if (k === "k" || k === "ArrowUp") return e.preventDefault(), focusAt(st.current.idx - 1)
      if (k === "h" || k === "H") return scope === "week" && S.setPref({ hide: !S.pref().hide })
      if (!cur) return
      const ck = caseKey(cur)
      const ex = st.current.expanded.has(ck)
      const steps = registry.current.get(ck) ?? null
      if ((k === "ArrowRight" || k === "ArrowLeft") && ex && steps) {
        e.preventDefault()
        const t = st.current.targets.get(ck)
        const n = k === "ArrowRight" ? (t == null ? 0 : Math.min(steps.length - 1, t + 1)) : t == null ? null : t === 0 ? null : t - 1
        actRef.current.target(cur, n)
        return
      }
      if (k === "Enter" || k === " ") return e.preventDefault(), actRef.current.open(cur, ex ? st.current.targets.get(ck) ?? null : null)
      if (/^[0-9]$/.test(k)) {
        const t = k === "0" ? p.shared.falseAlarm : p.shared.quick[Number(k) - 1]
        if (t) void toggle(cur, stepOf(cur), t)
        return
      }
      if (k === "t" || k === "T") return e.preventDefault(), setSearchKey(ck)
      if (k === "c" || k === "C") {
        e.preventDefault()
        document.querySelector<HTMLInputElement>(`[data-key="${ck}"] .rv-note-in`)?.focus()
        return
      }
      if (k === "p" || k === "P") return actRef.current.pool(cur)
      if (k === "e" || k === "E") return cur.unit === "chain" && cur.stepCount > 1 && actRef.current.expand(cur)
      if (k === "x" || k === "X") return select(cur)
      if (k === "o" || k === "O") {
        const s = stepOf(cur)
        const u = s?.task ? fdUrl(s.task) : cur.fdUrl
        if (u) window.open(u, "_blank", "noopener")
      }
      if (k === "Escape") setFocusKey(null)
    },
    [p.shared, scope, hide, list.more],
  )
  const fc = list.facets
  const opts = (xs: { key: string; count: number }[] | undefined, name?: (k: string) => string) => (xs ?? []).map((x) => ({ value: x.key, label: name ? name(x.key) : x.key, count: x.count }))
  const active = JSON.stringify(f) !== JSON.stringify(emptyFilters)
  const secondary = f.result.length + f.pattern.length + f.model.length + f.mode.length + f.level.length + f.movement.length + f.steps.length
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !list.more) return
    const io = new IntersectionObserver((es) => es[0].isIntersecting && !list.fetching && list.loadMore(), { rootMargin: "900px" })
    io.observe(el)
    return () => io.disconnect()
  }, [list.more, list.fetching, rows.length])
  const allSel = rows.length > 0 && rows.every((r) => sel.has(caseKey(r)))
  const doneN = rows.filter((r) => p.L.processed(r) === "done").length
  return (
    <>
      {scope === "week" ? <Summary s={list.summary} f={f} set={set} loading={list.loading} /> : <LibraryStatsView p={p} filters={f} setFilters={setF} />}
      <div className="cx-filters">
        <Input icon="search" size="sm" quiet placeholder="提示词或企业" value={f.q} onChange={(e) => set("q", e.target.value)} onClear={() => set("q", "")} style={{ width: 180 }} />
        <FilterChip label="结局" multi value={f.outcome} onChange={(v) => set("outcome", v as CaseOutcome[])} options={outcomeOrder.map((o) => ({ value: o, label: outcomeName[o], hint: outcomeLong[o], count: fc?.outcomes.find((x) => x.key === o)?.count }))} />
        <FilterChip label={p.line === "video" ? "模式" : "意图"} multi search value={f.intent} onChange={(v) => set("intent", v)} options={opts(fc?.intents)} />
        <FilterChip label="企业" multi search value={f.enterprise} onChange={(v) => set("enterprise", v)} options={(fc?.enterprises ?? []).map((e) => ({ value: e.id, label: e.name, count: e.count }))} />
        <FilterChip label="标签" multi search value={f.tag} onChange={(v) => set("tag", v)} options={p.tags.filter((t) => !t.id.startsWith("pending:")).map((t) => ({ value: t.id, label: t.label, group: t.group, count: fc?.tags.find((x) => x.key === t.id)?.count }))} />
        {scope === "week" && <FilterChip label="处理" multi value={f.processed} onChange={(v) => set("processed", v as Processed[])} options={(["todo", "done", "noted"] as Processed[]).map((k) => ({ value: k, label: processedName[k], count: p.legacy ? undefined : (fc as unknown as { processed?: { key: string; count: number }[] })?.processed?.find((x) => x.key === k)?.count }))} />}
        <button className={cx("chip", f.slow ? "on" : "idle")} onClick={() => set("slow", !f.slow)}>
          <Icon name="clock" size="xs" />
          <span>耗时异常</span>
          {fc && <span className="faint num">{fc.slow}</span>}
        </button>
        <button className={cx("chip", f.noted ? "on" : "idle")} onClick={() => set("noted", !f.noted)}>
          <Icon name="edit" size="xs" />
          <span>有评论</span>
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
          {p.line === "inspiration" && <FilterChip label="修改方式" multi value={f.pattern} onChange={(v) => set("pattern", v)} options={opts(fc?.patterns, (k) => patternName[k as keyof typeof patternName] ?? k)} />}
          <FilterChip label="步数" multi value={f.steps} onChange={(v) => set("steps", v)} options={stepsBuckets.map((b) => ({ value: b, label: `${b} 步`, count: fc?.steps.find((x) => x.key === b)?.count }))} />
          <FilterChip label="模型" multi search value={f.model} onChange={(v) => set("model", v)} options={opts(fc?.models)} />
          {p.line === "inspiration" && <FilterChip label="模式" multi value={f.mode} onChange={(v) => set("mode", v)} options={opts(fc?.modes)} />}
          <FilterChip label="客户层级" multi value={f.level} onChange={(v) => set("level", v)} options={levelOrder.map((l) => ({ value: l as string, label: levelName[l], count: fc?.levels.find((x) => x.key === l)?.count }))} />
          <FilterChip label="动向" multi value={f.movement} onChange={(v) => set("movement", v)} options={opts(fc?.movements, (k) => movementName[k as keyof typeof movementName] ?? k)} />
        </div>
      )}
      <div className="cx-bar">
        <Checkbox
          checked={allSel}
          mixed={rows.some((r) => sel.has(caseKey(r))) && !allSel}
          onChange={(on) =>
            setSel((s) => {
              const n = new Map(s)
              rows.forEach((r) => (on ? n.set(caseKey(r), r) : n.delete(caseKey(r))))
              return n
            })
          }
        />
        <span className="faint num">{list.loading ? "加载中" : countText(list, rows.length, hide, p.legacy)}</span>
        {!list.loading && rows.length > 0 && scope === "week" && (
          <span className="rv-prog num">
            <span className="track">
              <i style={{ width: `${(doneN / rows.length) * 100}%` }} />
            </span>
            <b>{doneN}</b>/{rows.length} 已处理
          </span>
        )}
        <span className="spacer" />
        {scope === "week" && (
          <Tooltip content={<span>隐藏已处理 <Kbd keys={["H"]} /></span>}>
            <span>
              <Switch size="sm" checked={hide} onChange={(v) => S.setPref({ hide: v })}>
                隐藏已处理
              </Switch>
            </span>
          </Tooltip>
        )}
        <Tooltip content="打完标签自动跳到下一条">
          <span>
            <Switch size="sm" checked={prefs.auto} onChange={(v) => S.setPref({ auto: v })}>
              自动下一条
            </Switch>
          </span>
        </Tooltip>
        <Menu
          width={160}
          trigger={({ toggle: t, ref }) => (
            <Button ref={ref as never} size="sm" variant="ghost" iconRight="chevDown" onClick={t}>
              {sort === "processed" ? "最近处理" : sortName[sort]}
            </Button>
          )}
          items={[...(scope === "library" ? (["processed"] as CaseSort[]) : []), ...(Object.keys(sortName) as CaseSort[])].map((k) => ({ key: k, label: k === "processed" ? "最近处理" : sortName[k as keyof typeof sortName], icon: k === sort ? ("check" as const) : undefined, onSelect: () => setSort(k) }))}
        />
        <Button size="sm" variant="ghost" icon="download" onClick={() => exportCases({ line: p.line, week: p.week, unit: p.unit, rows: null, filters: f, legacy: p.legacy, scope, tags: p.tags })}>
          导出
        </Button>
      </div>
      {list.loading ? (
        <div className="rv-list">
          {[0, 1, 2].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} retry={list.retry} />
      ) : rows.length ? (
        <div className="rv-list">
          {rows.map((r) => {
            const k = caseKey(r)
            const ex = expanded.has(k)
            return (
              <CaseCard
                key={k}
                r={r}
                review={p.L.review(r)}
                notes={p.L.notes(r)}
                pool={p.L.inPool(r)}
                processed={p.L.processed(r)}
                focus={k === focusKey}
                selected={sel.has(k)}
                expanded={ex}
                stepIdx={ex ? targets.get(k) ?? null : null}
                searching={searchKey === k}
                ver={ex ? version : 0}
                act={act}
              />
            )
          })}
          {list.more && (
            <div ref={sentinel} className="cx-more-row">
              <Button size="sm" variant="ghost" loading={list.fetching} onClick={list.loadMore}>
                加载更多
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Empty
          icon={scope === "library" ? "book" : "layers"}
          title={scope === "library" ? (active ? "没有符合条件的案例" : "案例集还是空的") : hide && !active ? "这周的都处理完了" : active ? "没有符合条件的记录" : "这周没有记录"}
          text={scope === "library" && !active ? "在「全部」里给记录打上标签，就会出现在这里" : undefined}
          action={active ? <Button size="sm" onClick={() => setF(emptyFilters)}>清除筛选</Button> : hide ? <Button size="sm" onClick={() => S.setPref({ hide: false })}>显示已处理</Button> : undefined}
        />
      )}
      {focusKey && rows.length > 0 && <KeyHints shared={p.shared} expanded={expanded.has(focusKey)} />}
    </>
  )
}

const countText = (list: CaseList, shown: number, hide: boolean, legacy: boolean) => {
  if (hide && legacy) return `${num(shown)} 条待处理${list.more ? "+" : ""}`
  return `${num(list.total)} 条${shown < list.total ? ` · 已显示 ${num(shown)}` : ""}`
}

const KeyHints = ({ shared, expanded }: { shared: Shared; expanded: boolean }) => (
  <div className="rv-keys">
    <span><Kbd keys={["J", "K"]} />上下</span>
    <span><Kbd keys={["1-9"]} />打标签</span>
    {shared.falseAlarm && <span><Kbd keys={["0"]} />其实没问题</span>}
    <span><Kbd keys={["T"]} />搜标签</span>
    <span><Kbd keys={["C"]} />评论</span>
    <span><Kbd keys={["P"]} />可做模板</span>
    <span><Kbd keys={["E"]} />{expanded ? "收起" : "展开步骤"}</span>
    {expanded && <span><Kbd keys={["←", "→"]} />选步骤</span>}
    <span><Kbd keys={["↵"]} />全屏</span>
  </div>
)

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
  const processed = (s as CaseSummary & { processed?: number; rated?: number }).processed ?? (s as { rated?: number }).rated ?? null
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
        {processed != null && (
          <div className="cx-rated faint num">
            已处理 {num(processed)} · {pct(s.total ? processed / s.total : 0, 1)}
          </div>
        )}
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
