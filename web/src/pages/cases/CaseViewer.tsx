import { useEffect, useMemo, useRef, useState } from "react"
import type { Media } from "@spec/contract"
import { failureName, levelName, movementName, patternName } from "../../lib/labels"
import { time } from "../../lib/format"
import { fdUrl } from "../../lib/fd"
import { navigate } from "../../lib/route"
import { Button, IconButton, Kbd, Segmented, cx } from "../../ui/controls"
import { Badge, copyText } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { Portal } from "../../ui/overlays"
import { CompareStage, MediaView, compareModeName, type CompareMode } from "../../ui/compare"
import { DiffText } from "../../ui/prompt"
import { AnnotationScope, Thread } from "../../ui/annotate"
import type { CaseTag, Review, Row, Step } from "./types"
import { caseKey } from "./types"
import { blockOf, blocksOf, durText, outcomeLong, resultName } from "./model"
import { OutcomePill } from "./CaseRow"
import { NoteBox, TagBar, notesForBlocks, useShared } from "./Review"
import { useCaseDetail } from "./data"

export interface ViewerCtx {
  review: (r: Row) => Review | null
  stepReview: (r: Row, s: Step) => Review | null
  toggleTag: (r: Row, s: Step | null, t: CaseTag) => void
  createTag: (r: Row, s: Step | null, label: string) => void
  note: (r: Row, s: Step | null, text: string) => void
  inPool: (r: Row) => boolean
  pool: (r: Row) => void
  selected: Set<string>
  select: (r: Row) => void
  ai: Map<string, { tags: string[]; note: string }>
}

type Mode = CompareMode | "tile"
const modeName: Record<Mode, string> = { tile: "平铺", ...compareModeName }
const modes: Mode[] = ["tile", "side", "slide", "flip"]

type Ref = { kind: "input"; i: number } | { kind: "step"; i: number }

const thumb = (m: Media) => (m.kind === "video" ? m.poster ?? m.thumb : m.thumb)

let lastMode: Mode | null = null

