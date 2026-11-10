import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { TemplateDraft, TemplatePush } from "@spec/contract"
import { call } from "../api/client"
import { Button, Checkbox, Switch } from "../ui/controls"
import { Avatar, Badge, Empty, Skel } from "../ui/display"
import { Icon } from "../ui/icons"
import { Modal, toast } from "../ui/overlays"

export const PushModal = ({ draft, enterprises, touchId, open, onClose }: { draft: TemplateDraft | null; enterprises: string[]; touchId?: string; open: boolean; onClose: () => void }) => {
  const qc = useQueryClient()
  const [push, setPush] = useState<TemplatePush | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open || !draft) return
    setPush(null)
    setErr(null)
    call("POST /api/drafts/:id/pushes", { params: { id: draft.id }, body: { enterprises, touchId, notify: true } })
      .then((p) => {
        setPush(p)
        setPicked(new Set(p.receivers.filter((r) => r.selectable).map((r) => r.fdUserId)))
      })
      .catch((e) => setErr(e?.missing ? "后端尚未提供推送接口" : e.message))
  }, [open, draft?.id, enterprises.join()])
  useEffect(() => {
    if (!push || (push.state !== "sharing" && push.state !== "creating" && push.state !== "confirmed")) return
    const t = setInterval(async () => {
      const p = await call("GET /api/pushes/:id", { params: { id: push.id } })
      setPush(p)
      if (p.state === "done" || p.state === "partial" || p.state === "failed" || p.state === "uncertain") {
        clearInterval(t)
        qc.invalidateQueries({ queryKey: ["GET /api/drafts"] })
        qc.invalidateQueries({ queryKey: ["GET /api/touches"] })
        if (p.state === "done") toast(`已推送给 ${p.result?.success ?? 0} 位成员`, { tone: "ok" })
      }
    }, 700)
    return () => clearInterval(t)
  }, [push?.id, push?.state])
  const confirm = async () => {
    if (!push) return
    setBusy(true)
    try {
      setPush(await call("POST /api/pushes/:id/confirm", { params: { id: push.id }, body: { receiverUserIds: [...picked] } }))
    } catch (e: any) {
      toast(e.message, { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    if (push?.state === "preview") await call("POST /api/pushes/:id/cancel", { params: { id: push.id } }).catch(() => null)
    onClose()
  }
  const running = push && ["confirmed", "creating", "sharing"].includes(push.state)
  const finished = push && ["done", "partial", "failed", "uncertain"].includes(push.state)
  const groups = push ? [...new Map(push.receivers.map((r) => [r.enterprise.id, r.enterprise])).values()] : []
  return (
    <Modal
      open={open}
      onClose={cancel}
      width={560}
      title="推送模板"
      sub={draft ? `「${draft.title.text}」会出现在对方的共享模板里` : undefined}
      footer={
        finished ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <span className="left">{push && `已选 ${picked.size} 位成员`}</span>
            <Button variant="ghost" onClick={cancel} disabled={!!running}>
              取消
            </Button>
            <Button variant="primary" icon="send" disabled={!push || !picked.size || push.state !== "preview"} loading={busy || !!running} onClick={confirm}>
              {running ? "推送中" : "确认推送"}
            </Button>
          </>
        )
      }
    >
      {err ? (
        <Empty icon="layers" title={err} compact />
      ) : !push ? (
        <div className="stack" style={{ gap: 10 }}>
          <Skel h={52} r={8} />
          <Skel h={52} r={8} />
        </div>
      ) : finished ? (
        <div className="stack" style={{ alignItems: "center", gap: 10, padding: "20px 0" }}>
          <span style={{ width: 44, height: 44, borderRadius: "50%", display: "grid", placeItems: "center", background: push.state === "done" ? "var(--up-weak)" : "var(--warn-weak)", color: push.state === "done" ? "var(--up)" : "var(--warn)" }}>
            <Icon name={push.state === "done" ? "check" : "alert"} size="lg" />
          </span>
          <b>{push.state === "done" ? "推送完成" : push.state === "uncertain" ? "结果不确定，请在 FD 里核对" : "部分失败"}</b>
          <span className="muted num">
            成功 {push.result?.success ?? 0} · 失败 {push.result?.failed ?? 0}
          </span>
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {running && (
            <div className="progress indeterminate">
              <i />
            </div>
          )}
          {groups.map((e) => (
            <div key={e.id}>
              <div className="label">{e.name}</div>
              <div className="receivers">
                {push.receivers
                  .filter((r) => r.enterprise.id === e.id)
                  .map((r) => (
                    <div key={r.fdUserId} className={`receiver ${r.selectable ? "" : "off"}`}>
                      <Checkbox
                        checked={picked.has(r.fdUserId)}
                        disabled={!r.selectable || push.state !== "preview"}
                        onChange={(v) =>
                          setPicked((s) => {
                            const n = new Set(s)
                            v ? n.add(r.fdUserId) : n.delete(r.fdUserId)
                            return n
                          })
                        }
                      />
                      <Avatar name={r.userName} size={26} />
                      <div className="who">
                        <span>{r.userName}</span>
                        <span className="s num">{r.maskedPhone}</span>
                      </div>
                      {!r.selectable && <Badge tone="outline">{r.disabledReason}</Badge>}
                    </div>
                  ))}
              </div>
            </div>
          ))}
          {push.blocked.length > 0 && (
            <div className="banner">
              <Icon name="shield" size="sm" />
              <span>
                {push.blocked.map((b) => b.enterprise.name).join("、")}：{push.blocked[0].reason}
              </span>
            </div>
          )}
          {!push.receivers.length && !push.blocked.length && <Empty compact title="没有可推送的成员" />}
          <Switch
            checked={notify}
            onChange={(v) => {
              setNotify(v)
              setPush({ ...push, notify: v })
            }}
          >
            同时给对方发送通知
          </Switch>
        </div>
      )}
    </Modal>
  )
}
