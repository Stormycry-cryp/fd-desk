# FD 数据更新

采集使用仓库内的 [fddata 技能](../skills/fddata/SKILL.md)，筛选配置为 `collector/scope.json`，时区为 `Asia/Shanghai`。客户选择在约、体验；场景包含灵感成款快速和 Agent、自由改款及全部视频子场景。导出字段没有客户状态，页面筛选证据随每次采集保存，企业档案的在约状态保持真实已知值。

初始数据覆盖 `2026-09-10 00:00:00` 至 `2026-11-09 23:59:59`，共有 302,537 条生成记录。项目通过 `data/inbox/` 中的符号链接引用已经核验的合并文件及其 `.csv.validation.json`，原始资料保存在原有导出目录。用于原有指标自检的两份 Excel 继续保留。

每日按以下顺序更新：

1. 读取后端覆盖日期，确定截至昨天的完整自然日。初始数据之后的第一个日期为 `2026-11-10`，在 `2026-11-11` 取得完整数据。中断后补齐缺少的日期。
2. 使用 fddata，按完整自然日串行查询和导出；刷新截至昨天的最近 14 个自然日，以更新生成状态和延后发生的下载。单日超过导出容量时按小时拆分，最后核验完整日期。
3. 每次采集的原始文件、运行记录、页面筛选证据、清单和校验报告放在 `data/collector/<数据日期>/<执行日期>/`。按技能程序核验实际文件及独立页面总数，合并输出 `FD_在约体验_YYYYMMDD-YYYYMMDD.csv.gz`。相同日期的起止值用于单日文件。
4. 将已核验的合并文件和对应的 `.csv.validation.json` 引用到 `data/inbox/`，然后执行下面的覆盖导入命令。一次文件对应一次事务，文件校验值、行数、每天数量、场景和日期范围通过后才提交。覆盖只作用于校验报告声明的完整日期和场景，保留企业手工资料、备注和设置。
5. 检查 `GET /api/meta` 的覆盖和刷新时间、导入记录、实际行数及周指标。重复导入应当没有新增记录。失败时保留该次证据并停止受影响日期的导入。

```bash
~/.local/bin/uv run --directory server fd-desk import ../data/inbox/FD_在约体验_YYYYMMDD-YYYYMMDD.csv.gz --replace-range --scope ../collector/scope.json
```

普通追加和更新导入可以通过 `POST /api/imports`、`POST /api/imports/scan` 或 `fd-desk scan` 完成，支持 `.xlsx` 和 UTF-8 BOM `.csv.gz`。完整日期覆盖使用上述命令和 fddata 校验报告。

每个日期的来源引用、运行状态和校验值保存在 `data/collector/state.json`，已成功核验的文件在中断后复用。初始数据、唯一原始资料、运行数据库与手工资料独立保留。

```bash
~/.local/bin/uv run --directory server python ../collector/daily.py --plan
~/.local/bin/uv run --directory server python ../collector/daily.py
~/.local/bin/uv run --directory server python ../collector/install.py
```

采集由本机 Codex CLI 执行，模型、渠道和推理强度读取 `data/runtime.json`。Chrome 通过 `browser.py` 和 AppleScript 操作本任务的专用标签页，使用已有登录状态，通过 DOM 确认条件和点击控件。禁止读取浏览器存储、Cookie 或额外发送接口请求，不使用截图。Chrome 需要允许 Apple Events JavaScript。

安装程序生成并加载 `~/Library/LaunchAgents/cn.zhiyitech.fd-desk.daily.plist`。每日 07:30 执行，登录时检查，每三十分钟检查未完成更新。已完成日期不重复调用模型；进程锁阻止并行操作页面。状态保存实际执行目录、校验值、导入 ID 和本次刷新日期。电脑中断期间的缺失日期在恢复后补充。

恢复时核对原 Codex CLI 的进程身份；原进程仍在执行时等待已有任务。跨日期恢复继续读取原执行目录中的已核验文件，刷新日期采用真实提取时间。较早日期提取的文件完成导入后，仍按每日计划刷新。

CLI 单次输出限制 64 MB，事件记录限制 128 KB。调度日志单份约 1 MB，超出后保留最近部分；客户原始资料不进入日志清理范围。零记录的日期也必须由独立页面总数和完整日期报告证明。

生成记录完成后，调度继续采集生成分析页面下方的客户点数记录。账户采集使用独立 Chrome 标签页和当前 Codex CLI 配置，按页面实际总数逐页核验。完整快照、每页 DOM 证据和采集状态保存在 `data/collector/accounts/<采集日期>/codex-<编号>/`。每日成功后不再重复采集；失败在后续调度中重试，生成记录的导入结果保持有效。

手动执行账户采集：

```bash
~/.local/bin/uv run --frozen --directory server python ../collector/accounts.py --force
```

也可以调用 `POST /api/accounts/collect`，通过 `GET /api/pipeline` 的 `accounts` 字段查看运行状态、总行数、匹配数和失败原因。`GET /api/accounts/unmatched` 返回最近一次成功采集的未匹配账号。数据不完整时整次快照拒绝入库，最近成功时间保持原值。

账户快照完整保留，查询时从最近 30 个自然日中取每天最后一次余额。客户名单返回最近 8 个点，企业详情返回最近 30 个点。手工修改负责人的企业保留手工值；采集仍保存后台原始销售和售后，供核对来源。点数分析共享整个 FD+ 账户，按照快照时间解释余额与消耗。
