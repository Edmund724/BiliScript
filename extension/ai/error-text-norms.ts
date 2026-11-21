export function normalizeErrorText(detail: unknown): string {
  return String(detail ?? "").toLowerCase();
}

export const BUDGET_PARAM_RE =
  /(max_tokens|max_completion_tokens|max_output_tokens|maximum output tokens|最大输出|输出 ?tokens?)/;
export const OUTPUT_BUDGET_PARAM_RE = BUDGET_PARAM_RE;

export const OVER_LIMIT_RE =
  /(too large|too big|greater than|larger than|valid range|out of range|invalid|exceed|>\s*\d|不能大于|不能超过|超出|超过)/;
export const OUTPUT_BUDGET_OVER_LIMIT_RE = OVER_LIMIT_RE;

export const INPUT_SIDE_RE =
  /(context|prompt|input|messages?\b|上下文|输入|提示词)/;
export const OUTPUT_BUDGET_INPUT_SIDE_RE = INPUT_SIDE_RE;

export const CONTEXT_OVERFLOW_DIRECT_PATTERNS: readonly string[] = [
  "context_length",
  "context length",
  "maximum context length",
  "max context length",
  "context window",
  "too many tokens",
  "too long",
  "too large",
  "max_tokens",
  "max tokens",
  "max_output_tokens",
  "token limit",
  "最大上下文",
  "上下文长度",
  "上下文超出",
  "超出上下文",
  "超出长度",
  "超过上下文",
  "令牌超限",
  "token超限",
  "超出上限"
];

export const CONTEXT_OVERFLOW_SUBJECT_RE = /(context|tokens?|length|上下文|长度|令牌|窗口)/;

export const CONTEXT_OVERFLOW_RE = /(exceed|limit|maximum|too many|too long|overflow|超出|超过|超限|上限|最大)/;
