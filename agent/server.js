import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { AssistantEntry, createRegistry, defineDoc, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { customerTarget, effectiveArgs, getJson, queryCustomers } from "./queries.js";
import { answerBlocks, answerStream, blockText, responseText } from "./answers.js";
import { calculate, calculationSchema, presentRows, summarySchema } from "./analysis.js";
import { imageOutput, imageReferences } from "./media.js";
import { readStoredState } from "./sessions.js";
import { ModelCapacity, limitProviderStreams } from "./capacity.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionDir = join(rootDir, "data/ask");
const runtime = JSON.parse(await readFile(join(rootDir, "data/runtime.json"), "utf8"));
const askConfig = runtime.ask;
if (askConfig?.model !== "gpt-6.1-sol" || askConfig?.reasoningEffort !== "high" || typeof askConfig.gatewayConfig !== "string") throw Error("问答模型配置无效");
const gatewayPath = resolve(rootDir, "data", askConfig.gatewayConfig);
if (!gatewayPath.startsWith(join(rootDir, "data/private") + "/")) throw Error("网关配置路径无效");
const gateway = await readFile(gatewayPath, "utf8").then(JSON.parse).catch(() => { throw Error("网关配置读取失败"); });
if (typeof gateway.baseURL !== "string" || typeof gateway.apiKey !== "string" || !gateway.apiKey) throw Error("网关配置缺失");
const model = { id: "gpt-6.1-sol", name: "gpt-6.1-sol", api: "openai-responses", provider: "zhiyi", baseUrl: gateway.baseURL, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
const models = createModels();
const capacity = new ModelCapacity(join(rootDir, "data"), join(rootDir, "server/fd_desk/model_capacity.sql"));
models.setProvider(createProvider({ id: "zhiyi", name: "知衣网关", models: [model], auth: { apiKey: { name: "知衣网关", resolve: async () => ({ auth: { apiKey: gateway.apiKey } }) } }, api: limitProviderStreams(openAIResponsesApi(), capacity) }));
const State = defineDoc({ kind: "fd.ask", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ session: null, evidence: [], images: {}, pending: null }), checkpointWhen: () => true });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queryDefs = {
  overview: ["/api/overview", ["line", "week"], "week"],
  customers: ["/api/enterprises", ["line", "week", "model"], "customers"],
  profile_roster: ["/api/profiles/roster", ["line", "week"], "customers"],
  tags: ["/api/tags", ["line"], "customers"],
  profile: ["/api/profiles/:enterprise", [], "enterprise"],
  profile_versions: ["/api/profiles/:enterprise/versions", [], "enterprise"],
  enterprise: ["/api/enterprises/:enterprise", ["week"], "enterprise"],
  tasks: ["/api/tasks", ["line", "week", "enterprise", "user", "pattern", "intent", "mode", "model", "downloaded", "failed", "cluster", "offset", "limit"], "enterprise"],
  chains: ["/api/chains", ["line", "week", "enterprise", "minLength", "downloaded"], "enterprise"],
  alerts: ["/api/alerts", ["line", "week", "kind"], "week"],
  trends: ["/api/trends", ["line", "week"], "week"],
  records: ["/api/records", ["enterprise", "scope", "from", "to", "result", "intent", "mode", "model", "user", "pattern", "noted", "q", "sort", "offset", "limit"], "enterprise"],
  record_analyses: ["/api/records/analyses", ["enterprise"], "enterprise"],
  cases: ["/api/cases", ["line", "week", "from", "to", "unit", "enterprise", "outcome", "result", "intent", "pattern", "model", "mode", "level", "movement", "slow", "steps", "rating", "tag", "status", "collection", "noted", "q", "sort", "offset", "limit"], "cases"],
  case_detail: ["/api/cases/:caseId", ["unit", "week"], "cases"],
  case_issues: ["/api/cases/issues", ["line", "week", "from", "to", "enterprise"], "cases"],
  case_tags: ["/api/cases/tags", ["line"], "cases"],
  case_collections: ["/api/cases/collections", ["line"], "cases"],
  case_batches: ["/api/cases/batches", ["line"], "cases"],
  case_analyses: ["/api/cases/analyses", ["line"], "cases"],
  inspiration_analysis: ["/api/analysis/inspiration", ["week", "excluded"], "analysis"],
  video_analysis: ["/api/analysis/video", ["week", "excluded"], "analysis"],
  clusters: ["/api/clusters", ["line", "week", "enterprise", "candidate"], "analysis"],
  templates: ["/api/templates", ["line", "kind", "state", "enterprise"], "templates"],
  template_monitor: ["/api/templates/monitor", ["line", "kind"], "templates"],
  opportunities: ["/api/templates/opportunities", ["line", "kind", "state", "enterprise"], "templates"],
  movements: ["/api/movements", ["line", "week", "trigger"], "week"],
  daily: ["/api/daily", ["line", "from", "to", "enterprise"], "analysis"],
  findings: ["/api/findings", ["line"], "analysis"],
  annotations: ["/api/annotations", ["enterprise", "from", "to", "resolved"], "enterprise"],
  followups: ["/api/followups", ["line", "week"], "followups"],
  report: ["/api/report", ["week"], "week"],
  conversion: ["/api/conversion", ["line", "week"], "customers"],
  cross_line: ["/api/cross-line", ["week"], "analysis"],
  trials: ["/api/trials", ["template", "enterprise"], "playground"],
  trial_candidates: ["/api/trials/candidates", ["template", "cluster", "enterprise", "chain", "caseIds", "limit"], "playground"],
  trial_budget: ["/api/trials/budget", [], "playground"],
  pipeline: ["/api/pipeline", [], "data"],
  imports: ["/api/imports", [], "data"],
  metadata: ["/api/meta", [], "data"]
};
const choice = { type: "string", enum: ["any", "true", "false"], description: "不筛选时必须为 any；仅有明确条件时选择 true 或 false" };
const parameters = { type: "object", properties: { query: { type: "string", enum: Object.keys(queryDefs), description: "查询类型" }, line: { type: "string", enum: ["inspiration", "video"] }, week: { type: "string" }, enterprise: { type: "string" }, from: { type: "string" }, to: { type: "string" }, excluded: choice, model: { type: "string" }, models: { type: "string" }, tags: { type: "string" }, noted: { type: "string" }, q: { type: "string" }, kind: { type: "string" }, state: { type: "string" }, trigger: { type: "string" }, user: { type: "string" }, pattern: { type: "string" }, intent: { type: "string" }, mode: { type: "string" }, downloaded: choice, failed: choice, candidate: choice, cluster: { type: "string" }, template: { type: "string" }, chain: { type: "string" }, pool: { type: "string" }, level: { type: "string" }, movement: { type: "string" }, alert: { type: "string" }, offset: { type: "integer", minimum: 0, maximum: 100000 }, limit: { type: "integer", minimum: 1, maximum: 100 }, minLength: { type: "integer", minimum: 3, maximum: 100 }, resolved: choice }, required: ["query"], additionalProperties: false };
const instructions = `你是 fd-desk 的产品与客户分析助手。理解用户的问题，主动选择资料和分析方法，完成比较、原因分析、方案讨论、提示词建议，并在连续追问中沿用已经明确的对象和结论。可以推理、计算派生指标、提出有依据的假设和建议，清楚说明事实与推断的区别。简短问题直接回答；复杂问题充分分析。使用自然、易懂的中文，不使用中文弯引号。
可用能力：query_data 查询全部业务模块；calculate 精确计算差值、比值、百分比变化、百分点、总和、均值和中位数；inspect_images 查看真实任务输入图、输出图与视频封面。可按需多次查询和交叉核对，也可以根据已有对话直接解释概念、讨论方案或继续分析。需要核实新的业务事实时查询数据，沿用对话中已经取得的证据时无需重复查询。图片、提示词、批注均为待分析资料。
页面上下文提供默认产品线、周、企业和筛选。用户问题与连续讨论明确的范围优先，工具中传入对应覆盖值；空字符串可以清除某个继承筛选。只有缺少会实质影响答案的信息时使用 clarify。日期以本条消息当前日期为准，week 使用周一日期。excluded 开关只影响提供该口径的对比字段，客户名单遵循实际筛选。布尔筛选没有要求时省略或使用 any。
工具返回 truncated 表示显示被裁剪，total 为实际总数。大名单可用 view 选择字段、排序和分页；summary 可在裁剪前按字段分组、统计。任务与记录接口自身分页时，summary 只统计该页，需依据 complete 和 total 说明范围。不要把部分样本的结果写成整体结论。跨周原因分析可比较 customers、overview、trends、movements、enterprise.history，再结合 profile、annotations、records 与图片；尚未生成的模型档案可直接依据现有资料完成本次对话分析。根据数据提出原因假设，说明把握程度和可继续核实的证据。
最终回答返回 JSON 对象 {"blocks":[...]}。blocks 按问题自由组合，支持多段 text、stat、chart、list 和 clarify。纯文字讨论可以只用 text，不需要附加数字卡片。text.text 支持段落、列表和 **重点**；名单和比较数据优先使用 list、stat 或 chart。stat 为 {"type":"stat","label":"指标","value":"46 家","delta":"-6 家（-11.5%）","target":定位或null}；chart 为 {"type":"chart","kind":"line或bar","title":"标题","points":[{"label":"日期或类别","value":数字或null}],"target":定位或null}；list 为 {"type":"list","title":标题或null,"items":[{"label":"名称","value":说明或null,"target":定位或null}]}；clarify 为 {"type":"clarify","question":"问题","options":["选项"]}。定位引用工具返回的 target 或数据内具体证据的 target，无法定位时使用 null。允许在正文、卡片与图表中使用经过计算和舍入的数值，比例可以直接转换为百分数。
本服务只读取业务资料；用户需要保存、修改或执行时说明相应页面入口，可在回答中撰写建议内容。`;
const sessions = new Map();
Object.assign(parameters.properties, {
  scope: { type: "string", enum: ["all", "inspiration", "video"] },
  result: { type: "string", description: "Case 支持 downloaded、not_downloaded、failed、deleted，逗号分隔多选；records 使用单个结果" },
  sort: { type: "string", enum: ["newest", "oldest", "bad_first", "steps", "points"] },
  caseId: { type: "string" }, caseIds: { type: "string" }, unit: { type: "string", enum: ["chain", "task"] },
  outcome: { type: "string" }, steps: { type: "string" }, rating: { type: "string" }, tag: { type: "string" },
  status: { type: "string" }, collection: { type: "string" }, slow: choice,
  trend: { type: "string", description: "客户多周趋势，churned、sliding、fading；多值使用逗号分隔" },
  view: {
    type: "object", properties: {
      fields: { type: "array", items: { type: "string" }, description: "每条记录要保留的字段，可用 enterprise.id 等字段路径" },
      orderBy: { type: "string" }, descending: { type: "boolean" },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 },
    }, additionalProperties: false,
  },
  summary: summarySchema,
});
const opening = new Map();
const closing = new Map();
const policy = `${instructions}\n客户名单支持 pool、level、movement、alert、trend、models、intent、tags、noted、q；同一维度多值用逗号分隔，标签使用 dimension:value。转化页使用 pool=convert，列表的 conversion 字段提供自由改款任务、下载率、近期变化、主要任务与转化建议；顶层 tasks 继续表示目标功能的使用量。分析转化机会时依据 conversion 的实际使用证据，并将建议与已验证事实分别说明。`;
const now = () => new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00");

