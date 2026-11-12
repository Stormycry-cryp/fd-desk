import { useEffect, useRef, useState, type ReactNode } from "react"
import { cx } from "./controls"

export const StickyBar = ({ className, children }: { className?: string; children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const check = () => {
      raf = 0
      const top = parseFloat(getComputedStyle(el).top) || 0
      setStuck(el.getBoundingClientRect().top <= top + 0.5)
    }
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    check()
    window.addEventListener("scroll", on, true)
    window.addEventListener("resize", on)
    return () => {
      window.removeEventListener("scroll", on, true)
      window.removeEventListener("resize", on)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return (
    <div ref={ref} className={cx("sbar", stuck && "stuck", className)}>
      {children}
    </div>
  )
}
