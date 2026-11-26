import type { Settings } from "../core/defaults.js";
import { MISSING_PROVIDER_KEY_MESSAGE } from "../core/overview-setup-error.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { ProviderListEntry } from "../shared/messaging-protocol.js";
import { resolveCatalogModel } from "../shared/selected-provider.js";
import {
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODELS,
  isIndexTranslateModelId,
  normalizeIndexTranslateModel,
  parseSubtitleGlossary,
  type IndexTranslateModelId,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput
} from "../shared/subtitle-glossary.js";
import type { AiProtocol } from "./protocol-vocab.js";

export {
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODELS,
  isIndexTranslateModelId,
  normalizeIndexTranslateModel,
  parseSubtitleGlossary,
  type IndexTranslateModelId,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput
};

export interface SubtitleTranslateProviderResolution {
  provider: ProviderListEntry;
  apiKey: string;
  baseUrl: string;
  model: string;
  presetId: string;
  protocol?: AiProtocol;
  isFallback: boolean;
}

export const INDEX_TRANSLATE_PROVIDER_ID = "bilibili-index-translate";
export const INDEX_TRANSLATE_PROVIDER_NAME = "Bilibili Index-Translate";
export const INDEX_TRANSLATE_BASE_URL = "https://index-translate.bilibili.com/v1";
export const INDEX_TRANSLATE_HOST = "index-translate.bilibili.com";
export const INDEX_TRANSLATE_MODEL: IndexTranslateModelId = INDEX_TRANSLATE_DEFAULT_MODEL;
export const INDEX_TRANSLATE_USER_AGENT = "Index-Translate-Client/1.0";

export const SILICONFLOW_TRANSLATE_PROVIDER_ID = "siliconflow-translate";
export const SILICONFLOW_TRANSLATE_PROVIDER_NAME = "SiliconFlow 硅基流动";
export const SILICONFLOW_TRANSLATE_BASE_URL = "https://api.siliconflow.cn/v1";
export const SILICONFLOW_TRANSLATE_HOST = "api.siliconflow.cn";
export const SILICONFLOW_TRANSLATE_MODELS = ["tencent/Hunyuan-MT-7B"] as const;
export type SiliconFlowTranslateModelId = (typeof SILICONFLOW_TRANSLATE_MODELS)[number];
export const SILICONFLOW_TRANSLATE_DEFAULT_MODEL: SiliconFlowTranslateModelId = "tencent/Hunyuan-MT-7B";
export const SILICONFLOW_TRANSLATE_KEY_STORAGE = "subtitleTranslateSiliconFlowKey";
export const MISSING_SILICONFLOW_TRANSLATE_KEY_MESSAGE =
  "请先填写硅基流动 API Key（或先在「语音转写」中配置硅基流动以自动复用）";

export interface SiliconFlowTranslateModelOption {
  id: SiliconFlowTranslateModelId;
  label: string;
  isDefault: boolean;
  available: boolean;
}

export const SILICONFLOW_TRANSLATE_MODEL_OPTIONS: readonly SiliconFlowTranslateModelOption[] = [
  {
    id: "tencent/Hunyuan-MT-7B",
    label: "tencent/Hunyuan-MT-7B（免费）",
    isDefault: true,
    available: true
  }
];

export const SILICONFLOW_TRANSLATE_BUILTIN_PROVIDER: ProviderListEntry = {
  id: SILICONFLOW_TRANSLATE_PROVIDER_ID,
  presetId: "siliconflow",
  name: SILICONFLOW_TRANSLATE_PROVIDER_NAME,
  baseUrl: SILICONFLOW_TRANSLATE_BASE_URL,
  models: [...SILICONFLOW_TRANSLATE_MODELS],
  model: SILICONFLOW_TRANSLATE_DEFAULT_MODEL,
  requiresKey: true,
  hasSavedKey: false,
  enabled: true,
  protocol: "openai"
};

export function normalizeSiliconFlowTranslateModel(value: unknown): SiliconFlowTranslateModelId {
  const trimmed = String(value || "").trim();
  if (!trimmed) return SILICONFLOW_TRANSLATE_DEFAULT_MODEL;
  const lower = trimmed.toLowerCase();
  const matched = SILICONFLOW_TRANSLATE_MODELS.find((candidate) => candidate.toLowerCase() === lower);
  return matched ?? SILICONFLOW_TRANSLATE_DEFAULT_MODEL;
}

export function isSiliconFlowTranslateProvider(
  provider?: { id?: unknown; presetId?: unknown } | null
): boolean {
  if (!provider) return false;
  const id = String(provider.id || "").trim();
  const presetId = String(provider.presetId || "").trim();
  return id === SILICONFLOW_TRANSLATE_PROVIDER_ID || presetId === SILICONFLOW_TRANSLATE_PROVIDER_ID;
}

export interface SiliconFlowAsrProviderLike {
  id?: unknown;
  presetId?: unknown;
  baseUrl?: unknown;
  enabled?: unknown;
  hasSavedKey?: unknown;
}

