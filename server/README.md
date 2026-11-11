# fd-desk 后端

## 启动与自检

在项目根目录启动后端，Python 要求 3.12，依赖由 `server/uv.lock` 锁定：

```bash
~/.local/bin/uv run --directory server fd-desk serve
```

启动时扫描 `data/inbox/` 中尚未成功导入的 `.xlsx` 和 UTF-8 BOM `.csv.gz`，监听 `127.0.0.1:8765`。同一进程提供 API 和已有的 `web/dist/`；前端构建目录缺失不影响 API。导入也可使用 `POST /api/imports` 的 multipart `file`、`POST /api/imports/scan` 或 `fd-desk scan`。完整日期覆盖导入使用 `fd-desk import <文件> --replace-range --scope <范围文件>`，需要对应校验报告；普通导入按行主键追加或更新。每日采集是独立调度，参见 `collector/README.md`。

问答使用独立 Node 24 进程和 `agent/` 内的依赖，可以手工启动：

```bash
node agent/server.js
```

它监听 `127.0.0.1:8766`，后端将 `/api/ask/sessions` 及其子路径代理到该进程；未启动时返回 `ask_unavailable`。问答进程需要公司网关配置。

macOS 运行 `~/.local/bin/uv run --directory server fd-desk install-service`，安装 Python 后端与问答的两个 LaunchAgent，登录时启动、异常退出后恢复。服务分别为 `cn.zhiyitech.fd-desk.server` 和 `cn.zhiyitech.fd-desk.ask`，日志位于 `data/service/logs/` 并限制保留数量。每日采集由独立服务 `cn.zhiyitech.fd-desk.daily` 调度。

内网入口通过 Caddy 转发整个应用，包括页面、接口、图片、文件下载和 SSE。安装 Caddy 后，在项目根目录执行：

```bash
~/.local/bin/uv run --directory server fd-desk install-lan
```

配置在 `server/Caddyfile`，当前固定入口为 `http://chem.local:8767`，通过本机 Bonjour 名称访问，安装结果保存于 `data/service/lan.json`。独立 LaunchAgent `cn.zhiyitech.fd-desk.lan` 在登录时启动，进程退出后自动恢复；后端与问答继续监听各自的本机端口。Caddy 状态保存在 `data/service/caddy/`，错误日志限制为当前文件与一个归档文件，每份最多 2 MiB。入口需要访问设备能够解析本机 Bonjour 名称；其他设备及跨子网访问尚未验证。通过内网入口执行真实流式问答验收：

```bash
node agent/verify-lan.mjs http://chem.local:8767
```

结果写入 `data/fixtures/rework/lan-verification.json`，包括真实模型回答、流式时序及会话读取结果，同一份回执中的页面、接口与下载检查继续保留。

```bash
~/.local/bin/uv run --directory server fd-desk selfcheck
```

自检使用隔离数据库和既有真实输入，对照 `spec/golden.json` 验证统计和重复导入，并写入验证与夹具目录。它不验证模型、生图或问答的端到端能力。常规测试可在 `server/` 使用现有环境运行 `pytest`。`fd-desk profiles init` 需要后端已启动，提交持久初始化申请后立即返回，进度通过 `GET /api/pipeline` 查看。每批最多十家，批次依次执行，后台最多三个模型请求；已完成档案跳过，失败企业冷却十分钟后可再次处理。达到每日模型任务额度后保存进度，次日继续；服务恢复后继续未完成批次。

## 配置与数据

SQLite 默认位于 `data/fd-desk.db`，采用 WAL；上传暂存和工作文件位于 `data/work/`。`FD_DESK_DATA_DIR` 可覆盖运行数据目录。默认设置来源是 `spec/settings.default.json`，运行设置持久化在数据库，通过 `GET/PUT /api/settings` 读取或更新。`pipeline` 控制模型任务并发、每次档案数量、最少任务数、档案最大年龄和每日模型任务数；`trials` 控制预算、币种、用例数、写法数和并发；`followups.suggestionsPerWeek` 控制每周建议数量。以运行时设置为准，默认值分别为流水线并发 3、每批档案 40、最低 20 个任务、28 天、每日 120 个模型任务；试验每日 50 CNY、最多 12 个用例和 3 个写法、并发 4；每周跟进建议 12 条。

