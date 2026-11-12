import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Opportunity, OpportunityState, Priority, Template, TemplateKind, TemplateMonitor, TemplateState } from "@spec/contract"
import { call } from "../../api/client"
import { errorText, useMonitor, useOpportunities, useTemplates, watchJob } from "../../api/next"
import { useCtx } from "../../lib/ctx"
import { lineName } from "../../lib/labels"
import { navigate } from "../../lib/route"
import { num, pct, time, weekShort } from "../../lib/format"
import { exportBundle, exportOne } from "../../lib/download"
import { Button, Checkbox, Input, Segmented, Tabs, cx } from "../../ui/controls"
import { Badge, Empty, ErrorState, Skel, Thumb } from "../../ui/display"
import { Spark } from "../../ui/charts"
import { Icon } from "../../ui/icons"
import { JobProgress } from "../../ui/insight"
import { ExportMenu } from "../../ui/export"
import { Menu, Tooltip, toast } from "../../ui/overlays"
import { TemplateDetail } from "./TemplateDetail"
import { kindName, priorityName, stateName, stateOrder } from "./names"

export const TemplatesPage = () => {
  const { line, week, route } = useCtx()
  const kind = route.kind
  const pane = route.pane
  const opps = useOpportunities(line, kind)
  const tpls = useTemplates(line, kind)
  const mon = useMonitor(line, kind)
  const drafts = (tpls.data ?? []).filter((t) => t.state !== "live" && t.state !== "retired")
  const openOpps = (opps.data ?? []).filter((o) => o.state === "open")
  if (route.tpl) return <TemplateDetail id={route.tpl} />
  const exportKind = kind === "official" ? "templates_official" : "templates_custom"
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>模板</h1>
          <div className="meta">
            <span>{lineName[line]}</span>
            <span className="faint">
              {openOpps.length} 个机会 · {drafts.length} 份草稿 · {(mon.data ?? []).length} 个已上线
            </span>
          </div>
        </div>
        <div className="actions">
          <Segmented value={kind} onChange={(v) => navigate({ kind: v, tpl: null }, { replace: true })} options={[{ value: "official", label: "官方", icon: "layers" }, { value: "custom", label: "定制", icon: "building" }]} />
          <ExportMenu
            items={[
              { key: "cfg", label: `${kindName[kind]}模板配置表`, hint: "全部草稿和已上线", run: () => exportOne(exportKind, { line }, `${kindName[kind]}模板_${lineName[line]}`) },
              { key: "opp", label: "模板机会", run: () => exportOne("opportunities", { line, kind, week: week ?? undefined }, `模板机会_${lineName[line]}`) },
              { key: "mon", label: "模板监控", run: () => exportOne("monitor", { line, kind }, `模板监控_${lineName[line]}`) },
            ]}
          />
          <NewTemplate kind={kind} />
        </div>
      </div>
      <Tabs
        value={pane}
        onChange={(v) => navigate({ pane: v }, { replace: true })}
        options={[
          { value: "opportunities" as const, label: "机会", count: openOpps.length },
          { value: "drafts" as const, label: "草稿", count: drafts.length },
          { value: "live" as const, label: "已上线", count: (mon.data ?? []).length },
        ]}
      />
      <div style={{ marginTop: 20 }}>
        {pane === "opportunities" ? <Opportunities q={opps} kind={kind} /> : pane === "drafts" ? <Drafts q={tpls} list={drafts} kind={kind} /> : <Live q={mon} kind={kind} />}
      </div>
    </div>
  )
}

const NewTemplate = ({ kind }: { kind: TemplateKind }) => {
  const { line } = useCtx()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await call("POST /api/templates", { body: { line, kind, write: false, content: { title: "新模板", prompt: "" } } })
      navigate({ tpl: r.template.id, pane: "drafts" })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="primary" icon="plus" loading={busy} onClick={go}>
      新建
    </Button>
  )
}

const OppSkeleton = () => (
  <div className="opp-grid">
    {Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="opp-card">
        <Skel w="60%" h={16} />
        <Skel h={13} />
        <Skel h={56} r={8} />
      </div>
    ))}
  </div>
)

