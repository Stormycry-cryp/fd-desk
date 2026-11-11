import { useEffect, useMemo, useRef, useState } from "react"
import type { Annotation, Media } from "@spec/contract"
import { failureName, levelName, movementName, patternName } from "../../lib/labels"
import { time } from "../../lib/format"
import { fdUrl } from "../../lib/fd"
import { navigate } from "../../lib/route"
import { Button, IconButton, Kbd, Segmented, cx } from "../../ui/controls"
import { Badge, copyText } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { Menu, Portal, Tooltip } from "../../ui/overlays"
import { CompareStage, compareModeName, type CompareMode } from "../../ui/compare"
import { DiffText } from "../../ui/prompt"
import { AnnotationScope, Composer, Thread } from "../../ui/annotate"
import type { CaseAnalysis, CaseCollection, CaseRating, CaseReview, CaseStatus, CaseTag, Row, Step } from "./types"
import { caseKey } from "./types"
import { outcomeLong, ratingName, resultName, statusName } from "./model"
import { OutcomePill, RatingPills } from "./CaseRow"
import type { ReviewPatch } from "./store"

export interface ViewerCtx {
  review: (r: Row) => CaseReview | null
  stepReview: (r: Row, rowKey: string) => CaseReview | null
  rate: (r: Row, p: ReviewPatch) => void
  rateStep: (r: Row, rowKey: string, p: ReviewPatch) => void
  tags: CaseTag[]
  addTag: (label: string) => Promise<CaseTag | null>
  anns: Annotation[]
  collections: CaseCollection[]
  inCollection: (r: Row) => string[]
  toggleCollection: (r: Row, id: string, on: boolean) => void
  newCollection: (r: Row) => void
  selected: Set<string>
  toggleSelect: (r: Row) => void
  ai: Map<string, CaseAnalysis["perCase"][number]>
  detail: (r: Row) => Row | null
}

type Ref = { kind: "input"; i: number } | { kind: "prev" }

