export const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export const rng = (seed: number | string) => {
  let a = typeof seed === "string" ? hash(seed) : seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rand = ReturnType<typeof rng>

export const pick = <T,>(r: Rand, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]

export const between = (r: Rand, lo: number, hi: number) => lo + (hi - lo) * r()

export const int = (r: Rand, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1))

export const normal = (r: Rand) => {
  let s = 0
  for (let i = 0; i < 12; i++) s += r()
  return s - 6
}

export const shuffle = <T,>(r: Rand, xs: T[]) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const weighted = <T,>(r: Rand, xs: readonly (readonly [T, number])[]) => {
  const total = xs.reduce((s, [, w]) => s + w, 0)
  let x = r() * total
  for (const [v, w] of xs) {
    x -= w
    if (x <= 0) return v
  }
  return xs[xs.length - 1][0]
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
