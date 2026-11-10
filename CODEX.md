# 给 Codex：fd-desk 后端任务

## 你负责什么

fd-desk 后端（`server/`）和导出采集（`collector/`）。前端（`web/`）由另一个代理负责，不要改 `web/`。

先读，按这个顺序：

1. `PLAN.md`：目的、两条线、页面、第 6 节口径、第 9 节里程碑。
2. `spec/contract.ts`：全部接口和返回类型。后端必须逐字段符合。
3. `spec/reference.py`：口径的参考实现。与 `PLAN.md` 第 6 节不一致时以它为准，并告诉我。
4. `spec/golden.json`：参考实现在 `data/inbox` 两份导出上的输出，是验收基准。
5. `spec/settings.default.json`、`spec/intents.json`、`spec/seeds.json`：默认阈值、任务类型规则、结论记录初始内容。

## 硬性约束

- 只监听 `127.0.0.1:8765`。一个进程提供 `/api/*`，同时托管 `web/dist`（不存在时跳过），非 `/api` 路径回退到 `index.html`。
- 客户数据只放在 `data/`（已被 `.gitignore` 忽略）：数据库、缓存、fixtures 都在里面。不要把手机号、企业名、图片链接写进代码、测试快照或日志。
- 不保存 FD 后台的登录凭据。采集脚本使用本机已有的登录态，凭据来自环境变量或本机钥匙串，不进仓库。
- 需要大模型分析时，调用本机 Codex CLI，模型、渠道和推理强度沿用当前会话配置，保存在 `data/runtime.json`。生图使用用户的 LiteLLM Key 和对应 Skill runner。
- 模板推送（M3）会给客户发通知：只能在 `POST /api/pushes/:id/confirm` 之后执行，一次确认只执行一次；遵守草稿的 `scope` 和 `pushDailyLimit`；超时或结果不明时置为 `uncertain`，不自动重试。流程和接口见 `PLAN.md` 6.11。
- FD 账号的登录态只在调用 FD 接口时使用，不写入数据库和日志。
- 重跑对比（M4）通过 LiteLLM 收费：先核验费用依据和每日货币预算，`POST /api/reruns/:id/confirm` 之后才执行；结果不确定时置为 `uncertain`，不自动重试。
- 没有经过确认不要 push，也不要动 `zy-web` 仓库。

## 技术选型

建议 Python 3.12（uv 管理）、FastAPI、SQLite（WAL）、pandas、openpyxl、Pillow。本机系统 Python 是 3.9.6，`uv` 在 `~/.local/bin`。只要接口和数字符合要求，可以换。

## 接口约定（契约里没写死的部分）

