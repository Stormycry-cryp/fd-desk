import type { Task } from "@spec/contract"
import { patternName, sampleReasonName } from "../../lib/labels"
import { time } from "../../lib/format"
import { Badge, Thumb } from "../../ui/display"
import { cx } from "../../ui/controls"

export const TaskCard = ({ t, onOpen }: { t: Task; onOpen: () => void }) => {
  const out = t.outputs[0] ?? null
  const input = t.inputs[0] ?? null
  const reason = t.sampleReason
  return (
    <button className="task-card" onClick={onOpen}>
      <div className="media">
        <Thumb media={out ?? input} w="100%" ratio={4 / 3} dim={!out} />
        {out && input && t.line === "inspiration" && (
          <span className="inset">
            <Thumb media={input} w="100%" ratio={4 / 3} radius={6} />
          </span>
        )}
        {reason && (
          <span className="tag">
            <Badge tone={reason === "stuck" || reason === "failed" ? "down" : reason === "batch" ? "accent" : reason === "downloaded" ? "up" : undefined}>{sampleReasonName[reason]}</Badge>
          </span>
        )}
      </div>
      <div className="p">{t.prompt}</div>
      <div className="m">
        <span className={cx("dl-dot", t.downloaded && "on", t.failed && "fail")} />
        <span className="num">{time(t.createdAt)}</span>
        {!reason && t.pattern !== "none" && t.pattern !== "new" && <span>· {patternName[t.pattern]}</span>}
        <span className="spacer" />
        <span className="ellipsis" style={{ maxWidth: 80 }}>{t.model}</span>
      </div>
    </button>
  )
}
