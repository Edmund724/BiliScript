// extension/asr/asr-provider-store.ts
// ASR（语音转写）平台 Provider/Key 的设置存储。
// 列表 CRUD 委托给 extension/core/provider-store.js 的 createProviderStore
// （与 AI 平台存储共用同一工厂）：provider 列表持久化在 chrome.storage.sync，
// API Key 单独存放在 chrome.storage.local，不随列表明文回传（列表只带
// hasSavedKey 布尔占位）。直接导出绑定好的 asrProviderStore 实例，消费方
// （background.js 消息路由、运行时配置处理器）调用实例方法。本模块只与
// chrome.storage 交互，不涉及消息路由。
//
// 与 AI 平台存储完全隔离：用不同的 storage key（asrProviders / asrProviderKeys），
// 不和对话平台混用同一个列表。

import { normalizeAsrProvider, type AsrProvider } from "./asr-provider-normalize.js";
import { createProviderStore } from "../core/provider-store.js";

// 域类型单源：定义在 asr-provider-normalize.js（跟归一化走），此处原样
// 转出，消费方（offscreen、消息协议、设置快照）的 import 路径不变。
export type { AsrProvider } from "./asr-provider-normalize.js";

// ===== ASR 平台列表存储 =====

// 存储键字面量单源（跟随 search-provider-store.ts:16-24 先例）：settings-snapshot
// 的族键面与 onChanged 订阅键面从这两个常量派生，别处不再复写字面量。
export const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
export const ASR_PROVIDERS_STORAGE = "asrProviders";

export const asrProviderStore = createProviderStore<AsrProvider>({
  listStorageKey: ASR_PROVIDERS_STORAGE,
  keysStorageKey: ASR_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAsrProvider
});
