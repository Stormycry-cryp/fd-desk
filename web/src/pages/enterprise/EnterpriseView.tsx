import { useEffect, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Alert, ContractState, EnterpriseDetail, EnterpriseKind, Line, LineDetail, SampleReason, Task } from "@spec/contract"
import { useChains, useEnterprise, useTasks, useCall, usePutNextAction } from "../../api/hooks"
import { useCtx } from "../../lib/ctx"
import { alertName, contractName, failureName, kindName, lineName, offerName, patternName, poolAction, poolName, sampleReasonName, slotName } from "../../lib/labels"
import { navigate } from "../../lib/route"
import { ago, compact, num, pct, time, weekLabel, weekShort } from "../../lib/format"
import { Button, IconButton, Segmented, TextArea } from "../../ui/controls"
import { Avatar, Badge, Empty, ErrorState, InlineEdit, LevelTag, Phone, Rate, Sev, Skel, SourceTag, Stat, Thumb, Delta } from "../../ui/display"
import { StackBar, TrendChart } from "../../ui/charts"
import { Icon } from "../../ui/icons"
import { Drawer, Menu, Select, Tooltip, toast } from "../../ui/overlays"
import { MovementTag, PoolTag, StatusTag } from "../bits"
import { TaskCard } from "./TaskCard"
import { TaskViewer } from "./TaskViewer"

export const EnterpriseDrawer = ({ id }: { id: string }) => {
  const [open, setOpen] = useState(true)
  useEffect(() => setOpen(true), [id])
  const close = () => {
    setOpen(false)
    setTimeout(() => navigate({ ent: null }, { replace: true }), 160)
  }
  return (
    <Drawer
      open={open}
      onClose={close}
      width={720}
      title={<span className="faint" style={{ fontWeight: 500, fontSize: 12.5 }}>企业</span>}
      actions={
        <>
          <Tooltip content="上一家 / 下一家">
            <span className="row" style={{ gap: 2, color: "var(--ink-4)", fontSize: 11.5, marginRight: 6 }}>
              <kbd className="kbd">J</kbd>
              <kbd className="kbd">K</kbd>
            </span>
          </Tooltip>
          <IconButton icon="expand" label="整页打开" onClick={() => navigate({ page: "enterprise", ent: id })} />
        </>
      }
    >
      <EnterpriseView id={id} />
    </Drawer>
  )
}

const sampleOrder: SampleReason[] = ["stuck", "not_downloaded", "batch", "downloaded", "failed"]

export const EnterpriseView = ({ id, page }: { id: string; page?: boolean }) => {
  const { line: ctxLine, week } = useCtx()
  const q = useEnterprise(id, week)
  const d = q.data
  const available = d ? (["inspiration", "video"] as Line[]).filter((l) => d.lines[l]) : []
  const [line, setLine] = useState<Line>(ctxLine)
  useEffect(() => {
    if (d && !d.lines[line] && available.length) setLine(available[0])
  }, [d, line])
  useEffect(() => setLine(ctxLine), [ctxLine, id])
  if (q.isLoading) return <EntSkeleton />
  if (q.error || !d) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const ld = d.lines[line]
  return (
    <div className="ent" key={id}>
      <Header d={d} week={week!} page={page} />
      {available.length > 1 && (
        <div style={{ padding: "16px 24px 0" }}>
          <Segmented value={line} onChange={setLine} options={available.map((l) => ({ value: l, label: lineName[l] }))} />
        </div>
      )}
      {ld ? <LineBody d={d} ld={ld} week={week!} /> : <Empty icon="layers" title={`没有用过${lineName[line]}`} text="可以放进转化池，用这条线把他最近的任务做一遍" />}
      <Members ld={ld} />
      <AlertsTouches d={d} />
      <Notes d={d} />
    </div>
  )
}

