import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Annotation, AnnotationKind } from "@spec/contract.next"
import { useAnnotate } from "../api/next"
import { time } from "../lib/format"
import { Button, IconButton, Kbd, Segmented, TextArea, cx } from "./controls"
import { Icon } from "./icons"
import { Menu, Popover, Tooltip } from "./overlays"

export const kindName: Record<AnnotationKind, string> = { followup: "跟进", special: "特殊情况", other: "其他" }

interface Ctx {
  enterprise: string
  list: Annotation[]
  mode: "rail" | "inline"
  active: string | null
  setActive: (id: string | null) => void
  composing: { block: string; insightId?: string; quote?: string } | null
  compose: (c: { block: string; insightId?: string; quote?: string } | null) => void
  register: (block: string, el: HTMLElement | null) => void
  blocks: Map<string, HTMLElement>
  version: number
}

const AnnCtx = createContext<Ctx | null>(null)
export const useAnn = () => useContext(AnnCtx)

export const AnnotationScope = ({ enterprise, list, mode, children }: { enterprise: string; list: Annotation[]; mode: "rail" | "inline"; children: ReactNode }) => {
  const [active, setActive] = useState<string | null>(null)
  const [composing, compose] = useState<Ctx["composing"]>(null)
  const blocks = useRef(new Map<string, HTMLElement>()).current
  const [version, setVersion] = useState(0)
  const register = useCallback((block: string, el: HTMLElement | null) => {
    const had = blocks.get(block)
    if (el) {
      if (had === el) return
      blocks.set(block, el)
    } else {
      if (!had) return
      blocks.delete(block)
    }
    setVersion((v) => v + 1)
  }, [])
  useEffect(() => {
    if (!composing && !active) return
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        compose(null)
        setActive(null)
      }
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [composing, active])
  const value = useMemo(() => ({ enterprise, list, mode, active, setActive, composing, compose, register, blocks, version }), [enterprise, list, mode, active, composing, version])
  return <AnnCtx.Provider value={value}>{children}</AnnCtx.Provider>
}

