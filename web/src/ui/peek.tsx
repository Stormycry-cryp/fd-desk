import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Media } from "@spec/contract"
import { Portal } from "./overlays"

const large = (m: Media) => {
  const src = m.kind === "video" ? m.poster ?? m.thumb : m.thumb
  return src.includes("/api/media/thumb") ? src.replace(/([?&]w=)\d+/, "$11200") : m.kind === "image" ? m.url : src
}

let open: (() => void) | null = null

export const Peek = ({ media, label, children }: { media: Media | null | undefined; label?: ReactNode; children: ReactNode }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; side: "r" | "l" } | null>(null)
  const [ready, setReady] = useState(false)
  const close = () => {
    if (timer.current) clearTimeout(timer.current)
    setPos(null)
    setReady(false)
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  useEffect(() => {
    if (!pos) return
    const f = () => close()
    window.addEventListener("scroll", f, true)
    window.addEventListener("keydown", f)
    return () => {
      window.removeEventListener("scroll", f, true)
      window.removeEventListener("keydown", f)
    }
  }, [pos])
  if (!media) return <>{children}</>
  const W = Math.min(520, window.innerWidth * 0.4)
  return (
    <span
      ref={ref}
      className="peek-a"
      onMouseEnter={() => {
        timer.current = setTimeout(() => {
          const r = ref.current?.getBoundingClientRect()
          if (!r) return
          open?.()
          open = close
          const right = r.right + 14 + W < window.innerWidth - 12
          const top = Math.max(12, Math.min(r.top + r.height / 2 - W * 0.6, window.innerHeight - W * 1.25 - 12))
          setPos({ left: right ? r.right + 14 : r.left - 14 - W, top, side: right ? "r" : "l" })
        }, 220)
      }}
      onMouseLeave={close}
      onMouseDown={close}
    >
      {children}
      {pos && (
        <Portal>
          <div className={`peek ${ready ? "in" : ""}`} style={{ left: pos.left, top: pos.top, width: W }}>
            <img src={large(media)} alt="" onLoad={() => setReady(true)} style={{ maxHeight: W * 1.25 }} />
            {!ready && <span className="peek-load" />}
            {label && <span className="peek-l">{label}</span>}
          </div>
        </Portal>
      )}
    </span>
  )
}
