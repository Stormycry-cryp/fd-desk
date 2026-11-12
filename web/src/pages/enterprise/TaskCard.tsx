import type { Task } from "@spec/contract"
import { patternName, sampleReasonName } from "../../lib/labels"
import { time } from "../../lib/format"
import { Badge, Thumb } from "../../ui/display"
import { cx } from "../../ui/controls"
import { Icon } from "../../ui/icons"
import { Tooltip } from "../../ui/overlays"
import { fdUrl } from "../../lib/fd"

export const TaskCard = ({ t, onOpen }: { t: Task; onOpen: () => void }) => {
  const out = t.outputs[0] ?? null
  const input = t.inputs[0] ?? null
  const reason = t.sampleReason
  const link = fdUrl(t)
  return (
    <div className="task-card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
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
        {link && (
          <Tooltip content="在 FD 中打开">
            <a className="fd-link" href={link} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} aria-label="在 FD 中打开">
              <Icon name="external" size="xs" />
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
