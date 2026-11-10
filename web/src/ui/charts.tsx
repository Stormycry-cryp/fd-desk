import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Level } from "@spec/contract"
import { levelName, levelOrder } from "../lib/labels"
import { cx } from "./controls"

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    setW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  return { ref, w }
}

const niceStep = (v: number) => {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  const m = [1, 2, 2.5, 5, 10].find((x) => n <= x) ?? 10
  return m * p
}

const niceScale = (max: number, ticks: number) => {
  const step = niceStep(Math.max(max, 1) / ticks)
  return { max: step * ticks, step }
}

export const Spark = ({ values, w = 72, h = 22, tone, partial = [] }: { values: (number | null)[]; w?: number; h?: number; tone?: "hi" | "up" | "down"; partial?: boolean[] }) => {
  const vs = values.map((v) => v ?? 0)
  const max = Math.max(...vs, 1)
  const n = vs.length
  if (n < 2 || vs.every((v) => v === 0)) return <svg className="spark" width={w} height={h}><line x1={0} x2={w} y1={h - 1} y2={h - 1} stroke="var(--line)" strokeDasharray="2 3" /></svg>
  const x = (i: number) => (i / (n - 1)) * (w - 4) + 2
  const y = (v: number) => h - 2 - (v / max) * (h - 5)
  const first = vs.findIndex((v) => v > 0)
  const pts = vs.map((v, i) => [x(i), y(v)] as const).slice(Math.max(0, first - 1))
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("")
  const area = `${d}L${pts[pts.length - 1][0]},${h}L${pts[0][0]},${h}Z`
  const last = pts[pts.length - 1]
  return (
    <svg className={cx("spark", tone)} width={w} height={h}>
      <path className="a" d={area} />
      <path className="l" d={d} strokeDasharray={partial[n - 1] ? undefined : undefined} />
      <circle cx={last[0]} cy={last[1]} r={2} style={{ color: tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "hi" ? "var(--accent)" : "var(--ink-3)" }} />
    </svg>
  )
}

export interface Point {
  label: string
  value: number | null
  partial?: boolean
  note?: ReactNode
}

