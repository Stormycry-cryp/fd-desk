import { useEffect, useMemo, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Annotation, Line, Scope, Task } from "@spec/contract"
import type { RecordAnalysis, RecordPage, RecordQuery, RecordResult, RecordRow, SampleResult, SampleStratum } from "@spec/contract"
import { call, RequestError, url } from "../../api/client"
import { errorText, useRecordAnalyses } from "../../api/next"
import { useCtx } from "../../lib/ctx"
import { lineName, failureName } from "../../lib/labels"
import { num, time, weekShort } from "../../lib/format"
import { fdUrl } from "../../lib/fd"
import { Button, Checkbox, IconButton, Input, Segmented, cx } from "../../ui/controls"
import { Badge, Empty, ErrorState, Skel, Thumb } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { FilterChip, Tooltip, toast } from "../../ui/overlays"
import { ConfidenceDot, EvidenceChip, JobProgress } from "../../ui/insight"
import { Composer, Thread } from "../../ui/annotate"
import { TaskViewer } from "./TaskViewer"

export const strataName: Record<SampleStratum, string> = {
  stuck_tail: "卡住",
  not_downloaded: "未下载",
  downloaded: "已下载",
  failed: "失败",
  batch: "批量",
  agent: "Agent",
  rare_intent: "少见类型",
  new_model: "新模型",
  member: "成员",
  recent: "最近",
  annotated: "有批注",
}
const strataTone: Partial<Record<SampleStratum, "down" | "up" | "accent" | "warn">> = { stuck_tail: "down", failed: "down", not_downloaded: "warn", downloaded: "up", batch: "accent" }
const resultName: Record<RecordResult, string> = { downloaded: "已下载", not_downloaded: "未下载", failed: "失败" }
const verdictTone = { good: "up", ok: undefined, bad: "down" } as const
const verdictName = { good: "好", ok: "一般", bad: "差" }

type Range = "all" | "week" | "4w" | "12w"
const rangeName: Record<Range, string> = { all: "全部时间", week: "所选周", "4w": "近 4 周", "12w": "近 12 周" }
const day = (d: Date) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10)
const shift = (w: string, days: number) => day(new Date(new Date(`${w}T00:00:00+08:00`).getTime() + days * 86400e3))
const rangeOf = (r: Range, week: string | null) => {
  if (r === "all" || !week) return {}
  const to = shift(week, 6)
  return { from: r === "week" ? week : shift(week, r === "4w" ? -21 : -77), to }
}

const resultOf = (t: Task): RecordResult => (t.failed ? "failed" : t.downloaded ? "downloaded" : "not_downloaded")
const recordBlock = (rowKey: string) => `record:${rowKey}`
const missing = (e: unknown) => e instanceof RequestError && e.missing

interface Filters {
  range: Range
  result: RecordResult[]
  kind: string[]
  model: string[]
  user: string[]
  noted: boolean
  q: string
}
const empty: Filters = { range: "all", result: [], kind: [], model: [], user: [], noted: false, q: "" }

