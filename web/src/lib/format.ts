const nf = new Intl.NumberFormat("zh-CN")

export const num = (v: number | null | undefined) => (v == null ? "—" : nf.format(Math.round(v)))

export const pct = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`)

export const compact = (v: number | null | undefined) => {
  if (v == null) return "—"
  const a = Math.abs(v)
  if (a >= 10000) return `${(v / 10000).toFixed(a >= 100000 ? 0 : 1)}万`
  return nf.format(Math.round(v))
}

export const ratio = (current: number, previous: number) => (previous > 0 ? current / previous - 1 : current > 0 ? Infinity : 0)

export const signedPct = (r: number) => {
  if (!Number.isFinite(r)) return "新"
  const s = Math.round(r * 100)
  return `${s > 0 ? "+" : s < 0 ? "−" : "±"}${Math.abs(s)}%`
}

export const signedNum = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${nf.format(Math.abs(Math.round(v)))}`

export const maskPhone = (p: string) => (p.length >= 11 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p)

const dayMs = 86400000

export const parseDay = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00+08:00`)

export const weekLabel = (w: string) => {
  const s = parseDay(w)
  const e = new Date(s.getTime() + 6 * dayMs)
  const f = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  return `${f(s)}–${f(e)}`
}

export const weekShort = (w: string) => {
  const s = parseDay(w)
  return `${s.getMonth() + 1}/${s.getDate()}`
}

export const weekdayNames = ["一", "二", "三", "四", "五", "六", "日"]

export const weekdaysLabel = (days: number[]) => {
  if (!days.length) return "无"
  if (days.length === 7) return "整周"
  const sorted = [...days].sort((a, b) => a - b)
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  return contiguous && sorted.length > 2 ? `周${weekdayNames[sorted[0]]}至周${weekdayNames[sorted[sorted.length - 1]]}` : sorted.map((d) => `周${weekdayNames[d]}`).join("、")
}

export const time = (t: string) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const ago = (t: string | null, now = Date.now()) => {
  if (!t) return "—"
  const diff = now - new Date(t).getTime()
  const days = Math.floor(diff / dayMs)
  if (days <= 0) return "今天"
  if (days === 1) return "昨天"
  if (days < 7) return `${days} 天前`
  if (days < 60) return `${Math.floor(days / 7)} 周前`
  return `${Math.floor(days / 30)} 月前`
}
