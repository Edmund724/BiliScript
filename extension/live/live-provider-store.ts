// extension/live/live-provider-store.ts
// MOSS-LIVE 伴看平台的 Provider/Key 存储。
// 复用 extension/core/provider-store.ts 工厂：
// 平台列表存储在 chrome.storage.sync，API Key 存储在 chrome.storage.local。

import { createProviderStore } from "../core/provider-store.js";
import { normalizeLiveProvider, resolveActiveLiveProviderId, type LiveProvider } from "./live-provider-normalize.js";

export { resolveActiveLiveProviderId };
export type { LiveProvider } from "./live-provider-normalize.js";

export const LIVE_PROVIDERS_STORAGE = "liveProviders";
export const LIVE_PROVIDER_KEYS_STORAGE = "liveProviderKeys";

export interface LiveProviderPreset {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  note?: string;
}

export const LIVE_PROVIDER_PRESETS: readonly LiveProviderPreset[] = [
  {
    id: "moss-live",
    name: "MOSS-LIVE",
    type: "moss-live",
    baseUrl: "https://api.mosi.cn",
    model: "moss-live-1.0",
    requiresKey: true,
    note: "MOSS-LIVE 1.0 全双工实时语音伴看"
  }
];

export const liveProviderStore = createProviderStore<LiveProvider>({
  listStorageKey: LIVE_PROVIDERS_STORAGE,
  keysStorageKey: LIVE_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeLiveProvider
});
