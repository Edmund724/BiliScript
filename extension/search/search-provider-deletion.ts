import { SEARCH_PROVIDER_ORDER_STORAGE, searchProviderStore } from "./search-provider-store.js";
import { clearSearchCache } from "./search-cache.js";
import { logWarn } from "../shared/logging.js";
import type { SearchProviderListEntry } from "../shared/messaging-protocol.js";

export interface DeleteSearchProviderDeps {
  deleteProvider?: (providerId: string) => Promise<SearchProviderListEntry[]>;
  invalidatingWrite?: (
    write: (providerId: string) => Promise<SearchProviderListEntry[]>,
    storageKeys: readonly string[]
  ) => (providerId: string) => Promise<SearchProviderListEntry[]>;
  storageKeys?: readonly string[];
  writeSnapshotKeys?: (changes: Record<string, unknown>) => Promise<void>;
  getSyncStorage?: (keys: string[]) => Promise<Record<string, unknown>>;
  clearCache?: () => Promise<void>;
  logWarn?: (message: string, error?: unknown) => void;
}

export interface PruneSearchProviderOrderDeps {
  getSyncStorage?: (keys: string[]) => Promise<Record<string, unknown>>;
  writeSnapshotKeys?: (changes: Record<string, unknown>) => Promise<void>;
}

export async function pruneSearchProviderOrder(
  providerId: string,
  deps: PruneSearchProviderOrderDeps = {}
): Promise<void> {
  const getSync =
    deps.getSyncStorage ??
    (async (keys: string[]) => {
      if (typeof chrome !== "undefined" && chrome?.storage?.sync?.get) {
        return chrome.storage.sync.get(keys);
      }
      return {};
    });
  const stored = await getSync([SEARCH_PROVIDER_ORDER_STORAGE]);
  const raw = stored?.[SEARCH_PROVIDER_ORDER_STORAGE];
  if (!Array.isArray(raw) || !raw.includes(providerId)) return;
  const writeSnapshot =
    deps.writeSnapshotKeys ??
    (async (changes: Record<string, unknown>) => {
      if (typeof chrome !== "undefined" && chrome?.storage?.sync?.set) {
        await chrome.storage.sync.set(changes);
        return;
      }
      throw new Error("缺少 writeSnapshotKeys 或 chrome.storage.sync 依赖");
    });
  await writeSnapshot({
    [SEARCH_PROVIDER_ORDER_STORAGE]: raw.filter((id) => id !== providerId)
  });
}

export function deleteSearchProviderAndClearCache(
  deps: DeleteSearchProviderDeps = {}
): (providerId: string) => Promise<SearchProviderListEntry[]> {
  return async (providerId: string): Promise<SearchProviderListEntry[]> => {
    const rawDelete = deps.deleteProvider ?? searchProviderStore.deleteProvider;
    const doDelete =
      deps.invalidatingWrite && deps.storageKeys
        ? deps.invalidatingWrite(rawDelete, deps.storageKeys)
        : rawDelete;
    const providers = await doDelete(providerId);

    try {
      await pruneSearchProviderOrder(providerId, {
        getSyncStorage: deps.getSyncStorage,
        writeSnapshotKeys: deps.writeSnapshotKeys
      });
    } catch (error) {
      const warn = deps.logWarn ?? logWarn;
      warn("[BILISCRIPT] search provider order prune on provider delete failed", error);
    }

    try {
      const clear = deps.clearCache ?? clearSearchCache;
      await clear();
    } catch (error) {
      const warn = deps.logWarn ?? logWarn;
      warn("[BILISCRIPT] search cache clear on provider delete failed", error);
    }

    return providers;
  };
}