const prio: Priority[] = ["high", "medium", "low"]

const Opportunities = ({ q, kind }: { q: ReturnType<typeof useOpportunities>; kind: TemplateKind }) => {
  const { line, week } = useCtx()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<OpportunityState>("open")
  const [busy, setBusy] = useState(false)
  const list = (q.data ?? []).filter((o) => o.state === filter)
  const refresh = async () => {
    if (!week) return
    setBusy(true)
    try {
      const j = await call("POST /api/templates/opportunities/refresh", { body: { line, week } })
      toast("正在重新分析模板机会")
      watchJob(j, (r) => {
        setBusy(false)
        toast(r.state === "done" ? "模板机会已更新" : `分析失败：${r.error?.message ?? ""}`, { tone: r.state === "done" ? "ok" : "error" })
        qc.invalidateQueries({ queryKey: ["GET /api/templates/opportunities"] })
      })
    } catch (e) {
      setBusy(false)
      toast(errorText(e), { tone: "error" })
    }
  }
  const counts = (s: OpportunityState) => (q.data ?? []).filter((o) => o.state === s).length
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 10 }}>
        <Segmented size="sm" value={filter} onChange={setFilter} options={(["open", "adopted", "shelved", "dismissed"] as OpportunityState[]).map((s) => ({ value: s, label: { open: "待处理", adopted: "已采纳", shelved: "搁置", dismissed: "忽略" }[s], count: counts(s) }))} />
        <span className="spacer" />
        {busy ? <JobProgress state="running" label="分析中" /> : <Button size="sm" variant="ghost" icon="refresh" onClick={refresh} disabled={!week}>重新分析{week ? ` ${weekShort(week)} 周` : ""}</Button>}
      </div>
      {q.isLoading ? (
        <OppSkeleton />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : list.length ? (
        <div className="opp-grid">
          {[...list].sort((a, b) => prio.indexOf(a.priority) - prio.indexOf(b.priority) || b.evidence.uses - a.evidence.uses).map((o) => (
            <OppCard key={o.id} o={o} />
          ))}
        </div>
      ) : (
        <Empty icon="sparkle" title={filter === "open" ? "暂时没有新的模板机会" : "没有"} text={filter === "open" ? (kind === "official" ? "重复使用且没有官方模板覆盖的写法会出现在这里" : "某家企业反复使用的写法会出现在这里") : undefined} action={filter === "open" ? <Button icon="refresh" loading={busy} onClick={refresh} disabled={!week}>分析本周</Button> : undefined} />
      )}
    </div>
  )
}

