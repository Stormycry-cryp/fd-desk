import type { Coverage, Metric, Pair } from "@spec/contract"
import { compact, num, pct, weekShort, weekdaysLabel } from "../lib/format"
import { Delta, Skel } from "../ui/display"
import { Tooltip } from "../ui/overlays"

export const pickPair = (m: Metric | null | undefined, excluded: boolean): Pair | null => (m ? (excluded && m.comparableExcluded ? m.comparableExcluded : m.comparable) : null)

export const fmt = (v: number | null | undefined, kind: "num" | "pct" | "compact" | "dec" = "num") => (v == null ? "—" : kind === "pct" ? pct(v, 1) : kind === "compact" ? compact(v) : kind === "dec" ? v.toFixed(1) : num(v))

export const CmpFoot = ({ m, excluded, kind = "num", weekdays, invert }: { m: Metric | null | undefined; excluded: boolean; kind?: "num" | "pct" | "compact" | "dec"; weekdays: number[]; invert?: boolean }) => {
  const p = pickPair(m, excluded)
  if (!p) return <span className="faint">没有上周数据</span>
  const label = weekdays.length === 7 ? "比上周" : `同星期（${weekdaysLabel(weekdays)}）`
  return (
    <Tooltip
      content={
        <>
          <div className="t">{label}</div>
          <div className="num">
            上周 {fmt(p.previous, kind)} → 本周 {fmt(p.current, kind)}
          </div>
          {excluded && m?.comparableExcluded && <div className="muted">不含最大客户</div>}
        </>
      }
    >
      <span className="row" style={{ gap: 6 }}>
        <Delta pair={p} pill rate={kind === "pct"} invert={invert} />
        <span className="cmp">{label}</span>
      </span>
    </Tooltip>
  )
}

export const trimHistory = <T extends { tasks: number }>(h: T[], min = 4) => {
  const first = h.findIndex((p) => p.tasks > 0)
  if (first < 0) return h.slice(-min)
  return h.slice(Math.max(0, Math.min(first, h.length - min)))
}

export const weekPoint = (w: string) => weekShort(w)

export const PageSkeleton = () => (
  <div className="page">
    <div className="page-head">
      <div className="stack" style={{ gap: 10 }}>
        <Skel w={180} h={24} />
        <Skel w={260} h={14} />
      </div>
    </div>
    <div className="grid">
      <div className="card span-7" style={{ height: 260, padding: 20 }}>
        <Skel w={120} h={12} />
        <Skel w={90} h={40} style={{ marginTop: 14 }} />
        <Skel h={120} style={{ marginTop: 24 }} />
      </div>
      <div className="card span-5" style={{ height: 260, padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stack" style={{ gap: 10 }}>
            <Skel w={70} h={12} />
            <Skel w={90} h={26} />
            <Skel w={110} h={12} />
          </div>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card span-4" style={{ height: 300, padding: 16 }}>
          <Skel w={100} h={12} />
          {[0, 1, 2, 3, 4, 5].map((j) => (
            <Skel key={j} h={18} style={{ marginTop: 18 }} />
          ))}
        </div>
      ))}
    </div>
  </div>
)

export const coverageText = (c?: Coverage) => (c ? (c.complete ? "整周" : `覆盖 ${c.days.length} 天`) : "")
