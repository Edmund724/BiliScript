// ai/learned-budget.ts — 会话内存级的「平台学到的输出上限」（叶子模块：零 import，
// SW 与 content 两侧静态图都安全）。
//
// 由来：宽兜底（output-budget.ts 的 DEFAULT_MAX_TOKENS）会被上限低的平台按超上限
// 拒收，completion 的唯一 fetch 点退回保守值重发一次——这一次往返是必要成本，但不该
// 每个请求都付：概览分段路径一次运行有 N+1 次调用，对话每轮都要重来。本模块只做
// 一件事：记住「退回保守值之后仍然成功」这个事实，同平台（baseUrl + model）的后续
// 请求把生效上限夹到学到的值，不再先撞一次 400。
//
// 纪律：
// - 只在「退回后仍然成功」时写入——拿一次失败去压低上限，会把偶发错误（限流/网关
//   抽风/判据误判）固化成整会话策略；
// - 只夹低不抬高：min(请求值, 学到的值)；
// - 请求值为 null（协议本来不发这个字段，如 openai 未指定时）保持 null——学到的值
//   不得把字段变出来；
// - 作用域是 (baseUrl, model)，不含 protocol：输出上限是「平台×模型」属性，不是线
//   格式属性（判断与 ai/model-catalog.ts 的「protocol 不参与查表」同源）；
// - 纯内存、无持久化：SW 重启即清零，不进任何存储 schema。

export interface BudgetScope {
  baseUrl?: unknown;
  model?: unknown;
}

const learned = new Map<string, number>();

function normalizeBaseUrl(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/** 作用域键：baseUrl 去尾斜杠 + model；缺字段归一为空串（不抛错）。 */
export function budgetScopeKey(scope: BudgetScope | null | undefined): string {
  return `${normalizeBaseUrl(scope?.baseUrl)}|${String(scope?.model ?? "")}`;
}

/** 记下「这个值平台收下了」——只应由「退回保守值后仍然成功」的唯一调用点写入。 */
export function noteLearnedMaxTokens(scope: BudgetScope | null | undefined, value: number): void {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return;
  }
  learned.set(budgetScopeKey(scope), Math.floor(numeric));
}

/** 生效上限：请求值为 null 保持 null（不发字段的协议不因学过什么就发字段）。 */
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

/**
 * 抬高预算值不值得发：`to` 相对 `from` 是否真能变宽。学到的上限已经压在两值或
 * `from` 之下时为 false——此时「加倍重跑」会发出一个与上一次完全相同的请求
 * （概览的截断/空正文重跑据此跳过，省一次白花的调用与等待）。
 */
export function canRaiseBudget(
  scope: BudgetScope | null | undefined,
  from: number,
  to: number
): boolean {
  const cap = learned.get(budgetScopeKey(scope)) ?? Infinity;
  return Math.min(to, cap) > Math.min(from, cap);
}

/** 测试专用：模块级会话状态清零（用例之间不串，见 chat-state 的同类导出）。 */
export function resetLearnedBudgetsForTests(): void {
  learned.clear();
}
