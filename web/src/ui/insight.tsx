import { useState, type ReactNode } from "react"
import type { Confidence, Evidence, JobState, Locator, ProfileTag, TagDimension } from "@spec/contract"
import { locate } from "../lib/locate"
import { cx } from "./controls"
import { Icon } from "./icons"
import { OptionList, Popover, Tooltip } from "./overlays"
import { MiniArea } from "./charts"

const confName: Record<Confidence, string> = { high: "把握高", medium: "把握中", low: "把握低" }

export const ConfidenceDot = ({ c, label }: { c: Confidence; label?: boolean }) => (
  <Tooltip content={confName[c]}>
    <span className={cx("conf", c)}>
      <i />
      <i />
      <i />
      {label && <b>{confName[c]}</b>}
    </span>
  </Tooltip>
)

export const EvidenceChip = ({ e }: { e: Evidence }) => {
  const body = (
    <>
      <span className="ev-l">{e.label}</span>
      {e.value && <span className="ev-v">{e.value}</span>}
      {e.target && <Icon name="arrowUpRight" size="xs" className="ev-go" />}
    </>
  )
  return e.target ? (
    <button className="ev-chip go" title={e.value ? `${e.label} ${e.value}` : e.label} onClick={() => locate(e.target as Locator)}>
      {body}
    </button>
  ) : (
    <span className="ev-chip" title={e.value ? `${e.label} ${e.value}` : e.label}>{body}</span>
  )
}

export const BigStat = ({ label, value, unit, sub, trend, partial, labels, format, hint, tone }: { label: ReactNode; value: ReactNode; unit?: string; sub?: ReactNode; trend?: (number | null)[]; partial?: boolean[]; labels?: string[]; format?: (n: number) => string; hint?: string; tone?: "down" | "up" }) => (
  <div className="bigstat">
    <div className="bs-k">
      {hint ? (
        <Tooltip content={hint}>
          <span className="tip-anchor">{label}</span>
        </Tooltip>
      ) : (
        label
      )}
    </div>
    <div className={cx("bs-v", tone)}>
      {value}
      {unit && <span className="bs-u">{unit}</span>}
    </div>
    {sub && <div className="bs-s">{sub}</div>}
    {trend && trend.some((v) => v != null) && (
      <div className="bs-t">
        <MiniArea values={trend} partial={partial} labels={labels} format={format} height={36} />
      </div>
    )}
  </div>
)

export const JobProgress = ({ state, done, total, label, error }: { state: JobState; done?: number; total?: number; label?: string; error?: string | null }) => {
  if (state === "failed") return <span className="jobp failed"><Icon name="alert" size="xs" />{error ?? "失败"}</span>
  if (state === "done") return <span className="jobp done"><Icon name="check" size="xs" />{label ?? "完成"}</span>
  const pct = total ? Math.min(100, ((done ?? 0) / total) * 100) : null
  return (
    <span className="jobp running">
      <span className="jp-track">{pct == null ? <i className="ind" /> : <i style={{ width: `${pct}%` }} />}</span>
      <span>{label ?? (state === "queued" ? "排队中" : "分析中")}{total ? ` ${done ?? 0}/${total}` : ""}</span>
    </span>
  )
}

export const tagDimName: Record<TagDimension, string> = { category: "品类", role: "角色", purpose: "用途", rhythm: "节奏", skill: "熟练度" }

export const tagOptions: Record<TagDimension, string[]> = {
  category: ["女装", "男装", "童装", "内衣泳装", "面料辅料", "鞋包配饰", "综合"],
  role: ["品牌商家", "工厂", "面料商", "设计工作室"],
  purpose: ["换色出款", "印花面料", "上身图", "改款设计", "视频展示", "详情图"],
  rhythm: ["连续", "按批次", "偶尔"],
  skill: ["熟手", "一般", "新手"],
}

export const tagOrder: TagDimension[] = ["category", "role", "purpose", "rhythm", "skill"]

export const TagChip = ({ t, onClick, active }: { t: ProfileTag; onClick?: () => void; active?: boolean }) => (
  <Tooltip content={`${tagDimName[t.dimension]}${t.source === "manual" ? " · 手工" : ""}`}>
    <span className={cx("ptag", `d-${t.dimension}`, onClick && "click", active && "on", t.source === "manual" && "manual")} onClick={onClick}>
      {t.value}
    </span>
  </Tooltip>
)

