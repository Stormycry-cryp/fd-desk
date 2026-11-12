# FD Desk

FD / FD+ 客户使用分析工作台。将真实生成记录、客户账户快照、人工批注和模型分析集中在一个本地应用中，支持客户跟进、生成案例复核、模板制作、试验和周报导出。

## 功能

- 查看灵感成款、AI 视频及自由改款的使用、耗点、下载、失败和多周变化，按完整覆盖日期解释指标。
- 查询客户档案、销售及售后负责人、账户余额、近期消耗、点数预警和未匹配账户。
- 检索生成记录和修改链，查看提示词、输入与输出，添加标签、批注、抽样批次和案例集。
- 基于真实案例分析问题、维护模板池、撰写和审核模板，运行有预算限制的图片试验。
- 通过问答服务查询业务数据、计算指标、分析图片和继续讨论，保存会话历史。
- 管理客户跟进、导出 XLSX / ZIP、打印报告，并通过浏览器 DOM 采集每日数据。

## 目录

| 路径 | 内容 |
| --- | --- |
| `web/` | React 19、TypeScript、Vite 8 前端 |
| `server/` | Python 3.12+、FastAPI、SQLite 后端 |
| `agent/` | Node 24 问答服务，使用 pi-ai、pi-durable 和 chord |
| `collector/` | 生成记录、客户点数采集及 macOS 调度 |
| `skills/fddata/` | 数据提取 Skill、筛选配置、浏览器操作说明、校验与合并程序 |
| `spec/` | 接口类型、默认设置、任务意图及真实输入对应的指标基准 |
| `scripts/` | Release 数据打包、完整性校验和恢复程序 |
| `data/` | 本地运行数据库、原始输入、分析结果和私有配置，由 Git 忽略 |

## 安装

需要 Python 3.12 或更新版本、uv、Node.js 24 和 pnpm 8.15.9。依赖版本分别保存在 `server/uv.lock`、`agent/package-lock.json` 和 `web/pnpm-lock.yaml`。

在仓库根目录执行：

```bash
uv sync --frozen --directory server
npm ci --prefix agent --ignore-scripts
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
```

## 恢复随仓库提供的数据

真实业务数据随私有仓库的 `data-20261112` Release 提供。下载该 Release 的 `fd-desk-data.tar.gz` 和 `manifest.json`：

```bash
mkdir -p .artifacts/data-20261112
gh release download data-20261112 --repo Stormycry-cryp/fd-desk --dir .artifacts/data-20261112
python3 scripts/data_bundle.py verify --bundle-dir .artifacts/data-20261112
python3 scripts/data_bundle.py restore --bundle-dir .artifacts/data-20261112 --target data
```

上述命令用于新克隆且尚未创建 `data/` 的仓库。已有数据时，将 `--target` 指向项目 `data/` 下尚不存在的目录，再通过 `FD_DESK_DATA_DIR` 选择该目录启动 Python 后端。恢复程序校验全部文件的 SHA-256，并检查 SQLite 完整性，遇到现有目标目录立即停止。数据目录包含可直接使用的 `fd-desk.db`、实际输入文件和业务记录；原有本机符号链接在包内保存为实际文件。

发布数据的具体文件范围、记录数量、日期和校验值以 Release 附件 `manifest.json` 为准。快照包含客户数据，仅向获得业务授权的仓库成员提供访问权限。数据库中的客户档案、人工标签、批注、模板、跟进、账户快照及分析对象随快照保留。输入文件和原始媒体地址一并保留，远程媒体的访问仍取决于来源服务。

凭据、Codex 登录信息、私有配置、浏览器状态、缓存和本机服务状态独立保存在原机器，需在使用模型或执行采集的机器上配置。

## 启动前后端

默认数据目录为项目根目录下的 `data/`。使用恢复到其他子目录的数据时，启动 Python 后端前设置 `FD_DESK_DATA_DIR`，其值必须位于项目 `data/` 内。

```bash
uv run --frozen --directory server fd-desk serve
```

后端监听 `127.0.0.1:8765`，同时提供 `web/dist/` 页面和 `/api/` 接口。启动时扫描数据目录中的 `inbox/`，导入尚未成功处理的文件。开发前端可在另一个终端执行：

```bash
pnpm --dir web dev
```