const useRecordList = (id: string, scope: Scope, lines: Line[], f: Filters, week: string | null, anns: Annotation[]) => {
  const base: RecordQuery = {
    enterprise: id,
    scope,
    ...rangeOf(f.range, week),
    result: f.result.length === 1 ? f.result[0] : undefined,
    intent: f.kind.length === 1 && scope === "inspiration" ? f.kind[0] : undefined,
    mode: f.kind.length === 1 && scope === "video" ? f.kind[0] : undefined,
    model: f.model.length === 1 ? f.model[0] : undefined,
    user: f.user.length === 1 ? f.user[0] : undefined,
    noted: f.noted ? "any" : undefined,
    q: f.q.trim() || undefined,
    limit: 60,
  }
  const primary = useInfiniteQuery({
    queryKey: ["GET /api/records", base],
    queryFn: ({ pageParam }) => call("GET /api/records", { query: { ...base, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last: RecordPage, all) => {
      const n = all.reduce((s, p) => s + p.items.length, 0)
      return n < last.total ? n : undefined
    },
    retry: (n, e) => !(e instanceof RequestError && (e.missing || e.status < 500)) && n < 2,
  })
  const fallback = missing(primary.error)
  const [limit, setLimit] = useState(60)
  useEffect(() => setLimit(60), [id, scope, f.result.join(), f.model.join(), f.user.join(), f.kind.join()])
  const use = scope === "all" ? lines : lines.filter((l) => l === scope)
  const fb = useQuery({
    queryKey: ["records-fallback", id, use.join(), limit, f.result.join(), f.model.join(), f.user.join(), f.kind.join()],
    enabled: fallback,
    placeholderData: (p) => p,
    queryFn: async () => {
      const pages = await Promise.all(
        use.map((line) =>
          call("GET /api/tasks", {
            query: {
              line,
              enterprise: id,
              limit: Math.min(200, limit),
              downloaded: f.result.length === 1 && f.result[0] !== "failed" ? f.result[0] === "downloaded" : undefined,
              failed: f.result.length === 1 ? f.result[0] === "failed" : undefined,
              model: f.model.length === 1 ? f.model[0] : undefined,
              user: f.user.length === 1 ? f.user[0] : undefined,
              intent: f.kind.length === 1 && line === "inspiration" ? f.kind[0] : undefined,
              mode: f.kind.length === 1 && line === "video" ? f.kind[0] : undefined,
            },
          }).then((p) => ({ line, ...p })),
        ),
      )
      return pages
    },
  })
  const counts = useMemo(() => {
    const m = new Map<string, { n: number; last: Annotation | null }>()
    anns.forEach((a) => {
      const b = a.anchor?.block
      if (!b?.startsWith("record:")) return
      const k = b.slice(7)
      const cur = m.get(k) ?? { n: 0, last: null }
      m.set(k, { n: cur.n + 1, last: !cur.last || a.updatedAt > cur.last.updatedAt ? a : cur.last })
    })
    return m
  }, [anns])
  const rows = useMemo<RecordRow[]>(() => {
    if (!fallback) {
      const xs = primary.data?.pages.flatMap((p) => p.items) ?? []
      const multi = (r: RecordRow) =>
        (f.result.length < 2 || f.result.includes(resultOf(r.task))) &&
        (f.kind.length < 2 || f.kind.includes((r.task.line === "inspiration" ? r.task.intent : r.task.mode) ?? "")) &&
        (f.model.length < 2 || f.model.includes(r.task.model ?? "")) &&
        (f.user.length < 2 || f.user.includes(r.task.user?.id ?? ""))
      return xs.filter(multi)
    }
    const all = (fb.data ?? []).flatMap((p) => p.items)
    const r = rangeOf(f.range, week)
    const s = f.q.trim().toLowerCase()
    return all
      .filter((t) => (!r.from || t.createdAt.slice(0, 10) >= r.from) && (!r.to || t.createdAt.slice(0, 10) <= r.to))
      .filter((t) => !f.result.length || f.result.includes(resultOf(t)))
      .filter((t) => !f.model.length || f.model.includes(t.model ?? ""))
      .filter((t) => !f.user.length || f.user.includes(t.user?.id ?? ""))
      .filter((t) => !f.kind.length || f.kind.includes((t.line === "inspiration" ? t.intent : t.mode) ?? ""))
      .filter((t) => !s || t.prompt.toLowerCase().includes(s))
      .filter((t) => !f.noted || counts.has(t.rowKey))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((t) => ({ task: t, annotationCount: counts.get(t.rowKey)?.n ?? 0, lastAnnotation: counts.get(t.rowKey)?.last ? { text: counts.get(t.rowKey)!.last!.entries.at(-1)?.text ?? "", at: counts.get(t.rowKey)!.last!.updatedAt } : null, sampleReason: null }))
  }, [fallback, primary.data, fb.data, counts, f, week])
  const withCounts = useMemo(() => rows.map((r) => (counts.has(r.task.rowKey) && !r.annotationCount ? { ...r, annotationCount: counts.get(r.task.rowKey)!.n } : r)), [rows, counts])
  const facets = primary.data?.pages[0]?.facets ?? null
  const total = fallback ? (fb.data ?? []).reduce((s, p) => s + p.total, 0) : primary.data?.pages[0]?.total ?? 0
  const loaded = fallback ? (fb.data ?? []).reduce((s, p) => s + p.items.length, 0) : withCounts.length
  return {
    rows: withCounts,
    total,
    loaded,
    facets,
    fallback,
    loading: fallback ? fb.isLoading : primary.isLoading,
    fetching: fallback ? fb.isFetching : primary.isFetchingNextPage,
    error: fallback ? fb.error : primary.error,
    more: fallback ? loaded < total && limit < 200 : !!primary.hasNextPage,
    loadMore: () => (fallback ? setLimit((n) => Math.min(200, n + 60)) : primary.fetchNextPage()),
    retry: () => (fallback ? fb.refetch() : primary.refetch()),
    counts,
  }
}

export const RecordsTab = ({ id, scope, lines, anns, kinds, models, users }: { id: string; scope: Scope; lines: Line[]; anns: Annotation[]; kinds: string[]; models: string[]; users: { id: string; name: string }[] }) => {
  const { week } = useCtx()
  const [mode, setMode] = useState<"list" | "sample">("list")
  const [f, setF] = useState<Filters>(empty)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [view, setView] = useState<{ rows: RecordRow[]; i: number } | null>(null)
  const [grid, setGrid] = useState(false)
  const list = useRecordList(id, scope, lines, f, week, anns)
  const analyses = useRecordAnalyses(id)
  const verdicts = useMemo(() => {
    const m = new Map<string, { verdict: "good" | "ok" | "bad"; note: string }>()
    ;[...(analyses.data ?? [])].filter((a) => a.state === "done").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).forEach((a) => a.perRecord.forEach((p) => m.set(p.rowKey, p)))
    return m
  }, [analyses.data])
  useEffect(() => setSel(new Set()), [id, scope])
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }))
  const fc = list.facets
  const kindOpts = fc ? [...(scope !== "video" ? fc.intents : []), ...(scope !== "inspiration" ? fc.modes : [])].map((x) => ({ value: x.key, label: x.key, count: x.count })) : kinds.map((k) => ({ value: k, label: k }))
  const modelOpts = fc ? fc.models.map((x) => ({ value: x.key, label: x.key, count: x.count })) : models.map((m) => ({ value: m, label: m }))
  const userOpts = fc ? fc.users.map((u) => ({ value: u.id, label: u.name, count: u.count })) : users.map((u) => ({ value: u.id, label: u.name }))
  const resultOpts = (["downloaded", "not_downloaded", "failed"] as RecordResult[]).map((r) => ({ value: r, label: resultName[r], count: fc?.results.find((x) => x.result === r)?.count }))
  const anyF = f.range !== "all" || f.result.length || f.kind.length || f.model.length || f.user.length || f.noted || f.q
  const toggle = (k: string) => setSel((s) => {
    const n = new Set(s)
    n.has(k) ? n.delete(k) : n.add(k)
    return n
  })
  return (
    <div className="rec">
      <AnalysesPanel id={id} q={analyses} onOpen={(rows, i) => setView({ rows, i })} />
      <div className="rec-head">
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "list", label: "全部记录", icon: "layers" }, { value: "sample", label: "价值抽样", icon: "sparkle" }]} />
        {mode === "list" && <span className="faint num">{list.loading ? "" : `${num(list.total)} 条${scope === "all" && lines.length > 1 ? ` · ${lines.map((l) => lineName[l]).join(" + ")}` : ""}`}</span>}
        <span className="spacer" />
        <Tooltip content={grid ? "列表" : "宫格"}>
          <IconButton size="sm" icon={grid ? "layers" : "image"} label={grid ? "列表" : "宫格"} onClick={() => setGrid(!grid)} />
        </Tooltip>
        <Button size="sm" variant="ghost" icon="download" onClick={() => exportRecords(id, scope, sel.size ? [...sel] : undefined)}>
          导出
        </Button>
      </div>
      {mode === "list" ? (
        <>
          <div className="rec-filters">
            <Input icon="search" size="sm" quiet placeholder="提示词" value={f.q} onChange={(e) => set("q", e.target.value)} onClear={() => set("q", "")} style={{ width: 160 }} />
            <FilterChip label="时间" value={f.range === "all" ? [] : [f.range]} onChange={(v) => set("range", (v[0] as Range) ?? "all")} options={(["week", "4w", "12w"] as Range[]).map((r) => ({ value: r, label: r === "week" && week ? `${weekShort(week)} 周` : rangeName[r] }))} />
            <FilterChip label="结果" multi value={f.result} onChange={(v) => set("result", v as RecordResult[])} options={resultOpts} />
            {kindOpts.length > 0 && <FilterChip label={scope === "video" ? "模式" : scope === "inspiration" ? "任务类型" : "类型"} multi search={kindOpts.length > 8} value={f.kind} onChange={(v) => set("kind", v)} options={kindOpts} />}
            {modelOpts.length > 0 && <FilterChip label="模型" multi search={modelOpts.length > 8} value={f.model} onChange={(v) => set("model", v)} options={modelOpts} />}
            {userOpts.length > 1 && <FilterChip label="成员" multi search={userOpts.length > 8} value={f.user} onChange={(v) => set("user", v)} options={userOpts} />}
            <button className={cx("chip", f.noted ? "on" : "idle")} onClick={() => set("noted", !f.noted)}>
              <Icon name={f.noted ? "check" : "edit"} size="xs" />
              <span>有批注</span>
              {list.counts.size > 0 && <span className="faint num">{list.counts.size}</span>}
            </button>
            {anyF ? (
              <Button size="xs" variant="ghost" onClick={() => setF(empty)}>
                清除
              </Button>
            ) : null}
          </div>
          {list.loading ? (
            <RecSkeleton grid={grid} />
          ) : list.error && !list.fallback ? (
            <ErrorState error={list.error} retry={list.retry} />
          ) : list.rows.length ? (
            <>
              <RecList rows={list.rows} grid={grid} sel={sel} toggle={toggle} verdicts={verdicts} scope={scope} onOpen={(i) => setView({ rows: list.rows, i })} onAll={(on) => setSel(on ? new Set(list.rows.map((r) => r.task.rowKey)) : new Set())} />
              {list.more && (
                <div className="rec-more">
                  <Button size="sm" loading={list.fetching} onClick={list.loadMore}>
                    加载更多 · 已显示 {num(list.loaded)} / {num(list.total)}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Empty icon="layers" title={anyF ? "没有符合条件的记录" : "没有生成记录"} compact />
          )}
        </>
      ) : (
        <SampleView id={id} scope={scope} week={week} grid={grid} sel={sel} toggle={toggle} setSel={setSel} verdicts={verdicts} onOpen={(rows, i) => setView({ rows, i })} />
      )}
      <SelectionBar id={id} sel={sel} clear={() => setSel(new Set())} scope={scope} />
      <TaskViewer
        tasks={view?.rows.map((r) => r.task) ?? []}
        index={view?.i ?? null}
        onClose={() => setView(null)}
        extra={(t) => <RecordSide t={t} anns={anns} verdict={verdicts.get(t.rowKey) ?? null} reason={view?.rows.find((r) => r.task.rowKey === t.rowKey)?.sampleReason ?? null} selected={sel.has(t.rowKey)} toggle={() => toggle(t.rowKey)} />}
      />
    </div>
  )
}

