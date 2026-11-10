import type { ContractState, EnterpriseKind, EnterpriseRef, FailureCategory, Line } from "@spec/contract"
import { garmentKeys, type Garment } from "./art"
import { between, clamp, hash, int, normal, pick, rng, weighted, type Rand } from "./rand"

export const WEEKS = ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]
export const LATEST = 11
export const COVER: number[][] = WEEKS.map((_, i) => (i === 10 ? [3, 4, 5, 6] : i === 12 ? [0] : [0, 1, 2, 3, 4, 5, 6]))
export const NOW = "2026-11-10T09:30:00+08:00"

export const INTENTS = ["换色", "印花面料", "换装上身", "换模特换脸", "换背景", "姿势角度", "平铺白底", "改款设计", "详情排版", "修图去除"] as const
export const IMAGE_MODELS = ["fd-2.0-max", "nano_banana_pro", "gpt-image-2.5-flare", "gemini-nano-banana-2.1", "seedream-4.5"] as const
export const VIDEO_MODES = ["自由创作", "图生视频", "多图参考", "首尾帧", "全能替换", "动作跟随"] as const
export const VIDEO_MODELS = ["kling-v3", "seedance-2.0-pro", "veo-3.1-fast", "hailuo-03"] as const
export const OWNERS = ["王晓雯", "陈立", "周可", "林舒", "赵一鸣"]
export const AFTER = ["许岚", "孙磊", "何佳"]

const CITIES = ["杭州", "广州", "深圳", "宁波", "苏州", "海宁", "湖州", "东莞", "温州", "嘉兴", "泉州", "绍兴", "常熟", "佛山", "义乌", "上海", "南通", "无锡"]
const WORDS = ["云织", "衣洛", "初禾", "绮梦", "森屿", "拾光", "南衿", "素影", "锦程", "暖野", "澄意", "微澜", "知秋", "青柚", "朗月", "栖木", "简衣", "凡尔", "晴川", "沐棠", "望舒", "知更", "星禾", "朵拉", "麦田", "织语", "曼陀", "清和", "若水", "启明", "未央", "鹿鸣", "长安", "蓝屿", "橙光", "半夏", "听雨", "山岚", "素年", "安和"]
const TRADES = ["服饰", "服装", "纺织", "电子商务", "网络科技", "贸易", "时装", "针织", "制衣", "品牌管理"]
const SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余于杜叶程魏苏吕丁任沈姚卢钟姜崔谭陆范汪廖石金韦贾夏付方邹熊白孟秦邱侯江尹薛闫段雷龙黎史陶贺毛郝顾龚邵万覃武钱戴严莫孔向常汤"
const GIVEN = ["晓", "雨", "思", "佳", "子", "梓", "欣", "怡", "浩", "宇", "俊", "婷", "静", "敏", "磊", "强", "芳", "丽", "娜", "琳", "涛", "鹏", "杰", "颖", "倩", "雪", "楠", "瑶", "昊", "峰"]

type Story = "steady" | "growing" | "fading" | "drop" | "surge" | "new" | "returned" | "silent" | "lost" | "none"
type Tier = "top" | "heavy" | "medium" | "burst" | "light" | "trial" | "lost" | "none"

interface TierSpec {
  base: [number, number]
  days: [number, number]
  activeP: number
  stories: [Story, number][]
}

