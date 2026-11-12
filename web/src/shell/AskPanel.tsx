import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { AskBlock, AskContext, AskEvent, AskMessage, AskSession } from "@spec/contract"
import { call, RequestError } from "../api/client"
import { useCtx } from "../lib/ctx"
import { lineName } from "../lib/labels"
import { locate } from "../lib/locate"
import { snapshot, clearSelection, useSelection } from "../lib/viewctx"
import { time, weekShort } from "../lib/format"
import { Button, IconButton, Kbd, cx } from "../ui/controls"
import { Icon } from "../ui/icons"
import { Portal, Tooltip, toast } from "../ui/overlays"
import { useEnterprise } from "../api/hooks"

const pageName: Record<string, string> = { week: "本周", customers: "客户", enterprise: "企业", templates: "模板", playground: "试验台", followups: "跟进", analysis: "分析", data: "数据", export: "导出", report: "周报" }

const suggest = (c: AskContext): string[] => {
  if (c.selection) return [`为什么「${c.selection.label}」是这样`, `「${c.selection.label}」和上周比有什么变化`, "这里最值得关注的是什么"]
  if (c.enterprise) return ["这家企业最近为什么用得少了", "他们最常做什么，效果怎么样", "下次联系时该聊什么"]
  if (c.page === "customers") return ["当前筛选下有多少家客户", "哪些稳定客户这周明显下滑", "下载率最低的重度客户是哪些"]
  if (c.page === "templates") return ["哪些写法最值得做成官方模板", "定制模板上线后效果怎么样", "重试最多的任务类型是什么"]
  if (c.page === "analysis") return ["哪个模型在换色上表现最好", "失败主要集中在哪里", "Agent 模式的效果怎么样"]
  return ["这周最需要关注的三件事", "稳定企业为什么少了", "哪些客户在连续下滑"]
}

const ctxChips = (c: AskContext, entName: string | null) => {
  const xs: { key: string; label: string }[] = [{ key: "page", label: pageName[c.page] ?? c.page }, { key: "line", label: lineName[c.line] }]
  if (c.week) xs.push({ key: "week", label: `${weekShort(c.week)} 周` })
  if (c.enterprise) xs.push({ key: "enterprise", label: entName ?? "企业" })
  Object.entries(c.filters).forEach(([k, v]) => xs.push({ key: `f:${k}`, label: `${k}=${v}` }))
  if (c.selection) xs.push({ key: "selection", label: c.selection.label })
  return xs
}

const strip = (c: AskContext, off: string[]): AskContext => ({
  ...c,
  week: off.includes("week") ? null : c.week,
  enterprise: off.includes("enterprise") ? null : c.enterprise,
  selection: off.includes("selection") ? null : c.selection,
  filters: Object.fromEntries(Object.entries(c.filters).filter(([k]) => !off.includes(`f:${k}`))),
})

const read = async (res: Response, on: (e: AskEvent) => void, signal: AbortSignal) => {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = chunk.split("\n").find((l) => l.startsWith("data:"))
      if (line) {
        try {
          on(JSON.parse(line.slice(5).trim()))
        } catch {}
      }
    }
  }
}

