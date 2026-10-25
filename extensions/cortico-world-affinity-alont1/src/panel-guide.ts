import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "好感度",
  "purpose": "记录关系、情绪、表达方式与还没过去的事。",
  "setup": "启用扩展后按需要设置桌宠对象 ID、初始分数和每日增量上限。",
  "firstUse": "在对话中请 Coo 先用 affinity_get 感受关系（省略 qq 就是面前这个人）；情绪用 affinity_feel 记，亲疏变化用 affinity_adjust，事情过去了用 affinity_repair，affinity_list 看心里排前面的人。",
  "troubleshoot": "没有记录时先确认 subjectId 和记录键一致；affinity_get 不显示分数，账本在 data/affinity.json 和 affinity.changed 事件里。"
}
