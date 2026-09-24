// asr-provider-store.js 测试：锁定 ASR 平台专属 storage key（asrProviders /
// asrProviderKeys）与 ASR 域归一化（非法 type 丢弃）。工厂本体契约见
// tests/core/provider-store.test.ts，此处只锁 ASR 域绑定。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let syncStorage: Record<string, any>;
let localStorage: Record<string, any>;

async function loadModule() {
  return import("../../extension/asr/asr-provider-store.js");
}

beforeEach(() => {
  vi.resetModules();
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
          const out: Record<string, any> = {};
          // chrome.storage.get 签名支持 string | string[] | object，这里覆盖数组形式
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = syncStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(syncStorage, obj); })
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys) => {
          const out: Record<string, any> = {};
          // chrome.storage.get 签名支持 string | string[] | object，这里覆盖数组形式
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

function baseProvider(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    presetId: "custom",
    name: "P " + id,
    type: "openai-transcriptions",
    baseUrl: "https://example.com/v1",
    model: "m",
    ...overrides
  };
}

describe("asrProviderStore.loadProviders / saveProviders", () => {
  it("保存后读取返回列表，apiKey 不明文出现在 sync 存储", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), apiKey: "secret-key-1" }
    ]);
    // sync 存储里只有 provider 列表，不含 apiKey 字段
    expect(syncStorage.asrProviders).toHaveLength(1);
    expect(syncStorage.asrProviders[0].id).toBe("p1");
    expect(syncStorage.asrProviders[0]).not.toHaveProperty("apiKey");
    // Key 单独存放在 local
    expect(localStorage.asrProviderKeys).toEqual({ p1: "secret-key-1" });

    const list = await asrProviderStore.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
    expect(list[0].hasSavedKey).toBe(true);
    expect(list[0]).not.toHaveProperty("apiKey");
  });

  it("保存时归一化字段：非法 type 的项被丢弃", async () => {
    const { asrProviderStore } = await loadModule();
    await asrProviderStore.saveProviders([
      { ...baseProvider("p1"), type: "bad-type" },
      { ...baseProvider("p2"), type: "openai-transcriptions" }
    ]);
    const list = await asrProviderStore.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p2");
  });
});
