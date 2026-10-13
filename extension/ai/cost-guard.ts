// 「成本护栏」模块：
// 发起 Map-Reduce 前，若预估调用数 ≥COST_GUARD_MIN_CALLS 应向用户弹护栏提示
// 「预计约 N 次调用 / 约 X token，可取消」。预算内单次（=1 次调用）永不触发。
// 判定与文案由 buildCostGuardNotice 单源给出（阈值常量 + 纯函数，可直接复用预算器
// plan.estimatedCalls / plan.estimatedTokens）；护栏顺序（预估 → 判定 → 询问 → 拒绝）
// 由 runCostGuard 单源承担——两条链各注入自己的 ask（确认钩子）与 onDecline
// （拒绝出口：阶梯链回包 stopped、概览链抛 cancelled），出口形状不进本模块。

// 触发阈值：预估 ≥5 次调用才弹护栏。
export const COST_GUARD_MIN_CALLS = 5;

/**
 * 是否应弹成本护栏：estimatedCalls 为 ≥5 的有限数 → true；非数 / 负 / <5 → false。
 */
export function shouldPromptCostGuard(estimatedCalls: unknown): boolean {
  const n = Number(estimatedCalls);
  return Number.isFinite(n) && n >= COST_GUARD_MIN_CALLS;
}

/**
 * 千分位格式化数字（如 1234567 → "1,234,567"）；非有限值回落到 "0"。
 */
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

/**
 * 构建成本护栏通知：{ shouldPrompt, message }。
 * message 形如「预计约 N 次调用 / 约 X token，可取消」（X 千分位）；
 * 与 shouldPromptCostGuard 同判，shouldPrompt 为 false 时 message 为空串。
 */
export function buildCostGuardNotice({ estimatedCalls, estimatedTokens }: CostGuardInput = {}): CostGuardNotice {
  if (!shouldPromptCostGuard(estimatedCalls)) {
    return { shouldPrompt: false, message: "" };
  }
  return {
    shouldPrompt: true,
    message: `预计约 ${estimatedCalls} 次调用 / 约 ${formatThousands(estimatedTokens)} token，可取消`
  };
}

/** 护栏事务的注入出口：调用方只提供「怎么问」与「拒了怎么收」，判定与顺序留在事务内。 */
export interface RunCostGuardArgs {
  /** 预估调用数：判定输入（阈值见 shouldPromptCostGuard）。 */
  estimatedCalls?: number;
  /** 预估 token 数字：纯展示，不参与判定。 */
  estimatedTokens?: number;
  /** 确认钩子：仅在应弹护栏时调用一次，解析值为真即「已确认」。 */
  ask: (message: string) => Promise<unknown>;
  /** 拒绝出口：未确认时调用一次；由调用方在自己的链路里收束（回包 / 抛错）。 */
  onDecline: () => void;
  /** 前置条件钩子：返回真值表示本次不参与护栏（询问前短路，ask 与 onDecline 都不执行）；
   *  可抛错以表达调用链自身的中止语义。 */
  precheck?: () => boolean | void;
  /** 通知构建（默认 buildCostGuardNotice）：注入只为保住调用方既有的注入缝。 */
  buildNotice?: (input: { estimatedCalls?: number; estimatedTokens?: number }) => CostGuardNotice;
}

/**
 * 成本护栏事务：预估 → 判定 → 询问 → 拒绝，顺序只有这一份实现。
 * 返回是否被拒绝：true = 未确认且 onDecline 已执行；false = 放行（未达阈值 /
 * 前置短路 / 已确认）。未达阈值与前置短路都不询问、也不调 onDecline。
 */
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
