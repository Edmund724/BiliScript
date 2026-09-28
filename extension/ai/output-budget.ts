// ai/output-budget.ts — 「调用方不关心输出上限时给多少」与「平台以超上限拒绝后
// 退回多少」两个事实的单源（叶子模块：零 import，SW 静态图安全）。
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
// 而实际上换个更小的预算就能成。
//
// 判据（偏向不误判，漏判退化为现状的溢出错误）：提到输出上限参数名 + 出现过限措辞
// - 参数名只认输出侧精确拼写（max_tokens / max_completion_tokens / max_output_tokens /
//   最大输出 等）——"max tokens exceeded" 这类松拼写通用作输入超长的表述，不认
// - 过限措辞：比较式（"> 8192"）/ 区间式（valid range）/ invalid / too large / exceed /
//   中文「超出|超过」
// 同时排除提到上下文与输入侧词的文案（context / prompt / input / messages）。
const BUDGET_PARAM_RE =
  /(max_tokens|max_completion_tokens|max_output_tokens|maximum output tokens|最大输出|输出 ?tokens?)/i;
const OVER_LIMIT_RE = /(too large|too big|greater than|larger than|valid range|out of range|invalid|exceed|>\s*\d|不能大于|不能超过|超出|超过)/i;
const INPUT_SIDE_RE = /(context|prompt|input|messages?\b|上下文|输入|提示词)/i;

export function isOutputBudgetTooLarge(detail: unknown): boolean {
  const text = String(detail ?? "");
  if (!text) return false;
  if (INPUT_SIDE_RE.test(text)) return false;
  return BUDGET_PARAM_RE.test(text) && OVER_LIMIT_RE.test(text);
}
