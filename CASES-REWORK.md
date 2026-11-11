# 记录页（Case）后端需求

记录页放在导航「客户」下面，跨企业查看生成记录。目的是快速发现问题客户、看清客户输入和结果、评价、归因，然后批量导出给运营和领导。企业抽屉里的「记录」标签页改成一个入口，跳到记录页并按该企业筛选。前端由 Opus 负责，本文只列后端和契约。

## 已确认的产品口径

- **默认范围**：当前所选周的全部企业、全部记录。时间可以改成自定义起止日期。
- **基本单位**：灵感成款默认按「修改链」看，AI视频默认按「单条」看，两种都要能切换。修改链沿用 `Engine.register_chain`；不在链里的任务（Agent 模式、没有手机号的任务）各自单独成一个 case。
- **链结局**，三类：
  - `bad`：链上没有任何一步被下载。链上有失败或删除的步骤，而且之后没再下载的，也算 bad。
  - `grind`：第一步没下载，后面某一步下载了（改了几次才成功）。
  - `good`：第一步就下载了。
- **单条结果**在现有 `downloaded | not_downloaded | failed` 之外加一个 `deleted`（`status == "deleted"`）。deleted 算 bad 的一种。
- **评价作用在 case 上**：给链打分，链上每一步都继承这个评价；需要时可以给某一步单独打分，覆盖继承来的。
- **AI 分析**只在用户主动点击后执行，调用本机 Codex CLI。发起前返回 Case、图片数量和预计金额，按当前渠道配置的模型单价计算。
- **导出**为 xlsx，图片放链接，不嵌图。
- **默认排序**：bad 优先，然后按时间倒序。要支持分页，一周灵感成款大约 9,000 条，合成链大约 5,000 个。

## 一、Case 列表 `GET /api/cases`

现有 `/api/records` 必须指定 enterprise，这里新开一个跨企业接口。`/api/records` 保留不动。

查询参数：

| 参数 | 说明 |
|---|---|
| `line` | 必填，`inspiration` 或 `video` |
| `week` 或 `from`/`to` | 二选一，`from`/`to` 优先。按链的第一步落在哪天算 |
| `unit` | `chain` 或 `task`。灵感成款默认 chain，AI 视频默认 task。按单条看时 outcome 用单条结果映射：downloaded→good，not_downloaded、failed、deleted→bad |
| `enterprise` | 逗号分隔的多个企业 |
| `outcome` | 逗号分隔的多选：`bad,grind,good` |
| `result` | 逗号分隔的多选：链上只要有一步符合就算命中 |
| `intent`、`pattern`、`model`、`mode` | 逗号分隔的多选 |
| `level`、`movement` | 按企业本周的层级和动向筛选，口径与客户名单一致 |
| `slow` | `true` 时只返回耗时超过同一模型、同一业务线近 4 周 P90 的 case |
| `steps` | `1`、`2-3`、`4+` |
| `rating` | 逗号分隔：`good,ok,bad,none` |
| `tag` | 逗号分隔的标签 id，命中任意一个即可 |
| `status` | 逗号分隔：`todo,seen,done` |
| `collection` | 收藏夹 id |
| `noted` | `any` 或 `none` |
| `q` | 搜索链上任意一步的提示词，或企业名 |
| `sort` | `bad_first`（默认）、`newest`、`oldest`、`steps`、`points` |
| `offset`、`limit` | limit 默认 50，最多 200 |

响应：

