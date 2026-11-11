import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Media } from "@spec/contract"
import { Kbd } from "./controls"

export type CompareMode = "side" | "slide" | "flip"
export const compareModeName: Record<CompareMode, string> = { side: "并排", slide: "滑动", flip: "切换" }

export const MediaView = ({ m, label, empty }: { m: Media | null | undefined; label: string; empty?: ReactNode }) =>
  m ? (
    m.kind === "video" ? <video src={m.url} poster={m.poster ?? undefined} controls muted loop playsInline /> : <img src={m.url} alt={label} draggable={false} />
  ) : (
    <div className="cv-none">{empty ?? `${label}没有结果`}</div>
  )

const useRatio = (a: Media | null | undefined, b: Media | null | undefined) => {
  const [ar, setAr] = useState<number | null>(null)
  useEffect(() => {
    setAr(null)
    const src = b?.kind === "image" ? b.url : a?.kind === "image" ? a.url : null
    if (!src) return
    const im = new Image()
    im.onload = () => im.naturalWidth && setAr(im.naturalWidth / im.naturalHeight)
    im.src = src
  }, [a?.url, b?.url])
  return ar
}

export const CompareStage = ({ a, b, la, lb, ca, cb, mode, flip, setFlip, emptyB }: { a: Media | null | undefined; b: Media | null | undefined; la: string; lb: string; ca?: ReactNode; cb?: ReactNode; mode: CompareMode; flip: boolean; setFlip: (v: boolean) => void; emptyB?: ReactNode }) => {
  const [split, setSplit] = useState(50)
  const box = useRef<HTMLDivElement>(null)
  const ar = useRatio(a, b)
  const drag = (e: React.PointerEvent) => {
    const el = box.current
    if (!el) return
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      setSplit(Math.max(2, Math.min(98, ((ev.clientX - r.left) / r.width) * 100)))
    }
    move(e.nativeEvent)
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up))
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  if (mode === "side")
    return (
      <div className="cv-side">
        <figure>
          <MediaView m={a} label={la} />
          <figcaption>{ca ?? la}</figcaption>
        </figure>
        <figure>
          <MediaView m={b} label={lb} empty={emptyB} />
          <figcaption>{cb ?? lb}</figcaption>
        </figure>
      </div>
    )
  if (mode === "slide")
    return (
      <div className="cv-slide" ref={box} onPointerDown={drag} style={{ aspectRatio: ar ?? 1 }}>
        <div className="cv-layer">
          <MediaView m={b} label={lb} empty={emptyB} />
        </div>
        <div className="cv-layer top" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <MediaView m={a} label={la} />
        </div>
        <div className="cv-handle" style={{ left: `${split}%` }}>
          <span />
        </div>
        <span className="cv-lab l">{la}</span>
        <span className="cv-lab r">{lb}</span>
      </div>
    )
  return (
    <div className="cv-flip" onClick={() => setFlip(!flip)} style={{ aspectRatio: ar ?? 1 }}>
      <MediaView m={flip ? a : b} label={flip ? la : lb} empty={emptyB} />
      <span className="cv-lab l">
        {flip ? la : lb}
        <Kbd keys={["Space"]} />
      </span>
    </div>
  )
}
