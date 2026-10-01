// extension/search/search-chain.ts
// 回退链（spec §1 S1/S4/S6、§2、§3 落点表第 8 行、§4、§6.4、§6.8、§12.1–§12.3、
// §12.5 第 6 行）：
//   ① 纯函数 resolveSearchChain——链解析：进组判据（记录的 presetId 查预设表得
//      access）、两模式排序（单选 = 独苗链、无回退；智能 = 归一 order 序 > 内置默认序）、
//      按 presetId 去重（代表 = 排序最靠前的合格记录）、智能链冷却跳过，产出
//      「有序候选 + 各自 Key」（S4 的单趟回传形状，SW 是唯一知道 Key 的一侧）；
//   ①' 纯函数 normalizeSearchProviderOrder——searchProviderOrder 归一（非数组 /
//      元素非字符串或空串 / 未知 id / 重复 id → 整体作废 []）；
//   ② 执行器 executeSearchChain / classifySearchFailure / SEARCH_CHAIN_BUDGET_MS
//      ——顺序逐候选调一次既有 executeWebSearch（单候选失败静默、分类保序收集）、
//      链级预算 30s 到点主动放弃、调用方中止立即抛出。
// 纯函数纪律：resolveSearchChain 零 Chrome API / 零 DOM / 不改写入参 / 不取时间
// （now 由调用方注入）；Key 只经返回值中转，不进日志。执行器只经 deps.fetchImpl →
// provider-http 出网。
import {
  DEFAULT_SEARCH_PROVIDER_ORDER,
  type SearchProviderPreset,
  type SearchProviderType
} from "../core/presets.js";
import { type SearchMode } from "../core/search-mode.js";
import { executeWebSearch } from "./search-executor.js";
import type { NormalizedSearchResult } from "./adapters/types.js";
import type { SearchProvider } from "./search-provider-normalize.js";

// 链候选（= ResolveSearchProviderResponse.chain 的元素形状，S4 单一形状）：
// presetId 供健康度按引擎（而非记录）记账（spec §12.4 第 1/7 条）。
export interface SearchChainCandidate {
  provider: { id: string; presetId: string; name: string; type: string; baseUrl: string };
  apiKey: string;
}

// 链解析选项（spec §1 S4 第五参）：模式由消费方经 core/search-mode.ts 的
// resolveSearchMode 判定后传入；order / cooldownUntil 是 SW 侧快照的归一产物
// （§12.3 / §12.4 第 6 条）；now 注入以满足纯函数纪律。
export interface SearchChainOptions {
  mode: SearchMode;
  // 用户拖拽顺序（记录 id 数组；键缺席 / 脏值 → 传 [] 或缺省）
  order?: readonly string[] | null;
  // presetId → 冷却截止 epoch ms（只含 cooldownUntil > now 的项）；只对智能链生效
  cooldownUntil?: Record<string, number> | null;
  // 注入时钟（epoch ms）
  now?: number;
}

/**
 * searchProviderOrder 归一（spec §12.2）：整个键要么可信、要么不用——非数组 /
 * 元素非字符串或空串 / 含未知 id（不在当前记录集合中）/ 含重复 id → 返回 []（=
 * 无自定义顺序，回落内置默认序），不部分采纳、不抛错、不上报。
 */
export function normalizeSearchProviderOrder(raw: unknown, knownRecordIds: Iterable<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(knownRecordIds);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") return [];
    if (!known.has(value) || seen.has(value)) return [];
    seen.add(value);
    order.push(value);
  }
  return order;
}

