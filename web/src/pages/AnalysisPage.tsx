import { useMemo, useState } from "react"
import type { Finding, InspirationAnalysis, Line, MatrixCell, Verdict, VideoAnalysis } from "@spec/contract"
import { useCall, useCrossLine, useFindings, useInspirationAnalysis, useVideoAnalysis } from "../api/hooks"
import { navigate } from "../lib/route"
import { useCtx } from "../lib/ctx"
import { failureName, lineName, patternName, verdictName } from "../lib/labels"
import { compact, num, pct, time } from "../lib/format"
import { Button, Input, RadioGroup, Segmented, TextArea, IconButton, cx } from "../ui/controls"
import { Badge, Card, Empty, ErrorState, Rate, Skel } from "../ui/display"
import { BarList } from "../ui/charts"
import { Icon } from "../ui/icons"
import { Menu, Modal, Tooltip, toast } from "../ui/overlays"
import { TaskViewer } from "./enterprise/TaskViewer"
import { useQueryClient } from "@tanstack/react-query"
import { call } from "../api/client"
import { errorText, watchJob } from "../api/next"
import { JobProgress } from "../ui/insight"

const mix = (a: number[], b: number[], t: number) => a.map((x, i) => Math.round(x + (b[i] - x) * t))
const heat = (v: number | null, base: number) => {
  if (v == null) return { bg: "transparent", ink: "var(--ink-4)" }
  const d = Math.max(-1, Math.min(1, (v - base) / 0.35))
  const neutral = [246, 245, 242]
  const c = d < 0 ? mix(neutral, [233, 120, 110], -d) : mix(neutral, [104, 188, 152], d)
  return { bg: `rgb(${c.join(",")})`, ink: Math.abs(d) > 0.7 ? "#fff" : "var(--ink)" }
}

export const AnalysisPage = () => {
  const { line, week, excluded } = useCtx()
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>分析</h1>
          <div className="meta">
            <span>{lineName[line]}</span>
            {excluded && <Badge tone="accent">已应用排除名单</Badge>}
          </div>
        </div>
      </div>
      {line === "inspiration" ? <InspirationView week={week} excluded={excluded} /> : <VideoView week={week} excluded={excluded} />}
      {week && <CrossLine week={week} />}
      <Findings line={line} />
    </div>
  )
}

const CrossLine = ({ week }: { week: string }) => {
  const q = useCrossLine(week)
  if (q.isLoading) return <Skel h={120} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const groups = [{ key: "both" as const, label: "两条线都在使用", line: "inspiration" as const }, { key: "inspirationOnly" as const, label: "仅使用灵感成款", line: "inspiration" as const }, { key: "videoOnly" as const, label: "仅使用 AI 视频", line: "video" as const }]
  return <Card title="跨线使用"><div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>{groups.map(g => <div key={g.key} className="stack" style={{ gap: 8, maxHeight: 240, overflowY: "auto" }}><span className="label">{g.label} · {q.data![g.key].length} 家</span>{q.data![g.key].map(e => <button key={e.id} className="ellipsis" style={{ textAlign: "left" }} onClick={() => navigate({ line: g.line, ent: e.id })}>{e.name}</button>)}</div>)}</div></Card>
}

