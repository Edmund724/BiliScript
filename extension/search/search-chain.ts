import { type SearchProviderPreset } from "../core/presets.js";
import { makeAbortError } from "../core/provider-http-shared.js";
import { isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import { type SearchMode } from "../core/search-mode.js";
import type { SearchChainCandidate } from "../shared/messaging-protocol.js";
import { normalizeSearchProviderOrder, providerOrderRank } from "./search-order.js";
import { executeWebSearch } from "./search-executor.js";
import { recordSearchAttempt } from "./search-health-client.js";
import type { NormalizedSearchResult } from "./adapters/types.js";
import type { SearchProvider } from "./search-provider-normalize.js";

export type { SearchChainCandidate };

export interface SearchChainOptions {
  mode: SearchMode;
  order?: readonly string[] | null;
  cooldownUntil?: Record<string, number> | null;
  allowPaid?: boolean;
  paidKeys?: Record<string, string> | null;
  now?: number;
}

export interface SearchChainResolution {
  chain: SearchChainCandidate[];
  emptyCause?: "cooldown";
}

export function resolveSearchChain(
  providers: ReadonlyArray<SearchProvider>,
  keys: Record<string, string> | null | undefined,
  activeId: string | null | undefined,
  presets: readonly SearchProviderPreset[],
  options: SearchChainOptions
): SearchChainResolution {
  const presetById = new Map<string, SearchProviderPreset>();
  for (const preset of presets) {
    if (!presetById.has(preset.id)) presetById.set(preset.id, preset);
  }

  const knownIds = new Set(providers.map((record) => record.id));
  const activeRecordId = String(activeId ?? "").trim();
  const mode: SearchMode = options.mode === "single" && knownIds.has(activeRecordId) ? "single" : "smart";
  const order = normalizeSearchProviderOrder(options.order, knownIds);

  const qualify = (record: SearchProvider): SearchChainCandidate | null => {
    if (record.enabled === false) return null;
    const presetId = String(record.presetId || "").trim();
    const preset = presetById.get(presetId);
    if (!preset) return null;
    let apiKey = String(keys?.[record.id] ?? "").trim();
    if (preset.access === "paid") {
      if (mode === "smart" && options.allowPaid !== true) return null;
      apiKey = String(options.paidKeys?.[presetId] ?? "").trim();
      if (!apiKey) return null;
    } else if (preset.access === "free-quota" && !apiKey) {
      return null;
    }
    return {
      provider: {
        id: record.id,
        presetId,
        name: record.name,
        type: record.type,
        baseUrl: record.baseUrl,
        access: preset.access
      },
      apiKey
    };
  };

  if (mode === "single") {
    const record = providers.find((item) => item.id === activeRecordId);
    const candidate = record ? qualify(record) : null;
    return { chain: candidate ? [candidate] : [] };
  }

  const ranked: Array<{ candidate: SearchChainCandidate; orderIndex: number; defaultIndex: number }> = [];
  for (const record of providers) {
    const candidate = qualify(record);
    if (!candidate) continue;
    const [orderIndex, defaultIndex] = providerOrderRank(record.id, candidate.provider.presetId, order);
    ranked.push({ candidate, orderIndex, defaultIndex });
  }
  ranked.sort((a, b) =>
    a.orderIndex !== b.orderIndex ? a.orderIndex - b.orderIndex : a.defaultIndex - b.defaultIndex
  );

  const cooldownUntil = options.cooldownUntil ?? {};
  const now = Number.isFinite(options.now) ? Number(options.now) : 0;
  const seen = new Set<string>();
  const chain: SearchChainCandidate[] = [];
  let cooledFiltered = false;
  for (const { candidate } of ranked) {
    const presetId = candidate.provider.presetId;
    if (seen.has(presetId)) continue;
    seen.add(presetId);
    if (Number(cooldownUntil[presetId] ?? 0) > now) {
      cooledFiltered = true;
      continue;
    }
    chain.push(candidate);
  }
  return chain.length === 0 && cooledFiltered ? { chain, emptyCause: "cooldown" } : { chain };
}

export const SEARCH_CHAIN_BUDGET_MS = 30000;

export const SEARCH_QUOTA_MESSAGE =
  "搜索额度已用尽：可稍后再试，或在设置中为搜索平台配置 API Key 提升额度";

export type SearchFailureClass = "quota" | "auth" | "other";

export interface SearchChainOutcome {
  results: NormalizedSearchResult[];
  platform: string;
  downgradedFrom?: string;
  paid?: boolean;
  paidFallback?: PaidSearchFallback;
}

export interface PaidSearchFallback {
  platform: string;
  reason: PaidFallbackReason;
  fallbackTo: string;
}

export type PaidFallbackReason = "balance" | "rate-limit" | "timeout";

export function formatPaidFallbackNotice(fallback: PaidSearchFallback): string {
  const reasonText =
    fallback.reason === "balance" ? "余额不足" : fallback.reason === "rate-limit" ? "已达限速" : "请求超时";
  return `${fallback.platform} 搜索不可用（${reasonText}），已回退至 ${fallback.fallbackTo}`;
}

function paidFallbackReason(error: unknown): PaidFallbackReason {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  if (status === 402) return "balance";
  if (status === 429) return "rate-limit";
  return "timeout";
}

export interface SearchChainError extends Error {
  searchFailureClass: SearchFailureClass;
  failures: SearchFailureClass[];
}

export interface ExecuteSearchChainDeps {
  execute?: (
    candidate: SearchChainCandidate,
    query: string,
    signal?: AbortSignal | null
  ) => Promise<{ results: NormalizedSearchResult[]; platform: string }>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | null;
  recordAttempt?: (presetId: string, ok: boolean, latencyMs: number) => void | Promise<void>;
  nowMs?: () => number;
}

const QUOTA_HTTP_STATUSES = new Set([402, 429]);
const AUTH_HTTP_STATUSES = new Set([401, 403]);
const QUOTA_PROVIDER_CODES = new Set(["10406", "10407", "700429"]);
const AUTH_PROVIDER_CODES = new Set(["700901", "10403"]);

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

function isAbortError(error: unknown): boolean {
  return isAbortedMarkerError(error) || isAbortNamedError(error);
}

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
        type: candidate.provider.type,
        baseUrl: candidate.provider.baseUrl,
        apiKey: candidate.apiKey
      },
      query,
      fetchDeps,
      signal ?? null
    );
}

