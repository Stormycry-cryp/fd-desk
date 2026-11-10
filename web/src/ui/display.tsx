import { useState, type ReactNode } from "react"
import type { Authored, Level, Media, Pair } from "@spec/contract"
import { levelName, sourceName } from "../lib/labels"
import { maskPhone, pct, ratio, signedPct, time, weekdayNames } from "../lib/format"
import { cx, IconButton, TextArea, Button, Kbd } from "./controls"
import { Icon, type IconName } from "./icons"
import { Hint, toast } from "./overlays"

export const Badge = ({ tone, children, sq, dot, icon, title }: { tone?: "accent" | "up" | "down" | "warn" | "outline" | "solid"; children: ReactNode; sq?: boolean; dot?: boolean; icon?: IconName; title?: string }) => (
  <span className={cx("badge", tone, sq && "sq")} title={title}>
    {dot && <span className="dot" />}
    {icon && <Icon name={icon} size="xs" />}
    {children}
  </span>
)

export const LevelTag = ({ level, empty = "—" }: { level: Level | null; empty?: string }) => (
  <span className={cx("level", level ?? "none")}>
    <i />
    {level ? levelName[level] : empty}
  </span>
)

export const Sev = ({ s }: { s: 1 | 2 | 3 }) => <span className={`sev s${s}`} />

const tones = ["#6b7a8f", "#8f7a6b", "#6f8a76", "#8a6f86", "#7a7fa8", "#9a8a5e", "#5f8a8f", "#a07070"]
const strip = (n: string) => n.replace(/^(杭州|广州|深圳|宁波|苏州|海宁|湖州|东莞|温州|嘉兴|泉州|绍兴|常熟|佛山|义乌|上海|南通|无锡|桐乡|芦淞区|浙江|江苏|广东)(市|省)?/, "")

export const Avatar = ({ name, size = 24, square }: { name: string; size?: number; square?: boolean }) => {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (
    <span className={cx("avatar", square && "sq")} style={{ ["--s" as any]: `${size}px`, background: tones[h % tones.length] }}>
      {strip(name).slice(0, 1) || name.slice(0, 1)}
    </span>
  )
}

const arrow = (dir: "up" | "down") => (
  <svg viewBox="0 0 10 10">
    <path d={dir === "up" ? "M5 8.5V1.5M2 4.5l3-3 3 3" : "M5 1.5v7M2 5.5l3 3 3-3"} />
  </svg>
)

export const Delta = ({ pair, current, previous, rate, pill, invert, digits = 0 }: { pair?: Pair | null; current?: number | null; previous?: number | null; rate?: boolean; pill?: boolean; invert?: boolean; digits?: number }) => {
  const c = pair?.current ?? current
  const p = pair?.previous ?? previous
  if (c == null || p == null) return <span className="delta flat">—</span>
  let d: number
  let text: string
  if (rate) {
    d = c - p
    const pts = Math.abs(d * 100).toFixed(digits || 1)
    text = `${pts}pt`
  } else {
    d = ratio(c, p)
    text = Number.isFinite(d) ? signedPct(d).replace(/^[+−±]/, "") : "新"
  }
  const flat = rate ? Math.abs(d) < 0.005 : Number.isFinite(d) && Math.abs(d) < 0.005
  const good = invert ? d < 0 : d > 0
  const tone = flat ? "flat" : good ? "up" : "down"
  return (
    <span className={cx("delta", tone, pill && "pill")}>
      {!flat && Number.isFinite(d) && arrow(d > 0 ? "up" : "down")}
      {flat ? "持平" : text}
    </span>
  )
}

export const Rate = ({ value, mark, warnBelow = 0.35, goodAbove = 0.7, width = 44 }: { value: number | null; mark?: number | null; warnBelow?: number; goodAbove?: number; width?: number }) => {
  if (value == null) return <span className="faint">—</span>
  return (
    <span className={cx("rate", value < warnBelow && "low", value >= goodAbove && "high")}>
      <span className="track" style={{ width }}>
        <span className="fill" style={{ width: `${Math.min(100, value * 100)}%` }} />
        {mark != null && <span className="mark" style={{ left: `calc(${Math.min(100, mark * 100)}% - 0.75px)` }} />}
      </span>
      <span className="rv">{pct(value)}</span>
    </span>
  )
}