/**
 * 解析回退链：链成员是**记录**（S1），成员资格由记录的 presetId 查预设表得出
 * （§7「只挂预设表，记录不带副本」）：
 *   - 查不到预设表（脏值 / 未知 presetId）→ 不进候选（最保守）；
 *   - 记录须 enabled !== false；
 *   - access === "keyless" 无条件进；access === "free-quota" 仅该记录有 Key 才进；
 *   - 模式（options.mode，spec §12.1）："single" = 只有 activeId 那一条记录（无回退；
 *     悬空 activeId 按空处理走智能链，§6.8）；"smart" = 全部在组记录按
 *     「归一 order 下标 > 内置默认序 DEFAULT_SEARCH_PROVIDER_ORDER」排序（键相同保持
 *     输入序），不在 order 中的记录排到数组内记录之后；
 *   - 按 presetId 去重（裁定②）：同一家只入链一次，代表 = 排序最靠前的合格记录
 *     （含它自己的 Key）；同 presetId 的其余记录不进链、不试第二次；
 *   - 智能链剔除 cooldownUntil[presetId] > now 的引擎（单选不消费冷却，§12.4 第 5 条）；
 *   - keyless 无 Key 时候选的 apiKey 为 ""（适配器据此不产鉴权头）。
 */
export function resolveSearchChain(
  providers: ReadonlyArray<SearchProvider>,
  keys: Record<string, string> | null | undefined,
  activeId: string | null | undefined,
  presets: readonly SearchProviderPreset[],
  options: SearchChainOptions
): SearchChainCandidate[] {
  // presetId → 预设（access）；同 id 重复预设取表内首个
  const presetById = new Map<string, SearchProviderPreset>();
  for (const preset of presets) {
    if (!presetById.has(preset.id)) presetById.set(preset.id, preset);
  }

  const knownIds = new Set(providers.map((record) => record.id));
  const activeRecordId = String(activeId ?? "").trim();
  // 悬空的单选 activeId 按空处理走智能链（spec §6.8）：只有 id 在记录集合中才是单选。
  const mode: SearchMode = options.mode === "single" && knownIds.has(activeRecordId) ? "single" : "smart";
  const order = normalizeSearchProviderOrder(options.order, knownIds);

  // 进组判据 + 候选装配（presetId 一并带出，健康度按引擎记账要用它）
  const qualify = (record: SearchProvider): SearchChainCandidate | null => {
    if (record.enabled === false) return null;
    const presetId = String(record.presetId || "").trim();
    const preset = presetById.get(presetId);
    if (!preset) return null;
    const apiKey = String(keys?.[record.id] ?? "").trim();
    if (preset.access === "free-quota" && !apiKey) return null;
    return {
      provider: {
        id: record.id,
        presetId,
        name: record.name,
        type: record.type,
        baseUrl: record.baseUrl
      },
      apiKey
    };
  };

  // 单选（spec §12.1）：只有该记录一家——它不合格（未配 Key 的 free-quota / 停用 /
  // 未知 presetId）就是空链，调用方走既有「未配置搜索平台」路径（§12.7 第 2 条）。
  if (mode === "single") {
    const record = providers.find((item) => item.id === activeRecordId);
    const candidate = record ? qualify(record) : null;
    return candidate ? [candidate] : [];
  }

  // 智能：排序键规则（spec §12.2）——① 在 order 中的按数组下标；② 不在数组中的排到
  // 所有在数组中的记录之后，相互之间按内置默认序；键相同的保持输入序（稳定排序）。
  const ranked: Array<{ candidate: SearchChainCandidate; orderIndex: number; defaultIndex: number }> = [];
  for (const record of providers) {
    const candidate = qualify(record);
    if (!candidate) continue;
    const orderIndex = order.indexOf(record.id);
    const defaultIndex = DEFAULT_SEARCH_PROVIDER_ORDER.indexOf(candidate.provider.presetId);
    ranked.push({
      candidate,
      orderIndex: orderIndex === -1 ? Number.POSITIVE_INFINITY : orderIndex,
      defaultIndex: defaultIndex === -1 ? DEFAULT_SEARCH_PROVIDER_ORDER.length : defaultIndex
    });
  }
  ranked.sort((a, b) =>
    a.orderIndex !== b.orderIndex ? a.orderIndex - b.orderIndex : a.defaultIndex - b.defaultIndex
  );

  const cooldownUntil = options.cooldownUntil ?? {};
  const now = Number.isFinite(options.now) ? Number(options.now) : 0;
  const seen = new Set<string>();
  const chain: SearchChainCandidate[] = [];
  for (const { candidate } of ranked) {
    const presetId = candidate.provider.presetId;
    // 同 presetId 只入链一次，代表 = 排序最靠前的合格记录（裁定②）
    if (seen.has(presetId)) continue;
    seen.add(presetId);
    // 冷却按 presetId 判（不按记录 id）；过滤后为空也如实返回空链（§12.7 第 6 条）
    if (Number(cooldownUntil[presetId] ?? 0) > now) continue;
    chain.push(candidate);
  }
  return chain;
}

