import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

function processStart(pid) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim(); }
  catch (error) { if (error.status === 1) return ""; throw error; }
}

export class ModelCapacity {
  constructor(directory, schema) {
    mkdirSync(join(directory, "service"), { recursive: true });
    this.database = new DatabaseSync(join(directory, "service/model-capacity.sqlite3"));
    this.database.exec("PRAGMA busy_timeout=10000");
    this.database.exec(readFileSync(schema, "utf8"));
    this.stamp = processStart(process.pid);
    if (!this.stamp) throw Error("当前进程启动时间不可用");
  }

  ready(id) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const owners = this.database.prepare("SELECT DISTINCT pid,process_start FROM model_capacity_requests").all();
      for (const owner of owners) if (processStart(owner.pid) !== owner.process_start) this.database.prepare("DELETE FROM model_capacity_requests WHERE pid=? AND process_start=?").run(owner.pid, owner.process_start);
      const first = this.database.prepare("SELECT id FROM model_capacity_next").get();
      const { used } = this.database.prepare("SELECT COUNT(*) AS used FROM model_capacity_requests WHERE state='running'").get();
      const { maximum } = this.database.prepare("SELECT total_limit-reserved_slots AS maximum FROM model_capacity_limits WHERE id=1").get();
      if (first?.id !== id || used >= maximum) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("UPDATE model_capacity_requests SET state='running' WHERE id=?").run(id);
      this.database.exec("COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async acquire(category, signal) {
    signal?.throwIfAborted();
    const id = randomUUID();
    this.database.prepare("INSERT INTO model_capacity_requests(id,pid,process_start,category,state) VALUES (?,?,?,?,'queued')").run(id, process.pid, this.stamp, category);
    const release = () => this.database.prepare("DELETE FROM model_capacity_requests WHERE id=?").run(id);
    try {
      while (!this.ready(id)) await setTimeout(250, undefined, { signal });
      signal?.throwIfAborted();
      return release;
    } catch (error) { release(); throw error; }
  }

  close() { this.database.close(); }
}

export function limitProviderStreams(provider, capacity) {
  const wrap = method => (model, context, options) => lazyStream(model, async () => {
    const release = await capacity.acquire("ask", options?.signal);
    return (async function* () {
      try { for await (const event of method(model, context, options)) yield event; }
      finally { release(); }
    })();
  }, undefined, options?.signal);
  return { ...provider, stream: wrap(provider.stream), streamSimple: wrap(provider.streamSimple) };
}