const exportRecords = (id: string, scope: Scope, rowKeys?: string[]) => {
  const href = url("GET /api/records/export", { query: { enterprise: id, scope, rowKeys: rowKeys?.join(",") } })
  fetch(href).then(async (r) => {
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("json")) return toast(r.status === 404 || r.status === 405 ? "后端尚未提供" : "导出失败", { tone: "error" })
    const b = await r.blob()
    const a = document.createElement("a")
    a.href = URL.createObjectURL(b)
    a.download = `生成记录_${rowKeys ? `${rowKeys.length}条` : "全部"}.xlsx`
    a.click()
    URL.revokeObjectURL(a.href)
  })
}

const RecSkeleton = ({ grid }: { grid: boolean }) =>
  grid ? (
    <div className="task-grid">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="stack" style={{ gap: 8 }}>
          <Skel h={112} r={8} />
          <Skel h={12} />
        </div>
      ))}
    </div>
  ) : (
    <div className="rec-list">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="rec-row" style={{ cursor: "default" }}>
          <span />
          <Skel w={64} h={64} r={8} />
          <div className="stack" style={{ gap: 8 }}>
            <Skel h={13} />
            <Skel w="40%" h={12} />
          </div>
        </div>
      ))}
    </div>
  )

const RecList = ({ rows, grid, sel, toggle, verdicts, scope, onOpen, onAll }: { rows: RecordRow[]; grid: boolean; sel: Set<string>; toggle: (k: string) => void; verdicts: Map<string, { verdict: "good" | "ok" | "bad"; note: string }>; scope: Scope; onOpen: (i: number) => void; onAll?: (on: boolean) => void }) => {
  const on = rows.filter((r) => sel.has(r.task.rowKey)).length
  if (grid)
    return (
      <div className="task-grid">
        {rows.map((r, i) => (
          <RecCard key={r.task.rowKey} r={r} on={sel.has(r.task.rowKey)} toggle={() => toggle(r.task.rowKey)} v={verdicts.get(r.task.rowKey)} onOpen={() => onOpen(i)} />
        ))}
      </div>
    )
  return (
    <div className="rec-list">
      {onAll && (
        <div className="rec-row head">
          <Checkbox checked={on > 0 && on === rows.length} mixed={on > 0 && on < rows.length} onChange={onAll} />
          <span className="faint">{on ? `已选 ${on}` : "选择记录后可以批量分析或导出"}</span>
        </div>
      )}
      {rows.map((r, i) => (
        <RecRow key={r.task.rowKey} r={r} on={sel.has(r.task.rowKey)} toggle={() => toggle(r.task.rowKey)} v={verdicts.get(r.task.rowKey)} showLine={scope === "all"} onOpen={() => onOpen(i)} />
      ))}
    </div>
  )
}

