import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Mark, TemplateVersion } from "@spec/contract"
import { time } from "../lib/format"
import { sourceName } from "../lib/labels"
import { cx, Kbd } from "./controls"
import { Icon } from "./icons"
import { Menu } from "./overlays"

const TOKEN = /(\{\{[^{}]+\}\}|\[[^[\]]+\])/g

export const PromptEditor = ({ value, onChange, slots, variables, readOnly, minRows = 5, placeholder }: { value: string; onChange?: (v: string) => void; slots?: string[]; variables?: string[]; readOnly?: boolean; minRows?: number; placeholder?: string }) => {
  const ta = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [h, setH] = useState<number | null>(null)
  const kind = (tok: string) => {
    const name = tok.replace(/^\{\{|\}\}$|^\[|\]$/g, "")
    if (slots?.includes(name)) return "slot"
    if (variables?.includes(name)) return "var"
    return tok.startsWith("{{") ? "slot" : "var"
  }
  const parts = useMemo(() => value.split(TOKEN), [value])
  useLayoutEffect(() => {
    if (mirror.current) setH(mirror.current.scrollHeight)
  }, [value])
  const insert = (tok: string) => {
    const el = ta.current
    if (!el || !onChange) return
    const s = el.selectionStart ?? value.length
    const e = el.selectionEnd ?? value.length
    const next = value.slice(0, s) + tok + value.slice(e)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + tok.length, s + tok.length)
    })
  }
  return (
    <div className={cx("pe", readOnly && "ro")}>
      <div className="pe-box" style={{ minHeight: minRows * 24 + 24 }}>
        <div ref={mirror} className="pe-mirror" aria-hidden>
          {parts.map((p, i) => (TOKEN.test(p) ? (TOKEN.lastIndex = 0, <mark key={i} className={cx("pe-tok", kind(p))}>{p}</mark>) : <span key={i}>{p}</span>))}
          {"\u200b"}
        </div>
        <textarea ref={ta} className="pe-ta" value={value} placeholder={placeholder} readOnly={readOnly} spellCheck={false} onChange={(e) => onChange?.(e.target.value)} style={h ? { height: h } : undefined} />
      </div>
      {!readOnly && (slots?.length || variables?.length) ? (
        <div className="pe-ins">
          {slots?.map((s) => (
            <button key={`s${s}`} className="pe-chip slot" onClick={() => insert(`{{${s}}}`)}>
              <Icon name="image" size="xs" />
              {s}
            </button>
          ))}
          {variables?.map((v) => (
            <button key={`v${v}`} className="pe-chip var" onClick={() => insert(`[${v}]`)}>
              <Icon name="sliders" size="xs" />
              {v}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const lcs = (a: string[], b: string[]) => {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: "eq" | "add" | "del"; s: string }[] = []
  let i = 0
  let j = 0
  const push = (t: "eq" | "add" | "del", s: string) => {
    const last = out[out.length - 1]
    if (last && last.t === t) last.s += s
    else out.push({ t, s })
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) (push("eq", a[i]), i++, j++)
    else if (dp[i + 1][j] >= dp[i][j + 1]) (push("del", a[i]), i++)
    else (push("add", b[j]), j++)
  }
  while (i < n) push("del", a[i++])
  while (j < m) push("add", b[j++])
  return out
}

const tokens = (s: string) => s.match(/[a-zA-Z0-9_]+|\{\{[^{}]+\}\}|\s+|./gu) ?? []

export const DiffText = ({ from, to }: { from: string; to: string }) => {
  const parts = useMemo(() => {
    const a = tokens(from)
    const b = tokens(to)
    return a.length * b.length > 4e6 ? [{ t: "del" as const, s: from }, { t: "add" as const, s: to }] : lcs(a, b)
  }, [from, to])
  const added = parts.filter((p) => p.t === "add").reduce((s, p) => s + p.s.length, 0)
  const removed = parts.filter((p) => p.t === "del").reduce((s, p) => s + p.s.length, 0)
  return (
    <div className="diff">
      <div className="diff-sum num">
        <span className="up">+{added}</span>
        <span className="down">−{removed}</span>
        <span className="faint">字</span>
      </div>
      <div className="diff-body">
        {parts.map((p, i) => (p.t === "eq" ? <span key={i}>{p.s}</span> : p.t === "add" ? <ins key={i}>{p.s}</ins> : <del key={i}>{p.s}</del>))}
      </div>
    </div>
  )
}

export const VersionList = ({ versions, current, onRestore, extra }: { versions: TemplateVersion[]; current: number; onRestore?: (v: number) => void; extra?: ReactNode }) => {
  const sorted = useMemo(() => [...versions].sort((a, b) => b.version - a.version), [versions])
  const [pick, setPick] = useState<number[]>(() => sorted.slice(0, 2).map((v) => v.version))
  useEffect(() => setPick(sorted.slice(0, 2).map((v) => v.version)), [versions.length])
  const toggle = (v: number) => setPick((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p.slice(-1), v]))
  const [a, b] = [...pick].sort((x, y) => x - y).map((v) => versions.find((x) => x.version === v)!)
  return (
    <div className="vl">
      <div className="vl-list">
        {sorted.map((v) => (
          <div key={v.version} className={cx("vl-item", pick.includes(v.version) && "on", v.version === current && "cur")} onClick={() => toggle(v.version)}>
            <span className="vl-dot" />
            <div className="vl-b">
              <div className="vl-t">
                <b className="num">v{v.version}</b>
                {v.version === current && <span className="vl-cur">当前</span>}
                <span className="faint">{sourceName[v.source]}</span>
                <span className="spacer" />
                <span className="faint num">{time(v.createdAt)}</span>
              </div>
              {v.note && <div className="vl-note">{v.note}</div>}
            </div>
            {onRestore && v.version !== current && (
              <Menu
                width={160}
                items={[{ key: "r", label: `回退到 v${v.version}`, icon: "refresh", onSelect: () => onRestore(v.version) }]}
                trigger={({ toggle: t, ref }) => (
                  <button ref={ref as never} className="vl-more" onClick={(e) => (e.stopPropagation(), t())} aria-label="更多">
                    <Icon name="more" size="xs" />
                  </button>
                )}
              />
            )}
          </div>
        ))}
      </div>
      {extra}
      {a && b && a !== b ? (
        <div className="vl-diff">
          <div className="vl-dh num">
            v{a.version} → v{b.version}
          </div>
          {a.content.title !== b.content.title && <DiffText from={a.content.title} to={b.content.title} />}
          <DiffText from={a.content.prompt} to={b.content.prompt} />
        </div>
      ) : sorted.length > 1 ? (
        <div className="faint" style={{ fontSize: 13 }}>
          选两个版本查看差异
        </div>
      ) : null}
    </div>
  )
}

export const markName: Record<Mark, string> = { better: "更好", same: "差不多", worse: "更差" }

export const MarkControl = ({ value, usable, onMark, onUsable, keys, size }: { value: Mark | null; usable?: boolean | null; onMark: (m: Mark | null) => void; onUsable?: (v: boolean | null) => void; keys?: boolean; size?: "sm" }) => (
  <div className={cx("mk", size)}>
    {(["better", "same", "worse"] as Mark[]).map((m, i) => (
      <button key={m} className={cx("mk-b", m, value === m && "on")} onClick={(e) => (e.stopPropagation(), onMark(value === m ? null : m))}>
        {markName[m]}
        {keys && <Kbd keys={[String(i + 1)]} />}
      </button>
    ))}
    {onUsable && (
      <button className={cx("mk-b usable", usable && "on")} onClick={(e) => (e.stopPropagation(), onUsable(usable ? null : true))}>
        <Icon name="check" size="xs" />
        可用
        {keys && <Kbd keys={["U"]} />}
      </button>
    )}
  </div>
)