模型分析使用 `data/runtime.json` 指定的本机 Codex CLI、Codex Home、模型、渠道和推理强度；当前为 `gpt-6.1-sol`、`ultra`、`custom`。任务输入、结构化输出和进程记录保存在 `data/analysis/`。问答使用独立 pi 进程，通过知衣网关调用 `gpt-6.1-sol`、`high`，配置在 `data/private/zhiyi-gateway.json`，会话存储在 `data/ask/`。试验台调用 LiteLLM Skill runner，固定使用内网 `http://litellm-gray.sometimes.cn`，凭据读取本机 Skill 外的配置，估算费用和 FD 映射来自 `data/private/litellm-prices.json`。

所有应用模型请求通过 `data/service/model-capacity.sqlite3` 共用并发额度：总额度五项，为当前主会话预留一项，应用最多四项；后台分析、采集与图片生成合计最多三项。问答可以使用剩余名额，后台排队不会占用问答空余容量。名额绑定实际进程及启动时间，进程结束后自动释放；排队问答可以取消。

转化页使用独立的自由改款证据：本周任务、耗点、使用天数、成员、下载率、失败、累计任务、近四个完整周任务、同星期对比及十二周走势。主要任务依据 `spec/intents.json` 的提示词关键词归类，建议由代码根据真实使用生成。数据按事实版本缓存，SQLite 部分索引覆盖自由改款计数与下载统计；目标功能的原有任务字段保持原有含义。问答可结合这些证据继续分析转化机会。

`settings.trends` 包含流失空窗周数、稳定周数、连续下滑周数和两类回落比例。趋势仅使用所选周及之前的完整周，按任务数计算，优先顺序为流失、连续下滑、明显回落。档案事实和更新快照使用 SQLite 持久缓存，数据版本、当前周、层级和趋势设置变化时重算；记录查询复用企业索引，并按查询参数和数据版本缓存结果。

## 恢复

启动时恢复排队或执行中的已注册后台任务和未完成流水线。模型任务优先复用已有的完整结果；若此前进程已结束且无完整结果，任务失败并需重新发起。流水线记录各步骤状态，失败步骤可单独重跑；导入后待处理事件由后台轮询消费。试验恢复时重新安排排队格子；执行中断或费用不明的格子保留预算预留，不自动重试可能已经收费的格子。打包导出是后台任务，完成后通过结果中的下载地址获取；只保留最近两个完成的包，过期需重新生成。

## 接口

正式类型和请求响应见 `spec/contract.ts`，`spec/contract.next.ts` 保留类型重导出。已有的指标、企业、任务、链、预警、分析矩阵、提示词簇、结论、周报、导入和设置接口继续使用。旧 notes 和 touches 接口仍为兼容而保留；新跟进工作使用 followups。

- R1 档案和批注：`GET /api/profiles`、`GET /api/profiles/roster`、`GET /api/profiles/:id`、`GET /api/profiles/:id/versions`，`POST /api/profiles/init`、`POST /api/profiles/:id/refresh`，`PUT /api/profiles/:id/tags` 和 `/headline`；`GET /api/tags`；`/api/annotations` 及其 entries 支持增删改查。初始化接口返回流水线运行记录，刷新返回后台任务。
- R2 流水线和变动：`GET /api/pipeline`、`POST /api/pipeline/run`、`GET /api/jobs/:id`；`GET/POST /api/movements` 和 `GET /api/movements/:id`。流水线包括 facts、profiles、movement、opportunities、followups、monitor，支持选择步骤和周。
- R3 模板：`/api/templates` 支持列表、创建和详情修改删除，子路径 `revise`、`restore`、`review` 管理版本与审核；`/api/templates/opportunities` 支持查询、状态更新和 `refresh`；`GET /api/templates/monitor` 查询监控。模板通过表格交付运营。
- R4 试验：`GET /api/trials/budget`、`/candidates`，`GET/POST /api/trials`，单次试验支持查询、新增 arms 和 cases、retry、cells 标注、cancel 和 adopt。创建后立即执行，按照每日预算预留费用。
- R5 问答和跟进：`/api/ask/sessions` 支持创建、列表、查看、删除，`POST .../messages` 返回 SSE 事件流，`POST .../stop` 停止回答；问答支持跨周比较、原因分析、连续追问、看图、分组汇总和派生指标计算，按问题输出文字、卡片、图表和列表，工具读取真实业务数据。详见 `agent/README.md`。`GET/POST /api/followups` 和 `PATCH/DELETE /api/followups/:id` 管理个人跟进；`POST /api/findings/:id/recheck` 提交结论复核任务。
- R6 导出：`GET /api/export/:kind` 返回单个 XLSX；`POST /api/export/bundle` 接收 `items`（每项含 `kind` 和字符串参数 `params`），返回任务；完成后从 `GET /api/export/download/:id` 下载 ZIP。
- 生成记录：`GET /api/records` 按企业、产品线、日期、结果、任务类型、模式、模型、成员、行为、批注和关键字查询；`POST /api/records/sample` 执行有种子的分层抽样；`GET/POST /api/records/analyses` 管理选中记录的模型分析，单项支持查看和删除；`GET /api/records/export` 导出所选记录。`GET /api/trends` 查询多周趋势。类型已并入 `spec/contract.ts`，`contract.records.ts` 保留重导出。

