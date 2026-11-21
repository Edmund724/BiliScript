import { CHAR_PER_TOKEN } from "./budgeter.js";
import { budgetScopeKey, type BudgetScope } from "./learned-budget.js";

const SAMPLE_WINDOW = 8;

export interface UsageSampleInput {
  payloadChars?: number;
  inputTokens?: number;
}

const RATIO_MIN = 0.2;
const RATIO_MAX = 20;

interface ScopeStats {
  ratios: number[];
}

const statsByScope = new Map<string, ScopeStats>();

function statsOf(scope: BudgetScope | null | undefined): ScopeStats | undefined {
  return statsByScope.get(budgetScopeKey(scope));
}

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

  statsByScope.set(key, stats);
}

export function learnedCharsPerToken(scope: BudgetScope | null | undefined): number | undefined {
  const ratios = statsOf(scope)?.ratios;
  if (!ratios?.length) {
    return undefined;
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimateTokensFromChars(scope: BudgetScope | null | undefined, chars: unknown): number {
  const payloadChars = Number(chars);
  if (!Number.isFinite(payloadChars) || payloadChars <= 0) {
    return 0;
  }
  const charsPerToken = learnedCharsPerToken(scope) ?? CHAR_PER_TOKEN;
  return Math.round(payloadChars / charsPerToken);
}

export function resetUsageStatsForTests(): void {
  statsByScope.clear();
}