```ts
export type CaseOutcome = "bad" | "grind" | "good"
export type CaseUnit = "chain" | "task"
export type CaseRating = "good" | "ok" | "bad"
export type CaseStatus = "todo" | "seen" | "done"
export type StepResult = "downloaded" | "not_downloaded" | "failed" | "deleted"

export interface CaseStep {
  rowKey: Id
  index: number
  result: StepResult
  pattern: Pattern
  createdAt: Timestamp
  prompt: string
  inputs: Media[]
  outputs: Media[]
  durationSeconds: number | null
  points: number
  review: CaseReview | null
}

export interface CaseRow {
  id: Id
  unit: CaseUnit
  line: Line
  enterprise: EnterpriseRef & { level: Level | null; movement: Movement | null }
  user: { id: Id; name: string } | null
  outcome: CaseOutcome
  startedAt: Timestamp
  endedAt: Timestamp
  stepCount: number
  downloadedAt: number | null
  intent: string | null
  mode: string
  model: string | null
  config: Task["config"]
  points: number
  durationSeconds: number | null
  slow: boolean
  failure: Task["failure"]
  first: CaseStep
  last: CaseStep
  steps: CaseStep[] | null
  fdUrl: string | null
  review: CaseReview | null
  annotationCount: number
  lastAnnotation: { text: string; at: Timestamp } | null
  collections: Id[]
}

export interface CaseSummary {
  total: number
  outcomes: Record<CaseOutcome, number>
  byIntent: { key: string; total: number; bad: number; grind: number }[]
  byEnterprise: { enterprise: EnterpriseRef; total: number; bad: number; grind: number }[]
  rated: number
  ratings: Record<CaseRating, number>
}

export interface CasePage {
  items: CaseRow[]
  total: number
  summary: CaseSummary
  facets: {
    outcomes: RecordFacet[]
    results: RecordFacet[]
    intents: RecordFacet[]
    patterns: RecordFacet[]
    models: RecordFacet[]
    modes: RecordFacet[]
    enterprises: { id: Id; name: string; count: number }[]
    levels: RecordFacet[]
    movements: RecordFacet[]
    steps: RecordFacet[]
    ratings: RecordFacet[]
    tags: RecordFacet[]
    statuses: RecordFacet[]
    slow: number
    noted: number
  }
  range: { from: DateKey; to: DateKey } | null
}
```

约定：

- **`id`**：按链看时是现有的 `chainId`，也就是 `digest("chain|" + 第一步 rowKey)`；按单条看时就是 `rowKey`。重新导入后 id 必须保持不变。如果链长了（后来的导入又接上了新的一步），id 仍然不变。
- **`downloadedAt`**：第一次下载发生在第几步，从 0 开始；没下载过是 `null`。
- **`steps`**：列表里返回 `null`，详情接口才返回全部步骤。`first` 和 `last` 始终返回，前端靠它们在一行里显示「输入 → 最终结果」。
- **`intent`、`model`、`mode`**：取链上出现最多的值；一样多时取第一步的。
- **`points`、`durationSeconds`**：链上各步求和。任一步耗时缺失时，链的总耗时为 null。
- **`slow`**：链上任意一步超过 P90 就算。每一步使用其所在周及之前三周同一模型、同一业务线的有效耗时作为基准。
- **`enterprise.level`、`enterprise.movement`**：按记录页当前的周取值。用的是自定义起止日期时，按 `to` 所在的周取。
- **`summary`**：只受 `line`、时间和 `enterprise` 影响，不受其他筛选影响，因为它是页面顶部的固定概览。
- **`facets`**：沿用 `/api/records` 的做法，每个维度的计数忽略该维度自身的筛选。
- **`byEnterprise`**：按 bad 数降序，最多 20 家。
- **性能**：在 5,000 个链的规模上，一次请求要在 300ms 以内。链结局和 slow 在 `Engine.refresh` 时预先算好。

## 二、Case 详情 `GET /api/cases/:id`

query 带 `unit`。返回 `CaseRow`，其中 `steps` 是完整数组（每一步带自己的 `review`），再加一个 `annotations: Annotation[]`，包括链级批注和链上每一步的批注。

批注的锚点：

- 链级：`anchor.block = "case:<id>"`。
- 单条：沿用 `"record:<rowKey>"`。

`annotationCount` 两种都算。

## 三、评价与标签

```ts
export interface CaseReview {
  rating: CaseRating | null
  tags: Id[]
  status: CaseStatus
  inherited: boolean
  updatedAt: Timestamp
}

export interface CaseTag {
  id: Id
  group: string
  label: string
  lines: Line[]
  tone: "bad" | "good" | "neutral"
  order: number
  archived: boolean
}
```

