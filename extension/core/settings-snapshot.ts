import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { getMergedSettings } from "./settings-store.js";
import type { ProviderBase, ProviderKeys } from "./provider-store.js";
import {
  aiProviderStore,
  AI_PROVIDERS_STORAGE,
  AI_PROVIDER_KEYS_STORAGE,
  AI_PROVIDER_MODELS_LOCAL_KEY,
  type AiProvider
} from "./ai-provider-store.js";
import { asrProviderStore, ASR_PROVIDERS_STORAGE, ASR_PROVIDER_KEYS_STORAGE, type AsrProvider } from "../asr/asr-provider-store.js";
import { searchProviderStore, SEARCH_PROVIDER_ORDER_STORAGE, SEARCH_PROVIDERS_STORAGE, SEARCH_PROVIDER_KEYS_STORAGE } from "../search/search-provider-store.js";
import { liveProviderStore, LIVE_PROVIDERS_STORAGE, LIVE_PROVIDER_KEYS_STORAGE, type LiveProvider } from "../live/live-provider-store.js";
import type { SearchProvider } from "../search/search-provider-normalize.js";
import { normalizeSearchProviderOrder } from "../search/search-order.js";
import { SEARCH_HEALTH_KEY, readSearchHealth, type SearchHealthMap } from "../search/search-health.js";
import { withTimeout } from "../shared/error-helpers.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";

export type ProviderFamily = "ai" | "asr" | "search" | "live";

interface ProviderFamilyMap {
  ai: AiProvider;
  asr: AsrProvider;
  search: SearchProvider;
  live: LiveProvider;
}

export interface ProviderStoreSnapshot<T extends ProviderBase = ProviderBase> {
  providers: Array<T & { hasSavedKey: boolean }>;
  keys: ProviderKeys;
}

interface ProviderFamilyKeyPair {
  list: string;
  keys: string;
  extraLocalKeys?: readonly string[];
}

const PROVIDER_FAMILY_KEY_PAIRS: Record<ProviderFamily, ProviderFamilyKeyPair> = {
  ai: {
    list: AI_PROVIDERS_STORAGE,
    keys: AI_PROVIDER_KEYS_STORAGE,
    extraLocalKeys: [AI_PROVIDER_MODELS_LOCAL_KEY]
  },
  asr: { list: ASR_PROVIDERS_STORAGE, keys: ASR_PROVIDER_KEYS_STORAGE },
  search: { list: SEARCH_PROVIDERS_STORAGE, keys: SEARCH_PROVIDER_KEYS_STORAGE },
  live: { list: LIVE_PROVIDERS_STORAGE, keys: LIVE_PROVIDER_KEYS_STORAGE }
};

function keyFace({ list, keys, extraLocalKeys = [] }: ProviderFamilyKeyPair): readonly string[] {
  return [list, keys, ...extraLocalKeys];
}

export const PROVIDER_FAMILY_STORAGE_KEYS: Record<ProviderFamily, readonly string[]> = {
  ai: keyFace(PROVIDER_FAMILY_KEY_PAIRS.ai),
  asr: keyFace(PROVIDER_FAMILY_KEY_PAIRS.asr),
  search: keyFace(PROVIDER_FAMILY_KEY_PAIRS.search),
  live: keyFace(PROVIDER_FAMILY_KEY_PAIRS.live)
};

const PROVIDER_FAMILIES = Object.keys(PROVIDER_FAMILY_STORAGE_KEYS) as ProviderFamily[];

const SETTINGS_DOMAIN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));

export type SnapshotDomain = ProviderFamily | "settings" | "searchOrder" | "searchHealth";

export interface SnapshotStorageKey {
  key: string;
  area: "sync" | "local";
  domain: SnapshotDomain;
}

export const SNAPSHOT_STORAGE_KEYS: readonly SnapshotStorageKey[] = Object.freeze([
  ...[...SETTINGS_DOMAIN_KEYS].map(
    (key): SnapshotStorageKey => ({ key, area: "sync", domain: "settings" })
  ),
  ...PROVIDER_FAMILIES.flatMap(
    (family): SnapshotStorageKey[] => [
      { key: PROVIDER_FAMILY_KEY_PAIRS[family].list, area: "sync", domain: family },
      { key: PROVIDER_FAMILY_KEY_PAIRS[family].keys, area: "local", domain: family },
      ...(PROVIDER_FAMILY_KEY_PAIRS[family].extraLocalKeys ?? []).map(
        (key): SnapshotStorageKey => ({ key, area: "local", domain: family })
      )
    ]
  ),
  { key: SEARCH_PROVIDER_ORDER_STORAGE, area: "sync", domain: "searchOrder" },
  { key: SEARCH_HEALTH_KEY, area: "local", domain: "searchHealth" }
]);

