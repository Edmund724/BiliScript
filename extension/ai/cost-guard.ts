export const COST_GUARD_MIN_CALLS = 12;
export const COST_GUARD_MIN_TOKENS = 100_000;
export const COST_GUARD_HIGH_TOKENS = 200_000;

export function shouldPromptCostGuard(estimatedCalls: unknown, estimatedTokens?: unknown): boolean {
  const calls = Number(estimatedCalls);
  if (!Number.isFinite(calls) || calls < 2) {
    return false;
  }
  if (estimatedTokens === undefined || estimatedTokens === null || estimatedTokens === "") {
    return calls >= COST_GUARD_MIN_CALLS;
  }
  const tokens = Number(estimatedTokens);
  if (!Number.isFinite(tokens)) {
    return calls >= COST_GUARD_MIN_CALLS;
  }
  return (calls >= COST_GUARD_MIN_CALLS && tokens >= COST_GUARD_MIN_TOKENS) || tokens >= COST_GUARD_HIGH_TOKENS;
}

function formatThousands(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const [intPart, fracPart] = String(Math.trunc(Math.abs(n))).split(".");
  const digits = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = n < 0 ? "-" : "";
  return fracPart ? `${sign}${digits}.${fracPart}` : `${sign}${digits}`;
}

interface CostGuardInput {
  estimatedCalls?: number | string;
  estimatedTokens?: number | string;
  taskLabel?: string;
}

interface CostGuardNotice {
  shouldPrompt: boolean;
  message: string;
}

export function buildCostGuardNotice({ estimatedCalls, estimatedTokens, taskLabel }: CostGuardInput = {}): CostGuardNotice {
  if (!shouldPromptCostGuard(estimatedCalls, estimatedTokens)) {
    return { shouldPrompt: false, message: "" };
  }
  const label = String(taskLabel ?? "").trim();
  const prefix = label ? `${label}预计约` : "预计约";
  return {
    shouldPrompt: true,
    message: `${prefix} ${estimatedCalls} 次调用 / 约 ${formatThousands(estimatedTokens)} token，可取消`
  };
}

export interface RunCostGuardArgs {
  estimatedCalls?: number;
  estimatedTokens?: number;
  taskLabel?: string;
  ask: (message: string) => Promise<unknown>;
  onDecline: () => void;
  precheck?: () => boolean | void;
}

export async function runCostGuard({
  estimatedCalls,
  estimatedTokens,
  taskLabel,
  ask,
  onDecline,
  precheck
}: RunCostGuardArgs): Promise<boolean> {
  const notice = buildCostGuardNotice({ estimatedCalls, estimatedTokens, taskLabel });
  if (!notice.shouldPrompt) {
    return false;
  }
  if (precheck?.()) {
    return false;
  }
  if (Boolean(await ask(notice.message))) {
    return false;
  }
  onDecline();
  return true;
}