const durText = (s: number | null | undefined) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${Math.round(s)} 秒`)

export const CaseViewer = ({ rows, index, setIndex, onClose, ctx, title }: { rows: Row[]; index: number; setIndex: (i: number) => void; onClose: () => void; ctx: ViewerCtx; title?: string }) => {
  const base = rows[index]
  const row = (base && ctx.detail(base)) ?? base
  const steps: Step[] = row ? row.steps ?? (row.stepCount > 1 ? [row.first, row.last] : [row.last]) : []
  const [si, setSi] = useState(steps.length - 1)
  const [mode, setMode] = useState<CompareMode>("side")
  const [flip, setFlip] = useState(false)
  const [ref, setRef] = useState<Ref | null>(null)
  const [perStep, setPerStep] = useState(false)
  const [tagQ, setTagQ] = useState<string | null>(null)
  const side = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    setSi(Math.max(0, steps.length - 1))
    setRef(null)
    setPerStep(false)
    setTagQ(null)
  }, [base?.id, base?.unit, steps.length])
  useEffect(() => setRef(null), [si])
  const step = steps[Math.min(si, steps.length - 1)]
  const prev = si > 0 ? steps[si - 1] : null
  const cur: Ref = ref ?? (prev && prev.outputs[0] ? { kind: "prev" } : { kind: "input", i: 0 })
  const left: Media | null = cur.kind === "prev" ? prev?.outputs[0] ?? null : (step?.inputs ?? row?.first.inputs ?? [])[cur.i] ?? null
  const leftLabel = cur.kind === "prev" ? `第 ${si} 步` : `输入 ${cur.i + 1}`
  const rightLabel = steps.length > 1 ? `第 ${si + 1} 步` : "结果"
  const scope = perStep && row?.unit === "chain" && step
  const rv = row ? (scope ? ctx.stepReview(row, step.rowKey) : ctx.review(row)) : null
  const patch = (p: ReviewPatch) => {
    if (!row) return
    if (scope) ctx.rateStep(row, step.rowKey, p)
    else ctx.rate(row, p)
  }
  useEffect(() => {
    if (!row) return
    const k = caseKey(row)
    if (seen.current.has(k)) return
    seen.current.add(k)
    const r = ctx.review(row)
    if (!r || (r.status === "todo" && !r.inherited)) ctx.rate(row, { status: "seen" })
  }, [row?.id, row?.unit])
  const tagsOn = new Set(rv?.tags ?? [])
  const toggleTag = (id: string) => patch(tagsOn.has(id) ? { removeTags: [id] } : { addTags: [id] })
  const rate = (r: CaseRating | null) => patch({ rating: r })
  const groups = useMemo(() => {
    const m = new Map<string, CaseTag[]>()
    ctx.tags.forEach((t) => m.set(t.group, [...(m.get(t.group) ?? []), t]))
    return [...m]
  }, [ctx.tags])
  const tagHits = tagQ == null ? [] : ctx.tags.filter((t) => !tagQ || t.label.includes(tagQ) || t.group.includes(tagQ))
  const go = (d: number) => setIndex(Math.max(0, Math.min(rows.length - 1, index + d)))
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest("input, textarea, [contenteditable]")) {
        if (e.key === "Escape") (el as HTMLElement).blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      if (k === "Escape") return onClose()
      if (k === "ArrowRight" || k === "Enter") (e.preventDefault(), go(1))
      else if (k === "ArrowLeft") (e.preventDefault(), go(-1))
      else if (k === "ArrowDown") (e.preventDefault(), setSi((v) => Math.min(steps.length - 1, v + 1)))
      else if (k === "ArrowUp") (e.preventDefault(), setSi((v) => Math.max(0, v - 1)))
      else if (k === " ") (e.preventDefault(), mode === "flip" ? setFlip((v) => !v) : go(1))
      else if (k === "1" || k === "2" || k === "3") {
        const r: CaseRating = k === "1" ? "good" : k === "2" ? "ok" : "bad"
        rate(rv?.rating === r ? null : r)
      } else if (k === "t" || k === "T") (e.preventDefault(), setTagQ(""))
      else if (k === "n" || k === "N") {
        e.preventDefault()
        side.current?.querySelector<HTMLTextAreaElement>(".cxv-notes textarea")?.focus()
      } else if (k === "d" || k === "D") patch({ status: rv?.status === "done" ? "seen" : "done" })
      else if (k === "x" || k === "X") row && ctx.toggleSelect(row)
      else if (k === "s" || k === "S") row?.unit === "chain" && setPerStep((v) => !v)
      else if (k === "o" || k === "O") {
        const u = step?.task ? fdUrl(step.task) : row?.fdUrl
        if (u) window.open(u, "_blank", "noopener")
      } else if (k === "m" || k === "M") setMode((m) => (m === "side" ? "slide" : m === "slide" ? "flip" : "side"))
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
  if (!row || !step) return null
  const t = step.task
  const link = t ? fdUrl(t) : row.fdUrl
  const ai = ctx.ai.get(row.id)
  const blocks = new Set([row.unit === "chain" ? `case:${row.id}` : `record:${row.id}`, ...steps.map((s) => `record:${s.rowKey}`)])
  const notes = ctx.anns.filter((a) => blocks.has(a.anchor?.block ?? "")).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  const inCols = new Set(ctx.inCollection(row))
  const sel = ctx.selected.has(caseKey(row))
  const failure = t?.failure ?? (si === steps.length - 1 ? row.failure : null)
  const emptyRight = step.result === "failed" ? `失败${failure ? ` · ${failureName[failure.category]}` : ""}` : step.result === "deleted" ? "客户已删除" : "没有结果"
  return (
    <Portal>
      <div className="cxv">
        <div className="cxv-stage">
          <div className="cv-top">
            <OutcomePill o={row.outcome} />
            <span className="cxv-title ellipsis">{row.enterprise.name}</span>
            <span className="faint num">
              {title ? `${title} · ` : ""}
              {index + 1}/{rows.length}
            </span>
            <span className="spacer" />
            <div className="cv-modes">
              {(["side", "slide", "flip"] as CompareMode[]).map((m) => (
                <button key={m} className={cx(mode === m && "on")} onClick={() => setMode(m)}>
                  {compareModeName[m]}
                </button>
              ))}
            </div>
          </div>
          <div className="cv-stage">
            <CompareStage a={left} b={step.outputs[0] ?? null} la={leftLabel} lb={rightLabel} mode={mode} flip={flip} setFlip={setFlip} emptyB={emptyRight} />
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
          <div className="cxv-bot">
            <div className="cxv-refs">
              <span className="k">对比</span>
              {(step.inputs.length ? step.inputs : row.first.inputs).slice(0, 6).map((m, i) => (
                <button key={i} className={cx(cur.kind === "input" && cur.i === i && "on")} onClick={() => setRef({ kind: "input", i })}>
                  <img src={m.kind === "video" ? m.poster ?? m.thumb : m.thumb} alt="" />
                  <span>输入 {i + 1}</span>
                </button>
              ))}
              {prev && (
                <button className={cx("txt", cur.kind === "prev" && "on")} onClick={() => setRef({ kind: "prev" })}>
                  上一步
                </button>
              )}
            </div>
            {steps.length > 1 && (
              <div className="cxv-steps">
                {steps.map((s, i) => (
                  <button key={s.rowKey} className={cx(i === si && "on", s.result)} onClick={() => setSi(i)}>
                    {s.outputs[0] ? <img src={s.outputs[0].kind === "video" ? s.outputs[0].poster ?? s.outputs[0].thumb : s.outputs[0].thumb} alt="" /> : <span className="none">{resultName[s.result]}</span>}
                    <span className="n num">{i + 1}</span>
                    {s.result === "downloaded" && (
                      <span className="dl">
                        <Icon name="download" size="xs" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="cv-keys">
            <span><Kbd keys={["←", "→"]} />换一个</span>
            {steps.length > 1 && <span><Kbd keys={["↑", "↓"]} />换一步</span>}
            <span><Kbd keys={["1", "2", "3"]} />评价</span>
            <span><Kbd keys={["T"]} />标签</span>
            <span><Kbd keys={["N"]} />批注</span>
            <span><Kbd keys={["D"]} />处理完</span>
            <span><Kbd keys={["M"]} />对比方式</span>
            <span><Kbd keys={["Esc"]} />返回</span>
          </div>
        </div>
        <div className="cxv-side" ref={side}>
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
              <span>评价</span>
              {row.unit === "chain" && row.stepCount > 1 && (
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
            </div>
            <RatingPills value={rv?.rating} onPick={rate} size="lg" />
            {ai && (
              <div className="cxv-ai">
                <Icon name="wand" size="xs" />
                <span className="grow">
                  <b>AI 初判 · {ratingName[ai.rating]}</b>
                  {ai.note && <span>{ai.note}</span>}
                </span>
                {rv?.rating !== ai.rating && (
                  <Button size="xs" variant="soft" onClick={() => patch({ rating: ai.rating, addTags: ai.tags })}>
                    采纳
                  </Button>
                )}
              </div>
            )}
            <div className="cxv-tags">
              {tagQ != null && (
                <div className="cxv-tq">
                  <input
                    autoFocus
                    value={tagQ}
                    placeholder="搜标签，回车选第一个"
                    onChange={(e) => setTagQ(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        const v = e.currentTarget.value.trim()
                        const hit = ctx.tags.find((t) => t.label.includes(v) || t.group.includes(v))
                        if (hit) toggleTag(hit.id)
                        else if (v) {
                          const t = await ctx.addTag(v)
                          if (t) toggleTag(t.id)
                        }
                        setTagQ(null)
                      }
                      if (e.key === "Escape") (e.stopPropagation(), setTagQ(null))
                    }}
                    onBlur={() => setTimeout(() => setTagQ(null), 120)}
                  />
                  {tagQ && !tagHits.length && <span className="faint">回车新建「{tagQ}」</span>}
                </div>
              )}
              {groups.map(([g, ts]) => (
                <div key={g} className="cxv-tg">
                  <span className="g">{g}</span>
                  <div className="xs">
                    {ts.map((t) => (
                      <button key={t.id} className={cx("cxv-t", t.tone, tagsOn.has(t.id) && "on", tagQ && tagHits[0]?.id === t.id && "hit")} onClick={() => toggleTag(t.id)}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="cxv-status">
              {(["todo", "seen", "done"] as CaseStatus[]).map((s) => (
                <button key={s} className={cx((rv?.status ?? "todo") === s && "on", s)} onClick={() => patch({ status: s })}>
                  {s === "done" && <Icon name="check" size="xs" />}
                  {statusName[s]}
                </button>
              ))}
              <span className="spacer" />
              <Tooltip content="选中后可以在列表里批量操作">
                <button className={cx("cxv-sel", sel && "on")} onClick={() => ctx.toggleSelect(row)}>
                  <Icon name={sel ? "check" : "plus"} size="xs" />
                  {sel ? "已选" : "选中"}
                  <Kbd keys={["X"]} />
                </button>
              </Tooltip>
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
            <div className="cxv-prompt">{prev && prev.prompt !== step.prompt ? <DiffText from={prev.prompt} to={step.prompt} /> : step.prompt || <span className="faint">没有提示词</span>}</div>
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
              <span className="spacer" />
              <Menu
                width={220}
                trigger={({ toggle, ref }) => (
              <Button ref={ref as never} size="sm" variant="ghost" icon="book" onClick={toggle}>
                    {inCols.size ? `收藏 ${inCols.size}` : "收藏"}
                  </Button>
                )}
                items={[
                  ...ctx.collections.map((c) => ({ key: c.id, label: c.name, icon: inCols.has(c.id) ? ("check" as const) : undefined, onSelect: () => ctx.toggleCollection(row, c.id, !inCols.has(c.id)) })),
                  { key: "new", label: "新建收藏夹", icon: "plus" as const, sep: ctx.collections.length > 0, onSelect: () => ctx.newCollection(row) },
                ]}
              />
            </div>
          </div>
          <div className="cxv-sec cxv-notes">
            <div className="cxv-lab">
              <span>批注{notes.length ? ` · ${notes.length}` : ""}</span>
            </div>
            <AnnotationScope enterprise={row.enterprise.id} list={notes} mode="inline">
              <div className="stack" style={{ gap: 10 }}>
                {notes.map((a) => (
                  <Thread key={a.id} a={a} />
                ))}
                <Composer key={`${row.id}:${perStep ? step.rowKey : ""}`} anchor={{ block: perStep || row.unit === "task" ? `record:${step.rowKey}` : `case:${row.id}`, quote: (step.prompt || row.enterprise.name).slice(0, 60) }} placeholder="写批注，⌘↵ 保存" />
              </div>
            </AnnotationScope>
          </div>
        </div>
      </div>
    </Portal>
  )
}