const SNAPSHOT_DOMAIN_BY_KEY: ReadonlyMap<string, SnapshotDomain> = new Map(
  SNAPSHOT_STORAGE_KEYS.map(({ key, domain }) => [key, domain] as const)
);

const SNAPSHOT_AREA_BY_KEY: ReadonlyMap<string, "sync" | "local"> = new Map(
  SNAPSHOT_STORAGE_KEYS.map(({ key, area }) => [key, area] as const)
);

interface FamilyStoreReader {
  loadProviders: () => Promise<Array<ProviderBase & { hasSavedKey: boolean }>>;
  loadKeys: () => Promise<ProviderKeys>;
}

const FAMILY_STORES: Record<ProviderFamily, FamilyStoreReader> = {
  ai: aiProviderStore,
  asr: asrProviderStore,
  search: searchProviderStore,
  live: liveProviderStore
};

let settingsCache: Promise<Settings> | null = null;
const familyCaches: Record<ProviderFamily, Promise<ProviderStoreSnapshot> | null> = {
  ai: null,
  asr: null,
  search: null,
  live: null
};
let searchOrderCache: Promise<unknown> | null = null;
let searchHealthCache: Promise<SearchHealthMap> | null = null;

export function getSettingsSnapshot(): Promise<Settings> {
  settingsCache ??= getMergedSettings();
  return settingsCache;
}

export function getProviderStore<F extends ProviderFamily>(
  family: F
): Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>> {
  const cached = familyCaches[family];
  if (cached) return cached as Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>>;
  const store = FAMILY_STORES[family];
  const read = Promise.all([store.loadProviders(), store.loadKeys()]).then(
    ([providers, keys]) => ({ providers, keys })
  );
  read.catch(() => {
    if (familyCaches[family] === read) familyCaches[family] = null;
  });
  familyCaches[family] = read;
  return read as Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>>;
}

export async function getSearchProviderOrder(): Promise<string[]> {
  try {
    searchOrderCache ??= withTimeout(
      chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]),
      5000,
      new Error("storage timeout")
    ).catch(() => undefined);
    const stored = (await searchOrderCache) as Record<string, unknown> | undefined;
    const { providers } = await getProviderStore("search");
    return normalizeSearchProviderOrder(
      stored?.[SEARCH_PROVIDER_ORDER_STORAGE],
      providers.map((provider) => provider.id)
    );
  } catch {
    return [];
  }
}

export async function getSearchHealth(): Promise<SearchHealthMap> {
  try {
    searchHealthCache ??= withTimeout(
      readSearchHealth(),
      5000,
      new Error("storage timeout")
    ).catch(() => ({}));
    return await searchHealthCache;
  } catch {
    return {};
  }
}

export function invalidate(storageKeys: readonly string[]): void {
  for (const key of storageKeys) {
    const domain = SNAPSHOT_DOMAIN_BY_KEY.get(key);
    if (domain === "settings") {
      settingsCache = null;
    } else if (domain === "searchOrder") {
      searchOrderCache = null;
    } else if (domain === "searchHealth") {
      searchHealthCache = null;
    } else if (domain) {
      familyCaches[domain] = null;
      if (domain === "ai") {
        familyCaches.search = null;
      }
    }
  }
}

export function invalidatingWrite<TArgs extends unknown[], TResult>(
  write: (...args: TArgs) => Promise<TResult>,
  storageKeys: readonly string[] | ((...args: TArgs) => readonly string[])
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    const result = await write(...args);
    invalidate(typeof storageKeys === "function" ? storageKeys(...args) : storageKeys);
    return result;
  };
}

export async function writeSnapshotKeys(changes: Record<string, unknown>): Promise<void> {
  const syncChanges: Record<string, unknown> = {};
  const localChanges: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    const area = SNAPSHOT_AREA_BY_KEY.get(key);
    if (!area) {
      throw new Error(`未知的设置快照键：${key}（键面见 SNAPSHOT_STORAGE_KEYS）`);
    }
    (area === "sync" ? syncChanges : localChanges)[key] = value;
  }
  const syncKeys = Object.keys(syncChanges);
  if (syncKeys.length > 0) {
    await chrome.storage.sync.set(syncChanges);
    invalidate(syncKeys);
  }
  const localKeys = Object.keys(localChanges);
  if (localKeys.length > 0) {
    await chrome.storage.local.set(localChanges);
    invalidate(localKeys);
  }
}

watchStorageKeys(
  (changes) => {
    invalidate(Object.keys(changes));
  },
  {
    sync: SNAPSHOT_STORAGE_KEYS.filter((entry) => entry.area === "sync").map((entry) => entry.key),
    local: SNAPSHOT_STORAGE_KEYS.filter((entry) => entry.area === "local").map((entry) => entry.key)
  }
);
