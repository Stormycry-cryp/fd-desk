import type { Api, ApiError } from "@spec/contract"

type Key = keyof Api
type Spec<K extends Key> = Api[K]
type Q<K extends Key> = Spec<K> extends { query: infer T } ? T : never
type B<K extends Key> = Spec<K> extends { body: infer T } ? T : never
export type Res<K extends Key> = Spec<K> extends { response: infer T } ? T : never

export interface CallOpts<K extends Key> {
  params?: Record<string, string>
  query?: Q<K>
  body?: B<K>
}

export class RequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
  get missing() {
    return this.status === 404 && this.code === "not_implemented"
  }
}

export type Mode = "live" | "mock"

let mode: Mode = "live"
export const getMode = () => mode

const build = (key: string, opts: CallOpts<any>) => {
  const [method, raw] = key.split(" ")
  const path = raw.replace(/:([a-zA-Z]+)/g, (_, n) => encodeURIComponent(opts.params?.[n] ?? ""))
  const qs = new URLSearchParams()
  Object.entries((opts.query ?? {}) as Record<string, unknown>).forEach(([k, v]) => {
    if (v == null || v === "") return
    qs.set(k, Array.isArray(v) ? v.join(",") : String(v))
  })
  const s = qs.toString()
  return { method, url: s ? `${path}?${s}` : path }
}

export const url = <K extends Key>(key: K, opts: CallOpts<K> = {}) => build(key, opts).url

export const call = async <K extends Key>(key: K, opts: CallOpts<K> = {}): Promise<Res<K>> => {
  const { method, url } = build(key, opts)
  if (mode === "mock") {
    const { mockFetch, MockError } = await import("../mock/handlers")
    try {
      return (await mockFetch(method, url, opts.body)) as Res<K>
    } catch (e) {
      if (e instanceof MockError) throw new RequestError(e.status, e.code, e.message)
      throw e
    }
  }
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData
  const res = await fetch(url, {
    method,
    headers: opts.body != null && !isForm ? { "content-type": "application/json" } : undefined,
    body: opts.body == null ? undefined : isForm ? (opts.body as unknown as FormData) : JSON.stringify(opts.body),
  })
  const type = res.headers.get("content-type") ?? ""
  if (res.status === 204) return null as Res<K>
  if (!type.includes("json")) {
    if (res.ok && !type.includes("html")) return (await res.blob()) as Res<K>
    throw new RequestError(404, "not_implemented", `${method} ${url}`)
  }
  const data = await res.json()
  if (!res.ok) {
    const err = (data?.detail ?? data) as Partial<ApiError>
    if (res.status === 405 || (res.status === 404 && (!err.code || err.code === "not_implemented" || err.message === "接口不存在"))) throw new RequestError(404, "not_implemented", `${method} ${url}`)
    throw new RequestError(res.status, err.code ?? "error", err.message ?? res.statusText)
  }
  return data as Res<K>
}

export const boot = async () => {
  const forced = new URL(location.href).searchParams.get("mock")
  if (forced != null) localStorage.setItem("fd-desk-mode", forced === "0" ? "live" : "mock")
  const saved = localStorage.getItem("fd-desk-mode") as Mode | null
  if (saved) {
    mode = saved
    return mode
  }
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1200)
    const r = await fetch("/api/meta", { signal: ctl.signal })
    clearTimeout(t)
    mode = r.ok && (r.headers.get("content-type") ?? "").includes("json") ? "live" : "mock"
  } catch {
    mode = "mock"
  }
  return mode
}

export const setMode = (m: Mode) => {
  localStorage.setItem("fd-desk-mode", m)
  location.reload()
}
