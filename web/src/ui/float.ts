import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top" | "bottom" | "right-start"

export const useFloating = (open: boolean, opts: { placement?: Placement; offset?: number; matchWidth?: boolean } = {}) => {
  const anchor = useRef<HTMLElement | null>(null)
  const floating = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number; above: boolean } | null>(null)
  const { placement = "bottom-start", offset = 6, matchWidth = false } = opts
  const update = useCallback(() => {
    const a = anchor.current
    const f = floating.current
    if (!a || !f) return
    const r = a.getBoundingClientRect()
    const fw = f.offsetWidth
    const fh = f.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let above = placement.startsWith("top")
    if (!above && r.bottom + offset + fh > vh - 8 && r.top - offset - fh > 8) above = true
    if (above && r.top - offset - fh < 8 && r.bottom + offset + fh < vh - 8) above = false
    let top = above ? r.top - offset - fh : r.bottom + offset
    let left = placement.endsWith("end") ? r.right - Math.max(fw, matchWidth ? r.width : 0) : placement === "top" || placement === "bottom" ? r.left + r.width / 2 - fw / 2 : r.left
    if (placement === "right-start") {
      left = r.right + offset
      top = r.top
      above = false
    }
    left = Math.max(8, Math.min(left, vw - fw - 8))
    top = Math.max(8, Math.min(top, vh - fh - 8))
    setPos({ top, left, minWidth: matchWidth ? r.width : undefined, above })
  }, [placement, offset, matchWidth])
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    update()
    const ro = new ResizeObserver(update)
    if (floating.current) ro.observe(floating.current)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open, update])
  const style = pos ? { top: pos.top, left: pos.left, minWidth: pos.minWidth } : { top: -9999, left: -9999, visibility: "hidden" as const }
  return { anchor, floating, style, above: pos?.above ?? false }
}

export const useDismiss = (open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[]) => {
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (refs.some((r) => r.current && r.current.contains(e.target as Node))) return
      close()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener("mousedown", down, true)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("mousedown", down, true)
      document.removeEventListener("keydown", key, true)
    }
  }, [open, close])
}
