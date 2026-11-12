import { useQuery } from "@tanstack/react-query"
import type { Line, Owner } from "@spec/contract"
import { request, RequestError } from "../api/client"

export interface AccountPoint {
  date: string
  remaining: number
}

export interface Account {
  remaining: number
  total: number
  used7d: number
  usedYesterday: number
  daysLeft: number | null
  trend: AccountPoint[]
  internal: boolean
  takenAt: string
}

export interface OwnerOption {
  name: string
  role: "sales" | "after_sales"
  enterprises: number
}

export interface UnmatchedAccount {
  name: string
  phone: string | null
  sales: string | null
  afterSales: string | null
  remaining: number
  used7d: number
  takenAt: string
}

export type PointsLevel = "out" | "low" | "watch" | "ok" | "idle"

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export const accountOf = (x: unknown): Account | null => {
  const a = (x as { account?: unknown } | null)?.account as Record<string, unknown> | null | undefined
  if (!a || n(a.remaining) == null) return null
  const used7d = n(a.used7d) ?? 0
  const remaining = n(a.remaining)!
  const daysLeft = n(a.daysLeft) ?? (used7d > 0 ? remaining / (used7d / 7) : null)
  const trend = Array.isArray(a.trend) ? (a.trend as AccountPoint[]).filter((p) => p && n(p.remaining) != null) : []
  return { remaining, total: n(a.total) ?? remaining, used7d, usedYesterday: n(a.usedYesterday) ?? 0, daysLeft, trend, internal: !!a.internal, takenAt: String(a.takenAt ?? "") }
}

export const ownerOf = (x: unknown): Owner => {
  const o = (x as { owner?: Partial<Owner> | null } | null)?.owner
  return { sales: o?.sales?.trim() || null, afterSales: o?.afterSales?.trim() || null }
}

export const pointsLevel = (a: Account | null): PointsLevel | null => {
  if (!a) return null
  if (a.remaining <= 0) return "out"
  if (a.used7d <= 0) return "idle"
  if ((a.daysLeft ?? Infinity) <= 7 || a.remaining < a.used7d) return "low"
  if ((a.daysLeft ?? Infinity) <= 21) return "watch"
  return "ok"
}

export const isLow = (a: Account | null) => {
  const l = pointsLevel(a)
  return l === "out" || l === "low"
}

export const daysText = (d: number | null) => (d == null ? "—" : d >= 365 ? "1 年以上" : d >= 100 ? `${Math.round(d / 30)} 个月` : d < 1 ? "不到 1 天" : `${Math.floor(d)} 天`)

export const levelText: Record<PointsLevel, string> = { out: "已用完", low: "快用完", watch: "三周内", ok: "充足", idle: "近 7 天没消耗" }

export const ownerMatch = (o: Owner, name: string) => o.sales === name || o.afterSales === name

const optional = async <T,>(key: string, query: Record<string, unknown> = {}): Promise<T | null> => {
  try {
    return await request<T>(key, { query })
  } catch (e) {
    if (e instanceof RequestError && (e.missing || e.status === 404)) return null
    throw e
  }
}

export const useOwners = (line: Line) =>
  useQuery({ queryKey: ["GET /api/owners", line], queryFn: () => optional<OwnerOption[]>("GET /api/owners", { line }), staleTime: 300000, retry: false })

export const useUnmatched = () =>
  useQuery({ queryKey: ["GET /api/accounts/unmatched"], queryFn: () => optional<UnmatchedAccount[]>("GET /api/accounts/unmatched"), staleTime: 300000, retry: false })

export const ownersFromRows = (rows: unknown[]): OwnerOption[] => {
  const m = new Map<string, OwnerOption>()
  rows.forEach((r) => {
    const o = ownerOf(r)
    ;([["sales", o.sales], ["after_sales", o.afterSales]] as const).forEach(([role, name]) => {
      if (!name) return
      const k = `${role}:${name}`
      const cur = m.get(k) ?? { name, role, enterprises: 0 }
      cur.enterprises += 1
      m.set(k, cur)
    })
  })
  return [...m.values()].sort((a, b) => b.enterprises - a.enterprises)
}

export const accountsAt = (meta: unknown): string | null => {
  const v = (meta as { accountsAt?: unknown } | null | undefined)?.accountsAt
  return typeof v === "string" && v ? v : null
}