接口：

- `GET /api/cases/tags?line=`：返回该业务线可用、而且没有归档的标签。带 `all=1` 时把归档的也返回。
- `POST /api/cases/tags`：新建标签。
- `PATCH /api/cases/tags/:id`：改名、换组、调整顺序、归档。不支持删除；已经用过的标签只能归档。
- `PUT /api/cases/reviews`：批量写评价，请求体为 `{ items: { id: Id; unit: CaseUnit }[]; rating?: CaseRating | null; addTags?: Id[]; removeTags?: Id[]; status?: CaseStatus }`。
  - 只改请求里带了的字段。
  - 单次最多 500 条。
  - 返回 `{ updated: number }`。
- `DELETE /api/cases/reviews`：请求体 `{ items }`，清空这些评价。

存储与继承：

- 评价单独建一张 SQLite 表 `case_reviews(id, unit, line, enterprise_id, rating, tags_json, status, updated_at)`，不写进 tasks。
- 单条评价优先于它所在链的评价。没有单条评价的步骤继承链的评价，并标 `inherited: true`。
- 链被打分后，步骤上的 `review` 返回继承来的值。
- 没有评价时，`status` 视为 `todo`，`review` 返回 `null`。
- 打开详情不会自动改状态，前端会显式把状态写成 `seen`。

预置标签（业务线为空表示两条线都有）：

| group | label | lines | tone |
|---|---|---|---|
| 没听懂 | 指令没执行 | | bad |
| 没听懂 | 执行错了 | | bad |
| 没听懂 | 改了不该改的 | | bad |
| 没保住 | 款式变了 | | bad |
| 没保住 | 面料或印花变形 | | bad |
| 没保住 | 颜色偏 | | bad |
| 没保住 | 人脸或身材变了 | | bad |
| 质量差 | 糊或有瑕疵 | | bad |
| 质量差 | 文字乱码 | | bad |
| 质量差 | 比例或裁切不对 | | bad |
| 视频 | 动作僵或崩 | video | bad |
| 视频 | 人物和服装不一致 | video | bad |
| 视频 | 时长或节奏不对 | video | bad |
| 不是模型的问题 | 客户输入有问题 | | neutral |
| 不是模型的问题 | 需求超出能力 | | neutral |
| 值得关注 | 可做模板 | | good |

## 四、收藏夹

收藏夹用来把典型案例存成合集，比如「面料变形典型例」。

```ts
export interface CaseCollection { id: Id; name: string; line: Line; count: number; createdAt: Timestamp; updatedAt: Timestamp }
```

接口：

- `GET /api/cases/collections?line=`
- `POST /api/cases/collections`：请求体 `{ line; name }`。
- `PATCH /api/cases/collections/:id`：请求体 `{ name }`。
- `DELETE /api/cases/collections/:id`
- `PUT /api/cases/collections/:id/items`：请求体 `{ add?: { id; unit }[]; remove?: { id; unit }[] }`。

列表接口按 `collection=` 筛选。

## 五、抽样批次

抽样批次就是「抽 20 条，用键盘过一遍」。

```ts
export type CaseSampleStrategy = "stratified" | "problems" | "per_enterprise" | "per_intent"

export interface CaseBatch {
  id: Id
  line: Line
  name: string
  strategy: CaseSampleStrategy
  filters: Record<string, string>
  items: { id: Id; unit: CaseUnit }[]
  reviewed: number
  createdAt: Timestamp
}
```

接口：

- `POST /api/cases/batches`：请求体 `{ line; from; to; unit; filters: Record<string, string>; strategy; size; perGroup?: number; seed?: number; name?: string }`。
  - `filters` 与列表接口的 query 同名。
  - 返回 `CaseBatch`。
- `GET /api/cases/batches?line=`：按时间倒序，最多 30 个。
- `GET /api/cases/batches/:id`：返回 `CaseBatch` 加上 `rows: CaseRow[]`，按 items 的顺序排列。
- `DELETE /api/cases/batches/:id`：只删批次，评价保留。

