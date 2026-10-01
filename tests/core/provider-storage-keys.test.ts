// C4「设置快照键面单源」测试：六个 provider 存储键（ai/asr/search × list/keys）
// 的字面量真源上提到各 store 模块并导出，settings-snapshot 的族键面从单表派生。
// 断言两层：
//   1. 导出常量的值 = 既有存储键字面量（真源上提后字面量的唯一落点）；
//   2. 行为：store 读写与快照族键面都落在导出常量指定的键上（常量与工厂配置
//      必须同源——常量被改坏而配置没跟上时，这里红）。
// 既有域行为 pin 复用不重复：tests/core/ai-provider-store.normalize.test.ts:10 /
// tests/core/ai-provider-store.probe.test.ts:221 / tests/asr/asr-provider-store.test.ts:69,73 /
// tests/search/search-provider-store.test.ts:53-55。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const AI_PROVIDER = {
  id: "openai",
  presetId: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4o"],
  requiresKey: true,
  enabled: true
};

const ASR_PROVIDER = {
  id: "whisper",
  presetId: "custom",
  name: "Whisper",
  type: "openai-transcriptions",
  baseUrl: "https://api.example.com/v1",
  model: "whisper-1",
  enabled: true
};

const SEARCH_PROVIDER = {
  id: "tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

function pick(store: Record<string, unknown>, keys: unknown) {
  const names = Array.isArray(keys) ? keys : typeof keys === "object" && keys ? Object.keys(keys) : [keys];
  const out: Record<string, unknown> = {};
  for (const name of names) {
    if (typeof name === "string" && name in store) out[name] = store[name];
  }
  return out;
}

// 记录写入落点的 storage stub：set 直接并进内存表，用例按 Object.keys 断言键面。
function installStorageStub() {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: { lastError: null, getURL: (path: string) => `chrome-extension://test/${path}` },
    storage: {
      sync: {
        get: vi.fn(async (keys: unknown) => pick(sync, keys)),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(sync, obj); })
      },
      local: {
        get: vi.fn(async (keys: unknown) => pick(local, keys)),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj); })
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
  return { sync, local };
}

// 模块命名空间读常量：导出缺失时读到 undefined（在断言处红，而不是 import 期炸）。
async function keyConstants(path: string) {
  const mod = (await import(path)) as unknown as Record<string, unknown>;
  return mod;
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("六个键常量从各 store 模块导出且值 = 既有存储键", () => {
  it("ai 族：AI_PROVIDERS_STORAGE / AI_PROVIDER_KEYS_STORAGE", async () => {
    const mod = await keyConstants("../../extension/core/ai-provider-store.js");
    expect(mod.AI_PROVIDERS_STORAGE).toBe("aiProviders");
    expect(mod.AI_PROVIDER_KEYS_STORAGE).toBe("aiProviderKeys");
  });

  it("asr 族：ASR_PROVIDERS_STORAGE / ASR_PROVIDER_KEYS_STORAGE", async () => {
    const mod = await keyConstants("../../extension/asr/asr-provider-store.js");
    expect(mod.ASR_PROVIDERS_STORAGE).toBe("asrProviders");
    expect(mod.ASR_PROVIDER_KEYS_STORAGE).toBe("asrProviderKeys");
  });

  it("search 族：SEARCH_PROVIDERS_STORAGE / SEARCH_PROVIDER_KEYS_STORAGE（既有导出，不动）", async () => {
    const mod = await keyConstants("../../extension/search/search-provider-store.js");
    expect(mod.SEARCH_PROVIDERS_STORAGE).toBe("searchProviders");
    expect(mod.SEARCH_PROVIDER_KEYS_STORAGE).toBe("searchProviderKeys");
  });
});

describe("store 读写落在导出常量指定的键", () => {
  it("ai 族：列表进 sync 的 list 常量、明文 Key 只进 local 的 keys 常量", async () => {
    const { sync, local } = installStorageStub();
    const mod = await keyConstants("../../extension/core/ai-provider-store.js");
    const store = mod.aiProviderStore as { saveProviders: (items: unknown[]) => Promise<unknown> };

    await store.saveProviders([{ ...AI_PROVIDER, apiKey: "sk-test" }]);

    expect(Object.keys(sync)).toEqual([mod.AI_PROVIDERS_STORAGE]);
    expect(Object.keys(local)).toEqual([mod.AI_PROVIDER_KEYS_STORAGE]);
  });

  it("asr 族：列表进 sync 的 list 常量、明文 Key 只进 local 的 keys 常量", async () => {
    const { sync, local } = installStorageStub();
    const mod = await keyConstants("../../extension/asr/asr-provider-store.js");
    const store = mod.asrProviderStore as { saveProviders: (items: unknown[]) => Promise<unknown> };

    await store.saveProviders([{ ...ASR_PROVIDER, apiKey: "sk-asr" }]);

    expect(Object.keys(sync)).toEqual([mod.ASR_PROVIDERS_STORAGE]);
    expect(Object.keys(local)).toEqual([mod.ASR_PROVIDER_KEYS_STORAGE]);
  });

  it("search 族：列表进 sync 的 list 常量、明文 Key 只进 local 的 keys 常量", async () => {
    const { sync, local } = installStorageStub();
    const mod = await keyConstants("../../extension/search/search-provider-store.js");
    const store = mod.searchProviderStore as { saveProviders: (items: unknown[]) => Promise<unknown> };

    await store.saveProviders([{ ...SEARCH_PROVIDER, apiKey: "tvly-key" }]);

    expect(Object.keys(sync)).toEqual([mod.SEARCH_PROVIDERS_STORAGE]);
    expect(Object.keys(local)).toEqual([mod.SEARCH_PROVIDER_KEYS_STORAGE]);
  });
});

describe("settings-snapshot 族键面从键对表派生", () => {
  it("PROVIDER_FAMILY_STORAGE_KEYS 形状与值不变（list, keys 顺序）", async () => {
    installStorageStub();
    const snapshot = (await import("../../extension/core/settings-snapshot.js")) as unknown as Record<string, unknown>;
    expect(snapshot.PROVIDER_FAMILY_STORAGE_KEYS).toEqual({
      ai: ["aiProviders", "aiProviderKeys"],
      asr: ["asrProviders", "asrProviderKeys"],
      search: ["searchProviders", "searchProviderKeys"]
    });
  });

  it("族键面 = 各族导出常量的引用（派生而非第二份字面量）", async () => {
    installStorageStub();
    const snapshot = (await import("../../extension/core/settings-snapshot.js")) as unknown as Record<string, unknown>;
    const ai = await keyConstants("../../extension/core/ai-provider-store.js");
    const asr = await keyConstants("../../extension/asr/asr-provider-store.js");
    const search = await keyConstants("../../extension/search/search-provider-store.js");

    expect(snapshot.PROVIDER_FAMILY_STORAGE_KEYS).toEqual({
      ai: [ai.AI_PROVIDERS_STORAGE, ai.AI_PROVIDER_KEYS_STORAGE],
      asr: [asr.ASR_PROVIDERS_STORAGE, asr.ASR_PROVIDER_KEYS_STORAGE],
      search: [search.SEARCH_PROVIDERS_STORAGE, search.SEARCH_PROVIDER_KEYS_STORAGE]
    });
  });
});
