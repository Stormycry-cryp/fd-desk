import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createParser } from "eventsource-parser";
import { blockText, validBlock } from "./answers.js";

const base = new URL(process.argv[2]);
const output = resolve("data/fixtures/rework/lan-verification.json");
const receipt = existsSync(output) ? JSON.parse(await readFile(output, "utf8")) : { at: new Date().toISOString(), url: base.origin, checks: [] };
assert.equal(receipt.url, base.origin);
const created = await fetch(new URL("/api/ask/sessions", base), { method: "POST" });
assert.equal(created.status, 200);
const session = await created.json();
const started = performance.now();
const response = await fetch(new URL(`/api/ask/sessions/${session.id}/messages`, base), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    text: "11/02 这周灵感成款稳定使用企业多少家，比上周变化多少？说明数量差值和百分比变化，再给一句需要进一步核实的原因。",
    context: { page: "week", line: "inspiration", week: "2026-11-02", excluded: false, enterprise: null, tab: null, filters: {}, selection: null },
  }),
  signal: AbortSignal.timeout(480000),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /text\/event-stream/);
const events = [];
const parser = createParser({ onEvent(event) { events.push({ ...JSON.parse(event.data), elapsedMs: performance.now() - started }); } });
const decoder = new TextDecoder();
for await (const chunk of response.body) parser.feed(decoder.decode(chunk, { stream: true }));
parser.feed(decoder.decode());
const errors = events.filter(event => event.type === "error");
if (errors.length) {
  const check = { kind: "ask-stream", session: session.id, errors, ok: false };
  receipt.checks = receipt.checks.filter(item => item.kind !== check.kind);
  receipt.checks.push(check);
  receipt.ok = false;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2));
}
assert.deepEqual(errors, []);
const final = events.at(-1);
assert.equal(final?.type, "done");
assert.equal(final.message.state, "done");
assert.ok(final.message.blocks.every(validBlock));
const text = blockText(final.message.blocks);
for (const value of ["46", "52", "6", "11.5"]) assert.ok(text.includes(value), text);
const first = events.find(event => event.type === "delta");
assert.ok(first && first.elapsedMs < final.elapsedMs);
const saved = await fetch(new URL(`/api/ask/sessions/${session.id}`, base));
assert.equal(saved.status, 200);
assert.deepEqual((await saved.json()).messages.at(-1), final.message);
const check = { kind: "ask-stream", session: session.id, firstDeltaMs: first.elapsedMs, doneMs: final.elapsedMs, deltaCount: events.filter(event => event.type === "delta").length, blocks: final.message.blocks, ok: true };
receipt.checks = receipt.checks.filter(item => item.kind !== check.kind);
receipt.checks.push(check);
receipt.ok = receipt.checks.every(item => item.ok !== false);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ ...check, blocks: check.blocks.map(block => block.type) }));