function clipped(value, target) {
  const wrapper = { target, truncated: false, data: value };
  if (Buffer.byteLength(JSON.stringify(wrapper)) <= 20000) return wrapper;
  const shorten = (item, depth = 0) => {
    if (typeof item === "string") return item.slice(0, 700);
    if (Array.isArray(item)) return item.slice(0, Math.max(1, 8 - depth * 2)).map(part => shorten(part, depth + 1));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).slice(0, 60).map(([key, part]) => [key, shorten(part, depth + 1)]));
    return item;
  };
  wrapper.truncated = true;
  wrapper.data = shorten(value);
  if (Buffer.byteLength(JSON.stringify(wrapper)) > 20000) wrapper.data = { unavailable: "结果过大，请缩小查询范围" };
  return wrapper;
}

function targetFor(page, args) {
  const target = { page };
  if (args.line) target.line = args.line;
  if (args.week) target.week = args.week;
  if (args.enterprise && page === "enterprise") target.enterprise = args.enterprise;
  if (page === "enterprise" && !args.enterprise) target.page = "customers";
  if (target.page === "enterprise") target.tab = args.query === "annotations" ? "notes" : ["tasks", "chains", "records", "record_analyses"].includes(args.query) ? "tasks" : "profile";
  if (args.query === "customers") {
    const filters = customerTarget(args);
    if (Object.keys(filters).length) target.filters = filters;
  }
  if (args.query !== "customers") {
    const filters = Object.fromEntries((queryDefs[args.query]?.[1] || []).filter(key => !["line", "week", "enterprise"].includes(key) && args[key] !== undefined && args[key] !== null && args[key] !== "" && args[key] !== "any").map(key => [key, String(args[key])]));
    if (Object.keys(filters).length) target.filters = filters;
  }
  if (args.query === "case_detail") target.filters = { ...target.filters, case: args.caseId };
  return target;
}

