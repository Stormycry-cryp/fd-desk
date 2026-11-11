import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Mark, Task, TrialArm, TrialBudget, TrialCase, TrialCell, TrialRun } from "@spec/contract"
import { call } from "../../api/client"
import { errorText, useTemplate, useTrial, useTrialBudget, useTrials } from "../../api/next"
import { useCtx } from "../../lib/ctx"
import { navigate } from "../../lib/route"
import { num, time } from "../../lib/format"
import { fdUrl } from "../../lib/fd"
import { Button, Checkbox, IconButton, Input, cx } from "../../ui/controls"
import { Empty, ErrorState, Skel, Thumb } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { JobProgress } from "../../ui/insight"
import { MarkControl, markName, PromptEditor } from "../../ui/prompt"
import { Drawer, Select, Tooltip, toast } from "../../ui/overlays"
import { CompareViewer } from "./CompareViewer"

const money = (n: number, cur: string) => `${cur === "CNY" ? "¥" : "$"}${n.toFixed(n < 10 ? 1 : 0)}`

export const PlaygroundPage = () => {
  const { route } = useCtx()
  const tq = useTemplate(route.tpl)
  const runs = useTrials(route.tpl)
  const budget = useTrialBudget()
  const seed = route.q.includes(":") ? { enterprise: route.q.split(":")[0], rowKey: route.q.split(":")[1] } : null
  const runId = route.run ?? (runs.data && runs.data.length ? [...runs.data].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0].id : null)
  const [fresh, setFresh] = useState(false)
  if (!route.tpl && !seed && !route.run)
    return (
      <div className="page">
        <Empty icon="image" title="试验台" text="从模板草稿、企业生成记录进入，用真实输入重跑对比写法" action={<Button icon="template" onClick={() => navigate({ page: "templates", pane: "drafts" })}>去模板草稿</Button>} />
      </div>
    )
  if ((route.tpl && (tq.isLoading || runs.isLoading)) || budget.isLoading) return <PgSkeleton />
  if (tq.error && route.tpl) return <div className="page"><ErrorState error={tq.error} retry={() => tq.refetch()} /></div>
  const back = () => (route.tpl ? navigate({ page: "templates", tpl: route.tpl, run: null, q: "" }) : history.length > 1 ? history.back() : navigate({ page: "customers" }))
  const title = tq.data ? tq.data.current.content.title || "未命名模板" : "单条记录重跑"
  if (runId && !fresh) return <RunView key={runId} id={runId} title={title} back={back} budget={budget.data ?? null} runs={runs.data ?? []} onNew={() => setFresh(true)} />
  return <Setup title={title} back={back} budget={budget.data ?? null} seed={seed} onCancel={runId ? () => setFresh(false) : undefined} onCreated={(r) => (setFresh(false), navigate({ run: r.id }, { replace: true }))} />
}

const PgSkeleton = () => (
  <div className="page wide">
    <Skel w={320} h={28} />
    <div style={{ marginTop: 20 }}>
      <Skel h={520} r={12} />
    </div>
  </div>
)

