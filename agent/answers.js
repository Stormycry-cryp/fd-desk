import { parse } from "partial-json";

const pages = new Set(["week", "customers", "enterprise", "templates", "playground", "followups", "analysis", "data", "export", "report"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nullableString = value => value === null || typeof value === "string";
const finite = value => typeof value === "number" && Number.isFinite(value);

function locator(value) {
  if (value === null) return true;
  return object(value) && pages.has(value.page)
    && (value.line === undefined || ["inspiration", "video"].includes(value.line))
    && ["week", "enterprise", "tab", "section", "task", "draft", "run"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.filters === undefined || (object(value.filters) && Object.values(value.filters).every(item => typeof item === "string")));
}

export function validBlock(block) {
  if (!object(block)) return false;
  if (block.type === "text") return typeof block.text === "string";
  if (block.type === "stat") return typeof block.label === "string" && typeof block.value === "string" && nullableString(block.delta) && locator(block.target);
  if (block.type === "chart") return ["line", "bar"].includes(block.kind) && typeof block.title === "string" && locator(block.target)
    && Array.isArray(block.points) && block.points.every(point => object(point) && typeof point.label === "string" && (point.value === null || finite(point.value)));
  if (block.type === "list") return nullableString(block.title) && Array.isArray(block.items)
    && block.items.every(item => object(item) && typeof item.label === "string" && nullableString(item.value) && locator(item.target));
  if (block.type === "clarify") return typeof block.question === "string" && Array.isArray(block.options) && block.options.every(option => typeof option === "string");
  return false;
}

function content(raw) {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export function responseText(messages) {
  const parts = messages.flatMap(message => message.content || []).filter(part => part.type === "text");
  const final = parts.filter(part => typeof part.textSignature === "string" && part.textSignature.startsWith("{") && JSON.parse(part.textSignature).phase === "final_answer");
  if (final.length) return final.map(part => part.text).join("");
  const structured = parts.filter(part => content(part.text).startsWith("{"));
  if (structured.length) return structured.at(-1).text;
  return parts.filter(part => !(typeof part.textSignature === "string" && part.textSignature.startsWith("{") && JSON.parse(part.textSignature).phase === "commentary")).map(part => part.text).join("\n\n");
}

export function answerBlocks(raw) {
  const text = content(raw);
  if (!text) throw Error("模型没有返回回答内容");
  if (!text.startsWith("{")) return [{ type: "text", text }];
  const { blocks } = JSON.parse(text);
  if (!Array.isArray(blocks) || !blocks.length || !blocks.every(validBlock)) throw Error("回答的展示格式无效");
  return blocks;
}

export function partialBlocks(raw) {
  const text = content(raw);
  if (!text) return [];
  if (!text.startsWith("{")) return [{ type: "text", text }];
  const { blocks } = parse(text);
  return Array.isArray(blocks) ? blocks : [];
}

export function blockText(blocks) {
  return blocks.map(block => {
    if (block.type === "text") return block.text;
    if (block.type === "stat") return `${block.label}：${block.value}${block.delta ? `（${block.delta}）` : ""}`;
    if (block.type === "chart") return `${block.title}：${block.points.map(point => `${point.label} ${point.value ?? "暂无数据"}`).join("，")}`;
    if (block.type === "list") return [block.title, ...block.items.map(item => `${item.label}${item.value ? `：${item.value}` : ""}`)].filter(Boolean).join("\n");
    return block.question;
  }).join("\n\n");
}

export function answerStream(emit) {
  const displayed = new Map();
  return raw => {
    const blocks = partialBlocks(raw);
    blocks.forEach((block, index) => {
      if (block?.type === "text" && typeof block.text === "string") {
        const previous = displayed.get(index);
        if (previous?.type === "text" && block.text.startsWith(previous.text)) {
          if (block.text.length > previous.text.length) emit({ type: "delta", index, text: block.text.slice(previous.text.length) });
        } else if (!previous) emit({ type: "delta", index, text: block.text });
        else emit({ type: "block", index, block: { type: "text", text: block.text } });
        displayed.set(index, { type: "text", text: block.text });
      } else if (validBlock(block)) {
        const previous = displayed.get(index);
        if (JSON.stringify(previous) !== JSON.stringify(block)) emit({ type: "block", index, block });
        displayed.set(index, block);
      }
    });
    return blocks;
  };
}