export const AskPanel = () => {
  const { week, route } = useCtx()
  const qc = useQueryClient()
  const [open, setOpen] = useState(() => localStorage.getItem("fd-ask-open") === "1")
  const [pinned, setPinned] = useState(() => localStorage.getItem("fd-ask-pin") === "1")
  const [width, setWidth] = useState(() => Number(localStorage.getItem("fd-ask-w")) || 440)
  const [sid, setSid] = useState<string | null>(() => localStorage.getItem("fd-ask-sid"))
  const [history, setHistory] = useState(false)
  const [text, setText] = useState("")
  const [off, setOff] = useState<string[]>([])
  const [live, setLive] = useState<{ status: string; parts: Record<number, string>; blocks: Record<number, AskBlock> } | null>(null)
  const [pending, setPending] = useState<AskMessage | null>(null)
  const abort = useRef<AbortController | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const sel = useSelection()
  const ent = useEnterprise(route.ent, week)
  const ctx = useMemo(() => snapshot(week), [week, route, sel])
  const sessions = useQuery({ queryKey: ["GET /api/ask/sessions"], queryFn: () => call("GET /api/ask/sessions"), enabled: open, retry: false })
  const session = useQuery({ queryKey: ["GET /api/ask/sessions/:id", sid], queryFn: () => call("GET /api/ask/sessions/:id", { params: { id: sid! } }), enabled: open && !!sid, retry: false })
  const down = sessions.error instanceof RequestError && (sessions.error.missing || sessions.error.status >= 500 || sessions.error.status === 502)
  useEffect(() => localStorage.setItem("fd-ask-open", open ? "1" : "0"), [open])
  useEffect(() => localStorage.setItem("fd-ask-pin", pinned ? "1" : "0"), [pinned])
  useEffect(() => (sid ? localStorage.setItem("fd-ask-sid", sid) : localStorage.removeItem("fd-ask-sid"), undefined), [sid])
  useEffect(() => {
    if (session.error instanceof RequestError && session.error.status === 404) setSid(null)
  }, [session.error])
  useEffect(() => {
    document.documentElement.style.setProperty("--ask-w", open && pinned ? `${width}px` : "0px")
  }, [open, pinned, width])
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === "Escape" && open && !pinned && !(e.target as HTMLElement).closest(".modal, .drawer")) setOpen(false)
    }
    window.addEventListener("keydown", f)
    return () => window.removeEventListener("keydown", f)
  }, [open, pinned])
  useEffect(() => setOff([]), [route.page, route.ent])
  const msgs = [...(session.data?.messages ?? []), ...(pending ? [pending] : [])]
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" })
  }, [msgs.length, live])
  const busy = !!live
  const send = async (q: string) => {
    const t = q.trim()
    if (!t || busy) return
    const c = strip(ctx, off)
    setText("")
    setHistory(false)
    let id = sid
    try {
      if (!id) {
        const s = await call("POST /api/ask/sessions")
        id = s.id
        setSid(id)
        qc.setQueryData(["GET /api/ask/sessions/:id", id], s)
      }
      setPending({ id: "pending", role: "user", text: t, blocks: [], context: c, state: "done", createdAt: new Date().toISOString() })
      setLive({ status: "正在理解问题", parts: {}, blocks: {} })
      const ctl = new AbortController()
      abort.current = ctl
      const res = await fetch(`/api/ask/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t, context: c }), signal: ctl.signal })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.message ?? "问答服务不可用")
      }
      await read(
        res,
        (e) => {
          if (e.type === "status") setLive((l) => (l ? { ...l, status: e.text } : l))
          if (e.type === "delta") setLive((l) => (l ? { ...l, parts: { ...l.parts, [e.index]: (l.parts[e.index] ?? "") + e.text } } : l))
          if (e.type === "block") setLive((l) => (l ? { ...l, blocks: { ...l.blocks, [e.index]: e.block } } : l))
          if (e.type === "error") toast(e.error.message, { tone: "error" })
        },
        ctl.signal,
      )
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, { tone: "error" })
    } finally {
      abort.current = null
      setLive(null)
      setPending(null)
      if (id) await qc.invalidateQueries({ queryKey: ["GET /api/ask/sessions/:id", id] })
      qc.invalidateQueries({ queryKey: ["GET /api/ask/sessions"] })
    }
  }
  const stop = () => {
    abort.current?.abort()
    if (sid) call("POST /api/ask/sessions/:id/stop", { params: { id: sid } }).catch(() => {})
  }
  const drag = (e: React.PointerEvent) => {
    const x0 = e.clientX
    const w0 = width
    const move = (ev: PointerEvent) => setWidth(Math.max(360, Math.min(760, w0 + x0 - ev.clientX)))
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      localStorage.setItem("fd-ask-w", String(width))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  const chips = ctxChips(ctx, ent.data?.enterprise.name ?? null)
  const liveBlocks = live ? [...Object.keys(live.parts).map(Number), ...Object.keys(live.blocks).map(Number)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b) : []
  return (
    <Portal>
      {!open && (
        <Tooltip content={down ? "问答服务未启动" : "问数据"}>
          <button className={cx("ask-fab", down && "down")} onClick={() => setOpen(true)} aria-label="问答">
            <Icon name="sparkle" />
            <Kbd keys={["⌘", "J"]} />
          </button>
        </Tooltip>
      )}
      {open && (
        <aside className={cx("ask", pinned && "pinned")} style={{ width }}>
          <div className="ask-grip" onPointerDown={drag} />
          <header className="ask-h">
            <button className="ask-title" onClick={() => setHistory(!history)}>
              <Icon name="sparkle" size="sm" />
              <span className="ellipsis">{history ? "历史会话" : session.data?.title || "问数据"}</span>
              <Icon name={history ? "chevUp" : "chevDown"} size="xs" className="faint" />
            </button>
            <span className="spacer" />
            <Tooltip content="新会话">
              <IconButton size="sm" icon="plus" label="新会话" onClick={() => (setSid(null), setHistory(false))} />
            </Tooltip>
            <Tooltip content={pinned ? "取消固定" : "固定在右侧"}>
              <IconButton size="sm" icon={pinned ? "layers" : "expand"} label="固定" onClick={() => setPinned(!pinned)} active={pinned} />
            </Tooltip>
            <IconButton size="sm" icon="x" label="关闭" onClick={() => setOpen(false)} />
          </header>
          {history ? (
            <History sessions={sessions.data ?? []} current={sid} pick={(id) => (setSid(id), setHistory(false))} remove={async (id) => {
              await call("DELETE /api/ask/sessions/:id", { params: { id } }).catch(() => {})
              if (id === sid) setSid(null)
              qc.invalidateQueries({ queryKey: ["GET /api/ask/sessions"] })
            }} />
          ) : (
            <div className="ask-body" ref={list}>
              {down ? (
                <div className="ask-empty">
                  <Icon name="alert" size="lg" />
                  <b>问答服务未启动</b>
                  <span>它运行在本机 8766 端口，启动后刷新这里</span>
                </div>
              ) : msgs.length || live ? (
                <>
                  {msgs.map((m) => (
                    <Message key={m.id} m={m} onClarify={send} />
                  ))}
                  {live && (
                    <div className="ask-msg bot">
                      {liveBlocks.map((i) => (live.blocks[i] ? <Block key={i} b={live.blocks[i]} onClarify={send} /> : <RichText key={i} text={live.parts[i]} />))}
                      <div className="ask-status">
                        <span className="dots"><i /><i /><i /></span>
                        {live.status}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="ask-hello">
                  <b>问数据</b>
                  <span>回答基于本机导入的真实数据，数字带出处，可以点「查看」跳到对应位置。</span>
                </div>
              )}
            </div>
          )}
          {!history && !down && (
            <footer className="ask-f">
              <div className="ask-ctx">
                {chips.map((c) =>
                  c.key === "page" || c.key === "line" ? (
                    <span key={c.key} className="ask-chip fixed">{c.label}</span>
                  ) : (
                    <span key={c.key} className={cx("ask-chip", off.includes(c.key) && "off")}>
                      <span className="ellipsis">{c.label}</span>
                      <button onClick={() => (c.key === "selection" && !off.includes(c.key) ? clearSelection() : setOff((o) => (o.includes(c.key) ? o.filter((x) => x !== c.key) : [...o, c.key])))} aria-label="去掉">
                        <Icon name={off.includes(c.key) ? "plus" : "x"} size="xs" />
                      </button>
                    </span>
                  ),
                )}
              </div>
              {!msgs.length && !live && (
                <div className="ask-sug">
                  {suggest(ctx).map((s) => (
                    <button key={s} onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="ask-in">
                <textarea
                  value={text}
                  placeholder="问一个关于数据的问题"
                  rows={2}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send(text))
                  }}
                />
                {busy ? (
                  <Button size="sm" icon="x" onClick={stop}>
                    停止
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" icon="arrowUpRight" disabled={!text.trim()} onClick={() => send(text)} />
                )}
              </div>
            </footer>
          )}
        </aside>
      )}
    </Portal>
  )
}

const History = ({ sessions, current, pick, remove }: { sessions: Omit<AskSession, "messages">[]; current: string | null; pick: (id: string) => void; remove: (id: string) => void }) => {
  const groups = useMemo(() => {
    const today = new Date().toDateString()
    const m = new Map<string, typeof sessions>()
    ;[...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).forEach((s) => {
      const d = new Date(s.updatedAt)
      const k = d.toDateString() === today ? "今天" : `${d.getMonth() + 1}/${d.getDate()}`
      m.set(k, [...(m.get(k) ?? []), s])
    })
    return [...m]
  }, [sessions])
  if (!sessions.length) return <div className="ask-empty"><span>还没有会话</span></div>
  return (
    <div className="ask-body">
      {groups.map(([k, xs]) => (
        <div key={k} className="ask-hg">
          <div className="ask-hk">{k}</div>
          {xs.map((s) => (
            <div key={s.id} className={cx("ask-hi", s.id === current && "on")} onClick={() => pick(s.id)}>
              <span className="ellipsis">{s.title || "未命名"}</span>
              <span className="faint num">{time(s.updatedAt).split(" ")[1]}</span>
              <button onClick={(e) => (e.stopPropagation(), remove(s.id))} aria-label="删除">
                <Icon name="trash" size="xs" />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const inline = (t: string) =>
  t.split(/(\*\*[^*]+\*\*)/g).map((x, i) => (x.startsWith("**") && x.endsWith("**") ? <b key={i}>{x.slice(2, -2)}</b> : <span key={i}>{x}</span>))

const lead = (t: string) => {
  const m = /^([^，。；：:!?！？\s]{2,28})[：:]\s*(.+)$/s.exec(t)
  return m ? (
    <>
      <b className="ask-lead">{m[1]}</b>
      {inline(m[2])}
    </>
  ) : (
    inline(t)
  )
}

export const RichText = ({ text }: { text: string }) => {
  const paras = text.replace(/\r/g, "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return (
    <div className="ask-rich">
      {paras.map((p, i) => {
        const lines = p.split("\n").map((l) => l.trim()).filter(Boolean)
        const items = lines.filter((l) => /^([-•·*]|\d+[.、)）])\s*/.test(l))
        if (items.length && items.length === lines.length)
          return (
            <ul key={i}>
              {lines.map((l, k) => (
                <li key={k}>{lead(l.replace(/^([-•·*]|\d+[.、)）])\s*/, ""))}</li>
              ))}
            </ul>
          )
        const note = i === paras.length - 1 && paras.length > 1 && /(截断|不代表|仅供|仅基于|可能不完整)/.test(p)
        return (
          <p key={i} className={cx(i === 0 && paras.length > 1 && "first", note && "note")}>
            {lines.map((l, k) => (
              <span key={k}>
                {k > 0 && <br />}
                {lead(l)}
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}

type Piece = { kind: "one"; b: AskBlock } | { kind: "stats"; xs: Extract<AskBlock, { type: "stat" }>[] }

const pieces = (blocks: AskBlock[]): Piece[] => {
  const out: Piece[] = []
  blocks.forEach((b) => {
    const last = out[out.length - 1]
    if (b.type === "stat") {
      if (last?.kind === "stats") last.xs.push(b)
      else out.push({ kind: "stats", xs: [b] })
    } else out.push({ kind: "one", b })
  })
  return out
}

const Stats = ({ xs }: { xs: Extract<AskBlock, { type: "stat" }>[] }) =>
  xs.length === 1 && !/[｜|]/.test(xs[0].label) ? (
    <Block b={xs[0]} onClarify={() => {}} />
  ) : (
    <div className="ask-stats">
      <div className="ask-ev-h">依据</div>
      {xs.map((b, i) => {
        const [name, ...rest] = b.label.split(/\s*[｜|]\s*/)
        return (
          <div key={i} className={cx("ask-sr", b.target && "go")} onClick={() => b.target && locate(b.target)}>
            <span className="ask-sr-l">
              <span className="ellipsis">{name}</span>
              {rest.length > 0 && <span className="faint ellipsis">{rest.join(" · ")}</span>}
            </span>
            <span className="ask-sr-v num">{b.value}</span>
            {b.delta && <span className={cx("ask-sr-d num", /^[-−]/.test(b.delta) ? "down" : "up")}>{b.delta}</span>}
            {b.target ? <Icon name="arrowUpRight" size="xs" className="ask-sr-go" /> : <span />}
          </div>
        )
      })}
    </div>
  )

const plain = (m: AskMessage) => m.blocks.map((b) => (b.type === "text" ? b.text : b.type === "stat" ? `${b.label}：${b.value}${b.delta ? `（${b.delta}）` : ""}` : b.type === "list" ? [b.title, ...b.items.map((x) => `- ${x.label}${x.value ? `：${x.value}` : ""}`)].filter(Boolean).join("\n") : b.type === "chart" ? `${b.title}：${b.points.map((p) => `${p.label} ${p.value ?? "—"}`).join("，")}` : b.question)).join("\n\n") || m.text || ""

const Message = ({ m, onClarify }: { m: AskMessage; onClarify: (s: string) => void }) =>
  m.role === "user" ? (
    <div className="ask-msg me">
      <p>{m.text}</p>
    </div>
  ) : (
    <div className={cx("ask-msg bot", m.state === "failed" && "failed")}>
      {m.blocks.length ? pieces(m.blocks).map((x, i) => (x.kind === "stats" ? <Stats key={i} xs={x.xs} /> : <Block key={i} b={x.b} onClarify={onClarify} />)) : m.text ? <RichText text={m.text} /> : null}
      {m.state === "failed" && (
        <div className="ask-fail">
          <Icon name="alert" size="xs" />
          没能给出有依据的回答
        </div>
      )}
      {m.state === "done" && (m.blocks.length > 0 || m.text) && (
        <div className="ask-acts">
          <span className="faint num">{time(m.createdAt).split(" ")[1]}</span>
          <button onClick={() => navigator.clipboard.writeText(plain(m)).then(() => toast("已复制", { tone: "ok", ms: 1200 }))}>
            <Icon name="copy" size="xs" />
            复制
          </button>
        </div>
      )}
    </div>
  )

const Go = ({ t }: { t: Parameters<typeof locate>[0] | null }) =>
  t ? (
    <button className="ask-go" onClick={() => locate(t)}>
      查看
      <Icon name="arrowUpRight" size="xs" />
    </button>
  ) : null

const Block = ({ b, onClarify }: { b: AskBlock; onClarify: (s: string) => void }) => {
  if (b.type === "text") return <RichText text={b.text} />
  if (b.type === "stat")
    return (
      <div className="ask-stat">
        <span className="faint">{b.label}</span>
        <b className="num">{b.value}</b>
        {b.delta && <span className={cx("num", b.delta.startsWith("-") || b.delta.startsWith("−") ? "down" : "up")}>{b.delta}</span>}
        <span className="spacer" />
        <Go t={b.target} />
      </div>
    )
  if (b.type === "chart") {
    const vals = b.points.map((p) => p.value ?? 0)
    const max = Math.max(1, ...vals)
    return (
      <div className="ask-chart">
        <div className="row" style={{ gap: 8 }}>
          <span className="ask-ct">{b.title}</span>
          <span className="spacer" />
          <Go t={b.target} />
        </div>
        {b.kind === "bar" ? (
          <div className="ask-bars">
            {b.points.map((p, i) => (
              <div key={i} className="ask-bar">
                <span className="ellipsis">{p.label}</span>
                <span className="ask-bar-t">
                  <i style={{ width: `${((p.value ?? 0) / max) * 100}%` }} />
                </span>
                <span className="num">{p.value ?? "—"}</span>
              </div>
            ))}
          </div>
        ) : (
          <svg className="ask-line" viewBox={`0 0 ${Math.max(1, b.points.length - 1) * 40} 60`} preserveAspectRatio="none">
            <polyline points={b.points.map((p, i) => `${i * 40},${56 - ((p.value ?? 0) / max) * 52}`).join(" ")} />
          </svg>
        )}
        {b.kind === "line" && (
          <div className="ask-xl num">
            <span>{b.points[0]?.label}</span>
            <span>{b.points[b.points.length - 1]?.label}</span>
          </div>
        )}
      </div>
    )
  }
  if (b.type === "list")
    return (
      <div className="ask-list">
        {b.title && <div className="ask-ct">{b.title}</div>}
        {b.items.map((x, i) => (
          <div key={i} className={cx("ask-li", x.target && "go")} onClick={() => x.target && locate(x.target)}>
            <span className="ellipsis">{x.label}</span>
            {x.value && <span className="num faint">{x.value}</span>}
            {x.target && <Icon name="arrowUpRight" size="xs" className="faint" />}
          </div>
        ))}
      </div>
    )
  return (
    <div className="ask-clar">
      <span>{b.question}</span>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {b.options.map((o) => (
          <button key={o} onClick={() => onClarify(o)}>
            {o}
          </button>
        ))}
      </div>
    </div>
  )
}
