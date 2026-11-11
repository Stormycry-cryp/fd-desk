import type { Api, ApiError } from "@spec/contract"
type AllApi = Api
type Key = keyof AllApi
type Spec<K extends Key> = AllApi[K]
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
    return this.code === "not_implemented"
  }
}

export const isMissing = (e: unknown) => e instanceof RequestError && e.missing

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
    throw new RequestError(res.status, "invalid_response", "本机后端返回了无效响应")
  }
  const data = await res.json()
  if (!res.ok) {
    const err = (data?.detail ?? data) as Partial<ApiError>
    const absent = res.status === 405 || (res.status === 404 && (err.code === "not_found" || err.code === "not_implemented") && err.message === "接口不存在")
    if (absent) throw new RequestError(404, "not_implemented", "后端尚未提供")
    throw new RequestError(res.status, err.code ?? "error", err.message ?? res.statusText)
  }
  return data as Res<K>
}