const OppCard = ({ o }: { o: Opportunity }) => {
  const { line } = useCtx()
  const qc = useQueryClient()
  const [writing, setWriting] = useState(false)
  const e = o.evidence
  const set = async (state: OpportunityState) => {
    try {
      await call("PATCH /api/templates/opportunities/:id", { params: { id: o.id }, body: { state } })
      qc.invalidateQueries({ queryKey: ["GET /api/templates/opportunities"] })
      toast(state === "shelved" ? "已搁置" : state === "dismissed" ? "已忽略" : "已恢复", { action: state !== "open" ? { label: "撤销", run: () => set("open") } : undefined })
    } catch (err) {
      toast(errorText(err), { tone: "error" })
    }
  }
  const adopt = async () => {
    setWriting(true)
    try {
      const r = await call("POST /api/templates", { body: { line, kind: o.kind, target: o.target?.id, opportunityId: o.id, clusterIds: o.clusterIds, write: true } })
      qc.invalidateQueries({ queryKey: ["GET /api/templates/opportunities"] })
      if (r.job)
        watchJob(r.job, (j) => {
          setWriting(false)
          if (j.state === "done") {
            toast("草稿已写好", { tone: "ok", action: { label: "打开", run: () => navigate({ tpl: r.template.id, pane: "drafts" }) } })
          } else toast(`撰写失败：${j.error?.message ?? ""}`, { tone: "error" })
        })
      else navigate({ tpl: r.template.id, pane: "drafts" })
    } catch (err) {
      setWriting(false)
      toast(errorText(err), { tone: "error" })
    }
  }
  const lift = e.downloadRate != null && e.peerDownloadRate != null ? e.downloadRate - e.peerDownloadRate : null
  return (
    <div className="opp-card">
      <div className="opp-h">
        <b>{o.title}</b>
        <span className={cx("opp-prio", o.priority)}>{priorityName[o.priority]}</span>
      </div>
      {e.officialCovered && <Badge tone="outline">已有官方覆盖</Badge>}
      {o.target && (
        <button className="opp-target" onClick={() => navigate({ ent: o.target!.id })}>
          <Icon name="building" size="xs" />
          {o.target.name}
        </button>
      )}
      <div className="opp-value">{o.value}</div>
      <div className="opp-ev">
        <div>
          <b className="num">{num(e.uses)}</b>
          <span>次使用</span>
        </div>
        <div>
          <b className="num">{e.enterprises}</b>
          <span>家 · {e.weeks} 周</span>
        </div>
        <div>
          <b className={cx("num", lift != null && (lift > 0 ? "up" : lift < 0 ? "down" : ""))}>{pct(e.downloadRate, 0)}</b>
          <span>下载率 · 同类 {pct(e.peerDownloadRate, 0)}</span>
        </div>
        <div>
          <b className={cx("num", e.retryShare != null && e.retryShare > 0.3 && "down")}>{pct(e.retryShare, 0)}</b>
          <span>重试</span>
        </div>
      </div>
      <div className="opp-reason">{o.reason}</div>
      {o.sampleTasks.length > 0 && (
        <div className="opp-samples">
          {o.sampleTasks.slice(0, 5).map((t) => (
            <Tooltip key={t.rowKey} content={<span style={{ maxWidth: 280, display: "block" }}>{t.prompt}</span>}>
              <span>
                <Thumb media={t.outputs[0] ?? t.inputs[0]} w={52} ratio={1} radius={6} dim={!t.downloaded} />
              </span>
            </Tooltip>
          ))}
        </div>
      )}
      <div className="opp-f">
        {o.state === "open" ? (
          writing ? (
            <JobProgress state="running" label="正在撰写草稿" />
          ) : (
            <>
              <Button size="sm" variant="primary" icon="wand" onClick={adopt}>
                采纳并撰写
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set("shelved")}>
                搁置
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set("dismissed")}>
                忽略
              </Button>
            </>
          )
        ) : o.draftId ? (
          <Button size="sm" icon="arrowRight" onClick={() => navigate({ tpl: o.draftId, pane: "drafts" })}>
            打开草稿
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => set("open")}>
            恢复
          </Button>
        )}
        <span className="spacer" />
        <span className="faint num" style={{ fontSize: 12 }}>
          {weekShort(o.week)} 周
        </span>
      </div>
    </div>
  )
}

const Drafts = ({ q, list, kind }: { q: ReturnType<typeof useTemplates>; list: Template[]; kind: TemplateKind }) => {
  const { line } = useCtx()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [state, setState] = useState<TemplateState | "all">("all")
  const [search, setSearch] = useState("")
  const shown = useMemo(() => list.filter((t) => (state === "all" || t.state === state) && (!search || `${t.current.content.title}${t.current.content.prompt}${t.target?.name ?? ""}`.includes(search))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), [list, state, search])
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })
  const exportKind = kind === "official" ? "templates_official" : "templates_custom"
  if (q.isLoading) return <Skel h={320} r={12} />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const on = shown.filter((t) => sel.has(t.id)).length
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        <Input icon="search" size="sm" quiet placeholder="标题、提示词或企业" value={search} onChange={(e) => setSearch(e.target.value)} onClear={() => setSearch("")} style={{ width: 220 }} />
        <Segmented size="sm" value={state} onChange={setState} options={[{ value: "all" as const, label: "全部", count: list.length }, ...(["draft", "tried", "exported"] as TemplateState[]).map((s) => ({ value: s, label: stateName[s], count: list.filter((t) => t.state === s).length }))]} />
        <span className="spacer" />
        {sel.size > 0 && (
          <Button size="sm" variant="primary" icon="download" onClick={() => exportOne(exportKind, { line, ids: [...sel].join(",") }, `${kindName[kind]}模板_${sel.size}个`)}>
            导出给运营 · {sel.size}
          </Button>
        )}
      </div>
      {shown.length ? (
        <div className="tpl-table">
          <div className="tpl-row head">
            <Checkbox checked={on > 0 && on === shown.length} mixed={on > 0 && on < shown.length} onChange={(v) => setSel(v ? new Set(shown.map((t) => t.id)) : new Set())} />
            <span>模板</span>
            {kind === "custom" && <span>企业</span>}
            <span>阶段</span>
            <span>检查</span>
            <span>试验</span>
            <span className="r">来源</span>
            <span className="r">更新</span>
          </div>
          {shown.map((t) => (
            <DraftRow key={t.id} t={t} on={sel.has(t.id)} toggle={() => toggle(t.id)} custom={kind === "custom"} />
          ))}
        </div>
      ) : (
        <Empty icon="template" title={list.length ? "没有符合条件的草稿" : "还没有草稿"} text={list.length ? undefined : "从机会采纳，或点右上角新建"} compact />
      )}
    </div>
  )
}

