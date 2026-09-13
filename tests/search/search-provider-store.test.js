// searchProviderStore 测试：锁定搜索平台专属 storage key（searchProviders /
// searchProviderKeys）与 Key 双存储不变式（列表进 sync、明文 Key 只进 local，
// 列表只带 hasSavedKey 占位，删除清孤儿 Key）。工厂本体契约见
// tests/core/provider-store.test.js，此处只锁搜索域绑定。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { searchProviderStore } from "../../extension/search/search-provider-store.js";

let syncStorage;
let localStorage;

beforeEach(() => {
  resetModuleState();
  syncStorage = {};
  localStorage = {};
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        get: vi.fn(async (keys) => {
          const out = {};
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = syncStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(syncStorage, obj); })
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys) => {
          const out = {};
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

describe("searchProviderStore", () => {
  it("列表存 sync 的 searchProviders，明文 Key 只存 local 的 searchProviderKeys", async () => {
    await searchProviderStore.saveProviders([
      { id: "search_1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "tk_1" }
    ]);
    expect(syncStorage.searchProviders).toHaveLength(1);
    expect(JSON.stringify(syncStorage.searchProviders)).not.toContain("tk_1");
    expect(localStorage.searchProviderKeys.search_1).toBe("tk_1");
    const list = await searchProviderStore.loadProviders();
    expect(list).toEqual([
      { id: "search_1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true, hasSavedKey: true }
    ]);
  });

  it("保存时空 apiKey 沿用已存 Key 不清除", async () => {
    await searchProviderStore.saveProviders([
      { id: "search_1", presetId: "tavily", type: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com", apiKey: "tk_1" }
    ]);
    await searchProviderStore.saveProviders([
      { id: "search_1", presetId: "tavily", type: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com" }
    ]);
    const list = await searchProviderStore.loadProviders();
    expect(list[0].hasSavedKey).toBe(true);
  });

  it("未知 type 条目不入列表；删除清孤儿 Key", async () => {
    await searchProviderStore.saveProviders([
      { id: "a", presetId: "exa", type: "exa", name: "Exa", baseUrl: "https://api.exa.ai", apiKey: "ek_1" },
      { id: "bad", type: "serpapi", name: "坏条目", baseUrl: "https://x" }
    ]);
    expect((await searchProviderStore.loadProviders()).map((p) => p.id)).toEqual(["a"]);
    const rest = await searchProviderStore.deleteProvider("a");
    expect(rest).toEqual([]);
    expect(localStorage.searchProviderKeys).toEqual({});
  });
});