// ===== 执行器（spec §4 / §6.4 / §3 落点表第 8 行②）=====

// 链级预算（spec §4）：由链持有、按「单次搜索调用」计。算术依据 = 最坏现实成功
// 路径「首家吃满 15s + 第二家正常 ≈5.5s」≈21s 必须容得下；无预算时最坏 6×15s=90s。
export const SEARCH_CHAIN_BUDGET_MS = 30000;

// 整链无果且额度类在列时的终态文案（spec §6.4 唯一映射表第 ① 行）。
export const SEARCH_QUOTA_MESSAGE =
  "搜索额度已用尽：可稍后再试，或在设置中为搜索平台配置 API Key 提升额度";

// 失败三等（spec §6.4）：额度 / 鉴权 / 其余。鉴权类不单开终态文案（走其余类）。
export type SearchFailureClass = "quota" | "auth" | "other";

// 首个成功即返回的产物：platform = 实际产出结果的引擎名；成功家不是链首时
// downgradedFrom = 链首 provider.name（模型侧降级注记的输入，已接线于
// ai/tool-loop.ts 的降级注记行）。
export interface SearchChainOutcome {
  results: NormalizedSearchResult[];
  platform: string;
  downgradedFrom?: string;
}

// 整链无果抛出的错误：failures 是**保序保留**的分类列表（不塌成字符串），
// searchFailureClass 是决定终态文案的那一类。
export interface SearchChainError extends Error {
  searchFailureClass: SearchFailureClass;
  failures: SearchFailureClass[];
}

export interface ExecuteSearchChainDeps {
  // 缺省 executeWebSearch（provider-http 通道，SW 代发）；测试注入桩。
  execute?: (
    candidate: SearchChainCandidate,
    query: string,
    signal?: AbortSignal | null
  ) => Promise<{ results: NormalizedSearchResult[]; platform: string }>;
  fetchImpl?: typeof fetch;
  // 调用方中止信号（聊天 abort controller / 解释卡中止器）：中止即抛出、不试下一家。
  signal?: AbortSignal | null;
}

const QUOTA_HTTP_STATUSES = new Set([402, 429]);
const AUTH_HTTP_STATUSES = new Set([401, 403]);
// 豆包 HTTP 200 信封码（spec §6.4；票 11 裁定 700901/10403 归鉴权类，覆盖票 08）。
const QUOTA_PROVIDER_CODES = new Set(["10406", "10407", "700429"]);
const AUTH_PROVIDER_CODES = new Set(["700901", "10403"]);

/**
 * 失败分类（spec §6.4 唯一映射表）：输入 = 带 `status?: number` 与
 * `providerCode?: string` 的 Error（search-executor 的 `HTTP <status>`；
 * 豆包适配器的 200 信封码）。码按字符串比对，数字也认；其余一律归「其余类」
 * （超时 / 网络 / 5xx / 形状 4xx / 解析失败）。
 */
export function classifySearchFailure(error: unknown): SearchFailureClass {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  if (Number.isFinite(status)) {
    if (QUOTA_HTTP_STATUSES.has(status)) return "quota";
    if (AUTH_HTTP_STATUSES.has(status)) return "auth";
  }
  const providerCode = String(
    (error as { providerCode?: unknown } | null | undefined)?.providerCode ?? ""
  ).trim();
  if (QUOTA_PROVIDER_CODES.has(providerCode)) return "quota";
  if (AUTH_PROVIDER_CODES.has(providerCode)) return "auth";
  return "other";
}

// 中止形状与 provider-http 的 makeAbortError 一致（tool-loop 据 name 判中止）。
function makeSearchAbortError(): Error {
  const error = new Error("请求已中止");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    (error as { aborted?: unknown } | null | undefined)?.aborted === true ||
    (error as { name?: unknown } | null | undefined)?.name === "AbortError"
  );
}

