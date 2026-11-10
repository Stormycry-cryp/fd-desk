import { useEffect, useMemo, useRef, useState } from "react"
import { useRoster } from "../api/hooks"
import { useCtx } from "../lib/ctx"
import { levelName, lineName } from "../lib/labels"
import { navigate, type PageKey } from "../lib/route"
import { num } from "../lib/format"
import { Icon, type IconName } from "../ui/icons"
import { Portal, usePresence } from "../ui/overlays"
import { Avatar } from "../ui/display"
import { Kbd, cx } from "../ui/controls"

type Item = { id: string; group: string; label: React.ReactNode; text: string; hint?: React.ReactNode; icon?: IconName; lead?: React.ReactNode; run: () => void }

const pages: { key: PageKey; label: string; icon: IconName }[] = [
  { key: "week", label: "本周", icon: "home" },
  { key: "customers", label: "客户", icon: "users" },
  { key: "touches", label: "触达", icon: "send" },
  { key: "templates", label: "模板", icon: "template" },
  { key: "analysis", label: "分析", icon: "chart" },
  { key: "data", label: "数据", icon: "database" },
  { key: "report", label: "周报", icon: "report" },
]

export const Palette = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { line, week } = useCtx()
  const a = useRoster("inspiration", week)
  const b = useRoster("video", week)
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const { mounted, closing } = usePresence(open, 140)
  useEffect(() => {
    if (open) {
      setQ("")
      setActive(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [open])
  const items = useMemo<Item[]>(() => {
    const ents = new Map<string, { name: string; lines: string[]; tasks: number; level: string | null }>()
    for (const [l, r] of [["inspiration", a.data], ["video", b.data]] as const)
      r?.rows.forEach((row) => {
        const e = ents.get(row.enterprise.id) ?? { name: row.enterprise.name, lines: [], tasks: 0, level: null }
        if (row.tasks || row.pool) e.lines.push(lineName[l])
        e.tasks += row.tasks
        if (l === line && row.level) e.level = levelName[row.level]
        ents.set(row.enterprise.id, e)
      })
    const s = q.trim().toLowerCase()
    const entItems: Item[] = [...ents]
      .filter(([, e]) => !s || e.name.toLowerCase().includes(s))
      .sort((x, y) => y[1].tasks - x[1].tasks)
      .slice(0, s ? 30 : 6)
      .map(([id, e]) => ({
        id,
        group: "企业",
        text: e.name,
        label: highlight(e.name, s),
        hint: [e.level, e.lines.join("、"), e.tasks ? `${num(e.tasks)} 个任务` : null].filter(Boolean).join(" · "),
        lead: <Avatar name={e.name} size={22} square />,
        run: () => navigate({ ent: id }),
      }))
    const pageItems: Item[] = pages
      .filter((p) => !s || p.label.includes(s))
      .map((p) => ({ id: `p-${p.key}`, group: "页面", text: p.label, label: p.label, icon: p.icon, run: () => navigate({ page: p.key }) }))
    const lineItems: Item[] = (["inspiration", "video"] as const)
      .filter((l) => l !== line && (!s || lineName[l].toLowerCase().includes(s)))
      .map((l) => ({ id: `l-${l}`, group: "切换", text: lineName[l], label: `切换到 ${lineName[l]}`, icon: "refresh", run: () => navigate({ line: l }, { replace: true }) }))
    return [...entItems, ...pageItems, ...lineItems]
  }, [a.data, b.data, q, line])
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    box.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  if (!mounted) return null
  const run = (i: Item) => {
    onClose()
    i.run()
  }
  let last = ""
  return (
    <Portal>
      <div className={cx("scrim", closing && "closing")} style={{ zIndex: 69 }} onClick={onClose} />
      <div className="palette" style={closing ? { opacity: 0, transition: "opacity 140ms" } : undefined} role="dialog">
        <div className="input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="搜索企业或页面"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((v) => Math.min(items.length - 1, v + 1)))
              if (e.key === "ArrowUp") (e.preventDefault(), setActive((v) => Math.max(0, v - 1)))
              if (e.key === "Enter" && items[active]) run(items[active])
              if (e.key === "Escape") onClose()
            }}
          />
          <Kbd keys="Esc" />
        </div>
        <div ref={box} className="listbox" role="listbox">
          {items.map((it, i) => {
            const head = it.group !== last ? <div className="option-group">{it.group}</div> : null
            last = it.group
            return (
              <div key={it.id} style={{ display: "contents" }}>
                {head}
                <div data-i={i} className={cx("option", i === active && "active")} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => run(it)}>
                  {it.lead}
                  {it.icon && (
                    <span className="lead">
                      <Icon name={it.icon} size="sm" />
                    </span>
                  )}
                  <span className="body">
                    <span className="ellipsis">{it.label}</span>
                    {it.hint && <span className="hint">{it.hint}</span>}
                  </span>
                  {i === active && <Icon name="arrowRight" size="sm" className="faint" />}
                </div>
              </div>
            )
          })}
          {!items.length && <div className="list-empty">没有匹配的企业</div>}
        </div>
        <div className="foot">
          <span>
            <Kbd keys="↑" />
            <Kbd keys="↓" /> 选择
          </span>
          <span>
            <Kbd keys="↵" /> 打开
          </span>
          <span>
            <Kbd keys="1" /> <Kbd keys="2" /> 切换产品线
          </span>
        </div>
      </div>
    </Portal>
  )
}

const highlight = (text: string, q: string) => {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark className="mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}
