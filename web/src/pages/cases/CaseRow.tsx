import { memo, useEffect, useState } from "react"
import type { Media } from "@spec/contract"
import { levelName, movementName, patternName } from "../../lib/labels"
import { time } from "../../lib/format"
import { Checkbox, cx } from "../../ui/controls"
import { Peek, warm } from "../../ui/peek"
import { Icon } from "../../ui/icons"
import { Tooltip } from "../../ui/overlays"
import { DiffText } from "../../ui/prompt"
import type { CaseTag, Processed, Review, Row, Step } from "./types"
import { blockOf, durText, outcomeName, resultName, stepsLabel } from "./model"
import { NoteBox, NoteList, TagBar, notesForBlocks, useShared } from "./Review"
import { useCaseDetail } from "./data"

export const OutcomePill = ({ o, sm }: { o: Row["outcome"]; sm?: boolean }) => <span className={cx("cx-out", o, sm && "sm")}>{outcomeName[o]}</span>

export const Pic = ({ m, label, peek = true, onClick, className }: { m: Media | null | undefined; label?: string; peek?: boolean; onClick?: () => void; className?: string }) => {
  const [st, setSt] = useState<"l" | "ok" | "x">("l")
  const src = m ? (m.kind === "video" ? m.poster ?? m.thumb : m.thumb) : null
  const body = (
    <span className={cx("pic", st === "l" && src && "loading", (!src || st === "x") && "broken", className)} onClick={onClick}>
      {src && st !== "x" ? <img src={src} alt="" loading="lazy" decoding="async" className={st === "ok" ? "ready" : ""} onLoad={() => setSt("ok")} onError={() => setSt("x")} /> : <Icon name={m?.kind === "video" ? "video" : "image"} />}
      {m?.kind === "video" && st !== "x" && (
        <span className="play">
          <Icon name="play" size="xs" style={{ fill: "#fff", stroke: "none" }} />
        </span>
      )}
      {label && <span className="pic-l">{label}</span>}
    </span>
  )
  return peek && m ? (
    <Peek media={m} label={label}>
      {body}
    </Peek>
  ) : (
    body
  )
}

export interface CardAct {
  open: (r: Row, stepIdx: number | null) => void
  focus: (r: Row) => void
  select: (r: Row) => void
  expand: (r: Row) => void
  target: (r: Row, idx: number | null) => void
  toggleTag: (r: Row, s: Step | null, t: CaseTag) => void
  createTag: (r: Row, s: Step | null, label: string) => void
  search: (r: Row | null) => void
  note: (r: Row, s: Step | null, text: string) => void
  pool: (r: Row) => void
  stepReview: (r: Row, s: Step) => Review | null
  ent: (r: Row) => void
  register: (key: string, steps: Step[] | null) => void
}

const Inputs = ({ ins, onOpen }: { ins: Media[]; onOpen: () => void }) => {
  if (!ins.length) return <div className="rv-ins none">无输入图</div>
  const n = ins.length
  const shown = n > 4 ? ins.slice(0, 4) : ins
  return (
    <div className={cx("rv-ins", `n${Math.min(n, 4)}`)} onClick={(e) => (e.stopPropagation(), onOpen())}>
      {shown.map((m, i) => (
        <span key={i} className="rv-in">
          <Pic m={m} label={n > 1 ? String(i + 1) : undefined} />
          {i === 3 && n > 4 && <span className="rv-in-more num">+{n - 4}</span>}
        </span>
      ))}
    </div>
  )
}

