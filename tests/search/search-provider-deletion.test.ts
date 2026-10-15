// tests/search/search-provider-deletion.test.ts
// 搜索平台删除撤回事务（spec §6.7 / §10 第 40 行）测试：
//   ① 正常路径：store 删除（带 invalidatingWrite 包装）→ 顺序剔除 → 清空缓存三步串联，回包为存活列表；
//   ② 顺序剔除失败静默：写回抛错 → 回包照常、logWarn 一次，清缓存照常执行；
//   ③ 清缓存失败静默：clearCache 抛错 → 回包照常、logWarn 一次；
//   ④ 顺序剔除短路：数组未含该 id / 存储非数组 → 不调用 writeSnapshotKeys；
//   ⑤ pruneSearchProviderOrder 纯逻辑单测：数组过滤与无匹配短路。

import { describe, expect, it, vi } from "vitest";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../../extension/search/search-provider-store.js";
import {
  deleteSearchProviderAndClearCache,
  pruneSearchProviderOrder
} from "../../extension/search/search-provider-deletion.js";
import type { SearchProviderListEntry } from "../../extension/shared/messaging-protocol.js";

const REMAINING_PROVIDERS: SearchProviderListEntry[] = [
  {
    id: "search_remaining",
    presetId: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com",
    enabled: true,
    hasSavedKey: true
  }
];

describe("deleteSearchProviderAndClearCache 撤回事务（spec §6.7 / §10 第 40 行）", () => {
  it("正常路径：三步按序执行，回包为删除后存活列表", async () => {
    const callOrder: string[] = [];
    const deleteProvider = vi.fn(async (id: string) => {
      callOrder.push(`delete:${id}`);
      return REMAINING_PROVIDERS;
    });
    const writeSnapshotKeys = vi.fn(async (changes: Record<string, unknown>) => {
      callOrder.push("prune");
      expect(changes).toEqual({
        [SEARCH_PROVIDER_ORDER_STORAGE]: ["search_remaining"]
      });
    });
    const getSyncStorage = vi.fn(async () => ({
      [SEARCH_PROVIDER_ORDER_STORAGE]: ["search_target", "search_remaining"]
    }));
    const clearCache = vi.fn(async () => {
      callOrder.push("clearCache");
    });
    const logWarn = vi.fn();

    const handler = deleteSearchProviderAndClearCache({
      deleteProvider,
      writeSnapshotKeys,
      getSyncStorage,
      clearCache,
      logWarn
    });
    const result = await handler("search_target");

    expect(callOrder).toEqual(["delete:search_target", "prune", "clearCache"]);
    expect(result).toBe(REMAINING_PROVIDERS);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("支持 invalidatingWrite 包装器与 storageKeys 注入", async () => {
    const rawDelete = vi.fn(async (_id: string) => REMAINING_PROVIDERS);
    const invalidatingWrite = vi.fn((fn: (id: string) => Promise<SearchProviderListEntry[]>, keys: readonly string[]) => {
      expect(keys).toEqual(["testStorageKey"]);
      return async (id: string) => {
        return fn(id);
      };
    });

    const handler = deleteSearchProviderAndClearCache({
      deleteProvider: rawDelete,
      invalidatingWrite,
      storageKeys: ["testStorageKey"],
      getSyncStorage: async () => ({ [SEARCH_PROVIDER_ORDER_STORAGE]: [] }),
      writeSnapshotKeys: async () => {},
      clearCache: async () => {}
    });

    const result = await handler("search_target");
    expect(invalidatingWrite).toHaveBeenCalledTimes(1);
    expect(rawDelete).toHaveBeenCalledWith("search_target");
    expect(result).toBe(REMAINING_PROVIDERS);
  });

  it("顺序剔除抛错静默：回包照常，logWarn 一次，清缓存照常执行", async () => {
    const pruneError = new Error("sync write failed");
    const writeSnapshotKeys = vi.fn(async () => {
      throw pruneError;
    });
    const getSyncStorage = vi.fn(async () => ({
      [SEARCH_PROVIDER_ORDER_STORAGE]: ["search_target"]
    }));
    const clearCache = vi.fn(async () => {});
    const logWarn = vi.fn();

    const handler = deleteSearchProviderAndClearCache({
      deleteProvider: async () => REMAINING_PROVIDERS,
      writeSnapshotKeys,
      getSyncStorage,
      clearCache,
      logWarn
    });
    const result = await handler("search_target");

    expect(result).toBe(REMAINING_PROVIDERS);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "[BILISCRIPT] search provider order prune on provider delete failed",
      pruneError
    );
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("清缓存抛错静默：回包照常，logWarn 一次", async () => {
    const cacheError = new Error("local remove failed");
    const clearCache = vi.fn(async () => {
      throw cacheError;
    });
    const logWarn = vi.fn();

    const handler = deleteSearchProviderAndClearCache({
      deleteProvider: async () => REMAINING_PROVIDERS,
      getSyncStorage: async () => ({ [SEARCH_PROVIDER_ORDER_STORAGE]: [] }),
      clearCache,
      logWarn
    });
    const result = await handler("search_target");

    expect(result).toBe(REMAINING_PROVIDERS);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "[BILISCRIPT] search cache clear on provider delete failed",
      cacheError
    );
  });

  it("store 删除本身抛错时不静默，后续步骤不执行", async () => {
    const storeError = new Error("store delete failed");
    const deleteProvider = vi.fn(async () => {
      throw storeError;
    });
    const clearCache = vi.fn(async () => {});
    const logWarn = vi.fn();

    const handler = deleteSearchProviderAndClearCache({
      deleteProvider,
      clearCache,
      logWarn
    });

    await expect(handler("search_target")).rejects.toThrow("store delete failed");

    expect(clearCache).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe("pruneSearchProviderOrder 顺序剔除逻辑", () => {
  it("数组包含该 providerId 时写回过滤后数组", async () => {
    const writeSnapshotKeys = vi.fn(async () => {});
    const getSyncStorage = vi.fn(async () => ({
      [SEARCH_PROVIDER_ORDER_STORAGE]: ["p1", "p2", "p3"]
    }));

    await pruneSearchProviderOrder("p2", {
      getSyncStorage,
      writeSnapshotKeys
    });

    expect(writeSnapshotKeys).toHaveBeenCalledWith({
      [SEARCH_PROVIDER_ORDER_STORAGE]: ["p1", "p3"]
    });
  });

  it("数组不含该 providerId 时短路，不调用 writeSnapshotKeys", async () => {
    const writeSnapshotKeys = vi.fn(async () => {});
    const getSyncStorage = vi.fn(async () => ({
      [SEARCH_PROVIDER_ORDER_STORAGE]: ["p1", "p3"]
    }));

    await pruneSearchProviderOrder("p2", {
      getSyncStorage,
      writeSnapshotKeys
    });

    expect(writeSnapshotKeys).not.toHaveBeenCalled();
  });

  it("存储值非数组时短路，不调用 writeSnapshotKeys", async () => {
    const writeSnapshotKeys = vi.fn(async () => {});
    for (const raw of [null, undefined, "p2", { 0: "p2" }, 123]) {
      const getSyncStorage = vi.fn(async () => ({
        [SEARCH_PROVIDER_ORDER_STORAGE]: raw
      }));

      await pruneSearchProviderOrder("p2", {
        getSyncStorage,
        writeSnapshotKeys
      });

      expect(writeSnapshotKeys).not.toHaveBeenCalled();
    }
  });
});
