import type { MovementAnalysis } from "@spec/contract"
import { useNext } from "../api/next"
import { num } from "../lib/format"
import { Button } from "../ui/controls"
import { navigate } from "../lib/route"
import { cx } from "../ui/controls"
import { Delta } from "../ui/display"
import { ConfidenceDot, EvidenceChip, JobProgress } from "../ui/insight"
import { Icon } from "../ui/icons"

export const MovementCard = ({ m, showName, compact }: { m: MovementAnalysis; showName?: boolean; compact?: boolean }) => {
  const running = m.state === "queued" || m.state === "running"
  const follow = useNext("POST /api/followups", ["GET /api/followups"], { ok: "已加入跟进清单" })
  return (
    <div className={cx("mv-card", m.direction, compact && "compact")} data-section={`movement`}>
      <div className="mv-h">
        {showName && (
          <button className="mv-name ellipsis" onClick={() => navigate({ ent: m.enterprise.id })}>
            {m.enterprise.name}
          </button>
        )}
        <span className="mv-num num">
          {num(m.change.previous)} → <b>{num(m.change.current)}</b>
        </span>
        <Delta pair={m.change} pill />
        <span className="spacer" />
        {m.state === "done" && <ConfidenceDot c={m.confidence} />}
        {m.trigger === "auto" && <span className="mv-auto">自动</span>}
      </div>
      {running ? (
        <JobProgress state={m.state} label="正在分析原因" />
      ) : m.state === "failed" ? (
        <div className="mv-fail">
          <Icon name="alert" size="xs" />
          {m.error?.message ?? "分析失败"}
        </div>
      ) : (
        <>
          <div className="mv-head">{m.headline}</div>
          {!compact && m.reasons.length > 0 && (
            <ol className="mv-reasons">
              {m.reasons.map((r, i) => (
                <li key={i}>
                  <span>{r.text}</span>
                  <EvidenceChip e={r.evidence} />
                </li>
              ))}
            </ol>
          )}
          {!compact && m.action && (
            <div className="mv-action">
              <Icon name="target" size="xs" />
              <span className="grow">{m.action}</span>
              <Button size="xs" variant="ghost" icon="plus" loading={follow.isPending} disabled={follow.isSuccess} onClick={() => follow.mutate({ body: { line: m.line, week: m.week, enterprise: m.enterprise.id, goal: m.direction === "down" ? "retain" : "keep", reason: m.headline, script: m.action ?? undefined } })}>
                {follow.isSuccess ? "已加入" : "加入跟进"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
