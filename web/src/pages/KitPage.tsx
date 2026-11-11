import { useState } from "react"
import type { Level } from "@spec/contract"
import { Button, Checkbox, IconButton, Input, Kbd, NumberField, RadioGroup, Segmented, Switch, Tabs, TextArea } from "../ui/controls"
import { Badge, Card, CopyField, Delta, Empty, InlineEdit, LevelTag, Phone, Rate, Sev, Skel, Stat, Stepper } from "../ui/display"
import { BarList, LevelBar, Spark, StackBar, TrendChart } from "../ui/charts"
import { Drawer, FilterChip, Menu, Modal, Select, Tooltip, toast } from "../ui/overlays"
import { levelOrder } from "../lib/labels"
import { StatusTag } from "./bits"
import { DiffText, MarkControl, PromptEditor, VersionList } from "../ui/prompt"
import { ExportMenu } from "../ui/export"
import { JobProgress } from "../ui/insight"
import { MovementCard } from "./movement"
import type { Mark, MovementAnalysis, TemplateVersion } from "@spec/contract"

const kitContent = (prompt: string) => ({ title: "换色", task: "", prompt, variables: [], slots: [{ name: "款式图", required: true, requirement: "" }], model: null, ratio: null, resolution: null, fits: "", avoids: "" })
const kitVersions: TemplateVersion[] = [
  { version: 1, content: kitContent("保持{{款式图}}版型不变，把颜色换成[颜色]，面料质感保持一致"), source: "agent", note: "从 32 家企业的写法整理", createdAt: "2026-11-09T10:00:00+08:00" },
  { version: 2, content: kitContent("保持{{款式图}}的版型、褶皱和面料质感不变，只把主色换成[颜色]，辅料颜色不变"), source: "manual", note: "补上辅料", createdAt: "2026-11-10T15:20:00+08:00" },
]
const kitMove: MovementAnalysis = { id: "k", enterprise: { id: "k", name: "杭州承甫贸易有限公司", kind: "customer" }, line: "inspiration", week: "2026-11-02", direction: "down", change: { current: 107, previous: 298 }, headline: "任务量回落，使用重心从换色转向印花面料", reasons: [{ text: "换色任务明显减少，是本周回落的主要构成", evidence: { label: "换色", value: "27", target: null } }, { text: "印花面料成为本周主要类型", evidence: { label: "印花面料", value: "61", target: null } }], action: "核实换色需求是否告一段落，跟进印花面料的使用", confidence: "medium", trigger: "auto", state: "done", error: null, createdAt: "2026-11-11T10:00:00+08:00" }

const swatches = [
  ["--bg", "背景"],
  ["--surface", "表面"],
  ["--ink", "正文"],
  ["--ink-3", "次要"],
  ["--line", "分隔"],
  ["--accent", "强调"],
  ["--accent-weak", "强调底"],
  ["--up", "上升"],
  ["--down", "下降"],
  ["--warn", "提醒"],
]

