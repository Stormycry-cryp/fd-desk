import type { Chain, FailureCategory, Line, Media, Pattern, SampleReason, Task, TaskQuery } from "@spec/contract"
import { art, palette } from "./art"
import { PROMPTS } from "./prompts"
import { between, hash, int, pick, rng, weighted, type Rand } from "./rand"
import { COVER, ENTS, WEEKS, BY_ID, cellAt, type Ent } from "./world"
import { failUser } from "./views"

const media = (kind: "image" | "video", spec: Parameters<typeof art>[0]): Media => {
  const u = art(spec)
  return { kind, url: u, thumb: u, poster: kind === "video" ? art({ ...spec, video: true }) : null }
}

const PROVIDER: Record<FailureCategory, string[]> = {
  moderation: ["Sensitive content detected in input image", "Risk label: copyright"],
  material: ["参考视频帧率需在 24 至 60 之间", "参考视频时长不足 2 秒"],
  timeout: ["Task timed out after 600s"],
  upstream: ["素材处理失败", "502 Bad Gateway from provider"],
  other: ["unexpected error"],
}

const cache = new Map<string, Task[]>()

const at = (w: number, day: number, r: Rand) => {
  const t = new Date(`${WEEKS[w]}T00:00:00+08:00`).getTime() + day * 86400000 + Math.floor(between(r, 9, 21.9) * 3600000)
  return new Date(t)
}

const iso = (d: Date) => {
  const t = new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 19)
  return `${t}+08:00`
}

