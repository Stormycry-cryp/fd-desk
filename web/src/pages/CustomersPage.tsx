import { useEffect, useMemo, useRef, useState } from "react"
import type { AlertKind, Level, Line, Movement, Pool, RosterRow } from "@spec/contract"
import type { RosterExtra, TagDimension } from "@spec/contract"
import { useAnalyzeMovement, useMovementPoll, useRosterExtra, useTags, useTrends } from "../api/next"
import type { Trend, TrendKind } from "@spec/contract"
import { trendName, trendOrder, trendText } from "../lib/trend"
import { tagDimName, tagOrder, TagChip, JobProgress } from "../ui/insight"
import { useRoster } from "../api/hooks"
import { call, url } from "../api/client"
import { useQueries } from "@tanstack/react-query"
import { useCtx } from "../lib/ctx"
import { alertName, levelName, levelOrder, lineName, movementName, poolName, poolOrder } from "../lib/labels"
import { navigate } from "../lib/route"
import { ago, compact, num, pct, time } from "../lib/format"
import { useKey } from "../lib/useKey"
import { download } from "../lib/download"
import { Button, Checkbox, Input, Tabs, cx } from "../ui/controls"
import { Avatar, Badge, Card, Delta, Empty, ErrorState, LevelTag, Rate, Skel } from "../ui/display"
import { Spark } from "../ui/charts"
import { Icon } from "../ui/icons"
import { FilterChip, Menu, Tooltip } from "../ui/overlays"
import { MovementTag } from "./bits"
import { accountOf, isLow, ownerMatch, ownerOf, ownersFromRows, useOwners } from "../lib/accounts"
import { OwnerCell, PointsCell, PointsTag } from "../ui/points"

type SortKey = "name" | "level" | "tasks" | "delta" | "rate" | "share" | "stuck" | "last" | "ppd" | "points"
const levelRank = (l: Level | null) => (l ? 5 - levelOrder.indexOf(l) : 0)

const sorters: Record<SortKey, (r: RosterRow) => number | string> = {
  name: (r) => r.enterprise.name,
  level: (r) => levelRank(r.level) * 1e6 + r.tasks,
  tasks: (r) => (r.video ? r.points : r.tasks),
  delta: (r) => (r.comparable ? r.comparable.current - r.comparable.previous : -Infinity),
  rate: (r) => r.downloadRate ?? -1,
  share: (r) => r.inspiration?.batchShare ?? r.video?.pointShare ?? 0,
  stuck: (r) => r.inspiration?.stuckShare ?? r.video?.notDownloadedPoints ?? 0,
  last: (r) => (r.lastActiveAt ? new Date(r.lastActiveAt).getTime() : 0),
  ppd: (r) => r.video?.pointsPerDownloaded ?? -1,
  points: (r) => {
    const a = accountOf(r)
    return a ? (a.remaining <= 0 ? -1 : a.daysLeft ?? 1e6) : 1e7
  },
}

type AlertKey = AlertKind | "low_points"
const alertsOf = (r: RosterRow): AlertKey[] => {
  const xs = r.alerts as AlertKey[]
  return isLow(accountOf(r)) && !xs.includes("low_points") ? [...xs, "low_points"] : xs
}

export const exportFile = download