const Header = ({ d, week, page }: { d: EnterpriseDetail; week: string; page?: boolean }) => {
  const qc = useQueryClient()
  const patch = useCall("PATCH /api/enterprises/:id", ["GET /api/enterprises", "GET /api/enterprises/:id", "GET /api/meta", "GET /api/overview"])
  const save = (body: Parameters<typeof patch.mutate>[0]["body"], msg: string) =>
    patch.mutate(
      { params: { id: d.enterprise.id }, body, query: { week } } as any,
      {
        onSuccess: () => toast(msg, { tone: "ok", ms: 1800 }),
        onError: (e: any) => toast(e?.missing ? "后端尚未支持修改" : `保存失败：${e.message}`, { tone: "error" }),
      },
    )
  void qc
  const lines = (["inspiration", "video"] as Line[]).filter((l) => d.lines[l])
  return (
    <div className="ent-head">
      <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <Avatar name={d.enterprise.name} size={44} square />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{d.enterprise.name}</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <Select
              size="sm"
              ghost
              value={d.enterprise.kind}
              onChange={(v) => save({ kind: v as EnterpriseKind }, `已标为${kindName[v as EnterpriseKind]}`)}
              options={(["customer", "internal", "agency", "unknown"] as EnterpriseKind[]).map((k) => ({ value: k, label: kindName[k], hint: k === "internal" ? "会自动加入排除列表" : undefined }))}
              popWidth={200}
            />
            <Select size="sm" ghost value={d.contract} onChange={(v) => save({ contract: v as ContractState }, "已更新签约状态")} options={(Object.keys(contractName) as ContractState[]).map((k) => ({ value: k, label: contractName[k] }))} popWidth={160} />
            {lines.map((l) => (
              <span key={l} className="row" style={{ gap: 6, fontSize: 12.5, color: "var(--ink-3)", marginLeft: 4 }}>
                <span className="faint">{lineName[l]}</span>
                <LevelTag level={d.lines[l]!.level} empty="—" />
              </span>
            ))}
          </div>
        </div>
        {page && (
          <Button size="sm" icon="send" onClick={() => navigate({ page: "touches" })}>
            触达
          </Button>
        )}
      </div>
      <div className="meta">
        <span>
          <Icon name="phone" size="xs" />
          <Phone value={d.adminPhone} />
        </span>
        <span>
          <Icon name="user" size="xs" />
          销售 {d.owner.sales ?? <span className="faint">未分配</span>}
          {d.owner.afterSales && <span className="faint">· 售后 {d.owner.afterSales}</span>}
        </span>
        <span>
          <Icon name="clock" size="xs" />
          最近使用 {ago(d.lastActiveAt)}
        </span>
        <span className="faint">首次 {weekShort(d.firstSeenAt)}</span>
      </div>
      <div className="note-box" style={{ marginTop: 16 }}>
        <div className="k">
          小结
          <SourceTag a={d.summary} />
        </div>
        <InlineEdit value={d.summary?.text ?? ""} placeholder="一句话说清他在做什么、卡在哪" saving={patch.isPending} onSave={(v) => save({ summary: v, source: "manual" }, "小结已保存")} />
      </div>
    </div>
  )
}

