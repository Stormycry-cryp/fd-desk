import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Line, Settings } from "@spec/contract"
import { useImports, useRoster, useSettings, useCall } from "../api/hooks"
import { call } from "../api/client"
import { useCtx, isoWeek } from "../lib/ctx"
import { lineName } from "../lib/labels"
import { num, time, weekLabel, weekdayNames } from "../lib/format"
import { Button, NumberField, Segmented, IconButton, cx } from "../ui/controls"
import { Badge, Card, Empty, ErrorState, Skel } from "../ui/display"
import { Icon } from "../ui/icons"
import { Select, toast } from "../ui/overlays"

export const DataPage = () => {
  const [tab, setTab] = useState<"imports" | "settings">("imports")
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>数据</h1>
          <div className="meta">
            <span>导入、覆盖与口径设置</span>
          </div>
        </div>
        <div className="actions">
          <Segmented value={tab} onChange={setTab} options={[{ value: "imports", label: "导入与覆盖", icon: "database" }, { value: "settings", label: "设置", icon: "sliders" }]} />
        </div>
      </div>
      {tab === "imports" ? <Imports /> : <SettingsForm />}
    </div>
  )
}

const Imports = () => {
  const q = useImports()
  const { meta, line } = useCtx()
  const qc = useQueryClient()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const refresh = () => qc.invalidateQueries()
  const upload = async (files: FileList | File[]) => {
    setBusy(true)
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData()
        fd.append("file", f)
        const job = await call("POST /api/imports", { body: fd })
        if (job.state === "failed") throw new Error(job.error ?? "导入失败")
        toast(`${job.file}：新增 ${num(job.inserted)}，更新 ${num(job.updated)}`, { tone: "ok" })
      }
      refresh()
    } catch (e: any) {
      toast(e.message, { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  const scan = async () => {
    setBusy(true)
    try {
      const jobs = await call("POST /api/imports/scan")
      toast(jobs.length ? `导入了 ${jobs.length} 个文件` : "没有新文件", { tone: "ok" })
      refresh()
    } catch (e: any) {
      toast(e.message, { tone: "error" })
    } finally {
      setBusy(false)
    }
  }
  const weeks = useMemo(() => [...(meta?.weeks ?? [])].reverse(), [meta])
  return (
    <div className="grid">
      <div className="span-8 stack" style={{ gap: 16 }}>
        <div
          className={cx("dropzone", over && "over")}
          onClick={() => input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
          }}
        >
          <input ref={input} type="file" accept=".xlsx,.csv.gz" multiple hidden disabled={busy} onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = "" }} />
          <span className="glyph">{busy ? <span className="btn" style={{ padding: 0, height: "auto" }}><span className="spinner" /></span> : <Icon name="upload" />}</span>
          <b style={{ color: "var(--ink)", fontWeight: 500 }}>拖入生成记录导出文件</b>
          <span style={{ fontSize: 13.5 }}>支持 .xlsx 和 .csv.gz，按任务主键更新记录</span>
        </div>
        <Card flush title="导入记录" actions={<Button size="sm" icon="refresh" loading={busy} onClick={scan}>扫描收件箱</Button>}>
          {q.isLoading ? (
            <div style={{ padding: 16 }}><Skel h={120} /></div>
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : q.data?.length ? (
            <table className="table flush">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>覆盖</th>
                  <th className="r">行数</th>
                  <th className="r">灵感成款</th>
                  <th className="r">AI视频</th>
                  <th className="r">新增 / 更新</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <Icon name={j.state === "failed" ? "alert" : "inbox"} size="sm" className={j.state === "failed" ? "down" : "faint"} />
                        <span className="ellipsis" style={{ maxWidth: 300 }}>{j.file}</span>
                        {j.error && <Badge tone="warn">{j.error}</Badge>}
                      </span>
                    </td>
                    <td className="num">{j.from && j.to ? `${j.from.slice(5)} – ${j.to.slice(5)}` : "—"}</td>
                    <td className="r num">{num(j.rows)}</td>
                    <td className="r num">{num(j.byLine.inspiration)}</td>
                    <td className="r num">{num(j.byLine.video)}</td>
                    <td className="r num">
                      {num(j.inserted)} <span className="faint">/ {num(j.updated)}</span>
                    </td>
                    <td className="faint">{time(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty icon="inbox" title="还没有导入" compact />
          )}
        </Card>
      </div>
      <Card className="span-4" title="覆盖" sub="每周哪几天有数据">
        {meta ? (
          <div className="coverage-grid">
            <span />
            {weekdayNames.map((d) => (
              <span key={d} className="h">
                {d}
              </span>
            ))}
            <span />
            {weeks.map((w) => {
              const c = meta.coverage.find((x) => x.week === w && x.line === line)
              const start = new Date(`${w}T00:00:00+08:00`).getTime()
              const on = new Set((c?.days ?? []).map((d) => Math.round((new Date(`${d.slice(0, 10)}T00:00:00+08:00`).getTime() - start) / 86400000)))
              return (
                <div key={w} style={{ display: "contents" }}>
                  <span className="num" style={{ color: "var(--ink-2)" }}>{weekLabel(w)}</span>
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <span key={d} className={cx("cell", !on.has(d) && "off")} />
                  ))}
                  <span className="faint num" style={{ fontSize: 12.5, textAlign: "right" }}>
                    {c?.complete ? `W${isoWeek(w)}` : `${on.size} 天`}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <Skel h={200} />
        )}
        {meta?.lastImportAt && <div className="faint" style={{ fontSize: 13, marginTop: 14 }}>最近导入 {time(meta.lastImportAt)}</div>}
        <div className="faint" style={{ fontSize: 13, marginTop: 8 }}>{lineName[line]} · 状态刷新 {meta?.coverage.filter(c => c.line === line).map(c => c.refreshedAt).sort().at(-1) ? time(meta.coverage.filter(c => c.line === line).map(c => c.refreshedAt).sort().at(-1)!) : "—"}</div>
      </Card>
    </div>
  )
}

type Path = (string | number)[]
const getAt = (o: any, p: Path) => p.reduce((x, k) => x?.[k], o)
const setAt = (o: any, p: Path, v: any): any => (p.length ? { ...o, [p[0]]: setAt(o?.[p[0]], p.slice(1), v) } : v)

const SettingsForm = () => {
  const q = useSettings()
  const { week } = useCtx()
  const save = useCall("PUT /api/settings", ["GET /api/settings", "GET /api/meta", "GET /api/overview", "GET /api/enterprises", "GET /api/alerts"])
  const [draft, setDraft] = useState<Settings | null>(null)
  const [line, setLine] = useState<Line>("inspiration")
  const roster = useRoster(line, week)
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data)
  }, [q.data])
  if (q.isLoading || !draft) return q.error ? <ErrorState error={q.error} /> : <Skel h={400} r={12} />
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data)
  const f = (p: Path, opts: { suffix?: string; percent?: boolean; step?: number; min?: number } = {}) => <NumberField size="sm" width={getAt(draft, p) >= 1000 ? 120 : 104} value={getAt(draft, p)} onChange={(v) => setDraft(setAt(draft, p, v))} suffix={opts.suffix} percent={opts.percent} step={opts.step ?? (opts.percent ? 1 : 1)} min={opts.min ?? 0} />
  const T = (l: Line) => ["thresholds", l]
  const ex = draft.excluded[line]
  const rows = roster.data?.rows ?? []
  return (
    <div style={{ maxWidth: 880 }}>
      <div className="settings-group">
      <Card title="层级阈值" actions={<Segmented size="sm" value={line} onChange={setLine} options={[{ value: "inspiration", label: lineName.inspiration }, { value: "video", label: lineName.video }]} />}>
        <div className="form-row">
          <div className="lbl">
            <span>重度</span>
            <span className="d">任务数且使用天数都达到</span>
          </div>
          <div className="ctl">
            {f([...T(line), "heavy", "tasks"], { suffix: "个" })}
            {f([...T(line), "heavy", "days"], { suffix: "天" })}
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">
            <span>中度</span>
            <span className="d">任务数达到但天数不够的算集中</span>
          </div>
          <div className="ctl">
            {f([...T(line), "medium", "tasks"], { suffix: "个" })}
            {f([...T(line), "medium", "days"], { suffix: "天" })}
          </div>
        </div>
        <div className="form-row">
          <div className="lbl">
            <span>大客户基数</span>
            <span className="d">上周同星期达到这个任务数才判断掉量和上涨</span>
          </div>
          <div className="ctl">{f([...T(line), "moverBase"], { suffix: "个" })}</div>
        </div>
      </Card>
      </div>
      <div className="settings-group">
        <Card title="预警">
          <div className="form-row">
            <div className="lbl">
              <span>卡住</span>
              <span className="d">任务数 · 卡住占比 · 或下载率低于</span>
            </div>
            <div className="ctl">
              {f(["alerts", "stuck", "minTasks"], { suffix: "个" })}
              {f(["alerts", "stuck", "stuckShare"], { percent: true })}
              {f(["alerts", "stuck", "downloadRate"], { percent: true })}
            </div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>空耗</span>
              <span className="d">视频耗点 · 且下载率低于</span>
            </div>
            <div className="ctl">
              {f(["alerts", "waste", "minPoints"], { suffix: "点", step: 100 })}
              {f(["alerts", "waste", "downloadRate"], { percent: true })}
            </div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>新客未下载 · 模型不匹配 · 失败集中 · 可沉淀</span>
            </div>
            <div className="ctl">
              {f(["alerts", "coldStart", "minTasks"], { suffix: "个" })}
              {f(["alerts", "mismatch", "minTasks"], { suffix: "个" })}
              {f(["alerts", "failures", "minCount"], { suffix: "次" })}
              {f(["alerts", "reuse", "minUses"], { suffix: "次" })}
            </div>
          </div>
        </Card>
      </div>
      <div className="settings-group">
        <Card title="客户池">
          <div className="form-row">
            <div className="lbl">
              <span>帮助</span>
              <span className="d">卡住占比达到 · 或下载率低于</span>
            </div>
            <div className="ctl">
              {f(["pools", "help", "stuckShare"], { percent: true })}
              {f(["pools", "help", "downloadRate"], { percent: true })}
            </div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>召回</span>
              <span className="d">历史单周任务达到</span>
            </div>
            <div className="ctl">{f(["pools", "recall", "minPeakTasks"], { suffix: "个" })}</div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>下载信号存疑</span>
              <span className="d">任务数达到且下载率低于时不判断下载相关问题</span>
            </div>
            <div className="ctl">
              {f(["pools", "unreliable", "minTasks"], { suffix: "个" })}
              {f(["pools", "unreliable", "downloadRate"], { percent: true })}
            </div>
          </div>
        </Card>
      </div>
      <div className="settings-group">
        <Card title="排除企业" sub={lineName[line]}>
          <div className="stack" style={{ gap: 8 }}>
            {ex.map((id) => {
              const r = rows.find((x) => x.enterprise.id === id)
              return (
                <div key={id} className="row" style={{ gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-2)" }}>
                  <Icon name="building" size="sm" className="faint" />
                  <span style={{ flex: 1 }}>{r?.enterprise.name ?? id}</span>
                  {r && <span className="faint num">{num(r.tasks)} 个任务</span>}
                  <IconButton size="sm" icon="x" label="移除" onClick={() => setDraft(setAt(draft, ["excluded", line], ex.filter((x) => x !== id)))} />
                </div>
              )
            })}
            {!ex.length && <span className="faint">没有排除企业</span>}
            <Select
              value={null}
              placeholder="添加企业"
              search
              onChange={(v) => setDraft(setAt(draft, ["excluded", line], [...ex, v]))}
              options={rows.filter((r) => !ex.includes(r.enterprise.id)).sort((a, b) => b.tasks - a.tasks).map((r) => ({ value: r.enterprise.id, label: r.enterprise.name, hint: `${num(r.tasks)} 个任务` }))}
              width={320}
              popWidth={380}
            />
          </div>
        </Card>
      </div>
      <div className="settings-group">
        <Card title="其他">
          <div className="form-row">
            <div className="lbl">
              <span>重跑每日预算</span>
            </div>
            <div className="ctl">
              {f(["rerunDailyBudget"], { step: 0.1 })}
              <Select value={draft.rerunCurrency} onChange={v => setDraft({ ...draft, rerunCurrency: v as Settings["rerunCurrency"] })} options={[{ value: "CNY", label: "人民币 CNY" }, { value: "USD", label: "美元 USD" }]} width={150} />
            </div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>推送每日上限</span>
            </div>
            <div className="ctl">{f(["pushDailyLimit"], { suffix: "人" })}</div>
          </div>
          <div className="form-row">
            <div className="lbl">
              <span>提示词合并相似度</span>
            </div>
            <div className="ctl">{f(["clusters", "similarity"], { percent: true })}</div>
          </div>
        </Card>
      </div>
      {dirty && (
        <div className="savebar">
          <Icon name="info" size="sm" />
          <span style={{ flex: 1 }}>修改会重新计算层级、池和预警</span>
          <Button size="sm" variant="ghost" onClick={() => setDraft(q.data!)}>
            还原
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ body: draft }, { onSuccess: (s) => (setDraft(s), toast("已保存", { tone: "ok" })), onError: (e: any) => toast(e.message, { tone: "error" }) })}>
            保存
          </Button>
        </div>
      )}
    </div>
  )
}
