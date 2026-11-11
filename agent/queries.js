const customerFilters = ["pool", "level", "movement", "alert", "trend", "models", "intent", "tags", "noted", "q"];
const split = value => typeof value === "string" ? value.split(",").map(item => item.trim()).filter(Boolean) : [];

export function effectiveArgs(args, context = {}) {
  const result = { ...args };
  for (const field of ["line", "week", "enterprise", "excluded"]) {
    if (result[field] === undefined || result[field] === null || result[field] === "any") {
      if (context[field] !== null && context[field] !== undefined) result[field] = String(context[field]);
    }
  }
  if (args.query === "customers") {
    for (const field of customerFilters) if (result[field] === undefined && typeof context.filters?.[field] === "string") result[field] = context.filters[field];
    if (args.model !== undefined && args.models === undefined) result.models = args.model;
  }
  if (args.query === "records") {
    if (result.scope === undefined) result.scope = "all";
    for (const field of ["from", "to", "result", "intent", "mode", "model", "user", "pattern", "noted", "q", "sort"])
      if (result[field] === undefined && typeof context.filters?.[field] === "string") result[field] = context.filters[field];
  }
  if (["cases", "case_issues"].includes(args.query)) {
    for (const field of ["from", "to", "unit", "outcome", "result", "intent", "pattern", "model", "mode", "level", "movement", "slow", "steps", "rating", "tag", "status", "collection", "noted", "q", "sort"])
      if (result[field] === undefined && typeof context.filters?.[field] === "string") result[field] = context.filters[field];
  }
  if (args.query === "case_detail") {
    if (result.caseId === undefined && context.filters?.case) result.caseId = context.filters.case;
    if (result.unit === undefined) result.unit = context.filters?.unit || (result.line === "video" ? "task" : "chain");
  }
  return result;
}

export function customerTarget(args) {
  const filters = Object.fromEntries(customerFilters.filter(key => typeof args[key] === "string" && args[key] && !(key === "pool" && args[key] === "all")).map(key => [key, args[key]]));
  return filters;
}

export async function getJson(path, params = {}) {
  const url = new URL(path, "http://127.0.0.1:8765");
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "" && value !== "any") {
    if (String(value).length > 2000) throw Error("查询参数过长");
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw Error(`只读查询接口返回 HTTP ${response.status}`); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10000000) throw Error("查询结果过大，请缩小范围");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function queryCustomers(args) {
  const base = { line: args.line, week: args.week };
  const selectedModels = split(args.models);
  const selectedTrends = split(args.trend);
  if (selectedTrends.some(kind => !["churned", "sliding", "fading"].includes(kind))) throw Error("多周趋势筛选无效");
  if (selectedModels.length > 20) throw Error("模型筛选数量过多");
  const [roster, extra, trendRows, ...modelRosters] = await Promise.all([
    getJson("/api/enterprises", base),
    getJson("/api/profiles/roster", base),
    selectedTrends.length ? getJson("/api/trends", base) : Promise.resolve([]),
    ...selectedModels.map(model => getJson("/api/enterprises", { ...base, model }))
  ]);
  if (!Array.isArray(roster.rows) || !Array.isArray(extra) || modelRosters.some(item => !Array.isArray(item.rows))) throw Error("客户名单数据不完整");
  const extras = new Map(extra.map(item => [item.enterpriseId, item]));
  const modelIds = new Set(modelRosters.flatMap(item => item.rows.map(row => row.enterprise.id)));
  const trendIds = new Set(trendRows.filter(item => selectedTrends.includes(item.kind)).map(item => item.enterpriseId));
  const tags = new Map();
  for (const tag of split(args.tags)) {
    const position = tag.indexOf(":");
    if (position < 1 || position === tag.length - 1) throw Error("标签筛选须采用 dimension:value 格式");
    const dimension = tag.slice(0, position);
    if (!tags.has(dimension)) tags.set(dimension, []);
    tags.get(dimension).push(tag.slice(position + 1));
  }
  const levels = split(args.level), pools = split(args.pool).filter(value => value !== "all"), movements = split(args.movement), alerts = split(args.alert), intents = split(args.intent), noted = split(args.noted);
  if (noted.some(value => !["any", "recent"].includes(value))) throw Error("批注筛选无效");
  const search = (args.q || "").trim().toLowerCase();
  const weekAgo = Date.now() - 7 * 86400000;
  const rows = roster.rows.filter(row => {
    if (selectedTrends.length && !trendIds.has(row.enterprise.id)) return false;
    const detail = extras.get(row.enterprise.id);
    const conversion = pools.includes("convert") ? row.conversion : null;
    return (!pools.length || pools.includes(row.pool)) && (!levels.length || levels.includes(row.level)) && (!movements.length || movements.includes(conversion?.movement ?? row.movement)) && (!alerts.length || alerts.some(value => row.alerts?.includes(value))) && (!selectedModels.length || modelIds.has(row.enterprise.id)) && (!intents.length || intents.includes(conversion?.topIntent ?? row.inspiration?.topIntent ?? row.video?.topMode ?? "")) && [...tags].every(([dimension, values]) => detail?.tags?.some(tag => tag.dimension === dimension && values.includes(tag.value))) && (!noted.length || noted.some(value => value === "any" ? detail?.annotationCount > 0 : detail?.lastAnnotation && new Date(detail.lastAnnotation.at).getTime() >= weekAgo)) && (!search || row.enterprise.name.toLowerCase().includes(search) || (detail?.headline ?? "").toLowerCase().includes(search));
  });
  return { line: args.line, week: args.week, total: rows.length, rows };
}
