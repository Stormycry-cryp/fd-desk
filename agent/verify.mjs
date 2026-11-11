import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createParser } from "eventsource-parser";
import { answerBlocks, answerStream, blockText, responseText, validBlock } from "./answers.js";
import { calculate, presentRows } from "./analysis.js";
import { imageReferences, imageOutput } from "./media.js";
import { getJson, queryCustomers } from "./queries.js";

const output = resolve("data/fixtures/rework/R5/analysis-agent-verification.json");
const week = "2026-11-02";
const line = "inspiration";
const context = { page: "week", line, week, excluded: false, enterprise: null, tab: null, filters: {}, selection: null };

async function post(path, payload) {
  const response = await fetch(`http://127.0.0.1:8765${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(480000) });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}

async function ask(id, text, selected = context) {
  const started = performance.now();
  const response = await post(`/api/ask/sessions/${id}/messages`, { text, context: selected });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const parser = createParser({ onEvent(event) { events.push({ ...JSON.parse(event.data), elapsedMs: performance.now() - started }); } });
  const decoder = new TextDecoder();
  for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }));
  parser.feed(decoder.decode());
  const errors = events.filter(event => event.type === "error");
  assert.deepEqual(errors, [], JSON.stringify(errors));
  const done = events.at(-1);
  assert.equal(done?.type, "done", JSON.stringify(events));
  assert.equal(done.message.state, "done");
  assert.ok(done.message.blocks.every(validBlock));
  const blocks = new Map();
  for (const event of events) if (event.type === "block") blocks.set(event.index, event.block);
  assert.deepEqual([...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block), done.message.blocks);
  return { question: text, source: "live-sse", message: done.message, firstDeltaMs: events.find(event => event.type === "delta")?.elapsedMs ?? null, doneMs: done.elapsedMs, deltaCount: events.filter(event => event.type === "delta").length, statuses: events.filter(event => event.type === "status").map(event => event.text) };
}

const results = process.argv.includes("--continue")
  ? JSON.parse(await readFile(output, "utf8"))
  : { at: new Date().toISOString(), checks: [] };
delete results.error;
delete results.ok;
function record(check) {
  results.checks = results.checks.filter(item => item.kind !== check.kind);
  results.checks.push(check);
  console.log(JSON.stringify({ kind: check.kind, ok: check.ok, firstDeltaMs: check.firstDeltaMs, doneMs: check.doneMs }));
}
async function scenario(kind, text, selected) {
  const saved = results.checks.find(check => check.kind === kind && check.ok);
  if (saved) return saved;
  if (process.argv.includes("--reuse-latest")) {
    const session = await getJson(`/api/ask/sessions/${results.session}`);
    const [user, assistant] = session.messages.slice(-2);
    if (user?.role === "user" && user.text === text && assistant?.role === "assistant" && assistant.state === "done")
      return { question: text, source: "persisted-http-answer", message: assistant, firstDeltaMs: null, doneMs: null, deltaCount: null, statuses: [] };
  }
  return ask(results.session, text, selected);
}
async function save() {
  await mkdir(resolve("data/fixtures/rework/R5"), { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2));
}

try {
  const overview = await getJson("/api/overview", { line, week });
  const prior = await getJson("/api/overview", { line, week: "2026-10-26" });
  const current = overview.stable.value, previous = prior.stable.value;
  assert.equal(current, 46);
  assert.equal(previous, 52);
  const change = calculate({ label: "稳定使用变化", operation: "subtract", values: [current, previous] });
  const relative = calculate({ label: "稳定使用变化率", operation: "percent_change", values: [current, previous], decimals: 1 });
  const download = calculate({ label: "下载率", operation: "percentage", values: [overview.downloadRate.value, 1], decimals: 1 });
  assert.equal(change.result, -6);
  assert.equal(relative.rounded, -11.5);
  assert.equal(download.rounded, 55.1);
  const roster = await queryCustomers({ line, week });
  const grouped = presentRows(roster, { summary: { path: "rows", groupBy: ["level"], metrics: [{ label: "企业数", operation: "count" }, { label: "任务数", operation: "sum", field: "tasks" }] } });
  assert.equal(grouped.sourceRows, roster.rows.length);
  assert.equal(grouped.groups.reduce((total, group) => total + group.metrics[0].value, 0), roster.rows.length);
  assert.equal(grouped.groups.reduce((total, group) => total + group.metrics[1].value, 0), roster.rows.reduce((total, row) => total + row.tasks, 0));
  const ordered = presentRows(roster, { fields: ["enterprise.id", "tasks"], orderBy: "tasks", limit: 5 });
  assert.equal(ordered.rows[0].tasks, Math.max(...roster.rows.map(row => row.tasks)));
  record({ kind: "real-data-calculations", change, relative, download, grouped, ordered, ok: true });

  const old = JSON.parse(await readFile("data/fixtures/rework/R5/http-verification.json", "utf8"));
  for (const check of old.checks) if (check.blocks?.length) {
    const blocks = answerBlocks(JSON.stringify({ blocks: check.blocks }));
    const events = [];
    const stream = answerStream(event => events.push(event));
    const raw = JSON.stringify({ blocks });
    for (let end = 1; end <= raw.length; end++) stream(raw.slice(0, end));
    const text = new Map();
    for (const event of events) {
      if (event.type === "delta") text.set(event.index, (text.get(event.index) || "") + event.text);
      else if (event.block.type === "text") text.set(event.index, event.block.text);
    }
    blocks.forEach((block, index) => { if (block.type === "text") assert.equal(text.get(index), block.text); });
  }
  record({ kind: "saved-real-answer-streams", cases: old.checks.length, ok: true });
  const savedPhase = process.argv.includes("--phase") ? JSON.parse(await readFile("data/fixtures/rework/R5/session-analysis-verification.json", "utf8")) : null;
  if (savedPhase) {
    const blocks = answerBlocks(responseText(savedPhase.model));
    assert.deepEqual(blocks, savedPhase.blocks);
    assert.ok(blocks.some(block => block.type === "chart"));
    const events = [];
    const stream = answerStream(event => events.push(event));
    const final = responseText(savedPhase.model);
    for (let end = 1; end <= final.length; end++) stream(final.slice(0, end));
    assert.ok(events.some(event => event.type === "delta"));
    record({ kind: "provider-answer-phases", contentParts: savedPhase.contentParts, ok: true });
  }
  await save();
  if (process.argv.includes("--data-only")) process.exit(0);

  const session = results.session ? await getJson(`/api/ask/sessions/${results.session}`) : await (await post("/api/ask/sessions")).json();
  results.session = session.id;
  await save();
  const comparison = await scenario("derived-comparison-and-streaming", "11/02 这周灵感成款稳定使用企业有多少家？比上周变化多少？请同时说明企业数量变化和百分比变化。");
  const comparisonText = blockText(comparison.message.blocks);
  for (const number of ["46", "52", "6", "11.5"]) assert.ok(comparisonText.includes(number), comparisonText);
  assert.ok(comparison.firstDeltaMs !== null && comparison.firstDeltaMs < comparison.doneMs, JSON.stringify(comparison));
  record({ ...comparison, kind: "derived-comparison-and-streaming", ok: true });
  await save();

  const followup = await scenario("conversation-and-reasoning", "继续解释这个变化，现在只有这两个总数，可以判断什么？还需要检查哪些原因？用自然段回答，暂时不用卡片和图表。");
  assert.ok(followup.message.blocks.every(block => block.type === "text"));
  assert.ok(blockText(followup.message.blocks).length > 100);
  record({ ...followup, kind: "conversation-and-reasoning", ok: true });
  await save();

  const percent = await scenario("formatted-percentage", "同一周灵感成款下载率是多少？请转换成百分数，保留一位小数。");
  assert.match(blockText(percent.message.blocks), /55\.1\s*%/);
  record({ ...percent, kind: "formatted-percentage", ok: true });
  await save();

  const analytical = await scenario("multi-week-analysis", "查阅从09/28到11/02六个完整周的灵感成款总览，逐周比较稳定使用企业数，并结合趋势资料分析近期最需要关注的变化和可核实的原因。请给出折线图和解释。");
  const chart = analytical.message.blocks.find(block => block.type === "chart" && block.points.length >= 6);
  assert.ok(chart);
  const weeks = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"];
  const overviews = await Promise.all(weeks.map(week => getJson("/api/overview", { line, week })));
  assert.deepEqual(chart.points.map(point => point.value), overviews.map(overview => overview.stable.value));
  record({ ...analytical, kind: "multi-week-analysis", ok: true });
  await save();

  const groupedAnswer = await scenario("grouping-and-customer-ranking", "当前周客户名单按使用等级分别有多少家、合计任务数是多少？请使用分组汇总能力，并列出任务数最多的五家企业。", { ...context, page: "customers" });
  const groupedText = blockText(groupedAnswer.message.blocks).replaceAll(",", "");
  for (const group of grouped.groups) for (const metric of group.metrics)
    assert.ok(groupedText.includes(String(metric.value)), `分组结果缺少 ${metric.label} ${metric.value}`);
  const top = [...roster.rows].sort((left, right) => right.tasks - left.tasks).slice(0, 5);
  for (const row of top) {
    assert.ok(groupedText.includes(row.enterprise.name), "排行缺少真实企业");
    assert.ok(groupedText.includes(String(row.tasks)), "排行缺少真实任务数");
  }
  record({ ...groupedAnswer, kind: "grouping-and-customer-ranking", grouped, top, ok: true });
  await save();

  const records = await getJson("/api/records", { enterprise: "1cd6112680", scope: line, from: week, to: "2026-11-08", limit: 4 });
  const task = records.items.find(row => row.task.outputs.some(media => media.kind === "image"))?.task;
  assert.ok(task);
  const refs = imageReferences(task, { page: "enterprise", enterprise: task.enterprise.id, line, week, tab: "tasks" });
  const imageId = refs.data.outputs.find(media => media.kind === "image").imageId;
  const image = await imageOutput(imageId, refs.references[imageId]);
  assert.equal(image[1].type, "image");
  assert.ok(image[1].data.length > 100);
  const visual = await scenario("image-analysis", "查询这家企业11/02这一周最近的生成记录，使用 inspect_images 查看其中一条记录的输入图和输出图，分析画面用途、结果质量与可以改进的提示词。只根据实际看到的图片描述。", { ...context, page: "enterprise", enterprise: task.enterprise.id, tab: "tasks" });
  assert.ok(visual.statuses.some(status => status.includes("图片")), JSON.stringify(visual.statuses));
  record({ ...visual, kind: "image-analysis", ok: true });
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = String(error.stack || error);
  throw error;
} finally {
  await save();
  console.log(JSON.stringify({ ok: results.ok, checks: results.checks.map(check => ({ kind: check.kind, ok: check.ok })), session: results.session, output }));
}