const InspirationView = ({ week, excluded }: { week: string | null; excluded: boolean }) => {
  const q = useInspirationAnalysis(week, excluded)
  const [mode, setMode] = useState<"task" | "ent">("task")
  if (q.isLoading) return <Skel h={420} r={12} />
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>
  const a = q.data
  return (
    <div className="grid">
      <Matrix a={a} mode={mode} setMode={setMode} />
      <Card className="span-5" title="使用方式" sub="快速模式">
        <BarList
          items={[...a.patterns].sort((x, y) => y.tasks - x.tasks).map((p) => ({
            key: p.pattern,
            label: patternName[p.pattern],
            value: p.tasks,
            tone: p.pattern === "retry" || p.pattern === "tweak" ? "var(--down-weak)" : undefined,
            display: <span className="num">{pct(p.share)}</span>,
            secondary: <Rate value={p.downloadRate} width={36} />,
          }))}
        />
        <div className="divider" />
        <dl className="kv" style={{ fontSize: 13.5 }}>
          <dt>批量</dt>
          <dd>同一句提示词连续换图</dd>
          <dt>重试 · 微调</dt>
          <dd>同一张图重新生成或只改几个字</dd>
          <dt>适配 · 改写</dt>
          <dd>换图时调整写法 / 同一张图换了写法</dd>
        </dl>
      </Card>
      <Card className="span-7" title="任务类型" sub={`其他 ${pct(a.unclassifiedShare)} 未能归类`}>
        <BarList
          items={a.intents.map((t) => ({
            key: t.intent,
            label: t.intent,
            value: t.tasks,
            display: <span className="num">{num(t.tasks)}</span>,
            secondary: (
              <span className="row" style={{ gap: 10 }}>
                <span className="faint num" style={{ minWidth: 40, textAlign: "right" }}>{t.enterprises} 家</span>
                <Rate value={t.downloadRate} width={36} />
              </span>
            ),
          }))}
        />
      </Card>
    </div>
  )
}

const Matrix = ({ a, mode, setMode }: { a: InspirationAnalysis; mode: "task" | "ent"; setMode: (m: "task" | "ent") => void }) => {
  const models = useMemo(() => {
    const t = new Map<string, number>()
    a.matrix.forEach((c) => t.set(c.model, (t.get(c.model) ?? 0) + c.tasks))
    return a.models.filter((m) => t.get(m)).sort((x, y) => (t.get(y) ?? 0) - (t.get(x) ?? 0))
  }, [a])
  const intents = a.intents.map((i) => i.intent).filter((i) => a.matrix.some((c) => c.intent === i))
  const cell = (i: string, m: string) => a.matrix.find((c) => c.intent === i && c.model === m)
  const base = a.intents.reduce((s, i) => s + i.downloadRate * i.tasks, 0) / Math.max(1, a.intents.reduce((s, i) => s + i.tasks, 0))
  const value = (c: MatrixCell) => (mode === "task" ? c.downloadRate : c.enterpriseMedianDownloadRate)
  return (
    <Card
      className="span-12 matrix-card"
      title="任务类型 × 模型"
      sub="下载率"
      actions={
        <div className="row" style={{ gap: 14 }}>
          <span className="scale">
            低<span className="grad" />高
          </span>
          <span className="row faint" style={{ gap: 6, fontSize: 12.5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ink)", opacity: 0.6 }} />
            单家占一半以上
          </span>
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "task", label: "按任务" }, { value: "ent", label: "企业中位" }]} />
        </div>
      }
    >
      <div className="heat" style={{ gridTemplateColumns: `120px repeat(${models.length}, minmax(84px, 1fr))` }}>
        <div />
        {models.map((m) => (
          <div key={m} className="h">
            {m}
          </div>
        ))}
        {intents.map((i) => (
          <div key={i} style={{ display: "contents" }}>
            <div className="rh">
              <span>{i}</span>
            </div>
            {models.map((m) => {
              const c = cell(i, m)
              if (!c || c.tasks < 5) return <div key={m} className="cell none" />
              const v = value(c)
              const { bg, ink } = heat(v, base)
              const flagged = v != null && v < base - 0.2 && c.enterprises >= 3
              return (
                <Tooltip
                  key={m}
                  content={
                    <>
                      <div className="t">
                        {i} · {m}
                      </div>
                      <div className="num">任务级 {pct(c.downloadRate)} · {num(c.tasks)} 个任务</div>
                      <div className="num">企业中位 {pct(c.enterpriseMedianDownloadRate)} · {c.enterprises} 家</div>
                      {c.dominantEnterpriseShare >= 0.5 && <div className="muted">一家企业占 {pct(c.dominantEnterpriseShare)}</div>}
                    </>
                  }
                >
                  <div className={cx("cell", flagged && "flag")} style={{ background: bg, color: ink }}>
                    <span className="v num">{v == null ? "—" : pct(v)}</span>
                    <span className="n num">
                      {mode === "task" ? num(c.tasks) : `${c.enterprises} 家`}
                    </span>
                    {c.dominantEnterpriseShare >= 0.5 && <span className="dom" />}
                  </div>
                </Tooltip>
              )
            })}
          </div>
        ))}
      </div>
    </Card>
  )
}

