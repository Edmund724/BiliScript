// ASR 配置续跑意图（票 provider-onboarding-consistency/04）：字幕空态、概览空态
// 与对话拦截因配置类 ASR 阻塞点「前往设置」时记录的恢复意图——配置保存成功或
// 自动转写开关打开并落盘后，在同一视频重新进入既有字幕抓取链（抓取 → 无字幕
// 出口 → 转写 → 字幕接受事务），不必刷新页面。
//
// 为什么是独立零依赖叶子（对照 reader/overview-setup-resume 票 01 与
// reader/explain-setup-resume 票 02 同一先例）：写入方（三个面的设置动作）与
// 读取方（设置保存成功 / 开关落盘后的续跑）分属不同装配时机，意图必须住在两边
// 都买得起的常驻叶子上；只存当前页面内存（模块级单槽），不落 storage。
//
// 失效口径（写入后任一满足即不续跑，续跑前统一校验）：
//   - 页面视频身份键与写入时不一致（换视频 / 换分 P）；
//   - 意图已被消费（单槽取走）或被显式清除（取消编辑、关闭设置抽屉、关阅读视图）。
// 视频身份取页面 URL（bvid|分 P）而不是 state.clip：写入时刻可能还没有落定的
// clip 身份，而 URL 身份与「用户是否还在同一个视频」永远是同一个答案。

import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import type { AsrSetupKind } from "../asr/asr-setup.js";

export interface AsrSetupResumeIntent {
  /** 页面视频身份键（bvid|分 P）：写入与续跑校验同源，换视频 / 换分 P 即失配 */
  videoKey: string;
  /** 进入设置时解析出的目标类目（诊断快照，不参与续跑判定） */
  kind: AsrSetupKind;
}

// 当前页面的视频身份键（写入与校验同源）。
export function currentPageVideoKey(): string {
  return `${extractBvid(location.href)}|${extractPageIndex(location.href)}`;
}

let pendingIntent: AsrSetupResumeIntent | null = null;

// 记录/覆盖续跑意图（intent 外部对象后续变更不影响已存快照）。
export function setAsrSetupResumeIntent(intent: AsrSetupResumeIntent): void {
  pendingIntent = { ...intent };
}

// 只读窥视（不消费）；返回副本防外部改写内部状态。
export function peekAsrSetupResumeIntent(): AsrSetupResumeIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

// 消费：取走并清空（保证一次意图只续跑一次）；无 pending 时返回 null。
export function consumeAsrSetupResumeIntent(): AsrSetupResumeIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent ? { ...intent } : null;
}

// 清除（取消编辑、关闭设置抽屉、关闭阅读视图等会话收尾时调用，未消费意图即作废）。
export function clearAsrSetupResumeIntent(): void {
  pendingIntent = null;
}