export const Annotatable = ({ block, label, children, className, insightId, quote }: { block: string; label?: string; children: ReactNode; className?: string; insightId?: string; quote?: string }) => {
  const ctx = useAnn()
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ctx) return
    ctx.register(block, ref.current)
    return () => ctx.register(block, null)
  }, [block, !!ctx])
  const mine = ctx ? ctx.list.filter((a) => a.anchor?.block === block && !a.resolved) : []
  const hot = !!ctx && (mine.some((a) => a.id === ctx.active) || ctx.composing?.block === block)
  return (
    <div ref={ref} className={cx("annotatable", hot && "hot", className)} data-section={block}>
      {children}
      {ctx && (
        <div className="ann-hook">
          {ctx.mode === "inline" && mine.length > 0 ? (
            <InlineThread block={block} items={mine} label={label} insightId={insightId} quote={quote} />
          ) : (
            <Tooltip content={`批注${label ? ` · ${label}` : ""}`}>
              <button className={cx("ann-btn", mine.length > 0 && "has")} onClick={() => ctx.compose({ block, insightId, quote })} aria-label="添加批注">
                <Icon name="edit" size="xs" />
                {mine.length > 0 && <span className="num">{mine.length}</span>}
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

const InlineThread = ({ block, items, label, insightId, quote }: { block: string; items: Annotation[]; label?: string; insightId?: string; quote?: string }) => {
  const [adding, setAdding] = useState(false)
  return (
    <Popover
      width={340}
      placement="bottom-end"
      trigger={({ open, toggle, ref }) => (
        <button ref={ref as never} className={cx("ann-btn has", open && "open")} onClick={toggle} aria-label="查看批注">
          <Icon name="edit" size="xs" />
          <span className="num">{items.length}</span>
        </button>
      )}
    >
      {() => (
        <div className="ann-pop">
          <div className="ann-pop-h">
            <span>{label ?? "批注"}</span>
            <span className="spacer" />
            {!adding && (
              <Button size="xs" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
                新批注
              </Button>
            )}
          </div>
          {adding && <Composer anchor={{ block, insightId, quote }} onDone={() => setAdding(false)} autoFocus />}
          <div className="ann-pop-list">
            {items.map((a) => (
              <Thread key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}
    </Popover>
  )
}

export const Composer = ({ anchor, onDone, autoFocus, placeholder = "写批注，⌘↵ 保存" }: { anchor?: { block: string; insightId?: string; quote?: string } | null; onDone?: () => void; autoFocus?: boolean; placeholder?: string }) => {
  const ctx = useAnn()
  const ops = useAnnotate(ctx?.enterprise ?? "")
  const [text, setText] = useState("")
  const [kind, setKind] = useState<AnnotationKind | "none">("none")
  const save = () => {
    const t = text.trim()
    if (!t || !ctx) return
    ops.create.mutate({ text: t, kind: kind === "none" ? undefined : kind, anchor: anchor ?? undefined })
    setText("")
    setKind("none")
    onDone?.()
  }
  return (
    <div className="ann-composer">
      {anchor?.quote && <div className="ann-quote">{anchor.quote}</div>}
      <TextArea
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), save())
          if (e.key === "Escape") (e.stopPropagation(), onDone?.())
        }}
        style={{ minHeight: 64 }}
      />
      <div className="ann-composer-f">
        <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "none", label: "不分类" }, { value: "followup", label: "跟进" }, { value: "special", label: "特殊情况" }, { value: "other", label: "其他" }]} />
        <span className="spacer" />
        {onDone && (
          <Button size="xs" variant="ghost" onClick={onDone}>
            取消
          </Button>
        )}
        <Button size="xs" variant="primary" disabled={!text.trim()} onClick={save}>
          保存
        </Button>
      </div>
    </div>
  )
}

export const Thread = ({ a, showAnchor }: { a: Annotation; showAnchor?: boolean }) => {
  const ctx = useAnn()
  const ops = useAnnotate(ctx?.enterprise ?? a.enterprise.id)
  const [reply, setReply] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [open, setOpen] = useState(!a.resolved)
  const pending = a.id.startsWith("tmp")
  const send = () => {
    const t = reply.trim()
    if (!t) return
    ops.append.mutate({ id: a.id, text: t })
    setReply("")
  }
  if (a.resolved && !open)
    return (
      <button className="ann-thread resolved" onClick={() => setOpen(true)}>
        <Icon name="check" size="xs" />
        <span className="ellipsis">{a.entries[0]?.text}</span>
        <span className="faint num">{time(a.updatedAt)}</span>
      </button>
    )
  return (
    <div className={cx("ann-thread", ctx?.active === a.id && "active", pending && "pending")} onMouseEnter={() => ctx?.setActive(a.id)} onMouseLeave={() => ctx?.setActive(null)}>
      <div className="ann-head">
        {a.kind && <span className={cx("ann-kind", a.kind)}>{kindName[a.kind]}</span>}
        {showAnchor && a.anchor && <span className="ann-where ellipsis">{a.anchor.block}</span>}
        <span className="spacer" />
        {!pending && (
          <>
            <Tooltip content={a.resolved ? "重新打开" : "标为已处理"}>
              <IconButton size="xs" icon={a.resolved ? "refresh" : "check"} label={a.resolved ? "重新打开" : "已处理"} onClick={() => ops.update.mutate({ id: a.id, resolved: !a.resolved })} />
            </Tooltip>
            <Menu
              width={160}
              items={[
                ...(["followup", "special", "other"] as AnnotationKind[]).map((k) => ({ key: k, label: `标为${kindName[k]}`, onSelect: () => ops.update.mutate({ id: a.id, kind: a.kind === k ? null : k }) })),
                { key: "sep", label: "", sep: true },
                { key: "del", label: "删除整条", icon: "trash" as const, danger: true, onSelect: () => ops.remove.mutate(a.id) },
              ]}
              trigger={({ toggle, ref }) => <IconButton ref={ref as never} size="xs" icon="more" label="更多" onClick={toggle} />}
            />
          </>
        )}
      </div>
      {a.anchor?.quote && <div className={cx("ann-quote", a.anchor.stale && "stale")}>{a.anchor.quote}{a.anchor.stale && <span className="ann-stale">原文已更新</span>}</div>}
      <div className="ann-entries">
        {a.entries.map((en) => (
          <div key={en.id} className="ann-entry">
            <div className="ann-meta">
              <span className="num">{time(en.createdAt)}</span>
              {en.editedAt && <span className="faint">已编辑</span>}
              <span className="spacer" />
              {!pending && editing !== en.id && (
                <span className="ann-acts">
                  <button onClick={() => (setEditing(en.id), setDraft(en.text))}>编辑</button>
                  {a.entries.length > 1 && <button onClick={() => ops.removeEntry.mutate({ id: a.id, entryId: en.id })}>删除</button>}
                </span>
              )}
            </div>
            {editing === en.id ? (
              <div className="stack" style={{ gap: 6 }}>
                <TextArea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), draft.trim() && ops.editEntry.mutate({ id: a.id, entryId: en.id, text: draft.trim() }), setEditing(null))
                    if (e.key === "Escape") (e.stopPropagation(), setEditing(null))
                  }}
                  style={{ minHeight: 48 }}
                />
                <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                    取消
                  </Button>
                  <Button size="xs" variant="primary" onClick={() => (draft.trim() && ops.editEntry.mutate({ id: a.id, entryId: en.id, text: draft.trim() }), setEditing(null))}>
                    保存
                  </Button>
                </div>
              </div>
            ) : (
              <div className="ann-text">{en.text}</div>
            )}
          </div>
        ))}
      </div>
      {!pending && !a.resolved && (
        <div className="ann-reply">
          <input
            value={reply}
            placeholder="追加跟进"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send())
            }}
          />
          {reply && (
            <button className="ann-send" onClick={send} aria-label="追加">
              <Icon name="arrowUpRight" size="xs" />
            </button>
          )}
        </div>
      )}
      {a.resolved && (
        <button className="ann-fold" onClick={() => setOpen(false)}>
          收起
        </button>
      )}
    </div>
  )
}

