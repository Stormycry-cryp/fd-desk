import { setTimeout } from "node:timers/promises";
import { ModelCapacity } from "../../agent/capacity.js";

const [directory, schema, mode] = process.argv.slice(2);
const capacity = new ModelCapacity(directory, schema);
const controller = new AbortController();
if (mode === "abort") setTimeout(400).then(() => controller.abort());
try {
  const release = await capacity.acquire("ask", controller.signal);
  process.stdout.write("acquired\n");
  await setTimeout(mode === "hold" ? 30000 : 750);
  release();
  process.stdout.write("released\n");
} catch (error) {
  if (mode !== "abort" || !controller.signal.aborted) throw error;
  process.stdout.write("aborted\n");
} finally { capacity.close(); }
