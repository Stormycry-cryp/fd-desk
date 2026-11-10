import { useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { OfferKind, Pool, Touch, TouchSlot, TouchStatus } from "@spec/contract"
import { useDrafts, usePatchTouch, useTouches, useCall } from "../api/hooks"
import { call, url } from "../api/client"
import { useCtx } from "../lib/ctx"
import { lineName, offerName, poolName, poolOrder, slotHint, slotName, touchStatusName, touchStatusOrder } from "../lib/labels"
import { navigate } from "../lib/route"
import { num, pct, weekLabel } from "../lib/format"
import { Button, IconButton, Input, Segmented, TextArea, cx } from "../ui/controls"
import { Avatar, Badge, CopyField, Delta, Empty, ErrorState, Skel, SourceTag, Stepper } from "../ui/display"
import { Icon } from "../ui/icons"
import { Drawer, Menu, Select, Tooltip, toast } from "../ui/overlays"
import { PoolTag, StatusTag } from "./bits"
import { exportFile } from "./CustomersPage"
import { PushModal } from "./PushModal"

const slots: TouchSlot[] = ["mon", "wed", "fri"]

export const TouchesPage = () => {
  const { line, week } = useCtx()
  const q = useTouches(line, week)
  const patch = usePatchTouch(line, week ?? "")
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<TouchSlot | null>(null)
  const [owner, setOwner] = useState<string>("all")
  const file = useRef<HTMLInputElement>(null)
  const board = q.data
  const all = useMemo(() => (board ? [...board.suggestions, ...slots.flatMap((s) => board.slots[s])] : []), [board])
  const owners = useMemo(() => [...new Set(all.map((t) => t.owner).filter(Boolean) as string[])], [all])
  const current = all.find((t) => t.id === openId) ?? null
  const move = (id: string, slot: TouchSlot) => {
    const t = all.find((x) => x.id === id)
    if (!t || (t.slot === slot && !t.suggested)) return
    patch.mutate({ id, body: { slot, suggested: false } }, { onError: (e: any) => toast(e?.missing ? "后端尚未提供触达接口" : e.message, { tone: "error" }) })
  }
  const accept = (t: Touch) => patch.mutate({ id: t.id, body: { suggested: false } }, { onSuccess: () => toast(`已放入${slotName[t.slot]}`, { tone: "ok", ms: 1600 }) })
  const dismiss = useCall("DELETE /api/touches/:id", ["GET /api/touches"])
  const importFile = async (f: File) => {
    const fd = new FormData()
    fd.append("file", f)
    try {
      const r = await call("POST /api/touches/import", { body: fd })
      toast(`回填 ${r.updated} 张卡片${r.skipped ? `，跳过 ${r.skipped}` : ""}`, { tone: "ok" })
      qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
    } catch (e: any) {
      toast(e?.missing ? "后端尚未提供回填接口" : e.message, { tone: "error" })
    }
  }
  const stats = useMemo(() => {
    const placed = board ? slots.flatMap((s) => board.slots[s]) : []
    const by = (s: TouchStatus) => placed.filter((t) => t.status === s).length
    return { total: placed.length, todo: by("draft") + by("assigned"), sent: by("sent"), replied: by("replied") }
  }, [board])
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>触达</h1>
          <div className="meta">
            <span className="num">{week && weekLabel(week)}</span>
            <span>{lineName[line]}</span>
            {board && (
              <>
                <span className="faint">·</span>
                <span>
                  待处理 <b className="num" style={{ color: "var(--ink)" }}>{stats.todo}</b>
                </span>
                <span>
                  已发送 <b className="num" style={{ color: "var(--ink)" }}>{stats.sent}</b>
                </span>
                <span>
                  已回复 <b className="num" style={{ color: "var(--up)" }}>{stats.replied}</b>
                </span>
              </>
            )}
          </div>
        </div>
        <div className="actions">
          {owners.length > 0 && <Select size="sm" value={owner} onChange={setOwner} prefix="负责人" options={[{ value: "all", label: "全部" }, ...owners.map((o) => ({ value: o, label: o }))]} popWidth={180} />}
          <input ref={file} type="file" accept=".xlsx" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <Menu
            width={240}
            items={[
              { key: "export", label: "导出本周清单", icon: "download", hint: owner === "all" ? "全部负责人" : owner, onSelect: () => exportFile(url("GET /api/touches/export", { query: { line, week: week!, owner: owner === "all" ? undefined : owner } }), `触达清单_${lineName[line]}_${week}.xlsx`) },
              { key: "import", label: "导入回填表", icon: "upload", hint: "按卡片更新状态和回复", onSelect: () => file.current?.click() },
            ]}
            trigger={({ toggle, ref, open }) => (
              <Button ref={ref as any} icon="download" iconRight="chevDown" onClick={toggle} active={open}>
                清单
              </Button>
            )}
          />
          <NewTouch />
        </div>
      </div>
      {q.isLoading ? (
        <BoardSkeleton />
      ) : q.error || !board ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          {board.suggestions.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 0 }}>
                <Icon name="sparkle" size="sm" style={{ color: "var(--accent)" }} />
                建议
                <span className="sub">按规则从预警里挑出，接受后进入看板</span>
              </div>
              <div className="suggest-strip">
                {board.suggestions.map((t) => (
                  <div key={t.id} className="tcard" onClick={() => setOpenId(t.id)} draggable onDragStart={(e) => (setDrag(t.id), e.dataTransfer.setData("text/plain", t.id))} onDragEnd={() => (setDrag(null), setOver(null))}>
                    <div className="top-row">
                      <PoolTag p={t.goal} />
                      <span className="name">{t.enterprise.name}</span>
                    </div>
                    <div className="ev">{t.evidence.join("；")}</div>
                    <div className="foot">
                      <span>{slotName[t.slot]}</span>
                      <span className="spacer" />
                      <Button size="xs" variant="ghost" onClick={(e) => (e.stopPropagation(), dismiss.mutate({ params: { id: t.id } }))}>
                        忽略
                      </Button>
                      <Button size="xs" variant="soft" icon="plus" onClick={(e) => (e.stopPropagation(), accept(t))}>
                        接受
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="board" style={{ marginTop: board.suggestions.length ? 16 : 0 }}>
            {slots.map((s) => {
              const list = board.slots[s].filter((t) => owner === "all" || t.owner === owner)
              return (
                <div
                  key={s}
                  className={cx("col", over === s && "over")}
                  onDragOver={(e) => (e.preventDefault(), over !== s && setOver(s))}
                  onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    const id = e.dataTransfer.getData("text/plain") || drag
                    if (id) move(id, s)
                    setOver(null)
                    setDrag(null)
                  }}
                >
                  <div className="col-head">
                    <b>{slotName[s]}</b>
                    <span className="faint" style={{ fontSize: 12 }}>{slotHint[s]}</span>
                    <span className="spacer" />
                    <span className="n">{list.length}</span>
                  </div>
                  <div className="col-list">
                    {list.map((t) => (
                      <TouchCard key={t.id} t={t} open={openId === t.id} dragging={drag === t.id} onOpen={() => setOpenId(t.id)} onDragStart={() => setDrag(t.id)} onDragEnd={() => (setDrag(null), setOver(null))} />
                    ))}
                    {!list.length && (
                      <div className="empty compact" style={{ padding: "28px 12px" }}>
                        <span className="d">拖动卡片到这里</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      <TouchEditor t={current} onClose={() => setOpenId(null)} />
    </div>
  )
}

const TouchCard = ({ t, open, dragging, onOpen, onDragStart, onDragEnd }: { t: Touch; open: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void }) => (
  <div className={cx("tcard", open && "open", dragging && "dragging")} draggable onClick={onOpen} onDragStart={(e) => (e.dataTransfer.setData("text/plain", t.id), (e.dataTransfer.effectAllowed = "move"), onDragStart())} onDragEnd={onDragEnd}>
    <Icon name="grip" size="sm" className="grip" />
    <div className="top-row">
      <PoolTag p={t.goal} />
      <span className="name">{t.enterprise.name}</span>
    </div>
    <div className="ev">{t.evidence.join("；") || <span className="faint">没有依据</span>}</div>
    <div className="foot">
      <Badge tone="outline" icon={t.offer.kind === "template" ? "template" : t.offer.kind === "comparison" ? "image" : t.offer.kind === "question" ? "info" : "sparkle"}>
        {offerName[t.offer.kind]}
      </Badge>
      {t.outcome && (
        <Tooltip content={<span className="num">下一周 {num(t.outcome.tasks.previous)} → {num(t.outcome.tasks.current)}</span>}>
          <span>
            <Delta pair={t.outcome.tasks} />
          </span>
        </Tooltip>
      )}
      <span className="spacer" />
      {t.owner && (
        <Tooltip content={t.owner}>
          <span>
            <Avatar name={t.owner} size={20} />
          </span>
        </Tooltip>
      )}
      <StatusTag s={t.status} />
    </div>
  </div>
)

const TouchEditor = ({ t, onClose }: { t: Touch | null; onClose: () => void }) => {
  const { line, week } = useCtx()
  const patch = usePatchTouch(line, week ?? "")
  const drafts = useDrafts(line)
  const del = useCall("DELETE /api/touches/:id", ["GET /api/touches"])
  const [push, setPush] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const set = (body: Parameters<typeof patch.mutate>[0]["body"]) => t && patch.mutate({ id: t.id, body }, { onError: (e: any) => toast(e?.missing ? "后端尚未提供触达接口" : e.message, { tone: "error" }) })
  const tpl = t?.offer.draftId ? drafts.data?.find((d) => d.id === t.offer.draftId) ?? null : null
  return (
    <Drawer
      open={!!t}
      onClose={() => (setDraft(null), setReply(null), onClose())}
      width={560}
      title={
        t && (
          <span className="row" style={{ gap: 8 }}>
            <PoolTag p={t.goal} />
            <button className="ellipsis" style={{ fontWeight: 600 }} onClick={() => navigate({ ent: t.enterprise.id })}>
              {t.enterprise.name}
            </button>
          </span>
        )
      }
      actions={t && <Menu width={160} items={[{ key: "open", label: "查看企业", icon: "building", onSelect: () => navigate({ ent: t.enterprise.id }) }, { key: "sep", label: "", sep: true }, { key: "del", label: "删除卡片", icon: "trash", danger: true, onSelect: () => (del.mutate({ params: { id: t.id } }), onClose()) }]} trigger={({ toggle, ref }) => <IconButton ref={ref as any} icon="more" label="更多" onClick={toggle} />} />}
    >
      {t && (
        <div className="stack" style={{ gap: 20, padding: 20 }}>
          <div>
            <span className="label">状态</span>
            <Stepper steps={touchStatusOrder} value={t.status} labels={touchStatusName} onChange={(s) => set({ status: s })} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div>
              <span className="label">时段</span>
              <Select value={t.slot} onChange={(v) => set({ slot: v as TouchSlot, suggested: false })} options={slots.map((s) => ({ value: s, label: slotName[s], hint: slotHint[s] }))} width="100%" />
            </div>
            <div>
              <span className="label">目的</span>
              <Select value={t.goal} onChange={(v) => set({ goal: v as Pool })} options={poolOrder.map((p) => ({ value: p, label: poolName[p] }))} width="100%" />
            </div>
            <div>
              <span className="label">渠道</span>
              <Select value={t.channel} placeholder="选择" onChange={(v) => set({ channel: v })} options={["微信", "企业微信", "电话", "运营转达"].map((c) => ({ value: c, label: c }))} width="100%" />
            </div>
          </div>
          <div>
            <span className="label">负责人</span>
            <Input key={t.id} defaultValue={t.owner ?? ""} placeholder="谁去联系" onBlur={(e) => e.target.value !== (t.owner ?? "") && set({ owner: e.target.value || null })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </div>
          <div>
            <span className="label">依据</span>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, color: "var(--ink-2)" }}>
              {t.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
          <div>
            <span className="label">带去的东西</span>
            <div className="stack" style={{ gap: 10 }}>
              <Segmented size="sm" value={t.offer.kind} onChange={(k) => set({ offer: { ...t.offer, kind: k as OfferKind } })} options={(Object.keys(offerName) as OfferKind[]).map((k) => ({ value: k, label: offerName[k] }))} />
              {t.offer.kind === "template" ? (
                <>
                  <Select value={t.offer.draftId} placeholder="选择模板草稿" onChange={(v) => set({ offer: { ...t.offer, draftId: v } })} options={(drafts.data ?? []).map((d) => ({ value: d.id, label: d.title.text, hint: d.scope === "general" ? "通用" : "仅来源企业" }))} width="100%" />
                  {tpl?.link && <CopyField value={tpl.link} open />}
                  {tpl && (
                    <Button icon="send" variant="soft" onClick={() => setPush(true)}>
                      推送给这家企业
                    </Button>
                  )}
                </>
              ) : (
                <Input key={`${t.id}${t.offer.kind}`} defaultValue={t.offer.text ?? ""} placeholder={t.offer.kind === "comparison" ? "对比说明" : t.offer.kind === "question" ? "要问他的问题" : "建议内容"} onBlur={(e) => e.target.value !== (t.offer.text ?? "") && set({ offer: { ...t.offer, text: e.target.value } })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              )}
            </div>
          </div>
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="label" style={{ margin: 0 }}>话术</span>
              <SourceTag a={t.draft} />
              <span className="spacer" />
              <IconButton size="xs" icon="copy" label="复制话术" onClick={() => navigator.clipboard.writeText(t.draft.text).then(() => toast("话术已复制", { tone: "ok", ms: 1500 }))} />
            </div>
            <TextArea value={draft ?? t.draft.text} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft != null && draft !== t.draft.text && (set({ draft, source: "manual" }), setDraft(null))} style={{ minHeight: 96 }} />
          </div>
          {(t.status === "sent" || t.status === "replied" || t.status === "closed") && (
            <div>
              <span className="label">客户回复</span>
              <TextArea value={reply ?? t.reply ?? ""} placeholder="对方怎么说" onChange={(e) => setReply(e.target.value)} onBlur={() => reply != null && (set({ reply, status: reply ? "replied" : t.status }), setReply(null))} />
            </div>
          )}
          {t.outcome ? (
            <div>
              <span className="label">下一周结果</span>
              <div className="outcome">
                <div className="stat sm">
                  <span className="k">任务</span>
                  <span className="v num">{num(t.outcome.tasks.current)}</span>
                  <span className="f">
                    <Delta pair={t.outcome.tasks} pill /> 从 {num(t.outcome.tasks.previous)}
                  </span>
                </div>
                <div className="stat sm">
                  <span className="k">下载率</span>
                  <span className="v num">{pct(t.outcome.downloadRate.current)}</span>
                  <span className="f">
                    <Delta current={t.outcome.downloadRate.current} previous={t.outcome.downloadRate.previous} rate pill />
                  </span>
                </div>
                <div className="stat sm">
                  <span className="k">同池未触达</span>
                  <span className="v num">{t.outcome.control ? `${t.outcome.control.medianTaskChange > 0 ? "+" : ""}${Math.round(t.outcome.control.medianTaskChange * 100)}%` : "—"}</span>
                  <span className="f">{t.outcome.control ? `中位数 · ${t.outcome.control.enterprises} 家` : ""}</span>
                </div>
              </div>
              {t.outcome.templateUsed != null && <div style={{ marginTop: 8, fontSize: 12.5 }} className={t.outcome.templateUsed ? "up" : "muted"}>{t.outcome.templateUsed ? "模板被使用了" : "模板没有被使用"}</div>}
            </div>
          ) : (
            t.status !== "draft" && <div className="banner neutral"><Icon name="clock" size="sm" />下一周数据导入后自动算出结果</div>
          )}
        </div>
      )}
      <PushModal open={push} onClose={() => setPush(false)} draft={tpl} enterprises={t ? [t.enterprise.id] : []} touchId={t?.id} />
    </Drawer>
  )
}

const NewTouch = () => {
  const { line, week, route } = useCtx()
  void route
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [ent, setEnt] = useState<string | null>(null)
  const [slot, setSlot] = useState<TouchSlot>("mon")
  const [goal, setGoal] = useState<Pool>("retain")
  const roster = qc.getQueryData<any>(["GET /api/enterprises", null, { line, week }])
  const create = async () => {
    if (!ent) return
    try {
      await call("POST /api/touches", { body: { line, week: week!, slot, enterprise: ent, goal, source: "manual" } })
      qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
      setOpen(false)
      setEnt(null)
    } catch (e: any) {
      toast(e?.missing ? "后端尚未提供触达接口" : e.message, { tone: "error" })
    }
  }
  return (
    <>
      <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
        新建
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        width={440}
        title="新建触达"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" disabled={!ent} onClick={create}>
              创建
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 16, padding: 20 }}>
          <div>
            <span className="label">企业</span>
            <Select value={ent} placeholder="搜索企业" search onChange={(v) => {
              setEnt(v)
              const r = roster?.rows?.find((x: any) => x.enterprise.id === v)
              if (r?.pool) setGoal(r.pool)
            }} options={(roster?.rows ?? []).map((r: any) => ({ value: r.enterprise.id, label: r.enterprise.name, hint: r.pool ? poolName[r.pool as Pool] : undefined }))} width="100%" popWidth={380} />
          </div>
          <div>
            <span className="label">时段</span>
            <Segmented block value={slot} onChange={setSlot} options={slots.map((s) => ({ value: s, label: slotName[s] }))} />
          </div>
          <div>
            <span className="label">目的</span>
            <Select value={goal} onChange={(v) => setGoal(v as Pool)} options={poolOrder.map((p) => ({ value: p, label: poolName[p] }))} width="100%" />
          </div>
        </div>
      </Drawer>
    </>
  )
}

const BoardSkeleton = () => (
  <div className="board">
    {slots.map((s) => (
      <div key={s} className="col">
        <div className="col-head">
          <Skel w={40} />
        </div>
        <div className="col-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="tcard" style={{ cursor: "default" }}>
              <Skel w="70%" />
              <Skel h={28} />
              <Skel w="40%" />
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
)

export { Empty }