const LineBody = ({ d, ld, week }: { d: EnterpriseDetail; ld: LineDetail; week: string }) => {
  const insp = ld.line === "inspiration"
  const put = usePutNextAction(ld.line, week)
  const hist = ld.history
  const first = hist.findIndex((h) => h.tasks > 0)
  const shown = hist.slice(Math.max(0, Math.min(first < 0 ? hist.length - 4 : first, hist.length - 4)))
  const pts = shown.map((h) => ({ label: weekShort(h.week), value: insp ? h.tasks : h.points, partial: !h.complete, note: `${h.activeDays} 天 · 下载 ${pct(h.downloadRate)}` }))
  const cur = hist[hist.length - 1]
  const prev = hist[hist.length - 2]
  return (
    <>
      <div className="ent-section" style={{ borderTop: 0 }}>
        <div className="kpis">
          <Stat size="sm" label={insp ? "任务" : "耗点"} value={insp ? num(ld.tasks) : compact(ld.points)} delta={prev && prev.complete && cur.complete && (prev.tasks || prev.points) ? <Delta current={insp ? cur.tasks : cur.points} previous={insp ? prev.tasks : prev.points} /> : undefined} foot={<span>{ld.activeDays} 天</span>} />
          <Stat size="sm" label="下载率" value={pct(ld.downloadRate, 1)} foot={!ld.downloadSignalReliable ? <Badge tone="warn">信号存疑</Badge> : <Rate value={ld.downloadRate} width={60} />} />
          <Stat size="sm" label="变动" value={<MovementTag m={ld.movement} />} foot={<span>{weekLabel(week)}</span>} />
          <Stat size="sm" label="池" value={<PoolTag p={ld.pool} />} foot={ld.pool ? <span>{poolAction[ld.pool]}</span> : null} />
        </div>
        <div className="note-box" style={{ marginTop: 16, background: "var(--accent-weak)", boxShadow: "inset 0 0 0 1px var(--accent-weak-2)" }}>
          <div className="k" style={{ color: "var(--accent-ink)" }}>
            <Icon name="target" size="xs" />
            下一步
            <SourceTag a={ld.nextAction} />
          </div>
          <InlineEdit
            value={ld.nextAction?.text ?? ""}
            placeholder="写下这周要带给他的东西"
            saving={put.isPending}
            onSave={(text) =>
              put.mutate(
                { id: d.enterprise.id, text },
                { onSuccess: () => toast("已保存", { tone: "ok", ms: 1600 }), onError: (e: any) => toast(e?.missing ? "后端尚未支持保存" : e?.code === "manual_locked" ? "已有手工内容" : `保存失败：${e.message}`, { tone: "error" }) },
              )
            }
          />
        </div>
      </div>
      <div className="ent-section">
        <h4>
          {insp ? "每周任务" : "每周耗点"}
          <span className="sub">近 {shown.length} 周</span>
        </h4>
        <TrendChart points={pts} height={150} kind="bar" highlight={pts.length - 1} format={(v) => compact(v)} />
      </div>
      <div className="ent-section">
        <h4>
          在做什么
          <span className="sub">竖线是同类企业的中位下载率</span>
        </h4>
        {ld.breakdown.length ? (
          <table className="table compact">
            <thead>
              <tr>
                <th>{insp ? "任务类型" : "模式"}</th>
                <th className="r">任务</th>
                <th className="r">占比</th>
                <th>下载率</th>
                <th className="r">与同类</th>
                <th>主要模型</th>
              </tr>
            </thead>
            <tbody>
              {ld.breakdown.map((b) => {
                const gap = b.downloadRate != null && b.peerMedianDownloadRate != null ? b.downloadRate - b.peerMedianDownloadRate : null
                return (
                  <tr key={b.key}>
                    <td>{b.key}</td>
                    <td className="r num">{num(b.tasks)}</td>
                    <td className="r num faint">{pct(b.share)}</td>
                    <td>
                      <Tooltip content={<span className="num">同类中位 {pct(b.peerMedianDownloadRate)} · {b.peerEnterprises} 家</span>}>
                        <span>
                          <Rate value={b.downloadRate} mark={b.peerMedianDownloadRate} width={64} />
                        </span>
                      </Tooltip>
                    </td>
                    <td className="r num">{gap == null ? <span className="faint">—</span> : <span className={gap < -0.1 ? "down" : gap > 0.1 ? "up" : "faint"}>{gap > 0 ? "+" : "−"}{Math.abs(Math.round(gap * 100))}pt</span>}</td>
                    <td className="faint ellipsis" style={{ maxWidth: 160 }}>{b.mainModel ?? "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <span className="faint">本周没有任务</span>
        )}
        {insp && ld.patterns.length > 0 && <Patterns ld={ld} />}
        {!insp && ld.failures.length > 0 && (
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <span className="faint" style={{ fontSize: 12 }}>失败</span>
            {ld.failures.map((f) => (
              <Badge key={f.category} tone={f.category === "material" ? "down" : undefined}>
                {failureName[f.category]} {f.count}
              </Badge>
            ))}
          </div>
        )}
        {ld.models.length > 1 && (
          <div className="row" style={{ gap: 14, marginTop: 14, fontSize: 12.5, color: "var(--ink-3)", flexWrap: "wrap" }}>
            <span className="faint" style={{ fontSize: 12 }}>模型</span>
            {ld.models.slice(0, 4).map((m) => (
              <span key={m.model} className="row" style={{ gap: 6 }}>
                <span style={{ color: "var(--ink-2)" }}>{m.model}</span>
                <span className="num">{num(m.tasks)}</span>
                <span className="num faint">{pct(m.downloadRate)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <Chains id={d.enterprise.id} line={ld.line} week={week} />
      <Samples id={d.enterprise.id} line={ld.line} week={week} />
    </>
  )
}

const patternColor: Record<string, string> = { batch: "var(--accent-weak-2)", retry: "#f8d9d6", tweak: "var(--down-weak)", adapt: "#e9e7fb", rework: "#efede8", new: "rgba(24,24,27,.05)", agent: "#e7f1ec" }

const Patterns = ({ ld }: { ld: LineDetail }) => {
  const total = ld.patterns.reduce((s, p) => s + p.tasks, 0) || 1
  return (
    <div style={{ marginTop: 18 }}>
      <StackBar height={24} segments={ld.patterns.map((p) => ({ key: p.pattern, value: p.tasks, color: patternColor[p.pattern] ?? "#eee", label: patternName[p.pattern], title: `${patternName[p.pattern]} ${pct(p.tasks / total)} · 下载 ${pct(p.downloadRate)}` }))} />
      <div className="mini-legend">
        {ld.patterns.map((p) => (
          <span key={p.pattern}>
            <i style={{ background: patternColor[p.pattern] }} />
            {patternName[p.pattern]} <b>{pct(p.tasks / total)}</b>
            <span className="faint num">下载 {pct(p.downloadRate)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

const Chains = ({ id, line, week }: { id: string; line: Line; week: string }) => {
  const q = useChains({ line, week, enterprise: id, minLength: 3, downloaded: false })
  const [view, setView] = useState<{ tasks: Task[]; i: number } | null>(null)
  const items = q.data?.items ?? []
  if (q.error && (q.error as any).missing) return null
  return (
    <div className="ent-section">
      <h4>
        没出来的连续尝试
        <span className="sub">同一张图连续 3 次以上，没有下载</span>
        <span className="spacer" />
        {q.data && <span className="faint num">{q.data.total} 条</span>}
      </h4>
      {q.isLoading ? (
        <Skel h={64} />
      ) : items.length ? (
        <div>
          {items.slice(0, 4).map((c) => (
            <div key={c.id} className="chain">
              <div className="meta">
                <span style={{ color: "var(--ink-2)" }}>{c.user?.name ?? "—"}</span>
                <span className="num">
                  {time(c.startedAt)} · {c.length} 次
                </span>
                <span className="num">{c.points} 点</span>
              </div>
              <div className="steps">
                {c.tasks.slice(0, 7).map((t, i) => (
                  <span key={t.rowKey} className="row" style={{ gap: 4 }}>
                    {i > 0 && <Icon name="chevRight" size="xs" className="sep" />}
                    <Tooltip content={<span style={{ display: "block", maxWidth: 260 }}>{t.prompt}</span>}>
                      <span>
                        <Thumb media={t.outputs[0] ?? t.inputs[0]} w={52} ratio={4 / 3} onClick={() => setView({ tasks: c.tasks, i })} dim={!t.outputs[0]} />
                      </span>
                    </Tooltip>
                  </span>
                ))}
                {c.tasks.length > 7 && <span className="faint" style={{ fontSize: 12, marginLeft: 4 }}>+{c.tasks.length - 7}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <span className="faint">没有</span>
      )}
      <TaskViewer tasks={view?.tasks ?? []} index={view?.i ?? null} onClose={() => setView(null)} />
    </div>
  )
}

const Samples = ({ id, line, week }: { id: string; line: Line; week: string }) => {
  const [reason, setReason] = useState<SampleReason | "all">("all")
  const q = useTasks({ line, week, enterprise: id, sample: 6 })
  const [view, setView] = useState<number | null>(null)
  const items = q.data?.items ?? []
  const counts = useMemo(() => {
    const m = new Map<SampleReason, number>()
    items.forEach((t) => t.sampleReason && m.set(t.sampleReason, (m.get(t.sampleReason) ?? 0) + 1))
    return m
  }, [items])
  const shown = reason === "all" ? items : items.filter((t) => t.sampleReason === reason)
  return (
    <div className="ent-section">
      <h4>
        任务抽样
        <span className="sub">{q.data ? `本周 ${num(q.data.total)} 个任务中按情况抽取` : ""}</span>
      </h4>
      <div style={{ marginBottom: 14 }}>
        <Segmented
          size="sm"
          value={reason}
          onChange={setReason}
          options={[{ value: "all" as const, label: "全部", count: items.length }, ...sampleOrder.filter((r) => counts.get(r)).map((r) => ({ value: r, label: sampleReasonName[r], count: counts.get(r) }))]}
        />
      </div>
      {q.isLoading ? (
        <div className="task-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="stack" style={{ gap: 8 }}>
              <Skel h={112} r={8} />
              <Skel h={12} />
              <Skel w="60%" h={12} />
            </div>
          ))}
        </div>
      ) : shown.length ? (
        <div className="task-grid">
          {shown.map((t) => (
            <TaskCard key={t.rowKey} t={t} onOpen={() => setView(shown.indexOf(t))} />
          ))}
        </div>
      ) : (
        <span className="faint">没有任务</span>
      )}
      <TaskViewer tasks={shown} index={view} onClose={() => setView(null)} />
    </div>
  )
}

const Members = ({ ld }: { ld: LineDetail | null }) => {
  if (!ld || !ld.members.length) return null
  const max = Math.max(1, ...ld.members.map((m) => m.tasks))
  return (
    <div className="ent-section">
      <h4>
        成员
        <span className="sub">{ld.members.length} 人</span>
      </h4>
      <table className="table compact">
        <tbody>
          {ld.members.map((m) => (
            <tr key={m.id}>
              <td style={{ width: "34%" }}>
                <span className="row" style={{ gap: 8 }}>
                  <Avatar name={m.name} size={22} />
                  <span className="ellipsis">{m.name}</span>
                </span>
              </td>
              <td>
                <Phone value={m.phone} />
              </td>
              <td style={{ width: 140 }}>
                <span className="row" style={{ gap: 8 }}>
                  <span style={{ flex: 1, height: 4, borderRadius: 4, background: "rgba(24,24,27,.06)", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${(m.tasks / max) * 100}%`, background: "var(--accent-3)" }} />
                  </span>
                  <span className="num" style={{ minWidth: 34, textAlign: "right" }}>{num(m.tasks)}</span>
                </span>
              </td>
              <td className="r num faint">{pct(m.downloadRate)}</td>
              <td className="r faint">{ago(m.lastActiveAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const AlertsTouches = ({ d }: { d: EnterpriseDetail }) => {
  const open = d.alerts.filter((a: Alert) => !a.dismissed)
  if (!open.length && !d.touches.length) return null
  return (
    <div className="ent-section">
      {open.length > 0 && (
        <>
          <h4>预警</h4>
          <div className="stack" style={{ gap: 8, marginBottom: d.touches.length ? 20 : 0 }}>
            {open.map((a) => (
              <div key={a.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
                <span style={{ paddingTop: 6 }}>
                  <Sev s={a.severity} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b style={{ fontWeight: 500 }}>{alertName[a.kind]}</b>
                    <span className="faint" style={{ fontSize: 12 }}>{lineName[a.line]}</span>
                    {a.suggestedPool && <PoolTag p={a.suggestedPool} />}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{a.facts.join("；")}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {d.touches.length > 0 && (
        <>
          <h4>触达记录</h4>
          <div className="stack" style={{ gap: 2 }}>
            {d.touches.map((t) => (
              <div key={t.id} className="row" style={{ gap: 10, minHeight: 34 }}>
                <span className="num faint" style={{ width: 84, fontSize: 12 }}>{weekShort(t.week)} {slotName[t.slot]}</span>
                <PoolTag p={t.goal} />
                <span className="ellipsis" style={{ flex: 1 }}>{t.offer.text ?? offerName[t.offer.kind]}</span>
                {t.outcome && <Delta pair={t.outcome.tasks} />}
                <StatusTag s={t.status} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const Notes = ({ d }: { d: EnterpriseDetail }) => {
  const [text, setText] = useState("")
  const add = useCall("POST /api/enterprises/:id/notes", ["GET /api/enterprises/:id"])
  const del = useCall("DELETE /api/notes/:id", ["GET /api/enterprises/:id"])
  const submit = () => {
    if (!text.trim()) return
    add.mutate({ params: { id: d.enterprise.id }, body: { text: text.trim() } }, { onSuccess: () => setText(""), onError: (e: any) => toast(e?.missing ? "后端尚未支持备注" : e.message, { tone: "error" }) })
  }
  return (
    <div className="ent-section" style={{ paddingBottom: 32 }}>
      <h4>备注</h4>
      <div className="stack" style={{ gap: 8 }}>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder="记录沟通内容，⌘↵ 保存" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()} style={{ minHeight: 56 }} />
        {text && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button size="sm" variant="primary" loading={add.isPending} onClick={submit}>
              添加
            </Button>
          </div>
        )}
        {d.notes.map((n) => (
          <div key={n.id} className="row" style={{ alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-2)" }}>
            <div style={{ flex: 1, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{n.text}</div>
            <span className="faint num" style={{ fontSize: 12 }}>{time(n.createdAt)}</span>
            <Menu items={[{ key: "del", label: "删除", icon: "trash", danger: true, onSelect: () => del.mutate({ params: { id: n.id } }) }]} trigger={({ toggle, ref }) => <IconButton ref={ref as any} size="xs" icon="more" label="更多" onClick={toggle} />} width={140} />
          </div>
        ))}
      </div>
    </div>
  )
}

const EntSkeleton = () => (
  <div style={{ padding: 24 }}>
    <div className="row" style={{ gap: 14 }}>
      <Skel w={44} h={44} r={12} />
      <div className="stack" style={{ gap: 8, flex: 1 }}>
        <Skel w="60%" h={18} />
        <Skel w="40%" h={12} />
      </div>
    </div>
    <Skel h={64} r={12} style={{ marginTop: 20 }} />
    <div className="kpis" style={{ marginTop: 24 }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="stack" style={{ gap: 8 }}>
          <Skel w={50} h={12} />
          <Skel w={70} h={20} />
        </div>
      ))}
    </div>
    <Skel h={150} style={{ marginTop: 28 }} />
    <Skel h={120} style={{ marginTop: 24 }} />
  </div>
)

export { poolName }
