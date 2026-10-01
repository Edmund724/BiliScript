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
// 用户拖拽的搜索顺序（spec §12.3）：`chrome.storage.sync` 上的**记录 id 数组**
// （粒度 = 记录级，不是 presetId），与 searchProviders 同侧。**无默认值**——键缺席
// = 无自定义顺序；不进 DEFAULT_SETTINGS / save-settings 白名单（否则
// initializeSettingsStorage 会把「删除该键」重建成 []，「恢复默认顺序」失效）。
// 面板拖拽落点直写 sync，恢复默认 = sync.remove（UI 侧接线）；本模块只提供字面量单源，
// 列表 CRUD（loadProviders / saveProviders / deleteProvider）不碰该键。
export const SEARCH_PROVIDER_ORDER_STORAGE = "searchProviderOrder";

export const searchProviderStore = createProviderStore({
  listStorageKey: SEARCH_PROVIDERS_STORAGE,
  keysStorageKey: SEARCH_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeSearchProvider
});
