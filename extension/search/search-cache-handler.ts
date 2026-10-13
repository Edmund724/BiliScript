// 查询缓存 SW 端消息 handler（arch-review-2026-09/08）：宿主是 SW（offscreen 无
// chrome.storage），offscreen 工具循环与 content 侧选区解释卡都经 `search-cache`
// 消息族读写，本 handler 直调 ./search-cache.js 单源——归一（trim + 空白折叠 +
// toLowerCase）与 64 位哈希键都在那一侧完成，调用方不拼键。
// 来源守卫：本族**不得**进来源名单（协议层 OFFSCREEN_ONLY_MESSAGE_TYPES，注册表
// 逐条 sender 标签派生）——本族发送者含 content（reader/explain-card.ts 与
// offscreen 工具循环共用 search/search-runtime.ts）。
// 本模块只有本族的声明（type / op 表 / 未知 op 文案）与两个 op 分支体；handler 壳
// 与 withOkResponse 信封单源在 core/storage-message-family.ts 的存储消息族工厂，
// 组合根只登记工厂实例。

import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import { getSearchCacheEntry, putSearchCacheEntry } from "./search-cache.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../shared/messaging-protocol.js";

// 回包形参按本条消息收型（查询缓存响应形状），返回 void——search-cache 登记为 async，
// 回包时机归注册表 reply、入口 resolveReplyKeepOpen 兑现。
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