const TopBar = ({ title, back, sub, children }: { title: string; back: () => void; sub?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="tpl-top">
    <button className="back" onClick={back}>
      <Icon name="chevLeft" size="sm" />
      返回
    </button>
    <div className="tpl-title">
      <h1 className="ellipsis">{title}</h1>
      <div className="meta">{sub}</div>
    </div>
    <span className="spacer" />
    {children}
  </div>
)

const BudgetPill = ({ b, need }: { b: TrialBudget; need?: number }) => {
  const left = Math.max(0, b.dailyLimit - b.spentToday)
  const over = need != null && need > left
  return (
    <Tooltip content={`今日额度 ${money(b.dailyLimit, b.currency)}，已用 ${money(b.spentToday, b.currency)}`}>
      <span className={cx("bud", over && "over")}>
        <span className="bud-bar">
          <i style={{ width: `${Math.min(100, (b.spentToday / Math.max(1, b.dailyLimit)) * 100)}%` }} />
          {need != null && <i className="need" style={{ width: `${Math.min(100, (need / Math.max(1, b.dailyLimit)) * 100)}%` }} />}
        </span>
        <span className="num">剩 {money(left, b.currency)}</span>
        {need != null && <span className="num faint">· 本次约 {money(need, b.currency)}</span>}
      </span>
    </Tooltip>
  )
}

interface ArmDraft { label: string; prompt: string; model: string; templateVersion?: number }

const Setup = ({ title, back, budget, seed, onCreated, onCancel }: { title: string; back: () => void; budget: TrialBudget | null; seed: { enterprise: string; rowKey: string } | null; onCreated: (r: TrialRun) => void; onCancel?: () => void }) => {
  const { route } = useCtx()
  const tq = useTemplate(route.tpl)
  const t = tq.data
  const cands = useQuery({
    queryKey: ["GET /api/trials/candidates", route.tpl, seed?.enterprise],
    queryFn: () => call("GET /api/trials/candidates", { query: { template: route.tpl ?? undefined, enterprise: route.tpl ? undefined : seed?.enterprise, limit: 24 } }),
  })
  const seedTask = useQuery({
    queryKey: ["seed-task", seed?.rowKey],
    enabled: !!seed,
    queryFn: async () => {
      for (const line of ["inspiration", "video"] as const) {
        const r = await call("GET /api/tasks", { query: { line, enterprise: seed!.enterprise, limit: 200 } })
        const hit = r.items.find((x) => x.rowKey === seed!.rowKey)
        if (hit) return hit
      }
      return null
    },
  })
  const pool = useMemo(() => {
    const xs = [...(seedTask.data ? [seedTask.data] : []), ...(cands.data ?? [])]
    return xs.filter((x, i) => xs.findIndex((y) => y.rowKey === x.rowKey) === i)
  }, [cands.data, seedTask.data])
  const max = budget?.maxCases ?? 12
  const [sel, setSel] = useState<string[]>([])
  useEffect(() => {
    if (!sel.length && pool.length) setSel(pool.slice(0, Math.min(6, max)).map((x) => x.rowKey))
  }, [pool.length])
  const models = budget?.models ?? []
  const defModel = models.find((m) => t?.current.content.model && m.fdModels.includes(t.current.content.model))?.id ?? models[0]?.id ?? ""
  const [arms, setArms] = useState<ArmDraft[]>([])
  useEffect(() => {
    if (arms.length || !models.length) return
    if (t) setArms([{ label: `v${t.current.version}`, prompt: t.current.content.prompt, model: defModel, templateVersion: t.current.version }])
    else if (seedTask.data) setArms([{ label: "原写法", prompt: seedTask.data.prompt, model: models.find((m) => seedTask.data!.model && m.fdModels.includes(seedTask.data!.model))?.id ?? defModel }])
  }, [t, seedTask.data, models.length])
  const unit = (m: string) => models.find((x) => x.id === m)?.unitCost ?? 0
  const need = sel.length * arms.reduce((s, a) => s + unit(a.model), 0)
  const left = budget ? budget.dailyLimit - budget.spentToday : 0
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const r = await call("POST /api/trials", { body: { templateId: route.tpl ?? undefined, taskRowKeys: sel, arms } })
      onCreated(r)
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.length >= max ? s : [...s, k]))
  return (
    <div className="page wide">
      <TopBar title={title} back={back} sub={<span>新建试验</span>}>
        {budget && <BudgetPill b={budget} need={need} />}
        {onCancel && <Button onClick={onCancel}>取消</Button>}
        <Tooltip content={need > left ? "额度不够，减少用例或写法" : !models.length ? "没有可用的模型" : `${sel.length} 个用例 × ${arms.length} 种写法`}>
          <Button variant="primary" icon="play" loading={busy} disabled={!sel.length || !arms.length || need > left || !arms.every((a) => a.prompt.trim() && a.model)} onClick={run}>
            运行
          </Button>
        </Tooltip>
      </TopBar>
      <div className="pg-setup">
        <section className="tpl-col">
          <h3>
            用例
            <span className="faint num">
              已选 {sel.length}/{max}
            </span>
            <span className="spacer" />
            <Button size="xs" variant="ghost" icon="refresh" onClick={() => setSel([...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(6, max)).map((x) => x.rowKey))}>
              换一批
            </Button>
          </h3>
          {cands.isLoading ? (
            <div className="pg-cands">
              {Array.from({ length: 8 }, (_, i) => (
                <Skel key={i} h={150} r={10} />
              ))}
            </div>
          ) : cands.error && !pool.length ? (
            <ErrorState error={cands.error} retry={() => cands.refetch()} />
          ) : pool.length ? (
            <div className="pg-cands">
              {pool.map((x) => (
                <CandCard key={x.rowKey} t={x} on={sel.includes(x.rowKey)} toggle={() => toggle(x.rowKey)} />
              ))}
            </div>
          ) : (
            <Empty icon="image" title="没有可用的真实输入" compact />
          )}
        </section>
        <section className="tpl-col">
          <h3>
            写法
            <span className="faint num">
              {arms.length}/{budget?.maxArms ?? 3}
            </span>
          </h3>
          {arms.map((a, i) => (
            <div key={i} className="pg-arm-edit">
              <div className="row" style={{ gap: 8 }}>
                <Input size="sm" value={a.label} onChange={(e) => setArms(arms.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} style={{ width: 120 }} />
                <Select size="sm" value={a.model} onChange={(m) => setArms(arms.map((x, k) => (k === i ? { ...x, model: m } : x)))} options={models.map((m) => ({ value: m.id, label: m.label, hint: money(m.unitCost, budget!.currency) }))} />
                <span className="spacer" />
                {arms.length > 1 && <IconButton size="xs" icon="x" label="删除" onClick={() => setArms(arms.filter((_, k) => k !== i))} />}
              </div>
              <PromptEditor value={a.prompt} onChange={(v) => setArms(arms.map((x, k) => (k === i ? { ...x, prompt: v, templateVersion: v === t?.current.content.prompt ? t.current.version : undefined } : x)))} slots={t?.current.content.slots.map((s) => s.name)} variables={t?.current.content.variables.map((v) => v.name)} minRows={4} />
            </div>
          ))}
          {arms.length < (budget?.maxArms ?? 3) && (
            <button className="kvt-add" onClick={() => setArms([...arms, { label: `写法 ${arms.length + 1}`, prompt: arms[arms.length - 1]?.prompt ?? "", model: arms[arms.length - 1]?.model ?? defModel }])}>
              <Icon name="plus" size="xs" />
              加一种写法
            </button>
          )}
          {!models.length && <div className="tf-warn"><Icon name="alert" size="xs" />网关里没有可用的生图模型</div>}
        </section>
      </div>
    </div>
  )
}

