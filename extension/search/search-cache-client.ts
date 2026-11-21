import { withTimeout } from "../shared/error-helpers.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../shared/messaging-protocol.js";
import type { NormalizedSearchResult } from "./adapters/types.js";

export const SEARCH_CACHE_READ_TIMEOUT_MS = 1000;

export interface SearchCacheEntryView {
  results: NormalizedSearchResult[];
  platform: string;
}

async function searchCacheRequest(
  payload: Omit<SearchCacheMessage, "type">
): Promise<SearchCacheResponse | null> {
  try {
    const pending = chrome.runtime.sendMessage({
      type: "search-cache",
      ...payload
    }) as Promise<SearchCacheResponse>;
    return (await withTimeout(pending, SEARCH_CACHE_READ_TIMEOUT_MS, null)) ?? null;
  } catch {
    return null;
  }
}

export const searchCacheClient = {
  async get(query: string): Promise<SearchCacheEntryView | null> {
    const response = await searchCacheRequest({ op: "get", query });
    if (!response?.ok || response.hit !== true || !response.entry) return null;
    const { results, platform } = response.entry;
    if (!Array.isArray(results) || typeof platform !== "string") return null;
    return { results, platform };
  },

  async put(input: { query: string; results: NormalizedSearchResult[]; platform: string }): Promise<void> {
    await searchCacheRequest({
      op: "put",
      query: input.query,
      results: input.results,
      platform: input.platform
    });
  }
};
