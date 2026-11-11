import { useEffect, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { ReviseKind, Template, TemplateContent, TemplateKind, TemplateSlot, TemplateState, TemplateVariable } from "@spec/contract"
import { call, type CallOpts } from "../../api/client"
import { errorText, useTemplate, watchJob } from "../../api/next"
import { useCtx } from "../../lib/ctx"
import { lineName } from "../../lib/labels"
import { navigate } from "../../lib/route"
import { num, pct, time } from "../../lib/format"
import { exportOne } from "../../lib/download"
import { Button, Checkbox, IconButton, Input, Segmented, TextArea, cx } from "../../ui/controls"
import { Empty, ErrorState, Skel, SourceTag, Stepper, Thumb } from "../../ui/display"
import { Icon } from "../../ui/icons"
import { JobProgress } from "../../ui/insight"
import { DiffText, PromptEditor, VersionList } from "../../ui/prompt"
import { Menu, Tooltip, toast } from "../../ui/overlays"
import { useKey } from "../../lib/useKey"
import { checkName, kindName, reviseName, stateName, stateOrder } from "./names"

const same = (a: TemplateContent, b: TemplateContent) => JSON.stringify(a) === JSON.stringify(b)

export const TemplateDetail = ({ id }: { id: string }) => {
  const q = useTemplate(id)
  if (q.isLoading) return <DetailSkeleton />
  if (q.error || !q.data) return <div className="page"><ErrorState error={q.error} retry={() => q.refetch()} /></div>
  return <Detail key={`${q.data.id}:${q.data.current.version}`} t={q.data} />
}

const DetailSkeleton = () => (
  <div className="page wide">
    <Skel w={280} h={28} />
    <div className="tpl-detail" style={{ marginTop: 20 }}>
      <Skel h={520} r={12} />
      <Skel h={520} r={12} />
      <Skel h={520} r={12} />
    </div>
  </div>
)

const Detail = ({ t }: { t: Template }) => {
  const qc = useQueryClient()
  const { line } = useCtx()
  const [c, setC] = useState<TemplateContent>(t.current.content)
  const [saving, setSaving] = useState(false)
  const dirty = !same(c, t.current.content)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["GET /api/templates/:id"] })
    qc.invalidateQueries({ queryKey: ["GET /api/templates"] })
  }
  const patch = async (body: NonNullable<CallOpts<"PATCH /api/templates/:id">["body"]>, ok?: string) => {
    try {
      await call("PATCH /api/templates/:id", { params: { id: t.id }, body })
      refresh()
      if (ok) toast(ok, { tone: "ok", ms: 1400 })
      return true
    } catch (e) {
      toast(errorText(e), { tone: "error" })
      return false
    }
  }
  const save = async () => {
    if (!dirty) return
    setSaving(true)
    await patch({ content: c }, "已保存为新版本")
    setSaving(false)
  }
  useKey(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        save()
      }
    },
    [c, dirty],
    true,
  )
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => dirty && e.preventDefault()
    window.addEventListener("beforeunload", f)
    return () => window.removeEventListener("beforeunload", f)
  }, [dirty])
  const del = async () => {
    try {
      await call("DELETE /api/templates/:id", { params: { id: t.id } })
      qc.invalidateQueries({ queryKey: ["GET /api/templates"] })
      navigate({ tpl: null })
      toast("已删除")
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  const back = () => {
    if (dirty && !confirm("有未保存的修改，确定离开？")) return
    navigate({ tpl: null })
  }
  const exportKind = t.kind === "official" ? "templates_official" : "templates_custom"
  return (
    <div className="page wide">
      <div className="tpl-top">
        <button className="back" onClick={back}>
          <Icon name="chevLeft" size="sm" />
          模板
        </button>
        <div className="tpl-title">
          <h1 className="ellipsis">{c.title || "未命名"}</h1>
          <div className="meta">
            <span>{lineName[t.line]}</span>
            <span className="faint num">v{t.current.version} · {time(t.updatedAt)}</span>
            {dirty && <span className="tpl-dirty">未保存</span>}
          </div>
        </div>
        <span className="spacer" />
        <Segmented size="sm" value={t.kind} onChange={(k: TemplateKind) => patch({ kind: k, ...(k === "official" ? { target: null } : {}) }, `已改为${kindName[k]}`)} options={[{ value: "official", label: "官方" }, { value: "custom", label: "定制" }]} />
        <Button icon="image" onClick={() => navigate({ page: "playground", tpl: t.id, run: null })}>
          试验台
        </Button>
        <Button icon="download" onClick={() => exportOne(exportKind, { line, ids: t.id }, `${kindName[t.kind]}模板_${c.title}`)}>
          导出
        </Button>
        <Button variant="primary" icon="check" disabled={!dirty} loading={saving} onClick={save}>
          保存
        </Button>
        <Menu
          width={180}
          items={[{ key: "del", label: "删除模板", icon: "trash", danger: true, onSelect: () => confirm("删除这个模板？") && del() }]}
          trigger={({ toggle, ref }) => <IconButton ref={ref as never} icon="more" label="更多" onClick={toggle} />}
        />
      </div>
      <div className="tpl-steps">
        <Stepper<TemplateState> steps={stateOrder} value={t.state} labels={stateName} onChange={(s) => patch({ state: s }, `阶段：${stateName[s]}`)} />
        {t.review.suggestedState && t.review.suggestedState !== t.state && (
          <button className="tpl-suggest" onClick={() => patch({ state: t.review.suggestedState! }, `阶段：${stateName[t.review.suggestedState!]}`)}>
            <Icon name="sparkle" size="xs" />
            建议推进到「{stateName[t.review.suggestedState]}」
          </button>
        )}
        {t.kind === "custom" && (
          <span className="tpl-target">
            <Icon name="building" size="xs" />
            {t.target ? (
              <button className="link-btn" onClick={() => navigate({ ent: t.target!.id })}>
                {t.target.name}
              </button>
            ) : (
              <span className="faint">未指定企业</span>
            )}
          </span>
        )}
      </div>
      <div className="tpl-detail">
        <ContentCol c={c} setC={setC} />
        <AiCol t={t} dirty={dirty} />
        <ReviewCol t={t} c={c} onCover={() => navigate({ page: "playground", tpl: t.id, run: t.review.trial?.runId ?? null })} />
      </div>
    </div>
  )
}

const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <div className="tf">
    <div className="tf-l">
      {label}
      {hint && <span className="faint">{hint}</span>}
    </div>
    {children}
  </div>
)

