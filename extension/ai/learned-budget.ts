export interface BudgetScope {
  baseUrl?: unknown;
  model?: unknown;
}

const learned = new Map<string, number>();

function normalizeBaseUrl(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function budgetScopeKey(scope: BudgetScope | null | undefined): string {
  return `${normalizeBaseUrl(scope?.baseUrl)}|${String(scope?.model ?? "")}`;
}

export function noteLearnedMaxTokens(scope: BudgetScope | null | undefined, value: number): void {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return;
  }
  learned.set(budgetScopeKey(scope), Math.floor(numeric));
}

export function clampToLearnedMaxTokens(
  requested: number | null,
  scope: BudgetScope | null | undefined
): number | null {
  if (requested == null) {
    return null;
  }
  const cap = learned.get(budgetScopeKey(scope));
  return cap == null ? requested : Math.min(requested, cap);
}

export function canRaiseBudget(
  scope: BudgetScope | null | undefined,
  from: number,
  to: number
): boolean {
  const cap = learned.get(budgetScopeKey(scope)) ?? Infinity;
  return Math.min(to, cap) > Math.min(from, cap);
}

export function resetLearnedBudgetsForTests(): void {
  learned.clear();
}
