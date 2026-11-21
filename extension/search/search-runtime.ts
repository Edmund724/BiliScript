import type { NormalizedSearchResult } from "./adapters/types.js";
import { searchCacheClient } from "./search-cache-client.js";
import { executeSearchChain, type PaidSearchFallback } from "./search-chain.js";
import type { ResolveSearchProviderResponse } from "../shared/messaging-protocol.js";

export interface WebSearchRuntime {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<{
    results: NormalizedSearchResult[];
    platform: string;
    downgradedFrom?: string;
    paid?: boolean;
    paidFallback?: PaidSearchFallback;
  }>;
}

export const SEARCH_NOT_CONFIGURED_NOTICE = "未配置搜索平台，本轮未联网";
export const SEARCH_COOLDOWN_NOTICE =
  "搜索平台连续故障，本轮进入冷却稍后自动恢复：可稍后再试，或在设置中手动指定一个平台";

export interface WebSearchRuntimeResolution {
  runtime?: WebSearchRuntime;
  notice?: string;
}

export async function resolveWebSearchRuntime(
  signal?: AbortSignal | null
): Promise<WebSearchRuntimeResolution> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "resolve-search-provider"
    })) as ResolveSearchProviderResponse | null;
    const chain = resp?.ok && Array.isArray(resp.chain) ? resp.chain : [];
    if (chain.length === 0) {
      return {
        notice:
          resp?.chainEmptyReason === "cooldown" ? SEARCH_COOLDOWN_NOTICE : SEARCH_NOT_CONFIGURED_NOTICE
      };
    }
    const maxToolCalls = Number(resp?.maxToolCalls) > 0 ? Number(resp?.maxToolCalls) : 5;
    return {
      runtime: {
        maxToolCalls,
        executeSearch: async (query) => {
          const cached = await searchCacheClient.get(query);
          if (cached) {
            return { results: cached.results, platform: cached.platform };
          }
          const outcome = await executeSearchChain(chain, query, { signal: signal ?? null });
          void searchCacheClient.put({
            query,
            results: outcome.results,
            platform: outcome.platform
          });
          return outcome;
        }
      }
    };
  } catch {
    return { notice: SEARCH_NOT_CONFIGURED_NOTICE };
  }
}