抽样策略：

- `stratified`：沿用 `Records.sample` 的分层思路，改成在链上抽。按 outcome（bad、grind、good 大约 5:3:2）× intent 分层，每家企业不超过总数的 25%。
- `problems`：只从 bad 和 grind 里抽，优先抽 slow、步数 ≥3、失败或删除的。
- `per_enterprise`：在筛选后的企业中，每家抽 `perGroup` 条（默认 3），bad 优先。
- `per_intent`：每个意图抽 `perGroup` 条（默认 3），bad 优先。

通用规则：

- `seed` 相同则结果相同。
- 已经抽过的记录默认跳过；按底层 rowKey 判断，删除批次后仍保留抽样历史。已经评过的 Case 默认跳过，`filters.rating` 明确要求时可以包含已评价的 Case。
- `reviewed` 等于批次里有 rating 的 case 数，实时计算。

## 六、AI 分析（只在用户点击时运行）

```ts
export interface CaseCluster {
  title: string
  summary: string
  tags: Id[]
  caseIds: Id[]
  enterprises: EnterpriseRef[]
  severity: "high" | "medium" | "low"
}

export interface CaseAnalysis {
  id: Id
  line: Line
  items: { id: Id; unit: CaseUnit }[]
  question: string | null
  state: JobState
  headline: string
  clusters: CaseCluster[]
  perCase: { id: Id; rating: CaseRating; tags: Id[]; note: string }[]
  suggestions: string[]
  cost: { estimated: number | null; spent: number | null; currency: string }
  error: ApiError | null
  createdAt: Timestamp
  finishedAt: Timestamp | null
}
```

接口：

- `POST /api/cases/analyses/estimate`：请求体 `{ items }`，返回 `{ cases: number; images: number; estimated: number; currency: string }`。模型单价和渠道倍率读取本机 CC Switch 价格数据库，币种为 USD；预计用量参考同模型已完成的真实 Case 分析，按 Case 数量、图片数量和文本规模估算。完成金额按本次 CLI 的实际输入、缓存读取、缓存写入和输出用量计算，并使用创建时保存的单价。
- `POST /api/cases/analyses`：请求体 `{ line; items; question?: string }`，最多 40 个 case。
- `GET /api/cases/analyses?line=`
- `GET /api/cases/analyses/:id`
- `DELETE /api/cases/analyses/:id`

分析要求：

- 复用 `record_analysis.py` 的取图和调用方式。
- **输入**：每个 case 取第一步的输入、每一步的结果（链太长就取第一、最后和下载的那一步）、全部提示词，以及步数、结局、耗时。
- **聚类**：`clusters` 按问题聚类，每类必须有 `caseIds` 作为证据，`tags` 只能取第三节里已有的标签 id。
- **`perCase`**：AI 对每个 case 的初判。前端会把它填进评价栏供确认，后端不自动写进 `case_reviews`。
- **`headline`**：一句话，不超过 40 字。
- **`suggestions`**：最多 3 条，必须是具体可做的动作。

## 七、问题看板 `GET /api/cases/issues`

query：`line`、`from`/`to` 或 `week`、`enterprise?`。

```ts
export interface CaseIssue {
  tag: CaseTag
  cases: number
  enterprises: number
  topEnterprises: { enterprise: EnterpriseRef; cases: number }[]
  weekly: { week: WeekKey; cases: number }[]
  samples: { id: Id; unit: CaseUnit; thumb: string | null }[]
  linked: { followups: number; opportunities: number; templates: number }
}
```

规则：

- 只统计用户确认过的评价，也就是 `case_reviews` 里的数据，不含 AI 初判。明确保存的链评价与单条评价分别计数，继承到步骤的评价不会重复计数；手工添加标签的评价也参与统计。
- 按 `cases` 降序排。
- `weekly` 取最近 8 周。
- `samples` 最多 4 个，优先取 rating 为 bad 的。
- `linked` 统计挂有这些 case 的跟进、模板机会和模板，见下一节。

