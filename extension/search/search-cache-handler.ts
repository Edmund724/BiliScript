import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import { getSearchCacheEntry, putSearchCacheEntry } from "./search-cache.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../shared/messaging-protocol.js";

export function createSearchCacheHandler(): (
  message: SearchCacheMessage,
  sender: unknown,
  sendResponse: (response: SearchCacheResponse) => void
) => void {
  return defineStorageMessageFamily<SearchCacheMessage, SearchCacheResponse>({
    type: "search-cache",
    unknownOpText: "不支持的搜索缓存操作：",
    ops: {
      get: async (message) => {
        const entry = await getSearchCacheEntry(message.query);
        return entry
          ? { ok: true, hit: true, entry: { results: entry.results, platform: entry.platform } }
          : { ok: true, hit: false };
      },
      put: async (message) => {
        await putSearchCacheEntry(message.query, {
          results: Array.isArray(message.results) ? message.results : [],
          platform: String(message.platform ?? "")
        });
        return { ok: true };
      }
    }
  });
}
