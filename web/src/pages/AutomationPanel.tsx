import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Line } from "@spec/contract"
import { call } from "../api/client"
import { useCall } from "../api/hooks"
import { Button } from "../ui/controls"
import { Badge, Card, ErrorState } from "../ui/display"

export const AutomationPanel = ({ line, week }: { line: Line; week: string }) => {
  const qc = useQueryClient()
  const storageKey = `fd-desk-analysis:${line}:${week}`
  const [id, setId] = useState(() => localStorage.getItem(storageKey))
  const create = useCall("POST /api/automation/analysis")
  const status = useQuery({
    queryKey: ["GET /api/automation/analysis/:id", id],
    queryFn: () => call("GET /api/automation/analysis/:id", { params: { id: id! } }),
    enabled: !!id,
    retry: false,
    refetchInterval: q => q.state.data?.state === "queued" || q.state.data?.state === "running" ? 2000 : false,
  })
  useEffect(() => {
    if (status.data?.state === "done") {
      ["GET /api/enterprises", "GET /api/enterprises/:id", "GET /api/touches", "GET /api/drafts", "GET /api/clusters"].forEach(key => qc.invalidateQueries({ queryKey: [key] }))
    }
  }, [status.data, qc])
  const running = status.data?.state === "queued" || status.data?.state === "running"
  const labels = { queued: "等待执行", running: "分析中", done: "分析完成", failed: "分析失败" }
  return <Card title="模型分析" sub="本机 Codex CLI" actions={<Button variant="soft" icon="wand" loading={create.isPending || running} disabled={!!id && status.isLoading} onClick={() => create.mutate({ body: { line, week } }, { onSuccess: job => { localStorage.setItem(storageKey, job.id); setId(job.id) } })}>{id ? "再次分析" : "生成企业小结与触达草稿"}</Button>}>
    <div className="stack" style={{ gap: 8 }}>
      <span className="muted">根据本周真实指标撰写企业小结、下一步、触达话术和模板草稿。手工内容受到保护。</span>
      {status.data && <Badge tone={status.data.state === "done" ? "up" : status.data.state === "failed" ? "warn" : "accent"}>{labels[status.data.state]}</Badge>}
      {(create.error || status.error || status.data?.error) && <ErrorState error={create.error ?? status.error ?? status.data?.error} retry={status.error ? () => status.refetch() : undefined} />}
    </div>
  </Card>
}
