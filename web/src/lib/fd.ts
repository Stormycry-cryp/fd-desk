import type { Task } from "@spec/contract"

let base = "https://data.zhiyitech.cn/plus-fd"
export const setSiteBase = (b: string | null | undefined) => {
  if (b) base = b.replace(/\/+$/, "")
}

export const fdUrl = (t: Pick<Task, "line" | "sourceId"> & { fdUrl?: string | null }) => {
  if (t.fdUrl !== undefined) return t.fdUrl
  return t.line === "inspiration" && /^C_[0-9a-zA-Z]+$/.test(t.sourceId) ? `${base}/workbench/chatting-image/design/${t.sourceId}` : null
}

export const openFd = (t: Pick<Task, "line" | "sourceId"> & { fdUrl?: string | null }) => {
  const u = fdUrl(t)
  if (u) window.open(u, "_blank", "noopener")
}