- 契约中 `"GET /api/x": { query, body, response }` 表示：query 用 URL 参数，body 用 JSON，response 是 200 的 JSON 体。`response: Blob` 是文件下载（xlsx 或图片）。`response: null` 返回 204。
- 错误：4xx/5xx 加 `ApiError { code, message }`。`code` 用小写英文，如 `not_found`、`invalid_week`、`manual_locked`。
- 时间一律 ISO 8601 带 `+08:00`。`WeekKey` 是周一日期 `YYYY-MM-DD`。
- 比例用 0 到 1 的小数，不是百分数。
- 企业 `id`：超管手机号的 sha1 前 10 位。`adminPhone`、`Member.phone` 返回完整号码，打码由前端做。
- `GET /api/enterprises/export` 必须注册在 `GET /api/enterprises/:id` 之前。
- `Metric.comparable`：同星期对比的 `{current, previous}`，只用两周都覆盖的星期几；上一周没有数据时为 `null`。`comparableExcluded`：去掉 `settings.excluded[line]` 里的企业后的同一对数字，列表为空时为 `null`。`Metric.value` 是本周全量值。
- `Overview.stable` 和 `levels`：本周不完整时为 `null`。
- 企业类型改为 `internal` 时自动加入两条线的排除列表。
- 排除列表的默认值按 `PLAN.md` 6.5：首次导入后，每条线最近一个完整周占比 ≥ 20% 的企业写入 `settings.excluded`。之后只由用户修改。
- `POST /api/touches/import` 接收 `GET /api/touches/export` 导出的表格，按隐藏的卡片 ID 列更新 `status`、`reply`、`sentAt`；未知 ID 计入 `skipped`。
- 推送预览（`POST /api/drafts/:id/pushes`）：查询每家企业成员的分享候选，填 `receivers`；`scope` 为 `owner` 且企业不在 `sourceEnterprises` 里的列入 `blocked`。确认时只接受预览里 `selectable` 的成员。
- `Authored`：写入带 `source`。已有内容 `source` 为 `manual` 时，`rule` 或 `agent` 的写入不生效，返回 409 `manual_locked` 和现有内容。
- `Media.thumb` 由后端拼好，形如 `/api/media/thumb?url=<原图编码>&w=480`。缩略图接口只接受 `PLAN.md` 第 8 节列出的域名，按 `url+w` 缓存到 `data/cache/`，返回 webp 或 jpeg，带长缓存头。视频的 `poster` 用配置里的 `firstFrameImage`。
- `GET /api/tasks?sample=n`：按 `SampleReason` 分层，每层最多取 n 条，并填 `sampleReason`；不带 `sample` 时按时间倒序分页，`limit` 默认 50、最大 200。
- `GET /api/enterprises`：返回本条线截至该周出现过的全部企业，加上转化池候选。`poolCounts` 按全部行统计。
- `RosterRow.spark` 和 `LineDetail.history`：截至该周的 12 周，没有数据的周 `tasks` 为 0、`level` 为 `null`。
- 导入：`POST /api/imports` 接收 multipart 字段 `file`；`POST /api/imports/scan` 导入 `data/inbox` 中未导入过的 `.xlsx` 和 `.csv.gz`。从文件名 `FD生成记录导出_YYYYMMDD-YYYYMMDD.xlsx` 或 `FD_在约体验_YYYYMMDD-YYYYMMDD.csv.gz` 读取覆盖起止日期；fddata 校验报告优先声明覆盖日期并核对文件名。缺少日期声明时用数据中最早和最晚的日期，并在 `ImportJob.error` 中提示。按行主键更新，同一文件导入两次行数不变。完整范围覆盖通过 `fd-desk import <文件> --replace-range` 执行，必须核验同目录 fddata 合并报告，且保留企业手工资料和设置。
- 首次启动时，若数据库为空，从 `spec/settings.default.json` 写入设置，从 `spec/seeds.json` 写入结论记录。结论 `rule` 为 `mismatch` 且 `verdict` 为 `confirmed` 时，驱动模型不匹配预警。
- 规则产生的触达建议（`suggested: true`）在导入新数据后重新生成；已被接受或编辑过的卡片不受影响。

## 验收

每个里程碑结束时交付：

1. 一条命令启动服务，并写进 `server/README.md`。
2. 自检命令：清空临时库，导入 `data/inbox` 两份文件，从数据库算出与 `spec/golden.json` 同结构的结果，逐项比对，全部一致才算通过。比较浮点时容差 1e-4。
3. 重复导入测试：行数和全部汇总不变。
4. 把该里程碑涉及的接口在真实数据上的返回存到 `data/fixtures/<接口名>.json`，周取 `2026-11-02`。前端用它核对。
5. 一段说明：做了什么、哪些口径与 `PLAN.md` 不同及原因、哪些契约字段暂时返回空值。

M1 抽查数字（`2026-11-02`，灵感成款）：任务 9077，企业 130，稳定使用 46（重度 26，中度 20），下载率 0.5505，批量占比 0.347，卡住占比 0.1585。视频：任务 881，耗点 60016，稳定使用 19，失败 68，未下载耗点 31861。

## 里程碑顺序

初始运行数据使用 `2026-09-10` 至 `2026-11-09` 的在约、体验客户完整导出，共 302,537 条。后续采集使用 fddata，按完整自然日更新并刷新最近 14 天。配置和执行约定见 `collector/README.md`；原有两份 Excel 继续用于 golden 自检。

按 `PLAN.md` 第 9 节实现 M1 名单与周对比、M2 分析与模板候选、M3 触达与效果、M4 重跑、转化池和每日采集，连续完成实现与验收。

需要修改契约时，先改 `spec/contract.ts` 并写明原因，再改实现。