const CandCard = ({ t, on, toggle }: { t: Task; on: boolean; toggle: () => void }) => (
  <div className={cx("pg-cand", on && "on")} onClick={toggle}>
    <div className="pg-cand-m">
      <Thumb media={t.inputs[0] ?? t.outputs[0]} w="100%" ratio={1} radius={8} />
      <span className="pg-cand-c">
        <Checkbox checked={on} onChange={toggle} />
      </span>
      {t.inputs.length > 1 && <span className="rec-n num">{t.inputs.length}</span>}
    </div>
    <div className="pg-cand-p">{t.prompt}</div>
    <div className="pg-cand-f">
      <span className={cx("dl-dot", t.downloaded && "on", t.failed && "fail")} />
      <span className="ellipsis">{t.enterprise.name}</span>
    </div>
  </div>
)

const RunView = ({ id, title, back, budget, runs, onNew }: { id: string; title: string; back: () => void; budget: TrialBudget | null; runs: TrialRun[]; onNew: () => void }) => {
  const q = useTrial(id)
  const qc = useQueryClient()
  const { route } = useCtx()
  const [view, setView] = useState<{ c: number; a: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])
  if (q.isLoading) return <PgSkeleton />
  if (q.error || !q.data) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>
  const r = q.data
  const set = (next: TrialRun) => qc.setQueryData(["GET /api/trials/:id", { id }, null], next)
  const act = async <T,>(p: Promise<T>, ok?: string) => {
    try {
      const x = await p
      if (x && typeof x === "object" && "cases" in (x as object)) set(x as unknown as TrialRun)
      else qc.invalidateQueries({ queryKey: ["GET /api/trials/:id"] })
      if (ok) toast(ok, { tone: "ok", ms: 1400 })
      return x
    } catch (e) {
      toast(errorText(e), { tone: "error" })
      return null
    }
  }
  const mark = (caseId: string, armId: string, body: { mark?: Mark | null; usable?: boolean | null }) => {
    set({ ...r, cases: r.cases.map((c) => (c.id !== caseId ? c : { ...c, cells: c.cells.map((x) => (x.armId !== armId ? x : { ...x, ...body })) })) })
    act(call("PATCH /api/trials/:id/cells", { params: { id }, body: { caseId, armId, ...body } }))
  }
  const adopt = async (armId: string, caseId?: string) => {
    const t = await act(call("POST /api/trials/:id/adopt", { params: { id }, body: { armId, cover: caseId ? { caseId } : undefined } }), "已写成草稿的新版本")
    if (t) {
      qc.invalidateQueries({ queryKey: ["GET /api/templates/:id"] })
      qc.invalidateQueries({ queryKey: ["GET /api/templates"] })
    }
  }
  const arms = r.arms.filter((a) => !hidden.includes(a.id))
  const running = r.state === "queued" || r.state === "running"
  const cellOf = (c: TrialCase, a: TrialArm) => c.cells.find((x) => x.armId === a.id)
  return (
    <div className="page wide">
      <TopBar
        title={title}
        back={back}
        sub={
          <>
            <span className="num">{time(r.createdAt)}</span>
            <span className="faint num">
              {r.cases.length} 个用例 · {r.arms.length} 种写法 · 花费 {money(r.cost.spent, r.cost.currency)}
            </span>
            {runs.length > 1 && (
              <Select size="sm" ghost value={id} onChange={(v) => navigate({ run: v }, { replace: true })} options={[...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((x) => ({ value: x.id, label: time(x.createdAt) }))} />
            )}
          </>
        }
      >
        {budget && <BudgetPill b={budget} />}
        {running ? (
          <Button icon="x" onClick={() => act(call("POST /api/trials/:id/cancel", { params: { id } }), "已停止")}>
            停止
          </Button>
        ) : (
          <Button icon="plus" onClick={onNew}>
            新试验
          </Button>
        )}
        <Button variant="soft" icon="plus" disabled={r.arms.length >= (budget?.maxArms ?? 3)} onClick={() => setAdding(true)}>
          加写法
        </Button>
      </TopBar>
      {r.fidelity.level !== "exact" && (
        <div className={cx("pg-fid", r.fidelity.level)}>
          <Icon name="info" size="xs" />
          <span>
            <b>{r.fidelity.level === "close" ? "接近 FD" : "直接调用"}</b>
            {r.fidelity.note}
          </span>
        </div>
      )}
      <div className="pg-sum">
        {r.arms.map((a) => {
          const s = r.summary.find((x) => x.armId === a.id)
          if (!s) return null
          const marked = s.better + s.same + s.worse
          return (
            <div key={a.id} className={cx("pg-sum-i", hidden.includes(a.id) && "off")}>
              <div className="row" style={{ gap: 8 }}>
                <b>{a.label}</b>
                <span className="faint ellipsis" style={{ maxWidth: 160 }}>{a.model}</span>
                <span className="spacer" />
                <IconButton size="xs" icon={hidden.includes(a.id) ? "eyeOff" : "eye"} label={hidden.includes(a.id) ? "显示" : "隐藏"} onClick={() => setHidden((h) => (h.includes(a.id) ? h.filter((x) => x !== a.id) : [...h, a.id]))} />
              </div>
              {s.done < s.total ? (
                <JobProgress state="running" done={s.done} total={s.total} label={`${s.done}/${s.total}`} />
              ) : (
                <div className="tr-bar">
                  <i className="up" style={{ width: `${(s.better / Math.max(1, s.total)) * 100}%` }} />
                  <i className="same" style={{ width: `${(s.same / Math.max(1, s.total)) * 100}%` }} />
                  <i className="down" style={{ width: `${(s.worse / Math.max(1, s.total)) * 100}%` }} />
                </div>
              )}
              <div className="tr-nums num">
                <span><b className="up">{s.better}</b> 更好</span>
                <span><b>{s.same}</b> 差不多</span>
                <span><b className="down">{s.worse}</b> 更差</span>
                <span className="spacer" />
                <span className="faint">{s.usable} 可用 · 已标 {marked}/{s.total}</span>
              </div>
              {route.tpl && (
                <Button size="xs" variant={s.better > s.worse ? "primary" : "secondary"} icon="check" onClick={() => adopt(a.id)}>
                  采用这个写法
                </Button>
              )}
            </div>
          )
        })}
      </div>
      <div className="cg" style={{ gridTemplateColumns: `minmax(220px, 260px) repeat(${arms.length + 1}, minmax(220px, 1fr))` }}>
        <div className="cg-h">输入</div>
        <div className="cg-h">原结果</div>
        {arms.map((a) => (
          <Tooltip key={a.id} content={<span style={{ whiteSpace: "pre-wrap", maxWidth: 360, display: "block" }}>{a.prompt}</span>}>
            <div className="cg-h arm">
              <b>{a.label}</b>
              <span className="faint ellipsis">{a.model}</span>
            </div>
          </Tooltip>
        ))}
        {r.cases.map((c, ci) => (
          <CaseRow key={c.id} c={c} arms={arms} cellOf={cellOf} onOpen={(ai) => setView({ c: ci, a: ai })} onMark={mark} onRetry={(armId) => act(call("POST /api/trials/:id/retry", { params: { id }, body: { caseId: c.id, armId } }))} />
        ))}
      </div>
      {view && arms.length > 0 && <CompareViewer run={r} arms={arms} at={view} setAt={setView} onClose={() => setView(null)} onMark={mark} onAdopt={route.tpl ? adopt : undefined} />}
      <AddArm open={adding} onClose={() => setAdding(false)} run={r} budget={budget} onAdded={(x) => (set(x), setAdding(false))} />
    </div>
  )
}

