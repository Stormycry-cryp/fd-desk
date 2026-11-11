import { useEffect, useRef, useState } from "react"
import type { Mark, Media, TrialArm, TrialRun } from "@spec/contract"
import { Kbd, cx } from "../../ui/controls"
import { Button } from "../../ui/controls"
import { Icon } from "../../ui/icons"
import { MarkControl } from "../../ui/prompt"
import { Portal } from "../../ui/overlays"

type Mode = "side" | "slide" | "flip"

const Img = ({ m, label }: { m: Media | null | undefined; label: string }) =>
  m ? (
    m.kind === "video" ? <video src={m.url} poster={m.poster ?? undefined} controls muted loop /> : <img src={m.url} alt={label} draggable={false} />
  ) : (
    <div className="cv-none">{label}没有结果</div>
  )

export const CompareViewer = ({ run, arms, at, setAt, onClose, onMark, onAdopt }: { run: TrialRun; arms: TrialArm[]; at: { c: number; a: number }; setAt: (v: { c: number; a: number }) => void; onClose: () => void; onMark: (caseId: string, armId: string, b: { mark?: Mark | null; usable?: boolean | null }) => void; onAdopt?: (armId: string, caseId: string) => void }) => {
  const [mode, setMode] = useState<Mode>("side")
  const [flip, setFlip] = useState(false)
  const [split, setSplit] = useState(50)
  const [out, setOut] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const c = run.cases[at.c]
  const arm = arms[Math.min(at.a, arms.length - 1)]
  const cell = c?.cells.find((x) => x.armId === arm?.id)
  const orig = c?.task.outputs[0]
  const next = cell?.outputs[out] ?? cell?.outputs[0]
  useEffect(() => setOut(0), [at.c, at.a])
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return
      const k = e.key
      if (k === "Escape") return onClose()
      if (k === "ArrowRight") (e.preventDefault(), setAt({ ...at, c: Math.min(run.cases.length - 1, at.c + 1) }))
      if (k === "ArrowLeft") (e.preventDefault(), setAt({ ...at, c: Math.max(0, at.c - 1) }))
      if (k === "ArrowDown") (e.preventDefault(), setAt({ ...at, a: Math.min(arms.length - 1, at.a + 1) }))
      if (k === "ArrowUp") (e.preventDefault(), setAt({ ...at, a: Math.max(0, at.a - 1) }))
      if (k === " ") (e.preventDefault(), setFlip((v) => !v))
      if (!c || !arm || cell?.state !== "done") return
      const marks: Record<string, Mark> = { "1": "better", "2": "same", "3": "worse" }
      if (marks[k]) {
        onMark(c.id, arm.id, { mark: cell.mark === marks[k] ? null : marks[k] })
        if (cell.mark !== marks[k] && at.c < run.cases.length - 1) setTimeout(() => setAt({ ...at, c: at.c + 1 }), 160)
      }
      if (k === "u" || k === "U") onMark(c.id, arm.id, { usable: cell.usable ? null : true })
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [at, cell, c, arm, run.cases.length, arms.length])
  useEffect(() => {
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [])
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
  if (!c || !arm) return null
  return (
    <Portal>
      <div className="cv">
        <div className="cv-top">
          <span className="num">
            用例 {at.c + 1}/{run.cases.length}
          </span>
          <div className="cv-arms">
            {arms.map((a, i) => (
              <button key={a.id} className={cx(i === at.a && "on")} onClick={() => setAt({ ...at, a: i })}>
                {a.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div className="cv-modes">
            {(["side", "slide", "flip"] as Mode[]).map((m) => (
              <button key={m} className={cx(mode === m && "on")} onClick={() => setMode(m)}>
                {{ side: "并排", slide: "滑动", flip: "切换" }[m]}
              </button>
            ))}
          </div>
          <button className="cv-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="cv-stage">
          {mode === "side" ? (
            <div className="cv-side">
              <figure>
                <Img m={orig} label="原结果" />
                <figcaption>原结果 · {c.task.model}</figcaption>
              </figure>
              <figure>
                {cell?.state === "done" ? <Img m={next} label={arm.label} /> : <div className="cv-none">{cell?.state === "failed" ? cell.error?.message ?? "失败" : "生成中"}</div>}
                <figcaption>
                  {arm.label} · {arm.model}
                </figcaption>
              </figure>
            </div>
          ) : mode === "slide" ? (
            <div className="cv-slide" ref={box} onPointerDown={drag}>
              <div className="cv-layer">
                <Img m={next} label={arm.label} />
              </div>
              <div className="cv-layer top" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
                <Img m={orig} label="原结果" />
              </div>
              <div className="cv-handle" style={{ left: `${split}%` }}>
                <span />
              </div>
              <span className="cv-lab l">原结果</span>
              <span className="cv-lab r">{arm.label}</span>
            </div>
          ) : (
            <div className="cv-flip" onClick={() => setFlip(!flip)}>
              <Img m={flip ? orig : next} label={flip ? "原结果" : arm.label} />
              <span className="cv-lab l">
                {flip ? "原结果" : arm.label}
                <Kbd keys={["Space"]} />
              </span>
            </div>
          )}
          {at.c > 0 && (
            <button className="nav-btn l" onClick={() => setAt({ ...at, c: at.c - 1 })} aria-label="上一个">
              <Icon name="chevLeft" />
            </button>
          )}
          {at.c < run.cases.length - 1 && (
            <button className="nav-btn r" onClick={() => setAt({ ...at, c: at.c + 1 })} aria-label="下一个">
              <Icon name="chevRight" />
            </button>
          )}
        </div>
        <div className="cv-bot">
          <div className="cv-in">
            {c.task.inputs.slice(0, 4).map((m, i) => (
              <img key={i} src={m.thumb} alt="" />
            ))}
            <span className="cv-p">{c.task.prompt}</span>
          </div>
          {cell && cell.outputs.length > 1 && (
            <div className="cv-outs">
              {cell.outputs.map((m, i) => (
                <button key={i} className={cx(i === out && "on")} onClick={() => setOut(i)}>
                  <img src={m.thumb} alt="" />
                </button>
              ))}
            </div>
          )}
          <span className="spacer" />
          {cell?.state === "done" && <MarkControl value={cell.mark} usable={cell.usable} onMark={(m) => onMark(c.id, arm.id, { mark: m })} onUsable={(u) => onMark(c.id, arm.id, { usable: u })} keys />}
          {onAdopt && cell?.state === "done" && (
            <Button size="sm" variant="primary" icon="check" onClick={() => onAdopt(arm.id, c.id)}>
              采用并设为封面
            </Button>
          )}
        </div>
        <div className="cv-keys">
          <span><Kbd keys={["←", "→"]} />用例</span>
          <span><Kbd keys={["↑", "↓"]} />写法</span>
          <span><Kbd keys={["1", "2", "3"]} />标记</span>
          <span><Kbd keys={["U"]} />可用</span>
          <span><Kbd keys={["Esc"]} />返回</span>
        </div>
      </div>
    </Portal>
  )
}