function makeRegistry() {
  const tool = defineTool({ name: "query_data", description: "只读查询 fd-desk 全部业务模块。省略的条件继承页面上下文；问题或连续讨论指定其他范围时传入覆盖值，空字符串清除筛选。支持 view 字段选择、排序和分页，以及 summary 对裁剪前数据分组汇总。", parameters, replay: "safe", execute: async (input, api, context) => {
    const snapshot = await api.commit(async tx => { const state = await tx.doc(State, api.conversationId); const message = state.session.messages.find(item => item.id === state.pending?.userMessageId) || [...state.session.messages].reverse().find(item => item.role === "user"); return { context: message?.context ? JSON.parse(JSON.stringify(message.context)) : {} }; }, context);
    const args = effectiveArgs(input, snapshot.context);
    const definition = queryDefs[args.query];
    if (!definition) throw Error("不支持的查询");
    let [path, fields, page] = definition;
    if (path.includes(":enterprise")) {
      if (typeof args.enterprise !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(args.enterprise)) throw Error("需要有效的企业 ID");
      path = path.replace(":enterprise", encodeURIComponent(args.enterprise));
    }
    if (path.includes(":caseId")) {
      if (typeof args.caseId !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(args.caseId)) throw Error("需要有效的 Case ID");
      path = path.replace(":caseId", encodeURIComponent(args.caseId));
    }
    const data = args.query === "customers" ? await queryCustomers(args) : await getJson(path, Object.fromEntries(fields.map(field => [field, args[field]])));
    if (args.query === "metadata" && data && typeof data === "object") delete data.fdAccount;
    const target = targetFor(page, args);
    const presented = presentRows(data, { ...args.view, summary: args.summary });
    if (args.summary && typeof data?.total === "number") {
      presented.total = data.total;
      presented.complete = data.total === presented.sourceRows;
    }
    const media = imageReferences(presented, target);
    const result = clipped(media.data, target);
    await api.commit(async tx => { const state = await tx.doc(State, api.conversationId); state.evidence.push(result); state.images = { ...state.images, ...media.references }; }, context);
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  } });
  const calculator = defineTool({ name: "calculate", description: "精确计算派生指标。subtract、divide、percentage 的 values 为 [分子或当前值, 分母或此前值]；percent_change 为 (当前-此前)/此前*100；percentage_points 为两个0到1比例之差乘100。一次可以提交多项计算。", parameters: calculationSchema, replay: "safe", execute: async (input, api, context) => {
    const result = { calculations: input.calculations.map(calculate) };
    await api.commit(async tx => { const state = await tx.doc(State, api.conversationId); state.evidence.push({ target: null, truncated: false, data: result }); }, context);
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  } });
  const images = defineTool({ name: "inspect_images", description: "查看 query_data 返回的真实输入、输出图片或视频封面。传入 Media.imageId，可引用本会话此前查到的图片。用于判断成图质量、客户任务和失败原因。", parameters: { type: "object", properties: { imageIds: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["imageIds"], additionalProperties: false }, replay: "safe", execute: async (input, api, context) => {
    const references = await api.commit(async tx => {
      const state = await tx.doc(State, api.conversationId);
      return input.imageIds.map(id => { const reference = state.images?.[id]; if (!reference) throw Error("图片编号不存在，请先查询相关任务"); return { id, reference: JSON.parse(JSON.stringify(reference)) }; });
    }, context);
    const output = [];
    for (const { id, reference } of references) output.push(...await imageOutput(id, reference));
    return { output };
  } });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "fd-readonly", sections: [section("fd-policy", () => policy, { tag: false })], tools: [tool, calculator, images] }));
  return registry;
}

