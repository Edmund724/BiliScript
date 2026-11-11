// 解释卡首配续跑意图（票 provider-onboarding-consistency/02）：选区解释因无 AI
// 平台或缺 Key 落 error 态、用户点「去设置」时记录的恢复意图——首次配置保存成功
// 后自动退出设置并在同一解释卡（同一选区/字幕句/时刻）续跑一次解释。
//
// 为什么是独立零依赖叶子（对照 reader/overview-setup-resume.ts 票 01 与
// reader/explain-intent.ts 的 PR3 契约先例）：写入方（解释卡的 setup 动作）与
// 读取方（设置保存成功后的回调）分属不同装配时机，意图必须住在两边都买得起的
// 常驻叶子上；只存当前页面内存（模块级单槽），不落 storage——取消、换视频、
// 关卡片即失效，刷新页面天然清零。
//
// 失效口径（写入后任一满足即不续跑，resumeExplainAfterSetup 统一校验）：
//   - runId 与当前卡片代际号不一致（换选区重开、重试、关闭过卡片）；
//   - bvid/cid 与当前 clip 不一致（换视频 / 换分 P）；
//   - 卡片已关闭，或选区/整句快照与当前卡片不一致；
//   - 意图已被消费（单槽取走）或被显式清除（取消编辑、关闭设置抽屉、关阅读视图）。

import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";

export interface ExplainSetupResumeIntent {
  /** 用户选中的原文（写入时快照，续跑前比对） */
  selection: string;
  /** 选中所在的整条字幕句 */
  line: string;
  /** 所在句起始秒 */
  from: number;
  /** 所在句在字幕体中的下标（上下文窗口锚点） */
  index: number;
  /** 卡片代际号快照：写入时的 explain-card runId，续跑前比对 */
  runId: number;
  /** 视频身份快照（换视频 / 换分 P 作废） */
  bvid: string;
  cid: string;
  /** 记录时间（Date.now()） */
  createdAt: number;
  /** 进入设置时的错误类目（无记录 → 新增流程；缺 Key → 编辑并聚焦 Key） */
  errorClass: OverviewSetupErrorClass;
}

let pendingIntent: ExplainSetupResumeIntent | null = null;

// 记录/覆盖续跑意图（intent 外部对象后续变更不影响已存快照）。
export function setExplainSetupResumeIntent(intent: ExplainSetupResumeIntent): void {
  pendingIntent = { ...intent };
}

// 只读窥视（不消费）；返回副本防外部改写内部状态。
export function peekExplainSetupResumeIntent(): ExplainSetupResumeIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

// 消费：取走并清空（保证一次意图只续跑一次）；无 pending 时返回 null。
export function consumeExplainSetupResumeIntent(): ExplainSetupResumeIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent ? { ...intent } : null;
}

// 清除（取消编辑、关闭设置抽屉、关闭阅读视图等会话收尾时调用，未消费意图即作废）。
export function clearExplainSetupResumeIntent(): void {
  pendingIntent = null;
}
