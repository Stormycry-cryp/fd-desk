import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStoredState } from "./sessions.js";

const source = JSON.parse(await readFile(resolve("data/fixtures/rework/R5/analysis-agent-verification.json"), "utf8"));
const directory = resolve("data/ask", source.session);
const state = await readStoredState(directory);
assert.ok(state.session.messages.length && !state.pending);
async function fingerprint() {
  const result = {};
  for (const name of await readdir(directory)) if (name.endsWith(".jsonl"))
    result[name] = createHash("sha256").update(await readFile(resolve(directory, name))).digest("hex");
  return result;
}
const before = await fingerprint();
const times = [];
for (const path of ["/api/ask/sessions", `/api/ask/sessions/${source.session}`, "/api/ask/sessions"]) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:8765${path}`);
  assert.equal(response.status, 200);
  const value = await response.json();
  if (Array.isArray(value)) assert.ok(value.some(item => item.id === source.session));
  else assert.deepEqual(value, state.session);
  times.push({ path, elapsedMs: performance.now() - start });
}
assert.deepEqual(await fingerprint(), before);
const result = { session: source.session, fileCount: Object.keys(before).length, unchanged: true, times, ok: true };
await writeFile(resolve("data/fixtures/rework/R5/session-readonly-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
