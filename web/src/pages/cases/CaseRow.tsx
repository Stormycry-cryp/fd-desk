import { memo } from "react"
import type { Media } from "@spec/contract"
import { levelName, movementName } from "../../lib/labels"
import { time } from "../../lib/format"
import { Checkbox, cx } from "../../ui/controls"
import { Thumb } from "../../ui/display"
import { Peek } from "../../ui/peek"
import { Icon } from "../../ui/icons"
import { Tooltip } from "../../ui/overlays"
import type { CaseRating, CaseReview, CaseTag, Row, Step } from "./types"
import { outcomeLong, outcomeName, ratingName, ratingOrder, resultName } from "./model"

export const OutcomePill = ({ o, sm }: { o: Row["outcome"]; sm?: boolean }) => <span className={cx("cx-out", o, sm && "sm")}>{outcomeName[o]}</span>

export const StepDot = ({ s }: { s: Step }) => (
  <Tooltip content={resultName[s.result]}>
    <span className={cx("cx-dot", s.result)} />
  </Tooltip>
)

export const RatingPills = ({ value, onPick, size }: { value: CaseRating | null | undefined; onPick: (r: CaseRating | null) => void; size?: "sm" | "lg" }) => (
  <div className={cx("cx-rate", size)} onClick={(e) => e.stopPropagation()}>
    {ratingOrder.map((r, i) => (
      <button key={r} className={cx(r, value === r && "on")} onClick={() => onPick(value === r ? null : r)}>
        {ratingName[r]}
        {size === "lg" && <span className="k">{i + 1}</span>}
      </button>
    ))}
  </div>
)

export const TagList = ({ ids, tags, max = 2 }: { ids: string[]; tags: Map<string, CaseTag>; max?: number }) => {
  if (!ids.length) return null
  const xs = ids.map((id) => tags.get(id)).filter((t): t is CaseTag => !!t)
  return (
    <span className="cx-tags">
      {xs.slice(0, max).map((t) => (
        <span key={t.id} className={cx("cx-tag", t.tone)}>
          {t.label}
        </span>
      ))}
      {xs.length > max && (
        <Tooltip content={xs.slice(max).map((t) => t.label).join("、")}>
          <span className="cx-tag more">+{xs.length - max}</span>
        </Tooltip>
      )}
    </span>
  )
}

const mid = (r: Row): Media[] => {
  const steps = r.steps ?? []
  return steps.slice(0, -1).map((s) => s.outputs[0]).filter((m): m is Media => !!m)
}

const stepsLabel = (r: Row) => {
  if (r.unit === "task" || r.stepCount === 1) return r.outcome === "good" ? "已下载" : resultName[r.last.result]
  if (r.downloadedAt == null) return `${r.stepCount} 步没下载`
  return r.downloadedAt === 0 ? `${r.stepCount} 步 · 第 1 步下载` : `第 ${r.downloadedAt + 1}/${r.stepCount} 步下载`
}

const dur = (s: number | null) => (s == null ? null : s >= 60 ? `${Math.floor(s / 60)}分${Math.round(s % 60)}秒` : `${Math.round(s)}秒`)

export const Meta = ({ r, onEnt }: { r: Row; onEnt?: () => void }) => (
  <div className="cx-meta">
    <button
      className="cx-ent"
      onClick={(e) => {
        e.stopPropagation()
        onEnt?.()
      }}
    >
      {r.enterprise.name}
    </button>
    {r.enterprise.level && <span className={cx("cx-lv", r.enterprise.level)}>{levelName[r.enterprise.level]}</span>}
    {r.enterprise.movement && ["lost", "drop", "silent", "new", "returned"].includes(r.enterprise.movement) && <span className={cx("cx-mv", r.enterprise.movement)}>{movementName[r.enterprise.movement]}</span>}
    {r.intent && <span>{r.intent}</span>}
    <span className={cx("cx-steps", r.outcome)}>{stepsLabel(r)}</span>
    {r.slow && (
      <Tooltip content="比同模型九成任务都慢">
        <span className="cx-slow">
          <Icon name="clock" size="xs" />
          {dur(r.durationSeconds)}
        </span>
      </Tooltip>
    )}
    <span className="faint num">{time(r.startedAt)}</span>
  </div>
)

