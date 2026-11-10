import { forwardRef, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react"
import { Icon, type IconName } from "./icons"

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ")
export { cx }

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "soft"
  size?: "xs" | "sm" | "md" | "lg"
  icon?: IconName
  iconRight?: IconName
  loading?: boolean
  active?: boolean
}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(({ variant = "secondary", size = "md", icon, iconRight, loading, active, className, children, disabled, ...rest }, ref) => (
  <button ref={ref} type="button" className={cx("btn", variant, size !== "md" && size, loading && "loading", active && "active", className)} disabled={disabled || loading} {...rest}>
    {loading ? <span className="spinner" /> : icon && <Icon name={icon} size={size === "xs" ? "xs" : "sm"} />}
    {children != null && <span>{children}</span>}
    {iconRight && <Icon name={iconRight} size="xs" className="faint" />}
  </button>
))

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: "xs" | "sm" | "md"; active?: boolean }

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(({ icon, label, size = "md", active, className, ...rest }, ref) => (
  <button ref={ref} type="button" aria-label={label} title={label} className={cx("icon-btn", size !== "md" && size, active && "active", className)} {...rest}>
    <Icon name={icon} size={size === "md" ? undefined : "sm"} />
  </button>
))

export const Kbd = ({ keys }: { keys: string | string[] }) => (
  <span className="kbd-group">
    {(Array.isArray(keys) ? keys : [keys]).map((k) => (
      <kbd key={k} className="kbd">
        {k}
      </kbd>
    ))}
  </span>
)

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { icon?: IconName; suffix?: ReactNode; size?: "sm" | "md"; quiet?: boolean; invalid?: boolean; onClear?: () => void }

export const Input = forwardRef<HTMLInputElement, FieldProps>(({ icon, suffix, size = "md", quiet, invalid, onClear, className, style, ...rest }, ref) => (
  <label className={cx("field", size === "sm" && "sm", quiet && "quiet", invalid && "invalid", className)} style={style}>
    {icon && <Icon name={icon} size="sm" />}
    <input ref={ref} {...rest} />
    {onClear && rest.value ? (
      <button type="button" className="icon-btn xs" aria-label="清除" onClick={onClear}>
        <Icon name="x" size="xs" />
      </button>
    ) : null}
    {suffix && <span className="suffix">{suffix}</span>}
  </label>
))

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean }>(({ autoGrow = true, className, onInput, ...rest }, ref) => {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  const grow = () => {
    const el = inner.current
    if (!el || !autoGrow) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + 2}px`
  }
  useLayoutEffect(grow, [rest.value])
  return (
    <textarea
      ref={(el) => {
        inner.current = el
        if (typeof ref === "function") ref(el)
        else if (ref) ref.current = el
      }}
      className={cx("textarea", className)}
      onInput={(e) => {
        grow()
        onInput?.(e)
      }}
      {...rest}
    />
  )
})

export const NumberField = ({ value, onChange, min, max, step = 1, suffix, width = 96, size = "md", percent }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; width?: number; size?: "sm" | "md"; percent?: boolean }) => {
  const shown = percent ? Math.round(value * 1000) / 10 : value
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const commit = (raw: string) => {
    const n = Number(raw)
    setDraft(null)
    if (!Number.isFinite(n)) return
    onChange(clamp(percent ? n / 100 : n))
  }
  const bump = (d: number) => onChange(clamp(Math.round(((percent ? value * 100 : value) + d * step) * 1000) / 1000 / (percent ? 100 : 1)))
  return (
    <label className={cx("field number", size === "sm" && "sm")} style={{ width }}>
      <input
        inputMode="decimal"
        value={draft ?? String(shown)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "ArrowUp") (e.preventDefault(), bump(1))
          if (e.key === "ArrowDown") (e.preventDefault(), bump(-1))
        }}
      />
      {(suffix || percent) && <span className="suffix">{percent ? "%" : suffix}</span>}
      <span className="steps">
        <button type="button" tabIndex={-1} aria-label="增加" onClick={() => bump(1)}>
          <Icon name="chevUp" size="xs" />
        </button>
        <button type="button" tabIndex={-1} aria-label="减少" onClick={() => bump(-1)}>
          <Icon name="chevDown" size="xs" />
        </button>
      </span>
    </label>
  )
}

export const CheckBox = ({ on, mixed }: { on: boolean; mixed?: boolean }) => (
  <span className={cx("check-box", on && "on", mixed && !on && "mixed")}>
    <svg viewBox="0 0 16 16">
      <path d={mixed && !on ? "M4 8h8" : "M3.5 8.5 6.5 11.5 12.5 4.5"} />
    </svg>
  </span>
)

export const Checkbox = ({ checked, mixed, onChange, children, disabled }: { checked: boolean; mixed?: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) => (
  <label className="checkbox" onClick={(e) => e.stopPropagation()} style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
    <CheckBox on={checked} mixed={mixed} />
    {children}
  </label>
)

export const RadioGroup = <T extends string>({ value, onChange, options, row, cards }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[]; row?: boolean; cards?: boolean }) => (
  <div className={cx("radio-group", row && "row")} role="radiogroup">
    {options.map((o) => (
      <label key={o.value} className={cx("radio", cards && "cards", value === o.value && "on")}>
        <input type="radio" checked={value === o.value} onChange={() => onChange(o.value)} />
        <span className="radio-dot" />
        <span className="text">
          <span>{o.label}</span>
          {o.hint && <span className="hint">{o.hint}</span>}
        </span>
      </label>
    ))}
  </div>
)

export const Switch = ({ checked, onChange, children, size }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; size?: "sm" }) => (
  <label className={cx("switch", checked && "on", size)}>
    <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="switch-track" />
    {children}
  </label>
)

const useIndicator = (deps: unknown[]) => {
  const wrap = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ x: number; w: number } | null>(null)
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>("[data-on='1']")
    if (!el) return setBox(null)
    const measure = () => setBox({ x: el.offsetLeft, w: el.offsetWidth })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const t = requestAnimationFrame(() => setReady(true))
    return () => {
      ro.disconnect()
      cancelAnimationFrame(t)
    }
  }, deps)
  return { wrap, box, ready }
}

export const Segmented = <T extends string>({ value, onChange, options, size, block }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: IconName; count?: number }[]; size?: "sm"; block?: boolean }) => {
  const { wrap, box, ready } = useIndicator([value, options.length])
  return (
    <div ref={wrap} className={cx("seg", size, block && "block")} role="group">
      {box && <span className="seg-ind" style={{ width: box.w, transform: `translateX(${box.x}px)`, transition: ready ? undefined : "none" }} />}
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} data-on={value === o.value ? "1" : "0"} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size="sm" />}
          {o.label}
          {o.count != null && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export const Tabs = <T extends string>({ value, onChange, options, right }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; right?: ReactNode }) => {
  const { wrap, box, ready } = useIndicator([value, options.map((o) => o.count).join()])
  return (
    <div ref={wrap} className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} data-on={value === o.value ? "1" : "0"} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null && <span className="count">{o.count}</span>}
        </button>
      ))}
      {box && <span className="bar" style={{ width: box.w - 16, transform: `translateX(${box.x + 8}px)`, transition: ready ? undefined : "none" }} />}
      {right && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{right}</div>}
    </div>
  )
}
