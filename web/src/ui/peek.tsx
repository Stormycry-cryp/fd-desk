import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Media } from "@spec/contract"
import { Portal } from "./overlays"

const small = (m: Media) => (m.kind === "video" ? m.poster ?? m.thumb : m.thumb)
const large = (m: Media) => {
  const src = small(m)
  return src.includes("/api/media/thumb") ? src.replace(/([?&]w=)\d+/, "$11200") : m.kind === "image" ? m.url : src
}

const warmed = new Set<string>()
export const warm = (m: Media | null | undefined) => {
  if (!m) return
  const u = large(m)
  if (warmed.has(u)) return
  warmed.add(u)
  const img = new Image()
  img.decoding = "async"
  img.src = u
}

let closeOpen: (() => void) | null = null

export const Peek = ({ media, label, children, delay = 160 }: { media: Media | null | undefined; label?: ReactNode; children: ReactNode; delay?: number }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  const [sharp, setSharp] = useState(false)
  const close = () => {
    if (timer.current) clearTimeout(timer.current)
    setPos(null)
    setSharp(false)
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
  return (
    <span
      ref={ref}
      className="peek-a"
      onMouseEnter={() => {
        warm(media)
        timer.current = setTimeout(() => {
          const r = ref.current?.getBoundingClientRect()
          if (!r) return
          closeOpen?.()
          closeOpen = close
          const img = ref.current?.querySelector("img")
          const ar = img && img.naturalWidth ? img.naturalWidth / img.naturalHeight : 0.75
          let h = Math.min(window.innerHeight - 40, 820)
          let w = Math.round(h * ar)
          const maxW = Math.min(900, window.innerWidth * 0.55)
          if (w > maxW) (w = Math.round(maxW), (h = Math.round(maxW / ar)))
          const right = r.right + 16 + w < window.innerWidth - 16
          const top = Math.max(20, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 20))
          setPos({ left: right ? r.right + 16 : Math.max(16, r.left - 16 - w), top, w, h })
        }, delay)
      }}
      onMouseLeave={close}
      onMouseDown={close}
    >
      {children}
      {pos && (
        <Portal>
          <div className="peek" style={{ left: pos.left, top: pos.top, width: pos.w, height: pos.h }}>
            <img className="lo" src={small(media)} alt="" />
            <img className={sharp ? "hi on" : "hi"} src={large(media)} alt="" onLoad={() => setSharp(true)} />
            {label && <span className="peek-l">{label}</span>}
          </div>
        </Portal>
      )}
    </span>
  )
}