const ResultDot = ({ t }: { t: Task }) => (
  <Tooltip content={t.failed ? `失败 · ${t.failure ? failureName[t.failure.category] : ""}` : t.downloaded ? "已下载" : "未下载"}>
    <span className={cx("dl-dot", t.downloaded && "on", t.failed && "fail")} />
  </Tooltip>
)

const RecRow = ({ r, on, toggle, v, showLine, onOpen }: { r: RecordRow; on: boolean; toggle: () => void; v?: { verdict: "good" | "ok" | "bad"; note: string }; showLine: boolean; onOpen: () => void }) => {
  const t = r.task
  const out = t.outputs[0] ?? null
  const input = t.inputs[0] ?? null
  const link = fdUrl(t)
  return (
    <div className={cx("rec-row", on && "on")} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <span onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={on} onChange={toggle} />
      </span>
      <div className="rec-media">
        <Thumb media={out ?? input} w={64} ratio={1} radius={8} dim={!out} />
        {out && input && t.line === "inspiration" && (
          <span className="rec-inset">
            <Thumb media={input} w={26} ratio={1} radius={4} />
          </span>
        )}
        {t.outputs.length > 1 && <span className="rec-n num">{t.outputs.length}</span>}
      </div>
      <div className="rec-body">
        <div className="rec-p">{t.prompt || <span className="faint">没有提示词</span>}</div>
        <div className="rec-m">
          <ResultDot t={t} />
          <span className="num">{time(t.createdAt)}</span>
          {showLine && <span className={cx("rec-line", t.line)}>{lineName[t.line]}</span>}
          <span>{t.line === "inspiration" ? t.intent ?? t.mode : t.mode}</span>
          {t.user && <span className="ellipsis" style={{ maxWidth: 90 }}>{t.user.name}</span>}
          <span className="ellipsis faint" style={{ maxWidth: 150 }}>{t.model}</span>
          {r.sampleReason && <Badge tone={strataTone[r.sampleReason]}>{strataName[r.sampleReason]}</Badge>}
        </div>
        {r.lastAnnotation && (
          <div className="rec-note">
            <Icon name="edit" size="xs" />
            <span className="ellipsis">{r.lastAnnotation.text}</span>
          </div>
        )}
      </div>
      <div className="rec-side">
        {v && (
          <Tooltip content={v.note}>
            <span className={cx("rec-verdict", v.verdict)}>{verdictName[v.verdict]}</span>
          </Tooltip>
        )}
        {r.annotationCount > 0 && (
          <span className="rec-ann num">
            <Icon name="edit" size="xs" />
            {r.annotationCount}
          </span>
        )}
        {link && (
          <Tooltip content="在 FD 中打开">
            <a className="fd-link" href={link} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} aria-label="在 FD 中打开">
              <Icon name="external" size="xs" />
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

const RecCard = ({ r, on, toggle, v, onOpen }: { r: RecordRow; on: boolean; toggle: () => void; v?: { verdict: "good" | "ok" | "bad"; note: string }; onOpen: () => void }) => {
  const t = r.task
  const out = t.outputs[0] ?? null
  return (
    <div className={cx("task-card", on && "on")} role="button" tabIndex={0} onClick={onOpen}>
      <div className="media">
        <Thumb media={out ?? t.inputs[0]} w="100%" ratio={4 / 3} dim={!out} />
        <span className="rec-check" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={on} onChange={toggle} />
        </span>
        <span className="tag">
          {r.sampleReason && <Badge tone={strataTone[r.sampleReason]}>{strataName[r.sampleReason]}</Badge>}
          {v && <span className={cx("rec-verdict", v.verdict)}>{verdictName[v.verdict]}</span>}
        </span>
      </div>
      <div className="p">{t.prompt}</div>
      <div className="m">
        <ResultDot t={t} />
        <span className="num">{time(t.createdAt)}</span>
        <span className="spacer" />
        {r.annotationCount > 0 && (
          <span className="rec-ann num">
            <Icon name="edit" size="xs" />
            {r.annotationCount}
          </span>
        )}
      </div>
    </div>
  )
}

const SampleView = ({ id, scope, week, grid, sel, toggle, setSel, verdicts, onOpen }: { id: string; scope: Scope; week: string | null; grid: boolean; sel: Set<string>; toggle: (k: string) => void; setSel: (s: Set<string>) => void; verdicts: Map<string, { verdict: "good" | "ok" | "bad"; note: string }>; onOpen: (rows: RecordRow[], i: number) => void }) => {
  const [range, setRange] = useState<Range>("all")
  const [size, setSize] = useState("24")
  const [seen, setSeen] = useState<string[]>([])
  const run = useMutation({ mutationFn: (seed: number) => call("POST /api/records/sample", { body: { enterprise: id, scope, ...rangeOf(range, week), size: Number(size), seed, exclude: seen.slice(-300) } }) })
  const [res, setRes] = useState<SampleResult | null>(null)
  const go = (fresh: boolean) => {
    const seed = fresh ? Math.floor(Math.random() * 1e9) : res?.seed ?? Math.floor(Math.random() * 1e9)
    run.mutate(seed, {
      onSuccess: (r) => {
        setRes(r)
        setSeen((s) => [...s, ...r.items.map((x) => x.task.rowKey)])
      },
    })
  }
  useEffect(() => {
    setRes(null)
    setSeen([])
    go(true)
  }, [id, scope, range, size])
  const items = res?.items ?? []
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="rec-filters">
        <Segmented size="sm" value={range} onChange={setRange} options={(["all", "12w", "4w", "week"] as Range[]).map((r) => ({ value: r, label: r === "week" && week ? `${weekShort(week)} 周` : rangeName[r] }))} />
        <Segmented size="sm" value={size} onChange={setSize} options={["12", "24", "48"].map((n) => ({ value: n, label: `${n} 条` }))} />
        <span className="spacer" />
        <Button size="sm" icon="refresh" loading={run.isPending} onClick={() => go(true)}>
          换一批
        </Button>
        {items.length > 0 && (
          <Button size="sm" variant="soft" icon="check" onClick={() => setSel(new Set(items.map((r) => r.task.rowKey)))}>
            全选这批
          </Button>
        )}
      </div>
      {run.isError ? (
        missing(run.error) ? (
          <Empty icon="sparkle" title="后端尚未提供" text="价值抽样需要后端接口，计划见 RECORDS-REWORK.md" compact />
        ) : (
          <ErrorState error={run.error} retry={() => go(false)} />
        )
      ) : !res ? (
        <RecSkeleton grid={grid} />
      ) : (
        <>
          <div className="rec-cover">
            <div className="rc-strata">
              {res.coverage
                .filter((c) => c.available > 0)
                .map((c) => (
                  <span key={c.stratum} className={cx("rc-chip", c.picked === 0 && "zero")}>
                    {strataName[c.stratum]}
                    <b className="num">{c.picked}</b>
                    <span className="faint num">/ {num(c.available)}</span>
                  </span>
                ))}
            </div>
            <div className="rc-dims num">
              覆盖 <b>{res.dims.intents}</b> 种类型 · <b>{res.dims.models}</b> 个模型 · <b>{res.dims.users}</b> 位成员 · <b>{res.dims.weeks}</b> 周
              {res.dims.lines.length > 1 && <> · 两条线</>}
            </div>
          </div>
          {items.length ? <RecList rows={items} grid={grid} sel={sel} toggle={toggle} verdicts={verdicts} scope={scope} onOpen={(i) => onOpen(items, i)} /> : <Empty icon="layers" title="这个范围没有记录" compact />}
        </>
      )}
    </div>
  )
}

const SelectionBar = ({ id, sel, clear, scope }: { id: string; sel: Set<string>; clear: () => void; scope: Scope }) => {
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const run = useMutation({
    mutationFn: () => call("POST /api/records/analyses", { body: { enterprise: id, rowKeys: [...sel], question: q.trim() || undefined } }),
    onSuccess: () => {
      toast("已开始分析")
      setQ("")
      clear()
      qc.invalidateQueries({ queryKey: ["GET /api/records/analyses"] })
    },
    onError: (e) => toast(errorText(e), { tone: "error" }),
  })
  if (!sel.size) return null
  const over = sel.size > 40
  return (
    <div className="rec-bar">
      <span className="num">
        已选 <b>{sel.size}</b>
      </span>
      <Input size="sm" placeholder="想看什么（可不填）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !over && run.mutate()} style={{ width: 240 }} />
      <Tooltip content={over ? "一次最多 40 条" : "模型看提示词、输入图和结果，给出结论"}>
        <Button size="sm" variant="primary" icon="wand" loading={run.isPending} disabled={over} onClick={() => run.mutate()}>
          分析
        </Button>
      </Tooltip>
      <Button size="sm" icon="download" onClick={() => exportRecords(id, scope, [...sel])}>
        导出
      </Button>
      <IconButton size="sm" icon="x" label="取消选择" onClick={clear} />
    </div>
  )
}

const AnalysesPanel = ({ id, q, onOpen }: { id: string; q: ReturnType<typeof useRecordAnalyses>; onOpen: (rows: RecordRow[], i: number) => void }) => {
  const [all, setAll] = useState(false)
  const qc = useQueryClient()
  const list = [...(q.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  if (!list.length) return null
  const shown = all ? list : list.slice(0, 1)
  const del = async (a: RecordAnalysis) => {
    try {
      await call("DELETE /api/records/analyses/:id", { params: { id: a.id } })
      qc.invalidateQueries({ queryKey: ["GET /api/records/analyses"] })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  void id
  return (
    <div className="ra">
      {shown.map((a) => (
        <AnalysisCard key={a.id} a={a} onOpen={onOpen} onDelete={() => del(a)} />
      ))}
      {list.length > 1 && (
        <button className="pf-more" onClick={() => setAll(!all)}>
          <Icon name={all ? "chevUp" : "chevDown"} size="xs" />
          {all ? "收起" : `更早的 ${list.length - 1} 次分析`}
        </button>
      )}
    </div>
  )
}

const AnalysisCard = ({ a, onOpen, onDelete }: { a: RecordAnalysis; onOpen: (rows: RecordRow[], i: number) => void; onDelete: () => void }) => {
  const running = a.state === "queued" || a.state === "running"
  const open = (k: string) => {
    const i = a.records.findIndex((r) => r.task.rowKey === k)
    if (i >= 0) onOpen(a.records, i)
  }
  const tally = { good: a.perRecord.filter((p) => p.verdict === "good").length, ok: a.perRecord.filter((p) => p.verdict === "ok").length, bad: a.perRecord.filter((p) => p.verdict === "bad").length }
  return (
    <div className="ra-card">
      <div className="ra-h">
        <Icon name="wand" size="sm" />
        <span className="num">{time(a.createdAt)}</span>
        <span className="faint num">{a.rowKeys.length} 条记录</span>
        {a.question && <span className="ra-q ellipsis">“{a.question}”</span>}
        <span className="spacer" />
        {a.state === "done" && a.perRecord.length > 0 && (
          <span className="ra-tally num">
            <span className="rec-verdict good">{tally.good}</span>
            <span className="rec-verdict ok">{tally.ok}</span>
            <span className="rec-verdict bad">{tally.bad}</span>
          </span>
        )}
        <IconButton size="xs" icon="trash" label="删除" onClick={onDelete} />
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
          <div className="ra-head">{a.headline}</div>
          <div className="ra-findings">
            {a.findings.map((x) => (
              <div key={x.id} className="ra-f">
                <ConfidenceDot c={x.confidence} />
                <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                  <span>{x.text}</span>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {x.evidence.map((e, i) => (
                      <EvidenceChip key={i} e={e} />
                    ))}
                    {x.rowKeys.map((k) => {
                      const r = a.records.find((y) => y.task.rowKey === k)
                      return r ? (
                        <button key={k} className="ra-thumb" onClick={() => open(k)}>
                          <Thumb media={r.task.outputs[0] ?? r.task.inputs[0]} w={30} ratio={1} radius={5} />
                        </button>
                      ) : null
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {a.suggestions.length > 0 && (
            <div className="ra-sugs">
              {a.suggestions.map((s, i) => (
                <div key={i} className="mv-action">
                  <Icon name="target" size="xs" />
                  <span className="grow">{s}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const RecordSide = ({ t, anns, verdict, reason, selected, toggle }: { t: Task; anns: Annotation[]; verdict: { verdict: "good" | "ok" | "bad"; note: string } | null; reason: SampleStratum | null; selected: boolean; toggle: () => void }) => {
  const mine = anns.filter((a) => a.anchor?.block === recordBlock(t.rowKey)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest("input, textarea, [contenteditable]")) return
      if (e.key === "x") toggle()
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [toggle])
  return (
    <div className="sec rec-side-sec">
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <Checkbox checked={selected} onChange={toggle}>选中</Checkbox>
        <span className="kbd-hint faint">X</span>
        <span className="spacer" />
        {reason && <Badge tone={strataTone[reason]}>{strataName[reason]}</Badge>}
        {verdict && (
          <Tooltip content={verdict.note}>
            <Badge tone={verdictTone[verdict.verdict]}>模型判断 · {verdictName[verdict.verdict]}</Badge>
          </Tooltip>
        )}
      </div>
      {verdict && <div className="rec-vnote">{verdict.note}</div>}
      <span className="label">批注{mine.length ? ` · ${mine.length}` : ""}</span>
      <div className="stack" style={{ gap: 10, marginTop: 8 }}>
        {mine.map((a) => (
          <Thread key={a.id} a={a} />
        ))}
        <Composer key={t.rowKey} anchor={{ block: recordBlock(t.rowKey), quote: t.prompt.slice(0, 60) || t.sourceId }} placeholder="给这条记录写批注，⌘↵ 保存" />
      </div>
    </div>
  )
}
