import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { TemplateDraft, TemplatePush } from "@spec/contract"
import { useRoster } from "../api/hooks"
import { call } from "../api/client"
import { useCtx } from "../lib/ctx"
import { Button, Checkbox, Switch } from "../ui/controls"
import { Avatar, Badge, Empty, ErrorState } from "../ui/display"
import { Modal, toast } from "../ui/overlays"

export const PushModal = ({ draft, enterprises, touchId, open, onClose }: { draft: TemplateDraft | null; enterprises: string[]; touchId?: string; open: boolean; onClose: () => void }) => {
  if (!open || !draft) return null
  return <PushForm key={`${draft.id}:${touchId ?? ""}`} draft={draft} enterprises={enterprises} touchId={touchId} onClose={onClose} />
}

const PushForm = ({ draft, enterprises, touchId, onClose }: { draft: TemplateDraft; enterprises: string[]; touchId?: string; onClose: () => void }) => {
  const qc = useQueryClient()
  const { week } = useCtx()
  const roster = useRoster(draft.line, week)
  const [push, setPush] = useState<TemplatePush | null>(null)
  const [err, setErr] = useState<Error | null>(null)
  const [targets, setTargets] = useState(new Set(enterprises))
  const [picked, setPicked] = useState(new Set<number>())
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const running = !!push && ["confirmed", "creating", "sharing"].includes(push.state)
  const finished = !!push && ["done", "partial", "failed", "uncertain"].includes(push.state)
  const poll = useQuery({
    queryKey: ["GET /api/pushes/:id", push?.id],
    queryFn: () => call("GET /api/pushes/:id", { params: { id: push!.id } }),
    enabled: running,
    retry: false,
    refetchInterval: running ? 1500 : false,
  })
  useEffect(() => {
    if (!poll.data) return
    setPush(poll.data)
    if (!["confirmed", "creating", "sharing"].includes(poll.data.state)) {
      qc.invalidateQueries({ queryKey: ["GET /api/drafts"] })
      qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
    }
  }, [poll.data, qc])
  useEffect(() => {
    if (finished) {
      qc.invalidateQueries({ queryKey: ["GET /api/drafts"] })
      qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
    }
  }, [finished, qc])
  const preview = async () => {
    setBusy(true)
    setErr(null)
    try {
      const p = await call("POST /api/drafts/:id/pushes", { params: { id: draft.id }, body: { enterprises: [...targets], touchId, notify } })
      setPush(p)
      setPicked(new Set(p.receivers.filter(r => r.selectable).map(r => r.fdUserId)))
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (!push || busy) return
    setBusy(true)
    setErr(null)
    try {
      setPush(await call("POST /api/pushes/:id/confirm", { params: { id: push.id }, body: { receiverUserIds: [...picked] } }))
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }
  const cancel = async (close: boolean) => {
    if (running || busy) return
    setBusy(true)
    try {
      if (push?.state === "preview") await call("POST /api/pushes/:id/cancel", { params: { id: push.id } })
      setPush(null)
      setErr(null)
      if (close) onClose()
    } catch (e) {
      toast((e as Error).message, { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  const allowed = new Set(draft.sourceEnterprises.map(e => e.id))
  const rows = (roster.data?.rows ?? []).filter(r => draft.scope === "general" || allowed.has(r.enterprise.id))
  return (
    <Modal open onClose={() => cancel(true)} width={560} title="推送模板" sub={draft.title.text} footer={finished ? <Button variant="primary" onClick={onClose}>完成</Button> : <>
      {push?.state === "preview" && <Button variant="ghost" loading={busy} onClick={() => cancel(false)}>重新选择</Button>}
      <span className="spacer" />
      <Button variant="ghost" disabled={running || busy} onClick={() => cancel(true)}>取消</Button>
      {push ? <Button variant="primary" icon="send" disabled={push.state !== "preview" || !picked.size || !!poll.error} loading={busy || running} onClick={confirm}>{running ? "推送中" : `确认推送 ${picked.size} 位成员`}</Button> : <Button variant="primary" loading={busy} disabled={!targets.size || !draft.fdTemplateId} onClick={preview}>查看接收成员</Button>}
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        {(err || poll.error) && <ErrorState error={err ?? poll.error} retry={poll.error ? () => poll.refetch() : undefined} />}
        {!draft.fdTemplateId && <div className="banner">请先在模板页发布团队模板</div>}
        {finished ? <>
          <b>{push!.state === "done" ? "推送完成" : push!.state === "uncertain" ? "结果不确定，请在 FD 核对" : push!.state === "failed" ? "推送失败" : "部分推送成功"}</b>
          <span className="num">成功 {push!.result?.success ?? 0} · 失败 {push!.result?.failed ?? 0} · 待完成 {push!.result?.pending ?? 0}</span>
          {push!.result?.failures.map((f, i) => <span key={i} className="muted">成员 {f.fdUserId}：{f.message ?? f.code}</span>)}
        </> : !push ? <>
          <span className="label">接收企业</span>
          {roster.error ? <ErrorState error={roster.error} retry={() => roster.refetch()} /> : rows.map(r => <Checkbox key={r.enterprise.id} checked={targets.has(r.enterprise.id)} disabled={!!touchId || busy} onChange={v => setTargets(s => { const next = new Set(s); v ? next.add(r.enterprise.id) : next.delete(r.enterprise.id); return next })}>{r.enterprise.name}</Checkbox>)}
          <Switch checked={notify} disabled={busy} onChange={setNotify}>同时发送通知</Switch>
        </> : <>
          <span className="muted">{push.notify ? "确认后分享模板并发送通知" : "确认后分享模板"}</span>
          {push.receivers.map(r => <div key={`${r.enterprise.id}:${r.fdUserId}`} className="row" style={{ gap: 10 }}>
            <Checkbox checked={picked.has(r.fdUserId)} disabled={!r.selectable || push.state !== "preview" || busy} onChange={v => setPicked(s => { const next = new Set(s); v ? next.add(r.fdUserId) : next.delete(r.fdUserId); return next })} />
            <Avatar name={r.userName} size={26} />
            <div className="stack" style={{ flex: 1 }}><span>{r.userName} · {r.enterprise.name}</span><span className="faint num">{r.maskedPhone}</span></div>
            {!r.selectable && <Badge tone="outline">{r.disabledReason ?? "无法选择"}</Badge>}
            {!!r.missingModels.length && <Badge tone="warn">缺少模型 {r.missingModels.join("、")}</Badge>}
          </div>)}
          {push.blocked.map(b => <div key={b.enterprise.id} className="banner">{b.enterprise.name}：{b.reason}</div>)}
          {!push.receivers.length && <Empty title="没有可推送的成员" compact />}
        </>}
      </div>
    </Modal>
  )
}