const TIERS: Record<Line, Record<Exclude<Tier, "none">, TierSpec>> = {
  inspiration: {
    top: { base: [2100, 2500], days: [6, 7], activeP: 1, stories: [["steady", 1]] },
    heavy: { base: [110, 420], days: [4, 6], activeP: 0.96, stories: [["steady", 6], ["drop", 2], ["surge", 1], ["growing", 1], ["fading", 1]] },
    medium: { base: [24, 95], days: [3, 5], activeP: 0.9, stories: [["steady", 5], ["drop", 1.2], ["surge", 1], ["growing", 1], ["fading", 1], ["silent", 1], ["returned", 0.8], ["new", 0.8]] },
    burst: { base: [28, 120], days: [1, 2], activeP: 0.55, stories: [["steady", 3], ["silent", 1], ["returned", 1]] },
    light: { base: [6, 18], days: [2, 3], activeP: 0.7, stories: [["steady", 4], ["silent", 1], ["returned", 1], ["new", 1.2]] },
    trial: { base: [1, 6], days: [1, 1], activeP: 0.35, stories: [["steady", 3], ["new", 2], ["silent", 1]] },
    lost: { base: [20, 80], days: [2, 4], activeP: 0.85, stories: [["lost", 1]] },
  },
  video: {
    top: { base: [330, 420], days: [6, 7], activeP: 1, stories: [["steady", 1]] },
    heavy: { base: [22, 60], days: [3, 5], activeP: 0.92, stories: [["steady", 5], ["drop", 2], ["surge", 1], ["fading", 1]] },
    medium: { base: [7, 18], days: [2, 4], activeP: 0.85, stories: [["steady", 4], ["drop", 1], ["surge", 1], ["silent", 1], ["new", 1]] },
    burst: { base: [8, 20], days: [1, 1], activeP: 0.5, stories: [["steady", 2], ["returned", 1]] },
    light: { base: [2, 4], days: [2, 2], activeP: 0.6, stories: [["steady", 3], ["new", 1], ["silent", 1]] },
    trial: { base: [1, 3], days: [1, 1], activeP: 0.3, stories: [["steady", 2], ["new", 2]] },
    lost: { base: [8, 20], days: [2, 3], activeP: 0.8, stories: [["lost", 1]] },
  },
}

const TIER_COUNTS: Record<Line, [Tier, number][]> = {
  inspiration: [["heavy", 25], ["medium", 24], ["burst", 9], ["light", 34], ["trial", 36], ["lost", 18]],
  video: [["heavy", 7], ["medium", 12], ["burst", 6], ["light", 6], ["trial", 14], ["lost", 6]],
}

export interface Member {
  id: string
  name: string
  phone: string
  weight: number
}

export interface Ent {
  ref: EnterpriseRef
  index: number
  adminPhone: string
  contract: ContractState
  owner: { sales: string | null; afterSales: string | null }
  members: Member[]
  garment: Garment
  palette: number
  otherFunctions: boolean
  firstSeen: string
  lines: Record<Line, LineProfile | null>
}

export interface LineProfile {
  tier: Tier
  story: Story
  intents: [string, number][]
  model: string
  models: [string, number][]
  modes: [string, number][]
  download: number
  stuck: number
  batch: number
  agent: number
  failRate: number
  weeks: (Cell | null)[]
}

export interface Cell {
  week: number
  days: number[]
  tasks: number
  points: number
  downloaded: number
  failed: number
  users: number
  outputs: number
  failures: Partial<Record<FailureCategory, number>>
  downloadRate: number
  stuck: number
  batch: number
  agentRows: number
  pointsDownloaded: number
}

const phone = (r: Rand) => `1${pick(r, ["3", "5", "7", "8", "9"])}${String(int(r, 0, 999999999)).padStart(9, "0")}`

const lognorm = (r: Rand, sd: number) => Math.exp(normal(r) * sd - (sd * sd) / 2)

const spreadDays = (r: Rand, tasks: number, nDays: number) => {
  const chosen = new Set<number>()
  const order = [0, 1, 2, 3, 4, 5, 6].sort(() => r() - 0.5)
  for (const d of order) {
    if (chosen.size >= nDays) break
    if (d >= 5 && r() < 0.55) continue
    chosen.add(d)
  }
  for (const d of order) if (chosen.size < nDays) chosen.add(d)
  const ds = [...chosen].sort((a, b) => a - b)
  const w = ds.map(() => 0.4 + r())
  const sum = w.reduce((a, b) => a + b, 0)
  const days = [0, 0, 0, 0, 0, 0, 0]
  let left = tasks
  ds.forEach((d, i) => {
    const n = i === ds.length - 1 ? left : Math.min(left, Math.round((tasks * w[i]) / sum))
    days[d] = n
    left -= n
  })
  return days
}

