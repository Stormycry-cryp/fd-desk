import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react"
import { cloneElement, isValidElement } from "react"
import { createPortal } from "react-dom"
import { CheckBox, cx } from "./controls"
import { useDismiss, useFloating, type Placement } from "./float"
import { Icon, type IconName } from "./icons"

export const Portal = ({ children }: { children: ReactNode }) => createPortal(children, document.body)

export const usePresence = (open: boolean, ms = 180) => {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, ms)
    return () => clearTimeout(t)
  }, [open])
  return { mounted, closing }
}

export const Tooltip = ({ content, children, placement = "top", delay = 280 }: { content: ReactNode; children: ReactElement<any>; placement?: Placement; delay?: number }) => {
  const [open, setOpen] = useState(false)
  const timer = useRef<number>(0)
  const { anchor, floating, style } = useFloating(open, { placement, offset: 8 })
  if (content == null || content === "") return children
  const show = () => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  const kid = children as ReactElement<any>
  const kp: any = (kid as any)?.props ?? {}
  const child = isValidElement(kid)
    ? cloneElement(kid as ReactElement<any>, {
        ref: (el: HTMLElement) => (anchor.current = el),
        onMouseEnter: (e: any) => (show(), kp.onMouseEnter?.(e)),
        onMouseLeave: (e: any) => (hide(), kp.onMouseLeave?.(e)),
        onFocus: (e: any) => (show(), kp.onFocus?.(e)),
        onBlur: (e: any) => (hide(), kp.onBlur?.(e)),
        onMouseDown: (e: any) => (hide(), kp.onMouseDown?.(e)),
      })
    : children
  return (
    <>
      {child}
      {open && (
        <Portal>
          <div ref={floating} className="tip" style={style} role="tooltip">
            {content}
          </div>
        </Portal>
      )}
    </>
  )
}

export const Hint = ({ title, children, text }: { title?: ReactNode; children: ReactNode; text: ReactNode }) => (
  <Tooltip
    content={
      <>
        {title && <div className="t">{title}</div>}
        <div>{text}</div>
      </>
    }
  >
    <span className="tip-anchor">{children}</span>
  </Tooltip>
)

export interface Opt<T extends string = string> {
  value: T
  label: ReactNode
  text?: string
  hint?: ReactNode
  count?: number
  icon?: IconName
  lead?: ReactNode
  disabled?: boolean
  danger?: boolean
  group?: string
  sep?: boolean
}

const textOf = (o: Opt) => (o.text ?? (typeof o.label === "string" ? o.label : String(o.value))).toLowerCase()

export const OptionList = <T extends string>({
  options,
  isOn,
  onPick,
  multi,
  search,
  autoFocus = true,
  onClose,
  emptyText = "没有匹配项",
  footer,
  initial,
}: {
  options: Opt<T>[]
  isOn?: (v: T) => boolean
  onPick: (v: T) => void
  multi?: boolean
  search?: boolean
  autoFocus?: boolean
  onClose?: () => void
  emptyText?: string
  footer?: ReactNode
  initial?: T
}) => {
  const id = useId()
  const [q, setQ] = useState("")
  const list = useMemo(() => (q ? options.filter((o) => !o.sep && textOf(o).includes(q.toLowerCase())) : options), [q, options])
  const pickable = list.map((o, i) => (o.sep || o.disabled ? -1 : i)).filter((i) => i >= 0)
  const start = Math.max(0, list.findIndex((o) => (initial != null ? o.value === initial : isOn?.(o.value))))
  const [active, setActive] = useState(pickable.includes(start) ? start : pickable[0] ?? -1)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const typed = useRef({ s: "", t: 0 })
  useEffect(() => {
    if (!autoFocus) return
    requestAnimationFrame(() => (search ? input.current : box.current)?.focus({ preventScroll: true }))
  }, [])
  useEffect(() => {
    if (q) setActive(pickable[0] ?? -1)
  }, [q])
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  const move = (d: number) => {
    if (!pickable.length) return
    const at = pickable.indexOf(active)
    setActive(pickable[(at + d + pickable.length) % pickable.length])
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), move(1))
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1))
    else if (e.key === "Home") (e.preventDefault(), setActive(pickable[0]))
    else if (e.key === "End") (e.preventDefault(), setActive(pickable[pickable.length - 1]))
    else if (e.key === "Enter") {
      e.preventDefault()
      const o = list[active]
      if (o && !o.disabled && !o.sep) onPick(o.value)
    } else if (e.key === "Tab") onClose?.()
    else if (!search && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const now = Date.now()
      typed.current = { s: now - typed.current.t < 600 ? typed.current.s + e.key : e.key, t: now }
      const hit = list.findIndex((o) => !o.sep && !o.disabled && textOf(o).startsWith(typed.current.s.toLowerCase()))
      if (hit >= 0) setActive(hit)
    }
  }
  let lastGroup: string | undefined
  return (
    <div ref={box} className="listbox" role="listbox" tabIndex={-1} aria-multiselectable={multi} aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined} onKeyDown={onKey}>
      {search && (
        <div className="search">
          <label className="field sm">
            <Icon name="search" size="sm" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" onKeyDown={onKey} />
          </label>
        </div>
      )}
      {list.map((o, i) => {
        if (o.sep) return <div key={`sep${i}`} className="option-sep" />
        const header = o.group && o.group !== lastGroup ? <div className="option-group">{o.group}</div> : null
        lastGroup = o.group
        const on = isOn?.(o.value) ?? false
        return (
          <div key={o.value} style={{ display: "contents" }}>
            {header}
            <div
              id={`${id}-${i}`}
              data-i={i}
              role="option"
              aria-selected={on}
              aria-disabled={o.disabled}
              className={cx("option", i === active && "active", o.danger && "danger")}
              onMouseMove={() => active !== i && !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !o.disabled && onPick(o.value)}
            >
              {multi && <CheckBox on={on} />}
              {o.icon && (
                <span className="lead">
                  <Icon name={o.icon} size="sm" />
                </span>
              )}
              {o.lead}
              <span className="body">
                <span className="ellipsis">{o.label}</span>
                {o.hint && <span className="hint">{o.hint}</span>}
              </span>
              {o.count != null && <span className="count">{o.count}</span>}
              {!multi && isOn && (
                <span className="check">{on && <Icon name="check" size="sm" />}</span>
              )}
            </div>
          </div>
        )
      })}
      {!list.length && <div className="list-empty">{emptyText}</div>}
      {footer}
    </div>
  )
}

