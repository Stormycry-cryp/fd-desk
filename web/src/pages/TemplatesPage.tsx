import { useMemo, useState } from "react"
import type { Cluster, DraftScope, DraftStatus, TemplateDraft } from "@spec/contract"
import { useClusters, useDrafts, useCall } from "../api/hooks"
import { useCtx } from "../lib/ctx"
import { draftStatusName, draftStatusOrder, lineName } from "../lib/labels"
import { navigate } from "../lib/route"
import { num, pct, time } from "../lib/format"
import { Button, Input, RadioGroup, Segmented, TextArea, IconButton } from "../ui/controls"
import { Badge, Card, CopyField, Empty, ErrorState, Rate, Skel, SourceTag, Stepper } from "../ui/display"
import { Icon } from "../ui/icons"
import { Menu, Modal, Tooltip, toast } from "../ui/overlays"
import { PushModal } from "./PushModal"

type ClusterFilter = "candidate" | "official" | "all"

export const TemplatesPage = () => {
  const { line, week, meta } = useCtx()
  const cq = useClusters(line, week)
  const dq = useDrafts(line)
  const [filter, setFilter] = useState<ClusterFilter>("candidate")
  const [creating, setCreating] = useState<Cluster | null>(null)
  const clusters = cq.data ?? []
  const shown = useMemo(() => clusters.filter((c) => (filter === "all" ? true : filter === "official" ? !!c.matchedTemplate : c.candidate)), [clusters, filter])
  const counts = { candidate: clusters.filter((c) => c.candidate).length, official: clusters.filter((c) => c.matchedTemplate).length, all: clusters.length }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>模板</h1>
          <div className="meta">
            <span>{lineName[line]}</span>
            {cq.data && (
              <span className="faint">
                {counts.all} 组重复提示词 · {counts.candidate} 组可以做成模板
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {meta?.fdAccount && (
            <Tooltip content={meta.fdAccount.externalShareAllowed ? "可以分享给团队外的客户成员" : "这个账号没有团队外分享权限，推送不可用"}>
              <Badge tone={meta.fdAccount.ready && meta.fdAccount.externalShareAllowed ? "up" : "warn"} dot>
                FD 账号 {meta.fdAccount.userName ?? "未登录"}
              </Badge>
            </Tooltip>
          )}
          <Button variant="primary" icon="plus" onClick={() => setCreating({ id: "", line, sample: "", uses: 0, enterprises: 0, downloadRate: 0, intent: null, matchedTemplate: null, candidate: true, topEnterprises: [], draftId: null })}>
            新建草稿
          </Button>
        </div>
      </div>
      <div className="split">
        <Card
          flush
          title="重复使用的提示词"
          actions={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "candidate", label: "可做模板", count: counts.candidate }, { value: "official", label: "已有官方", count: counts.official }, { value: "all", label: "全部", count: counts.all }]} />}
        >
          {cq.isLoading ? (
            <ListSkeleton />
          ) : cq.error ? (
            <ErrorState error={cq.error} />
          ) : shown.length ? (
            shown.map((c, i) => <ClusterRow key={c.id} c={c} rank={i + 1} onCreate={() => setCreating(c)} />)
          ) : (
            <Empty icon="template" title="没有" compact />
          )}
        </Card>
        <Card flush title="草稿" sub={dq.data ? `${dq.data.length}` : undefined}>
          {dq.isLoading ? <ListSkeleton /> : dq.error ? <ErrorState error={dq.error} /> : dq.data?.length ? dq.data.map((d) => <DraftItem key={d.id} d={d} />) : <Empty icon="template" title="还没有草稿" text="从左侧挑一组提示词开始" compact />}
        </Card>
      </div>
      <CreateDraft cluster={creating} onClose={() => setCreating(null)} />
    </div>
  )
}