const ContentCol = ({ c, setC }: { c: TemplateContent; setC: (c: TemplateContent) => void }) => {
  const set = <K extends keyof TemplateContent>(k: K, v: TemplateContent[K]) => setC({ ...c, [k]: v })
  const used = useMemo(() => {
    const s = new Set<string>()
    for (const m of c.prompt.matchAll(/\{\{([^{}]+)\}\}|\[([^[\]]+)\]/g)) s.add(m[1] ?? m[2])
    return s
  }, [c.prompt])
  const missing = [...used].filter((n) => !c.slots.some((s) => s.name === n) && !c.variables.some((v) => v.name === n))
  return (
    <section className="tpl-col">
      <h3>内容</h3>
      <Field label="标题">
        <Input value={c.title} onChange={(e) => set("title", e.target.value)} placeholder="一句话说清做什么" />
      </Field>
      <Field label="解决的任务">
        <Input value={c.task} onChange={(e) => set("task", e.target.value)} placeholder="例如：把平铺图换成模特上身图" />
      </Field>
      <Field label="提示词" hint={`${c.prompt.length} 字`}>
        <PromptEditor value={c.prompt} onChange={(v) => set("prompt", v)} slots={c.slots.map((s) => s.name)} variables={c.variables.map((v) => v.name)} minRows={6} placeholder="用 {{槽位}} 表示上传的图片，用 [可变项] 表示可选的文字" />
        {missing.length > 0 && (
          <div className="tf-warn">
            <Icon name="alert" size="xs" />
            {missing.map((m) => `「${m}」`).join("")} 没有定义
            <button className="link-btn" onClick={() => setC({ ...c, slots: [...c.slots, ...missing.filter((m) => c.prompt.includes(`{{${m}}}`)).map((name) => ({ name, required: true, requirement: "" }))], variables: [...c.variables, ...missing.filter((m) => c.prompt.includes(`[${m}]`)).map((name) => ({ name, default: "", options: [] }))] })}>
              补上
            </button>
          </div>
        )}
      </Field>
      <Field label="槽位" hint="上传的图片">
        <SlotTable xs={c.slots} onChange={(v) => set("slots", v)} />
      </Field>
      <Field label="可变项" hint="可选的文字">
        <VarTable xs={c.variables} onChange={(v) => set("variables", v)} />
      </Field>
      <div className="tf-grid">
        <Field label="推荐模型">
          <Input value={c.model ?? ""} onChange={(e) => set("model", e.target.value || null)} placeholder="—" />
        </Field>
        <Field label="比例">
          <Input value={c.ratio ?? ""} onChange={(e) => set("ratio", e.target.value || null)} placeholder="—" />
        </Field>
        <Field label="分辨率">
          <Input value={c.resolution ?? ""} onChange={(e) => set("resolution", e.target.value || null)} placeholder="—" />
        </Field>
      </div>
      <div className="tf-grid two">
        <Field label="适用">
          <TextArea value={c.fits} onChange={(e) => set("fits", e.target.value)} placeholder="什么样的图效果好" style={{ minHeight: 64 }} />
        </Field>
        <Field label="不适用">
          <TextArea value={c.avoids} onChange={(e) => set("avoids", e.target.value)} placeholder="什么情况别用" style={{ minHeight: 64 }} />
        </Field>
      </div>
    </section>
  )
}

