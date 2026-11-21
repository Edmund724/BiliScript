import {
  BUDGET_PARAM_RE,
  INPUT_SIDE_RE,
  normalizeErrorText,
  OVER_LIMIT_RE
} from "./error-text-norms.js";

export const DEFAULT_MAX_TOKENS = 32768;

export const CONSERVATIVE_MAX_TOKENS = 8192;

export function isOutputBudgetTooLarge(detail: unknown): boolean {
  const text = normalizeErrorText(detail);
  if (!text) return false;
  if (INPUT_SIDE_RE.test(text)) return false;
  return BUDGET_PARAM_RE.test(text) && OVER_LIMIT_RE.test(text);
}
