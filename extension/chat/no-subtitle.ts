// extension/chat/no-subtitle.ts — 一键总结「无字幕拦截」的判定与文案（可测纯模块；
// PR5 自 extension/pages/sidepanel-no-subtitle.ts 迁入 chat 域）。
//
// 为什么存在：content 侧无字幕收尾后快照为 subtitleFetchState === "empty" 且字
// 幕体为空，此时把空 subtitleBody 发给模型只会得到凭标题+热评编造的总结。
// ensureCurrentContextForSend 在最终快照后据此拦截发送，并按 noSubtitleReason
// （content 侧 asr/fallback.js 写入、经上下文快照 payload 透传）给出对应提示。
//
// 文案已收归单一真源（asr-error-reporting/06）：本模块退化为**薄适配层**——
// 文案逐字取自 core/asr-failure-notice 的 sidepanel 面，openSettings 由 remedy
// 枚举映射（open-settings → true）。曾经的分支表（四条 case + default）与真源
// 并存，新类目只改一处、另一处静默漂移，故整体退役。
//
// reason 取值（clipState.noSubtitleReason，见 core/state.js，票 04 定稿的十个
// 非 null 值；历史字面量 "asr-failed" 已删除）：
//   null            从未归类 → 通用文案（最常见成因是压根没配平台）
//   "no-asr-config" 平台 / 模型不可用（未配置、域名未授权、baseUrl 缺失、模型不存在）
//   "asr-disabled"  无字幕自动转写开关未开启
//   "asr-auth"      鉴权 / 授权不通过（401 / 403）
//   "asr-quota"     额度或余额不足（402；429 且额度语义）
//   "asr-ratelimit" 被限流（429）
//   "asr-network"   连不上 / 超时
//   "asr-media"     音轨取不到 / 解不了（含 415 与格式类 400）
//   "asr-server"    平台侧故障（5xx）
//   "asr-unknown"   无从判断
//   "asr-empty"     转写成功但未识别到语音内容（本面保留例外整句）
//
// 详情行（「（错误详情：…）」）在本面**刻意不出现**：sidepanel 只从上下文快照
// 拿到 contextData.noSubtitleReason，快照里没有 noSubtitleDetail（票 07 的数据
// 表），本模块也拿不到它——详情行是 reader 状态栏那个单行宿主的呈现设计。

import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { NoSubtitleReason as ClipNoSubtitleReason } from "../core/state.js";
import { buildAsrNoSubtitleMessage, getAsrFailureNotice } from "../core/asr-failure-notice.js";

// 拦截信号不再是本模块导出的字符串哨兵：发送闸经 GateOutcome
//（send-gate.ts 的 { pass: false, kind: "no-subtitle" }）显式返回，调用方按
// 结构化字段判定，不经副作用（输入框是否清空）反推受理结论。

// noSubtitleReason 的可能取值：单源 core/state 的字面量联合（快照经 AiContext
// 的开放索引签名读出为 unknown，调用点显式收窄），此处只叠加读边界的
// undefined（可选字段缺失）。
export type NoSubtitleReason = ClipNoSubtitleReason | undefined;

// 「当前快照是否为无字幕空上下文」判定（ensureCurrentContextForSend 用，纯函数）。
// 与 isContextPending 的边界互补：pending 管"还在抓取/转写"（loading），
// 这里管"已经无字幕收尾"（empty）。字幕体非空即放行，不受状态字段影响。
export function isNoSubtitleEmptyContext(snapshot: ChatSessionContextSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return false;
  }
  const body = Array.isArray(snapshot.subtitleBody) ? snapshot.subtitleBody : [];
  if (body.length > 0) {
    return false;
  }
  return snapshot.subtitleFetchState === "empty";
}

// 按无字幕原因给出提示文案；openSettings 为 true 时提示末尾附「前往设置」
// 链接（sidepanel 负责渲染与 openOptionsPage 接线）。文案与判定都取单一真源：
// 本函数只做「面 → 前缀 + 文案 + 动作位」的适配。
export function buildNoSubtitleNotice(reason: NoSubtitleReason): { message: string; openSettings: boolean } {
  return {
    message: buildAsrNoSubtitleMessage("sidepanel", reason ?? null),
    openSettings: getAsrFailureNotice(reason ?? null).remedy === "open-settings"
  };
}
