import { useState } from "react"
import type { Rerun, Task } from "@spec/contract"
import { useCall, useReruns, useSettings } from "../../api/hooks"
import { Button, Input, TextArea } from "../../ui/controls"
import { Badge, Empty, ErrorState, Thumb } from "../../ui/display"
import { Modal } from "../../ui/overlays"
import { time } from "../../lib/format"

const stateName: Record<Rerun["state"], string> = { estimated: "待确认", confirmed: "已确认", running: "生成中", done: "已完成", failed: "生成失败", uncertain: "结果不确定" }
const money = (value: number | null, currency: string | null) => value == null ? "费用未知" : `${value.toFixed(4)} ${currency}`

export const RerunModal = ({ task, onClose }: { task: Task; onClose: () => void }) => {
  const history = useReruns(task.enterprise.id)
  const settings = useSettings()
  const create = useCall("POST /api/reruns", ["GET /api/reruns"])
  const confirm = useCall("POST /api/reruns/:id/confirm", ["GET /api/reruns"])
  const [prompt, setPrompt] = useState(task.prompt)
  const [model, setModel] = useState("gpt-image-2")
  const [selected, setSelected] = useState<Rerun | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const current = history.data?.find(r => r.id === selected?.id) ?? selected
  const records = history.data?.filter(r => r.sourceTask.rowKey === task.rowKey) ?? []
  const estimate = () => {
    setError(null)
    create.mutate({ body: { sourceRowKey: task.rowKey, prompt: prompt.trim(), model: model.trim() } }, { onSuccess: setSelected, onError: setError })
  }
  const pay = () => {
    if (!current || current.state !== "estimated") return
    setError(null)
    confirm.mutate({ params: { id: current.id } }, { onSuccess: setSelected, onError: setError })
  }
  const budget = settings.data
  const canConfirm = current?.state === "estimated" && current.estimatedCost != null && budget && current.currency === budget.rerunCurrency && current.estimatedCost <= budget.rerunDailyBudget
  return <Modal open onClose={onClose} title="重跑对比" sub={task.enterprise.name} width={820} footer={<>
    <span className="left muted">{current ? money(current.estimatedCost, current.currency) : "修改提示词或模型后获取费用预估"}</span>
    <Button variant="ghost" onClick={onClose}>关闭</Button>
    <Button loading={create.isPending} disabled={!prompt.trim() || !model.trim() || confirm.isPending} onClick={estimate}>获取费用预估</Button>
    <Button variant="primary" loading={confirm.isPending} disabled={!canConfirm || create.isPending} onClick={pay}>确认收费并生成</Button>
  </>}>
    <div className="stack" style={{ gap: 14 }}>
      {!!(error || history.error || settings.error) && <ErrorState error={error ?? history.error ?? settings.error} />}
      <div><span className="label">图片模型 ID</span><Input value={model} onChange={e => { setModel(e.target.value); setSelected(null) }} /></div>
      <div><span className="label">新提示词</span><TextArea value={prompt} onChange={e => { setPrompt(e.target.value); setSelected(null) }} style={{ minHeight: 100 }} /></div>
      {budget && <span className="muted">每日预算 {money(budget.rerunDailyBudget, budget.rerunCurrency)}</span>}
      {current?.state === "estimated" && current.estimatedCost == null && <div className="banner">缺少该模型的费用依据，暂时无法确认收费生成</div>}
      {current?.state === "estimated" && current.estimatedCost != null && !canConfirm && <div className="banner">费用预估超出每日预算，或货币设置不一致</div>}
      {current && <><Badge>{stateName[current.state]}</Badge>{current.error && <ErrorState error={current.error} />}</>}
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="stack" style={{ gap: 8 }}><span className="label">原始结果</span>{task.outputs.length ? task.outputs.map((m, i) => <Thumb key={i} media={m} w="100%" ratio={4 / 3} onClick={() => window.open(m.url, "_blank", "noopener")} />) : <Empty compact title="没有原始输出" />}</div>
        <div className="stack" style={{ gap: 8 }}><span className="label">重跑结果</span>{current?.result.length ? current.result.map((m, i) => <Thumb key={i} media={m} w="100%" ratio={4 / 3} onClick={() => window.open(m.url, "_blank", "noopener")} />) : <Empty compact title={current ? stateName[current.state] : "尚未生成"} />}{current?.state === "done" && <span className="muted">实际费用 {money(current.spentCost, current.currency)}</span>}</div>
      </div>
      {!!records.length && <div className="stack" style={{ gap: 8 }}><span className="label">本任务重跑记录</span>{records.map(r => <Button key={r.id} variant="ghost" onClick={() => { setSelected(r); setPrompt(r.prompt); setModel(r.model); setError(null) }}>{time(r.createdAt)} · {r.model} · {stateName[r.state]}</Button>)}</div>}
    </div>
  </Modal>
}
