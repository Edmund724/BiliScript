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

export function resolveSubtitleTranslateProviderConfig(
  providers: ProviderListEntry[],
  keys: Record<string, string>,
  settings?: SubtitleTranslateSettingsInput
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