const VideoView = ({ week, excluded }: { week: string | null; excluded: boolean }) => {
  const q = useVideoAnalysis(week, excluded)
  const [view, setView] = useState<number | null>(null)
  if (q.isLoading) return <Skel h={420} r={12} />
  if (q.error || !q.data) return <Card><ErrorState error={q.error} /></Card>
  const a: VideoAnalysis = q.data
  const models = [...new Set(a.matrix.map((c) => c.model))]
  const total = a.failures.reduce((s, f) => s + f.count, 0)
  return (
    <div className="grid">
      <Card className="span-7" flush title="模式 × 模型" sub="耗点与下载">
        <div className="table-wrap">
          <table className="table compact flush">
            <thead>
              <tr>
                <th>模式</th>
                <th>模型</th>
                <th className="r">任务</th>
                <th className="r">耗点</th>
                <th>下载率</th>
                <th className="r">每条下载耗点</th>
                <th className="r">失败</th>
              </tr>
            </thead>
            <tbody>
              {[...a.matrix].sort((x, y) => y.points - x.points).map((c) => (
                <tr key={`${c.mode}${c.model}`}>
                  <td>{c.mode}</td>
                  <td className="faint">{c.model}</td>
                  <td className="r num">{num(c.tasks)}</td>
                  <td className="r num">{compact(c.points)}</td>
                  <td>
                    <Rate value={c.downloadRate} />
                  </td>
                  <td className="r num">{c.pointsPerDownloaded != null ? c.pointsPerDownloaded.toFixed(0) : "—"}</td>
                  <td className="r num">{c.failed ? <span className="down">{c.failed}</span> : <span className="faint">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row faint" style={{ padding: "10px 16px", fontSize: 13, gap: 16 }}>
          <span>{models.length} 个模型</span>
          <span>
            重复生成链 <b className="num" style={{ color: "var(--ink)" }}>{a.rerollChains}</b> 条
          </span>
        </div>
      </Card>
      <Card className="span-5" title="失败原因" sub={`${total} 次`}>
        <BarList items={a.failures.map((f) => ({ key: f.category, label: failureName[f.category], value: f.count, tone: f.category === "material" ? "var(--down-weak)" : undefined, display: <span className="num">{f.count}</span>, secondary: <span className="faint">{f.enterprises} 家</span> }))} />
        <div className="divider" />
        <span className="label">失败样例</span>
        <div className="stack">
          {a.failureSamples.slice(0, 6).map((t, i) => (
            <button key={t.rowKey} className="row" style={{ gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line-2)", textAlign: "left" }} onClick={() => setView(i)}>
              <Badge tone={t.failure?.category === "material" ? "down" : undefined}>{t.failure ? failureName[t.failure.category] : "失败"}</Badge>
              <span className="ellipsis" style={{ flex: 1, fontSize: 13.5 }}>{t.failure?.providerMessage ?? t.prompt}</span>
              <span className="faint ellipsis" style={{ maxWidth: 120, fontSize: 13 }}>{t.enterprise.name}</span>
            </button>
          ))}
          {!a.failureSamples.length && <span className="faint">没有失败</span>}
        </div>
      </Card>
      <Card className="span-12" title="各模式" sub="按耗点">
        <BarList items={a.modes.map((m) => ({ key: m.mode, label: m.mode, value: m.points, display: <span className="num">{compact(m.points)}</span>, secondary: <span className="row" style={{ gap: 10 }}><span className="faint num" style={{ minWidth: 48, textAlign: "right" }}>{num(m.tasks)} 个</span><Rate value={m.downloadRate} width={40} /></span> }))} />
      </Card>
      <TaskViewer tasks={a.failureSamples} index={view} onClose={() => setView(null)} />
    </div>
  )
}

const Findings = ({ line }: { line: Line }) => {
  const q = useFindings()
  const [filter, setFilter] = useState<Verdict | "all">("all")
  const [edit, setEdit] = useState<Finding | "new" | null>(null)
  const list = (q.data ?? []).filter((f) => f.line === line && (filter === "all" || f.verdict === filter))
  const all = (q.data ?? []).filter((f) => f.line === line)
  return (
    <>
      <div className="section-title">
        <Icon name="book" size="sm" />
        结论记录
        <span className="sub">被数据证实或推翻的判断</span>
        <span className="spacer" />
        <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部", count: all.length }, ...(["confirmed", "refuted", "open"] as Verdict[]).map((v) => ({ value: v, label: verdictName[v], count: all.filter((f) => f.verdict === v).length }))]} />
        <Button size="sm" icon="plus" onClick={() => setEdit("new")}>
          记录
        </Button>
      </div>
      <Card flush>
        {q.isLoading ? (
          <div style={{ padding: 16 }}>
            <Skel h={60} />
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : list.length ? (
          list.map((f) => (
            <div key={f.id} className="finding">
              <span className={`verdict ${f.verdict}`}>
                <Icon name={f.verdict === "confirmed" ? "check" : f.verdict === "refuted" ? "x" : "clock"} size="xs" />
                {verdictName[f.verdict]}
              </span>
              <div className="body">
                <div className="claim">{f.claim}</div>
                <div className="ev">{f.evidence}</div>
                <div className="meta">
                  <span>{f.sample}</span>
                  {f.caveat && <span>注意：{f.caveat}</span>}
                  {f.rule && <Badge tone="accent" icon="zap">驱动预警</Badge>}
                  <span>{time(f.updatedAt)}</span>
                </div>
                <Rechecks f={f} />
              </div>
              <div className="row" style={{ gap: 4, alignSelf: "flex-start" }}>
                <RecheckButton f={f} />
                <Menu width={160} items={[{ key: "edit", label: "编辑", icon: "edit", onSelect: () => setEdit(f) }]} trigger={({ toggle, ref }) => <IconButton ref={ref as any} size="sm" icon="more" label="更多" onClick={toggle} />} />
              </div>
            </div>
          ))
        ) : (
          <Empty icon="book" title="没有结论" compact />
        )}
      </Card>
      <FindingEditor value={edit} line={line} onClose={() => setEdit(null)} />
    </>
  )
}

const FindingEditor = ({ value, line, onClose }: { value: Finding | "new" | null; line: Line; onClose: () => void }) => {
  const create = useCall("POST /api/findings", ["GET /api/findings"])
  const patch = useCall("PATCH /api/findings/:id", ["GET /api/findings"])
  const f = value && value !== "new" ? value : null
  const [form, setForm] = useState({ claim: "", evidence: "", sample: "", caveat: "", verdict: "open" as Verdict })
  const [last, setLast] = useState<string | null>(null)
  const key = value === "new" ? "new" : f?.id ?? null
  if (key !== last) {
    setLast(key)
    setForm({ claim: f?.claim ?? "", evidence: f?.evidence ?? "", sample: f?.sample ?? "", caveat: f?.caveat ?? "", verdict: f?.verdict ?? "open" })
  }
  const save = () => {
    const body = { ...form, caveat: form.caveat || null, line }
    const done = { onSuccess: () => (toast("已保存", { tone: "ok", ms: 1500 }), onClose()), onError: (e: any) => toast(e.message, { tone: "error" }) }
    if (f) patch.mutate({ params: { id: f.id }, body }, done)
    else create.mutate({ body: { ...body, rule: null } }, done)
  }
  return (
    <Modal open={!!value} onClose={onClose} title={f ? "编辑结论" : "记录结论"} width={560} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" disabled={!form.claim.trim()} loading={create.isPending || patch.isPending} onClick={save}>保存</Button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <span className="label">判断</span>
          <Input value={form.claim} onChange={(e) => setForm({ ...form, claim: e.target.value })} placeholder="一句话" />
        </div>
        <div>
          <span className="label">结论</span>
          <RadioGroup row value={form.verdict} onChange={(v) => setForm({ ...form, verdict: v })} options={(["confirmed", "refuted", "open"] as Verdict[]).map((v) => ({ value: v, label: verdictName[v] }))} />
        </div>
        <div>
          <span className="label">证据</span>
          <TextArea value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="数字和对比" />
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <span className="label">样本</span>
            <Input value={form.sample} onChange={(e) => setForm({ ...form, sample: e.target.value })} placeholder="哪几周、多少家" />
          </div>
          <div>
            <span className="label">注意</span>
            <Input value={form.caveat} onChange={(e) => setForm({ ...form, caveat: e.target.value })} placeholder="局限" />
          </div>
        </div>
      </div>
    </Modal>
  )
}

const RecheckButton = ({ f }: { f: Finding }) => {
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  const go = async () => {
    setBusy(true)
    try {
      const j = await call("POST /api/findings/:id/recheck", { params: { id: f.id } })
      watchJob(j, (r) => {
        setBusy(false)
        qc.invalidateQueries({ queryKey: ["GET /api/findings"] })
        toast(r.state === "done" ? "已用最新数据核对" : `核对失败：${r.error?.message ?? ""}`, { tone: r.state === "done" ? "ok" : "error" })
      })
    } catch (e) {
      setBusy(false)
      toast(errorText(e), { tone: "error" })
    }
  }
  return busy ? <JobProgress state="running" label="核对中" /> : (
    <Button size="xs" variant="ghost" icon="refresh" onClick={go}>
      重新核对
    </Button>
  )
}

const Rechecks = ({ f }: { f: Finding }) => {
  const patch = useCall("PATCH /api/findings/:id", ["GET /api/findings"])
  const [all, setAll] = useState(false)
  const xs = [...(f.rechecks ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1))
  if (!xs.length) return null
  const shown = all ? xs : xs.slice(0, 1)
  return (
    <div className="rechecks">
      {shown.map((r, i) => (
        <div key={r.at} className={cx("recheck", r.changed && "changed")}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`verdict ${r.verdict}`}>{verdictName[r.verdict]}</span>
            <span className="faint num">{time(r.at)} 核对</span>
            {r.changed ? <Badge tone="warn">结论有变化</Badge> : <span className="faint">结论不变</span>}
            <span className="spacer" />
            {i === 0 && r.changed && (
              <Button size="xs" variant="soft" icon="check" loading={patch.isPending} onClick={() => patch.mutate({ params: { id: f.id }, body: { verdict: r.verdict, evidence: r.evidence, sample: r.sample } }, { onSuccess: () => toast("已采用新结论", { tone: "ok" }) })}>
                采用新结论
              </Button>
            )}
          </div>
          <div className="ev">{r.evidence}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>{r.sample}</div>
        </div>
      ))}
      {xs.length > 1 && (
        <button className="pf-more" onClick={() => setAll(!all)}>
          <Icon name={all ? "chevUp" : "chevDown"} size="xs" />
          {all ? "收起" : `更早的 ${xs.length - 1} 次核对`}
        </button>
      )}
    </div>
  )
}
