import type { Authored, EnterpriseKind, Finding, Line, Note, Owner, Settings, TemplateDraft, TemplatePush, Touch } from "@spec/contract"
import defaults from "@spec/settings.default.json"
import seeds from "@spec/seeds.json"
import { NOW } from "./world"

type Builder = (line: Line, week: string) => Touch[]

let builder: Builder = () => []
const touches = new Map<string, Touch[]>()

export const state = {
  settings: JSON.parse(JSON.stringify(defaults)) as Settings,
  nextActions: new Map<string, Authored>(),
  summaries: new Map<string, Authored>(),
  notes: new Map<string, Note[]>(),
  kinds: new Map<string, EnterpriseKind>(),
  owners: new Map<string, Owner>(),
  reasons: new Map<string, string>(),
  dismissed: new Set<string>(),
  reports: new Map<string, { done: Authored | null; next: Authored | null }>(),
  drafts: [] as TemplateDraft[],
  pushes: new Map<string, TemplatePush>(),
  findings: (seeds.findings as Omit<Finding, "id" | "updatedAt" | "rule" | "caveat">[]).map(
    (f, i) => ({ caveat: null, rule: null, ...f, id: `f${i + 1}`, updatedAt: NOW }) as Finding,
  ),
  setBuilder(b: Builder) {
    builder = b
  },
  touchesFor(line: Line, week: string) {
    const k = `${line}|${week}`
    let t = touches.get(k)
    if (!t) {
      touches.set(k, [])
      t = builder(line, week)
      touches.set(k, t)
    }
    return t
  },
  allTouches() {
    return [...touches.values()].flat()
  },
  findTouch(id: string) {
    for (const list of touches.values()) {
      const i = list.findIndex((t) => t.id === id)
      if (i >= 0) return { list, i }
    }
    return null
  },
}
