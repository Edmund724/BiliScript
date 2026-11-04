// extension/live/live-provider-store.ts
// MOSS-LIVE 伴看平台的 Provider/Key 存储。
// 复用 extension/core/provider-store.ts 工厂：
// 平台列表存储在 chrome.storage.sync，API Key 存储在 chrome.storage.local。

import { normalizeBaseUrl } from "../core/presets.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { createProviderStore, formatProbeHttpError } from "../core/provider-store.js";
import { normalizeLiveProvider, resolveActiveLiveProviderId, type LiveProvider } from "./live-provider-normalize.js";

export { resolveActiveLiveProviderId };
export type { LiveProvider } from "./live-provider-normalize.js";

export const LIVE_PROVIDERS_STORAGE = "liveProviders";
export const LIVE_PROVIDER_KEYS_STORAGE = "liveProviderKeys";
export const DEFAULT_LIVE_MODEL = "moss-live-1.0";

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
    model: DEFAULT_LIVE_MODEL,
    requiresKey: true,
    note: "MOSS-LIVE 1.0 全双工实时语音伴看"
  }
];

export const liveProviderStore = createProviderStore<LiveProvider>({
  listStorageKey: LIVE_PROVIDERS_STORAGE,
  keysStorageKey: LIVE_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeLiveProvider
});

export function resolveLiveModelsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  if (/\/v1\/realtime$/i.test(normalized)) {
    return normalized.replace(/\/v1\/realtime$/i, "/v1/models");
  }
  if (/\/realtime$/i.test(normalized)) {
    return normalized.replace(/\/realtime$/i, "/v1/models");
  }
  if (/\/v1$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

export interface ListLiveModelsOptions {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export type ListLiveModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

export async function listLiveModels({
  baseUrl,
  apiKey,
  providerId
}: ListLiveModelsOptions = {}): Promise<ListLiveModelsResult> {
  const modelsUrl = resolveLiveModelsUrl(baseUrl || "");
  if (!modelsUrl) {
    return { ok: false, error: "请先填写 baseUrl" };
  }

  const resolvedApiKey = await liveProviderStore.resolveDraftApiKey(apiKey, providerId);
  if (!resolvedApiKey) {
    return { ok: false, error: "请先填写 API Key" };
  }

  let resp: Response;
  try {
    resp = await providerFetchViaBackground(modelsUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${resolvedApiKey}`
      }
    });
  } catch (error) {
    return { ok: false, error: `网络错误: ${(error as Error).message}` };
  }

  if (!resp.ok) {
    return { ok: false, error: await formatProbeHttpError(resp) };
  }

  let data: { data?: Array<{ id?: string }> } | null;
  try {
    data = (await resp.json()) as { data?: Array<{ id?: string }> };
  } catch {
    return { ok: false, error: "返回内容不是合法 JSON" };
  }

  const rawList = Array.isArray(data?.data) ? data.data : [];
  const fetched = rawList
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean);
  const models = fetched.includes(DEFAULT_LIVE_MODEL)
    ? fetched
    : [DEFAULT_LIVE_MODEL, ...fetched];

  return { ok: true, models };
}

export async function testLiveConnection(
  provider?: (Partial<LiveProvider> & { apiKey?: string }) | null
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = String(provider?.baseUrl || "").trim();
  const model = String(provider?.model || "").trim();
  if (!baseUrl) {
    return { ok: false, error: "请填写 API 地址" };
  }
  if (!model) {
    return { ok: false, error: "请填写模型名" };
  }
  const res = await listLiveModels({
    baseUrl,
    apiKey: provider?.apiKey,
    providerId: provider?.id
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error || "连接失败" };
}
