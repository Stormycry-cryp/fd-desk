
# 客户的销售、售后和剩余点数

客户台需要知道每家客户的销售、售后是谁，以及还剩多少点数，并且每天自动更新。前端由 Opus 负责，本文写给 Codex，只列数据来源、后端和契约。

## 数据来源

- **页面**：知衣后台 → FD+管理 → 生成分析，`https://new-backstage.zhiyitech.cn/fd-plus/generation-analytics`。
- **表格**：页面下方的「客户点数记录」，共 563 条，分 29 页。
- **列**：企业名称、超管手机号、销售名称、售后名称、生成任务数、下载任务数、下载率、总点数、过去 7 日消耗点数、昨日消耗点数、剩余点数。
- **要取的列**：企业名称、超管手机号、销售名称、售后名称、总点数、过去 7 日消耗点数、昨日消耗点数、剩余点数。生成数和下载率我们自己能算，不取。
- **取法**：沿用 `collector/` 现有方式，由 Codex CLI 驱动 Chrome 专用标签页、通过 DOM 读取，不读 Cookie，也不额外发请求。
  - 能导出就导出。不能导出时逐页读表格，读完后核对条数与页面上「共 N 条」一致。
  - 这张表在页面上不需要筛选日期，读到的就是当前快照。

## 匹配到企业

- 用超管手机号匹配 `EnterpriseDetail.adminPhone`，匹配不上时再按企业名称精确匹配。
- 两种都匹配不上的行，单独存一份「未匹配」，不要丢掉。
- 销售或售后为「测试人员」或「测试」的企业，标为内部账号（`internal: true`），前端会默认排除。

## 存储与更新

- **快照**：每次采集存一份完整快照，新建一张表 `account_snapshots(enterprise_id, taken_at, sales, after_sales, total_points, used_7d, used_yesterday, remaining)`，按天保留，不覆盖历史。剩余点数的变化曲线要靠这些历史。
- **写回负责人**：采集到的销售、售后写进现有的 `Owner { sales, afterSales }`，也就是 `RosterRow.owner` 和 `EnterpriseDetail.owner`。现在这两个字段全是 null。
  - 手工改过负责人（`PATCH /api/enterprises/:id` 带 `owner`）的企业，保留手工值，以手工为准。
- **频率**：并入每日 07:30 的采集任务，在生成记录之后执行，失败不影响生成记录的导入。也支持手动触发。
- **新鲜度**：`Meta` 增加 `accountsAt: Timestamp | null`，表示最近一次成功采集的时间。

## 契约

```ts
export interface Account {
  remaining: number              // 剩余点数
  total: number                  // 总点数
  used7d: number                 // 过去 7 日消耗
  usedYesterday: number          // 昨日消耗
  daysLeft: number | null        // remaining ÷ (used7d / 7)；过去 7 日没有消耗时为 null
  trend: { date: DateKey; remaining: number }[]   // 最近 30 天每天一个点，取当天最后一次快照
  internal: boolean
  takenAt: Timestamp
}

// RosterRow 增加 account: Account | null（没匹配到时为 null，trend 可以只给最近 8 个点）
// EnterpriseDetail 增加 account: Account | null（trend 给满 30 天）
// Meta 增加 accountsAt: Timestamp | null
// AlertKind 增加 "low_points"
```

- **新提醒 `low_points`（点数快用完）**：`daysLeft <= 7`，或者 `remaining < used7d`。证据写剩余点数和按近 7 天速度还能用几天。
- **客户列表** `GET /api/enterprises`：
  - 增加筛选参数 `owner`：销售名或售后名，命中任一即可。路由里已经有 `owner` 字段。
  - 增加 `points=low`：只看 `low_points`。
  - 新增 `GET /api/owners?line=`，返回 `{ name: string; role: "sales" | "after_sales"; enterprises: number }[]`，前端用来做筛选下拉。
- **导出**：客户名单导出 `GET /api/enterprises/export` 增加销售、售后、剩余点数、近 7 日消耗、预计可用天数这几列。
- **未匹配**：`GET /api/accounts/unmatched` 返回未匹配的行，前端在数据页展示。
- **数据页**：`GET /api/pipeline`（或数据页现有的接口）里增加这项采集的最近运行状态、行数和匹配数。

## 验证

- 采集后，`GET /api/enterprises` 里 `owner.sales` 非空的企业，不少于当周活跃企业的九成。
- 抽查截图里的几家：厚德载物剩余 88,509、销售何好姣、售后林泽雄；广州高维剩余 14,457、销售黄国军、售后钱海龙。和页面一致。
- 连续两天采集后，`trend` 有 2 个点，`daysLeft` 与 `remaining ÷ (used7d / 7)` 一致。
- 「市场-知衣售前」「杭州知小布科技」（销售、售后为测试人员或测试）的 `internal` 为 true。
- 手工把某家的售后改成别人后，再采集一次，手工值不被覆盖。