const DraftRow = ({ t, on, toggle, custom }: { t: Template; on: boolean; toggle: () => void; custom: boolean }) => {
  const c = t.current.content
  const warn = t.review.checks.filter((x) => !x.ok)
  const tr = t.review.trial
  return (
    <div className={cx("tpl-row", on && "on")} onClick={() => navigate({ tpl: t.id })}>
      <span onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={on} onChange={toggle} />
      </span>
      <div className="tpl-name">
        {t.cover ? <Thumb media={t.cover.output} w={40} ratio={1} radius={6} /> : <span className="tpl-ph"><Icon name="template" size="sm" /></span>}
        <div className="stack" style={{ minWidth: 0, gap: 2 }}>
          <b className="ellipsis">{c.title || <span className="faint">未命名</span>}</b>
          <span className="ellipsis faint">{c.prompt || "—"}</span>
        </div>
      </div>
      {custom && (
        <span className="ellipsis">
          {t.target ? (
            <button className="link-btn ellipsis" onClick={(e) => (e.stopPropagation(), navigate({ ent: t.target!.id }))}>
              {t.target.name}
            </button>
          ) : (
            <span className="faint">—</span>
          )}
        </span>
      )}
      <span>
        <span className={cx("tpl-state", t.state)}>{stateName[t.state]}</span>
      </span>
      <span>
        {warn.length ? (
          <Tooltip content={<div className="stack" style={{ gap: 4 }}>{warn.map((w) => <span key={w.key}>{w.message}</span>)}</div>}>
            <span className="tpl-warn">
              <Icon name="alert" size="xs" />
              {warn.length} 条提醒
            </span>
          </Tooltip>
        ) : (
          <span className="tpl-ok">
            <Icon name="check" size="xs" />
            通过
          </span>
        )}
      </span>
      <span>
        {tr ? (
          <span className="tpl-trial num">
            <span className="up">{tr.better}</span>
            <span className="faint">/</span>
            <span>{tr.same}</span>
            <span className="faint">/</span>
            <span className="down">{tr.worse}</span>
            <span className="faint">· {tr.cases} 例</span>
          </span>
        ) : (
          <span className="faint">未试验</span>
        )}
      </span>
      <span className="r num faint">{t.origin.uses ? `${num(t.origin.uses)} 次 · ${t.origin.enterprises} 家` : "—"}</span>
      <span className="r num faint">{time(t.updatedAt)}</span>
    </div>
  )
}