export const KitPage = () => {
  const [seg, setSeg] = useState("a")
  const [tab, setTab] = useState("x")
  const [sel, setSel] = useState<string | null>("heavy")
  const [multi, setMulti] = useState<string[]>(["换色"])
  const [chk, setChk] = useState(true)
  const [sw, setSw] = useState(true)
  const [radio, setRadio] = useState("owner")
  const [prompt, setPrompt] = useState("保持{{款式图}}的版型不变，把主色换成[颜色]")
  const [mark, setMark] = useState<Mark | null>("better")
  const [usable, setUsable] = useState(true)
  const [n, setN] = useState(20)
  const [p, setP] = useState(0.35)
  const [drawer, setDrawer] = useState(false)
  const [modal, setModal] = useState(false)
  const [text, setText] = useState("把重复用的提示词存成团队模板")
  const [step, setStep] = useState<"draft" | "tested" | "published" | "pushed">("tested")
  return (
    <div className="page kit">
      <div className="page-head">
        <div>
          <h1>设计系统</h1>
          <div className="meta">组件一览</div>
        </div>
      </div>
      <Card title="颜色">
        <div className="swatches">
          {swatches.map(([v, n]) => (
            <div key={v} className="sw">
              <div style={{ background: `var(${v})` }} />
              <div>
                <b style={{ fontWeight: 500 }}>{n}</b>
                <code className="faint">{v}</code>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="按钮">
        <div className="demo">
          <Button variant="primary" icon="send">主要</Button>
          <Button icon="download">次要</Button>
          <Button variant="soft" icon="wand">柔和</Button>
          <Button variant="ghost">幽灵</Button>
          <Button variant="danger" icon="trash">危险</Button>
          <Button variant="primary" loading>加载</Button>
          <Button size="sm">小</Button>
          <Button size="xs">更小</Button>
          <IconButton icon="more" label="更多" />
          <IconButton icon="expand" label="展开" size="sm" />
          <Kbd keys={["⌘", "K"]} />
        </div>
      </Card>
      <div className="grid">
        <Card className="span-6" title="输入">
          <div className="stack" style={{ gap: 12 }}>
            <Input icon="search" placeholder="搜索企业" />
            <Input placeholder="静默样式" quiet size="sm" />
            <TextArea placeholder="多行输入，自动增高" />
            <div className="demo">
              <NumberField value={n} onChange={setN} suffix="个" />
              <NumberField value={p} onChange={setP} percent />
            </div>
          </div>
        </Card>
        <Card className="span-6" title="选择">
          <div className="stack" style={{ gap: 14 }}>
            <div className="demo">
              <Select value={sel} onChange={setSel} options={levelOrder.map((l) => ({ value: l, label: <LevelTag level={l as Level} />, text: l, hint: l === "heavy" ? "任务 ≥ 100 且 ≥ 4 天" : undefined }))} width={180} />
              <Select value={null} onChange={() => {}} placeholder="可搜索" search options={Array.from({ length: 20 }, (_, i) => ({ value: `o${i}`, label: `选项 ${i + 1}`, count: 20 - i }))} width={160} />
              <Select value="a" ghost size="sm" onChange={() => {}} options={[{ value: "a", label: "幽灵下拉" }, { value: "b", label: "另一项" }]} />
            </div>
            <div className="demo">
              <FilterChip label="类型" multi value={multi} onChange={setMulti} options={["换色", "印花面料", "换装上身", "换背景"].map((v, i) => ({ value: v, label: v, count: 40 - i * 7 }))} />
              <FilterChip label="层级" value={[]} onChange={() => {}} options={[{ value: "a", label: "重度" }]} />
              <Menu items={[{ key: "a", label: "导出", icon: "download" }, { key: "b", label: "复制链接", icon: "link", hint: "带周和产品线" }, { key: "s", label: "", sep: true }, { key: "c", label: "删除", icon: "trash", danger: true }]} trigger={({ toggle, ref }) => <Button ref={ref as any} iconRight="chevDown" onClick={toggle}>菜单</Button>} />
            </div>
            <div className="demo">
              <Checkbox checked={chk} onChange={setChk}>复选框</Checkbox>
              <Checkbox checked={false} mixed onChange={() => {}}>部分</Checkbox>
              <Switch checked={sw} onChange={setSw}>开关</Switch>
            </div>
            <RadioGroup row value={radio} onChange={setRadio} options={[{ value: "owner", label: "仅来源企业" }, { value: "general", label: "通用" }]} />
          </div>
        </Card>
      </div>
      <Card title="切换">
        <div className="stack" style={{ gap: 16 }}>
          <div className="demo">
            <Segmented value={seg} onChange={setSeg} options={[{ value: "a", label: "灵感成款" }, { value: "b", label: "AI视频" }, { value: "c", label: "第三项", count: 12 }]} />
            <Segmented size="sm" value={seg} onChange={setSeg} options={[{ value: "a", label: "按任务" }, { value: "b", label: "企业中位" }]} />
          </div>
          <Tabs value={tab} onChange={setTab} options={[{ value: "x", label: "全部", count: 159 }, { value: "y", label: "保住", count: 5 }, { value: "z", label: "帮助", count: 13 }]} />
          <Stepper steps={["draft", "tested", "published", "pushed"] as const} value={step} onChange={setStep} labels={{ draft: "草稿", tested: "已测试", published: "已上线", pushed: "已推送" }} />
        </div>
      </Card>
      <div className="grid">
        <Card className="span-4" title="标签">
          <div className="demo">
            <Badge>默认</Badge>
            <Badge tone="accent">强调</Badge>
            <Badge tone="up">上升</Badge>
            <Badge tone="down">下降</Badge>
            <Badge tone="warn">提醒</Badge>
            <Badge tone="outline">描边</Badge>
            <Badge tone="solid">实心</Badge>
          </div>
          <div className="demo" style={{ marginTop: 12 }}>
            {levelOrder.map((l) => (
              <LevelTag key={l} level={l as Level} />
            ))}
          </div>
          <div className="demo" style={{ marginTop: 12 }}>
            <Sev s={3} /> <Sev s={2} /> <Sev s={1} />
            <StatusTag s="draft" />
            <StatusTag s="sent" />
            <StatusTag s="replied" />
          </div>
        </Card>
        <Card className="span-4" title="数字">
          <div className="stack" style={{ gap: 14 }}>
            <Stat label="稳定使用企业" value={46} unit="家" hint="重度 + 中度" foot={<Delta current={46} previous={41} pill />} />
            <div className="demo">
              <Delta current={120} previous={100} />
              <Delta current={80} previous={100} />
              <Delta current={0.55} previous={0.6} rate pill />
              <Rate value={0.72} />
              <Rate value={0.22} mark={0.48} />
            </div>
            <Phone value="13800138000" />
          </div>
        </Card>
        <Card className="span-4" title="反馈">
          <div className="demo">
            <Button onClick={() => toast("已保存", { tone: "ok" })}>成功提示</Button>
            <Button onClick={() => toast("保存失败", { tone: "error" })}>错误提示</Button>
            <Button onClick={() => toast("已移到周三", { action: { label: "撤销", run: () => {} } })}>可撤销</Button>
            <Tooltip content="悬停提示">
              <Button variant="ghost">悬停</Button>
            </Tooltip>
            <Button onClick={() => setDrawer(true)}>抽屉</Button>
            <Button onClick={() => setModal(true)}>对话框</Button>
          </div>
          <div className="stack" style={{ gap: 8, marginTop: 14 }}>
            <Skel w="70%" />
            <Skel w="40%" />
          </div>
        </Card>
      </div>
      <div className="grid">
        <Card className="span-6" title="图表">
          <TrendChart points={[12, 18, 22, 19, 27, 31, 29, 36, 41, 39, 46, 44].map((v, i) => ({ label: `${i + 1}`, value: v, partial: i === 11 }))} height={160} />
          <div className="demo" style={{ marginTop: 12 }}>
            <Spark values={[3, 5, 4, 8, 7, 9, 12]} tone="hi" />
            <Spark values={[9, 8, 7, 7, 4, 3, 1]} tone="down" />
            <Spark values={[1, 2, 2, 3, 5, 8, 13]} tone="up" />
          </div>
        </Card>
        <Card className="span-6" title="分布">
          <LevelBar levels={{ heavy: 26, medium: 20, burst: 7, light: 39, trial: 38 }} />
          <div style={{ height: 16 }} />
          <StackBar segments={[{ key: "a", value: 35, color: "var(--accent-weak-2)", ink: "var(--accent-ink)", label: "批量 35%" }, { key: "b", value: 16, color: "var(--down-weak)", ink: "var(--down)", label: "卡住 16%" }, { key: "c", value: 49, color: "rgba(24,24,27,.05)", label: "其他" }]} />
          <div style={{ height: 16 }} />
          <BarList items={[["换色", 3535], ["换装上身", 1820], ["印花面料", 990]].map(([k, v]) => ({ key: String(k), label: k, value: Number(v), display: String(v), secondary: <Rate value={0.5} width={36} /> }))} />
        </Card>
      </div>
      <div className="grid">
        <Card className="span-6" title="编辑">
          <InlineEdit value={text} onSave={setText} />
          <div style={{ height: 14 }} />
          <CopyField value="https://data.zhiyitech.cn/plus-fd/workbench/chatting-image/inspiration?templateId=48213" open />
        </Card>
        <Card className="span-6" title="空状态">
          <Empty icon="users" title="没有符合条件的企业" text="换个页签或清除筛选" compact />
        </Card>
      </div>
      <div className="grid">
        <Card className="span-6" title="提示词编辑 · PromptEditor">
          <PromptEditor value={prompt} onChange={setPrompt} slots={["款式图"]} variables={["颜色"]} />
        </Card>
        <Card className="span-6" title="版本与差异 · VersionList / DiffText">
          <VersionList versions={kitVersions} current={2} onRestore={() => toast("回退")} />
        </Card>
        <Card className="span-6" title="对比标记 · MarkControl">
          <div className="stack" style={{ gap: 12 }}>
            <MarkControl value={mark} usable={usable} onMark={setMark} onUsable={(v) => setUsable(!!v)} keys />
            <DiffText from="把颜色换成红色" to="只把主色换成红色，辅料不变" />
          </div>
        </Card>
        <Card className="span-6" title="异步与导出 · JobProgress / ExportMenu">
          <div className="stack" style={{ gap: 12 }}>
            <JobProgress state="running" done={3} total={8} label="3/8" />
            <JobProgress state="running" label="正在撰写" />
            <JobProgress state="done" label="已完成" />
            <JobProgress state="failed" error="网关限流" />
            <ExportMenu items={[{ key: "a", label: "官方模板配置表", run: () => toast("导出") }, { key: "b", label: "模板监控", run: () => toast("导出") }]} />
          </div>
        </Card>
        <Card className="span-12" title="涨跌原因 · MovementCard">
          <MovementCard m={kitMove} showName />
        </Card>
      </div>
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="抽屉" footer={<Button variant="primary" onClick={() => setDrawer(false)}>完成</Button>}>
        <div style={{ padding: 20 }}>内容</div>
      </Drawer>
      <Modal open={modal} onClose={() => setModal(false)} title="对话框" sub="副标题" footer={<><Button variant="ghost" onClick={() => setModal(false)}>取消</Button><Button variant="primary" onClick={() => setModal(false)}>确认</Button></>}>
        内容
      </Modal>
    </div>
  )
}
