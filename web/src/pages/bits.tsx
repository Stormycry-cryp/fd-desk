import type { Movement, Pool, TouchStatus } from "@spec/contract"
import { movementName, poolName, touchStatusName } from "../lib/labels"
import { Badge } from "../ui/display"

const mvTone: Partial<Record<Movement, "down" | "up" | "warn" | "accent" | "outline">> = { drop: "down", lost: "down", silent: "warn", surge: "up", returned: "up", new: "accent" }

export const MovementTag = ({ m }: { m: Movement }) => (m === "steady" ? <span className="faint" style={{ fontSize: 12 }}>平稳</span> : <Badge tone={mvTone[m]}>{movementName[m]}</Badge>)

const poolTone: Record<Pool, "down" | "up" | "warn" | "accent" | "outline" | undefined> = { retain: "down", help: "warn", recall: "accent", keep: "up", nurture: "outline", convert: "accent" }

export const PoolTag = ({ p }: { p: Pool | null }) => (p ? <Badge tone={poolTone[p]} sq>{poolName[p]}</Badge> : <span className="faint">—</span>)

export const StatusTag = ({ s }: { s: TouchStatus }) => (
  <span className={`status ${s}`}>
    <i />
    {touchStatusName[s]}
  </span>
)
