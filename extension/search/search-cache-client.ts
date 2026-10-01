// extension/search/search-cache-client.ts
// 查询缓存发送方 proxy（spec §5 / §3 落点表第 9 行）：offscreen / content 可 import
// 的纯 runtime 消息侧（offscreen 无 chrome.storage；content 不设「直读」第二路径）。
// 形态照 ai/segment-cache-proxy.ts:27-39 的 op 判别式 + 容错回包——键位归一与哈希
// 在 SW 叶单源完成，调用方只传原始 query。
// 容错口径（缓存绝不影响回答）：读软超时 1000ms、读失败 / 无回包按未命中（null）；
// 写失败静默 no-op；两者都不上 notice、不改回答内容、不抛。
import { withTimeout } from "../shared/error-helpers.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../shared/messaging-protocol.js";
import type { NormalizedSearchResult } from "./adapters/types.js";

// 读软超时（spec §5「容错口径」）：SW 无回包/挂住时按未命中继续，不拖住回答。
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
  // 命中返回 { results, platform }；未命中 / 读失败 / 回包形状非法 → null。
  async get(query: string): Promise<SearchCacheEntryView | null> {
    const response = await searchCacheRequest({ op: "get", query });
    if (!response?.ok || response.hit !== true || !response.entry) return null;
    const { results, platform } = response.entry;
    if (!Array.isArray(results) || typeof platform !== "string") return null;
    return { results, platform };
  },

  // 写失败静默 no-op（含软超时）：调用方不必等待结果。
  async put(input: { query: string; results: NormalizedSearchResult[]; platform: string }): Promise<void> {
    await searchCacheRequest({
      op: "put",
      query: input.query,
      results: input.results,
      platform: input.platform
    });
  }
};
