// ai/usage-stats.ts — 响应 usage 的「实测 chars→token 比」学习（ai-usage-telemetry T2，
// 叶子模块：只 import learned-budget 的作用域键与 budgeter 的系数常量，无新依赖）。
//
// 由来：成本护栏展示的 token 数今天用「一字一 token」（budgeter.ts 的 CHAR_PER_TOKEN）
// 硬猜；同一平台同一模型的响应 usage 里本来就有真实的 prompt_tokens，把它与本次请求
// 的 prompt 字符数一比就得到该 (baseUrl, model) 的实测比。本模块只做三件事：
// 记样本、按最近 8 个样本的中位数回答「学到的比」、记下被 max_tokens 截断时见过的
// 最大 output_tokens（供 T3 的「平台默认输出上限」裁决，本票不消费）。
//
// 纪律：
// - 纯内存、不落盘、不跨 realm（与 learned-budget.ts 同纪律；ADR-0012 已按「持久化
//   学到的值」否决过；两个 realm 各自预热是 spec 已接受的限制）。
// - 作用域 = budgetScopeKey（(baseUrl, model)，与 learned-budget 同源）——不新造全局
//   混样概念：不同平台/模型的 token 计法不同，混在一起的中位数没有意义。
// - 只学比值，不改任何判定：护栏阈值只看调用数，本模块的输出纯展示（阶梯按字符数判）。
// - 中位数抗单点异常（一次网关抽风报的 usage 不该把整会话的估算带偏）。
// - 样本丢弃是整条丢弃（比值不学、cap 也不记）：usage 形状可疑时宁可当没采到，不拿
//   可疑数据去固化任何策略（同 learned-budget「不拿一次失败压低上限」的取舍）。

import { CHAR_PER_TOKEN } from "./budgeter.js";
import { budgetScopeKey, type BudgetScope } from "./learned-budget.js";

// 参与中位数的最近样本数：再多也只是把均值化，中位数本身就抗异常，8 个足够覆盖
// 「同一 scope 下 prompt 长短不一的几轮」，又不至于让旧样本拖住新的实测值。
const SAMPLE_WINDOW = 8;

export interface UsageSampleInput {
  /** 本次请求 messages[].content 的字符合计（含 system/instructions）。 */
  payloadChars?: number;
  /** 响应 usage 的输入 token（缺失 / 非有限 / ≤0 即丢弃）。 */
  inputTokens?: number;
  /** 响应 usage 的输出 token（仅 finishReason === "length" 时进 observedOutputCap）。 */
  outputTokens?: number;
  /** 归一后的结束原因；"length" = 输出被 max_tokens 截断。 */
  finishReason?: string | null;
}

// 比值合理区间：中文约 0.5~2 chars/token，留足余量（英文/代码更低、平台自带长
// system prompt 时更高）。落在区间外的样本多半是 usage 形状不对或单位不是 token，
// 学进去会污染后续所有估算。
const RATIO_MIN = 0.2;
const RATIO_MAX = 20;

interface ScopeStats {
  // 最近 SAMPLE_WINDOW 个有效样本的 payloadChars / inputTokens（新样本在尾）。
  ratios: number[];
  // 仅 finishReason === "length" 的样本里最大的 outputTokens。
  outputCap?: number;
}

const statsByScope = new Map<string, ScopeStats>();

function statsOf(scope: BudgetScope | null | undefined): ScopeStats | undefined {
  return statsByScope.get(budgetScopeKey(scope));
}

/**
 * 记一条响应 usage 样本。scope 经 budgetScopeKey 归一（(baseUrl, model) 口径）。
 * 丢弃：inputTokens 非有限或 ≤0；payloadChars / inputTokens 非有限或落在 [0.2, 20]
 * 之外。被丢弃的样本整条不记（比值与 outputCap 都不更新），不抛错——采样永远不该
 * 影响请求结果。
 */
export function noteUsageSample(scope: BudgetScope | null | undefined, sample: UsageSampleInput): void {
  const inputTokens = Number(sample?.inputTokens);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
    return;
  }
  const ratio = Number(sample?.payloadChars) / inputTokens;
  if (!Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) {
    return;
  }

  const key = budgetScopeKey(scope);
  const stats = statsByScope.get(key) ?? { ratios: [] };
  stats.ratios.push(ratio);
  if (stats.ratios.length > SAMPLE_WINDOW) {
    stats.ratios.splice(0, stats.ratios.length - SAMPLE_WINDOW);
  }

  const outputTokens = Number(sample?.outputTokens);
  if (sample?.finishReason === "length" && Number.isFinite(outputTokens) && outputTokens > 0) {
    stats.outputCap = Math.max(stats.outputCap ?? 0, outputTokens);
  }

  statsByScope.set(key, stats);
}

/**
 * 该 scope 学到的 chars/token 比：最近 8 个有效样本的中位数（偶数个取中间两值
 * 平均）。无样本 → undefined，调用方回落到 CHAR_PER_TOKEN。
 */
export function learnedCharsPerToken(scope: BudgetScope | null | undefined): number | undefined {
  const ratios = statsOf(scope)?.ratios;
  if (!ratios?.length) {
    return undefined;
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 该 scope 观察到的输出上限（T3 数据源）：仅 finishReason === "length" 的样本参与，
 * 取其中最大的 outputTokens；无此类样本 → undefined。本票不消费。
 */
export function observedOutputCap(scope: BudgetScope | null | undefined): number | undefined {
  return statsOf(scope)?.outputCap;
}

/**
 * 字符数 → 估算 token 数的唯一换算函数（成本护栏数字的两个调用点共用，禁止各写一份）：
 * 有实测比用实测比，无样本回落 CHAR_PER_TOKEN。四舍五入取整（护栏文案展示的是整数）。
 * 非有限 / 非正的字符数回落到 0——注入方 fake plan 不带 totalChars 时护栏数字保持
 * 改动前的 "0"，不让 NaN 漏进用户可见文案。
 */
export function estimateTokensFromChars(scope: BudgetScope | null | undefined, chars: unknown): number {
  const payloadChars = Number(chars);
  if (!Number.isFinite(payloadChars) || payloadChars <= 0) {
    return 0;
  }
  const charsPerToken = learnedCharsPerToken(scope) ?? CHAR_PER_TOKEN;
  return Math.round(payloadChars / charsPerToken);
}

/** 测试专用：模块级会话状态清零（用例之间不串，同 resetLearnedBudgetsForTests）。 */
export function resetUsageStatsForTests(): void {
  statsByScope.clear();
}