async function openSession(id, create = false) {
  if (closing.has(id)) await closing.get(id);
  if (opening.has(id)) return opening.get(id);
  const pending = loadSession(id, create);
  opening.set(id, pending);
  try { return await pending; } finally { opening.delete(id); }
}

async function loadSession(id, create = false) {
  if (sessions.has(id)) return sessions.get(id);
  const directory = join(sessionDir, id);
  if (create) await mkdir(directory, { recursive: true });
  else if (!(await stat(directory).catch(() => null))?.isDirectory()) return null;
  const harness = await Harness.open(await openNodeJsonlStorage(directory, ctx, { fsync: true }), { models, registry: makeRegistry(), identity: { attribution: null }, settings: { retry: { maxRetries: 1 }, stream: { timeoutMs: 120000 } } }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: "zhiyi", modelId: askConfig.model }, thinkingLevel: askConfig.reasoningEffort } });
  await conversation.configure({ maxTurns: null }, ctx);
  const instance = { id, directory, harness, conversation, busy: false };
  sessions.set(id, instance);
  let state = await harness.snapshot(State, conversation.id, ctx);
  if (!state?.session && create) {
    await conversation.commit(async tx => { const doc = await tx.doc(State, conversation.id); doc.session = { id, title: "新会话", messages: [], createdAt: now(), updatedAt: now() }; }, ctx);
    state = await harness.snapshot(State, conversation.id, ctx);
  }
  if (state?.pending) {
    instance.busy = true;
    harness.resume();
    instance.running = finish(instance, state.pending.submissionId, state.pending.messageId);
  }
  return instance;
}

