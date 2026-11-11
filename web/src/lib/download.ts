import type { ExportItem, ExportKind } from "@spec/contract"
import { call } from "../api/client"
import { watchJob } from "../api/next"
import { toast } from "../ui/overlays"

const save = (blob: Blob, name: string) => {
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

export const download = async (href: string, name: string) => {
  try {
    const r = await fetch(href)
    const type = r.headers.get("content-type") ?? ""
    if (!r.ok || type.includes("json") || type.includes("html")) {
      const body = type.includes("json") ? await r.json().catch(() => null) : null
      const msg = r.status === 405 || (r.status === 404 && body?.message === "接口不存在") ? "后端尚未提供" : body?.message ?? "导出失败"
      throw new Error(msg)
    }
    const disp = r.headers.get("content-disposition") ?? ""
    const m = /filename\*=UTF-8''([^;]+)/i.exec(disp)
    save(await r.blob(), m ? decodeURIComponent(m[1]) : name)
    return true
  } catch (e) {
    toast((e as Error).message, { tone: "error" })
    return false
  }
}

export const exportKindName: Record<ExportKind, string> = {
  roster: "客户名单",
  annotations: "批注",
  movements: "涨跌原因",
  templates_official: "官方模板配置表",
  templates_custom: "定制模板配置表",
  opportunities: "模板机会",
  monitor: "模板监控",
  followups: "跟进清单",
  analysis_matrix: "任务类型 × 模型",
  analysis_failures: "失败明细",
  tasks: "任务明细",
  records: "生成记录",
  cases: "记录",
}

const qs = (p: Record<string, string | undefined | null>) => {
  const s = new URLSearchParams()
  Object.entries(p).forEach(([k, v]) => v != null && v !== "" && s.set(k, v))
  return s.toString()
}

export const exportOne = (kind: ExportKind, params: Record<string, string | undefined | null>, name?: string) => download(`/api/export/${kind}?${qs(params)}`, `${name ?? exportKindName[kind]}.xlsx`)

export const exportBundle = async (items: ExportItem[], onProgress?: (done: number, total: number) => void) => {
  try {
    const job = await call("POST /api/export/bundle", { body: { items } })
    toast(`正在打包 ${items.length} 项`)
    return await new Promise<boolean>((resolve) =>
      watchJob(job, async (j) => {
        onProgress?.(j.progress.done, j.progress.total)
        if (j.state !== "done") {
          toast(`打包失败：${j.error?.message ?? ""}`, { tone: "error" })
          return resolve(false)
        }
        resolve(await download(j.result?.url ?? `/api/export/download/${j.id}`, "导出.zip"))
      }),
    )
  } catch (e) {
    toast((e as Error).message === "后端尚未提供" ? "后端尚未提供" : (e as Error).message, { tone: "error" })
    return false
  }
}
