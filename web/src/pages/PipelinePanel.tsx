import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { JobKind, PipelineJobKind, PipelineRun, PipelineStep } from "@spec/contract"
import { call } from "../api/client"
import { errorText, usePipeline } from "../api/next"
import { useCtx } from "../lib/ctx"
import { time, weekShort } from "../lib/format"
import { Button, cx } from "../ui/controls"
import { Card, Empty, ErrorState, Skel } from "../ui/display"
import { Icon } from "../ui/icons"
import { JobProgress } from "../ui/insight"
import { Tooltip, toast } from "../ui/overlays"

export const stepName: Record<JobKind, string> = {
  facts: "统计事实",
  profiles: "企业档案",
  movement: "涨跌原因",
  opportunities: "模板机会",
  followups: "跟进建议",
  monitor: "模板监控",
  draft_write: "模板撰写",
  finding_recheck: "结论核对",
  record_analysis: "记录分析",
  export: "导出",
}

const order: PipelineJobKind[] = ["facts", "profiles", "movement", "opportunities", "followups", "monitor"]

const dur = (s: PipelineStep) => {
  if (!s.startedAt) return null
  const ms = (s.finishedAt ? new Date(s.finishedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime()
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${(sec / 3600).toFixed(1)} 小时`
}

export const PipelinePanel = () => {
  const q = usePipeline()
  const { week } = useCtx()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (steps?: PipelineJobKind[], init?: boolean) => {
    setBusy(init ? "init" : steps?.join() ?? "all")
    try {
      if (init) await call("POST /api/profiles/init")
      else await call("POST /api/pipeline/run", { body: { steps, week: week ?? undefined } })
      toast(init ? "已开始初始化全部档案" : steps?.length === 1 ? `已开始重跑${stepName[steps[0]]}` : "已开始运行流水线")
      qc.invalidateQueries({ queryKey: ["GET /api/pipeline"] })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    } finally {
      setBusy(null)
    }
  }
  if (q.isLoading) return <Skel h={360} r={12} />
  if (q.error || !q.data) return <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card>
  const { latest, history, limits } = q.data
  const running = !!latest && !latest.finishedAt
  return (
    <div className="grid">
      <Card
        className="span-8"
        title="流水线"
        sub={latest ? `${latest.trigger === "collector" ? "采集后自动" : "手动"} · ${time(latest.startedAt)}${latest.week ? ` · ${weekShort(latest.week)} 周` : ""}` : undefined}
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="ghost" icon="layers" loading={busy === "init"} disabled={running} onClick={() => run(undefined, true)}>
              初始化档案
            </Button>
            <Button size="sm" variant="primary" icon="play" loading={busy === "all" || running} onClick={() => run()}>
              {running ? "运行中" : "运行全部"}
            </Button>
          </div>
        }
      >
        {latest ? (
          <div className="pl-steps">
            {order.map((k, i) => {
              const s = latest.steps.find((x) => x.kind === k)
              return <StepRow key={k} k={k} i={i} s={s ?? null} disabled={running} busy={busy === k} onRun={() => run([k])} />
            })}
          </div>
        ) : (
          <Empty icon="layers" title="还没有运行过" text="采集完成后会自动运行" compact />
        )}
      </Card>
      <div className="span-4 stack" style={{ gap: 16 }}>
        <Card title="限制">
          <div className="pl-limits">
            <div><b className="num">{limits.profilesPerRun}</b><span>每次更新档案数</span></div>
            <div><b className="num">{limits.concurrency}</b><span>并发</span></div>
          </div>
        </Card>
        <Card flush title="历史" sub={history.length ? `${history.length} 次` : undefined}>
          {history.length ? history.slice(0, 12).map((r) => <HistoryRow key={r.id} r={r} />) : <Empty title="没有记录" compact />}
        </Card>
      </div>
    </div>
  )
}

const StepRow = ({ k, i, s, disabled, busy, onRun }: { k: PipelineJobKind; i: number; s: PipelineStep | null; disabled: boolean; busy: boolean; onRun: () => void }) => {
  const st = s?.state ?? "queued"
  return (
    <div className={cx("pl-step", s ? st : "idle")}>
      <span className="pl-idx num">{st === "done" ? <Icon name="check" size="xs" /> : st === "failed" ? <Icon name="x" size="xs" /> : i + 1}</span>
      <div className="pl-body">
        <div className="pl-top">
          <b>{stepName[k]}</b>
          {s?.detail && <span className="faint ellipsis">{s.detail}</span>}
        </div>
        {s && (st === "running" || st === "queued") && <JobProgress state={st} done={s.progress.done} total={s.progress.total || undefined} label={s.progress.total ? `${s.progress.done}/${s.progress.total}` : undefined} />}
        {s?.error && <div className="pl-err">{s.error.message}</div>}
      </div>
      <span className="pl-meta num">
        {s && st === "done" && s.progress.total > 0 && <span>{s.progress.done}/{s.progress.total}</span>}
        {s && dur(s) && <span>{dur(s)}</span>}
      </span>
      <Tooltip content={`只重跑${stepName[k]}`}>
        <Button size="xs" variant="ghost" icon="refresh" loading={busy} disabled={disabled} onClick={onRun} />
      </Tooltip>
    </div>
  )
}

const HistoryRow = ({ r }: { r: PipelineRun }) => {
  const failed = r.steps.filter((s) => s.state === "failed").length
  const done = r.steps.filter((s) => s.state === "done").length
  return (
    <div className="row-item" style={{ cursor: "default" }}>
      <Icon name={failed ? "alert" : r.finishedAt ? "check" : "clock"} size="sm" className={failed ? "down" : r.finishedAt ? "up" : "faint"} />
      <span className="name">{time(r.startedAt)}</span>
      <span className="nums faint">
        {r.trigger === "collector" ? "自动" : "手动"} · {done}/{r.steps.length}{failed ? ` · ${failed} 失败` : ""}
      </span>
    </div>
  )
}
