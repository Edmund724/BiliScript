// extension/live/live-provider-store.ts
// 实时伴看平台的 Provider/Key 存储、归一化与模型探针。
// 平台列表存储在 chrome.storage.sync，自有 API Key 存储在 chrome.storage.local。

import {
  getAiCredentialStatusText,
  queryAiCredentialKey
} from "../core/ai-credential-reference.js";
import { normalizeBaseUrl } from "../core/presets.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { createProviderStore, formatProbeHttpError } from "../core/provider-store.js";

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

function isGeminiLive(value: { type?: unknown; presetId?: unknown }): boolean {
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
        if (!item || typeof item !== "object" || !isGeminiLive(item)) return item;
        const { apiKey: _apiKey, ...withoutKey } = item as LiveProvider;
        return withoutKey;
      })
    )
};

export function resolveLiveModelsUrl(baseUrl: string, type?: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  if (type === "gemini-live") {
    if (/\/v1beta\/models$/i.test(normalized)) return normalized;
    if (/\/v1beta$/i.test(normalized)) return `${normalized}/models`;
    return `${normalized}/v1beta/models`;
  }
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

// ===== 平台音色库（MOSS-LIVE 音色选择器）=====
// GET /v1/audio/voices 分页取全（limit 上限 150，after=next_cursor）；只有
// name 有展示意义，空名回落 id。音色列表是账号级数据，凭证与模型列表同源
//（草稿 Key 优先，其次该 provider 已存 Key）。

export const LIVE_VOICES_PAGE_SIZE = 150;
const LIVE_VOICES_MAX_PAGES = 20;

export interface LiveVoice {
  id: string;
  name: string;
}

export interface ListLiveVoicesOptions {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export type ListLiveVoicesResult =
  | { ok: true; voices: LiveVoice[] }
  | { ok: false; error: string };

export function resolveLiveVoicesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "";
  if (/\/v1\/audio\/voices$/i.test(normalized)) return normalized;
  if (/\/audio\/voices$/i.test(normalized)) return normalized;
  if (/\/v1\/realtime$/i.test(normalized)) {
    return normalized.replace(/\/v1\/realtime$/i, "/v1/audio/voices");
  }
  if (/\/realtime$/i.test(normalized)) {
    return normalized.replace(/\/realtime$/i, "/v1/audio/voices");
  }
  if (/\/v1$/i.test(normalized)) return `${normalized}/audio/voices`;
  return `${normalized}/v1/audio/voices`;
}

export async function listLiveVoices({
  baseUrl,
  apiKey,
  providerId
}: ListLiveVoicesOptions = {}): Promise<ListLiveVoicesResult> {
  const voicesUrl = resolveLiveVoicesUrl(baseUrl || "");
  if (!voicesUrl) return { ok: false, error: "请先填写 baseUrl" };

  const resolvedApiKey = await liveProviderStore.resolveDraftApiKey(apiKey, providerId);
  if (!resolvedApiKey) return { ok: false, error: "请先填写 API Key" };

  const headers = { Accept: "application/json", Authorization: `Bearer ${resolvedApiKey}` };
  const voices: LiveVoice[] = [];
  const seen = new Set<string>();
  let cursor = "";

  for (let page = 0; page < LIVE_VOICES_MAX_PAGES; page += 1) {
    const pageUrl = `${voicesUrl}?limit=${LIVE_VOICES_PAGE_SIZE}${
      cursor ? `&after=${encodeURIComponent(cursor)}` : ""
    }`;
    let resp: Response;
    try {
      resp = await providerFetchViaBackground(pageUrl, { method: "GET", headers });
    } catch (error) {
      return { ok: false, error: `网络错误: ${(error as Error).message}` };
    }
    if (!resp.ok) return { ok: false, error: await formatProbeHttpError(resp) };

    let data: {
      data?: Array<{ id?: unknown; name?: unknown }>;
      has_more?: unknown;
      next_cursor?: unknown;
    } | null;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, error: "返回内容不是合法 JSON" };
    }

    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const id = String(item?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      voices.push({ id, name: String(item?.name || "").trim() || id });
    }

    const nextCursor = typeof data?.next_cursor === "string" ? data.next_cursor.trim() : "";
    // 有的分页实现只回 next_cursor 不带 has_more：以游标是否前进为准。
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { ok: true, voices };
}

export interface ListLiveModelsOptions {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
  type?: string;
  presetId?: string;
}

export type ListLiveModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

export async function listLiveModels({
  baseUrl,
  apiKey,
  providerId,
  type,
  presetId
}: ListLiveModelsOptions = {}): Promise<ListLiveModelsResult> {
  const gemini = isGeminiLive({ type, presetId });
  const modelsUrl = resolveLiveModelsUrl(baseUrl || "", gemini ? "gemini-live" : type);
  if (!modelsUrl) return { ok: false, error: "请先填写 baseUrl" };

  let headers: Record<string, string>;
  if (gemini) {
    const credential = await queryAiCredentialKey("gemini-live");
    if (!credential.key) {
      return { ok: false, error: getAiCredentialStatusText("gemini-live", credential.status) };
    }
    headers = { Accept: "application/json", "x-goog-api-key": credential.key };
  } else {
    const resolvedApiKey = await liveProviderStore.resolveDraftApiKey(apiKey, providerId);
    if (!resolvedApiKey) return { ok: false, error: "请先填写 API Key" };
    headers = { Accept: "application/json", Authorization: `Bearer ${resolvedApiKey}` };
  }

  let resp: Response;
  try {
    resp = await providerFetchViaBackground(modelsUrl, { method: "GET", headers });
  } catch (error) {
    return { ok: false, error: `网络错误: ${(error as Error).message}` };
  }

  if (!resp.ok) return { ok: false, error: await formatProbeHttpError(resp) };

  let data: {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  } | null;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, error: "返回内容不是合法 JSON" };
  }

  if (gemini) {
    const fetched = (Array.isArray(data?.models) ? data.models : [])
      .filter((item) => item?.supportedGenerationMethods?.includes("bidiGenerateContent"))
      .map((item) => String(item?.name || "").trim().replace(/^models\//, ""))
      .filter(Boolean);
    return { ok: true, models: [...new Set([...GEMINI_LIVE_FALLBACK_MODELS, ...fetched])] };
  }

  const fetched = (Array.isArray(data?.data) ? data.data : [])
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean);
  return {
    ok: true,
    models: fetched.includes(DEFAULT_LIVE_MODEL) ? fetched : [DEFAULT_LIVE_MODEL, ...fetched]
  };
}

export async function testLiveConnection(
  provider?: (Partial<LiveProvider> & { apiKey?: string }) | null
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = String(provider?.baseUrl || "").trim();
  const model = String(provider?.model || "").trim();
  if (!baseUrl) return { ok: false, error: "请填写 API 地址" };
  if (!model) return { ok: false, error: "请填写模型名" };
  const res = await listLiveModels({
    baseUrl,
    apiKey: provider?.apiKey,
    providerId: provider?.id,
    type: provider?.type,
    presetId: provider?.presetId
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error || "连接失败" };
}
