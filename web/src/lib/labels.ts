import type { AlertKind, ContractState, DraftStatus, EnterpriseKind, FailureCategory, Level, Line, Movement, OfferKind, Pattern, Pool, SampleReason, Source, TouchSlot, TouchStatus, Verdict } from "@spec/contract"

export const lineName: Record<Line, string> = { inspiration: "灵感成款", video: "AI视频" }

export const levelName: Record<Level, string> = { heavy: "重度", medium: "中度", burst: "集中", light: "轻度", trial: "尝试" }

export const levelOrder: Level[] = ["heavy", "medium", "burst", "light", "trial"]

export const movementName: Record<Movement, string> = { lost: "流失", silent: "沉默", drop: "下跌", surge: "上涨", returned: "回归", new: "新增", steady: "平稳" }

export const poolName: Record<Pool, string> = { retain: "保住", recall: "召回", help: "帮助", keep: "维持", nurture: "培育", convert: "转化" }

export const poolOrder: Pool[] = ["retain", "help", "recall", "keep", "nurture", "convert"]

export const poolAction: Record<Pool, string> = {
  retain: "问清原因",
  recall: "带模板等下一批活",
  help: "重跑对比",
  keep: "存成团队模板",
  nurture: "同类用法与入门模板",
  convert: "用这条线做一遍",
}

export const patternName: Record<Pattern, string> = { retry: "重试", tweak: "微调", batch: "批量", adapt: "适配", rework: "改写", new: "新起", agent: "Agent", none: "无用户" }

export const alertName: Record<AlertKind, string> = {
  drop: "掉量",
  vanished: "消失",
  stuck: "卡住",
  cold_start: "新客未下载",
  mismatch: "模型不匹配",
  waste: "空耗",
  failures: "失败集中",
  reuse: "可沉淀",
  surge: "上涨",
}

export const failureName: Record<FailureCategory, string> = { moderation: "内容审核", material: "素材不合规", timeout: "超时", upstream: "上游异常", other: "其他" }

export const kindName: Record<EnterpriseKind, string> = { customer: "客户", internal: "内部", agency: "代运营", unknown: "未标注" }

export const contractName: Record<ContractState, string> = { active: "在约", trial: "试用", internal: "内部", expired: "已到期", unknown: "未知" }

export const sourceName: Record<Source, string> = { rule: "规则", agent: "自动", manual: "手工" }

export const slotName: Record<TouchSlot, string> = { mon: "周一", wed: "周三", fri: "周五" }

export const slotHint: Record<TouchSlot, string> = { mon: "活跃客户", wed: "帮助与培育", fri: "召回与转化" }

export const touchStatusName: Record<TouchStatus, string> = { draft: "草稿", assigned: "已分配", sent: "已发送", replied: "已回复", closed: "关闭" }

export const touchStatusOrder: TouchStatus[] = ["draft", "assigned", "sent", "replied", "closed"]

export const offerName: Record<OfferKind, string> = { template: "模板", comparison: "前后对比", tip: "建议", question: "提问" }

export const verdictName: Record<Verdict, string> = { confirmed: "成立", refuted: "不成立", open: "待验证" }

export const draftStatusName: Record<DraftStatus, string> = { draft: "草稿", tested: "已测试", published: "已上线", pushed: "已推送" }

export const draftStatusOrder: DraftStatus[] = ["draft", "tested", "published", "pushed"]

export const sampleReasonName: Record<SampleReason, string> = { stuck: "卡住链尾", batch: "批量样例", downloaded: "已下载", not_downloaded: "未下载", failed: "失败" }