export const Popover = ({ trigger, children, placement = "bottom-start", width, open: ctlOpen, onOpenChange, matchWidth }: { trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); placement?: Placement; width?: number; open?: boolean; onOpenChange?: (v: boolean) => void; matchWidth?: boolean }) => {
  const [inner, setInner] = useState(false)
  const open = ctlOpen ?? inner
  const set = useCallback((v: boolean) => (onOpenChange ? onOpenChange(v) : setInner(v)), [onOpenChange])
  const { anchor, floating, style, above } = useFloating(open, { placement, matchWidth })
  const close = useCallback(() => {
    set(false)
    anchor.current?.focus?.({ preventScroll: true })
  }, [set])
  useDismiss(open, () => set(false), [anchor, floating])
  return (
    <>
      {trigger({ open, toggle: () => set(!open), ref: (el) => (anchor.current = el) })}
      {open && (
        <Portal>
          <div ref={floating} className={cx("pop", above && "above")} style={{ ...style, width }}>
            {typeof children === "function" ? children(close) : children}
          </div>
        </Portal>
      )}
    </>
  )
}

export const Select = <T extends string>({ value, onChange, options, placeholder = "请选择", size, ghost, prefix, width, search, popWidth, disabled, renderValue }: { value: T | null; onChange: (v: T) => void; options: Opt<T>[]; placeholder?: string; size?: "sm"; ghost?: boolean; prefix?: ReactNode; width?: number | string; search?: boolean; popWidth?: number; disabled?: boolean; renderValue?: (o: Opt<T>) => ReactNode }) => {
  const cur = options.find((o) => o.value === value)
  return (
    <Popover
      matchWidth
      width={popWidth}
      trigger={({ open, toggle, ref }) => (
        <button
          ref={ref as any}
          type="button"
          disabled={disabled}
          className={cx("trigger", size, ghost && "ghost")}
          style={{ width }}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) (e.preventDefault(), toggle())
          }}
        >
          {prefix && <span className="prefix">{prefix}</span>}
          {cur?.icon && <Icon name={cur.icon} size="sm" className="muted" />}
          <span className={cx("tv", !cur && "placeholder")}>{cur ? (renderValue ? renderValue(cur) : cur.label) : placeholder}</span>
          <Icon name="chevDown" size="xs" className="chev" />
        </button>
      )}
    >
      {(close) => (
        <OptionList
          options={options}
          isOn={(v) => v === value}
          search={search ?? options.length > 9}
          onClose={close}
          onPick={(v) => {
            onChange(v)
            close()
          }}
        />
      )}
    </Popover>
  )
}

export const FilterChip = <T extends string>({ label, options, value, onChange, multi, search, icon }: { label: string; options: Opt<T>[]; value: T[]; onChange: (v: T[]) => void; multi?: boolean; search?: boolean; icon?: IconName }) => {
  const names = value.map((v) => options.find((o) => o.value === v)).filter(Boolean) as Opt<T>[]
  const on = names.length > 0
  const text = names.length > 2 ? `${names.slice(0, 2).map((n) => n.text ?? n.label).join("、")} 等 ${names.length} 项` : names.map((n, i) => <span key={n.value}>{i > 0 && "、"}{n.label}</span>)
  return (
    <Popover
      width={240}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref as any} type="button" className={cx("chip", on ? "on" : "idle")} aria-expanded={open} onClick={toggle}>
          {!on && (icon ? <Icon name={icon} size="xs" className="plus" /> : <Icon name="plus" size="xs" className="plus" />)}
          <span className="k">{label}</span>
          {on && <span>{text}</span>}
          {on && (
            <span
              className="x"
              role="button"
              aria-label="清除"
              onClick={(e) => {
                e.stopPropagation()
                onChange([])
              }}
            >
              <Icon name="x" size="xs" />
            </span>
          )}
          {!on && <Icon name="chevDown" size="xs" className="plus" />}
        </button>
      )}
    >
      {(close) => (
        <OptionList
          options={options}
          multi={multi}
          search={search ?? options.length > 9}
          isOn={(v) => value.includes(v)}
          onClose={close}
          onPick={(v) => {
            if (multi) onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
            else {
              onChange(value[0] === v ? [] : [v])
              close()
            }
          }}
          footer={
            multi && value.length ? (
              <>
                <div className="option-sep" />
                <div className="option" onClick={() => onChange([])} onMouseDown={(e) => e.preventDefault()} role="option" aria-selected={false}>
                  <span className="body muted">清除选择</span>
                </div>
              </>
            ) : null
          }
        />
      )}
    </Popover>
  )
}