export const TagPicker = ({ tags, onChange, disabled }: { tags: ProfileTag[]; onChange: (d: TagDimension, v: string | null) => void; disabled?: boolean }) => (
  <div className="tagpicker">
    {tagOrder.map((d) => {
      const cur = tags.find((t) => t.dimension === d)
      return (
        <Popover
          key={d}
          width={200}
          trigger={({ open, toggle, ref }) => (
            <button ref={ref as never} className={cx("tp-slot", cur ? "set" : "empty", open && "open", `d-${d}`)} onClick={toggle} disabled={disabled}>
              <span className="tp-k">{tagDimName[d]}</span>
              <span className="tp-v">{cur?.value ?? "—"}</span>
              {cur?.source === "manual" && <i className="tp-m" />}
            </button>
          )}
        >
          {(close) => (
            <OptionList
              options={[...tagOptions[d].map((v) => ({ value: v, label: v })), ...(cur ? [{ value: "__sep", label: "", sep: true }, { value: "__clear", label: "清除" }] : [])]}
              isOn={(v) => v === cur?.value}
              onClose={close}
              onPick={(v) => {
                close()
                if (v === "__clear") onChange(d, null)
                else if (v !== cur?.value) onChange(d, v)
              }}
            />
          )}
        </Popover>
      )
    })}
  </div>
)

export const HourHeat = ({ grid, prime, compact }: { grid: number[][]; prime?: { from: number; to: number } | null; compact?: boolean }) => {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null)
  const max = Math.max(1, ...grid.flat())
  const days = ["一", "二", "三", "四", "五", "六", "日"]
  const level = (v: number) => (v <= 0 ? 0 : Math.min(5, Math.ceil((v / max) * 5)))
  const inPrime = (h: number) => !!prime && (prime.from <= prime.to ? h >= prime.from && h < prime.to : h >= prime.from || h < prime.to)
  const total = grid.flat().reduce((a, b) => a + b, 0) || 1
  return (
    <div className={cx("hourheat", compact && "compact")}>
      <div className="hh-grid" onMouseLeave={() => setHover(null)}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className={cx("hh-h", inPrime(h) && "prime")}>{h % 3 === 0 ? h : ""}</span>
        ))}
        {grid.map((row, d) => (
          <div key={d} style={{ display: "contents" }}>
            <span className="hh-d">{days[d]}</span>
            {row.map((v, h) => (
              <span key={h} className={cx("hh-c", `l${level(v)}`, hover?.d === d && hover.h === h && "hot")} onMouseEnter={() => setHover({ d, h })} />
            ))}
          </div>
        ))}
      </div>
      <div className="hh-foot">
        {hover ? (
          <span className="num">
            周{days[hover.d]} {hover.h}:00–{hover.h + 1}:00 · <b>{grid[hover.d][hover.h]}</b> 个任务 · 占 {Math.round((grid[hover.d][hover.h] / total) * 1000) / 10}%
          </span>
        ) : prime ? (
          <span>
            主要时段 <b className="num">{prime.from}:00–{prime.to}:00</b>
          </span>
        ) : (
          <span className="faint">没有数据</span>
        )}
        <span className="spacer" />
        <span className="hh-legend">
          少
          {[0, 1, 2, 3, 4, 5].map((l) => (
            <i key={l} className={`hh-c l${l}`} />
          ))}
          多
        </span>
      </div>
    </div>
  )
}

export const Segments = ({ items, height = 10 }: { items: { key: string; label: string; value: number; color: string }[]; height?: number }) => {
  const total = items.reduce((s, i) => s + i.value, 0) || 1
  return (
    <div className="segs">
      <div className="segs-bar" style={{ height }}>
        {items.map((i) =>
          i.value > 0 ? (
            <Tooltip key={i.key} content={`${i.label} ${Math.round((i.value / total) * 100)}%`}>
              <span style={{ flexGrow: i.value, background: i.color }} />
            </Tooltip>
          ) : null,
        )}
      </div>
      <div className="segs-legend">
        {items.map((i) => (
          <span key={i.key}>
            <i style={{ background: i.color }} />
            {i.label}
            <b className="num">{Math.round((i.value / total) * 100)}%</b>
          </span>
        ))}
      </div>
    </div>
  )
}