const ClusterRow = ({ c, rank, onCreate }: { c: Cluster; rank: number; onCreate: () => void }) => (
  <div className="cluster">
    <span className="rank">{rank}</span>
    <div className="body">
      <div className="text">{c.sample}</div>
      <div className="meta">
        {c.intent && <Badge>{c.intent}</Badge>}
        <span>{c.enterprises} 家企业</span>
        <span className="row" style={{ gap: 6 }}>
          下载 <Rate value={c.downloadRate} width={36} />
        </span>
        {c.matchedTemplate && (
          <Badge tone="outline" icon="check">
            官方：{c.matchedTemplate.name}
          </Badge>
        )}
        {c.topEnterprises.slice(0, 2).map((e) => (
          <button key={e.enterprise.id} className="faint ellipsis" style={{ maxWidth: 150 }} onClick={() => navigate({ ent: e.enterprise.id })}>
            {e.enterprise.name} · {e.uses}
          </button>
        ))}
      </div>
    </div>
    <div className="stack" style={{ alignItems: "flex-end", gap: 8 }}>
      <div className="uses">
        <b>{num(c.uses)}</b>
        <span className="faint" style={{ fontSize: 12.5 }}>次</span>
      </div>
      {c.draftId ? (
        <Badge tone="accent" icon="check">已做草稿</Badge>
      ) : c.candidate ? (
        <Button size="xs" variant="soft" icon="wand" onClick={onCreate}>
          做成模板
        </Button>
      ) : null}
    </div>
  </div>
)

const DraftItem = ({ d }: { d: TemplateDraft }) => {
  const patch = useCall("PATCH /api/drafts/:id", ["GET /api/drafts"])
  const [push, setPush] = useState(false)
  const [editing, setEditing] = useState(false)
  const set = (body: Parameters<typeof patch.mutate>[0]["body"]) => patch.mutate({ params: { id: d.id }, body: { ...body, source: "manual" } }, { onError: (e: any) => toast(e?.missing ? "后端尚未提供模板接口" : e.message, { tone: "error" }) })
  return (
    <div className="draft-item">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">{d.title.text}</div>
          <div className="row" style={{ gap: 8, marginTop: 4, fontSize: 13, color: "var(--ink-4)" }}>
            {d.scene && <span>{d.scene}</span>}
            <span>·</span>
            <span>{time(d.createdAt)}</span>
            <SourceTag a={d.prompt} />
          </div>
        </div>
        <Tooltip content={d.scope === "owner" ? "来自具体企业的提示词，只能推给来源企业" : "已改写为通用内容，可推给任何企业"}>
          <span>
            <Badge tone={d.scope === "general" ? "accent" : "outline"} icon={d.scope === "general" ? "users" : "shield"}>
              {d.scope === "general" ? "通用" : "仅来源企业"}
            </Badge>
          </span>
        </Tooltip>
        <Menu
          width={200}
          items={[
            { key: "edit", label: "编辑", icon: "edit", onSelect: () => setEditing(true) },
            { key: "scope", label: d.scope === "owner" ? "改为通用" : "改为仅来源企业", icon: d.scope === "owner" ? "users" : "shield", onSelect: () => set({ scope: d.scope === "owner" ? "general" : "owner" }) },
          ]}
          trigger={({ toggle, ref }) => <IconButton ref={ref as any} size="sm" icon="more" label="更多" onClick={toggle} />}
        />
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--ink-2)", background: "var(--surface-2)", padding: "10px 12px", borderRadius: 8, boxShadow: "inset 0 0 0 1px var(--line-2)" }}>{d.prompt.text}</div>
      {d.slots.length > 0 && (
        <div className="slots">
          {d.slots.map((s, i) => (
            <span key={i} className="slot">
              <Icon name="image" size="xs" />
              {s}
            </span>
          ))}
        </div>
      )}
      <Stepper steps={draftStatusOrder} value={d.status} labels={draftStatusName} onChange={(s: DraftStatus) => set({ status: s })} />
      {d.link ? <CopyField value={d.link} open /> : null}
      <div className="row" style={{ gap: 8 }}>
        {d.pushedTo.length > 0 && (
          <span className="faint ellipsis" style={{ fontSize: 13, flex: 1 }}>
            已推送 {d.pushedTo.map((e) => e.name).join("、")}
          </span>
        )}
        <span className="spacer" />
        <Button size="sm" variant={d.status === "tested" || d.status === "published" ? "primary" : "secondary"} icon="send" onClick={() => setPush(true)} disabled={!d.sourceEnterprises.length && d.scope === "owner"}>
          推送
        </Button>
      </div>
      <PushModal open={push} onClose={() => setPush(false)} draft={d} enterprises={d.sourceEnterprises.map((e) => e.id)} />
      <EditDraft d={d} open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}