export const AnnotationRail = () => {
  const ctx = useAnn()
  const rail = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Record<string, number>>({})
  const groups = useMemo(() => {
    const g = new Map<string, Annotation[]>()
    if (!ctx) return g
    ctx.list.forEach((a) => {
      if (a.anchor && !a.resolved && ctx.blocks.has(a.anchor.block)) g.set(a.anchor.block, [...(g.get(a.anchor.block) ?? []), a])
    })
    if (ctx.composing && ctx.blocks.has(ctx.composing.block) && !g.has(ctx.composing.block)) g.set(ctx.composing.block, [])
    return g
  }, [ctx?.list, ctx?.composing, ctx?.version])
  const measure = useCallback(() => {
    if (!ctx || !rail.current) return
    const top = rail.current.getBoundingClientRect().top
    const order = [...groups.keys()].map((b) => ({ b, y: (ctx.blocks.get(b)?.getBoundingClientRect().top ?? 0) - top })).sort((a, b) => a.y - b.y)
    const out: Record<string, number> = {}
    let floor = 0
    for (const o of order) {
      const y = Math.max(o.y, floor)
      out[o.b] = y
      const el = rail.current.querySelector<HTMLElement>(`[data-rail="${CSS.escape(o.b)}"]`)
      floor = y + (el?.offsetHeight ?? 120) + 10
    }
    setPos((prev) => {
      const keys = Object.keys(out)
      return keys.length === Object.keys(prev).length && keys.every((k) => Math.abs((prev[k] ?? -1) - out[k]) < 0.5) ? prev : out
    })
  }, [groups])
  useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (rail.current) ro.observe(rail.current)
    ctx?.blocks.forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [measure])
  if (!ctx) return null
  return (
    <div ref={rail} className="ann-rail">
      {[...groups].map(([b, list]) => (
        <div key={b} data-rail={b} className="ann-rail-g" style={{ transform: `translateY(${pos[b] ?? 0}px)` }}>
          {ctx.composing?.block === b && <Composer anchor={ctx.composing} onDone={() => ctx.compose(null)} autoFocus />}
          {list.map((a) => (
            <Thread key={a.id} a={a} />
          ))}
        </div>
      ))}
    </div>
  )
}

