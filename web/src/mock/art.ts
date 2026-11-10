import { hash } from "./rand"

const garments = {
  tee: "M92 84 L132 66 Q150 88 168 66 L208 84 L250 132 L222 156 L204 134 L204 334 L96 334 L96 134 L78 156 L50 132 Z",
  dress: "M122 66 Q150 92 178 66 L188 146 L244 336 L56 336 L112 146 Z",
  coat: "M98 70 L136 60 L150 118 L164 60 L202 70 L242 142 L238 342 L62 342 L58 142 Z",
  pants: "M96 72 L204 72 L216 340 L166 340 L150 168 L134 340 L84 340 Z",
  skirt: "M112 116 L188 116 L242 334 L58 334 Z",
  shirt: "M96 82 L134 64 L150 96 L166 64 L204 82 L246 150 L222 166 L204 146 L204 334 L96 334 L96 146 L78 166 L54 150 Z",
}

export type Garment = keyof typeof garments

export const garmentKeys = Object.keys(garments) as Garment[]

export const palette = ["#2F3A4F", "#B9533F", "#D8C3A5", "#6E7F5F", "#C9A227", "#7A5C8E", "#E6E1D6", "#3E6E8E", "#A33B5C", "#9C8B78", "#1F1F1F", "#D98E73"]

const backgrounds = [
  ["#F4F1EC", "#E9E4DC"],
  ["#EEF0F2", "#DDE2E7"],
  ["#F3EEF7", "#E3DAEC"],
  ["#EFF3EE", "#DCE5DA"],
  ["#F7EFEA", "#EADBD1"],
]

export interface ArtSpec {
  garment: Garment
  color: string
  bg?: number
  print?: boolean
  person?: boolean
  video?: boolean
  flat?: boolean
}

const shade = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, k > 0 ? v + (255 - v) * k : v * (1 + k))))
  const r = ch(n >> 16)
  const g = ch((n >> 8) & 255)
  const b = ch(n & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

const cache = new Map<string, string>()

export const art = (s: ArtSpec) => {
  const key = JSON.stringify(s)
  const hit = cache.get(key)
  if (hit) return hit
  const id = hash(key).toString(36)
  const [b0, b1] = s.flat ? ["#FFFFFF", "#F5F5F4"] : backgrounds[(s.bg ?? 0) % backgrounds.length]
  const path = garments[s.garment]
  const fill = s.print ? `url(#p${id})` : `url(#g${id})`
  const person = s.person
    ? `<circle cx="150" cy="40" r="22" fill="${shade("#C8A893", -0.05)}"/><rect x="138" y="58" width="24" height="16" fill="${shade("#C8A893", -0.1)}"/>`
    : ""
  const play = s.video
    ? `<circle cx="150" cy="200" r="30" fill="rgba(20,20,24,.42)"/><path d="M141 184 L166 200 L141 216 Z" fill="#fff"/>`
    : ""
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><defs><linearGradient id="b${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${b0}"/><stop offset="1" stop-color="${b1}"/></linearGradient><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(s.color, 0.12)}"/><stop offset="1" stop-color="${shade(s.color, -0.18)}"/></linearGradient><pattern id="p${id}" width="22" height="22" patternUnits="userSpaceOnUse"><rect width="22" height="22" fill="${shade(s.color, 0.55)}"/><circle cx="6" cy="6" r="4" fill="${s.color}"/><circle cx="17" cy="17" r="3" fill="${shade(s.color, -0.25)}"/></pattern></defs><rect width="300" height="400" fill="url(#b${id})"/><ellipse cx="150" cy="356" rx="96" ry="10" fill="rgba(0,0,0,.06)"/>${person}<path d="${path}" fill="${fill}" stroke="${shade(s.color, -0.3)}" stroke-opacity=".25" stroke-width="1.5"/>${play}</svg>`
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  cache.set(key, uri)
  return uri
}