const CaseRow = ({ c, arms, cellOf, onOpen, onMark, onRetry }: { c: TrialCase; arms: TrialArm[]; cellOf: (c: TrialCase, a: TrialArm) => TrialCell | undefined; onOpen: (ai: number) => void; onMark: (caseId: string, armId: string, b: { mark?: Mark | null; usable?: boolean | null }) => void; onRetry: (armId: string) => void }) => {
  const t = c.task
  const link = fdUrl(t)
  return (
    <>
      <div className="cg-in">
        <div className="cg-ins">
          {t.inputs.slice(0, 3).map((m, i) => (
            <Thumb key={i} media={m} w={t.inputs.length > 1 ? 72 : 120} ratio={1} radius={8} onClick={() => window.open(m.url, "_blank", "noopener")} />
          ))}
        </div>
        <div className="cg-p">{t.prompt}</div>
        <div className="cg-f">
          <span className="ellipsis">{t.enterprise.name}</span>
          {link && (
            <a className="fd-link" href={link} target="_blank" rel="noopener" aria-label="在 FD 中打开">
              <Icon name="external" size="xs" />
            </a>
          )}
        </div>
      </div>
      <div className="cg-cell orig" onClick={() => arms.length && onOpen(0)}>
        {t.outputs[0] ? <Thumb media={t.outputs[0]} w="100%" ratio={1} radius={8} /> : <div className="cg-empty">{t.failed ? "原任务失败" : "没有结果"}</div>}
        <span className="cg-tag">
          <span className={cx("dl-dot", t.downloaded && "on", t.failed && "fail")} />
          {t.downloaded ? "客户下载过" : t.failed ? "失败" : "未下载"}
        </span>
      </div>
      {arms.map((a, ai) => {
        const x = cellOf(c, a)
        return (
          <div key={a.id} className={cx("cg-cell", x?.mark)} onClick={() => x?.state === "done" && onOpen(ai)}>
            {!x || x.state === "queued" || x.state === "running" ? (
              <div className="cg-wait">
                <span className="spinner" />
                <span>{x?.state === "running" ? "生成中" : "排队中"}</span>
              </div>
            ) : x.state === "failed" || x.state === "cancelled" ? (
              <div className="cg-fail">
                <Icon name="alert" size="sm" />
                <span>{x.error?.message ?? (x.state === "cancelled" ? "已停止" : "失败")}</span>
                <Button size="xs" icon="refresh" onClick={(e) => (e.stopPropagation(), onRetry(a.id))}>
                  重试
                </Button>
              </div>
            ) : (
              <>
                <div className="cg-img">
                  <Thumb media={x.outputs[0]} w="100%" ratio={1} radius={8} />
                  {x.outputs.length > 1 && <span className="rec-n num">{x.outputs.length}</span>}
                  {x.usable && <span className="cg-usable"><Icon name="check" size="xs" />可用</span>}
                </div>
                <div className="cg-mk" onClick={(e) => e.stopPropagation()}>
                  <MarkControl size="sm" value={x.mark} usable={x.usable} onMark={(m) => onMark(c.id, a.id, { mark: m })} onUsable={(u) => onMark(c.id, a.id, { usable: u })} />
                </div>
              </>
            )}
          </div>
        )
      })}
    </>
  )
}

