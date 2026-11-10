# fd-desk 后端

在项目根目录运行：

```bash
~/.local/bin/uv run --directory server fd-desk serve
```

使用 Python 3.12，依赖版本由 `server/uv.lock` 固定。启动时导入 `data/inbox/` 中尚未成功导入的 Excel，然后监听 `127.0.0.1:8765`。同一个进程提供 `/api/*` 和已有的 `web/dist/`；前端构建目录不存在时，接口仍可使用。

```bash
~/.local/bin/uv run --directory server fd-desk selfcheck
~/.local/bin/uv run --directory server pytest
~/.local/bin/uv run --directory server ruff check fd_desk tests
```

自检在 `data/verification/` 中创建独立数据库，导入两份原始 Excel，从 SQLite 重新统计全部指标，逐项比较 `spec/golden.json`，浮点容差为 `1e-4`。随后重复导入每份文件，再次比较行数与全部汇总。成功后更新 `data/fixtures/` 中的真实接口 JSON 和两条产品线的 Excel 名单，临时数据库自动清理。

真实数据测试覆盖名单和企业详情、完整周与同星期比较、任务筛选和分层抽样、任务链、失败后删除的记录、Excel 导出、设置持久化、默认排除与内部企业排除、手工内容保护、备注、预警、周报、重复文件与重叠日期导入，以及真实图片缩略图下载和缓存。

M1 提供 `meta`、`overview`、`enterprises`、`tasks`、`chains`、`media/thumb`、`alerts`、`report`、`imports`、`settings` 接口及企业资料、下一步、备注、预警、周报和设置的写入接口。导入可使用 multipart 字段 `file`，或调用 `POST /api/imports/scan`。额外扫描命令为：

```bash
~/.local/bin/uv run --directory server fd-desk scan
```

后端周报接口已通过真实 HTTP 验证。当前 `web/dist/` 尚未生成，静态页面托管和周报打印需要在前端构建完成后验收。

任务默认每页 50 条，最多 200 条；`sample=n` 为每个抽样类别最多 n 条，同一个任务只出现一次。企业和成员在接口中保留完整手机号，企业 ID 为超管手机号 SHA-1 的前 10 位。服务关闭访问日志，错误响应不会包含原始数据或输入字段。

SQLite 使用 WAL，数据库位于 `data/fd-desk.db`。上传暂存和依赖库的临时文件均使用 `data/work/`。缩略图限制四个指定域名的 HTTPS 地址，禁止跟随重定向；缓存位于 `data/cache/thumbs/`，按本服务的文件清单保留最多 256 MB。原图下载上限为 32 MB，接口返回 WebP 和长期缓存响应头。测试数据库和导入试验只位于 `data/verification/`，不修改原始输入文件。

首次出现完整周时，灵感成款按任务数、视频按耗点，将占比至少 20% 的企业加入默认排除名单。用户修改名单后不再自动重新初始化。标记为内部的企业会加入两条线的名单。排除名单只影响 `comparableExcluded`，企业列表和预警保留全部企业。

行为模式严格遵循 `spec/reference.py`：比较间隔严格小于一小时；缺失下载状态按未下载处理；没有用户信息的快速模式记录保留为 `none`，仍计入快速模式占比分母。覆盖日期采用导入文件声明的日期范围，因此没有生成记录的日期也能声明覆盖；文件名未声明范围时使用实际任务日期，并在导入记录中提示。行主键中的出现次数在每个文件内计算，使重复和重叠导出能够更新同一行。

`Metric.value` 使用完整本周范围，其普通指标的 `comparable` 使用两周共同覆盖的星期。稳定使用企业数依赖完整周，只有两周都完整时才提供其比较数值。本周不完整时 `stable` 和 `levels` 返回 `null`。十二周历史中的无数据周使用零任务及空层级。

原始导出未包含企业类型、在约状态、运营和售后，分别返回 `unknown` 或 `null`，可以通过企业接口补充。尚未撰写的小结和周报文字返回 `null`。未使用过的产品线详情、没有成员或模型信息的任务字段，以及没有视频首帧的 `poster` 返回 `null`。M3 的最近触达返回 `null`，触达记录返回空数组，周报触达统计为零。M1 尚未检查 FD 账号，因此 `fdAccount` 为未连接状态，用户名和检查时间为空。

M2 的分析矩阵和提示词簇、M3 的触达与模板推送、M4 的重跑和采集按 `CODEX.md` 逐个里程碑继续。`GET /api/tasks` 的 `cluster` 筛选在 M2 提供，M1 请求此筛选返回 `409 milestone_unavailable`。
