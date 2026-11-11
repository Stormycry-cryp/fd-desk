import { createHash } from "node:crypto";

export function imageReferences(data, target) {
  const references = {};
  const visit = (value, rowKey = null) => {
    if (Array.isArray(value)) return value.map(item => visit(item, rowKey));
    if (!value || typeof value !== "object") return value;
    const task = typeof value.rowKey === "string" ? value.rowKey : rowKey;
    if (["image", "video"].includes(value.kind) && typeof value.thumb === "string") {
      const url = new URL(value.thumb, "http://127.0.0.1:8765");
      if (url.origin !== "http://127.0.0.1:8765" || url.pathname !== "/api/media/thumb") throw Error("图片需要通过本机缩略图接口读取");
      const id = createHash("sha256").update(value.thumb).digest("hex").slice(0, 20);
      references[id] = { thumb: value.thumb, rowKey: task, target: task ? { ...target, task } : target, kind: value.kind };
      return { ...value, imageId: id };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, task)]));
  };
  return { data: visit(data), references };
}

export async function imageOutput(id, reference) {
  const url = new URL(reference.thumb, "http://127.0.0.1:8765");
  url.searchParams.set("w", "1200");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45000) });
  if (!response.ok) { await response.body?.cancel(); throw Error(`图片读取失败，HTTP ${response.status}`); }
  const mimeType = response.headers.get("content-type")?.split(";")[0];
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) { await response.body?.cancel(); throw Error("图片接口没有返回支持的图片格式"); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4500000) throw Error("图片超过模型支持的大小");
    chunks.push(chunk);
  }
  return [
    { type: "text", text: JSON.stringify({ imageId: id, rowKey: reference.rowKey, target: reference.target, kind: reference.kind, note: reference.kind === "video" ? "视频封面帧" : "任务图片" }) },
    { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType },
  ];
}
