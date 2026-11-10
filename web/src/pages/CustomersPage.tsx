import { useEffect, useMemo, useRef, useState } from "react"
import type { AlertKind, Level, Line, Movement, Pool, RosterRow, TouchSlot } from "@spec/contract"
import { useRoster } from "../api/hooks"
import { call, url } from "../api/client"
import { useQueryClient } from "@tanstack/react-query"
import { useCtx } from "../lib/ctx"
import { alertName, kindName, levelName, levelOrder, lineName, movementName, poolName, poolOrder, slotName } from "../lib/labels"
import { navigate } from "../lib/route"
import { ago, compact, num, pct } from "../lib/format"
import { useKey } from "../lib/useKey"
import { Button, Checkbox, Input, Tabs, cx } from "../ui/controls"
import { Avatar, Badge, Card, Delta, Empty, ErrorState, LevelTag, Rate, Skel } from "../ui/display"
import { Spark } from "../ui/charts"
import { Icon } from "../ui/icons"
import { FilterChip, Menu, Tooltip, toast } from "../ui/overlays"
import { MovementTag } from "./bits"
import { StatusTag } from "./bits"

type SortKey = "name" | "level" | "tasks" | "delta" | "rate" | "share" | "stuck" | "last" | "ppd"
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
}

export const exportFile = async (href: string, name: string) => {
  try {
    const response = await fetch(href)
    if (!response.ok) throw new Error((await response.json()).message)
    if (!(response.headers.get("content-type") ?? "").includes("spreadsheetml")) throw new Error("导出接口未返回 Excel 文件")
    const objectUrl = URL.createObjectURL(await response.blob())
    const a = document.createElement("a")
    a.href = objectUrl
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (e) {
    toast((e as Error).message, { tone: "error" })
  }
}

export const CustomersPage = () => {
  const { line, week, route } = useCtx()
  const [models, setModels] = useState<string[]>([])
  const q = useRoster(line, week, models[0])
  const qc = useQueryClient()
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "tasks", dir: -1 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState(-1)
  const [batchBusy, setBatchBusy] = useState(false)
  const [intent, setIntent] = useState<string[]>([])
  const [kind, setKind] = useState<string[]>([])
  const [search, setSearch] = useState(route.q)
  const tbody = useRef<HTMLTableSectionElement>(null)
  useEffect(() => setSelected(new Set()), [line, week])
  useEffect(() => setModels([]), [line, week])
  const rows = q.data?.rows ?? []
  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner.sales).filter(Boolean) as string[])].sort(), [rows])
  const intents = useMemo(() => {
    const m = new Map<string, number>()
    rows.forEach((r) => {
      const k = r.inspiration?.topIntent ?? r.video?.topMode
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    })
    return [...m].sort((a, b) => b[1] - a[1])
  }, [rows])
  const alertCounts = useMemo(() => {
    const m = new Map<AlertKind, number>()
    rows.forEach((r) => r.alerts.forEach((a) => m.set(a, (m.get(a) ?? 0) + 1)))
    return m
  }, [rows])
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    let xs = rows.filter(
      (r) =>
        (route.pool === "all" || r.pool === route.pool) &&
        (!route.level || r.level === route.level) &&
        (!route.movement || r.movement === route.movement) &&
        (!route.alert || r.alerts.includes(route.alert)) &&
        (!route.owner || r.owner.sales === route.owner) &&
        (!intent.length || intent.includes(r.inspiration?.topIntent ?? r.video?.topMode ?? "")) &&
        (!kind.length || kind.includes(r.enterprise.kind)) &&
        (!s || r.enterprise.name.toLowerCase().includes(s) || (r.owner.sales ?? "").includes(s)),
    )
    const f = sorters[sort.key]
    xs = [...xs].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      return (typeof x === "string" ? x.localeCompare(y as string, "zh") : (x as number) - (y as number)) * sort.dir
    })
    return xs
  }, [rows, route.pool, route.level, route.movement, route.alert, route.owner, intent, kind, search, sort])
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
  const createTouches = async (slot: TouchSlot) => {
    if (batchBusy) return
    setBatchBusy(true)
    const list = rows.filter((r) => selected.has(r.enterprise.id))
    let completed = 0
    try {
      for (const r of list) {
        await call("POST /api/touches", { body: { line, week: week!, slot, enterprise: r.enterprise.id, goal: r.pool ?? "nurture", draft: r.nextAction?.text, owner: r.owner.sales ?? undefined, source: "manual" } })
        completed += 1
        setSelected(previous => { const next = new Set(previous); next.delete(r.enterprise.id); return next })
      }
      toast(`已在${slotName[slot]}建了 ${list.length} 张触达卡片`, { tone: "ok", action: { label: "查看", run: () => navigate({ page: "touches" }) } })
      setSelected(new Set())
    } catch (e: any) {
      toast(`已创建 ${completed} 张，创建中断：${e.message}`, { tone: "error" })
    } finally {
      qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises"] })
      setBatchBusy(false)
    }
  }
  const pc = q.data?.poolCounts
  const insp = line === "inspiration"
  const active = filtered.filter((r) => r.tasks > 0).length
  const anyFilter = route.level || route.movement || route.alert || route.owner || intent.length || kind.length || models.length || search
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>客户</h1>
          <div className="meta">
            {q.data ? (
              <>
                <span>
                  {lineName[line]} · 共 <b className="num" style={{ color: "var(--ink)" }}>{rows.length}</b> 家
                </span>
                <span className="faint">本周活跃 {rows.filter((r) => r.tasks > 0).length} 家</span>
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
        <Input icon="search" size="sm" quiet placeholder="企业或负责人" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} style={{ width: 200 }} />
        <FilterChip label="层级" value={route.level ? [route.level] : []} onChange={(v) => navigate({ level: (v[0] as Level) ?? null }, { replace: true })} options={levelOrder.map((l) => ({ value: l, label: <LevelTag level={l} />, text: levelName[l], count: rows.filter((r) => r.level === l).length }))} />
        <FilterChip label="变动" value={route.movement ? [route.movement] : []} onChange={(v) => navigate({ movement: (v[0] as Movement) ?? null }, { replace: true })} options={(Object.keys(movementName) as Movement[]).map((m) => ({ value: m, label: movementName[m], count: rows.filter((r) => r.movement === m).length })).filter((o) => o.count)} />
        <FilterChip label="预警" value={route.alert ? [route.alert] : []} onChange={(v) => navigate({ alert: (v[0] as AlertKind) ?? null }, { replace: true })} options={[...alertCounts].map(([k, n]) => ({ value: k, label: alertName[k], count: n }))} />
        <FilterChip label={insp ? "任务类型" : "模式"} multi value={intent} onChange={setIntent} options={intents.map(([k, n]) => ({ value: k, label: k, count: n }))} />
        <FilterChip label="模型" value={models} onChange={setModels} options={(q.data?.models ?? []).map(model => ({ value: model, label: model }))} />
        {owners.length > 0 && <FilterChip label="负责人" search value={route.owner ? [route.owner] : []} onChange={(v) => navigate({ owner: v[0] ?? null }, { replace: true })} options={owners.map((o) => ({ value: o, label: o, count: rows.filter((r) => r.owner.sales === o).length }))} />}
        <FilterChip label="类型" multi value={kind} onChange={setKind} options={(["customer", "internal", "agency", "unknown"] as const).map((k) => ({ value: k, label: kindName[k], count: rows.filter((r) => r.enterprise.kind === k).length })).filter((o) => o.count)} />
        {anyFilter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              navigate({ level: null, movement: null, alert: null, owner: null }, { replace: true })
              setIntent([])
              setKind([])
              setModels([])
              setSearch("")
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
                  {th("level", "层级")}
                  <th>变动</th>
                  {th("tasks", insp ? "任务" : "耗点", "r")}
                  {th("delta", "同星期", "r")}
                  {th("rate", "下载率")}
                  <th>{insp ? "主要类型" : "主要模式"}</th>
                  {insp ? th("stuck", <Tooltip content="批量：同一句提示词换图；卡住：同一张图重试或微调"><span>批量 · 卡住</span></Tooltip>, "r") : th("ppd", <Tooltip content="耗点 / 被下载的视频数"><span>每条下载</span></Tooltip>, "r")}
                  {!insp && th("stuck", "未下载耗点", "r")}
                  <th>下一步</th>
                  <th>触达</th>
                  <th>12 周</th>
                  <th className="go" />
                </tr>
              </thead>
              <tbody ref={tbody}>
                {filtered.map((r, i) => (
                  <Row key={r.enterprise.id} r={r} line={line} focus={i === focus} open={route.ent === r.enterprise.id} selected={selected.has(r.enterprise.id)} onToggle={() => toggle(r.enterprise.id)} onOpen={() => (setFocus(i), navigate({ ent: r.enterprise.id }))} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected.size > 0 && (
        <div className="bulkbar">
          <span className="n">已选 {selected.size} 家</span>
          <Menu
            placement="top-start"
            width={200}
            items={(["mon", "wed", "fri"] as TouchSlot[]).map((s) => ({ key: s, label: `${slotName[s]}触达`, icon: "send", onSelect: () => createTouches(s) }))}
            trigger={({ toggle, ref }) => (
              <Button ref={ref as any} size="sm" variant="primary" icon="send" iconRight="chevDown" loading={batchBusy} onClick={toggle}>
                建触达卡片
              </Button>
            )}
          />
          <Button size="sm" icon="download" onClick={() => exportFile(url("GET /api/enterprises/export", { query: { line, week: week!, ids: [...selected] } }), `客户名单_${lineName[line]}_${week}.xlsx`)}>导出所选企业</Button>
          <Button size="sm" variant="ghost" icon="x" onClick={() => setSelected(new Set())}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}

const Row = ({ r, line, focus, open, selected, onToggle, onOpen }: { r: RosterRow; line: Line; focus: boolean; open: boolean; selected: boolean; onToggle: () => void; onOpen: () => void }) => {
  const insp = line === "inspiration"
  const i = r.inspiration
  const v = r.video
  const sparkVals = r.spark.map((p) => (insp ? p.tasks : p.points))
  const trend = r.movement === "drop" || r.movement === "silent" ? "down" : r.movement === "surge" ? "up" : undefined
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
              <span>{r.owner.sales ?? "未分配"}</span>
              <span>·</span>
              <span>{ago(r.lastActiveAt)}</span>
              {!r.downloadSignalReliable ? (
                <Tooltip content={`任务多但几乎不下载，可能用别的方式保存结果${r.excluded ? "；已从对比中排除" : ""}`}>
                  <span className="badge warn">下载存疑</span>
                </Tooltip>
              ) : r.excluded ? (
                <Badge tone="outline">已排除</Badge>
              ) : r.enterprise.kind !== "customer" && r.enterprise.kind !== "unknown" ? (
                <Badge>{kindName[r.enterprise.kind]}</Badge>
              ) : null}
            </span>
          </div>
        </div>
      </td>
      <td>
        <LevelTag level={r.level} />
      </td>
      <td>
        <MovementTag m={r.movement} />
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
            {i && r.tasks ? (
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
      <td>
        {r.nextAction?.text ? (
          <Tooltip content={r.nextAction.text}>
            <div className="next-cell">{r.nextAction.text}</div>
          </Tooltip>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>{r.lastTouch ? <StatusTag s={r.lastTouch.status} /> : <span className="faint">—</span>}</td>
      <td>
        <Spark values={sparkVals} tone={trend} w={50} />
      </td>
      <td className="go">
        <Icon name="chevRight" size="sm" />
      </td>
    </tr>
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