const SlotTable = ({ xs, onChange }: { xs: TemplateSlot[]; onChange: (v: TemplateSlot[]) => void }) => (
  <div className="kvt">
    {xs.map((s, i) => (
      <div key={i} className="kvt-row">
        <Input size="sm" value={s.name} onChange={(e) => onChange(xs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="名称" style={{ width: 140 }} />
        <Input size="sm" value={s.requirement} onChange={(e) => onChange(xs.map((x, k) => (k === i ? { ...x, requirement: e.target.value } : x)))} placeholder="对图片的要求" style={{ flex: 1 }} />
        <Checkbox checked={s.required} onChange={(v) => onChange(xs.map((x, k) => (k === i ? { ...x, required: v } : x)))}>
          必填
        </Checkbox>
        <IconButton size="xs" icon="x" label="删除" onClick={() => onChange(xs.filter((_, k) => k !== i))} />
      </div>
    ))}
    <button className="kvt-add" onClick={() => onChange([...xs, { name: `图${xs.length + 1}`, required: true, requirement: "" }])}>
      <Icon name="plus" size="xs" />
      添加槽位
    </button>
  </div>
)

const VarTable = ({ xs, onChange }: { xs: TemplateVariable[]; onChange: (v: TemplateVariable[]) => void }) => (
  <div className="kvt">
    {xs.map((v, i) => (
      <div key={i} className="kvt-row">
        <Input size="sm" value={v.name} onChange={(e) => onChange(xs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} placeholder="名称" style={{ width: 110 }} />
        <Input size="sm" value={v.default} onChange={(e) => onChange(xs.map((x, k) => (k === i ? { ...x, default: e.target.value } : x)))} placeholder="默认值" style={{ width: 110 }} />
        <Input size="sm" value={v.options.join("、")} onChange={(e) => onChange(xs.map((x, k) => (k === i ? { ...x, options: e.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) } : x)))} placeholder="可选值，用顿号分隔" style={{ flex: 1 }} />
        <IconButton size="xs" icon="x" label="删除" onClick={() => onChange(xs.filter((_, k) => k !== i))} />
      </div>
    ))}
    <button className="kvt-add" onClick={() => onChange([...xs, { name: `可变项${xs.length + 1}`, default: "", options: [] }])}>
      <Icon name="plus" size="xs" />
      添加可变项
    </button>
  </div>
)

const AiCol = ({ t, dirty }: { t: Template; dirty: boolean }) => {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<ReviseKind | null>(null)
  const [ins, setIns] = useState("")
  const revise = async (kind: ReviseKind) => {
    if (dirty && !confirm("有未保存的修改，AI 会基于当前已保存的版本修改。继续？")) return
    setBusy(kind)
    try {
      const j = await call("POST /api/templates/:id/revise", { params: { id: t.id }, body: { kind, instruction: kind === "custom" || kind === "specific" ? ins.trim() || undefined : undefined, runId: kind === "from_trial" ? t.review.trial?.runId : undefined } })
      watchJob(j, (r) => {
        setBusy(null)
        setIns("")
        qc.invalidateQueries({ queryKey: ["GET /api/templates/:id"] })
        toast(r.state === "done" ? "已生成新版本" : `修改失败：${r.error?.message ?? ""}`, { tone: r.state === "done" ? "ok" : "error" })
      })
    } catch (e) {
      setBusy(null)
      toast(errorText(e), { tone: "error" })
    }
  }
  const restore = async (v: number) => {
    try {
      await call("POST /api/templates/:id/restore", { params: { id: t.id }, body: { version: v } })
      qc.invalidateQueries({ queryKey: ["GET /api/templates/:id"] })
      toast(`已回退到 v${v}`, { tone: "ok" })
    } catch (e) {
      toast(errorText(e), { tone: "error" })
    }
  }
  const kinds: ReviseKind[] = ["shorter", "general", "specific", ...(t.review.trial ? (["from_trial"] as ReviseKind[]) : [])]
  return (
    <section className="tpl-col">
      <h3>AI 修改</h3>
      {busy ? (
        <div className="ai-busy">
          <JobProgress state="running" label={`正在${reviseName[busy]}`} />
        </div>
      ) : (
        <>
          <div className="ai-btns">
            {kinds.map((k) => (
              <Button key={k} size="sm" icon={k === "shorter" ? "minus" : k === "general" ? "users" : k === "specific" ? "target" : "image"} onClick={() => revise(k)}>
                {reviseName[k]}
              </Button>
            ))}
          </div>
          <div className="ai-ins">
            <TextArea value={ins} onChange={(e) => setIns(e.target.value)} placeholder="或者直接说要怎么改，⌘↵ 发送" style={{ minHeight: 60 }} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && ins.trim() && (e.preventDefault(), revise("custom"))} />
            <Button size="sm" variant="primary" icon="wand" disabled={!ins.trim()} onClick={() => revise("custom")}>
              修改
            </Button>
          </div>
        </>
      )}
      <h3 style={{ marginTop: 8 }}>
        版本<span className="faint num">{t.versions.length}</span>
      </h3>
      <VersionList versions={t.versions} current={t.current.version} onRestore={restore} />
    </section>
  )
}

const ReviewCol = ({ t, c, onCover }: { t: Template; c: TemplateContent; onCover: () => void }) => {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const r = t.review
  const rerun = async () => {
    setBusy(true)
    try {
      const j = await call("POST /api/templates/:id/review", { params: { id: t.id } })
      watchJob(j, (x) => {
        setBusy(false)
        qc.invalidateQueries({ queryKey: ["GET /api/templates/:id"] })
        if (x.state !== "done") toast(`评审失败：${x.error?.message ?? ""}`, { tone: "error" })
      })
    } catch (e) {
      setBusy(false)
      toast(errorText(e), { tone: "error" })
    }
  }
  const warns = r.checks.filter((x) => !x.ok).length
  const tr = r.trial
  const total = tr ? Math.max(1, tr.better + tr.same + tr.worse) : 1
  return (
    <section className="tpl-col">
      <h3>
        评审
        <span className={cx("faint", warns > 0 && "warn")}>{warns ? `${warns} 条提醒` : "全部通过"}</span>
        <span className="spacer" />
        {busy ? <JobProgress state="running" label="评审中" /> : <IconButton size="xs" icon="refresh" label="重新评审" onClick={rerun} />}
      </h3>
      <div className="chk">
        {r.checks.map((x) => (
          <div key={x.key} className={cx("chk-i", x.ok ? "ok" : "warn")}>
            <Icon name={x.ok ? "check" : "alert"} size="xs" />
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <span>{checkName[x.key]}</span>
              {x.message && <span className="chk-m">{x.message}</span>}
            </div>
          </div>
        ))}
      </div>
      {r.comment && (
        <div className="tpl-comment">
          <div className="row" style={{ gap: 6, marginBottom: 4 }}>
            <Icon name="sparkle" size="xs" />
            <span className="faint">评语</span>
            <SourceTag a={r.comment} />
          </div>
          {r.comment.text}
        </div>
      )}
      <h3 style={{ marginTop: 8 }}>试验</h3>
      {tr ? (
        <div className="tr-sum">
          <div className="tr-bar">
            <i className="up" style={{ width: `${(tr.better / total) * 100}%` }} />
            <i className="same" style={{ width: `${(tr.same / total) * 100}%` }} />
            <i className="down" style={{ width: `${(tr.worse / total) * 100}%` }} />
          </div>
          <div className="tr-nums num">
            <span><b className="up">{tr.better}</b> 更好</span>
            <span><b>{tr.same}</b> 差不多</span>
            <span><b className="down">{tr.worse}</b> 更差</span>
            <span className="spacer" />
            <span className="faint">{tr.usable}/{tr.cases} 可用</span>
          </div>
          <Button size="sm" icon="image" onClick={onCover}>
            打开试验
          </Button>
        </div>
      ) : (
        <div className="tr-empty">
          <span className="faint">还没试验</span>
          <Button size="sm" variant="soft" icon="image" onClick={onCover}>
            去试验台
          </Button>
        </div>
      )}
      <h3 style={{ marginTop: 8 }}>来源</h3>
      <div className="origin">
        <div className="origin-n">
          <div>
            <b className="num">{num(t.origin.uses)}</b>
            <span>次使用</span>
          </div>
          <div>
            <b className="num">{t.origin.enterprises}</b>
            <span>家企业</span>
          </div>
          <div>
            <b className="num">{pct(t.origin.downloadRate, 0)}</b>
            <span>下载率</span>
          </div>
        </div>
        {t.origin.originalPrompt ? (
          <details className="origin-p">
            <summary>原写法与当前对比</summary>
            <DiffText from={t.origin.originalPrompt} to={c.prompt} />
          </details>
        ) : null}
      </div>
      {t.cover ? (
        <>
          <h3 style={{ marginTop: 8 }}>封面</h3>
          <div className="cover">
            {t.cover.input && <Thumb media={t.cover.input} w={96} ratio={3 / 4} radius={8} />}
            {t.cover.input && <Icon name="arrowRight" size="sm" className="faint" />}
            <Thumb media={t.cover.output} w={96} ratio={3 / 4} radius={8} />
          </div>
        </>
      ) : (
        <Tooltip content="在试验台采用写法时选一张结果作为封面">
          <div className="cover-empty">
            <Icon name="image" size="sm" />
            没有封面
          </div>
        </Tooltip>
      )}
    </section>
  )
}

export { Empty }