## 导出列

以下为 `exports.py` 中的精确列顺序。两个模板类型使用同一组列；失败样本和任务明细使用同一组列；分析矩阵按产品线使用不同列。

| kind | 列，按顺序 |
| --- | --- |
| `roster` | 企业编号、企业名称、层级、变动、所属池、任务数、耗点、使用天数、下载率、标签、档案摘要、最近批注、批注时间、自由改款本周任务、自由改款活跃天数、自由改款下载率、自由改款近四个完整周任务、自由改款累计任务、自由改款主要任务、转化建议 |
| `annotations` | 批注编号、企业名称、类型、位置、所选原文、位置已经变化、内容、添加时间、修改时间、已解决 |
| `movements` | 企业名称、产品线、周、方向、本周用量、上周用量、结论、原因及依据、建议、把握程度、状态 |
| `templates_official` | 模板名称、提示词、场景、默认模型、输入图片数量、图片说明、封面图链接、可见客户范围、备注 |
| `templates_custom` | 模板名称、提示词、场景、默认模型、输入图片数量、图片说明、封面图链接、可见客户范围、备注 |
| `opportunities` | 机会编号、产品线、周、类型、目标企业、标题、价值、原因、优先级、使用次数、企业数、周数、下载率、同类中位下载率、重试占比、官方已覆盖、状态 |
| `monitor` | 模板编号、模板名称、类型、目标企业、FD模板编号、上线时间、估算数据、周、使用次数、企业数、下载率、基准使用次数、基准下载率 |
| `followups` | 企业名称、产品线、周、目的、排序、排序依据、依据、带去的内容、话术草稿、状态、客户回复、联系时间、下一周变化、建议 |
| `analysis_matrix` 灵感成款 | 任务类型、模型、任务数、企业数、下载率、企业中位下载率、最大企业占比 |
| `analysis_matrix` 视频 | 视频模式、模型、任务数、企业数、耗点、下载率、失败数、每次下载耗点 |
| `analysis_failures` | 任务编号、来源编号、时间、企业名称、成员、场景、模式、模型、任务类型、行为类型、提示词、耗点、状态、已下载、失败原因、FD会话地址 |
| `tasks` | 任务编号、来源编号、时间、企业名称、成员、场景、模式、模型、任务类型、行为类型、提示词、耗点、状态、已下载、失败原因、FD会话地址 |
| `records` | 时间、产品线、模式、任务类型、模型、成员、提示词、结果、失败原因、耗点、FD 链接、批注 |

默认使用灵感成款和该产品线最新周，可通过参数指定 `line`、`week` 及各类支持的筛选。`records` 必须指定 `enterprise`，默认 `scope=all`，支持 `from`、`to`、逗号分隔的 `rowKeys`，不限周且只合并灵感成款和视频。任务、失败样本和生成记录最多 5000 条，超限需缩小范围；单次打包最多 22 项，未压缩内容合计上限 250 MiB。模板导出会记录导出时间并更新适用的模板状态。自由文本中的 URL 会被移除，模板封面仅接受试验结果链接；定制模板的可见范围包含目标企业名称和管理员手机号。记录批注的导出位置为对应的来源任务编号。

## 限制

2026-11-11 已通过 LiteLLM 内网 `doubao-seedream-5.0-flash` 完成六个真实用例、两个写法的十二格生成，得到十二张 1536×2048 图片，并验证结果下载、标记、采用写法、采用封面和运营配置表导出。回执位于 `data/fixtures/rework/R4/adopt-verification.json`。当前每张图片按 1 CNY 保守预留；实际账单币种和准确价格尚未核实。FD 前端提交路径已读取，服务端的提示词拼装、图片角色和后台真实提示词尚未完全确认，因此还原精度为 `close`。

任务 API 默认每页 50 条、最多 200 条。覆盖不完整的周不能当作完整周比较；无依据的值可能为空。后端导出接口提供上述 XLSX 和 ZIP；档案、试验对比及周报打印和图表图片由前端实现。问答依赖独立进程和公司网关。后端与问答绑定本机，内网访问使用端口 `8767` 的独立入口。
