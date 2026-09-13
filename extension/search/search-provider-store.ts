// extension/search/search-provider-store.ts
// 搜索平台 Provider/Key 的设置存储。列表 CRUD 委托给
// extension/core/provider-store.js 的 createProviderStore（与 AI / ASR 平台
// 存储共用同一工厂）：provider 列表持久化在 chrome.storage.sync，API Key
// 单独存放在 chrome.storage.local，不随列表明文回传（列表只带 hasSavedKey
// 布尔占位）。直接导出绑定好的 searchProviderStore 实例，消费方（background
// 消息路由、后续 tool-loop 的密钥读取）调用实例方法。本模块只与
// chrome.storage 交互，不涉及消息路由。
//
// 与 AI / ASR 平台存储完全隔离：用不同的 storage key（searchProviders /
// searchProviderKeys），不和其它平台混用同一个列表。

import { normalizeSearchProvider } from "./search-provider-normalize.js";
import { createProviderStore } from "../core/provider-store.js";

export const SEARCH_PROVIDER_KEYS_STORAGE = "searchProviderKeys";
export const SEARCH_PROVIDERS_STORAGE = "searchProviders";

export const searchProviderStore = createProviderStore({
  listStorageKey: SEARCH_PROVIDERS_STORAGE,
  keysStorageKey: SEARCH_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeSearchProvider
});
