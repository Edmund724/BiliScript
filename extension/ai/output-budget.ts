import {
  BUDGET_PARAM_RE,
  INPUT_SIDE_RE,
  normalizeErrorText,
  OVER_LIMIT_RE
} from "./error-text-norms.js";

// ai/output-budget.ts — 「调用方不关心输出上限时给多少」与「平台以超上限拒绝后
// 退回多少」两个事实的单源（仅依赖 error-text-norms 叶子，SW 静态图安全）。
//
// 背景：Anthropic Messages 协议的 max_tokens 必填、平台不给默认值（怪癖
// maxTokensRequired，语义见 compat-vocab），调用方不传时由 adapter 兜底。兜底值
// 被两头的失败模式拉扯：
// - 给小（旧的 8192）：长回答被截断（对话 tab 的「回答被截断」徽标；思考型模型把
//   预算烧在思考上时正文干脆空串）；
// - 给大：超过模型自身输出上限会被平台 400 硬拒（Anthropic 官方 = 比较式
//   "max_tokens: N > M, which is the maximum allowed number of output tokens"，
//   DeepSeek 等 = "valid range"），整轮请求失败。
// 折中：默认给现代模型放得下的宽值（DEFAULT_MAX_TOKENS），一旦被平台以「超出
// 上限」拒绝，由 core（completion.ts 唯一 fetch 点）退回保守值重发一次——两类模型
// 都不会整轮失败，上限低的老模型只多花一次往返。
export const DEFAULT_MAX_TOKENS = 32768;

// 退回值 = 旧兜底 8192：它在「放得下思考预算 + 正文」与「低上限模型也能收下」
// 之间已被线上验证过（见 adapters/anthropic.ts 的预算推算），作为退回下限不动。
export const CONSERVATIVE_MAX_TOKENS = 8192;

// 判定一段错误文案是否属于「输出上限给大了」。必须与 isContextLengthOverflow
// 互斥：两者都走 HTTP 400，误判成溢出会把请求推去 Map-Reduce（或报「上下文过长」），
// 而实际上换个更小的预算就能成。判据正则族收口于 error-text-norms.ts。
export function isOutputBudgetTooLarge(detail: unknown): boolean {
  const text = normalizeErrorText(detail);
  if (!text) return false;
  if (INPUT_SIDE_RE.test(text)) return false;
  return BUDGET_PARAM_RE.test(text) && OVER_LIMIT_RE.test(text);
}
