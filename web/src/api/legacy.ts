import type { ApiError, DraftScope, DraftStatus, Id, Line, Meta, Rerun, Source, TemplateDraft, TemplatePush, TemplateSource, WeekKey } from "@spec/contract"

export interface ApiLegacy {
  "GET /api/drafts": { query: { line: Line }; response: TemplateDraft[] }
  "POST /api/drafts": {
    body: { line: Line; title: string; prompt: string; slots: string[]; scene?: string; clusterId?: Id; scope?: DraftScope; source: Source }
    response: TemplateDraft
  }
  "PATCH /api/drafts/:id": {
    body: Partial<{
      title: string
      prompt: string
      slots: string[]
      status: DraftStatus
      fdTemplateId: number | null
      fdTemplateSource: TemplateSource | null
      scope: DraftScope
      pushedTo: Id[]
      source: Source
    }>
    response: TemplateDraft
  }
  "POST /api/drafts/:id/publish": { body: { sceneId: number; model: string; templateImg?: string }; response: TemplateDraft }
  "POST /api/drafts/:id/pushes": { body: { enterprises: Id[]; touchId?: Id; notify?: boolean }; response: TemplatePush }
  "GET /api/pushes/:id": { response: TemplatePush }
  "POST /api/pushes/:id/confirm": { body: { receiverUserIds: number[] }; response: TemplatePush }
  "POST /api/pushes/:id/cancel": { response: TemplatePush }
  "POST /api/fd-account/check": { response: Meta["fdAccount"] }
  "GET /api/reruns": { query: { enterprise?: Id }; response: Rerun[] }
  "POST /api/reruns": { body: { sourceRowKey: Id; prompt: string; model: string }; response: Rerun }
  "POST /api/reruns/:id/confirm": { response: Rerun }
  "POST /api/automation/analysis": { body: { line: Line; week: WeekKey }; response: { id: Id; state: "queued" | "running" | "done" | "failed" } }
  "GET /api/automation/analysis/:id": { response: { id: Id; state: "queued" | "running" | "done" | "failed"; error: ApiError | null } }
}