export const TrendChart = ({ points, height = 140, kind = "line", format = (v: number) => String(Math.round(v)), compare, highlight, yTicks = 3 }: { points: Point[]; height?: number; kind?: "line" | "bar"; format?: (v: number) => string; compare?: (number | null)[]; highlight?: number; yTicks?: number }) => {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 32, r: 8, t: 10, b: 22 }
  const iw = Math.max(0, w - pad.l - pad.r)
  const ih = height - pad.t - pad.b
  const scale = niceScale(Math.max(1, ...points.map((p) => p.value ?? 0), ...(compare ?? []).map((v) => v ?? 0)), yTicks)
  const max = scale.max
  const n = points.length
  const slot = n ? iw / n : 0
  const x = (i: number) => pad.l + (kind === "bar" ? slot * i + slot / 2 : n > 1 ? (iw / (n - 1)) * i : iw / 2)
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => scale.step * i)
  const segs = useMemo(() => {
    const solid: string[] = []
    const dash: string[] = []
    let prev = -1
    for (let i = 0; i < n; i++) {
      const b = points[i]
      if (b.value == null) continue
      if (prev >= 0) {
        const a = points[prev]
        const s = `M${x(prev)},${y(a.value!)}L${x(i)},${y(b.value)}`
        ;(a.partial || b.partial || i - prev > 1 ? dash : solid).push(s)
      }
      prev = i
    }
    return { solid: solid.join(""), dash: dash.join("") }
  }, [points, w, max])
  const area = useMemo(() => {
    const idx = points.map((p, i) => (p.value != null && !p.partial ? i : -1)).filter((i) => i >= 0)
    if (idx.length < 2) return ""
    return `M${x(idx[0])},${y(0)}` + idx.map((i) => `L${x(i)},${y(points[i].value!)}`).join("") + `L${x(idx[idx.length - 1])},${y(0)}Z`
  }, [points, w, max])
  const cmpPath = compare ? compare.map((v, i) => (v == null ? "" : `${i && compare[i - 1] != null ? "L" : "M"}${x(i)},${y(v)}`)).join("") : ""
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 44))))
  const hp = hover != null ? points[hover] : null
  return (
    <div ref={ref} className="chart" style={{ height }} onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={height}>
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5f57e6" stopOpacity="0.16" />
              <stop offset="1" stopColor="#5f57e6" stopOpacity="0" />
            </linearGradient>
            <pattern id="bar-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#ecebfd" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="#a6a1f1" strokeWidth="2" />
            </pattern>
          </defs>
          <g className="grid-lines">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
                <text className="tick" x={pad.l - 8} y={y(t) + 3.5} textAnchor="end">
                  {format(t)}
                </text>
              </g>
            ))}
          </g>
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={i} className="tick" x={x(i)} y={height - 6} textAnchor="middle" style={{ fill: hover === i ? "var(--ink)" : undefined }}>
                {p.label}
              </text>
            ) : null,
          )}
          {kind === "bar" &&
            points.map((p, i) => {
              if (p.value == null) return <rect key={i} x={x(i) - Math.min(18, slot * 0.6) / 2} y={y(0) - 2} width={Math.min(18, slot * 0.6)} height={2} rx={1} fill="var(--line)" />
              const bw = Math.min(22, slot * 0.62)
              const top = y(p.value)
              return <rect key={i} className={cx("bar", (hover === i || (hover == null && highlight === i)) && "on", p.partial && "part")} x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, y(0) - top)} rx={3} />
            })}
          {kind === "line" && (
            <>
              {area && <path className="area" d={area} />}
              {cmpPath && <path className="line ghost" d={cmpPath} />}
              <path className="line" d={segs.solid} />
              <path className="line dash" d={segs.dash} />
              {points.map((p, i) => (p.value != null && (p.partial || i === n - 1 || hover === i) ? <circle key={i} className={cx("dot", p.partial && "hollow")} cx={x(i)} cy={y(p.value)} r={hover === i ? 4 : 3} /> : null))}
            </>
          )}
          {hover != null && kind === "line" && <line className="guide" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} />}
          {points.map((_, i) => (
            <rect key={i} x={kind === "bar" ? pad.l + slot * i : x(i) - (n > 1 ? iw / (n - 1) / 2 : iw / 2)} y={0} width={kind === "bar" ? slot : n > 1 ? iw / (n - 1) : iw} height={height} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hp && (
        <div className="chart-tip" style={{ left: x(hover!), top: hp.value != null ? y(hp.value) : pad.t + ih }}>
          <div className="k">
            {hp.label}
            {hp.partial ? " · 数据不完整" : ""}
          </div>
          <div className="v">{hp.value == null ? "—" : format(hp.value)}</div>
          {hp.note && <div className="k">{hp.note}</div>}
        </div>
      )}
    </div>
  )
}

export const LevelBar = ({ levels, onPick }: { levels: Record<Level, number>; onPick?: (l: Level) => void }) => {
  const total = levelOrder.reduce((s, l) => s + levels[l], 0) || 1
  return (
    <div>
      <div className="levelbar">
        {levelOrder.map((l) => (levels[l] ? <span key={l} className={l} style={{ flexGrow: levels[l] / total }} title={`${levelName[l]} ${levels[l]}`} /> : null))}
      </div>
      <div className="legend">
        {levelOrder.map((l) => (
          <button key={l} className={cx("level", l)} onClick={onPick ? () => onPick(l) : undefined} style={{ cursor: onPick ? "pointer" : "default" }}>
            <i />
            {levelName[l]}
            <b>{levels[l]}</b>
          </button>
        ))}
      </div>
    </div>
  )
}

export interface BarItem {
  key: string
  label: ReactNode
  value: number
  display?: ReactNode
  secondary?: ReactNode
  onClick?: () => void
  tone?: string
}