export async function executeSearchChain(
  candidates: readonly SearchChainCandidate[],
  query: string,
  deps: ExecuteSearchChainDeps = {}
): Promise<SearchChainOutcome> {
  const externalSignal = deps.signal ?? null;
  if (externalSignal?.aborted) {
    throw makeAbortError();
  }
  const execute = deps.execute ?? defaultChainExecute(deps);
  const nowMs = deps.nowMs ?? Date.now;
  const recordAttempt = deps.recordAttempt ?? recordSearchAttempt;
  const noteAttempt = (presetId: string, ok: boolean, latencyMs: number): void => {
    try {
      const pending: unknown = recordAttempt(presetId, ok, Math.max(0, latencyMs));
      if (typeof (pending as Promise<void> | null | undefined)?.catch === "function") {
        void (pending as Promise<void>).catch(() => {});
      }
    } catch {
    }
  };
  const headName = candidates.length > 0 ? candidates[0].provider.name : "";
  const failures: SearchFailureClass[] = [];
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
    const paidFailures: Array<{ name: string; error: unknown }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (externalSignal?.aborted) throw makeAbortError();
      const candidate = candidates[index];
      const presetId = candidate.provider.presetId;
      const startedAt = nowMs();
      try {
        const outcome = await execute(candidate, query, controller.signal);
        noteAttempt(presetId, true, nowMs() - startedAt);
        const paid = candidate.provider.access === "paid";
        const paidFallback = paidFailures.length
          ? {
              platform: paidFailures[0].name,
              reason: paidFallbackReason(paidFailures[0].error),
              fallbackTo: outcome.platform
            }
          : undefined;
        const base =
          index > 0 && headName
            ? { results: outcome.results, platform: outcome.platform, downgradedFrom: headName }
            : { results: outcome.results, platform: outcome.platform };
        return paid || paidFallback ? { ...base, ...(paid ? { paid: true } : {}), ...(paidFallback ? { paidFallback } : {}) } : base;
      } catch (error) {
        if (externalSignal?.aborted) throw error;
        if (!budgetExpired && isAbortError(error)) throw error;
        noteAttempt(presetId, false, nowMs() - startedAt);
        if (candidate.provider.access === "paid") {
          paidFailures.push({ name: candidate.provider.name, error });
        }
        if (budgetExpired) break;
        lastError = error;
        failures.push(classifySearchFailure(error));
      }
    }
    if (externalSignal?.aborted) throw makeAbortError();
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
