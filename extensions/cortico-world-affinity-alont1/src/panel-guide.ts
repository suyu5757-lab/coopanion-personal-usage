import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "好感度",
  "purpose": "记录交情、关系格子与情绪。",
  "setup": "启用扩展后按需要设置桌宠对象 ID、初始分数和每日增量上限。",
  "firstUse": "在对话中请 Coo 先用 affinity_get 查看交情（省略 qq 就是面前这个人），再用 affinity_adjust 记录有依据的变化；affinity_list 看排行。",
  "troubleshoot": "没有记录时先确认 subjectId 和记录键一致；配置分数不是对真实关系的证明。"
}