export const CustomersPage = () => {
  const { line, week, route } = useCtx()
  const { models, intent, q: search } = route
  const converting = route.pool === "convert"
  const q = useRoster(line, week)
  const modelQs = useQueries({ queries: models.map((m) => ({ queryKey: ["GET /api/enterprises", null, { line, week, model: m }], queryFn: () => call("GET /api/enterprises", { query: { line, week: week!, model: m } }), enabled: !!week, staleTime: 30000 })) })
  const modelSets = useMemo(() => new Map(models.map((m, i) => [m, new Set((modelQs[i]?.data?.rows ?? []).map((r) => r.enterprise.id))])), [models, modelQs.map((x) => x.dataUpdatedAt).join()])
  const extra = useRosterExtra(line, week)
  const tagsQ = useTags(line)
  const analyze = useAnalyzeMovement()
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "tasks", dir: -1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState(-1)
  const tbody = useRef<HTMLTableSectionElement>(null)
  useEffect(() => setSelected(new Set()), [line, week])
  const rows = useMemo(() => (q.data?.rows ?? []).map((r): RosterRow => {
    const c = converting ? r.conversion : null
    return c ? { ...r, tasks: c.tasks, points: c.points, activeDays: c.activeDays, users: c.users,
      comparable: c.comparable, downloadRate: c.downloadRate, lastActiveAt: c.lastActiveAt,
      movement: c.movement, spark: c.spark, downloadSignalReliable: true,
      inspiration: { topIntent: c.topIntent, topIntentShare: c.topIntentShare, mainModel: c.mainModel, batchShare: 0, stuckShare: 0, agentShare: 0 }, video: null } : r
  }), [q.data, converting])
  const ex = useMemo(() => new Map((extra.data ?? []).map((x) => [x.enterpriseId, x])), [extra.data])
  const pending = useMemo(() => (extra.data ?? []).filter((x) => x.movement && (x.movement.state === "queued" || x.movement.state === "running")).map((x) => x.movement!.id), [extra.data])
  useMovementPoll(pending)
  const tagSel = useMemo(() => {
    const m = new Map<TagDimension, string[]>()
    route.tags.forEach((t) => {
      const [d, v] = t.split(":")
      if (d && v) m.set(d as TagDimension, [...(m.get(d as TagDimension) ?? []), v])
    })
    return m
  }, [route.tags])
  const setTag = (d: TagDimension, vs: string[]) => {
    const m = new Map(tagSel)
    if (vs.length) m.set(d, vs)
    else m.delete(d)
    navigate({ tags: [...m].flatMap(([k, xs]) => xs.map((x) => `${k}:${x}`)) }, { replace: true })
  }
  const weekAgo = Date.now() - 7 * 86400000
  const intents = useMemo(() => {
    const m = new Map<string, number>()
    rows.forEach((r) => {
      const k = r.inspiration?.topIntent ?? r.video?.topMode
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    })
    return [...m].sort((a, b) => b[1] - a[1])
  }, [rows])
  const trends = useTrends(line, week, q.data?.rows)
  const trendCounts = useMemo(() => {
    const m = new Map<TrendKind, number>()
    trends.list.forEach((t) => m.set(t.kind, (m.get(t.kind) ?? 0) + 1))
    return m
  }, [trends.list])
  const alertCounts = useMemo(() => {
    const m = new Map<AlertKey, number>()
    rows.forEach((r) => alertsOf(r).forEach((a) => m.set(a, (m.get(a) ?? 0) + 1)))
    return m
  }, [rows])
  const ownersQ = useOwners(line)
  const owners = useMemo(() => {
    const local = ownersFromRows(rows)
    const list = ownersQ.data?.length ? ownersQ.data : local
    const count = new Map(local.map((o) => [`${o.role}:${o.name}`, o.enterprises]))
    return list.map((o) => ({ ...o, enterprises: count.get(`${o.role}:${o.name}`) ?? 0 })).sort((a, b) => (a.role === b.role ? b.enterprises - a.enterprises : a.role === "sales" ? -1 : 1))
  }, [rows, ownersQ.data])
  const hasOwner = owners.length > 0
  const hasPoints = useMemo(() => rows.some((r) => accountOf(r)), [rows])
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    let xs = rows.filter(
      (r) =>
        (route.pool === "all" || r.pool === route.pool) &&
        (!route.level.length || (!!r.level && route.level.includes(r.level))) &&
        (!route.movement.length || route.movement.includes(r.movement)) &&
        (!route.alert.length || route.alert.some((a) => alertsOf(r).includes(a))) &&
        (!route.owner || ownerMatch(ownerOf(r), route.owner)) &&
        (!route.trend.length || (!!trends.map.get(r.enterprise.id) && route.trend.includes(trends.map.get(r.enterprise.id)!.kind))) &&
        (!models.length || models.some((m) => modelSets.get(m)?.has(r.enterprise.id))) &&
        (!intent.length || intent.includes(r.inspiration?.topIntent ?? r.video?.topMode ?? "")) &&
        [...tagSel].every(([d, vs]) => ex.get(r.enterprise.id)?.tags.some((t) => t.dimension === d && vs.includes(t.value))) &&
        (!route.noted.length || route.noted.some((n) => (n === "any" ? (ex.get(r.enterprise.id)?.annotationCount ?? 0) > 0 : !!ex.get(r.enterprise.id)?.lastAnnotation && new Date(ex.get(r.enterprise.id)!.lastAnnotation!.at).getTime() >= weekAgo))) &&
        (!s || r.enterprise.name.toLowerCase().includes(s) || (ex.get(r.enterprise.id)?.headline ?? "").toLowerCase().includes(s)),
    )
    const f = sorters[sort.key]
    xs = [...xs].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      return (typeof x === "string" ? x.localeCompare(y as string, "zh") : (x as number) - (y as number)) * sort.dir
    })
    return xs
  }, [rows, route.pool, route.level, route.movement, route.alert, route.owner, route.trend, trends.map, intent, models, modelSets, tagSel, route.noted, ex, search, sort])
  useEffect(() => setFocus(-1), [filtered.length, route.pool])
  useEffect(() => {
    if (focus >= 0) tbody.current?.children[focus]?.scrollIntoView({ block: "nearest" })
  }, [focus])
  useKey(
    (e) => {
      if (route.ent && document.querySelector(".drawer")) {
        if (e.key === "j" || e.key === "k") {
          const i = filtered.findIndex((r) => r.enterprise.id === route.ent)
          const n = filtered[Math.max(0, Math.min(filtered.length - 1, i + (e.key === "j" ? 1 : -1)))]
          if (n) {
            setFocus(filtered.indexOf(n))
            navigate({ ent: n.enterprise.id }, { replace: true })
          }
        }
        return
      }
      if (e.key === "j" || e.key === "ArrowDown") (e.preventDefault(), setFocus((v) => Math.min(filtered.length - 1, v + 1)))
      if (e.key === "k" || e.key === "ArrowUp") (e.preventDefault(), setFocus((v) => Math.max(0, v - 1)))
      if (e.key === "Enter" && filtered[focus]) navigate({ ent: filtered[focus].enterprise.id })
      if (e.key === "x" && filtered[focus]) toggle(filtered[focus].enterprise.id)
      if (e.key === "Escape" && selected.size) setSelected(new Set())
    },
    [filtered, focus, route.ent, selected],
  )
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const allOn = filtered.length > 0 && filtered.every((r) => selected.has(r.enterprise.id))
  const someOn = filtered.some((r) => selected.has(r.enterprise.id))
  const th = (key: SortKey, label: React.ReactNode, cls = "") => (
    <th className={cx("sortable", cls, sort.key === key && "sorted", sort.key === key && sort.dir === 1 && "asc")} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === -1 ? 1 : -1) : key === "name" ? 1 : -1 }))}>
      <span className="sort">
        {label}
        <svg viewBox="0 0 10 10">
          <path d="M5 1.5v7M2 5.5l3 3 3-3" />
        </svg>
      </span>
    </th>
  )
  const pc = q.data?.poolCounts
  const insp = converting || line === "inspiration"
  const active = filtered.filter((r) => r.tasks > 0).length
  const anyFilter = !!route.owner || route.level.length || route.movement.length || route.alert.length || route.trend.length || intent.length || models.length || search || tagSel.size || route.noted.length
  const tagCount = (d: TagDimension, v: string) => (extra.data ?? []).filter((x) => x.tags.some((t) => t.dimension === d && t.value === v)).length
  const noteAny = (extra.data ?? []).filter((x) => x.annotationCount > 0).length
  const noteRecent = (extra.data ?? []).filter((x) => x.lastAnnotation && new Date(x.lastAnnotation.at).getTime() >= weekAgo).length
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>客户</h1>
          <div className="meta">
            {q.data ? (
              <>
                <span>
                  {converting ? "自由改款 · 转化候选" : lineName[line]} · 共 <b className="num" style={{ color: "var(--ink)" }}>{converting ? rows.filter((r) => r.pool === "convert").length : rows.length}</b> 家
                </span>
                <span className="faint">本周活跃 {rows.filter((r) => r.tasks > 0 && (!converting || r.pool === "convert")).length} 家</span>
              </>
            ) : (
              <Skel w={160} />
            )}
          </div>
        </div>
        <div className="actions">
          <Menu
            width={220}
            items={[
              { key: "all", label: "导出当前页签", icon: "download", hint: route.pool === "all" ? "全部企业" : poolName[route.pool as Pool], onSelect: () => exportFile(url("GET /api/enterprises/export", { query: { line, week: week!, pool: route.pool === "all" ? undefined : (route.pool as Pool) } }), `客户名单_${lineName[line]}_${week}.xlsx`) },
              { key: "full", label: "导出全部企业", icon: "download", onSelect: () => exportFile(url("GET /api/enterprises/export", { query: { line, week: week! } }), `客户名单_${lineName[line]}_${week}.xlsx`) },
            ]}
            trigger={({ toggle, ref, open }) => (
              <Button ref={ref as any} icon="download" iconRight="chevDown" onClick={toggle} active={open}>
                导出
              </Button>
            )}
          />
        </div>
      </div>
      <Tabs
        value={route.pool}
        onChange={(v) => navigate({ pool: v }, { replace: true })}
        options={[{ value: "all" as const, label: "全部", count: rows.length }, ...poolOrder.map((p) => ({ value: p, label: poolName[p], count: pc?.[p] ?? 0 }))]}
      />
      <div className="toolbar">
        <Input icon="search" size="sm" quiet placeholder="企业或档案" value={search} onChange={(e) => navigate({ q: e.target.value }, { replace: true })} onClear={() => navigate({ q: "" }, { replace: true })} style={{ width: 200 }} />
        <FilterChip label="层级" multi value={route.level} onChange={(v) => navigate({ level: v as Level[] }, { replace: true })} options={levelOrder.map((l) => ({ value: l, label: <LevelTag level={l} />, text: levelName[l], count: rows.filter((r) => r.level === l).length }))} />
        <FilterChip label="变动" multi value={route.movement} onChange={(v) => navigate({ movement: v as Movement[] }, { replace: true })} options={(Object.keys(movementName) as Movement[]).map((m) => ({ value: m, label: movementName[m], count: rows.filter((r) => r.movement === m).length })).filter((o) => o.count)} />
        <FilterChip label="多周趋势" multi value={route.trend} onChange={(v) => navigate({ trend: v as TrendKind[] }, { replace: true })} options={trendOrder.map((k) => ({ value: k, label: <span className={cx("trend-opt", k)}><i />{trendName[k]}</span>, text: trendName[k], count: trendCounts.get(k) ?? 0 }))} />
        {hasOwner && <FilterChip label="负责人" icon="user" search value={route.owner ? [route.owner] : []} onChange={(v) => navigate({ owner: v[0] ?? null }, { replace: true })} options={owners.map((o) => ({ value: o.name, label: o.name, count: o.enterprises, group: o.role === "sales" ? "销售" : "售后" })).filter((o, i, xs) => xs.findIndex((x) => x.value === o.value) === i)} />}
        <FilterChip label="预警" multi value={route.alert as AlertKey[]} onChange={(v) => navigate({ alert: v as AlertKind[] }, { replace: true })} options={[...alertCounts].sort((a, b) => (a[0] === "low_points" ? -1 : b[0] === "low_points" ? 1 : 0)).map(([k, n]) => ({ value: k, label: alertName[k], count: n }))} />
        <FilterChip label={insp ? "任务类型" : "模式"} multi value={intent} onChange={(v) => navigate({ intent: v }, { replace: true })} options={intents.map(([k, n]) => ({ value: k, label: k, count: n }))} />
        <FilterChip label="模型" multi search value={models} onChange={(v) => navigate({ models: v }, { replace: true })} options={(q.data?.models ?? []).map((model) => ({ value: model, label: model, count: modelSets.get(model)?.size }))} />
        {tagOrder.map((d) => {
          const opts = (tagsQ.data?.find((t) => t.dimension === d)?.values ?? []).filter((x) => x.count > 0)
          return opts.length ? <FilterChip key={d} label={tagDimName[d]} multi value={tagSel.get(d) ?? []} onChange={(v) => setTag(d, v)} options={opts.map((x) => ({ value: x.value, label: x.value, count: tagCount(d, x.value) }))} /> : null
        })}
        <FilterChip label="批注" multi value={route.noted} onChange={(v) => navigate({ noted: v as ("any" | "recent")[] }, { replace: true })} options={[{ value: "any", label: "有批注", count: noteAny }, { value: "recent", label: "近 7 天有跟进", count: noteRecent }]} />
        {!!anyFilter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              navigate({ level: [], movement: [], alert: [], trend: [], models: [], intent: [], q: "", owner: null, tags: [], noted: [] }, { replace: true })
            }}
          >
            清除
          </Button>
        )}
        <span className="spacer" />
        <span className="faint num" style={{ fontSize: 13 }}>
          {filtered.length} 家 · 活跃 {active}
        </span>
      </div>
      <Card flush className="roster-card">
        {q.isLoading ? (
          <RosterSkeleton />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !filtered.length ? (
          <Empty icon="users" title="没有符合条件的企业" text="换个页签或清除筛选" />
        ) : (
          <div className="table-wrap">
            <table className="table clickable flush">
              <thead>
                <tr>
                  <th className="sel">
                    <Checkbox checked={allOn} mixed={someOn} onChange={(v) => setSelected(v ? new Set(filtered.map((r) => r.enterprise.id)) : new Set())} />
                  </th>
                  {th("name", "企业")}
                  {converting ? <th>活跃天数</th> : th("level", "层级")}
                  <th>变动</th>
                  {th("tasks", insp ? "任务" : "耗点", "r")}
                  {th("delta", "同星期", "r")}
                  {th("rate", "下载率")}
                  <th>{converting ? <Tooltip content="按自由改款提示词的关键词归类"><span>主要任务</span></Tooltip> : insp ? "主要类型" : "主要模式"}</th>
                  {converting ? <th className="r">近四周任务</th> : insp ? th("stuck", <Tooltip content="批量：同一句提示词换图；卡住：同一张图重试或微调"><span>批量 · 卡住</span></Tooltip>, "r") : th("ppd", <Tooltip content="耗点 / 被下载的视频数"><span>每条下载</span></Tooltip>, "r")}
                  {!insp && th("stuck", "未下载耗点", "r")}
                  {hasPoints && th("points", <Tooltip content="剩余点数 · 按近 7 天速度还能用多久"><span>剩余点数</span></Tooltip>)}
                  {hasOwner && <th>销售 · 售后</th>}
                  <th>{converting ? "转化依据与建议" : "档案"}</th>
                  <th>最近批注</th>
                  <th>12 周</th>
                  <th className="go" />
                </tr>
              </thead>
              <tbody ref={tbody}>
                {filtered.map((r, i) => (
                  <Row key={r.enterprise.id} r={r} x={ex.get(r.enterprise.id)} cols={{ points: hasPoints, owner: hasOwner }} tr={converting ? undefined : trends.map.get(r.enterprise.id)} onAnalyze={() => analyze.mutate({ enterprise: r.enterprise.id, line, week: week! })} line={line} converting={converting} focus={i === focus} open={route.ent === r.enterprise.id} selected={selected.has(r.enterprise.id)} onToggle={() => toggle(r.enterprise.id)} onOpen={() => (setFocus(i), navigate({ ent: r.enterprise.id }))} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected.size > 0 && (
        <div className="bulkbar">
          <span className="n">已选 {selected.size} 家</span>
          <Button size="sm" variant="primary" icon="printer" onClick={() => window.open(`/print/profiles?ids=${[...selected].join(",")}`, "_blank", "noopener")}>
            打印档案
          </Button>
          <Button size="sm" icon="download" onClick={() => exportFile(url("GET /api/enterprises/export", { query: { line, week: week!, ids: [...selected] } }), `客户名单_${lineName[line]}_${week}.xlsx`)}>导出所选企业</Button>
          <Button size="sm" variant="ghost" icon="x" onClick={() => setSelected(new Set())}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

const Row = ({ r, x, cols, tr, onAnalyze, line, converting, focus, open, selected, onToggle, onOpen }: { r: RosterRow; x: RosterExtra | undefined; cols: { points: boolean; owner: boolean }; tr: Trend | undefined; onAnalyze: () => void; line: Line; converting: boolean; focus: boolean; open: boolean; selected: boolean; onToggle: () => void; onOpen: () => void }) => {
  const insp = converting || line === "inspiration"
  const i = r.inspiration
  const v = r.video
  const sparkVals = r.spark.map((p) => (insp ? p.tasks : p.points))
  const trend = tr || r.movement === "drop" || r.movement === "silent" ? "down" : r.movement === "surge" ? "up" : undefined
  return (
    <tr className={cx(focus && "focus", selected && "selected", open && "open", !r.tasks && "dim")} onClick={onOpen}>
      <td className="sel" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onChange={onToggle} />
      </td>
      <td>
        <div className="ent-cell">
          <Avatar name={r.enterprise.name} size={26} square />
          <div className="stack" style={{ minWidth: 0, overflow: "hidden" }}>
            <span className="name">{r.enterprise.name}</span>
            <span className="sub">
              {x?.tags.length ? x.tags.filter((t) => t.dimension !== "rhythm").slice(0, 2).map((t) => <TagChip key={t.dimension} t={t} />) : <span>{ago(r.lastActiveAt)}</span>}
              <PointsTag a={accountOf(r)} />
              {!r.downloadSignalReliable ? (
                <Tooltip content={`任务多但几乎不下载，可能用别的方式保存结果${r.excluded ? "；已从对比中排除" : ""}`}>
                  <span className="badge warn">下载存疑</span>
                </Tooltip>
              ) : r.excluded ? (
                <Badge tone="outline">已排除</Badge>
              ) : null}
            </span>
          </div>
        </div>
      </td>
      <td>
        {converting ? <span className="num">{r.activeDays} 天</span> : <LevelTag level={r.level} />}
      </td>
      <td>
        {converting ? <MovementTag m={r.movement} /> : <MoveCell r={r} x={x} onAnalyze={onAnalyze} />}
      </td>
      <td className="r num">{insp ? num(r.tasks) : compact(r.points)}</td>
      <td className="r">
        {r.comparable ? (
          <Tooltip content={<span className="num">同星期 {num(r.comparable.previous)} → {num(r.comparable.current)}</span>}>
            <span>
              <Delta pair={r.comparable} />
            </span>
          </Tooltip>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>{r.downloadSignalReliable ? <Rate value={r.downloadRate} width={36} /> : <span className="faint num">{pct(r.downloadRate)}</span>}</td>
      <td>
        {(i?.topIntent ?? v?.topMode) ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="ellipsis" style={{ maxWidth: 72 }}>{i?.topIntent ?? v?.topMode}</span>
            <span className="faint num" style={{ fontSize: 13 }}>{pct(i?.topIntentShare ?? v?.topModeShare)}</span>
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      {insp ? (
        <>
          <td className="r num">
            {converting ? num(r.conversion?.recentTasks ?? 0) : i && r.tasks ? (
              <span>
                {pct(i.batchShare)}
                <span className="faint"> · </span>
                <span className={i.stuckShare >= 0.3 ? "down" : ""}>{pct(i.stuckShare)}</span>
              </span>
            ) : (
              <span className="faint">—</span>
            )}
          </td>
        </>
      ) : (
        <>
          <td className="r num">{v?.pointsPerDownloaded != null ? v.pointsPerDownloaded.toFixed(0) : <span className="faint">—</span>}</td>
          <td className="r num">{v && v.notDownloadedPoints ? compact(v.notDownloadedPoints) : <span className="faint">—</span>}</td>
        </>
      )}
      {cols.points && (
        <td>
          <PointsCell a={accountOf(r)} />
        </td>
      )}
      {cols.owner && (
        <td>
          <OwnerCell o={ownerOf(r)} />
        </td>
      )}
      <td>
        {(converting ? r.conversion?.opportunity : x?.headline) ? (
          <Tooltip content={converting ? r.conversion?.opportunity : x?.headline}>
            <div className="next-cell">{converting ? r.conversion?.opportunity : x?.headline}</div>
          </Tooltip>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        {x?.lastAnnotation ? (
          <Tooltip content={<span style={{ whiteSpace: "pre-wrap" }}>{x.lastAnnotation.text}</span>}>
            <div className="note-cell">
              <span className="num">{time(x.lastAnnotation.at).split(" ")[0]}</span>
              <span className="ellipsis">{x.lastAnnotation.text}</span>
            </div>
          </Tooltip>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        <div className="spark-cell">
          <Spark values={sparkVals} tone={trend} w={50} />
          {tr && (
            <Tooltip content={<TrendTip t={tr} />}>
              <span className={cx("trend-tag", tr.kind)}>{trendName[tr.kind]}</span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="go">
        <Icon name="chevRight" size="sm" />
      </td>
    </tr>
  )
}

const MoveCell = ({ r, x, onAnalyze }: { r: RosterRow; x: RosterExtra | undefined; onAnalyze: () => void }) => {
  const m = x?.movement
  const can = r.movement !== "steady" || (r.comparable && r.comparable.previous > 0)
  if (m && (m.state === "queued" || m.state === "running"))
    return (
      <span className="move-cell">
        <MovementTag m={r.movement} />
        <JobProgress state={m.state} label="分析中" />
      </span>
    )
  if (m && m.state === "done")
    return (
      <Tooltip content={m.headline}>
        <span className="move-cell" onClick={(e) => (e.stopPropagation(), navigate({ ent: r.enterprise.id, section: "movement" }))}>
          <MovementTag m={r.movement} />
          <span className={cx("move-why", m.direction)}>{m.headline}</span>
        </span>
      </Tooltip>
    )
  return (
    <span className="move-cell">
      <MovementTag m={r.movement} />
      {can && (
        <button className="move-btn" onClick={(e) => (e.stopPropagation(), onAnalyze())}>
          <Icon name="sparkle" size="xs" />
          分析
        </button>
      )}
    </span>
  )
}

const RosterSkeleton = () => (
  <div style={{ padding: "8px 16px" }}>
    {Array.from({ length: 10 }, (_, i) => (
      <div key={i} className="row" style={{ height: 44, gap: 16, borderBottom: "1px solid var(--line-2)" }}>
        <Skel w={16} h={16} r={4} />
        <Skel w={26} h={26} r={7} />
        <Skel w={180 + (i % 3) * 30} />
        <span className="spacer" />
        <Skel w={50} />
        <Skel w={60} />
        <Skel w={80} />
        <Skel w={72} h={20} />
      </div>
    ))}
  </div>
)

const TrendTip = ({ t }: { t: Trend }) => {
  const max = Math.max(1, ...t.series.map((p) => p.tasks))
  return (
    <div className="trend-tip">
      <b>{trendText(t)}</b>
      <div className="tt-bars">
        {t.series.map((p) => (
          <span key={p.week} style={{ height: `${Math.max(2, (p.tasks / max) * 36)}px` }} title={String(p.tasks)} />
        ))}
      </div>
      <span className="tt-nums num">{t.series.map((p) => p.tasks).join(" · ")}</span>
    </div>
  )
}