开发页面监听 `127.0.0.1:5180`，`/api/` 代理到后端。

## 模型与问答配置

业务查询、已有报告和人工资料使用本地数据库。模型分析、问答、生图和浏览器采集分别需要对应运行配置与授权。

`data/runtime.json` 的字段如下。各路径应填写当前机器的实际位置：

| 字段 | 内容 |
| --- | --- |
| `codexHome` | 已配置渠道和身份信息的 Codex Home |
| `codexExecutable` | Codex CLI 可执行文件路径 |
| `codexNativeExecutable` | Codex 执行入口路径 |
| `model` / `modelProvider` / `reasoningEffort` | 后台分析及采集使用的模型、渠道与推理强度 |
| `caseAnalysisPricing.database` | 只读价格数据库路径 |
| `caseAnalysisPricing.historyDirectories` | 实际分析用量记录目录数组，相对路径以数据目录为基准 |
| `litellmRunner` | LiteLLM Skill runner 的实际路径 |
| `ask.model` / `ask.reasoningEffort` | 当前问答要求 `gpt-6.1-sol` / `high` |
| `ask.nodeExecutable` | Node 24 可执行文件路径，安装 macOS 服务时使用 |
| `ask.gatewayConfig` | 数据目录下的网关配置相对路径，使用 `private/zhiyi-gateway.json` |

`data/private/zhiyi-gateway.json` 需要有效的 `baseURL` 和 `apiKey`。图片试验使用 `data/private/litellm-prices.json` 和本机 LiteLLM 配置；FD 账户功能读取 `data/private/fd.env`。私有文件不进入 Git 或 Release 数据包。

在项目根目录、Node 24 环境中执行：

```bash
node agent/server.js
```

问答监听 `127.0.0.1:8766`，Python 后端代理 `/api/ask/sessions`。当前 Node 服务固定读取根目录的 `data/runtime.json` 和 `data/ask/`，完整问答运行时需将对应数据恢复到默认 `data/` 目录结构。模型请求使用共享并发额度，详细行为见 [问答说明](agent/README.md)。

## 数据提取与导入

[fddata Skill](skills/fddata/SKILL.md) 随仓库保存完整程序与参考资料。每日采集直接读取此目录。默认选择在约、体验客户，场景包含灵感成款快速和 Agent、自由改款及全部视频子场景，时区为 `Asia/Shanghai`。日期范围、原始列、行数、场景、重复行和文件校验值通过验证后才进入合并与覆盖导入。

普通导入支持 `.xlsx` 和 UTF-8 BOM `.csv.gz`。将文件放入 `data/inbox/`，执行：

```bash
uv run --frozen --directory server fd-desk scan
```

完整日期覆盖导入需要相邻的 `.csv.validation.json` 和明确的筛选配置：

```bash
uv run --frozen --directory server fd-desk import ../data/inbox/FD_在约体验_20261111-20261111.csv.gz --replace-range --scope ../collector/scope.json
```

采集需要 macOS、Chrome 已登录的后台页面、允许 Apple Events JavaScript 和有效 Codex CLI 配置，通过 DOM 确认页面条件、导出和分页。执行前查看 [采集说明](collector/README.md)。

## 验证

```bash
pnpm --dir web build
uv run --frozen --directory server fd-desk selfcheck
node agent/verify.mjs --data-only
```

`selfcheck` 使用真实的两份 Excel 输入，对照 `spec/golden.json` 检查统计与重复导入；问答数据检查需要后端已启动。执行 `node agent/verify.mjs` 会调用真实模型，产生相应模型费用。数据包的 `verify` 和 `restore` 命令检查文件内容与数据库完整性。

接口类型见 [spec/contract.ts](spec/contract.ts)，后端启动、配置、接口和导出列见 [server/README.md](server/README.md)。

## macOS 服务

完成本机配置并验证后，可按需要安装登录启动服务：

```bash
uv run --frozen --directory server fd-desk install-service
uv run --frozen --directory server fd-desk install-lan
uv run --frozen --directory server python ../collector/install.py
```

`install-service` 安装后端与问答服务；`install-lan` 需要 Caddy，配置见 `server/Caddyfile`；采集安装程序创建每日调度。局域网入口的主机名和网络可达性须根据使用机器设置，应用当前没有用户登录和访问权限管理，应限制在获授权的本机与内网环境中使用。