export function isOfficialSiliconFlowEndpoint(baseUrl: unknown): boolean {
  const raw = String(baseUrl || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      (!url.port || url.port === "443") &&
      url.hostname.toLowerCase() === SILICONFLOW_TRANSLATE_HOST
    );
  } catch {
    return false;
  }
}

export function isSiliconFlowAsrProvider(
  provider: SiliconFlowAsrProviderLike | null | undefined
): boolean {
  if (!provider || provider.enabled === false) return false;
  const baseUrl = String(provider.baseUrl || "").trim();
  if (baseUrl) {
    return isOfficialSiliconFlowEndpoint(baseUrl);
  }
  return String(provider.presetId || "").trim() === "siliconflow-sensevoice";
}

export function hasSavedSiliconFlowAsrKey(
  asrProviders: readonly SiliconFlowAsrProviderLike[] | undefined
): boolean {
  if (!Array.isArray(asrProviders)) return false;
  return asrProviders.some((provider) => isSiliconFlowAsrProvider(provider) && provider.hasSavedKey === true);
}

export function resolveSiliconFlowAsrApiKey(
  asrProviders: readonly SiliconFlowAsrProviderLike[] | undefined,
  asrKeys: Record<string, string> | undefined,
  activeAsrProviderId?: unknown
): string {
  const list = Array.isArray(asrProviders) ? asrProviders : [];
  const activeId = String(activeAsrProviderId || "").trim();
  const candidates = list.filter(isSiliconFlowAsrProvider);
  if (activeId) {
    const active = candidates.find((provider) => String(provider.id || "").trim() === activeId);
    const activeKey = active ? String(asrKeys?.[String(active.id || "").trim()] || "").trim() : "";
    if (activeKey) return activeKey;
  }
  for (const provider of candidates) {
    const id = String(provider.id || "").trim();
    const key = id ? String(asrKeys?.[id] || "").trim() : "";
    if (key) return key;
  }
  return "";
}

export interface IndexTranslateModelOption {
  id: IndexTranslateModelId;
  label: string;
  tier: "旗舰" | "均衡" | "轻量";
  isDefault: boolean;
  available: boolean;
}

export const INDEX_TRANSLATE_MODEL_OPTIONS: readonly IndexTranslateModelOption[] = [
  {
    id: "Index-Translate-35B-A3B",
    label: "Index-Translate-35B-A3B（旗舰，默认）",
    tier: "旗舰",
    isDefault: true,
    available: true
  },
  {
    id: "Index-Translate-9B",
    label: "Index-Translate-9B（均衡）",
    tier: "均衡",
    isDefault: false,
    available: true
  },
  {
    id: "Index-Translate-2B",
    label: "Index-Translate-2B（轻量）",
    tier: "轻量",
    isDefault: false,
    available: true
  }
];

export const INDEX_TRANSLATE_BUILTIN_PROVIDER: ProviderListEntry = {
  id: INDEX_TRANSLATE_PROVIDER_ID,
  presetId: INDEX_TRANSLATE_PROVIDER_ID,
  name: INDEX_TRANSLATE_PROVIDER_NAME,
  baseUrl: INDEX_TRANSLATE_BASE_URL,
  models: [...INDEX_TRANSLATE_MODELS],
  model: INDEX_TRANSLATE_DEFAULT_MODEL,
  requiresKey: false,
  hasSavedKey: false,
  enabled: true,
  protocol: "openai"
};

export function isIndexTranslateProvider(
  provider?: { id?: unknown; presetId?: unknown; baseUrl?: unknown } | null
): boolean {
  if (!provider) {
    return false;
  }
  const id = String(provider.id || "").trim();
  const presetId = String(provider.presetId || "").trim();
  if (id === INDEX_TRANSLATE_PROVIDER_ID || presetId === INDEX_TRANSLATE_PROVIDER_ID) {
    return true;
  }
  const rawBaseUrl = String(provider.baseUrl || "").trim();
  if (!rawBaseUrl) {
    return false;
  }
  try {
    return new URL(rawBaseUrl).hostname.toLowerCase() === INDEX_TRANSLATE_HOST;
  } catch {
    return false;
  }
}

export function createIndexTranslateResolution(model?: string): SubtitleTranslateProviderResolution {
  const effectiveModel = normalizeIndexTranslateModel(model);
  return {
    provider: INDEX_TRANSLATE_BUILTIN_PROVIDER,
    apiKey: "",
    baseUrl: INDEX_TRANSLATE_BASE_URL,
    model: effectiveModel,
    presetId: INDEX_TRANSLATE_PROVIDER_ID,
    protocol: "openai",
    isFallback: false
  };
}

export interface SubtitleTranslateSettingsInput {
  subtitleTranslateProviderId?: unknown;
  subtitleTranslateModel?: unknown;
  subtitleTranslateGlossary?: unknown;
}

export function resolveSubtitleTranslateGlossary(
  settings?: SubtitleTranslateSettingsInput | null
): SubtitleGlossaryEntry[] {
  const raw = typeof settings?.subtitleTranslateGlossary === "string"
    ? settings.subtitleTranslateGlossary
    : "";
  return parseSubtitleGlossary(raw);
}

