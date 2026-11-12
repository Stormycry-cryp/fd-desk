import { useEffect, useState } from "react"
import type { Annotation, Profile, Scope } from "@spec/contract"
import { useAnnotations, useProfile, useSetHeadline, useSetTag } from "../../api/next"
import { useSectionFocus } from "../../lib/locate"
import { AnnotationRail, AnnotationScope, AnnotationTimeline, Annotatable, ComposerPopover } from "../../ui/annotate"
import { TagPicker } from "../../ui/insight"
import { ProfileTab } from "./Profile"
import type { Alert, EnterpriseDetail, Line, LineDetail } from "@spec/contract"
import { useDaily, useEnterprise, usePutNextAction } from "../../api/hooks"
import { useCtx } from "../../lib/ctx"
import { alertName, failureName, lineName, offerName, patternName, poolAction, poolName, slotName } from "../../lib/labels"
import { navigate, type EntTab } from "../../lib/route"
import { ago, compact, num, pct, weekLabel, weekShort } from "../../lib/format"
import { Button, IconButton, Segmented, Tabs } from "../../ui/controls"
import { Avatar, Badge, Empty, ErrorState, InlineEdit, LevelTag, Phone, Rate, Sev, Skel, SourceTag, Stat, Delta } from "../../ui/display"
import { Heatmap, StackBar, TrendChart } from "../../ui/charts"
import { Icon } from "../../ui/icons"
import { Drawer, Menu, Tooltip, toast } from "../../ui/overlays"
import { MovementTag, PoolTag, StatusTag } from "../bits"
import { useQueryClient } from "@tanstack/react-query"
import type { Owner } from "@spec/contract"
import { call } from "../../api/client"
import { accountOf, ownerOf } from "../../lib/accounts"
import { AccountStrip } from "../../ui/points"

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
      title={<span className="faint" style={{ fontWeight: 500, fontSize: 13.5 }}>企业</span>}
      actions={
        <>
          <Tooltip content="上一家 / 下一家">
            <span className="row" style={{ gap: 2, color: "var(--ink-4)", fontSize: 12.5, marginRight: 6 }}>
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

const NO_ANN: Annotation[] = []


export const EnterpriseView = ({ id, page }: { id: string; page?: boolean }) => {
  const { line: ctxLine, week, route } = useCtx()
  const q = useEnterprise(id, week)
  const pq = useProfile(id)
  const anns = useAnnotations(id)
  useSectionFocus()
  const d = q.data
  const prof = pq.data
  const available = d ? (["inspiration", "video"] as Line[]).filter((l) => d.lines[l]) : []
  const scope: Scope = route.scope ?? "all"
  const tab = route.tab
  const dataLine: Line = scope !== "all" && available.includes(scope) ? scope : available.includes(ctxLine) ? ctxLine : available[0] ?? ctxLine
  if (q.isLoading) return <EntSkeleton />
  if (q.error || !d) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const ld = d.lines[dataLine]
  const list = anns.data ?? prof?.annotations ?? NO_ANN
  const openCount = list.filter((a) => !a.resolved).length
  const setTab = (t: EntTab) => (t === "tasks" ? navigate({ page: "cases", ents: [d.enterprise.id], line: dataLine, ent: null }) : navigate({ tab: t }, { replace: true }))
  const setScope = (s: Scope) => navigate({ scope: s === "all" ? null : s }, { replace: true })
  const none = <Empty icon="layers" title={`没有用过${lineName[dataLine]}`} />
  const body =
    tab === "profile" ? (
      prof ? <ProfileTab p={prof} scope={scope} /> : pq.error ? <div style={{ padding: 24 }}><ErrorState error={pq.error} retry={() => pq.refetch()} /></div> : <EntSkeleton />
    ) : tab === "data" ? (
      ld ? <LineBody d={d} ld={ld} week={week!} /> : none
    ) : tab === "tasks" ? (
      <div style={{ padding: "40px 24px" }}>
        <Empty icon="layers" title="记录在「记录」页" action={<Button variant="primary" icon="arrowRight" onClick={() => navigate({ page: "cases", ents: [d.enterprise.id], line: dataLine, ent: null })}>打开这家企业的记录</Button>} />
      </div>
    ) : (
      <div style={{ padding: "20px 24px 32px" }}>{anns.error && !prof ? <ErrorState error={anns.error} /> : <AnnotationTimeline list={list} />}</div>
    )
  return (
    <AnnotationScope enterprise={id} list={list} mode={page ? "rail" : "inline"}>
      <div className="ent" key={id}>
        <Top d={d} p={prof ?? null} page={page} missing={!!pq.error} />
        <div className="ent-tabs-wrap">
          <div className="ent-tabs">
            <Tabs
              value={tab}
              onChange={setTab}
              options={[
                { value: "profile" as EntTab, label: "档案" },
                { value: "data" as EntTab, label: "数据" },
                { value: "tasks" as EntTab, label: <span className="row" style={{ gap: 4 }}>记录<Icon name="arrowUpRight" size="xs" /></span> },
                { value: "notes" as EntTab, label: "批注", count: openCount || undefined },
              ]}
            />
            {tab !== "notes" && available.length > 0 && (
              <Segmented
                size="sm"
                value={tab === "profile" ? scope : dataLine}
                onChange={(v) => setScope(v as Scope)}
                options={[...(tab === "profile" ? [{ value: "all", label: "全部" }] : []), ...available.map((l) => ({ value: l, label: lineName[l] }))]}
              />
            )}
          </div>
        </div>
        {page && tab === "profile" ? (
          <div className="ent-full">
            <div style={{ minWidth: 0 }}>{body}</div>
            <div className="ann-col">
              <AnnotationRail />
            </div>
          </div>
        ) : (
          body
        )}
        <ComposerPopover />
      </div>
    </AnnotationScope>
  )
}

const useSaveOwner = (id: string) => {
  const qc = useQueryClient()
  return async (owner: Owner) => {
    try {
      await call("PATCH /api/enterprises/:id", { params: { id }, body: { owner } })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises/:id"] })
      qc.invalidateQueries({ queryKey: ["GET /api/enterprises"] })
      qc.invalidateQueries({ queryKey: ["GET /api/owners"] })
      toast("已保存负责人", { tone: "ok" })
    } catch (e) {
      toast((e as Error).message, { tone: "error" })
    }
  }
}

const Top = ({ d, p, page, missing }: { d: EnterpriseDetail; p: Profile | null; page?: boolean; missing?: boolean }) => {
  const saveOwner = useSaveOwner(d.enterprise.id)
  const setTag = useSetTag(d.enterprise.id)
  const setHeadline = useSetHeadline(d.enterprise.id)
  const lines = (["inspiration", "video"] as Line[]).filter((l) => d.lines[l])
  return (
    <div className="ent-top">
      <div className="name-row">
        <Avatar name={d.enterprise.name} size={44} square />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{d.enterprise.name}</div>
          {!missing && <Annotatable block="headline" label="一句话" className="ent-headline">
            {p?.headline ? (
              <div className="headline" data-quote-block="headline">
                <InlineEdit value={p.headline.text} multiline={false} onSave={(v) => setHeadline.mutate(v)} />
              </div>
            ) : (
              <div className="headline faint">{p ? (p.state === "facts_only" ? "任务不足 20 个，暂不生成档案判断" : "档案生成后显示一句话概括") : <span className="skel" style={{ display: "inline-block", width: 280, height: 14 }} />}</div>
            )}
          </Annotatable>}
        </div>
        {page && <ExportButton id={d.enterprise.id} />}
      </div>
      {!missing && <div className="tags">{p ? <TagPicker tags={p.tags} onChange={(dim, v) => setTag.mutate({ dimension: dim, value: v })} /> : <Skel w={360} h={28} />}</div>}
      <div className="meta">
        <span>
          <Icon name="phone" size="xs" />
          <Phone value={d.adminPhone} />
        </span>
        {lines.map((l) => (
          <span key={l}>
            <span className="faint">{lineName[l]}</span>
            <LevelTag level={d.lines[l]!.level} empty="—" />
          </span>
        ))}
        <span>
          <Icon name="clock" size="xs" />
          最近使用 {ago(d.lastActiveAt)}
        </span>
        <span className="faint">首次 {weekShort(d.firstSeenAt)}</span>
      </div>
      <AccountStrip a={accountOf(d)} owner={ownerOf(d)} onOwner={saveOwner} />
    </div>
  )
}

const ExportButton = ({ id }: { id: string }) => (
  <Menu
    width={200}
    items={[
      { key: "print", label: "打印档案", icon: "printer", onSelect: () => window.open(`/print/profiles?ids=${id}`, "_blank", "noopener") },
      { key: "notes", label: "导出批注", icon: "download", onSelect: () => window.open(`/api/export/annotations?enterprise=${id}`, "_blank", "noopener") },
    ]}
    trigger={({ toggle, ref }) => (
      <Button ref={ref as never} size="sm" icon="download" iconRight="chevDown" onClick={toggle}>
        导出
      </Button>
    )}
  />
)

const LineBody = ({ d, ld, week }: { d: EnterpriseDetail; ld: LineDetail; week: string }) => {
  const insp = ld.line === "inspiration"
  const largestGap = ld.breakdown.filter(b => b.downloadRate != null && b.peerMedianDownloadRate != null && b.downloadRate < b.peerMedianDownloadRate).sort((a, b) => (a.downloadRate! - a.peerMedianDownloadRate!) - (b.downloadRate! - b.peerMedianDownloadRate!))[0]?.key
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
                { onSuccess: () => toast("已保存", { tone: "ok", ms: 1600 }), onError: (e: any) => toast(e?.code === "manual_locked" ? "已有手工内容" : `保存失败：${e.message}`, { tone: "error" }) },
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
                    <td>{b.key} {b.key === largestGap && <Badge tone="warn">差距最大</Badge>}</td>
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
            <span className="faint" style={{ fontSize: 13 }}>失败</span>
            {ld.failures.map((f) => (
              <Badge key={f.category} tone={f.category === "material" ? "down" : undefined}>
                {failureName[f.category]} {f.count}
              </Badge>
            ))}
          </div>
        )}
        {ld.models.length > 1 && (
          <div className="row" style={{ gap: 14, marginTop: 14, fontSize: 13.5, color: "var(--ink-3)", flexWrap: "wrap" }}>
            <span className="faint" style={{ fontSize: 13 }}>模型</span>
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
      <EntDaily id={d.enterprise.id} line={ld.line} />
      <Members ld={ld} />
      <AlertsTouches d={d} />
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
                    <span className="faint" style={{ fontSize: 13 }}>{lineName[a.line]}</span>
                    {a.suggestedPool && <PoolTag p={a.suggestedPool} />}
                  </div>
                  <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>{a.facts.join("；")}</div>
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
                <span className="num faint" style={{ width: 84, fontSize: 13 }}>{weekShort(t.week)} {slotName[t.slot]}</span>
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

const EntDaily = ({ id, line }: { id: string; line: Line }) => {
  const { meta } = useCtx()
  const cov = meta?.coverage.filter((c) => c.line === line).flatMap((c) => c.days).sort() ?? []
  const q = useDaily(line, meta?.weeks[0] ?? null, cov[cov.length - 1] ?? null, id)
  const days = q.data ?? []
  const insp = line === "inspiration"
  const active = days.filter((d) => d.covered && d.tasks > 0).length
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  if (!q.isLoading && !days.length) return null
  return (
    <div className="ent-section">
      <h4>
        每天使用
        <span className="sub">{active} 天有使用</span>
      </h4>
      {q.isLoading ? (
        <div className="skel" style={{ height: 150, borderRadius: 8 }} />
      ) : (
        <Heatmap
          days={days.map((d) => ({ date: d.date, covered: d.covered, value: insp ? d.tasks : d.points, note: d.covered && d.tasks ? `${num(d.tasks)} 任务 · ${compact(d.points)} 点${d.downloadRate != null ? ` · 下载 ${pct(d.downloadRate)}` : ""}` : undefined }))}
          format={(n) => (insp ? `${num(n)} 个任务` : `${compact(n)} 点`)}
          maxCell={22}
        />
      )}
    </div>
  )
}
