// extension/live/live-provider-store.ts
// 实时伴看平台的 Provider/Key 存储、归一化与预设定义。
// 平台列表存储在 chrome.storage.sync，自有 API Key 存储在 chrome.storage.local。

import { normalizeBaseUrl } from "../core/presets.js";
import { createProviderStore } from "../core/provider-store.js";

export const LIVE_PROVIDERS_STORAGE = "liveProviders";
export const LIVE_PROVIDER_KEYS_STORAGE = "liveProviderKeys";
export const DEFAULT_LIVE_MODEL = "moss-live-1.0";
export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.8-live";
export const GEMINI_LIVE_FALLBACK_MODELS = [
  GEMINI_LIVE_DEFAULT_MODEL,
  "gemini-2.5-flash-native-audio-preview-12-2025"
] as const;

const LIVE_PROVIDER_TYPES = new Set(["moss-live", "gemini-live"]);

export interface LiveProvider {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  apiKey?: string;
  liveGeminiNativeSearch?: boolean;
  // 会话音色（仅 MOSS-LIVE）：音色列表返回的 voice id，空/缺省 = 平台默认音色。
  voiceId?: string;
}

export interface LiveVoice {
  id: string;
  name: string;
}

export function isGeminiLiveProvider(value: { type?: unknown; presetId?: unknown }): boolean {
  return value.type === "gemini-live" || value.presetId === "gemini-live";
}

export function normalizeLiveProvider(item: unknown): LiveProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<LiveProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const presetId = String(raw.presetId || "").trim();
  const type = String(raw.type || "").trim() || (presetId === "gemini-live" ? "gemini-live" : "moss-live");
  if (!LIVE_PROVIDER_TYPES.has(type)) return null;
  const gemini = type === "gemini-live";
  const voiceId = String(raw.voiceId || "").trim();
  return {
    id,
    presetId: presetId || (gemini ? "gemini-live" : "moss-live"),
    name: String(raw.name || "").trim() || (gemini ? "Gemini Live" : "MOSS Live"),
    type,
    baseUrl: normalizeBaseUrl(raw.baseUrl) || (gemini ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn"),
    model: String(raw.model || "").trim() || (gemini ? GEMINI_LIVE_DEFAULT_MODEL : DEFAULT_LIVE_MODEL),
    enabled: raw.enabled !== false,
    ...(gemini && typeof raw.liveGeminiNativeSearch === "boolean" ? { liveGeminiNativeSearch: raw.liveGeminiNativeSearch } : {}),
    ...(voiceId ? { voiceId } : {})
  };
}

export function resolveActiveLiveProviderId(
  providers: ReadonlyArray<{ id?: string | null }> | null | undefined,
  activeId?: string | null
): string {
  const list = Array.isArray(providers) ? providers : [];
  const trimmed = String(activeId || "").trim();
  if (trimmed && list.some((p) => String(p?.id || "").trim() === trimmed)) {
    return trimmed;
  }
  return String(list[0]?.id || "").trim();
}

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
    name: "MOSS Live",
    type: "moss-live",
    baseUrl: "https://api.mosi.cn",
    model: DEFAULT_LIVE_MODEL,
    requiresKey: true,
    note: "MOSS Live 1.0 全双工实时语音伴看"
  },
  {
    id: "gemini-live",
    name: "Gemini Live",
    type: "gemini-live",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: GEMINI_LIVE_DEFAULT_MODEL,
    requiresKey: false,
    note: "Gemini Live 全双工实时音画伴看"
  }
];

const providerStore = createProviderStore<LiveProvider>({
  listStorageKey: LIVE_PROVIDERS_STORAGE,
  keysStorageKey: LIVE_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeLiveProvider
});

export const liveProviderStore = {
  ...providerStore,
  saveProviders: (items: unknown[]) =>
    providerStore.saveProviders(
      items.map((item) => {
        if (!item || typeof item !== "object" || !isGeminiLiveProvider(item)) return item;
        const { apiKey: _apiKey, ...withoutKey } = item as LiveProvider;
        return withoutKey;
      })
    )
};
