import type { Profile, ProfileFacts } from "@spec/contract"

const hours = [
  [0, 0, 0, 0, 0, 0, 0, 0, 7, 20, 65, 39, 1, 26, 92, 75, 55, 67, 43, 16, 3, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 5, 50, 74, 92, 2, 32, 81, 36, 61, 57, 26, 20, 16, 4, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 7, 19, 34, 99, 3, 9, 74, 49, 77, 57, 25, 18, 11, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 10, 19, 35, 48, 0, 25, 79, 73, 61, 41, 27, 11, 7, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 14, 12, 47, 73, 2, 26, 63, 71, 66, 63, 11, 12, 27, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 18, 44, 47, 49, 0, 17, 89, 71, 60, 75, 2, 0, 0, 0, 2, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 22, 28, 9, 0, 5, 34, 18, 16, 29, 3, 8, 0, 0, 0, 0],
]

const weeks = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]
const tasks = [96, 212, 238, 180, 205, 260, 318, 296, 344, 120]
const dl = [0.58, 0.61, 0.55, 0.6, 0.63, 0.66, 0.62, 0.68, 0.71, 0.69]

const facts: ProfileFacts = {
  scope: "all",
  totals: { tasks: 3117, recentTasks: 1218, points: 9840, recentPoints: 3910, downloadRate: 0.63, recentDownloadRate: 0.69, activeWeeks: 10, stableWeeks: 8, firstSeenAt: "2026-09-10T10:12:00+08:00", lastActiveAt: "2026-11-10T17:40:00+08:00" },
  weekly: weeks.map((w, i) => ({ week: w, complete: i > 0 && i < 9, tasks: tasks[i], points: tasks[i] * 3, activeDays: 5, downloadRate: dl[i], level: i > 0 && i < 9 ? "heavy" : null })),
  hours,
  primeHours: { from: 14, to: 18 },
  weekendShare: 0.14,
  scenes: [
    { scene: "自由改款", line: "other", tasks: 1591, share: 0.51, recentShare: 0.38 },
    { scene: "灵感成款", line: "inspiration", tasks: 1476, share: 0.47, recentShare: 0.6 },
    { scene: "图生视频", line: "video", tasks: 33, share: 0.011, recentShare: 0.015 },
    { scene: "多图参考", line: "video", tasks: 15, share: 0.005, recentShare: 0.004 },
  ],
  intents: [
    { key: "换装上身", tasks: 620, share: 0.42, downloadRate: 0.74 },
    { key: "换色", tasks: 410, share: 0.28, downloadRate: 0.69 },
    { key: "改款设计", tasks: 190, share: 0.13, downloadRate: 0.41 },
    { key: "印花面料", tasks: 120, share: 0.08, downloadRate: 0.28 },
    { key: "换背景", tasks: 80, share: 0.05, downloadRate: 0.66 },
  ],
  models: [
    { model: "nano_banana_pro", tasks: 1182, share: 0.46, downloadRate: 0.66, firstUsedAt: "2026-09-10", lastUsedAt: "2026-11-10" },
    { model: "nano_banana_2", tasks: 826, share: 0.32, downloadRate: 0.71, firstUsedAt: "2026-10-08", lastUsedAt: "2026-11-10" },
    { model: "gemini-nano-banana-2.1", tasks: 379, share: 0.15, downloadRate: 0.52, firstUsedAt: "2026-09-12", lastUsedAt: "2026-11-06" },
    { model: "doubao-seedream-5.0-flash", tasks: 168, share: 0.07, downloadRate: 0.44, firstUsedAt: "2026-10-21", lastUsedAt: "2026-11-03" },
  ],
  inputs: {
    imageCounts: [
      { count: 2, share: 0.55 },
      { count: 1, share: 0.38 },
      { count: 3, share: 0.06 },
    ],
    promptLengthMedian: 34,
    ratios: [
      { key: "3:4", share: 0.71 },
      { key: "1:1", share: 0.18 },
      { key: "9:16", share: 0.11 },
    ],
    resolutions: [
      { key: "2K", share: 0.64 },
      { key: "1K", share: 0.3 },
      { key: "4K", share: 0.06 },
    ],
  },
  quality: {
    stuckShare: 0.27,
    batchShare: 0.31,
    failed: 6,
    failures: [
      { category: "upstream", count: 4 },
      { category: "timeout", count: 2 },
    ],
    unresolvedChains: 5,
  },
  rhythm: { kind: "continuous", batchGapWeeks: null, currentGapWeeks: 0, trend: null },
  members: [
    { id: "m1", name: "设计一组", phone: "18100000001", tasks: 2210, downloadRate: 0.71, lastActiveAt: "2026-11-10T17:40:00+08:00" },
    { id: "m2", name: "小周", phone: "13800001111", tasks: 907, downloadRate: 0.48, lastActiveAt: "2026-11-07T15:20:00+08:00" },
  ],
}

const ev = (label: string, value: string | null, section?: string) => ({ label, value, target: section ? { page: "enterprise" as const, enterprise: "kit", section } : null })

export const sampleProfile: Profile = {
  enterprise: { id: "kit", name: "示例：杭州某服饰有限公司", kind: "unknown" },
  adminPhone: "13300000000",
  state: "ready",
  version: 3,
  generatedAt: "2026-11-11T08:10:00+08:00",
  headline: { text: "示例：女装商家，用 FD 把平铺图批量做成上身图和换色款", source: "agent", updatedAt: "2026-11-11T08:10:00+08:00" },
  change: "示例：近 4 周灵感成款占比从 47% 升到 60%，自由改款相应减少",
  tags: [
    { dimension: "category", value: "女装", source: "agent" },
    { dimension: "role", value: "品牌商家", source: "agent" },
    { dimension: "purpose", value: "上身图", source: "manual" },
    { dimension: "rhythm", value: "连续", source: "rule" },
    { dimension: "skill", value: "一般", source: "agent" },
  ],
  insights: [
    { id: "i1", key: "business", text: "示例：针织和外套为主的女装商家，秋冬款占多数。", confidence: "high", evidence: [ev("换装上身", "42%", "facts.intents")], opportunityId: null },
    { id: "i2", key: "usage", text: "示例：主要把供应商平铺图转成模特上身图，再批量换色出款。", confidence: "high", evidence: [ev("批量占比", "31%", "facts.quality"), ev("输入 2 张图", "55%")], opportunityId: null },
    { id: "i3", key: "workflow", text: "示例：两人在用，一人负责出图，工作日下午集中使用。", confidence: "medium", evidence: [ev("主要时段", "14–18 点", "facts.hours")], opportunityId: null },
    { id: "i4", key: "skill", text: "示例：提示词偏短，改款类任务常靠反复重试。", confidence: "medium", evidence: [ev("提示词中位", "34 字")], opportunityId: null },
    { id: "i5", key: "pain", text: "示例：印花面料上身时花型容易变形，下载率只有 28%。", confidence: "high", evidence: [ev("印花面料下载率", "28%", "facts.intents"), ev("没出图的连续尝试", "5 条", "chains")], opportunityId: null },
    { id: "i6", key: "opportunity", text: "示例：适合做一个面料满印的定制模板。", confidence: "medium", evidence: [ev("模板机会", null)], opportunityId: "o1" },
    { id: "i7", key: "workflow", text: "示例：周末偶尔有人用，可能是老板自己在看效果。", confidence: "low", evidence: [ev("周末占比", "14%")], opportunityId: null },
  ],
  facts: { all: facts, inspiration: { ...facts, scope: "inspiration" }, video: null },
  samples: [],
  annotations: [],
  movements: [],
}