export interface MenuItem {
  key: string
  label: ReactNode
  icon?: IconName
  hint?: ReactNode
  danger?: boolean
  disabled?: boolean
  sep?: boolean
  onSelect?: () => void
}

export const Menu = ({ items, trigger, placement = "bottom-end", width = 200 }: { items: MenuItem[]; trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode; placement?: Placement; width?: number }) => (
  <Popover placement={placement} width={width} trigger={trigger}>
    {(close) => (
      <OptionList
        options={items.map((i) => ({ value: i.key, label: i.label, icon: i.icon, hint: i.hint, danger: i.danger, disabled: i.disabled, sep: i.sep }))}
        onClose={close}
        onPick={(k) => {
          close()
          items.find((i) => i.key === k)?.onSelect?.()
        }}
      />
    )}
  </Popover>
)

let stack: string[] = []
const useTopmost = (open: boolean) => {
  const id = useId()
  useEffect(() => {
    if (!open) return
    stack.push(id)
    return () => {
      stack = stack.filter((x) => x !== id)
    }
  }, [open])
  return () => stack[stack.length - 1] === id
}

export const Drawer = ({ open, onClose, title, children, footer, width = 640, actions, scrim = true, pad }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; actions?: ReactNode; scrim?: boolean; pad?: boolean }) => {
  const { mounted, closing } = usePresence(open)
  const top = useTopmost(open)
  useEffect(() => {
    if (!open) return
    const f = (e: KeyboardEvent) => e.key === "Escape" && top() && !document.querySelector(".pop") && onClose()
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [open, onClose])
  if (!mounted) return null
  return (
    <Portal>
      {scrim && <div className={cx("scrim light", closing && "closing")} onClick={onClose} />}
      <aside className={cx("drawer", closing && "closing")} style={{ ["--w" as any]: `${width}px` }} role="dialog" aria-modal>
        {(title || actions) && (
          <div className="drawer-head">
            <div className="title">{title}</div>
            {actions}
            <button className="icon-btn" aria-label="关闭" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        )}
        <div className={cx("drawer-body", pad && "pad")}>{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </Portal>
  )
}

export const Modal = ({ open, onClose, title, sub, children, footer, width = 520, bare }: { open: boolean; onClose: () => void; title?: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; bare?: boolean }) => {
  const { mounted, closing } = usePresence(open)
  const top = useTopmost(open)
  useEffect(() => {
    if (!open) return
    const f = (e: KeyboardEvent) => e.key === "Escape" && top() && !document.querySelector(".pop") && onClose()
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [open, onClose])
  if (!mounted) return null
  return (
    <Portal>
      <div className={cx("scrim", closing && "closing")} style={{ zIndex: 50 }} />
      <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className={cx("modal", closing && "closing")} style={{ ["--w" as any]: `${width}px` }} role="dialog" aria-modal>
          {!bare && <div className="modal-head">
            <h3>
              {title}
              {sub && <div className="sub">{sub}</div>}
            </h3>
            <button className="icon-btn sm" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size="sm" />
            </button>
          </div>}
          {bare && (
            <button className="icon-btn sm viewer-close" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size="sm" />
            </button>
          )}
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      </div>
    </Portal>
  )
}

type Toast = { id: number; msg: ReactNode; tone?: "ok" | "error"; action?: { label: string; run: () => void }; leaving?: boolean }
let toasts: Toast[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
let seq = 0

export const toast = (msg: ReactNode, opts: { tone?: "ok" | "error"; action?: { label: string; run: () => void }; ms?: number } = {}) => {
  const id = ++seq
  toasts = [...toasts.slice(-2), { id, msg, tone: opts.tone, action: opts.action }]
  emit()
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    emit()
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id)
      emit()
    }, 200)
  }, opts.ms ?? 3600)
}

export const Toaster = () => {
  const list = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => toasts,
  )
  return (
    <Portal>
      <div className="toasts">
        {list.map((t) => (
          <div key={t.id} className={cx("toast", t.tone, t.leaving && "leaving")}>
            <Icon name={t.tone === "error" ? "alert" : t.tone === "ok" ? "check" : "info"} size="sm" />
            <span className="msg">{t.msg}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run()
                  toasts = toasts.filter((x) => x.id !== t.id)
                  emit()
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Portal>
  )
}