export const Stat = ({ label, value, unit, foot, hint, size, delta }: { label: ReactNode; value: ReactNode; unit?: ReactNode; foot?: ReactNode; hint?: ReactNode; size?: "lg" | "sm" | "xs"; delta?: ReactNode }) => (
  <div className={cx("stat", size)}>
    <div className="k">{hint ? <Hint text={hint}>{label}</Hint> : label}</div>
    <div className="v">
      {value}
      {unit && <span className="u">{unit}</span>}
    </div>
    {(foot || delta) && (
      <div className="f">
        {delta}
        {foot}
      </div>
    )}
  </div>
)

export const Skel = ({ w = "100%", h = 14, r, style }: { w?: number | string; h?: number | string; r?: number; style?: React.CSSProperties }) => <span className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />

export const Empty = ({ icon = "inbox", title, text, action, compact }: { icon?: IconName; title: ReactNode; text?: ReactNode; action?: ReactNode; compact?: boolean }) => (
  <div className={cx("empty", compact && "compact")}>
    <span className="glyph">
      <Icon name={icon} size="lg" />
    </span>
    <div className="t">{title}</div>
    {text && <div className="d">{text}</div>}
    {action && <div style={{ marginTop: 8 }}>{action}</div>}
  </div>
)

export const Card = ({ title, sub, actions, children, flush, className, style, sunk }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; style?: React.CSSProperties; sunk?: boolean }) => (
  <section className={cx("card", sunk && "sunk", className)} style={style}>
    {(title || actions) && (
      <header className="card-head">
        <h3>
          {title}
          {sub && <span className="sub">{sub}</span>}
        </h3>
        {actions}
      </header>
    )}
    <div className={cx("card-body", flush && "flush")}>{children}</div>
  </section>
)

export const SourceTag = ({ a }: { a: Authored | null | undefined }) =>
  a ? (
    <span className={cx("src", a.source)} title={time(a.updatedAt)}>
      <i />
      {sourceName[a.source]}
    </span>
  ) : null

export const InlineEdit = ({ value, onSave, placeholder = "点击填写", multiline = true, saving }: { value: string; onSave: (v: string) => void; placeholder?: string; multiline?: boolean; saving?: boolean }) => {
  const [draft, setDraft] = useState<string | null>(null)
  const save = () => {
    if (draft != null && draft.trim() !== value.trim()) onSave(draft.trim())
    setDraft(null)
  }
  if (draft == null)
    return (
      <div className="inline-edit" role="button" tabIndex={0} onClick={() => setDraft(value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), setDraft(value))}>
        {value ? value : <span className="ph">{placeholder}</span>}
      </div>
    )
  return (
    <div className="inline-edit editing">
      {multiline ? (
        <TextArea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), save())
            if (e.key === "Escape") (e.stopPropagation(), setDraft(null))
          }}
          style={{ minHeight: 60 }}
        />
      ) : (
        <label className="field">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save()
              if (e.key === "Escape") (e.stopPropagation(), setDraft(null))
            }}
          />
        </label>
      )}
      <div className="actions">
        <span className="hint">
          <Kbd keys={["⌘", "↵"]} /> 保存
        </span>
        <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
          取消
        </Button>
        <Button size="xs" variant="primary" loading={saving} onClick={save}>
          保存
        </Button>
      </div>
    </div>
  )
}