export const ComposerPopover = () => {
  const ctx = useAnn()
  if (!ctx || ctx.mode !== "inline" || !ctx.composing) return null
  const el = ctx.blocks.get(ctx.composing.block)
  return el ? <FloatingComposer anchor={el} /> : null
}

const FloatingComposer = ({ anchor }: { anchor: HTMLElement }) => {
  const ctx = useAnn()!
  const box = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" })
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const w = 340
      const h = box.current?.offsetHeight ?? 180
      const top = Math.min(window.innerHeight - h - 12, Math.max(12, r.top + 8))
      const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w - 8))
      setStyle({ top, left, width: w })
    }
    place()
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [anchor])
  useEffect(() => {
    const f = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest(".ann-btn,.pop") && ctx.compose(null)
    document.addEventListener("mousedown", f, true)
    return () => document.removeEventListener("mousedown", f, true)
  }, [])
  return (
    <div ref={box} className="pop ann-float" style={{ ...style, position: "fixed" }}>
      <Composer anchor={ctx.composing} onDone={() => ctx.compose(null)} autoFocus />
    </div>
  )
}

export const useQuoteSelection = (container: React.RefObject<HTMLElement | null>) => {
  const ctx = useAnn()
  const [sel, setSel] = useState<{ x: number; y: number; quote: string; block: string; insightId?: string } | null>(null)
  useEffect(() => {
    const up = () => {
      const s = window.getSelection()
      const text = s?.toString().trim() ?? ""
      if (!s || !text || text.length < 2 || !container.current) return setSel(null)
      const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement
      const host = node?.closest<HTMLElement>("[data-quote-block]")
      if (!host || !container.current.contains(host)) return setSel(null)
      const r = s.getRangeAt(0).getBoundingClientRect()
      setSel({ x: r.left + r.width / 2, y: r.top, quote: text.slice(0, 200), block: host.dataset.quoteBlock!, insightId: host.dataset.insight })
    }
    const down = (e: MouseEvent) => !(e.target as HTMLElement).closest(".quote-btn") && setSel(null)
    document.addEventListener("mouseup", up)
    document.addEventListener("mousedown", down)
    return () => {
      document.removeEventListener("mouseup", up)
      document.removeEventListener("mousedown", down)
    }
  }, [])
  const button = sel && ctx ? (
    <button
      className="quote-btn"
      style={{ left: sel.x, top: sel.y }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        ctx.compose({ block: sel.block, insightId: sel.insightId, quote: sel.quote })
        window.getSelection()?.removeAllRanges()
        setSel(null)
      }}
    >
      <Icon name="edit" size="xs" />
      批注
    </button>
  ) : null
  return button
}

export const AnnotationTimeline = ({ list }: { list: Annotation[] }) => {
  const [filter, setFilter] = useState<"open" | "all" | AnnotationKind>("open")
  const shown = list.filter((a) => (filter === "open" ? !a.resolved : filter === "all" ? true : a.kind === filter)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  const counts = { open: list.filter((a) => !a.resolved).length, all: list.length }
  return (
    <div className="ann-timeline">
      <Composer placeholder="写一条批注，⌘↵ 保存" />
      <div className="row" style={{ margin: "18px 0 10px" }}>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: "未处理", count: counts.open },
            { value: "all", label: "全部", count: counts.all },
            { value: "followup", label: "跟进" },
            { value: "special", label: "特殊情况" },
          ]}
        />
      </div>
      {shown.length ? (
        <div className="ann-tl-list">
          {shown.map((a) => (
            <div key={a.id} className="ann-tl-item">
              <span className="ann-tl-dot" />
              <Thread a={a} showAnchor />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty compact">
          <span className="d">没有批注</span>
        </div>
      )}
    </div>
  )
}

export { Kbd }