const storyMult = (story: Story, i: number, r: Rand) => {
  switch (story) {
    case "growing":
      return 0.45 + i * 0.07
    case "fading":
      return Math.max(0.15, 1.35 - i * 0.09)
    case "drop":
      return i === LATEST ? 0.22 + r() * 0.12 : i === LATEST + 1 ? 0.3 : 1
    case "surge":
      return i === LATEST ? 2.4 + r() : i === LATEST + 1 ? 2.2 : 0.85
    default:
      return 1
  }
}

const activeAt = (story: Story, start: number, end: number, i: number, p: number, r: Rand) => {
  if (story === "none" || i < start || i > end) return false
  if (story === "returned" && i === LATEST - 1) return false
  if (story === "silent" || story === "lost") return i === end || i === start || r() < p
  if (story === "new" || story === "returned") return i >= LATEST || r() < p
  if (story === "drop" || story === "surge") return i >= LATEST - 1 || r() < p
  return r() < p
}

const intentMix = (r: Rand, line: Line): [string, number][] => {
  if (line === "video") return []
  const main = weighted(r, [["换色", 3], ["印花面料", 2], ["换装上身", 2.4], ["换模特换脸", 1.4], ["换背景", 1], ["平铺白底", 1], ["改款设计", 1.2], ["详情排版", 0.6], ["姿势角度", 0.6], ["修图去除", 0.6]] as const)
  const others = INTENTS.filter((x) => x !== main).sort(() => r() - 0.5).slice(0, int(r, 1, 4))
  const mainShare = between(r, 0.42, 0.82)
  const rest = others.map(() => r())
  const sum = rest.reduce((a, b) => a + b, 0)
  return [[main, mainShare], ...others.map((o, i) => [o, ((1 - mainShare) * rest[i]) / sum] as [string, number])]
}

const modeMix = (r: Rand): [string, number][] => {
  const main = weighted(r, [["自由创作", 4], ["多图参考", 3], ["图生视频", 3], ["首尾帧", 0.6], ["全能替换", 0.6], ["动作跟随", 0.4]] as const)
  const others = VIDEO_MODES.filter((x) => x !== main).sort(() => r() - 0.5).slice(0, int(r, 0, 2))
  const mainShare = others.length ? between(r, 0.5, 0.88) : 1
  return [[main, mainShare], ...others.map((o) => [o, (1 - mainShare) / others.length] as [string, number])]
}