export const BarList = ({ items, max }: { items: BarItem[]; max?: number }) => {
  const m = max ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="barlist">
      {items.map((i) => (
        <div key={i.key} className={cx("item", i.onClick && "click")} onClick={i.onClick}>
          <span className="lbl">{i.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(i.value / m) * 100}%`, background: i.tone }} />
          </span>
          <span className="val">
            <span>{i.display ?? i.value}</span>
            {i.secondary != null && <span className="s">{i.secondary}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

export const StackBar = ({ segments, height = 28 }: { segments: { key: string; value: number; label?: ReactNode; color: string; ink?: string; title?: string }[]; height?: number }) => {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  return (
    <div className="stack100" style={{ height }}>
      {segments.map((s) =>
        s.value > 0 ? (
          <div key={s.key} style={{ flexGrow: s.value / total, background: s.color, color: s.ink ?? "var(--ink-2)" }} title={s.title}>
            {s.value / total > 0.08 ? s.label : null}
          </div>
        ) : null,
      )}
    </div>
  )
}

export interface HeatDay {
  date: string
  value: number | null
  covered: boolean
  note?: ReactNode
}

const HEAT = ["#ebe9fc", "#d0ccf7", "#aba5f1", "#8279eb", "#5f57e6", "#3e36b6"]
const quant = (xs: number[], q: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}
const dayMs = 86400000
const parse = (d: string) => new Date(`${d}T12:00:00+08:00`).getTime()
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

export const Heatmap = ({ days, format = (v: number) => String(Math.round(v)), onPick, maxCell = 22, legend = true }: { days: HeatDay[]; format?: (v: number) => string; onPick?: (d: HeatDay) => void; maxCell?: number; legend?: boolean }) => {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<{ d: HeatDay; x: number; y: number } | null>(null)
  const grid = useMemo(() => {
    if (!days.length) return { cols: [] as (HeatDay | null)[][], months: [] as { col: number; label: string }[] }
    const map = new Map(days.map((d) => [d.date, d]))
    const first = parse(days[0].date)
    const dow = (new Date(first).getUTCDay() + 6) % 7
    const start = first - dow * dayMs
    const last = parse(days[days.length - 1].date)
    const cols: (HeatDay | null)[][] = []
    const months: { col: number; label: string }[] = []
    let prevMonth = -1
    for (let t = start, c = 0; t <= last; t += 7 * dayMs, c++) {
      const col: (HeatDay | null)[] = []
      for (let k = 0; k < 7; k++) col.push(map.get(iso(t + k * dayMs)) ?? null)
      const m = new Date(t + 3 * dayMs).getUTCMonth()
      if (m !== prevMonth) {
        months.push({ col: c, label: `${m + 1}月` })
        prevMonth = m
      }
      cols.push(col)
    }
    return { cols, months }
  }, [days])
  const vals = days.filter((d) => d.covered && d.value != null && d.value > 0).map((d) => d.value!)
  const th = [0.2, 0.4, 0.6, 0.8, 0.95].map((q) => quant(vals, q))
  const level = (v: number) => {
    let i = 0
    while (i < th.length && v > th[i]) i++
    return Math.min(HEAT.length - 1, i)
  }
  const labelW = 22
  const gap = 4
  const n = grid.cols.length
  const gapPx = n < 20 ? 6 : gap
  const cell = n ? Math.max(10, Math.min(maxCell, Math.floor((w - labelW - gapPx * (n - 1)) / n))) : maxCell
  const width = labelW + n * cell + Math.max(0, n - 1) * gapPx
  return (
    <div ref={ref} className="heatmap">
      {w > 0 && (
        <div style={{ position: "relative", width, maxWidth: "100%" }}>
          <div className="hm-body" style={{ gridTemplateColumns: `${labelW}px repeat(${n}, ${cell}px)`, gridTemplateRows: `repeat(7, ${cell}px)`, gap: gapPx }}>
            {["一", "二", "三", "四", "五", "六", "日"].map((l, k) => (
              <span key={k} className="hm-row" style={{ gridColumn: 1, gridRow: k + 1 }}>
                {l}
              </span>
            ))}
            {grid.cols.map((col, c) =>
              col.map((d, k) => {
                const style = { gridColumn: c + 2, gridRow: k + 1 }
                if (!d) return <span key={`${c}-${k}`} className="hm-cell void" style={style} />
                const v = d.value ?? 0
                const cls = !d.covered ? "off" : v > 0 ? "" : "zero"
                return (
                  <span
                    key={d.date}
                    className={cx("hm-cell", cls, onPick && "click", hover?.d.date === d.date && "hot")}
                    style={{ ...style, background: d.covered && v > 0 ? HEAT[level(v)] : undefined }}
                    onMouseEnter={() => setHover({ d, x: labelW + c * (cell + gapPx) + cell / 2, y: k * (cell + gapPx) })}
                    onMouseLeave={() => setHover(null)}
                    onClick={onPick ? () => onPick(d) : undefined}
                  />
                )
              }),
            )}
          </div>
          <div className="hm-months" style={{ marginLeft: labelW, height: 20 }}>
            {grid.months.map((m, i) => {
              const next = grid.months[i + 1]?.col ?? n
              if (next - m.col < 2 && i < grid.months.length - 1) return null
              return (
                <span key={m.col} style={{ left: m.col * (cell + gapPx) }}>
                  {m.label}
                </span>
              )
            })}
          </div>
          {legend && (
            <div className="hm-legend" style={{ marginLeft: labelW }}>
              <span className="row" style={{ gap: 6 }}>
                <i className="hm-cell off" />
                没有数据
              </span>
              <span className="spacer" />
              <span>少</span>
              <i className="hm-cell zero" />
              {HEAT.map((c) => (
                <i key={c} className="hm-cell" style={{ background: c }} />
              ))}
              <span>多</span>
            </div>
          )}
          {hover && (
            <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
              <div className="k">
                {hover.d.date.slice(5).replace("-", "/")} 周{["日", "一", "二", "三", "四", "五", "六"][new Date(parse(hover.d.date)).getUTCDay()]}
              </div>
              <div className="v">{!hover.d.covered ? "没有数据" : hover.d.value ? format(hover.d.value) : "0"}</div>
              {hover.d.covered && hover.d.note && <div className="k">{hover.d.note}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const MiniArea = ({ values, partial = [], height = 44, format = (v: number) => String(Math.round(v)), labels = [] }: { values: (number | null)[]; partial?: boolean[]; height?: number; format?: (v: number) => string; labels?: string[] }) => {
  const { ref, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const n = values.length
  const vs = values.map((v) => v ?? 0)
  const max = Math.max(...vs, 1)
  const min = Math.min(...vs.filter((_, i) => values[i] != null), max)
  const lo = Math.max(0, min - (max - min) * 0.4)
  const x = (i: number) => (n > 1 ? 3 + (i / (n - 1)) * (w - 6) : w / 2)
  const y = (v: number) => 4 + (height - 8) * (1 - (v - lo) / Math.max(1e-9, max - lo))
  const idx = values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0)
  const solid = idx.filter((i) => !partial[i])
  const path = (ids: number[]) => ids.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(vs[i]).toFixed(1)}`).join("")
  const lastSolid = solid[solid.length - 1]
  const tail = idx.filter((i) => i >= (lastSolid ?? 0))
  const area = solid.length > 1 ? `${path(solid)}L${x(lastSolid).toFixed(1)},${height}L${x(solid[0]).toFixed(1)},${height}Z` : ""
  return (
    <div ref={ref} className="mini-area" style={{ height }} onMouseLeave={() => setHover(null)}>
      {w > 0 && idx.length > 1 && (
        <svg width={w} height={height}>
          <defs>
            <linearGradient id="mini-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {area && <path d={area} fill="url(#mini-fill)" />}
          <path d={path(solid)} className="ml" />
          {tail.length > 1 && <path d={path(tail)} className="ml dash" />}
          {hover != null && values[hover] != null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="mg" />}
          {(hover != null && values[hover] != null ? [hover] : [idx[idx.length - 1]]).map((i) => (
            <circle key={i} cx={x(i)} cy={y(vs[i])} r={3} className={cx("md", partial[i] && "hollow")} />
          ))}
          {values.map((_, i) => (
            <rect key={i} x={x(i) - w / n / 2} y={0} width={w / n} height={height} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && values[hover] != null && (
        <div className="chart-tip" style={{ left: x(hover), top: y(vs[hover]) }}>
          <div className="k">{labels[hover] ?? ""}{partial[hover] ? " · 不完整" : ""}</div>
          <div className="v">{format(values[hover]!)}</div>
        </div>
      )}
    </div>
  )
}

export const PairBars = ({ rows, format = (v: number) => String(Math.round(v)) }: { rows: { key: string; label: ReactNode; previous: number | null; current: number | null; tail?: ReactNode }[]; format?: (v: number) => string }) => {
  const max = Math.max(1, ...rows.flatMap((r) => [r.previous ?? 0, r.current ?? 0]))
  return (
    <div className="pairbars">
      {rows.map((r) => (
        <div key={r.key} className="pb-row">
          <div className="pb-head">
            <span className="pb-label">{r.label}</span>
            {r.tail}
          </div>
          {r.previous == null || r.current == null ? (
            <div className="faint" style={{ fontSize: 13 }}>没有可比数据</div>
          ) : (
            <>
              <div className="pb-bar">
                <span className="pb-k">上周</span>
                <span className="pb-track">
                  <span className="pb-fill prev" style={{ width: `${(r.previous / max) * 100}%` }} />
                </span>
                <span className="pb-v">{format(r.previous)}</span>
              </div>
              <div className="pb-bar">
                <span className="pb-k">本周</span>
                <span className="pb-track">
                  <span className="pb-fill" style={{ width: `${(r.current / max) * 100}%` }} />
                </span>
                <span className="pb-v strong">{format(r.current)}</span>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
