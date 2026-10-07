// 查询缓存 SW 端消息 handler（arch-review-2026-09/08）：宿主是 SW（offscreen 无
// chrome.storage），offscreen 工具循环与 content 侧选区解释卡都经 `search-cache`
// 消息族读写，本 handler 直调 ./search-cache.js 单源——归一（trim + 空白折叠 +
// toLowerCase）与 64 位哈希键都在那一侧完成，调用方不拼键。
// 来源守卫：本族**不得**进 illegalMessageReason 的 offscreen-only 名单——本族发送者
// 含 content（reader/explain-card.ts 与 offscreen 工具循环共用 search/search-runtime.ts）。
// handler 工厂形态照 ai/segment-cache-handler.ts 先例（core/provider-handlers.ts
// 的 withOkResponse 收口异步错误回包）：handler 本体住域 module，组合根只登记与
// 注入实例。

import { withOkResponse } from "../core/provider-handlers.js";
import { getSearchCacheEntry, putSearchCacheEntry } from "./search-cache.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../shared/messaging-protocol.js";

// 回包形参按本条消息收型（查询缓存响应形状），返回 void——search-cache 登记为 async，
// 回包时机归注册表 reply、入口 resolveReplyKeepOpen 兑现。
export function createSearchCacheHandler(): (
  message: SearchCacheMessage,
  sender: unknown,
  sendResponse: (response: SearchCacheResponse) => void
) => void {
  return function handleSearchCache(
    message: SearchCacheMessage,
    _sender: unknown,
    sendResponse: (response: SearchCacheResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        if (message.op === "get") {
          const entry = await getSearchCacheEntry(message.query);
          return entry
            ? { ok: true, hit: true, entry: { results: entry.results, platform: entry.platform } }
            : { ok: true, hit: false };
        }
        if (message.op === "put") {
          await putSearchCacheEntry(message.query, {
            results: Array.isArray(message.results) ? message.results : [],
            platform: String(message.platform ?? "")
          });
          return { ok: true };
        }
        throw new Error("不支持的搜索缓存操作：" + String((message as { op?: unknown }).op));
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
  };
}