## 八、与跟进、模板打通

- `AttachmentKind` 增加 `"case"`。跟进的 `attachments` 可以挂 case。
  - `POST /api/followups` 的请求体增加 `attachments?: { kind; id }[]`。
  - attachment 的 `target` 指向记录页对应的 case。
- 模板：`POST /api/templates` 的请求体增加 `caseIds?: Id[]`，作为撰写时的参考案例传给 Codex。模板详情里返回 `sourceCases: { id; unit; thumb }[]`。
- 试验台：`GET /api/trials/candidates` 增加 `caseIds?: string` 参数，把指定 case 的第一步作为用例。

## 九、导出 `GET /api/cases/export`

- **参数**：与列表接口相同的筛选参数，或者 `ids=` 加 `unit=`。超过 5,000 行时返回 422，提示缩小范围。
- **格式**：xlsx，一行一个 case。
- **列**：企业、层级、动向、账号、开始时间、意图、模式、模型、比例/清晰度或时长、步数、结局、第几步下载、耗时、耗点、第一步提示词、最后一步提示词、输入图链接、最终结果链接、FD 链接、评价、标签、状态、收藏夹、批注。
  - 多个链接、多个标签用换行分隔。
  - 批注取最近 3 条，每条带日期。
- **第二个工作表「步骤」**：按链看时附带，一行一步，列有 case id、步序、结果、修改方式、提示词、输入链接、结果链接、评价。
- **文件名**：`记录_{业务线}_{from}-{to}.xlsx`。
- `ExportKind` 增加 `"cases"`，导出中心可以一起打包。

## 十、契约

- 以上类型加进 `spec/contract.ts`，`Api` 增加：

  ```ts
  "GET /api/cases": { query: CaseQuery; response: CasePage }
  "GET /api/cases/:id": { query: { unit: CaseUnit }; response: CaseRow & { annotations: Annotation[] } }
  "GET /api/cases/tags": { query: { line: Line; all?: boolean }; response: CaseTag[] }
  "POST /api/cases/tags": { body: { group: string; label: string; lines: Line[]; tone: CaseTag["tone"] }; response: CaseTag }
  "PATCH /api/cases/tags/:id": { body: Partial<Pick<CaseTag, "group" | "label" | "lines" | "tone" | "order" | "archived">>; response: CaseTag }
  "PUT /api/cases/reviews": { body: { items: { id: Id; unit: CaseUnit }[]; rating?: CaseRating | null; addTags?: Id[]; removeTags?: Id[]; status?: CaseStatus }; response: { updated: number } }
  "DELETE /api/cases/reviews": { body: { items: { id: Id; unit: CaseUnit }[] }; response: { updated: number } }
  "GET /api/cases/collections": { query: { line: Line }; response: CaseCollection[] }
  "POST /api/cases/collections": { body: { line: Line; name: string }; response: CaseCollection }
  "PATCH /api/cases/collections/:id": { body: { name: string }; response: CaseCollection }
  "DELETE /api/cases/collections/:id": { response: null }
  "PUT /api/cases/collections/:id/items": { body: { add?: { id: Id; unit: CaseUnit }[]; remove?: { id: Id; unit: CaseUnit }[] }; response: CaseCollection }
  "POST /api/cases/batches": { body: { line: Line; from: DateKey; to: DateKey; unit: CaseUnit; filters: Record<string, string>; strategy: CaseSampleStrategy; size: number; perGroup?: number; seed?: number; name?: string }; response: CaseBatch }
  "GET /api/cases/batches": { query: { line: Line }; response: CaseBatch[] }
  "GET /api/cases/batches/:id": { response: CaseBatch & { rows: CaseRow[] } }
  "DELETE /api/cases/batches/:id": { response: null }
  "POST /api/cases/analyses/estimate": { body: { items: { id: Id; unit: CaseUnit }[] }; response: { cases: number; images: number; estimated: number; currency: string } }
  "POST /api/cases/analyses": { body: { line: Line; items: { id: Id; unit: CaseUnit }[]; question?: string }; response: CaseAnalysis }
  "GET /api/cases/analyses": { query: { line: Line }; response: CaseAnalysis[] }
  "GET /api/cases/analyses/:id": { response: CaseAnalysis }
  "DELETE /api/cases/analyses/:id": { response: null }
  "GET /api/cases/issues": { query: { line: Line; week?: WeekKey; from?: DateKey; to?: DateKey; enterprise?: Id }; response: CaseIssue[] }
  "GET /api/cases/export": { query: CaseQuery & { ids?: string }; response: Blob }
  ```

