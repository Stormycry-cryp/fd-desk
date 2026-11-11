import { useMemo, useState } from "react"
import type { Annotation } from "@spec/contract.next"
import { Card } from "../../ui/display"
import { AnnotationRail, AnnotationScope, ComposerPopover } from "../../ui/annotate"
import { TagPicker } from "../../ui/insight"
import { ProfileTab } from "../enterprise/Profile"
import { sampleProfile } from "./profileSample"

export const ProfilePreview = () => {
  const [p, setP] = useState(sampleProfile)
  const list: Annotation[] = useMemo(() => [
    {
      id: "a1",
      enterprise: p.enterprise,
      kind: "followup",
      anchor: { block: "insight.pain.i5", insightId: "i5", quote: "印花面料上身时花型容易变形", stale: false },
      entries: [
        { id: "e1", text: "示例：11/6 微信问过，客户说是满印面料，花型一大就糊。", createdAt: "2026-11-06T16:20:00+08:00", editedAt: null },
        { id: "e2", text: "示例：答应下周给他一组试验台对比。", createdAt: "2026-11-08T10:05:00+08:00", editedAt: null },
      ],
      resolved: false,
      createdAt: "2026-11-06T16:20:00+08:00",
      updatedAt: "2026-11-08T10:05:00+08:00",
    },
    {
      id: "a2",
      enterprise: p.enterprise,
      kind: "special",
      anchor: { block: "facts.hours", insightId: null, quote: null, stale: false },
      entries: [{ id: "e3", text: "示例：客户说 11 月在备货，12 月才上新。", createdAt: "2026-11-09T11:30:00+08:00", editedAt: null }],
      resolved: false,
      createdAt: "2026-11-09T11:30:00+08:00",
      updatedAt: "2026-11-09T11:30:00+08:00",
    },
  ], [p.enterprise])
  return (
    <div className="page" style={{ maxWidth: 1320 }}>
      <div className="page-head">
        <div>
          <h1>档案预览</h1>
          <div className="meta">事实数字取自一家真实企业的统计；判断与批注是示例文字</div>
        </div>
      </div>
      <Card flush>
        <AnnotationScope enterprise="kit" list={list} mode="rail">
          <div style={{ padding: "20px 24px 0" }}>
            <TagPicker tags={p.tags} onChange={(d, v) => setP({ ...p, tags: [...p.tags.filter((t) => t.dimension !== d), ...(v ? [{ dimension: d, value: v, source: "manual" as const }] : [])] })} />
          </div>
          <div className="ent-full">
            <div style={{ minWidth: 0 }}>
              <ProfileTab p={p} scope="all" />
            </div>
            <div className="ann-col">
              <AnnotationRail />
            </div>
          </div>
          <ComposerPopover />
        </AnnotationScope>
      </Card>
    </div>
  )
}
