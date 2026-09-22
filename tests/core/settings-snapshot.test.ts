// extension/core/settings-snapshot.js 设置快照模块测试（sw-settings-snapshot 票）。
// 锁三族不变量：
//   1. 命中断言：快照建立后二次读取零 storage 调用（热路径 storage 读归 0）；
//   2. 写后读失效：invalidate(存储键) 后重读拿新值（写路径 inline 失效语义）；
//   3. onChanged 兜底：跨上下文/跨设备 sync 变更经真实 chrome.storage.onChanged
//      监听按键域失效（未订阅键不失效）。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款：
// 每用例重装 stub + 动态 import（vi.resetModules 换干净模块态）。

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

const SEARCH_PROVIDER = {
  id: "tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

function makeStub({ syncFixture = {}, localFixture = {} }: { syncFixture?: Record<string, unknown>; localFixture?: Record<string, unknown> } = {}) {
  return {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`
    },
    storage: {
      // get 的 keys 形状两种：数组（provider-store）与默认值对象
      // （getMergedSettings 传 DEFAULT_SETTINGS）——按请求键从 fixture 取值。
      sync: {
        get: vi.fn(async (keys: unknown) => {
          const requested = Array.isArray(keys) ? keys : typeof keys === "object" && keys ? Object.keys(keys) : [keys];
          const out: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in syncFixture) out[key] = syncFixture[key];
          }
          return out;
        }),
        set: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async (keys: unknown) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in localFixture) out[key] = localFixture[key];
          }
          return out;
        }),
        set: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  };
}

function storageGetCalls() {
  return (
    vi.mocked(chrome.storage.sync.get).mock.calls.length +
    vi.mocked(chrome.storage.local.get).mock.calls.length
  );
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("命中断言：快照建立后二次读取零 storage 调用", () => {
  it("getSettings 二次读取零 storage 调用，归一化产物一致", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { defaultModel: "openai", webSearchMaxToolCalls: 7 }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    const first = await snapshot.getSettings();
    expect(first.defaultModel).toBe("openai");
    expect(storageGetCalls()).toBeGreaterThan(0);

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const second = await snapshot.getSettings();
    expect(second).toEqual(first);
    expect(storageGetCalls()).toBe(0);
  });

  it("getProviderStore 二次读取零 storage 调用，providers 带 hasSavedKey 装配产物", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { aiProviders: [AI_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-test" } }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    const first = await snapshot.getProviderStore("ai");
    expect(first.providers).toEqual([{ ...AI_PROVIDER, hasSavedKey: true }]);
    expect(first.keys).toEqual({ openai: "sk-test" });

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const second = await snapshot.getProviderStore("ai");
    expect(second).toEqual(first);
    expect(storageGetCalls()).toBe(0);
  });

  it("三族快照互不影响：读 ai 不建立 asr/search 缓存", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { aiProviders: [AI_PROVIDER], searchProviders: [SEARCH_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-test" }, searchProviderKeys: {} }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();

    // ai 重读仍零调用（命中），且证明读 ai 时未顺带建立 search 缓存：
    // 首次读 search 必然发生 storage 调用
    await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBe(0);
    await snapshot.getProviderStore("search");
    expect(storageGetCalls()).toBeGreaterThan(0);
  });
});

describe("写后读失效：invalidate(存储键) 后重读拿新值", () => {
  it("失效 settings 键：getSettings 重读存储", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettings();

    // 模拟 save-settings 写后 inline 失效
    snapshot.invalidate(["defaultModel"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    const reloaded = await snapshot.getSettings();
    expect(reloaded.defaultModel).toBe("openai");
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();

    // 未命中已知域的键（白名单外的 payload 键）不引起失效也不抛错
    snapshot.invalidate(["someUnknownKey"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettings();
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });

  it("失效 family 列表键或 Keys 键：getProviderStore 重读存储", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { aiProviders: [AI_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-test" } }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");

    snapshot.invalidate(["aiProviders"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);

    await snapshot.getProviderStore("ai");
    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    snapshot.invalidate(["aiProviderKeys"]);
    await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);
  });

  it("域隔离：失效 ai 不清 asr/search 缓存", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { aiProviders: [AI_PROVIDER], searchProviders: [] },
      localFixture: { aiProviderKeys: {}, searchProviderKeys: {} }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    await snapshot.getProviderStore("search");

    snapshot.invalidate(["aiProviders"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();

    await snapshot.getProviderStore("search");
    expect(storageGetCalls()).toBe(0);
  });
});

describe("onChanged 兜底：跨上下文/跨设备变更按键域失效", () => {
  // 模块经 shared/watch-storage-keys 懒注册真实 onChanged 监听：捕获 stub 上的
  // addListener 回调直调（与生产触发路径一致，无绕过 API 的捷径）。
  function fireOnChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    listener(changes, areaName);
  }

  it("sync 区 settings 键变更 → settings 快照失效", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettings();
    fireOnChanged({ defaultModel: { newValue: "other" } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettings();
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();
  });

  it("local 区 providerKeys 变更 → family 快照失效（sync 区 provider 列表键同理）", async () => {
    const syncFixture = { aiProviders: [AI_PROVIDER] };
    const localFixture = { aiProviderKeys: { openai: "sk-test" } };
    vi.stubGlobal("chrome", makeStub({ syncFixture, localFixture }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    // 跨设备 sync 落盘先到 storage 再到 onChanged：fixture 先行变更，再触发事件
    localFixture.aiProviderKeys = { openai: "sk-new" };
    fireOnChanged({ aiProviderKeys: { newValue: { openai: "sk-new" } } }, "local");

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const reloaded = await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);
    expect(reloaded.keys).toEqual({ openai: "sk-new" });
  });

  it("未订阅键变更 → 缓存不失效（零 storage 重读）", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettings();
    // segment-cache 等 local 写、键面外 sync 键不在订阅键面内（enableDebugLogs
    // 是 settings 键面成员，会被正常失效）
    fireOnChanged({ someSegment: { newValue: {} } }, "local");
    fireOnChanged({ unknownSyncKey: { newValue: true } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettings();
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });
});
