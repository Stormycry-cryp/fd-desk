import { useEffect, useRef } from "react"

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
}

export const useKey = (handler: (e: KeyboardEvent) => void, deps: unknown[] = [], allowInInputs = false) => {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!allowInInputs && typing(e)) return
      ref.current(e)
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, deps)
}
