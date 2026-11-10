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
          <g className="grid">
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
