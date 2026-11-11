import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Followup, FollowupState, Pool } from "@spec/contract"
import { call, type CallOpts } from "../api/client"
import { errorText, useFollowups } from "../api/next"
import { useCtx } from "../lib/ctx"
import { lineName, poolName, poolOrder } from "../lib/labels"
import { navigate } from "../lib/route"
import { locate } from "../lib/locate"
import { num, pct, time, weekLabel } from "../lib/format"
import { exportOne } from "../lib/download"
import { Button, IconButton, Segmented, TextArea, cx } from "../ui/controls"
import { Badge, copyText, Delta, Empty, ErrorState, InlineEdit, Skel, SourceTag } from "../ui/display"
import { Icon, type IconName } from "../ui/icons"
import { EvidenceChip } from "../ui/insight"
import { Menu, Tooltip, toast } from "../ui/overlays"
import { PoolTag } from "./bits"

const stateName: Record<FollowupState, string> = { todo: "待联系", contacted: "已联系", replied: "已回复", shelved: "搁置" }
const stateOrder: FollowupState[] = ["todo", "contacted", "replied", "shelved"]
const attIcon: Record<string, IconName> = { template: "template", opportunity: "sparkle", chain: "chain", movement: "chart", trial: "image" }

export const FollowupsPage = () => {
  const { line, week } = useCtx()
  const q = useFollowups(line, week)
  const qc = useQueryClient()
  const [show, setShow] = useState<FollowupState | "all">("all")
  const items = q.data?.items ?? []
  const sugs = (q.data?.suggestions ?? []).filter((s) => !items.some((i) => i.enterprise.id === s.enterprise.id)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  const sync = () => qc.invalidateQueries({ queryKey: ["GET /api/followups"] })
  const groups = useMemo(() => stateOrder.map((s) => ({ s, xs: items.filter((i) => i.state === s) })).filter((g) => g.xs.length && (show === "all" || show === g.s)), [items, show])
  const count = (s: FollowupState) => items.filter((i) => i.state === s).length
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div>
          <h1>跟进</h1>
          <div className="meta">
            <span>{lineName[line]}</span>
            {week && <span className="num">{weekLabel(week)}</span>}
            <span className="faint">
              {items.length} 条 · 待联系 {count("todo")}
            </span>
          </div>
        </div>
        <div className="actions">
          <Button icon="download" onClick={() => exportOne("followups", { line, week: week ?? undefined }, `跟进清单_${lineName[line]}_${week}`)}>
            导出清单
          </Button>
        </div>
      </div>
      {q.isLoading ? (
        <div className="stack" style={{ gap: 12 }}>
          <Skel h={180} r={12} />
          <Skel h={120} r={12} />
          <Skel h={120} r={12} />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          {sugs.length > 0 && <Suggestions xs={sugs.slice(0, 12)} sync={sync} />}
          <div className="fu-bar">
            <Segmented size="sm" value={show} onChange={setShow} options={[{ value: "all" as const, label: "全部", count: items.length }, ...stateOrder.map((s) => ({ value: s, label: stateName[s], count: count(s) }))]} />
          </div>
          {groups.length ? (
            groups.map((g) => (
              <section key={g.s} className="fu-group">
                <h3>
                  {stateName[g.s]}
                  <span className="faint num">{g.xs.length}</span>
                </h3>
                <div className="fu-list">
                  {g.xs.map((f) => (
                    <Item key={f.id} f={f} sync={sync} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <Empty icon="send" title={items.length ? "这一类没有" : "本周还没有跟进"} text={items.length ? undefined : "从上面的建议加入，或在企业档案、涨跌原因里点「加入跟进」"} compact />
          )}
        </>
      )}
    </div>
  )
}

const Suggestions = ({ xs, sync }: { xs: Followup[]; sync: () => void }) => {
  const [busy, setBusy] = useState<string | null>(null)
  const add = async (f: Followup) => {
    setBusy(f.id)
    try {
      await call("PATCH /api/followups/:id", { params: { id: f.id }, body: { suggested: false } })
      sync()
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setBusy(null)
    }
  }
  const drop = async (f: Followup) => {
    try {
      await call("DELETE /api/followups/:id", { params: { id: f.id } })
      sync()
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  return (
    <section className="fu-sug">
      <div className="fu-sug-h">
        <Icon name="sparkle" size="sm" />
        <b>本周建议</b>
        <span className="faint">按需要程度排序</span>
        <span className="spacer" />
        <Button size="xs" variant="ghost" onClick={() => Promise.all(xs.map((f) => call("PATCH /api/followups/:id", { params: { id: f.id }, body: { suggested: false } }))).then(sync)}>
          全部加入
        </Button>
      </div>
      <div className="fu-sug-list">
        {xs.map((f, i) => (
          <div key={f.id} className="fu-sug-i">
            <span className="fu-rank num">{f.rank ?? i + 1}</span>
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <div className="row" style={{ gap: 8, minWidth: 0 }}>
                <button className="fu-name ellipsis" onClick={() => navigate({ ent: f.enterprise.id })}>
                  {f.enterprise.name}
                </button>
                <PoolTag p={f.goal} />
              </div>
              <span className="fu-reason">{f.reason}</span>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <Button size="xs" variant="soft" icon="plus" loading={busy === f.id} onClick={() => add(f)}>
                加入
              </Button>
              <IconButton size="xs" icon="x" label="不需要" onClick={() => drop(f)} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

const Item = ({ f, sync }: { f: Followup; sync: () => void }) => {
  const [reply, setReply] = useState(f.reply ?? "")
  const [replyOpen, setReplyOpen] = useState(false)
  const patch = async (body: NonNullable<CallOpts<"PATCH /api/followups/:id">["body"]>) => {
    try {
      await call("PATCH /api/followups/:id", { params: { id: f.id }, body })
      sync()
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  const o = f.outcome
  return (
    <div className={cx("fu-item", f.state)}>
      <div className="fu-h">
        <button className="fu-name ellipsis" onClick={() => navigate({ ent: f.enterprise.id })}>
          {f.enterprise.name}
        </button>
        <Menu
          width={160}
          items={poolOrder.map((p) => ({ key: p, label: poolName[p as Pool], icon: p === f.goal ? ("check" as const) : undefined, onSelect: () => patch({ goal: p }) }))}
          trigger={({ toggle, ref }) => (
            <button ref={ref as never} onClick={toggle} className="fu-goal">
              <PoolTag p={f.goal} />
              <Icon name="chevDown" size="xs" className="faint" />
            </button>
          )}
        />
        <span className="spacer" />
        {f.contactedAt && <span className="faint num" style={{ fontSize: 12.5 }}>联系于 {time(f.contactedAt)}</span>}
        <div className="fu-states">
          {stateOrder.map((s) => (
            <button key={s} className={cx("fu-st", s, f.state === s && "on")} onClick={() => f.state !== s && patch({ state: s })}>
              {stateName[s]}
            </button>
          ))}
        </div>
        <Menu
          width={160}
          items={[{ key: "del", label: "删除", icon: "trash", danger: true, onSelect: () => call("DELETE /api/followups/:id", { params: { id: f.id } }).then(sync, (e) => toast(errorText(e), { tone: "error" })) }]}
          trigger={({ toggle, ref }) => <IconButton ref={ref as never} size="xs" icon="more" label="更多" onClick={toggle} />}
        />
      </div>
      <div className="fu-reason">{f.reason}</div>
      {f.evidence.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {f.evidence.map((e, i) => (
            <EvidenceChip key={i} e={e} />
          ))}
        </div>
      )}
      {f.attachments.length > 0 && (
        <div className="fu-att">
          <span className="faint">带去</span>
          {f.attachments.map((a) => (
            <button key={`${a.kind}:${a.id}`} className="fu-att-i" onClick={() => locate(a.target)}>
              <Icon name={attIcon[a.kind] ?? "link"} size="xs" />
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div className="fu-script">
        <div className="row" style={{ gap: 6, marginBottom: 4 }}>
          <span className="faint" style={{ fontSize: 12.5 }}>话术</span>
          <SourceTag a={f.script} />
          <span className="spacer" />
          <IconButton size="xs" icon="copy" label="复制" onClick={() => copyText(f.script.text, "话术已复制")} />
        </div>
        <InlineEdit value={f.script.text} onSave={(v) => patch({ script: v })} placeholder="写下要说什么" />
      </div>
      {(f.state === "contacted" || f.state === "replied" || f.reply) && (
        <div className="fu-reply">
          {replyOpen || !f.reply ? (
            <div className="stack" style={{ gap: 6 }}>
              <TextArea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="客户怎么回复的" style={{ minHeight: 56 }} />
              <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                {f.reply && (
                  <Button size="xs" variant="ghost" onClick={() => (setReply(f.reply ?? ""), setReplyOpen(false))}>
                    取消
                  </Button>
                )}
                <Button size="xs" variant="primary" disabled={!reply.trim() || reply === f.reply} onClick={() => (patch({ reply: reply.trim(), state: "replied" }), setReplyOpen(false))}>
                  保存回复
                </Button>
              </div>
            </div>
          ) : (
            <button className="fu-reply-t" onClick={() => setReplyOpen(true)}>
              <Icon name="chevRight" size="xs" />
              <span>{f.reply}</span>
            </button>
          )}
        </div>
      )}
      {o && (
        <div className="fu-out">
          <span className="faint">下一周</span>
          <span className="num">
            任务 {num(o.tasks.previous)} → <b>{num(o.tasks.current)}</b>
          </span>
          <Delta pair={o.tasks} pill />
          <span className="num">
            下载 {pct(o.downloadRate.previous, 0)} → <b>{pct(o.downloadRate.current, 0)}</b>
          </span>
          {o.templateUsed != null && <Badge tone={o.templateUsed ? "up" : "outline"}>{o.templateUsed ? "用了模板" : "没用模板"}</Badge>}
          {o.control && (
            <Tooltip content={`同类 ${o.control.enterprises} 家企业的任务中位变化`}>
              <span className="faint num">同类 {o.control.medianTaskChange > 0 ? "+" : ""}{Math.round(o.control.medianTaskChange * 100)}%</span>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
