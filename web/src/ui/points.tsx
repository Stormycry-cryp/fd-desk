import { useState } from "react"
import type { Owner } from "@spec/contract"
import { cx } from "./controls"
import { Icon } from "./icons"
import { Tooltip } from "./overlays"
import { MiniArea } from "./charts"
import { compact, num, time } from "../lib/format"
import { daysText, levelText, pointsLevel, type Account } from "../lib/accounts"

const Gauge = ({ a }: { a: Account }) => {
  const share = a.total > 0 ? Math.max(0, Math.min(1, a.remaining / a.total)) : 0
  return (
    <span className="pt-gauge">
      <i style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }} />
    </span>
  )
}

export const PointsTip = ({ a }: { a: Account }) => (
  <div className="pt-tip">
    <div className="pt-tip-h">
      <b className="num">{num(a.remaining)}</b>
      <span>剩余 / 总 {num(a.total)}</span>
    </div>
    <div className="pt-tip-g">
      <span>近 7 天</span>
      <b className="num">{num(a.used7d)}</b>
      <span>昨天</span>
      <b className="num">{num(a.usedYesterday)}</b>
      <span>还能用</span>
      <b className="num">{daysText(a.daysLeft)}</b>
    </div>
    {a.takenAt && <div className="pt-tip-t num">{time(a.takenAt)} 更新</div>}
  </div>
)

export const PointsCell = ({ a }: { a: Account | null }) => {
  const lv = pointsLevel(a)
  if (!a || !lv) return <span className="faint">—</span>
  return (
    <Tooltip content={<PointsTip a={a} />}>
      <span className={cx("pt-cell", lv)}>
        <span className="pt-top">
          <b className="num">{compact(a.remaining)}</b>
          <span className="pt-days num">{lv === "out" ? "用完" : lv === "idle" ? "未消耗" : daysText(a.daysLeft)}</span>
        </span>
        <Gauge a={a} />
      </span>
    </Tooltip>
  )
}

export const PointsTag = ({ a }: { a: Account | null }) => {
  const lv = pointsLevel(a)
  if (!a || !lv || (lv !== "out" && lv !== "low")) return null
  return <span className={cx("pt-tag", lv)}>{lv === "out" ? "点数用完" : `点数剩 ${daysText(a.daysLeft)}`}</span>
}

export const OwnerCell = ({ o }: { o: Owner }) => {
  if (!o.sales && !o.afterSales) return <span className="faint">—</span>
  return (
    <span className="ow-cell">
      <span className="ow-n">{o.sales ?? <i>—</i>}</span>
      <span className="ow-n sub">{o.afterSales ?? <i>—</i>}</span>
    </span>
  )
}

const OwnerField = ({ label, value, onSave }: { label: string; value: string | null; onSave?: (v: string | null) => void }) => {
  const [draft, setDraft] = useState<string | null>(null)
  const save = () => {
    if (draft != null && (draft.trim() || null) !== value) onSave?.(draft.trim() || null)
    setDraft(null)
  }
  return (
    <div className="ow-f">
      <span className="ow-k">{label}</span>
      {draft != null ? (
        <input
          autoFocus
          className="ow-in"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), save())
            if (e.key === "Escape") (e.stopPropagation(), setDraft(null))
          }}
        />
      ) : (
        <button className={cx("ow-v", !value && "unset")} disabled={!onSave} onClick={() => setDraft(value ?? "")}>
          {value ?? "未填"}
          {onSave && <Icon name="edit" size="xs" />}
        </button>
      )}
    </div>
  )
}

export const AccountStrip = ({ a, owner, onOwner }: { a: Account | null; owner: Owner; onOwner?: (o: Owner) => void }) => {
  const lv = pointsLevel(a)
  const trend = a?.trend ?? []
  return (
    <div className={cx("acct", !a && "bare")}>
      <div className="acct-owners">
        <OwnerField label="销售" value={owner.sales} onSave={onOwner && ((v) => onOwner({ ...owner, sales: v }))} />
        <OwnerField label="售后" value={owner.afterSales} onSave={onOwner && ((v) => onOwner({ ...owner, afterSales: v }))} />
      </div>
      {a && lv && (
        <>
          <div className="acct-main">
            <div className="acct-k">
              剩余点数
              {a.internal && <span className="acct-int">内部账号</span>}
            </div>
            <div className="acct-v">
              <b className="num">{num(a.remaining)}</b>
              <span className="num">/ {compact(a.total)}</span>
            </div>
            <Gauge a={a} />
          </div>
          <div className="acct-nums">
            <div>
              <span>还能用</span>
              <b className={cx("num", lv)}>{lv === "out" ? "已用完" : daysText(a.daysLeft)}</b>
            </div>
            <div>
              <span>近 7 天</span>
              <b className="num">{num(a.used7d)}</b>
            </div>
            <div>
              <span>昨天</span>
              <b className="num">{num(a.usedYesterday)}</b>
            </div>
          </div>
          <div className="acct-trend">
            {trend.length > 1 ? (
              <MiniArea values={trend.map((p) => p.remaining)} labels={trend.map((p) => p.date.slice(5).replace("-", "/"))} format={(v) => num(v)} height={52} />
            ) : (
              <span className={cx("acct-lv", lv)}>{levelText[lv]}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
