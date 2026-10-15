// ai/error-text-norms.ts — HTTP 400 错误文本规一化与判据族单源（叶子模块：零 import，SW 静态图安全）。
//
// 背景：HTTP 400 失败在 core（completion.ts）存在两个互斥分类器：
// 1. isOutputBudgetTooLarge（output-budget.ts）：输出上限给大，退回保守值重发；
// 2. isContextLengthOverflow（completion.ts）：上下文超限，抛出带 overflow 标记供调用方分流。
//
// 两者共享同一文本规一化口径（String + 小写化），并由本模块单源持有各自的判据族（参数名/
// 过限/输入侧排除正则，以及直接子串表/主语·超限双正则）。互斥组合留在调用方，本模块只
// 提供预处理与无状态判据。

/**
 * 规一化错误文案：处理 null/undefined、转为字符串并统一小写。
 */
export function normalizeErrorText(detail: unknown): string {
  return String(detail ?? "").toLowerCase();
}

// ---------------------------------------------------------------------------
// 输出上限判据族（isOutputBudgetTooLarge）
// 偏向不误判：提到输出上限参数名 + 出现过限措辞，且排除上下文与输入侧词
// ---------------------------------------------------------------------------

/**
 * 输出侧参数名白名单（只认精确拼写，松拼写如 "max tokens exceeded" 留作输入侧）。
 */
export const BUDGET_PARAM_RE =
  /(max_tokens|max_completion_tokens|max_output_tokens|maximum output tokens|最大输出|输出 ?tokens?)/;
export const OUTPUT_BUDGET_PARAM_RE = BUDGET_PARAM_RE;

/**
 * 输出过限措辞：比较式（"> 8192"）/ 区间式（valid range）/ invalid / too large / exceed / 中文超出/超过。
 */
export const OVER_LIMIT_RE =
  /(too large|too big|greater than|larger than|valid range|out of range|invalid|exceed|>\s*\d|不能大于|不能超过|超出|超过)/;
export const OUTPUT_BUDGET_OVER_LIMIT_RE = OVER_LIMIT_RE;

/**
 * 输入侧排除词：提到上下文/输入/提示词时，不归输出上限处理。
 */
export const INPUT_SIDE_RE =
  /(context|prompt|input|messages?\b|上下文|输入|提示词)/;
export const OUTPUT_BUDGET_INPUT_SIDE_RE = INPUT_SIDE_RE;

// ---------------------------------------------------------------------------
// 上下文溢出判据族（isContextLengthOverflow）
// 粗判：命中常见溢出子串，或「主语（长度/上下文/令牌）」+「超限」语义同时出现
// ---------------------------------------------------------------------------

/**
 * 上下文溢出常见直接子串表。
 */
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

/**
 * 上下文溢出主语词正则（上下文/长度/令牌/窗口）。
 */
export const CONTEXT_OVERFLOW_SUBJECT_RE = /(context|tokens?|length|上下文|长度|令牌|窗口)/;

/**
 * 上下文超限词正则（超限/最大/超出等）。
 */
export const CONTEXT_OVERFLOW_RE = /(exceed|limit|maximum|too many|too long|overflow|超出|超过|超限|上限|最大)/;