const build = () => {
  const r = rng("fd-desk-world")
  const N = 176
  const names = new Set<string>()
  const ents: Ent[] = []
  const tierOf: Record<Line, Tier[]> = { inspiration: Array(N).fill("none"), video: Array(N).fill("none") }
  tierOf.inspiration[0] = "top"
  tierOf.video[3] = "top"
  for (const line of ["inspiration", "video"] as Line[]) {
    const slots = line === "inspiration" ? Array.from({ length: 150 }, (_, i) => i).filter((i) => i !== 0 && i !== 3) : [0, ...Array.from({ length: 30 }, (_, i) => 1 + i * 5), ...Array.from({ length: 25 }, (_, i) => 151 + i)].filter((i, k, a) => i !== 3 && a.indexOf(i) === k)
    const shuffled = slots.sort(() => r() - 0.5)
    let k = 0
    for (const [tier, n] of TIER_COUNTS[line]) for (let j = 0; j < n && k < shuffled.length; j++) tierOf[line][shuffled[k++]] = tier
  }
  for (let i = 0; i < N; i++) {
    let name = ""
    while (!name || names.has(name)) name = `${pick(r, CITIES)}${pick(r, WORDS)}${pick(r, TRADES)}有限公司`
    names.add(name)
    const kind: EnterpriseKind = i === 0 ? "unknown" : i === 7 ? "agency" : i === 11 ? "internal" : "customer"
    const contract: ContractState = kind === "internal" ? "internal" : r() < 0.78 ? "active" : r() < 0.6 ? "trial" : "expired"
    const nMembers = clamp(Math.round(1 + lognorm(r, 0.7) * 1.6), 1, 7)
    const members: Member[] = Array.from({ length: nMembers }, (_, m) => ({
      id: `u${(hash(`${i}-${m}`) % 1e8).toString(36)}`,
      name: `${SURNAMES[int(r, 0, SURNAMES.length - 1)]}${pick(r, GIVEN)}${r() < 0.6 ? pick(r, GIVEN) : ""}`,
      phone: phone(r),
      weight: m === 0 ? 3 : between(r, 0.2, 1.6),
    }))
    const ent: Ent = {
      ref: { id: `e${(hash(`ent-${i}`) % 2176782336).toString(36).padStart(6, "0")}`, name, kind },
      index: i,
      adminPhone: members[0].phone,
      contract,
      owner: { sales: r() < 0.88 ? pick(r, OWNERS) : null, afterSales: r() < 0.7 ? pick(r, AFTER) : null },
      members,
      garment: pick(r, garmentKeys),
      palette: int(r, 0, 11),
      otherFunctions: r() < 0.55,
      firstSeen: "",
      lines: { inspiration: null, video: null },
    }
    for (const line of ["inspiration", "video"] as Line[]) {
      const tier = tierOf[line][i]
      if (tier === "none") continue
      const spec = TIERS[line][tier]
      const story = weighted(r, spec.stories)
      const base = between(r, spec.base[0], spec.base[1])
      const start = story === "new" ? LATEST - (r() < 0.75 ? 0 : 1) : tier === "trial" ? int(r, 0, 10) : int(r, 0, 4)
      const end = story === "silent" ? LATEST - 1 : story === "lost" ? int(r, 3, 8) : WEEKS.length - 1
      const download = line === "inspiration" ? clamp(between(r, 0.32, 0.86) + (tier === "trial" ? -0.15 : 0), 0.04, 0.95) : clamp(between(r, 0.3, 0.9), 0.1, 0.95)
      const prof: LineProfile = {
        tier,
        story,
        intents: intentMix(r, line),
        model: "",
        models: [],
        modes: line === "video" ? modeMix(r) : [],
        download: i === 0 && line === "inspiration" ? 0.03 : i === 3 && line === "video" ? 0.3 : download,
        stuck: line === "inspiration" ? clamp(between(r, 0.04, 0.34) + (download < 0.4 ? 0.12 : 0), 0, 0.6) : 0,
        batch: line === "inspiration" ? clamp(between(r, 0.08, 0.6), 0, 0.7) : 0,
        agent: line === "inspiration" && (i === 0 || r() < 0.08) ? (i === 0 ? 0.22 : between(r, 0.03, 0.2)) : 0,
        failRate: line === "inspiration" ? between(r, 0, 0.004) : between(r, 0.02, 0.12),
        weeks: [],
      }
      const pool = line === "inspiration" ? IMAGE_MODELS : VIDEO_MODELS
      const m0 = i === 0 && line === "inspiration" ? "fd-2.0-max" : weighted(r, pool.map((m, k) => [m, k === 0 ? 3 : 2 - k * 0.3] as [string, number]))
      const m1 = pick(r, pool.filter((m) => m !== m0))
      const s0 = between(r, 0.6, 0.95)
      prof.model = m0
      prof.models = [[m0, s0], [m1, 1 - s0]]
      for (let w = 0; w < WEEKS.length; w++) {
        if (!activeAt(story, start, end, w, spec.activeP, r)) {
          prof.weeks.push(null)
          continue
        }
        const tasks = Math.max(1, Math.round(base * storyMult(story, w, r) * lognorm(r, tier === "top" ? 0.08 : 0.28)))
        const nDays = clamp(int(r, spec.days[0], spec.days[1]), 1, 7)
        const allDays = spreadDays(r, tasks, Math.min(nDays, tasks))
        const days = allDays.map((v, d) => (COVER[w].includes(d) ? v : 0))
        const covered = days.reduce((a, b) => a + b, 0)
        if (!covered) {
          prof.weeks.push(null)
          continue
        }
        const dl = clamp(prof.download + normal(r) * 0.06, 0, 0.98)
        const downloaded = Math.round(covered * dl)
        const failed = Math.round(covered * prof.failRate * between(r, 0.5, 1.5))
        const failures: Partial<Record<FailureCategory, number>> = {}
        for (let f = 0; f < failed; f++) {
          const c = weighted(r, [["upstream", 4], ["moderation", 2], ["timeout", 2], ["material", line === "video" ? 2 : 0.2], ["other", 0.4]] as const)
          failures[c] = (failures[c] ?? 0) + 1
        }
        const ppt = line === "inspiration" ? between(r, 3.2, 4.2) : i === 3 ? between(r, 85, 105) : between(r, 35, 80)
        const points = Math.round((covered - failed) * ppt)
        const pointsDownloaded = Math.round(points * clamp(dl * between(r, 0.85, 1.1), 0, 1))
        const stuck = clamp(prof.stuck + normal(r) * 0.04, 0, 0.8)
        const batch = clamp(prof.batch + normal(r) * 0.05, 0, 0.85)
        prof.weeks.push({
          week: w,
          days,
          tasks: covered,
          points,
          downloaded,
          failed,
          users: clamp(Math.round(between(r, 0.5, 1) * Math.min(members.length, 1 + covered / 25)), 1, members.length),
          outputs: line === "inspiration" ? Math.round(covered * between(r, 1.1, 1.4)) : covered - failed,
          failures,
          downloadRate: covered ? downloaded / covered : 0,
          stuck,
          batch,
          agentRows: Math.round(covered * prof.agent),
          pointsDownloaded,
        })
      }
      ent.lines[line] = prof
    }
    const first = Math.min(...(["inspiration", "video"] as Line[]).map((l) => ent.lines[l]?.weeks.findIndex(Boolean) ?? 99).map((v) => (v < 0 ? 99 : v)))
    ent.firstSeen = first < 99 ? `${WEEKS[first]}T10:00:00+08:00` : `${WEEKS[0]}T10:00:00+08:00`
    ents.push(ent)
  }
  return ents
}

export const ENTS = build()
export const BY_ID = new Map(ENTS.map((e) => [e.ref.id, e]))
export const weekIndex = (w: string) => WEEKS.indexOf(w)

export const comparable = (cur: Cell | null, prev: Cell | null, w: number) => {
  const days = COVER[w].filter((d) => w > 0 && COVER[w - 1].includes(d))
  const sum = (c: Cell | null) => (c ? days.reduce((s, d) => s + c.days[d], 0) : 0)
  return { days, current: sum(cur), previous: sum(prev) }
}

export const cellAt = (e: Ent, line: Line, w: number) => (w >= 0 ? e.lines[line]?.weeks[w] ?? null : null)

export const lastActive = (e: Ent, line: Line, w: number) => {
  for (let i = w; i >= 0; i--) {
    const c = cellAt(e, line, i)
    if (c) {
      const d = Math.max(...c.days.map((v, k) => (v ? k : -1)))
      const t = new Date(`${WEEKS[i]}T00:00:00+08:00`).getTime() + d * 86400000 + (10 + (e.index % 8)) * 3600000
      return new Date(t).toISOString()
    }
  }
  return null
}