export const tasksOf = (ent: Ent, line: Line, w: number): Task[] => {
  const key = `${ent.ref.id}|${line}|${w}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = cellAt(ent, line, w)
  const p = ent.lines[line]
  if (!c || !p) return []
  const r = rng(key)
  const cap = Math.min(c.tasks, 90)
  const days = COVER[w].filter((d) => c.days[d] > 0)
  const out: Task[] = []
  const members = ent.members
  const user = () => weighted(r, members.map((m) => [m, m.weight] as const))
  let failLeft = Object.entries(c.failures).flatMap(([k, n]) => Array(Math.min(n ?? 0, 6)).fill(k as FailureCategory))
  while (out.length < cap) {
    const u = user()
    const day = pick(r, days.length ? days : [0])
    let t = at(w, day, r)
    if (line === "inspiration") {
      const roll = r()
      const pattern: Pattern = roll < c.stuck ? "tweak" : roll < c.stuck + c.batch ? "batch" : r() < c.agentRows / Math.max(1, c.tasks) ? "agent" : "new"
      const intent = pattern === "agent" ? "Agent" : weighted(r, p.intents)
      const gen = pick(r, PROMPTS[intent] ?? PROMPTS["换色"])
      const prompt = gen(r)
      const baseColor = palette[(ent.palette + int(r, 0, 3)) % palette.length]
      const n = pattern === "new" ? 1 : int(r, 3, 5)
      const chainId = pattern === "tweak" || pattern === "batch" ? `ch${hash(`${key}${out.length}`).toString(36)}` : null
      const input0 = media("image", { garment: ent.garment, color: baseColor, flat: true })
      for (let i = 0; i < n && out.length < cap; i++) {
        const stuckTail = pattern === "tweak" && i === n - 1
        const downloaded = pattern === "tweak" ? stuckTail && r() < 0.35 : pattern === "batch" ? r() < Math.min(0.95, c.downloadRate + 0.2) : r() < c.downloadRate
        const inColor = pattern === "batch" ? palette[(ent.palette + i * 3 + 1) % palette.length] : baseColor
        const input = pattern === "batch" ? media("image", { garment: ent.garment, color: inColor, flat: true }) : input0
        const outColor = intent === "换色" ? palette[(ent.palette + i + 5) % palette.length] : inColor
        const outCount = pattern === "agent" ? 1 : r() < 0.25 ? 2 : 1
        const outputs = Array.from({ length: outCount }, (_, k) =>
          media("image", { garment: ent.garment, color: k ? palette[(ent.palette + i + 7) % palette.length] : outColor, bg: (i + k + ent.index) % 5, print: intent === "印花面料", person: ["换装上身", "换模特换脸", "姿势角度", "换背景"].includes(intent) }),
        )
        const failed = failLeft.length > 0 && r() < 0.08
        const cat = failed ? (failLeft.shift() as FailureCategory) : null
        out.push({
          rowKey: hash(`${key}row${out.length}`).toString(16).padStart(8, "0") + out.length,
          sourceId: `C_${hash(`${key}c${out.length}`).toString(16)}`,
          turnKey: pattern === "agent" ? `${key}t${Math.floor(out.length / 4)}` : null,
          line,
          scene: "灵感成款",
          mode: pattern === "agent" ? "灵感成款-Agent" : "灵感成款-快速",
          createdAt: iso(t),
          enterprise: ent.ref,
          user: { id: u.id, name: u.name },
          model: p.models.length && r() < p.models[0][1] ? p.models[0][0] : p.models[1]?.[0] ?? p.model,
          prompt: pattern === "tweak" && i > 0 ? `${prompt}${pick(r, ["，再自然一点", "，颜色别太艳", "，保持细节", "，光线柔和一些", "。注意袖口"])}` : prompt,
          inputs: intent === "印花面料" ? [input, media("image", { garment: "skirt", color: palette[(ent.palette + 4) % palette.length], print: true, flat: true })] : [input],
          outputs: failed ? [] : outputs,
          points: failed ? 0 : 3 * outCount + (r() < 0.2 ? 1 : 0),
          status: failed ? "failed" : "success",
          failed,
          downloaded: !failed && downloaded,
          downloadVia: !failed && downloaded ? [pick(r, ["单张下载", "批量下载", "预览下载"])] : [],
          failure: cat ? { category: cat, userMessage: failUser[cat], providerMessage: pick(r, PROVIDER[cat]) } : null,
          durationSeconds: Math.round(between(r, 25, 95)),
          intent,
          pattern: i === 0 && pattern !== "agent" ? "new" : pattern === "tweak" && r() < 0.45 ? "retry" : pattern,
          chainId,
          sampleReason: null,
          config: { resolution: pick(r, ["1K", "2K", "2K", "4K"]), ratio: pick(r, ["3:4", "3:4", "1:1", "9:16"]), videoDuration: null, audio: null, referenceImages: intent === "印花面料" ? 2 : 1, hasReferenceVideo: false },
        })
        t = new Date(t.getTime() + between(r, 1.5, 9) * 60000)
      }
    } else {
      const mode = weighted(r, p.modes)
      const prompt = pick(r, PROMPTS[mode] ?? PROMPTS["自由创作"])(r)
      const color = palette[(ent.palette + int(r, 0, 4)) % palette.length]
      const reroll = r() < 0.18
      const n = reroll ? int(r, 2, 4) : 1
      const chainId = reroll ? `vc${hash(`${key}${out.length}`).toString(36)}` : null
      const first = media("image", { garment: ent.garment, color, person: true, bg: ent.index % 5 })
      for (let i = 0; i < n && out.length < cap; i++) {
        const failed = failLeft.length > 0 && r() < 0.22
        const cat = failed ? (failLeft.shift() as FailureCategory) : null
        const downloaded = !failed && (reroll ? i === n - 1 && r() < 0.5 : r() < c.downloadRate)
        const dur = pick(r, [5, 5, 10])
        out.push({
          rowKey: hash(`${key}v${out.length}`).toString(16).padStart(8, "0") + out.length,
          sourceId: `${hash(`${key}u${out.length}`).toString(16)}-${hash(`${out.length}`).toString(16).slice(0, 4)}`,
          turnKey: null,
          line,
          scene: mode,
          mode,
          createdAt: iso(t),
          enterprise: ent.ref,
          user: { id: u.id, name: u.name },
          model: p.model,
          prompt,
          inputs: mode === "多图参考" ? [first, media("image", { garment: ent.garment, color: palette[(ent.palette + 2) % 12], flat: true }), media("image", { garment: "coat", color: "#9C8B78", bg: 2 })] : [first],
          outputs: failed ? [] : [media("video", { garment: ent.garment, color, person: true, bg: (ent.index + i + 1) % 5 })],
          points: failed ? 0 : Math.round(dur * between(r, 8, 18)),
          status: failed ? "failed" : "success",
          failed,
          downloaded,
          downloadVia: downloaded ? ["下载"] : [],
          failure: cat ? { category: cat, userMessage: failUser[cat], providerMessage: pick(r, PROVIDER[cat]) } : null,
          durationSeconds: Math.round(between(r, 90, 420)),
          intent: null,
          pattern: "none",
          chainId,
          sampleReason: null,
          config: { resolution: pick(r, ["720p", "1080p"]), ratio: pick(r, ["9:16", "3:4", "16:9"]), videoDuration: dur, audio: r() < 0.3, referenceImages: mode === "多图参考" ? 3 : 1, hasReferenceVideo: mode === "动作跟随" || mode === "全能替换" },
        })
        t = new Date(t.getTime() + between(r, 4, 20) * 60000)
      }
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  cache.set(key, out)
  return out
}

const reasonOf = (t: Task): SampleReason | null =>
  t.failed ? "failed" : (t.pattern === "tweak" || t.pattern === "retry") && !t.downloaded ? "stuck" : t.pattern === "batch" ? "batch" : t.downloaded ? "downloaded" : "not_downloaded"

export const queryTasks = (q: TaskQuery) => {
  const w = WEEKS.indexOf(q.week ?? WEEKS[11])
  const ents = q.enterprise ? [BY_ID.get(q.enterprise)].filter(Boolean) as Ent[] : ENTS.filter((e) => cellAt(e, q.line, w)).slice(0, 40)
  let all = ents.flatMap((e) => tasksOf(e, q.line, w))
  if (q.pattern) all = all.filter((t) => t.pattern === q.pattern)
  if (q.intent) all = all.filter((t) => t.intent === q.intent)
  if (q.mode) all = all.filter((t) => t.mode === q.mode)
  if (q.model) all = all.filter((t) => t.model === q.model)
  if (q.downloaded != null) all = all.filter((t) => t.downloaded === q.downloaded)
  if (q.failed != null) all = all.filter((t) => t.failed === q.failed)
  if (q.sample) {
    const buckets: Record<SampleReason, Task[]> = { stuck: [], batch: [], downloaded: [], not_downloaded: [], failed: [] }
    for (const t of all) {
      const r = reasonOf(t)
      if (r && buckets[r].length < q.sample) buckets[r].push({ ...t, sampleReason: r })
    }
    const items = (["stuck", "batch", "not_downloaded", "downloaded", "failed"] as SampleReason[]).flatMap((k) => buckets[k])
    return { items, total: all.length }
  }
  const offset = q.offset ?? 0
  const limit = Math.min(q.limit ?? 50, 200)
  return { items: all.slice(offset, offset + limit), total: all.length }
}

export const chainsOf = (line: Line, week: string, enterprise?: string, minLength = 3, downloaded?: boolean) => {
  const w = WEEKS.indexOf(week)
  const ents = enterprise ? [BY_ID.get(enterprise)].filter(Boolean) as Ent[] : ENTS.filter((e) => cellAt(e, line, w)).slice(0, 40)
  const chains: Chain[] = []
  for (const e of ents) {
    const groups = new Map<string, Task[]>()
    tasksOf(e, line, w).forEach((t) => t.chainId && (t.pattern !== "batch" || line === "video") && groups.set(t.chainId, [...(groups.get(t.chainId) ?? []), t]))
    for (const [id, ts] of groups) {
      if (ts.length < minLength) continue
      const sorted = [...ts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      const dl = sorted.some((t) => t.downloaded)
      if (downloaded != null && dl !== downloaded) continue
      chains.push({ id, line, enterprise: e.ref, user: sorted[0].user, startedAt: sorted[0].createdAt, endedAt: sorted[sorted.length - 1].createdAt, length: sorted.length, downloaded: dl, points: sorted.reduce((s, t) => s + t.points, 0), tasks: sorted })
    }
  }
  return { items: chains.sort((a, b) => b.length - a.length), total: chains.length }
}
