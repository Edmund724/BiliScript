import { createProviderStore, type ProviderStore } from "./provider-store.js";
import { AI_PROVIDER_MODELS_LOCAL_KEY } from "./defaults.js";
import { normalizeBaseUrl } from "./presets.js";
import { AI_PROTOCOLS, type AiProtocol } from "../ai/protocol-vocab.js";
import type { AiProvider as AiProviderWire } from "../ai/types.js";

export { AI_PROVIDER_MODELS_LOCAL_KEY };

export interface AiProvider extends AiProviderWire {
  id: string;
  presetId: string;
  name: string;
  baseUrl: string;
  models: string[];
  requiresKey: boolean;
  enabled: boolean;
  protocol?: AiProtocol;
  hasSavedKey?: boolean;
  apiKey?: string;
}

export const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";
export const AI_PROVIDERS_STORAGE = "aiProviders";
export const AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER = 5;
export const AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT = 6000;

export type AiProviderModelsLocalMap = Record<string, string[]>;

const utf8Encoder = new TextEncoder();

function serializedSyncItemBytes(providers: readonly AiProvider[]): number {
  return (
    utf8Encoder.encode(AI_PROVIDERS_STORAGE).length +
    utf8Encoder.encode(JSON.stringify(providers)).length
  );
}

function normalizeModelsField(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const id = String(entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeAiProvider(item: unknown): AiProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AiProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const legacyModel = String(raw.model ?? "").trim();
  const models = normalizeModelsField(raw.models);
  const normalized: AiProvider = {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    models: models.length ? models : legacyModel ? [legacyModel] : [],
    requiresKey: raw.requiresKey !== false,
    enabled: raw.enabled !== false
  };
  if (typeof raw.protocol === "string" && (AI_PROTOCOLS as readonly string[]).includes(raw.protocol)) {
    normalized.protocol = raw.protocol as AiProtocol;
  }
  return normalized;
}

function normalizeLocalModelsMap(raw: unknown): AiProviderModelsLocalMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: AiProviderModelsLocalMap = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(providerId || "").trim();
    if (!id) continue;
    const models = normalizeModelsField(value);
    if (models.length > 0) {
      out[id] = models;
    }
  }
  return out;
}

export function buildSlimSyncAiProviders(providers: readonly AiProvider[]): AiProvider[] {
  const slim: AiProvider[] = providers.map((provider) => ({
    ...provider,
    models: provider.models.slice(0, AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER)
  }));
  while (serializedSyncItemBytes(slim) > AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT) {
    let widestIndex = -1;
    let widestCount = 1;
    for (let i = 0; i < slim.length; i += 1) {
      if (slim[i].models.length > widestCount) {
        widestCount = slim[i].models.length;
        widestIndex = i;
      }
    }
    if (widestIndex === -1) {
      break;
    }
    slim[widestIndex] = {
      ...slim[widestIndex],
      models: slim[widestIndex].models.slice(0, -1)
    };
  }
  return slim;
}

function buildLocalModelsMap(providers: readonly AiProvider[]): AiProviderModelsLocalMap {
  const map: AiProviderModelsLocalMap = {};
  for (const provider of providers) {
    if (provider.models.length > 0) {
      map[provider.id] = [...provider.models];
    }
  }
  return map;
}

async function readLocalModelsMap(): Promise<AiProviderModelsLocalMap> {
  try {
    const localData = await chrome.storage.local.get([AI_PROVIDER_MODELS_LOCAL_KEY]);
    return normalizeLocalModelsMap(localData?.[AI_PROVIDER_MODELS_LOCAL_KEY]);
  } catch {
    return {};
  }
}

function needsLegacySyncMigration(
  syncProviders: readonly AiProvider[],
  slimSyncProviders: readonly AiProvider[]
): boolean {
  if (syncProviders.length === 0) {
    return false;
  }
  if (syncProviders.some((provider) => provider.models.length > AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER)) {
    return true;
  }
  if (serializedSyncItemBytes(syncProviders) <= AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT) {
    return false;
  }
  return syncProviders.some(
    (provider, index) => provider.models.length > (slimSyncProviders[index]?.models.length ?? 0)
  );
}

const baseAiProviderStore = createProviderStore<AiProvider>({
  listStorageKey: AI_PROVIDERS_STORAGE,
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});