export const Thumb = ({ media, w = 96, ratio: r = 4 / 3, onClick, radius, children, dim }: { media: Media | null | undefined; w?: number | string; ratio?: number; onClick?: () => void; radius?: number; children?: ReactNode; dim?: boolean }) => {
  const [state, setState] = useState<"loading" | "ready" | "broken">("loading")
  const src = media ? (media.kind === "video" ? media.poster ?? media.thumb : media.thumb) : null
  const Tag = (onClick ? "button" : "div") as "button"
  return (
    <Tag type={onClick ? "button" : undefined} className={cx("thumb", state === "loading" && src && "loading", (!src || state === "broken") && "broken")} style={{ width: w, aspectRatio: `${1 / r}`, borderRadius: radius, opacity: dim ? 0.45 : undefined }} onClick={onClick}>
      {src && state !== "broken" ? <img src={src} loading="lazy" decoding="async" alt="" className={state === "ready" ? "ready" : ""} onLoad={() => setState("ready")} onError={() => setState("broken")} /> : <Icon name={media?.kind === "video" ? "video" : "image"} />}
      {media?.kind === "video" && state !== "broken" && (
        <span className="play">
          <span>
            <Icon name="play" size="xs" style={{ fill: "#fff", stroke: "none" }} />
          </span>
        </span>
      )}
      {children}
    </Tag>
  )
}

export const Stepper = <T extends string>({ steps, value, onChange, labels }: { steps: T[]; value: T; onChange?: (v: T) => void; labels: Record<T, string> }) => {
  const at = steps.indexOf(value)
  return (
    <div className="stepper">
      {steps.map((s, i) => {
        const Tag = (onChange ? "button" : "span") as "button"
        return (
          <span key={s} style={{ display: "contents" }}>
            {i > 0 && <span className={cx("line", i <= at && "done")} />}
            <Tag type={onChange ? "button" : undefined} className={cx("step", i < at && "done", i === at && "cur")} onClick={onChange ? () => onChange(s) : undefined}>
              <i>{i < at ? <Icon name="check" size="xs" style={{ width: 10, height: 10, strokeWidth: 2.4 }} /> : null}</i>
              {labels[s]}
            </Tag>
          </span>
        )
      })}
    </div>
  )
}

export const copyText = async (text: string, what = "已复制") => {
  try {
    await navigator.clipboard.writeText(text)
    toast(what, { tone: "ok", ms: 1800 })
  } catch {
    toast("复制失败", { tone: "error" })
  }
}

export const CopyField = ({ value, open }: { value: string; open?: boolean }) => (
  <div className="copy">
    <code title={value}>{value}</code>
    <IconButton size="xs" icon="copy" label="复制" onClick={() => copyText(value, "链接已复制")} />
    {open && <IconButton size="xs" icon="external" label="打开" onClick={() => window.open(value, "_blank", "noopener")} />}
  </div>
)

export const Phone = ({ value }: { value: string }) => {
  const [show, setShow] = useState(false)
  return (
    <span className="row" style={{ gap: 2 }}>
      <span className="num" style={{ minWidth: 92 }}>
        {show ? value : maskPhone(value)}
      </span>
      <IconButton size="xs" icon={show ? "eyeOff" : "eye"} label={show ? "隐藏" : "显示"} onClick={() => setShow(!show)} />
      <IconButton size="xs" icon="copy" label="复制" onClick={() => copyText(value, "手机号已复制")} />
    </span>
  )
}

export const CoverageDots = ({ days, week, lg }: { days: string[]; week: string; lg?: boolean }) => {
  const start = new Date(`${week}T00:00:00+08:00`).getTime()
  const on = new Set(days.map((d) => Math.round((new Date(`${d.slice(0, 10)}T00:00:00+08:00`).getTime() - start) / 86400000)))
  return (
    <span className={cx("coverage-dots", lg && "lg")} title={[0, 1, 2, 3, 4, 5, 6].filter((d) => on.has(d)).map((d) => `周${weekdayNames[d]}`).join(" ")}>
      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
        <i key={d} className={on.has(d) ? "" : "off"} />
      ))}
    </span>
  )
}

export const ErrorState = ({ error, retry }: { error: unknown; retry?: () => void }) => {
  const e = error as { message?: string }
  return <Empty icon="alert" title="加载失败" text={e?.message} action={retry && <Button size="sm" icon="refresh" onClick={retry}>重试</Button>} />
}