const AddArm = ({ open, onClose, run, budget, onAdded }: { open: boolean; onClose: () => void; run: TrialRun; budget: TrialBudget | null; onAdded: (r: TrialRun) => void }) => {
  const base = run.arms[run.arms.length - 1]
  const [label, setLabel] = useState("")
  const [prompt, setPrompt] = useState(base?.prompt ?? "")
  const [model, setModel] = useState(base?.model ?? budget?.models[0]?.id ?? "")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setLabel(`写法 ${run.arms.length + 1}`)
      setPrompt(base?.prompt ?? "")
      setModel(base?.model ?? budget?.models[0]?.id ?? "")
    }
  }, [open])
  const unit = budget?.models.find((m) => m.id === model)?.unitCost ?? 0
  const need = unit * run.cases.length
  const left = budget ? budget.dailyLimit - budget.spentToday : 0
  const go = async () => {
    setBusy(true)
    try {
      onAdded(await call("POST /api/trials/:id/arms", { params: { id: run.id }, body: { label, prompt, model } }))
      toast("只运行新加的这一列")
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title="加一种写法"
      footer={
        <div className="row" style={{ gap: 8, width: "100%" }}>
          {budget && <BudgetPill b={budget} need={need} />}
          <span className="spacer" />
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="play" loading={busy} disabled={!prompt.trim() || !model || need > left} onClick={go}>
            加入并运行
          </Button>
        </div>
      }
    >
      <div className="stack" style={{ gap: 16, padding: "4px 0" }}>
        <div className="tf">
          <div className="tf-l">名称</div>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="tf">
          <div className="tf-l">模型</div>
          <Select value={model} onChange={setModel} options={(budget?.models ?? []).map((m) => ({ value: m.id, label: m.label, hint: money(m.unitCost, budget!.currency) }))} />
        </div>
        <div className="tf">
          <div className="tf-l">
            提示词<span className="faint">基于「{base?.label}」</span>
          </div>
          <PromptEditor value={prompt} onChange={setPrompt} minRows={8} />
        </div>
        <div className="faint" style={{ fontSize: 13 }}>
          已有的 {run.arms.length} 列不会重跑，只生成这一列的 {run.cases.length} 个结果。
        </div>
      </div>
    </Drawer>
  )
}

export { markName, num }
