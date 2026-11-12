import type { CheckKey, Priority, ReviseKind, TemplateKind, TemplateState } from "@spec/contract"

export const kindName: Record<TemplateKind, string> = { official: "官方", custom: "定制" }
export const priorityName: Record<Priority, string> = { high: "优先做", medium: "可以做", low: "再观察" }
export const stateName: Record<TemplateState, string> = { draft: "草稿", tried: "已试验", exported: "已导出", live: "已上线", retired: "已停用" }
export const stateOrder: TemplateState[] = ["draft", "tried", "exported", "live", "retired"]
export const checkName: Record<CheckKey, string> = { identity: "不含企业或人名", slots: "槽位完整", variables: "可变项完整", length: "长度合适", duplicate: "不与官方模板重复" }
export const reviseName: Record<ReviseKind, string> = { shorter: "缩短", general: "更通用", specific: "针对问题", from_trial: "根据试验结果", custom: "自由指令" }
