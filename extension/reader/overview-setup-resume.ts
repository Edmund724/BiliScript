// 概览首配续跑意图（票 provider-onboarding-consistency/01）：用户在概览因无 AI
// 平台或缺 Key 点「去设置」时记录的恢复意图——首次配置保存成功后自动退出设置并
// 在同一视频续跑一次概览。
//
// 为什么是独立零依赖叶子（对照 reader/explain-intent.ts 先例）：写入方（概览
// 协调器的 setup 动作）与读取方（设置保存成功后的装配方回调）分属不同装配时机，
// 意图必须住在两边都买得起的常驻叶子上；只存当前页面内存（模块级单槽），
// 不落 storage——取消、换视频、关面板即失效，刷新页面天然清零。
//
// 失效口径（写入后任一满足即不续跑，resumeAfterSetup 统一校验）：
//   - overviewKey 与当前概览身份键不一致（换视频 / 换分 P / 换字幕轨）；
//   - taskEpoch 与当前任务代次不一致（意图记录后概览任务又起过新一轮）；
//   - 意图已被消费（单槽取走）或被显式清除（取消编辑、关闭设置面板）。

import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";

export interface OverviewSetupResumeIntent {
  /** 概览身份键（bvid|cid|字幕签名）：写入时的当前键，续跑前比对 */
  overviewKey: string;
  /** 概览任务代次：写入时的协调器代次，续跑前比对 */
  taskEpoch: number;
  /** 记录时间（Date.now()） */
  createdAt: number;
  /** 进入设置时的错误类目（无记录 → 新增流程；缺 Key → 编辑并聚焦 Key） */
  errorClass: OverviewSetupErrorClass;
}

let pendingIntent: OverviewSetupResumeIntent | null = null;

// 记录/覆盖续跑意图（intent 外部对象后续变更不影响已存快照）。
export function setOverviewSetupResumeIntent(intent: OverviewSetupResumeIntent): void {
  pendingIntent = { ...intent };
}

// 只读窥视（不消费）；返回副本防外部改写内部状态。
export function peekOverviewSetupResumeIntent(): OverviewSetupResumeIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

// 消费：取走并清空（保证一次意图只续跑一次）；无 pending 时返回 null。
export function consumeOverviewSetupResumeIntent(): OverviewSetupResumeIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent ? { ...intent } : null;
}

// 清除（取消编辑、关闭设置面板等会话收尾时调用，未消费意图即作废）。
export function clearOverviewSetupResumeIntent(): void {
  pendingIntent = null;
}
