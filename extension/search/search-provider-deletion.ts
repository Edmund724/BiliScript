// extension/search/search-provider-deletion.ts
// 删除搜索平台记录 + 清空整张查询缓存（spec §6.7 / §10 第 40 行）：删除是撤回的
// 次入口（「不想这家收到」），删除本身走与 CRUD 同一条写后失效包装；清缓存失败
// 静默（logWarn 同既有形态），不影响删除回包。
// 另把该 id 从 searchProviderOrder 剔除（spec §12.2 末条 / §12.5 第 11 行）：不改的话
// 「删掉一个平台」会让顺序数组含未知 id → 整份自定义顺序被「脏值整体作废」丢掉。
// 仅在数组确实含该 id 时写回 + inline 失效（写回走 writeSnapshotKeys，落 sync 区与
// 失效键面都由快照表决定）；键缺席 / 脏值 / 写失败都静默跳过（顺序是偏好不是数据）。

import { SEARCH_PROVIDER_ORDER_STORAGE, searchProviderStore } from "./search-provider-store.js";
import { clearSearchCache } from "./search-cache.js";
import { logWarn } from "../shared/logging.js";
import type { SearchProviderListEntry } from "../shared/messaging-protocol.js";

export interface DeleteSearchProviderDeps {
  /** 包装了 invalidatingWrite 的 store 删除，或基础 deleteProvider 函数 */
  deleteProvider?: (providerId: string) => Promise<SearchProviderListEntry[]>;
  /** invalidatingWrite 包装器（可选，当外部传入原始 deleteProvider 与 storageKeys 时使用） */
  invalidatingWrite?: (
    write: (providerId: string) => Promise<SearchProviderListEntry[]>,
    storageKeys: readonly string[]
  ) => (providerId: string) => Promise<SearchProviderListEntry[]>;
  /** 失效键面（如 PROVIDER_FAMILY_STORAGE_KEYS.search） */
  storageKeys?: readonly string[];
  /** 裸 storage 写回并失效快照（默认 writeSnapshotKeys） */
  writeSnapshotKeys?: (changes: Record<string, unknown>) => Promise<void>;
  /** 读 chrome.storage.sync */
  getSyncStorage?: (keys: string[]) => Promise<Record<string, unknown>>;
  /** 清空搜索缓存（默认 clearSearchCache） */
  clearCache?: () => Promise<void>;
  /** 日志警告（默认 logWarn） */
  logWarn?: (message: string, error?: unknown) => void;
}

export interface PruneSearchProviderOrderDeps {
  getSyncStorage?: (keys: string[]) => Promise<Record<string, unknown>>;
  writeSnapshotKeys?: (changes: Record<string, unknown>) => Promise<void>;
}

/**
 * 顺序剔除：直读 sync 存储，仅在数组确实包含该 providerId 时写回。
 */
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

/**
 * 搜索平台删除撤回事务入口（spec §6.7 / §10 第 40 行）：
 * 串联 store 删除（支持 invalidatingWrite 包装）、顺序剔除与清空查询缓存。
 * 注入 primitive 与失效键面，返回供 CRUD 处理器挂接的 (providerId) => Promise<...> 函数。
 */
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
