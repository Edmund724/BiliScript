// 「思考烧光输出预算 → 正文空串」兜底的策略单源：触发判定与重试预算两处调用点
// （chat/stream 的截断重跑、analysis 单次调用的空正文加倍）此前各写一份 16384 与
// 各自的触发条件，注释互指。本模块只收口「判不判 / 给多少预算」，重放机制
// （stream-reset 整轮重跑 vs 静默重发）、提示纪律（notice vs 抛错）仍归各链。

import { DEFAULT_MAX_TOKENS } from "./output-budget.js";

// 重试时的输出预算（派生值）。语义锚点是协议必填参数的兜底上限
// （adapters/anthropic.ts 声明、ai/output-budget.ts 单源）——首发不带预算、由该
// 兜底决定（openai 协议首发干脆不发 max_tokens 字段），「加倍」只能相对这层兜底；
// 兜底上调后这里必须同步，否则重试反而比首发更小。
export const EMPTY_TEXT_RETRY_MAX_TOKENS = DEFAULT_MAX_TOKENS * 2;

// 触发判定单源：正文为空（纯空白算空；思考不算正文）才值得重试。
// finishReason 可选——传入时要求 "length"（仅 chat 链接 onFinishReason，「截断」
// 才是根因；其它收尾原因的空正文另有解释）；缺省则不约束（analysis 链不接该
// 回调，空即重试）。两种口径都保持原行为。
export function isEmptyTextRetryable({ finishReason, hasBody }: { finishReason?: string | null; hasBody: boolean }): boolean {
  if (hasBody) return false;
  return finishReason === undefined ? true : finishReason === "length";
}

// 重试预算：base 缺省 → 定值（chat/stream 链）；base 有值 → 按原估算加倍并封顶
// （analysis 链）。封顶与 estimateOutputTokens 的 ceiling 同源（两处都锚在
// DEFAULT_MAX_TOKENS）：analysis 的 base ≤ DEFAULT，加倍至多 2×DEFAULT 恰好抵到
// 定值——两条链的「上限的倍加」是同一个数，不再各写一份。
// 预算策略本身（该给多少）是独立议题，本模块只固定「加倍 + 封顶」这一形状。
export function retryBudget(base?: number): number {
  return base === undefined ? EMPTY_TEXT_RETRY_MAX_TOKENS : Math.min(base * 2, EMPTY_TEXT_RETRY_MAX_TOKENS);
}