// 整链无果的错误装配：额度类在列 → 额度文案；否则沿用最后一个错误的既有文案
// （「HTTP 503」等，供 tool-loop 的「联网搜索失败：<原因>」沿用）。
function createSearchChainError(
  failures: SearchFailureClass[],
  lastError: unknown,
  budgetExpired: boolean
): SearchChainError {
  const terminal: SearchFailureClass = failures.includes("quota")
    ? "quota"
    : failures.length > 0
      ? failures[failures.length - 1]
      : "other";
  const lastMessage =
    lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "";
  const fallback = budgetExpired ? "搜索超时" : "搜索失败：无可用搜索平台";
  const message = terminal === "quota" ? SEARCH_QUOTA_MESSAGE : lastMessage || fallback;
  return Object.assign(new Error(message), {
    searchFailureClass: terminal,
    failures: failures.slice()
  });
}

function defaultChainExecute(deps: ExecuteSearchChainDeps) {
  const fetchDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined;
  return (candidate: SearchChainCandidate, query: string, signal?: AbortSignal | null) =>
    executeWebSearch(
      {
        type: candidate.provider.type as SearchProviderType,
        baseUrl: candidate.provider.baseUrl,
        apiKey: candidate.apiKey
      },
      query,
      fetchDeps,
      signal ?? null
    );
}

/**
 * 链执行（spec §4）：顺序逐候选调一次既有 executeWebSearch——单候选失败**静默**
 * （不上 notice、不进 tool 结果），失败经 classifySearchFailure 保序收集；首个成功
 * 即返回（带 platform 与实际降级来源）；链级预算 30s 到点主动放弃（真中止在飞候选）
 * 并如实报失败；调用方 AbortSignal 中止立即抛出（不写缓存、不上 notice）。
 */
export async function executeSearchChain(
  candidates: readonly SearchChainCandidate[],
  query: string,
  deps: ExecuteSearchChainDeps = {}
): Promise<SearchChainOutcome> {
  const externalSignal = deps.signal ?? null;
  if (externalSignal?.aborted) {
    throw makeSearchAbortError();
  }
  const execute = deps.execute ?? defaultChainExecute(deps);
  const headName = candidates.length > 0 ? candidates[0].provider.name : "";
  const failures: SearchFailureClass[] = [];
  // 内部控制器：预算到点真中止在飞候选；调用方中止经外部 signal 转发过来。
  const controller = new AbortController();
  let lastError: unknown = null;
  let budgetExpired = false;
  let budgetError: SearchChainError | null = null;

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetDeadline = new Promise<never>((_resolve, reject) => {
    budgetTimer = setTimeout(() => {
      budgetExpired = true;
      controller.abort();
      budgetError = createSearchChainError(failures, lastError, true);
      reject(budgetError);
    }, SEARCH_CHAIN_BUDGET_MS);
  });

  const run = async (): Promise<SearchChainOutcome> => {
    for (let index = 0; index < candidates.length; index += 1) {
      if (externalSignal?.aborted) throw makeSearchAbortError();
      try {
        const outcome = await execute(candidates[index], query, controller.signal);
        return index > 0 && headName
          ? { results: outcome.results, platform: outcome.platform, downgradedFrom: headName }
          : { results: outcome.results, platform: outcome.platform };
      } catch (error) {
        // 预算到点：中止由预算造成，不再试下一家（最后一类的错误留待终态文案）。
        if (budgetExpired) break;
        if (externalSignal?.aborted || isAbortError(error)) throw error;
        lastError = error;
        failures.push(classifySearchFailure(error));
      }
    }
    if (externalSignal?.aborted) throw makeSearchAbortError();
    throw createSearchChainError(failures, lastError, budgetExpired);
  };

  try {
    return await Promise.race([run(), budgetDeadline]);
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    if (budgetExpired) throw budgetError ?? createSearchChainError(failures, lastError, true);
    throw error;
  } finally {
    clearTimeout(budgetTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