export const aiProviderStore: ProviderStore<AiProvider> = {
  loadKeys: baseAiProviderStore.loadKeys,
  getKey: baseAiProviderStore.getKey,
  resolveDraftApiKey: baseAiProviderStore.resolveDraftApiKey,

  async loadProviders(): Promise<Array<AiProvider & { hasSavedKey: boolean }>> {
    const [syncList, keys, localModels] = await Promise.all([
      chrome.storage.sync.get([AI_PROVIDERS_STORAGE]).then((syncData) => {
        const list: unknown[] = Array.isArray(syncData?.[AI_PROVIDERS_STORAGE])
          ? syncData[AI_PROVIDERS_STORAGE]
          : [];
        return list.map(normalizeAiProvider).filter((p): p is AiProvider => Boolean(p));
      }),
      baseAiProviderStore.loadKeys(),
      readLocalModelsMap()
    ]);

    const mergedProviders: AiProvider[] = syncList.map((provider) => {
      const localList = localModels[provider.id];
      if (localList && localList.length > 0) {
        return { ...provider, models: [...localList] };
      }
      return provider;
    });

    const slimForCheck = buildSlimSyncAiProviders(syncList);
    if (needsLegacySyncMigration(syncList, slimForCheck)) {
      const migratedProviders = syncList.map((provider) => {
        const localList = localModels[provider.id];
        if (localList && localList.length >= provider.models.length) {
          return { ...provider, models: [...localList] };
        }
        return provider;
      });
      const nextLocalModels = {
        ...localModels,
        ...buildLocalModelsMap(migratedProviders)
      };
      const slimSync = buildSlimSyncAiProviders(migratedProviders);
      try {
        await chrome.storage.local.set({ [AI_PROVIDER_MODELS_LOCAL_KEY]: nextLocalModels });
        await chrome.storage.sync.set({ [AI_PROVIDERS_STORAGE]: slimSync });
      } catch {
      }
      return migratedProviders.map((provider) => ({
        ...provider,
        hasSavedKey: Boolean(keys[provider.id])
      }));
    }

    return mergedProviders.map((provider) => ({
      ...provider,
      hasSavedKey: Boolean(keys[provider.id])
    }));
  },

  async saveProviders(items: unknown[]): Promise<Array<AiProvider & { hasSavedKey: boolean }>> {
    const rawList = Array.isArray(items) ? items : [];
    const keys = await baseAiProviderStore.loadKeys();
    const nextList: AiProvider[] = [];
    for (const raw of rawList) {
      const normalized = normalizeAiProvider(raw);
      if (!normalized) continue;
      nextList.push(normalized);
      const incomingKey = String((raw as { apiKey?: unknown }).apiKey || "").trim();
      if (incomingKey) {
        keys[normalized.id] = incomingKey;
      }
    }
    const localModels = buildLocalModelsMap(nextList);
    const slimSyncList = buildSlimSyncAiProviders(nextList);
    await Promise.all([
      chrome.storage.local.set({
        [AI_PROVIDER_KEYS_STORAGE]: keys,
        [AI_PROVIDER_MODELS_LOCAL_KEY]: localModels
      }),
      chrome.storage.sync.set({ [AI_PROVIDERS_STORAGE]: slimSyncList })
    ]);
    return nextList.map((provider) => ({ ...provider, hasSavedKey: Boolean(keys[provider.id]) }));
  },

  async deleteProvider(providerId: string): Promise<Array<AiProvider & { hasSavedKey: boolean }>> {
    const [current, keys, localModels] = await Promise.all([
      aiProviderStore.loadProviders(),
      baseAiProviderStore.loadKeys(),
      readLocalModelsMap()
    ]);
    const nextList: AiProvider[] = current
      .filter((provider) => provider.id !== providerId)
      .map(({ hasSavedKey: _hasSavedKey, apiKey: _apiKey, ...rest }) => rest);
    const slimSyncList = buildSlimSyncAiProviders(nextList);
    const localPatch: Record<string, unknown> = {};
    if (providerId in localModels) {
      delete localModels[providerId];
      localPatch[AI_PROVIDER_MODELS_LOCAL_KEY] = localModels;
    }
    if (keys && providerId in keys) {
      delete keys[providerId];
      localPatch[AI_PROVIDER_KEYS_STORAGE] = keys;
    }
    const writes: Promise<unknown>[] = [
      chrome.storage.sync.set({ [AI_PROVIDERS_STORAGE]: slimSyncList })
    ];
    if (Object.keys(localPatch).length > 0) {
      writes.push(chrome.storage.local.set(localPatch));
    }
    await Promise.all(writes);
    return nextList.map((provider) => ({ ...provider, hasSavedKey: Boolean(keys[provider.id]) }));
  }
};
