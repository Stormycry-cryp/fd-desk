import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { Annotation } from "@spec/contract"
import { time } from "../../lib/format"
import { cx } from "../../ui/controls"
import { Icon } from "../../ui/icons"
import type { CaseTag, Review } from "./types"
import { isFalseAlarm } from "./model"

export interface Shared {
  tags: CaseTag[]
  quick: CaseTag[]
  falseAlarm: CaseTag | null
  tagMap: Map<string, CaseTag>
  noteIndex: Map<string, Annotation[]>
  week: string | null
}

export const SharedCtx = createContext<Shared>({ tags: [], quick: [], falseAlarm: null, tagMap: new Map(), noteIndex: new Map(), week: null })
export const useShared = () => useContext(SharedCtx)

export const buildShared = (tags: CaseTag[], anns: Annotation[] | undefined, week: string | null): Shared => {
  const falseAlarm = tags.find(isFalseAlarm) ?? null
  const rest = tags.filter((t) => t !== falseAlarm)
  const noteIndex = new Map<string, Annotation[]>()
  ;(anns ?? []).forEach((a) => {
    const b = a.anchor?.block
    if (!b) return
    noteIndex.set(b, [...(noteIndex.get(b) ?? []), a])
  })
  noteIndex.forEach((xs) => xs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)))
  return { tags, quick: rest.slice(0, 9), falseAlarm, tagMap: new Map(tags.map((t) => [t.id, t])), noteIndex, week }
}

export const keyOfTag = (s: Shared, id: string) => {
  const i = s.quick.findIndex((t) => t.id === id)
  if (i >= 0) return String(i + 1)
  return s.falseAlarm?.id === id ? "0" : null
}

export const TagBar = ({ review, onToggle, onSearch, searching, onCreate, compact }: { review: Review | null; onToggle: (t: CaseTag) => void; onSearch: (on: boolean) => void; searching: boolean; onCreate: (label: string) => void; compact?: boolean }) => {
  const s = useShared()
  const eff = new Set(review?.effectiveTags ?? [])
  const inh = !!review?.inherited
  const extra = [...eff].filter((id) => !s.quick.some((t) => t.id === id) && s.falseAlarm?.id !== id).map((id) => s.tagMap.get(id)).filter((t): t is CaseTag => !!t)
  const chip = (t: CaseTag, k: string | null) => (
    <button key={t.id} type="button" className={cx("rv-chip", t.tone, eff.has(t.id) && "on", eff.has(t.id) && inh && "inh")} onClick={(e) => (e.stopPropagation(), onToggle(t))}>
      {k && <span className="k">{k}</span>}
      {t.label}
    </button>
  )
  return (
    <div className={cx("rv-tags", compact && "compact")} onClick={(e) => e.stopPropagation()}>
      {s.quick.map((t, i) => chip(t, String(i + 1)))}
      {s.falseAlarm && chip(s.falseAlarm, "0")}
      {extra.map((t) => chip(t, null))}
      {searching ? (
        <TagSearch onPick={(t) => (onToggle(t), onSearch(false))} onCreate={(l) => (onCreate(l), onSearch(false))} onClose={() => onSearch(false)} on={eff} />
      ) : (
        <button type="button" className="rv-chip add" onClick={() => onSearch(true)}>
          <Icon name="plus" size="xs" />
          <span className="k">T</span>
        </button>
      )}
    </div>
  )
}

const TagSearch = ({ onPick, onCreate, onClose, on }: { onPick: (t: CaseTag) => void; onCreate: (label: string) => void; onClose: () => void; on: Set<string> }) => {
  const s = useShared()
  const [q, setQ] = useState("")
  const [i, setI] = useState(0)
  const hits = useMemo(() => {
    const v = q.trim()
    return s.tags.filter((t) => !v || t.label.includes(v) || t.group.includes(v)).slice(0, 8)
  }, [q, s.tags])
  useEffect(() => setI(0), [q])
  const exact = hits.some((t) => t.label === q.trim())
  return (
    <div className="rv-search">
      <input
        autoFocus
        value={q}
        placeholder="搜标签或新建"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "ArrowDown") (e.preventDefault(), setI((v) => Math.min(hits.length - (q.trim() && !exact ? 0 : 1), v + 1)))
          else if (e.key === "ArrowUp") (e.preventDefault(), setI((v) => Math.max(0, v - 1)))
          else if (e.key === "Enter") {
            e.preventDefault()
            if (hits[i]) onPick(hits[i])
            else if (q.trim()) onCreate(q.trim())
          } else if (e.key === "Escape") onClose()
        }}
        onBlur={() => setTimeout(onClose, 150)}
      />
      <div className="rv-search-list">
        {hits.map((t, j) => (
          <button key={t.id} type="button" className={cx(j === i && "hl", on.has(t.id) && "on")} onMouseDown={(e) => (e.preventDefault(), onPick(t))} onMouseEnter={() => setI(j)}>
            <span className={cx("dot", t.tone)} />
            <span className="grow">{t.label}</span>
            <span className="g">{t.group}</span>
            {on.has(t.id) && <Icon name="check" size="xs" />}
          </button>
        ))}
        {q.trim() && !exact && (
          <button type="button" className={cx("new", i === hits.length && "hl")} onMouseDown={(e) => (e.preventDefault(), onCreate(q.trim()))}>
            <Icon name="plus" size="xs" />
            新建「{q.trim()}」
          </button>
        )}
      </div>
    </div>
  )
}

export const NoteBox = ({ onSend, placeholder = "写一句评论，回车发送" }: { onSend: (text: string) => void; placeholder?: string }) => {
  const [v, setV] = useState("")
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="rv-note" onClick={(e) => e.stopPropagation()}>
      <Icon name="edit" size="xs" />
      <input
        ref={ref}
        className="rv-note-in"
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter" && !e.nativeEvent.isComposing && v.trim()) {
            e.preventDefault()
            onSend(v)
            setV("")
          } else if (e.key === "Escape") ref.current?.blur()
        }}
      />
      {v.trim() && <span className="rv-note-k">↵</span>}
    </div>
  )
}

export const NoteList = ({ list, max = 2, fallback }: { list: Annotation[]; max?: number; fallback?: { text: string; at: string } | null }) => {
  if (!list.length && !fallback) return null
  const items = list.length ? list.slice(0, max).map((a) => ({ id: a.id, text: a.entries.map((e) => e.text).join(" / "), at: a.updatedAt })) : [{ id: "f", text: fallback!.text, at: fallback!.at }]
  return (
    <div className="rv-notes">
      {items.map((x) => (
        <div key={x.id} className="rv-n">
          <span className="t">{x.text}</span>
          <span className="d num">{time(x.at)}</span>
        </div>
      ))}
      {list.length > max && <span className="rv-n-more num">还有 {list.length - max} 条</span>}
    </div>
  )
}

export const notesForBlocks = (s: Shared, blocks: string[]) => {
  const out: Annotation[] = []
  blocks.forEach((b) => out.push(...(s.noteIndex.get(b) ?? [])))
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}