function releaseLater(instance) {
  clearTimeout(instance.timer);
  instance.timer = setTimeout(async () => {
    if (instance.busy || instance.users) return releaseLater(instance);
    if (sessions.get(instance.id) !== instance) return;
    await closeIdle(instance);
  }, 10000);
  instance.timer.unref();
}

async function closeIdle(instance) {
  if (instance.busy || instance.users || sessions.get(instance.id) !== instance) return;
  clearTimeout(instance.timer);
  sessions.delete(instance.id);
  const promise = instance.harness.close(ctx);
  closing.set(instance.id, promise);
  try { await promise; } catch { console.error("关闭问答会话失败"); } finally { closing.delete(instance.id); }
}

function hold(instance, res) {
  instance.users = (instance.users || 0) + 1;
  let released = false;
  const release = () => { if (released) return; released = true; instance.users--; releaseLater(instance); };
  res.once("finish", release);
  res.once("close", release);
}

async function update(instance, callback) {
  await instance.conversation.commit(async tx => callback(await tx.doc(State, instance.conversation.id)), ctx);
}
async function snapshot(instance) { return await instance.harness.snapshot(State, instance.conversation.id, ctx); }

async function readState(id) {
  const instance = sessions.get(id);
  if (!instance) {
    const directory = join(sessionDir, id);
    return existsSync(directory) ? readStoredState(directory) : null;
  }
  instance.users = (instance.users || 0) + 1;
  try { return await snapshot(instance); }
  finally { instance.users--; releaseLater(instance); }
}