export const CaseViewer = ({ rows, index, step: initStep, setIndex, onClose, ctx, title }: { rows: Row[]; index: number; step: number | null; setIndex: (i: number) => void; onClose: () => void; ctx: ViewerCtx; title?: string }) => {
  const sh = useShared()
  const base = rows[index]
  const detail = useCaseDetail(base ?? null, sh.week)
  const row = detail.data && base && detail.data.id === base.id ? detail.data : base
  const steps: Step[] = row ? row.steps ?? (row.stepCount > 1 ? [row.first, row.last] : [row.last]) : []
  const [si, setSi] = useState(initStep ?? steps.length - 1)
  const [mode, setMode] = useState<Mode>(lastMode ?? ((row?.first.inputs.length ?? 0) > 1 ? "tile" : "side"))
  const [flip, setFlip] = useState(false)
  const [ref, setRef] = useState<Ref | null>(null)
  const [perStep, setPerStep] = useState(initStep != null)
  const [searching, setSearching] = useState(false)
  const side = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setSi(Math.max(0, steps.length - 1))
    setRef(null)
    setPerStep(false)
    setSearching(false)
  }, [base?.id, base?.unit])
  useEffect(() => {
    if (initStep != null && steps.length > initStep) setSi(initStep)
  }, [steps.length])
  useEffect(() => setRef(null), [si])
  const pickMode = (m: Mode) => {
    lastMode = m
    setMode(m)
  }
  const step = steps[Math.min(si, steps.length - 1)]
  const ins = step?.inputs.length ? step.inputs : row?.first.inputs ?? []
  const prevOut = si > 0 ? steps[si - 1]?.outputs[0] ?? null : null
  const cur: Ref = ref ?? (prevOut ? { kind: "step", i: si - 1 } : { kind: "input", i: 0 })
  const left: Media | null = cur.kind === "step" ? steps[cur.i]?.outputs[0] ?? null : ins[cur.i] ?? null
  const leftLabel = cur.kind === "step" ? `第 ${cur.i + 1} 步` : `输入 ${cur.i + 1}`
  const rightLabel = steps.length > 1 ? `第 ${si + 1} 步` : "结果"
  const chain = row?.unit === "chain" && steps.length > 1
  const target: Step | null = chain && perStep && step ? step : null
  const rv = row ? (target ? ctx.stepReview(row, target) : ctx.review(row)) : null
  const go = (d: number) => setIndex(Math.max(0, Math.min(rows.length - 1, index + d)))
  const toggle = (t: CaseTag) => row && ctx.toggleTag(row, target, t)
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest("input, textarea, [contenteditable]")) {
        if (e.key === "Escape") el.blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || !row) return
      const k = e.key
      if (k === "Escape") return onClose()
      if (k === "ArrowRight" || k === "Enter") (e.preventDefault(), go(1))
      else if (k === "ArrowLeft") (e.preventDefault(), go(-1))
      else if (k === "ArrowDown") (e.preventDefault(), setSi((v) => Math.min(steps.length - 1, v + 1)))
      else if (k === "ArrowUp") (e.preventDefault(), setSi((v) => Math.max(0, v - 1)))
      else if (k === " ") (e.preventDefault(), mode === "flip" ? setFlip((v) => !v) : go(1))
      else if (/^[0-9]$/.test(k)) {
        const t = k === "0" ? sh.falseAlarm : sh.quick[Number(k) - 1]
        if (t) toggle(t)
      } else if (k === "t" || k === "T") (e.preventDefault(), setSearching(true))
      else if (k === "c" || k === "C" || k === "n" || k === "N") (e.preventDefault(), side.current?.querySelector<HTMLInputElement>(".rv-note-in")?.focus())
      else if (k === "p" || k === "P") ctx.pool(row)
      else if (k === "x" || k === "X") ctx.select(row)
      else if (k === "s" || k === "S") chain && setPerStep((v) => !v)
      else if (k === "o" || k === "O") {
        const u = step?.task ? fdUrl(step.task) : row.fdUrl
        if (u) window.open(u, "_blank", "noopener")
      } else if (k === "m" || k === "M") pickMode(modes[(modes.indexOf(mode) + 1) % modes.length])
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  })
  useEffect(() => {
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
    }
  }, [])
  const notes = useMemo(() => (row ? notesForBlocks(sh, [...blocksOf(row)]) : []), [row, sh])
  if (!row || !step) return null
  const t = step.task
  const link = t ? fdUrl(t) : row.fdUrl
  const ai = ctx.ai.get(row.id)
  const sel = ctx.selected.has(caseKey(row))
  const failure = si === steps.length - 1 ? row.failure : null
  const emptyRight = step.result === "failed" ? `失败${failure ? ` · ${failureName[failure.category]}` : ""}` : step.result === "deleted" ? "客户已删除" : "没有结果"
  const pool = ctx.inPool(row)
  const aiNew = ai ? ai.tags.filter((id) => !(rv?.effectiveTags ?? []).includes(id)) : []
  return (
    <Portal>
      <div className="cxv rvv">
        <div className="rvv-rail">
          <div className="rvv-rail-h">输入</div>
          {ins.map((m, i) => (
            <button key={i} className={cx("rvv-ref", cur.kind === "input" && cur.i === i && mode !== "tile" && "on")} onClick={() => (setRef({ kind: "input", i }), mode === "tile" && pickMode("side"))}>
              <img src={thumb(m)} alt="" />
              <span className="num">{i + 1}</span>
            </button>
          ))}
          {!ins.length && <span className="rvv-none">无</span>}
          {steps.length > 1 && (
            <>
              <div className="rvv-rail-h">步骤</div>
              {steps.map((s, i) => (
                <button key={s.rowKey} className={cx("rvv-ref step", s.result, i === si && "cur", cur.kind === "step" && cur.i === i && i !== si && mode !== "tile" && "on")} onClick={() => setSi(i)}>
                  {s.outputs[0] ? <img src={thumb(s.outputs[0])} alt="" /> : <span className="x">{resultName[s.result]}</span>}
                  <span className="num">{i + 1}</span>
                  {s.result === "downloaded" && (
                    <span className="dl">
                      <Icon name="download" size="xs" />
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
        <div className="rvv-stage">
          <div className="cv-top">
            <OutcomePill o={row.outcome} />
            <span className="cxv-title ellipsis">{row.enterprise.name}</span>
            <span className="faint num">
              {title ? `${title} · ` : ""}
              {index + 1}/{rows.length}
            </span>
            {steps.length > 1 && <span className="rvv-stepn num">第 {si + 1}/{steps.length} 步 · {resultName[step.result]}</span>}
            <span className="spacer" />
            <div className="cv-modes">
              {modes.map((m) => (
                <button key={m} className={cx(mode === m && "on")} onClick={() => pickMode(m)}>
                  {modeName[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="rvv-view">
            {mode === "tile" ? (
              <div className={cx("rvv-tile", `n${Math.min(ins.length + (prevOut ? 1 : 0), 6)}`)}>
                <div className="rvv-tile-ins">
                  {ins.map((m, i) => (
                    <figure key={i}>
                      <MediaView m={m} label={`输入 ${i + 1}`} />
                      <figcaption>输入 {i + 1}</figcaption>
                    </figure>
                  ))}
                  {prevOut && (
                    <figure className="prev">
                      <MediaView m={prevOut} label={`第 ${si} 步`} />
                      <figcaption>第 {si} 步</figcaption>
                    </figure>
                  )}
                </div>
                <figure className="rvv-tile-out">
                  <MediaView m={step.outputs[0]} label={rightLabel} empty={emptyRight} />
                  <figcaption>{rightLabel}</figcaption>
                </figure>
              </div>
            ) : (
              <div className="cv-stage">
                <CompareStage a={left} b={step.outputs[0] ?? null} la={leftLabel} lb={rightLabel} mode={mode} flip={flip} setFlip={setFlip} emptyB={emptyRight} />
              </div>
            )}
            {index > 0 && (
              <button className="nav-btn l" onClick={() => go(-1)} aria-label="上一个">
                <Icon name="chevLeft" />
              </button>
            )}
            {index < rows.length - 1 && (
              <button className="nav-btn r" onClick={() => go(1)} aria-label="下一个">
                <Icon name="chevRight" />
              </button>
            )}
          </div>
          <div className="cv-keys">
            <span><Kbd keys={["←", "→"]} />换一个</span>
            {steps.length > 1 && <span><Kbd keys={["↑", "↓"]} />换一步</span>}
            <span><Kbd keys={["1-9"]} />打标签</span>
            <span><Kbd keys={["T"]} />搜标签</span>
            <span><Kbd keys={["C"]} />评论</span>
            <span><Kbd keys={["P"]} />可做模板</span>
            <span><Kbd keys={["M"]} />对比方式</span>
            <span><Kbd keys={["Esc"]} />返回</span>
          </div>
        </div>
        <div className="cxv-side rvv-side" ref={side}>
          <div className="cxv-h">
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <button className="cxv-ent" onClick={() => (onClose(), navigate({ ent: row.enterprise.id, tab: "profile" }))}>
                {row.enterprise.name}
                <Icon name="arrowUpRight" size="xs" />
              </button>
              <div className="cxv-sub">
                {row.enterprise.level && <span className={cx("cx-lv", row.enterprise.level)}>{levelName[row.enterprise.level]}</span>}
                {row.enterprise.movement && row.enterprise.movement !== "steady" && <span className={cx("cx-mv", row.enterprise.movement)}>{movementName[row.enterprise.movement]}</span>}
                <span>{row.user?.name ?? "未知成员"}</span>
                <span className="num">{time(row.startedAt)}</span>
              </div>
            </div>
            <IconButton icon="x" label="关闭" onClick={onClose} />
          </div>
          <div className="cxv-sum">
            <span className={cx("cxv-o", row.outcome)}>{outcomeLong[row.outcome]}</span>
            <span className="num">{row.stepCount > 1 ? `${row.stepCount} 步${row.downloadedAt != null ? ` · 第 ${row.downloadedAt + 1} 步下载` : ""}` : resultName[row.last.result]}</span>
            <span className="num">{row.points} 点</span>
            <span className={cx("num", row.slow && "down")}>{durText(row.durationSeconds)}</span>
          </div>
          <div className="cxv-sec">
            <div className="cxv-lab">
              <span>标签</span>
              {chain && (
                <Segmented
                  size="sm"
                  value={perStep ? "step" : "case"}
                  onChange={(v) => setPerStep(v === "step")}
                  options={[
                    { value: "case", label: "整条" },
                    { value: "step", label: `第 ${si + 1} 步` },
                  ]}
                />
              )}
              <span className="spacer" />
              {rv?.inherited && <span className="faint">沿用整条</span>}
              <button className={cx("rv-pool", pool && "on")} onClick={() => ctx.pool(row)}>
                <Icon name={pool ? "check" : "plus"} size="xs" />
                可做模板
                <span className="k">P</span>
              </button>
            </div>
            <TagBar review={rv} searching={searching} onSearch={setSearching} onToggle={toggle} onCreate={(l) => ctx.createTag(row, target, l)} />
            {ai && (
              <div className="cxv-ai">
                <Icon name="wand" size="xs" />
                <span className="grow">
                  <b>AI 判断</b>
                  <span>
                    {ai.tags.map((id) => sh.tagMap.get(id)?.label).filter(Boolean).join("、") || "没有问题"}
                    {ai.note ? ` · ${ai.note}` : ""}
                  </span>
                </span>
                {aiNew.length > 0 && (
                  <Button size="xs" variant="soft" onClick={() => aiNew.forEach((id) => sh.tagMap.get(id) && toggle(sh.tagMap.get(id)!))}>
                    采纳
                  </Button>
                )}
              </div>
            )}
            <NoteBox onSend={(text) => ctx.note(row, target, text)} placeholder={target ? `评论第 ${si + 1} 步，回车发送` : "写一句评论，回车发送"} />
            {notes.length > 0 && (
              <AnnotationScope enterprise={row.enterprise.id} list={notes} mode="inline">
                <div className="rvv-thread">
                  {notes.map((a) => (
                    <Thread key={a.id} a={a} />
                  ))}
                </div>
              </AnnotationScope>
            )}
            <div className="rvv-tools">
              <button className={cx("cxv-sel", sel && "on")} onClick={() => ctx.select(row)}>
                <Icon name={sel ? "check" : "plus"} size="xs" />
                {sel ? "已选" : "选中"}
                <Kbd keys={["X"]} />
              </button>
              <span className="spacer" />
              {sh.falseAlarm && <span className="faint">0 = {sh.falseAlarm.label}</span>}
            </div>
          </div>
          <div className="cxv-sec">
            <div className="cxv-lab">
              <span>{steps.length > 1 ? `第 ${si + 1} 步` : "提示词"}</span>
              <span className={cx("cx-dot", step.result)} />
              <span className="faint">{resultName[step.result]}</span>
              {step.pattern !== "none" && step.pattern !== "new" && <Badge>{patternName[step.pattern]}</Badge>}
              <span className="spacer" />
              <IconButton size="xs" icon="copy" label="复制提示词" onClick={() => copyText(step.prompt, "提示词已复制")} />
            </div>
            <div className="cxv-prompt">{si > 0 && steps[si - 1].prompt !== step.prompt ? <DiffText from={steps[si - 1].prompt} to={step.prompt} /> : step.prompt || <span className="faint">没有提示词</span>}</div>
            <dl className="kv cxv-kv">
              <dt>模型</dt>
              <dd>{t?.model ?? row.model ?? "—"}</dd>
              <dt>规格</dt>
              <dd>{[(t?.config ?? row.config).resolution, (t?.config ?? row.config).ratio, (t?.config ?? row.config).videoDuration ? `${(t?.config ?? row.config).videoDuration}s` : null].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>用时</dt>
              <dd className="num">{durText(step.durationSeconds)}</dd>
              <dt>耗点</dt>
              <dd className="num">{step.points}</dd>
              <dt>时间</dt>
              <dd className="num">{time(step.createdAt)}</dd>
            </dl>
            {failure && (
              <div className="cxv-fail">
                <b>{failureName[failure.category]}</b>
                <span>{failure.userMessage ?? "—"}</span>
                {failure.providerMessage && <code>{failure.providerMessage}</code>}
              </div>
            )}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              {link && (
                <Button size="sm" icon="external" onClick={() => window.open(link, "_blank", "noopener")}>
                  FD
                </Button>
              )}
              {row.line === "inspiration" && step.inputs.length > 0 && (
                <Button size="sm" icon="image" onClick={() => (onClose(), navigate({ page: "playground", tpl: null, run: null, q: `${row.enterprise.id}:${step.rowKey}` }))}>
                  去试验台
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}

export const viewerBlock = blockOf