const Live = ({ q, kind }: { q: ReturnType<typeof useMonitor>; kind: TemplateKind }) => {
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <Skel h={320} r={12} />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const list = q.data ?? []
  if (!list.length) return <Empty icon="chart" title="还没有上线的模板" text="草稿导出给运营上线后，把阶段推进到已上线并回填 FD 模板 ID" compact />
  return (
    <div className="tpl-table">
      <div className="tpl-row head live">
        <span>模板</span>
        {kind === "custom" ? <span>企业</span> : <span>上线</span>}
        <span>每周使用</span>
        <span className="r">本周</span>
        <span className="r">企业</span>
        <span className="r">下载率 · 原写法</span>
        <span>FD 模板 ID</span>
      </div>
      {list.map((m) => (
        <LiveRow key={m.templateId} m={m} open={open === m.templateId} onToggle={() => setOpen(open === m.templateId ? null : m.templateId)} custom={kind === "custom"} />
      ))}
    </div>
  )
}

const LiveRow = ({ m, open, onToggle, custom }: { m: TemplateMonitor; open: boolean; onToggle: () => void; custom: boolean }) => {
  const qc = useQueryClient()
  const last = m.weekly[m.weekly.length - 1]
  const [fd, setFd] = useState(m.fdTemplateId ? String(m.fdTemplateId) : "")
  const saveFd = async () => {
    const v = fd.trim() ? Number(fd.trim()) : null
    if (v === m.fdTemplateId || (v != null && !Number.isFinite(v))) return
    try {
      await call("PATCH /api/templates/:id", { params: { id: m.templateId }, body: { fdTemplateId: v } })
      qc.invalidateQueries({ queryKey: ["GET /api/templates/monitor"] })
      toast("已保存", { tone: "ok", ms: 1200 })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  const d = last?.downloadRate != null && m.baseline?.downloadRate != null ? last.downloadRate - m.baseline.downloadRate : null
  const te = m.targetEffect
  return (
    <>
      <div className={cx("tpl-row live", open && "on")} onClick={custom && te ? onToggle : () => navigate({ tpl: m.templateId })}>
        <div className="tpl-name">
          <div className="stack" style={{ minWidth: 0, gap: 2 }}>
            <b className="ellipsis">{m.title}</b>
            <span className="faint num">
              {m.revisions.length > 1 ? `改过 ${m.revisions.length - 1} 次` : "未改过"}
              {m.estimated && <Badge tone="outline">估算</Badge>}
            </span>
          </div>
        </div>
        <span className="ellipsis">{custom ? m.target?.name ?? "—" : m.liveAt ? time(m.liveAt).split(" ")[0] : "—"}</span>
        <span>
          <Spark values={m.weekly.map((w) => w.uses)} w={88} />
        </span>
        <span className="r num">{num(last?.uses ?? 0)}</span>
        <span className="r num">{last?.enterprises ?? 0}</span>
        <span className="r num">
          {pct(last?.downloadRate ?? null, 0)}
          <span className="faint"> · {pct(m.baseline?.downloadRate ?? null, 0)}</span>
          {d != null && <span className={cx(d > 0 ? "up" : d < 0 ? "down" : "faint")} style={{ marginLeft: 6 }}>{d > 0 ? "+" : ""}{Math.round(d * 100)}pt</span>}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <Input size="sm" value={fd} placeholder="回填" onChange={(e) => setFd(e.target.value.replace(/[^\d]/g, ""))} onBlur={saveFd} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} style={{ width: 96 }} />
        </span>
      </div>
      {open && te && (
        <div className="tpl-effect">
          <EffectPair label="重试占比" before={te.retryShare.before} after={te.retryShare.after} good="down" />
          <EffectPair label="下载率" before={te.downloadRate.before} after={te.downloadRate.after} good="up" />
          <Button size="sm" variant="ghost" iconRight="chevRight" onClick={() => navigate({ tpl: m.templateId })}>
            模板详情
          </Button>
        </div>
      )}
    </>
  )
}

const EffectPair = ({ label, before, after, good }: { label: string; before: number | null; after: number | null; good: "up" | "down" }) => {
  const d = before != null && after != null ? after - before : null
  const tone = d == null || d === 0 ? "" : (d > 0) === (good === "up") ? "up" : "down"
  return (
    <div className="eff">
      <span className="faint">{label}</span>
      <span className="num">
        {pct(before, 0)} → <b className={tone}>{pct(after, 0)}</b>
      </span>
    </div>
  )
}

export { stateOrder, Menu, exportBundle }