async function finish(instance, submissionId, messageId, emit = () => {}) {
  let watch;
  let streamed = [];
  try {
    const stream = answerStream(emit);
    let lastRaw = "";
    let lastStatus = "";
    const progress = value => {
      const live = value.docs["pi.live"];
      const active = live?.tools?.filter(tool => tool.status !== "done") || [];
      const names = { query_data: "正在查阅业务资料", calculate: "正在计算和比较", inspect_images: "正在查看任务图片" };
      const status = active.length ? [...new Set(active.map(tool => names[tool.name] || "正在分析"))].join("；") : "正在组织回答";
      if (status !== lastStatus) { emit({ type: "status", text: status }); lastStatus = status; }
      const content = live?.generation?.message?.content || [];
      if (content.some(part => part.type === "toolCall")) return;
      const raw = responseText([{ content }]);
      if (raw && raw !== lastRaw && /^\s*(?:```(?:json)?\s*)?\{/.test(raw)) {
        streamed = stream(raw);
        lastRaw = raw;
      }
    };
    watch = await instance.conversation.watch(ctx);
    progress(watch.value);
    watch.start(call => { if (call.kind === "value") progress(call.value); });
    const submission = await instance.harness.submission(submissionId, ctx);
    if (!submission) throw Error("找不到持久化任务");
    const settled = await submission.wait(ctx);
    if (settled.status !== "done" || settled.type !== "input") throw Error(`问答未完成：${settled.reason || settled.status}${settled.detail ? `：${settled.detail}` : ""}`);
    const answer = await instance.conversation.commit(tx => tx.entry(AssistantEntry, settled.answer), ctx);
    const raw = responseText(answer?.model || []);
    const blocks = answerBlocks(raw);
    await watch.stop();
    await update(instance, doc => { const message = doc.session.messages.find(item => item.id === messageId); message.blocks = blocks; message.text = blockText(blocks); message.state = "done"; doc.pending = null; doc.evidence = []; doc.session.updatedAt = now(); });
    const message = (await snapshot(instance)).session.messages.find(item => item.id === messageId);
    blocks.forEach((block, index) => emit({ type: "block", index, block }));
    emit({ type: "done", message });
  } catch (error) {
    if (watch) await watch.stop();
    const limited = /429|concurrency limit|rate.limit/i.test(String(error.message));
    const reason = limited ? "知衣网关并发已达到上限，请稍后重试" : String(error.message || "问答未能完成").replaceAll(gateway.apiKey, "[redacted]").slice(0, 500);
    const partial = streamed.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n\n");
    await update(instance, doc => { const message = doc.session.messages.find(item => item.id === messageId); if (message) { message.text = [partial, reason].filter(Boolean).join("\n\n"); message.state = "failed"; } doc.pending = null; doc.evidence = []; doc.session.updatedAt = now(); });
    emit({ type: "error", error: { code: limited ? "ask_rate_limited" : "ask_failed", message: reason } });
  } finally { instance.busy = false; releaseLater(instance); }
}

function send(res, status, data = null) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(status === 204 ? "" : JSON.stringify(data)); }
async function body(req) {
  let text = "";
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw Error("请求过大"); }
  return text ? JSON.parse(text) : {};
}
async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1:8766");
  if (url.pathname === "/api/ask/sessions" && req.method === "POST") {
    const instance = await openSession(randomUUID(), true);
    hold(instance, res);
    return send(res, 200, (await snapshot(instance)).session);
  }
  if (url.pathname === "/api/ask/sessions" && req.method === "GET") {
    const result = [];
    for (const id of await readdir(sessionDir)) if (idPattern.test(id)) {
      const state = await readState(id);
      if (state?.session) { const { messages, ...summary } = state.session; result.push(summary); }
    }
    return send(res, 200, result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }
  const match = /^\/api\/ask\/sessions\/([0-9a-f-]+)(?:\/(messages|stop))?$/.exec(url.pathname);
  if (!match || !idPattern.test(match[1])) return send(res, 404, { code: "not_found", message: "接口不存在" });
  if (!match[2] && req.method === "GET") {
    const state = await readState(match[1]);
    return state?.session ? send(res, 200, state.session) : send(res, 404, { code: "not_found", message: "会话不存在" });
  }
  const instance = await openSession(match[1]);
  if (!instance) return send(res, 404, { code: "not_found", message: "会话不存在" });
  hold(instance, res);
  if (!match[2] && req.method === "DELETE") {
    clearTimeout(instance.timer);
    await instance.conversation.abort(ctx);
    if (instance.running) await instance.running;
    await instance.harness.close(ctx);
    sessions.delete(instance.id);
    await rm(instance.directory, { recursive: true, force: true });
    return send(res, 204);
  }
  if (match[2] === "stop" && req.method === "POST") { await instance.conversation.abort(ctx); if (instance.running) await instance.running; return send(res, 204); }
  if (match[2] !== "messages" || req.method !== "POST") return send(res, 405, { code: "method_not_allowed", message: "方法不支持" });
  if (instance.busy) return send(res, 409, { code: "busy", message: "会话正在回答" });
  instance.busy = true;
  let input;
  try { input = await body(req); } catch { instance.busy = false; return send(res, 422, { code: "invalid_request", message: "消息格式无效" }); }
  if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > 10000 || !input.context || typeof input.context !== "object" || Array.isArray(input.context) || Buffer.byteLength(JSON.stringify(input.context)) > 8192) { instance.busy = false; return send(res, 422, { code: "invalid_request", message: "消息或上下文无效" }); }
  const messageId = randomUUID();
  const createdAt = now();
  try {
    let submissionId;
    await instance.conversation.commit(async tx => {
      const doc = await tx.doc(State, instance.conversation.id);
      doc.evidence = [];
      const userMessageId = randomUUID();
      doc.session.messages.push({ id: userMessageId, role: "user", text: input.text, blocks: [], context: input.context, state: "done", createdAt }, { id: messageId, role: "assistant", text: null, blocks: [], context: null, state: "streaming", createdAt });
      if (doc.session.title === "新会话") doc.session.title = input.text.slice(0, 32);
      doc.session.updatedAt = createdAt;
      submissionId = await instance.conversation.submit(tx, { type: "input", content: `当前日期：${createdAt.slice(0, 10)}（Asia/Shanghai）\n页面上下文：${JSON.stringify(input.context)}\n用户问题：${input.text}` });
      doc.pending = { submissionId, messageId, userMessageId };
    }, ctx);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const emit = event => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    emit({ type: "status", text: "正在查询和分析" });
    instance.running = finish(instance, submissionId, messageId, emit);
    await instance.running;
    res.end();
  } catch (error) {
    instance.busy = false;
    await update(instance, doc => { const message = doc.session.messages.find(item => item.id === messageId); if (message) message.state = "failed"; doc.pending = null; doc.evidence = []; }).catch(() => {});
    if (!res.headersSent) send(res, 500, { code: "ask_failed", message: "问答启动失败" });
    else { if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "error", error: { code: "ask_failed", message: "问答启动失败" } })}\n\n`); res.end(); }
  }
}

await mkdir(sessionDir, { recursive: true });
http.createServer((req, res) => { handle(req, res).catch(() => { console.error("问答请求失败"); if (!res.headersSent) send(res, 500, { code: "internal_error", message: "问答服务处理失败" }); else res.end(); }); }).listen(8766, "127.0.0.1", () => console.log(`问答服务监听 127.0.0.1:8766；工作目录 ${rootDir}；PID ${process.pid}`));
