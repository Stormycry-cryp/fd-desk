export const calculationSchema = {
  type: "object",
  properties: {
    calculations: {
      type: "array", minItems: 1,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          operation: { type: "string", enum: ["sum", "mean", "median", "min", "max", "subtract", "multiply", "divide", "percentage", "percent_change", "percentage_points"] },
          values: { type: "array", minItems: 1, items: { type: "number" } },
          decimals: { type: "integer", minimum: 0, maximum: 12 },
        },
        required: ["label", "operation", "values"], additionalProperties: false,
      },
    },
  },
  required: ["calculations"], additionalProperties: false,
};

export function calculate({ operation, values, decimals = 4, label }) {
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw Error("计算需要有限数值");
  const [first, second] = values;
  const binary = ["subtract", "divide", "percentage", "percent_change", "percentage_points"];
  if (binary.includes(operation) && values.length !== 2) throw Error("该运算需要两个数值");
  if (["divide", "percentage", "percent_change"].includes(operation) && second === 0) throw Error("分母为零，无法计算该比值");
  let result;
  if (operation === "sum") result = values.reduce((total, value) => total + value, 0);
  else if (operation === "mean") result = values.reduce((total, value) => total + value, 0) / values.length;
  else if (operation === "median") {
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    result = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  } else if (operation === "min") result = values.reduce((value, item) => Math.min(value, item));
  else if (operation === "max") result = values.reduce((value, item) => Math.max(value, item));
  else if (operation === "subtract") result = first - second;
  else if (operation === "multiply") result = values.reduce((total, value) => total * value, 1);
  else if (operation === "divide") result = first / second;
  else if (operation === "percentage") result = first / second * 100;
  else if (operation === "percent_change") result = (first - second) / second * 100;
  else if (operation === "percentage_points") result = (first - second) * 100;
  else throw Error("计算类型无效");
  if (!Number.isFinite(result)) throw Error("计算结果超出有限数值范围");
  return { label, operation, values, result, rounded: Number(result.toFixed(decimals)), unit: ["percentage", "percent_change"].includes(operation) ? "%" : operation === "percentage_points" ? "个百分点" : null };
}

export const summarySchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "需要汇总的数组字段，如 rows、items、facts.all.weekly；结果本身为数组时留空" },
    groupBy: { type: "array", items: { type: "string" }, description: "分组字段，可使用 enterprise.id 等字段路径；空数组表示整体汇总" },
    metrics: {
      type: "array", minItems: 1,
      items: {
        type: "object", properties: { label: { type: "string" }, operation: { type: "string", enum: ["count", "distinct", "sum", "mean", "median", "min", "max"] }, field: { type: "string" } },
        required: ["label", "operation"], additionalProperties: false,
      },
    },
  },
  required: ["groupBy", "metrics"], additionalProperties: false,
};

export function fieldValue(value, path = "") {
  for (const key of path ? path.split(".") : []) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function summarize(data, options) {
  const rows = fieldValue(data, options.path);
  if (!Array.isArray(rows)) throw Error("汇总路径没有指向数组");
  const groups = new Map();
  for (const row of rows) {
    const group = Object.fromEntries(options.groupBy.map(field => [field, fieldValue(row, field) ?? null]));
    const key = JSON.stringify(group);
    if (!groups.has(key)) groups.set(key, { group, rows: [] });
    groups.get(key).rows.push(row);
  }
  if (!options.groupBy.length && !rows.length) groups.set("{}", { group: {}, rows: [] });
  return { sourceRows: rows.length, groups: [...groups.values()].map(({ group, rows: items }) => ({ group, metrics: options.metrics.map(metric => {
    if (metric.operation === "count") return { label: metric.label, value: items.length, missing: 0 };
    if (!metric.field) throw Error("该汇总需要指定字段");
    const values = items.map(item => fieldValue(item, metric.field));
    const present = values.filter(value => value !== undefined && value !== null);
    if (metric.operation === "distinct") return { label: metric.label, value: new Set(present.map(value => JSON.stringify(value))).size, missing: items.length - present.length };
    const numeric = present.filter(Number.isFinite);
    if (numeric.length !== present.length) throw Error(`字段 ${metric.field} 包含非数值内容`);
    return { label: metric.label, value: numeric.length ? calculate({ operation: metric.operation, values: numeric }).result : null, missing: items.length - numeric.length };
  }) })) };
}

export function presentRows(data, { fields, orderBy, descending = true, offset = 0, limit, summary }) {
  if (summary) return summarize(data, summary);
  if (!fields?.length && !orderBy && !offset && limit === undefined) return data;
  const container = Array.isArray(data) ? null : Array.isArray(data?.rows) ? "rows" : Array.isArray(data?.items) ? "items" : null;
  const rows = container ? data[container] : data;
  if (!Array.isArray(rows)) {
    if (fields?.length) return Object.fromEntries(fields.map(field => [field, fieldValue(data, field) ?? null]));
    throw Error("当前结果没有可以分页或排序的数组");
  }
  const sorted = [...rows];
  if (orderBy) sorted.sort((left, right) => {
    const a = fieldValue(left, orderBy), b = fieldValue(right, orderBy);
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    return (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))) * (descending ? -1 : 1);
  });
  const selected = sorted.slice(offset, limit === undefined ? undefined : offset + limit).map(row => fields?.length ? Object.fromEntries(fields.map(field => [field, fieldValue(row, field) ?? null])) : row);
  return container ? { ...data, [container]: selected, returned: selected.length, offset, sourceRows: rows.length } : { rows: selected, total: rows.length, returned: selected.length, offset };
}
