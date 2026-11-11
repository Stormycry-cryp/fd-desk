# fd-desk 问答服务

此服务使用 Node 24、pi-durable JSONL、pi-ai 和 chord，独立监听 `127.0.0.1:8766`。服务只读取 `data/private/zhiyi-gateway.json` 的 `baseURL` 和 `apiKey`，只调用 `gpt-6.1-sol` 的 Responses 接口，推理强度为 `high`。会话和恢复数据存放在 `data/ask/`。

在仓库根目录安装依赖和运行：

```sh
export PATH="/Users/chenyunzhe/.nvm/versions/node/v24.15.0/bin:$PATH"
export TMPDIR="$PWD/data/work/rework/r5/tmp"
export npm_config_cache="$PWD/data/work/rework/r5/npm-cache"
mkdir -p "$TMPDIR" "$npm_config_cache"
npm ci --prefix agent --ignore-scripts
node agent/server.js
```

Python 服务调用 `fd_desk.ask_proxy.mount(app, context)` 注册问答路由；主应用负责安装和进程管理。模型通过 GET 查询 `127.0.0.1:8765` 上的业务接口，支持跨周比较、原因分析、方案讨论、提示词建议和连续追问。事实依据来自真实查询和既有对话，模型可以计算、推断并解释自己的判断。

提供三个工具：

- `query_data`：总览、客户、档案、记录、趋势、模板、变动原因、批注等业务查询。`view` 选择字段、排序和分页；`summary` 在展示裁剪前完成分组、计数、去重、求和、均值和中位数统计。每次文字结果最多 20000 字节，裁剪会标记 `truncated`。任务或记录接口返回部分页时，汇总包含 `total` 和 `complete` 说明范围。
- `calculate`：差值、比值、百分比、变化率、百分点以及常用统计运算，支持一次提交多项计算，保留原值和舍入值。
- `inspect_images`：依据查询中的 `imageId`，通过本机缩略图接口读取真实任务输入图、输出图和视频封面，交给公司网关的模型分析。引用信息保存在会话中，连续追问可以再次查看。

回答支持多段自然文字、数字卡片、图表、列表和澄清问题，按问题选择展示形式。计算所得的差值、变化率和格式化百分比可以直接使用。代码检查展示结构，正常文字和模型分析直接呈现。pi 的实时状态通过 `delta` 和 `block` 事件流式返回，界面收到正文后即可显示。Responses 的 `commentary` 和 `final_answer` 分别处理，依据最终回答生成展示内容。真正的调用或结构错误保留具体原因与已有文字。

历史会话直接只读 JSONL，查看列表或历史内容不会触发模型请求。运行实例按需打开，空闲十秒后关闭，JSONL 继续保留；重启进程后可以重新打开。会话列表返回创建和更新时间，客户端可按日期分组。`stop` 会中止当前任务并保留状态。工具调用按分析需要执行，网关限流返回明确的错误。问答只读，业务内容的保存和执行使用对应页面。

实际模型请求与 Python 后台共用 `data/service/model-capacity.sqlite3`。总额度五项，为当前主会话预留一项，应用最多四项；后台分析、采集和图片生成合计最多三项，问答使用剩余名额。排队问答可以取消，进程结束后释放名额。连续工具调用和持久会话恢复都经过同一个模型请求入口。

查询白名单包含多周趋势、企业全部生成记录和记录分析历史。客户名单和记录查询继承对应页面筛选，工具返回的定位保留实际筛选参数。Python 的 `fd-desk install-service` 同时安装后端和问答两个登录启动服务。

转化候选的 `conversion` 字段提供自由改款的真实用量、下载率、主要任务、模型、同星期变化和代码建议。分析转化机会时使用这些字段，结合客户档案继续讨论；目标功能的顶层任务字段保留原有含义。

使用已经导入的真实数据验证计算、汇总、排序和保留回答的逐字符流式解析：

```sh
node agent/verify.mjs --data-only
```

运行实际模型问答、连续追问、多周分析、分组排行及看图分析：

```sh
node agent/verify.mjs
```

验证结果保存在 `data/fixtures/rework/R5/analysis-agent-verification.json`。脚本复用真实业务数据，只创建验收问答会话，并记录首段文字与完成事件的时间。

`--continue` 继续同一份验收，复用已经通过的结果。会话空闲关闭后，可运行 `node agent/verify-session.mjs <会话编号>`，读取 pi 持久化记录，检查真实工具调用、图片数量和最终回答内容。检查结果保存在 `data/fixtures/rework/R5/session-analysis-verification.json`；`node agent/verify.mjs --data-only --continue --phase` 可复现该回答的阶段选择和逐字符流式展示。添加 `--images` 会核对 `inspect_images` 调用与真实图片输入，另存为 `session-image-verification.json`。

固定内网入口 `http://chem.local:8767` 提供页面、接口和问答的统一地址。运行 `node agent/verify-lan.mjs http://chem.local:8767`，验证经过内网代理的实际流式回答及会话读取，回执保存在 `data/fixtures/rework/lan-verification.json`。访问设备需要能够解析该 Bonjour 名称。