const EditDraft = ({ d, open, onClose }: { d: TemplateDraft; open: boolean; onClose: () => void }) => {
  const patch = useCall("PATCH /api/drafts/:id", ["GET /api/drafts"])
  const [title, setTitle] = useState(d.title.text)
  const [prompt, setPrompt] = useState(d.prompt.text)
  const [slots, setSlots] = useState(d.slots.join("、"))
  const [fd, setFd] = useState(d.fdTemplateId ? String(d.fdTemplateId) : "")
  const save = () =>
    patch.mutate(
      { params: { id: d.id }, body: { title, prompt, slots: slots.split(/[、,，]/).map((s) => s.trim()).filter(Boolean), fdTemplateId: fd ? Number(fd) : null, fdTemplateSource: fd ? d.fdTemplateSource ?? "managed" : null, source: "manual" } },
      { onSuccess: () => (toast("已保存", { tone: "ok", ms: 1500 }), onClose()), onError: (e: any) => toast(e.message, { tone: "error" }) },
    )
  return (
    <Modal open={open} onClose={onClose} title="编辑草稿" width={560} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" loading={patch.isPending} onClick={save}>保存</Button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <span className="label">标题</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <span className="label">提示词</span>
          <TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 120 }} />
        </div>
        <div className="grid" style={{ gridTemplateColumns: "1fr 160px", gap: 12 }}>
          <div>
            <span className="label">图片槽位</span>
            <Input value={slots} onChange={(e) => setSlots(e.target.value)} placeholder="服装图、面料图" />
          </div>
          <div>
            <span className="label">FD 模板 ID</span>
            <Input value={fd} onChange={(e) => setFd(e.target.value.replace(/\D/g, ""))} placeholder="推送后自动填" />
          </div>
        </div>
      </div>
    </Modal>
  )
}

const CreateDraft = ({ cluster, onClose }: { cluster: Cluster | null; onClose: () => void }) => {
  const { line } = useCtx()
  const create = useCall("POST /api/drafts", ["GET /api/drafts", "GET /api/clusters"])
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [slots, setSlots] = useState("服装图")
  const [scope, setScope] = useState<DraftScope>("owner")
  const [last, setLast] = useState<string | null>(null)
  if (cluster && cluster.id !== last) {
    setLast(cluster.id)
    setTitle(cluster.intent ? `${cluster.intent}` : "")
    setPrompt(cluster.sample)
    setScope("owner")
  }
  const submit = () =>
    create.mutate(
      { body: { line, title: title || prompt.slice(0, 10), prompt, slots: slots.split(/[、,，]/).map((s) => s.trim()).filter(Boolean), clusterId: cluster?.id || undefined, scene: cluster?.intent ?? undefined, source: "manual" } },
      { onSuccess: () => (toast("草稿已创建", { tone: "ok" }), setLast(null), onClose()), onError: (e: any) => toast(e?.missing ? "后端尚未提供模板接口" : e.message, { tone: "error" }) },
    )
  return (
    <Modal open={!!cluster} onClose={() => (setLast(null), onClose())} title="做成模板" sub={cluster?.uses ? `这句提示词本周被用了 ${cluster.uses} 次，${pct(cluster.downloadRate)} 下载` : undefined} width={560} footer={<><Button variant="ghost" onClick={() => (setLast(null), onClose())}>取消</Button><Button variant="primary" disabled={!prompt.trim()} loading={create.isPending} onClick={submit}>创建草稿</Button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <span className="label">标题</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="客户在模板列表里看到的名字" />
        </div>
        <div>
          <span className="label">提示词</span>
          <TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 100 }} />
        </div>
        <div>
          <span className="label">图片槽位</span>
          <Input value={slots} onChange={(e) => setSlots(e.target.value)} placeholder="用顿号分隔" />
        </div>
        <div>
          <span className="label">范围</span>
          <RadioGroup
            cards
            value={scope}
            onChange={setScope}
            options={[
              { value: "owner", label: "仅来源企业", hint: cluster?.topEnterprises.length ? `${cluster.topEnterprises.map((e) => e.enterprise.name).slice(0, 2).join("、")}${cluster.topEnterprises.length > 2 ? " 等" : ""}` : "只能推给提示词的来源企业" },
              { value: "general", label: "通用", hint: "已去掉客户特有内容，可以推给任何企业" },
            ]}
          />
        </div>
      </div>
    </Modal>
  )
}

const ListSkeleton = () => (
  <div style={{ padding: 16 }} className="stack">
    {[0, 1, 2, 3, 4].map((i) => (
      <div key={i} className="stack" style={{ gap: 8, padding: "10px 0" }}>
        <Skel w={`${80 - i * 7}%`} />
        <Skel w="40%" h={12} />
      </div>
    ))}
  </div>
)
