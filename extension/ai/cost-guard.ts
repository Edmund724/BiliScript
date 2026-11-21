export const COST_GUARD_MIN_CALLS = 5;

export function shouldPromptCostGuard(estimatedCalls: unknown): boolean {
  const n = Number(estimatedCalls);
  return Number.isFinite(n) && n >= COST_GUARD_MIN_CALLS;
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
}

interface CostGuardNotice {
  shouldPrompt: boolean;
  message: string;
}

export function buildCostGuardNotice({ estimatedCalls, estimatedTokens }: CostGuardInput = {}): CostGuardNotice {
  if (!shouldPromptCostGuard(estimatedCalls)) {
    return { shouldPrompt: false, message: "" };
  }
  return {
    shouldPrompt: true,
    message: `预计约 ${estimatedCalls} 次调用 / 约 ${formatThousands(estimatedTokens)} token，可取消`
  };
}

export interface RunCostGuardArgs {
  estimatedCalls?: number;
  estimatedTokens?: number;
  ask: (message: string) => Promise<unknown>;
  onDecline: () => void;
  precheck?: () => boolean | void;
  buildNotice?: (input: { estimatedCalls?: number; estimatedTokens?: number }) => CostGuardNotice;
}

export async function runCostGuard({
  estimatedCalls,
  estimatedTokens,
  ask,
  onDecline,
  precheck,
  buildNotice = buildCostGuardNotice
}: RunCostGuardArgs): Promise<boolean> {
  const notice = buildNotice({ estimatedCalls, estimatedTokens });
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
