import { useCtx, isoWeek } from "../lib/ctx"
import { navigate } from "../lib/route"
import { weekLabel } from "../lib/format"
import { Select } from "../ui/overlays"
import { CoverageDots } from "../ui/display"

export const WeekPicker = () => {
  const { week, meta, cov, line } = useCtx()
  if (!meta || !week) return <span className="skel" style={{ width: 168, height: 36, borderRadius: 8 }} />
  const latest = meta.latestWeek[line]
  const options = [...meta.weeks].reverse().map((w) => {
    const c = cov(w)
    return {
      value: w,
      text: weekLabel(w),
      label: (
        <span className="row" style={{ gap: 10 }}>
          <span className="num" style={{ minWidth: 76 }}>{weekLabel(w)}</span>
          <span className="faint num" style={{ fontSize: 13 }}>第 {isoWeek(w)} 周</span>
        </span>
      ),
      lead: c ? <CoverageDots days={c.days} week={w} /> : <span style={{ width: 60 }} />,
      hint: w === latest ? "最近完整周" : c && !c.complete ? `覆盖 ${c.days.length} 天` : undefined,
    }
  })
  return (
    <Select
      value={week}
      onChange={(v) => navigate({ week: v === latest ? null : v }, { replace: true })}
      options={options}
      popWidth={300}
      search={false}
      prefix={<span className="icon-wrap" style={{ display: "grid" }}><svg viewBox="0 0 24 24" className="icon sm"><path d="M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 3.5v4M15.5 3.5v4" /></svg></span>}
      renderValue={() => <span className="num">{weekLabel(week)}</span>}
    />
  )
}
