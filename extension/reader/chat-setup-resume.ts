// AI 对话首配返回意图（票 provider-onboarding-consistency/03）：用户在 AI 对话
// 因无平台（空态 / 发送前拦截）或缺 Key（错误回合）进入平台编辑时记录的返回意图
// ——保存成功后回到原对话并聚焦输入区，提示「平台已就绪、请确认发送」。是否发送
// 始终由用户再点一次：本意图**不携带**、也不触发任何自动发送。
//
// 为什么是独立零依赖叶子（对照 reader/overview-setup-resume.ts 票 01 与
// reader/explain-setup-resume.ts 票 02）：写入方（对话组合根的两个入口）与读取方
//（保存成功后的回调）分属不同装配时机，意图必须住在两边都买得起的常驻叶子上；
// 只存当前页面内存（模块级单槽），不落 storage——取消、换视频、关面板即失效，
// 刷新页面天然清零。
//
// 失效口径（resumeChatAfterSetup 统一校验）：
//   - contextKey 与当前上下文身份不一致（换视频 / 换分 P / 换字幕轨）；
//   - conversationId 与当前会话身份不一致（新会话 / 切换历史会话）；
//   - 意图已被消费（单槽取走）或被显式清除（取消编辑、关闭设置抽屉、关闭对话会话）。
//
// 两种来源（mode）决定返回时视图怎么收：
//   - "blocked"：发送被平台配置拦在受理之前——消息区停在无平台状态屏，返回时重渲
//     初始态，输入框里的草稿与附件区原样留着；
//   - "error"：回合已被受理（用户气泡 / 部分回复 / 历史记录已在视图里），只提示并
//     聚焦输入区，不重渲消息区、不重发任何内容。

import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";

export type ChatSetupMode = "blocked" | "error";

export interface ChatSetupResumeIntent {
  /** 进入设置时的错误类目（无记录 → 新增流程；缺 Key → 编辑并聚焦 Key） */
  errorClass: OverviewSetupErrorClass;
  /** 缺 Key 时的目标记录 id（已选平台）；无记录时为空串 */
  providerId: string;
  /** 来源：受理前拦截（重渲初始态）或已受理错误回合（保留视图） */
  mode: ChatSetupMode;
  /** 对话上下文身份快照（chatSessionState.currentContextKey）：换视频 / 换分 P 作废 */
  contextKey: string;
  /** 会话身份快照（chatSessionState.currentConversationId）：换会话作废 */
  conversationId: string;
  /** 记录时间（Date.now()） */
  createdAt: number;
}

let pendingIntent: ChatSetupResumeIntent | null = null;

// 记录/覆盖返回意图（intent 外部对象后续变更不影响已存快照）。
export function setChatSetupResumeIntent(intent: ChatSetupResumeIntent): void {
  pendingIntent = { ...intent };
}

// 只读窥视（不消费）；返回副本防外部改写内部状态。
export function peekChatSetupResumeIntent(): ChatSetupResumeIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

// 消费：取走并清空（保证一次意图只生效一次）；无 pending 时返回 null。
export function consumeChatSetupResumeIntent(): ChatSetupResumeIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent ? { ...intent } : null;
}

// 清除（取消编辑、关闭设置抽屉、关闭对话会话等会话收尾时调用，未消费意图即作废）。
export function clearChatSetupResumeIntent(): void {
  pendingIntent = null;
}