export const CaseLine = memo(function CaseLine({ r, rv, notes, on, focus, tags, onOpen, onToggle, onRate, onEnt }: { r: Row; rv: CaseReview | null; notes: number; on: boolean; focus: boolean; tags: Map<string, CaseTag>; onOpen: () => void; onToggle: () => void; onRate: (v: CaseRating | null) => void; onEnt: () => void }) {
  const ins = r.first.inputs
  const ms = mid(r)
  const out = r.last.outputs[0] ?? null
  const changed = r.stepCount > 1 && r.last.prompt && r.last.prompt !== r.first.prompt
  return (
    <div className={cx("cx-row", r.outcome, on && "on", focus && "focus")} role="button" tabIndex={-1} onClick={onOpen} data-key={`${r.unit}:${r.id}`}>
      <span className="cx-check" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={on} onChange={onToggle} />
      </span>
      <div className="cx-media">
        <div className="cx-ins">
          {ins.slice(0, 3).map((m, i) => (
            <Peek key={i} media={m} label={`输入 ${i + 1}`}>
              <Thumb media={m} w={84} ratio={4 / 3} radius={8} />
            </Peek>
          ))}
          {ins.length > 3 && <span className="cx-more num">+{ins.length - 3}</span>}
          {!ins.length && <span className="cx-noin">无输入图</span>}
        </div>
        <Icon name="arrowRight" size="xs" className="cx-arrow" />
        <div className={cx("cx-res", r.last.result)}>
          <Peek media={out} label={r.stepCount > 1 ? `第 ${r.stepCount} 步结果` : "结果"}>
            <Thumb media={out} w={120} ratio={4 / 3} radius={10} dim={!out} />
          </Peek>
          {r.stepCount > 1 && <span className="cx-res-n num">{r.stepCount} 步</span>}
          <StepDot s={r.last} />
        </div>
      </div>
      <div className="cx-body">
        <div className="cx-p">{r.first.prompt || <span className="faint">没有提示词</span>}</div>
        {changed && (
          <div className="cx-p2">
            <span className="k">最后</span>
            {r.last.prompt}
          </div>
        )}
        <Meta r={r} onEnt={onEnt} />
      </div>
      {ms.length > 0 ? (
        <div className="cx-mid">
          {(r.steps ?? []).slice(0, -1).slice(-5).map((st) => (
            <span key={st.rowKey} className={cx("cx-mid-i", st.result)}>
              <Peek media={st.outputs[0]} label={`第 ${st.index + 1} 步`}>
                <Thumb media={st.outputs[0]} w={44} ratio={4 / 3} radius={6} dim={!st.outputs[0]} />
              </Peek>
            </span>
          ))}
          {r.stepCount - 1 > 5 && <span className="cx-more sm num">+{r.stepCount - 6}</span>}
        </div>
      ) : null}
      <div className="cx-side" onClick={(e) => e.stopPropagation()}>
        <RatingPills value={rv?.rating} onPick={onRate} size="sm" />
        <div className="cx-side-b">
          {rv && <TagList ids={rv.tags} tags={tags} />}
          {notes > 0 && (
            <span className="cx-note num">
              <Icon name="edit" size="xs" />
              {notes}
            </span>
          )}
          {rv?.status === "done" && (
            <Tooltip content="已处理">
              <span className="cx-done">
                <Icon name="check" size="xs" />
              </span>
            </Tooltip>
          )}
          {rv?.status === "seen" && !rv.rating && (
            <Tooltip content="已看">
              <span className="cx-seen">
                <Icon name="eye" size="xs" />
              </span>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
})

export const CaseCard = memo(function CaseCard({ r, rv, notes, on, focus, tags, onOpen, onToggle }: { r: Row; rv: CaseReview | null; notes: number; on: boolean; focus: boolean; tags: Map<string, CaseTag>; onOpen: () => void; onToggle: () => void }) {
  const out = r.last.outputs[0] ?? null
  return (
    <div className={cx("cx-card", r.outcome, on && "on", focus && "focus")} role="button" tabIndex={-1} onClick={onOpen} data-key={`${r.unit}:${r.id}`}>
      <div className="cx-card-m">
        <Thumb media={out ?? r.first.inputs[0]} w="100%" ratio={4 / 3} radius={0} dim={!out} />
        <span className="cx-card-ins">
          {r.first.inputs.slice(0, 3).map((m, i) => (
            <Peek key={i} media={m} label={`输入 ${i + 1}`}>
              <Thumb media={m} w={40} ratio={4 / 3} radius={6} />
            </Peek>
          ))}
        </span>
        <span className="cx-card-tl">
          <OutcomePill o={r.outcome} sm />
          {r.stepCount > 1 && <span className="cx-card-n num">{r.stepCount} 步</span>}
        </span>
        <span className="cx-card-ck" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={on} onChange={onToggle} />
        </span>
        {rv?.rating && <span className={cx("cx-card-r", rv.rating)}>{ratingName[rv.rating]}</span>}
      </div>
      <div className="cx-card-b">
        <div className="cx-card-e ellipsis">{r.enterprise.name}</div>
        <div className="cx-card-p">{r.first.prompt || "—"}</div>
        <div className="cx-card-f">
          {rv && <TagList ids={rv.tags} tags={tags} max={1} />}
          <span className="spacer" />
          {notes > 0 && (
            <span className="cx-note num">
              <Icon name="edit" size="xs" />
              {notes}
            </span>
          )}
        </div>
      </div>
    </div>
  )
})

export const outcomeHint = outcomeLong
