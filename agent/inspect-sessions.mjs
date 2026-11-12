import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readStoredState } from "./sessions.js";

const root = resolve("data/ask");
const sessions = [];
for (const id of await readdir(root)) {
  if (!/^[0-9a-f-]{36}$/.test(id)) continue;
  const state = await readStoredState(resolve(root, id));
  if (!state?.session) continue;
  sessions.push({ id, updatedAt: state.session.updatedAt, pending: state.pending, latest: state.session.messages.slice(-2).map(message => ({ role: message.role, state: message.state, at: message.createdAt })) });
}
await writeFile(resolve("data/fixtures/rework/R5/session-concurrency.json"), JSON.stringify({ at: new Date().toISOString(), sessions }, null, 2));
console.log(JSON.stringify({ total: sessions.length, pending: sessions.filter(session => session.pending), recent: sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 6) }));