export interface ResolveSubtitleTranslateProviderConfigOptions {
  asrProviders?: readonly SiliconFlowAsrProviderLike[];
  asrKeys?: Record<string, string>;
  siliconFlowApiKey?: string;
  activeAsrProviderId?: unknown;
}

export function resolveSubtitleTranslateProviderConfig(
  providers: ProviderListEntry[],
  keys: Record<string, string>,
  settings?: SubtitleTranslateSettingsInput,
  options?: ResolveSubtitleTranslateProviderConfigOptions
): SubtitleTranslateProviderResolution {
  const providerList = Array.isArray(providers) ? providers : [];
  const enabled = providerList.filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      item.enabled !== false &&
      String(item.id || "").trim() !== ""
  );

  const preferredProviderId = String(settings?.subtitleTranslateProviderId || "").trim();
  const preferredModel = String(settings?.subtitleTranslateModel || "").trim();

  if (preferredProviderId === SILICONFLOW_TRANSLATE_PROVIDER_ID) {
    const directKey = String(options?.siliconFlowApiKey || "").trim();
    const apiKey =
      directKey ||
      resolveSiliconFlowAsrApiKey(options?.asrProviders, options?.asrKeys, options?.activeAsrProviderId);
    if (!apiKey) {
      throw new Error(MISSING_SILICONFLOW_TRANSLATE_KEY_MESSAGE);
    }
    const model = normalizeSiliconFlowTranslateModel(preferredModel);
    return {
      provider: {
        ...SILICONFLOW_TRANSLATE_BUILTIN_PROVIDER,
        hasSavedKey: true
      },
      apiKey,
      baseUrl: SILICONFLOW_TRANSLATE_BASE_URL,
      model,
      presetId: "siliconflow",
      protocol: "openai",
      isFallback: false
    };
  }

  if (!preferredProviderId || preferredProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
    if (preferredProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
      const explicitEntry = providerList.find(
        (item) => Boolean(item) && typeof item === "object" && String(item.id || "").trim() === INDEX_TRANSLATE_PROVIDER_ID
      );
      if (explicitEntry) {
        if (explicitEntry.enabled === false) {
          return { ...createIndexTranslateResolution(), isFallback: true };
        }
        const apiKey = String(keys?.[INDEX_TRANSLATE_PROVIDER_ID] || "").trim();
        return {
          provider: explicitEntry,
          apiKey,
          baseUrl: String(explicitEntry.baseUrl || "").trim() || INDEX_TRANSLATE_BASE_URL,
          model: normalizeIndexTranslateModel(preferredModel || resolveCatalogModel(explicitEntry)),
          presetId: String(explicitEntry.presetId || INDEX_TRANSLATE_PROVIDER_ID),
          protocol: (explicitEntry.protocol as AiProtocol | undefined) ?? "openai",
          isFallback: false
        };
      }
    }
    return createIndexTranslateResolution(preferredModel);
  }

  const chosen = enabled.find((item) => String(item.id) === preferredProviderId) || null;
  if (!chosen) {
    return {
      ...createIndexTranslateResolution(),
      isFallback: true
    };
  }

  const chosenId = String(chosen.id);
  const apiKey = String(keys?.[chosenId] || "").trim();
  if (chosen.requiresKey !== false && !apiKey) {
    throw new Error(MISSING_PROVIDER_KEY_MESSAGE);
  }

  const model = resolveCatalogModel(chosen, preferredModel) || preferredModel;

  return {
    provider: chosen,
    apiKey,
    baseUrl: String(chosen.baseUrl || "").trim(),
    model,
    presetId: String(chosen.presetId || ""),
    protocol: chosen.protocol as AiProtocol | undefined,
    isFallback: false
  };
}

export interface ResolveSubtitleTranslateProviderDeps {
  getSettings?: () => Promise<Partial<Settings>>;
  loadProviders?: () => Promise<ProviderListEntry[]>;
  loadKeys?: () => Promise<Record<string, string>>;
}

export async function resolveSubtitleTranslateProvider(
  deps?: ResolveSubtitleTranslateProviderDeps
): Promise<SubtitleTranslateProviderResolution> {
  if (deps?.getSettings && deps?.loadProviders && deps?.loadKeys) {
    const [settings, providers, keys] = await Promise.all([
      deps.getSettings(),
      deps.loadProviders(),
      deps.loadKeys()
    ]);
    return resolveSubtitleTranslateProviderConfig(providers, keys, settings);
  }

  const resp = await sendRuntimeMessage({ type: "resolve-subtitle-translate-provider" });
  if (!resp?.ok || !resp.provider) {
    throw new Error(String(resp?.error || "解析字幕翻译平台配置失败"));
  }
  const provider = resp.provider;
  return {
    provider,
    apiKey: String(resp.apiKey || "").trim(),
    baseUrl: String(provider.baseUrl || "").trim(),
    model: String(resp.model || provider.model || "").trim(),
    presetId: String(provider.presetId || ""),
    protocol: provider.protocol as AiProtocol | undefined,
    isFallback: resp.isFallback === true
  };
}
