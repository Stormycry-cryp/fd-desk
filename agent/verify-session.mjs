import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { answerBlocks, responseText } from "./answers.js";

const id = process.argv[2];
const verifyImages = process.argv.includes("--images");
assert.match(id || "", /^[0-9a-f-]{36}$/);
const harness = await Harness.open(await openNodeJsonlStorage(resolve("data/ask", id), ctx), { models: createModels(), registry: createRegistry() }, ctx);
try {
  const conversation = await harness.root(ctx);
  const watch = await conversation.watch(ctx, { min: 100, max: 200 });
  const entries = watch.value.entries;
  const assistant = entries.filter(entry => entry.model?.some(message => message.role === "assistant"));
  const latest = assistant.at(-1);
  assert.ok(latest);
  const blocks = answerBlocks(responseText(latest.model));
  const calls = assistant.flatMap(entry => entry.model.flatMap(message => message.content?.filter(part => part.type === "toolCall") || []));
  const images = entries.flatMap(entry => entry.model?.flatMap(message => message.role === "toolResult" ? message.content?.filter(part => part.type === "image") || [] : []) || []);
  if (verifyImages) {
    assert.ok(calls.some(call => call.name === "inspect_images"));
    assert.ok(images.length > 0);
  }
  const result = { session: id, latestEntry: latest.id, blocks, contentParts: latest.model.flatMap(message => message.content || []).map(part => ({ type: part.type, signature: part.textSignature, characters: part.text?.length })), calls: calls.map(call => ({ name: call.name, arguments: call.arguments })), imageCount: images.length, model: latest.model };
  const directory = resolve("data/fixtures/rework/R5");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, verifyImages ? "session-image-verification.json" : "session-analysis-verification.json"), JSON.stringify(result, null, 2));
  await watch.stop();
  console.log(JSON.stringify({ session: id, blockTypes: blocks.map(block => block.type), contentParts: result.contentParts, calls: calls.map(call => call.name), imageCount: images.length }));
} finally {
  await harness.close(ctx);
}
