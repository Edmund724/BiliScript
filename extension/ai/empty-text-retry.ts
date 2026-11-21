import { DEFAULT_MAX_TOKENS } from "./output-budget.js";

export const EMPTY_TEXT_RETRY_MAX_TOKENS = DEFAULT_MAX_TOKENS * 2;

export function isEmptyTextRetryable({ finishReason, hasBody }: { finishReason?: string | null; hasBody: boolean }): boolean {
  if (hasBody) return false;
  return finishReason === undefined ? true : finishReason === "length";
}

export function retryBudget(base?: number): number {
  return base === undefined ? EMPTY_TEXT_RETRY_MAX_TOKENS : Math.min(base * 2, EMPTY_TEXT_RETRY_MAX_TOKENS);
}