const StepTile = ({ s, prev, on, rv, onPick, onOpen }: { s: Step; prev: Step | null; on: boolean; rv: Review | null; onPick: () => void; onOpen: () => void }) => {
  const sh = useShared()
  const tags = (rv?.effectiveTags ?? []).map((id) => sh.tagMap.get(id)).filter((t): t is CaseTag => !!t)
  return (
    <div className={cx("rv-step", s.result, on && "on")} onClick={(e) => (e.stopPropagation(), onPick())} onDoubleClick={(e) => (e.stopPropagation(), onOpen())}>
      <div className="rv-step-m">
        <Pic m={s.outputs[0]} label={`第 ${s.index + 1} 步`} />
        <span className={cx("rv-step-r", s.result)}>{s.result === "downloaded" ? <Icon name="download" size="xs" /> : null}{resultName[s.result]}</span>
      </div>
      <div className="rv-step-b">
        <div className="rv-step-p">{prev && prev.prompt !== s.prompt ? <DiffText from={prev.prompt} to={s.prompt} /> : s.prompt || <span className="faint">没有提示词</span>}</div>
        <div className="rv-step-f">
          {s.pattern !== "none" && s.pattern !== "new" && <span className="rv-pat">{patternName[s.pattern]}</span>}
          {tags.map((t) => (
            <span key={t.id} className={cx("cx-tag", t.tone, rv?.inherited && "inh")}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export const CaseCard = memo(function CaseCard({ r, review, notes, pool, processed, focus, selected, expanded, stepIdx, searching, ver, act }: { r: Row; review: Review | null; notes: number; pool: boolean; processed: Processed; focus: boolean; selected: boolean; expanded: boolean; stepIdx: number | null; searching: boolean; ver: number; act: CardAct }) {
  const sh = useShared()
  const detail = useCaseDetail(r, sh.week, expanded)
  const full = detail.data ?? r
  const steps: Step[] | null = r.unit === "chain" && r.stepCount > 1 ? full.steps ?? null : null
  const key = `${r.unit}:${r.id}`
  useEffect(() => {
    act.register(key, expanded ? steps : null)
  }, [expanded, steps, key])
  useEffect(() => {
    if (focus) {
      warm(r.last.outputs[0])
      r.first.inputs.slice(0, 2).forEach(warm)
    }
  }, [focus])
  void ver
  const step = expanded && steps && stepIdx != null ? steps[stepIdx] ?? null : null
  const rv = step ? act.stepReview(full, step) : review
  const out = r.last.outputs[0] ?? null
  const changed = r.stepCount > 1 && r.last.prompt && r.last.prompt !== r.first.prompt
  const blocks = step ? [blockOf(full, step)] : [blockOf(full, null), ...(full.steps ?? []).map((s) => `record:${s.rowKey}`)]
  const list = notesForBlocks(sh, blocks)
  const ent = r.enterprise
  return (
    <div className={cx("rv-card", r.outcome, focus && "focus", selected && "sel", processed === "done" && "done")} data-key={key} onMouseEnter={() => act.focus(r)} onClick={() => act.focus(r)}>
      <div className="rv-main">
        <div className="rv-rail">
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={selected} onChange={() => act.select(r)} />
          </span>
          {processed === "done" && (
            <Tooltip content="已处理">
              <span className="rv-ok">
                <Icon name="check" size="xs" />
              </span>
            </Tooltip>
          )}
        </div>
        <Inputs ins={r.first.inputs} onOpen={() => act.open(r, null)} />
        <Icon name="arrowRight" size="xs" className="rv-arrow" />
        <div className={cx("rv-res", r.last.result)} onClick={(e) => (e.stopPropagation(), act.open(r, null))}>
          <Peek media={out} label="结果">
            <Pic m={out} peek={false} />
          </Peek>
          {r.stepCount > 1 && <span className="rv-res-n num">{r.stepCount} 步</span>}
          {!out && <span className="rv-res-x">{resultName[r.last.result]}</span>}
          <span className="rv-zoom">
            <Icon name="expand" size="xs" />
          </span>
        </div>
        <div className="rv-body">
          <div className="rv-p">{r.first.prompt || <span className="faint">没有提示词</span>}</div>
          {changed && (
            <div className="rv-p2">
              <span className="k">最后</span>
              {r.last.prompt}
            </div>
          )}
          <div className="rv-meta">
            <button className="rv-ent" onClick={(e) => (e.stopPropagation(), act.ent(r))}>
              {ent.name}
            </button>
            {ent.level && <span className={cx("cx-lv", ent.level)}>{levelName[ent.level]}</span>}
            {ent.movement && ["lost", "drop", "silent", "new", "returned"].includes(ent.movement) && <span className={cx("cx-mv", ent.movement)}>{movementName[ent.movement]}</span>}
          </div>
          <div className="rv-meta">
            {r.intent && <span>{r.intent}</span>}
            <span className={cx("rv-sl", r.outcome)}>{stepsLabel(r)}</span>
            {r.slow && (
              <span className="cx-slow">
                <Icon name="clock" size="xs" />
                {durText(r.durationSeconds)}
              </span>
            )}
            <span className="faint num">{time(r.startedAt)}</span>
          </div>
          {r.unit === "chain" && r.stepCount > 1 && (
            <button className={cx("rv-expand", expanded && "on")} onClick={(e) => (e.stopPropagation(), act.expand(r))}>
              <Icon name={expanded ? "chevUp" : "chevDown"} size="xs" />
              {expanded ? "收起" : `展开 ${r.stepCount} 步`}
              <span className="k">E</span>
            </button>
          )}
        </div>
        <div className="rv-side">
          <div className="rv-target">
            {step ? (
              <>
                <b>第 {step.index + 1} 步</b>
                {rv?.inherited && <span className="faint">沿用整条</span>}
                <span className="spacer" />
                <button className="rv-back" onClick={(e) => (e.stopPropagation(), act.target(r, null))}>
                  回到整条
                </button>
              </>
            ) : (
              <>
                <b>{r.unit === "chain" && r.stepCount > 1 ? "整条" : "这条"}</b>
                {notes > 0 && (
                  <span className="rv-nc num">
                    <Icon name="edit" size="xs" />
                    {notes}
                  </span>
                )}
                <span className="spacer" />
                <button className={cx("rv-pool", pool && "on")} onClick={(e) => (e.stopPropagation(), act.pool(r))}>
                  <Icon name={pool ? "check" : "plus"} size="xs" />
                  可做模板
                  <span className="k">P</span>
                </button>
              </>
            )}
          </div>
          <TagBar review={rv} searching={searching} onSearch={(on) => act.search(on ? r : null)} onToggle={(t) => act.toggleTag(full, step, t)} onCreate={(l) => act.createTag(full, step, l)} />
          <NoteBox onSend={(t) => act.note(full, step, t)} placeholder={step ? `评论第 ${step.index + 1} 步，回车发送` : "写一句评论，回车发送"} />
          <NoteList list={list} fallback={step ? null : r.lastAnnotation} />
        </div>
      </div>
      {expanded && (
        <div className="rv-steps" onClick={(e) => e.stopPropagation()}>
          {steps
            ? steps.map((s, i) => <StepTile key={s.rowKey} s={s} prev={i > 0 ? steps[i - 1] : null} on={stepIdx === i} rv={act.stepReview(full, s)} onPick={() => act.target(r, i)} onOpen={() => act.open(r, i)} />)
            : Array.from({ length: Math.min(r.stepCount, 6) }, (_, i) => <div key={i} className="rv-step sk" />)}
        </div>
      )}
    </div>
  )
})

export const CardSkeleton = () => (
  <div className="rv-card sk">
    <div className="rv-main">
      <div className="rv-rail" />
      <div className="rv-ins n1">
        <span className="rv-in">
          <span className="pic loading" />
        </span>
      </div>
      <span />
      <div className="rv-res">
        <span className="pic loading" />
      </div>
      <div className="rv-body">
        <span className="skel" style={{ height: 14, width: "80%" }} />
        <span className="skel" style={{ height: 12, width: "50%", marginTop: 10 }} />
      </div>
      <div className="rv-side">
        <span className="skel" style={{ height: 80 }} />
      </div>
    </div>
  </div>
)