- `CaseQuery`：在第一节的参数基础上，多选参数统一用逗号分隔的字符串。
- `PageKey` 增加 `"cases"`。
- `JobKind` 增加 `"case_analysis"`。

## 验证

用 11/02 那一周做验证：

- **链结局**：灵感成款按链看时，`outcomes` 三类之和等于该周链的总数。拿杭州承甫 `1cd6112680` 抽查，「未下载但后面某一步下载了」的那些步骤，所在链必须是 `grind`，不能是 `bad`。
- **被删除的步骤**：status 为 deleted 的 99 条，它们所在的链全部是 `bad`，除非之后某一步下载了。
- **按单条看**：灵感成款 `total` 与当前数据库和 `/api/overview` 的任务数一致。当前同周真实数据为 9,066 条，视频为 882 条。
- **评价继承**：给一条链打 bad 后，详情里每一步的 `review.inherited` 为 true。再单独给第 2 步打 good，只有第 2 步是 `inherited: false`。
- **筛选**：同时筛 `outcome=bad&level=heavy,medium` 时，`facets.outcomes` 里 grind 和 good 的计数不为 0（计数忽略该维度自身的筛选）。
- **性能**：灵感成款全周按链看、`limit=50` 时，响应在 300ms 以内；`/api/cases/issues` 在 500ms 以内。
- **导出**：按 ids 导出 3 个链，主表 3 行，「步骤」表的行数等于这 3 个链的步数之和，链接可以直接打开。

## 前端完成情况（11/11）

记录页已经上线，路由为 `/cases`，导航在「客户」下面，快捷键 `G B`。

- **页面结构**：分「全部 / 问题 / 抽样 / AI 分析 / 收藏」五个标签页。顶部是 bad、磨合、good 三类计数，以及按意图和按客户的 bad 分布，点击任意一项都会筛选列表。
- **列表**：一行显示「输入图 → 最终结果」，带上提示词和特征，可以直接在行上打好 / 一般 / 差。也可以切到宫格视图。键盘操作：`J`/`K` 上下移动，`X` 选中，`1`/`2`/`3` 打评价，回车打开。
- **查看器**：支持并排、滑动、切换三种对比方式，对比对象可以选输入图或上一步。可以按整条链评价，也可以单独评某一步；有标签分组，状态分「待看 / 已看 / 已处理」，还能收藏、批注和查看 AI 初判。键盘快捷键都已接上。打开一条 case 时，前端会显式写入 `status: seen`。
- **兜底**：后端接口缺失时，页面改用 `/api/chains` 加 Agent 任务在本地算出 case，评价、收藏和抽样先存在本机。等接口恢复后会自动同步上去。目前后端接口都已在线，实测走的是后端。
- **企业抽屉**：「记录」标签页改为跳转到记录页，并按该企业筛选。原来的 `Records.tsx` 已删除。

后端补充约定：

1. 费用预估返回具体金额和币种，使用当前模型单价与渠道倍率；完成后保存本次 CLI 用量计算出的金额。
2. 三个视频预置标签的 `lines` 固定为 `["video"]`，灵感成款标签接口排除这三个标签；服务启动时修复已有的适用范围，保留标签的名称、排序和归档状态。
3. 批次 `filters` 只保存查询范围和筛选条件，排除 `sort`、`offset`、`limit`；服务启动时同步清理已有批次的这三个字段，保留抽样结果和评价。
