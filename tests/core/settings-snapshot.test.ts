import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import {
  AI_PROVIDER_KEYS_STORAGE,
  AI_PROVIDERS_STORAGE,
  AI_PROVIDER_MODELS_LOCAL_KEY
} from "../../extension/core/ai-provider-store.js";
import { ASR_PROVIDER_KEYS_STORAGE, ASR_PROVIDERS_STORAGE } from "../../extension/asr/asr-provider-store.js";
import {
  SEARCH_PROVIDER_KEYS_STORAGE,
  SEARCH_PROVIDERS_STORAGE,
  SEARCH_PROVIDER_ORDER_STORAGE
} from "../../extension/search/search-provider-store.js";
import { SEARCH_HEALTH_KEY } from "../../extension/search/search-health.js";
import { LIVE_PROVIDER_KEYS_STORAGE, LIVE_PROVIDERS_STORAGE } from "../../extension/live/live-provider-store.js";

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

const LIVE_PROVIDER = {
  id: "moss-live",
  presetId: "moss-live",
  name: "MOSS-LIVE",
  type: "moss-live",
  baseUrl: "https://api.mosi.cn",
  model: "moss-live-1.0",
  requiresKey: true,
  enabled: true
};

function makeStub({ syncFixture = {}, localFixture = {} }: { syncFixture?: Record<string, unknown>; localFixture?: Record<string, unknown> } = {}) {
  return {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`
    },
    storage: {
      sync: {
        get: vi.fn(async (keys: unknown) => {
          const requested = Array.isArray(keys) ? keys : typeof keys === "object" && keys ? Object.keys(keys) : [keys];
          const out: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in syncFixture) out[key] = syncFixture[key];
          }
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(syncFixture, obj);
        })
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
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(localFixture, obj);
        })
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
  it("getSettingsSnapshot 二次读取零 storage 调用，归一化产物一致", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { defaultModel: "openai", webSearchMaxToolCalls: 7 }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    const first = await snapshot.getSettingsSnapshot();
    expect(first.defaultModel).toBe("openai");
    expect(storageGetCalls()).toBeGreaterThan(0);

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const second = await snapshot.getSettingsSnapshot();
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

    await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBe(0);
    await snapshot.getProviderStore("search");
    expect(storageGetCalls()).toBeGreaterThan(0);
  });
});

describe("写后读失效：invalidate(存储键) 后重读拿新值", () => {
  it("失效 settings 键：getSettingsSnapshot 重读存储", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettingsSnapshot();

    snapshot.invalidate(["defaultModel"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    const reloaded = await snapshot.getSettingsSnapshot();
    expect(reloaded.defaultModel).toBe("openai");
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();

    snapshot.invalidate(["someUnknownKey"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettingsSnapshot();
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

  it("域隔离 + 凭据引用例外：失效 ai 连带清 search（DeepSeek 链 Key 读 AI 族），不清 asr", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { aiProviders: [AI_PROVIDER], asrProviders: [ASR_PROVIDER], searchProviders: [] },
      localFixture: { aiProviderKeys: {}, asrProviderKeys: {}, searchProviderKeys: {} }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    await snapshot.getProviderStore("asr");
    await snapshot.getProviderStore("search");

    snapshot.invalidate(["aiProviders"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();

    await snapshot.getProviderStore("asr");
    expect(storageGetCalls()).toBe(0);

    await snapshot.getProviderStore("search");
    expect(storageGetCalls()).toBeGreaterThan(0);
  });
});

describe("onChanged 兜底：跨上下文/跨设备变更按键域失效", () => {
  function fireOnChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    listener(changes, areaName);
  }

  it("sync 区 settings 键变更 → settings 快照失效", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettingsSnapshot();
    fireOnChanged({ defaultModel: { newValue: "other" } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettingsSnapshot();
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();
  });

  it("local 区 providerKeys 变更 → family 快照失效", async () => {
    const syncFixture = { aiProviders: [AI_PROVIDER] };
    const localFixture = { aiProviderKeys: { openai: "sk-test" } };
    vi.stubGlobal("chrome", makeStub({ syncFixture, localFixture }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    localFixture.aiProviderKeys = { openai: "sk-new" };
    fireOnChanged({ aiProviderKeys: { newValue: { openai: "sk-new" } } }, "local");

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const reloaded = await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);
    expect(reloaded.keys).toEqual({ openai: "sk-new" });
  });

  it("sync 区 provider 列表键变更 → family 快照失效（收编原用例标题声称的覆盖）", async () => {
    const syncFixture: Record<string, unknown> = { aiProviders: [AI_PROVIDER] };
    vi.stubGlobal("chrome", makeStub({ syncFixture, localFixture: { aiProviderKeys: { openai: "sk-test" } } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    syncFixture.aiProviders = [{ ...AI_PROVIDER, name: "OpenAI 2" }];
    fireOnChanged({ aiProviders: { newValue: syncFixture.aiProviders } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const reloaded = await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);
    expect(reloaded.providers[0].name).toBe("OpenAI 2");
  });

  it("四族 × 两区：list 键 fire 在 sync、keys 键 fire 在 local → 对应族失效（分区约定）", async () => {
    const cases = [
      {
        family: "ai",
        syncFixture: { aiProviders: [AI_PROVIDER] },
        localFixture: { aiProviderKeys: { openai: "sk-test" } },
        listKey: "aiProviders",
        keysKey: "aiProviderKeys"
      },
      {
        family: "asr",
        syncFixture: { asrProviders: [ASR_PROVIDER] },
        localFixture: { asrProviderKeys: { whisper: "sk-asr" } },
        listKey: "asrProviders",
        keysKey: "asrProviderKeys"
      },
      {
        family: "search",
        syncFixture: { searchProviders: [SEARCH_PROVIDER] },
        localFixture: { searchProviderKeys: { tavily: "tvly-key" } },
        listKey: "searchProviders",
        keysKey: "searchProviderKeys"
      },
      {
        family: "live",
        syncFixture: { liveProviders: [LIVE_PROVIDER] },
        localFixture: { liveProviderKeys: { "moss-live": "sk-live" } },
        listKey: "liveProviders",
        keysKey: "liveProviderKeys"
      }
    ] as const;

    for (const entry of cases) {
      for (const area of ["sync", "local"] as const) {
        const key = area === "sync" ? entry.listKey : entry.keysKey;
        resetModuleState();
        vi.stubGlobal("chrome", makeStub({
          syncFixture: { ...entry.syncFixture },
          localFixture: { ...entry.localFixture }
        }));
        const snapshot = await import("../../extension/core/settings-snapshot.js");

        await snapshot.getProviderStore(entry.family);
        fireOnChanged({ [key]: { newValue: {} } }, area);

        vi.mocked(chrome.storage.sync.get).mockClear();
        vi.mocked(chrome.storage.local.get).mockClear();
        await snapshot.getProviderStore(entry.family);
        expect(storageGetCalls(), `${entry.family} 族的 ${key}（${area} 区）应使该族快照失效`).toBeGreaterThan(0);
      }
    }
  });

  it("未订阅键变更 → 缓存不失效（零 storage 重读）", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettingsSnapshot();
    fireOnChanged({ someSegment: { newValue: {} } }, "local");
    fireOnChanged({ unknownSyncKey: { newValue: true } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettingsSnapshot();
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });
});

describe("order 快照位：searchProviderOrder（spec §12.3 / §12.5 第 9 行）", () => {
  const ORDER_RECORDS = [
    {
      id: "search_firecrawl",
      presetId: "firecrawl",
      name: "Firecrawl",
      type: "firecrawl",
      baseUrl: "https://api.firecrawl.dev",
      enabled: true
    },
    SEARCH_PROVIDER
  ];

  function stubWithOrder(order?: unknown) {
    const syncFixture: Record<string, unknown> = { searchProviders: ORDER_RECORDS };
    if (order !== undefined) syncFixture.searchProviderOrder = order;
    vi.stubGlobal("chrome", makeStub({ syncFixture, localFixture: { searchProviderKeys: {} } }));
  }

  it("归一：数组内全为在册记录 id → 原样返回；键缺席 → []", async () => {
    stubWithOrder(["search_firecrawl", "tavily"]);
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    expect(await snapshot.getSearchProviderOrder()).toEqual(["search_firecrawl", "tavily"]);

    resetModuleState();
    stubWithOrder();
    const fresh = await import("../../extension/core/settings-snapshot.js");
    expect(await fresh.getSearchProviderOrder()).toEqual([]);
  });

  it("脏值整体作废（非数组 / 未知 id / 重复 id / 元素非字符串）→ []", async () => {
    for (const order of ["tavily", 7, ["tavily", "search_ghost"], ["tavily", "tavily"], ["tavily", 7]]) {
      resetModuleState();
      stubWithOrder(order);
      const snapshot = await import("../../extension/core/settings-snapshot.js");
      expect(await snapshot.getSearchProviderOrder()).toEqual([]);
    }
  });

  it("读失败 → []（快照不抛，顺序读失败按无自定义顺序）", async () => {
    stubWithOrder(["tavily"]);
    vi.mocked(chrome.storage.sync.get).mockRejectedValue(new Error("storage down"));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await expect(snapshot.getSearchProviderOrder()).resolves.toEqual([]);
  });

  it("二次读取零 storage 调用；invalidate 该键后重读", async () => {
    stubWithOrder(["search_firecrawl", "tavily"]);
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    const first = await snapshot.getSearchProviderOrder();
    expect(first).toEqual(["search_firecrawl", "tavily"]);

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    expect(await snapshot.getSearchProviderOrder()).toEqual(first);
    expect(storageGetCalls()).toBe(0);

    snapshot.invalidate(["searchProviderOrder"]);
    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSearchProviderOrder();
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();
  });

  it("跨上下文：onChanged sync 区该键变更 → 快照失效重读", async () => {
    stubWithOrder(["tavily"]);
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSearchProviderOrder();

    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    listener({ searchProviderOrder: { newValue: ["search_firecrawl", "tavily"] } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSearchProviderOrder();
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();
  });
});

type SnapshotModule = typeof import("../../extension/core/settings-snapshot.js");
type SnapshotDomainName = "settings" | "ai" | "asr" | "search" | "live" | "searchOrder" | "searchHealth";

const DOMAIN_PROBE_ORDER: readonly SnapshotDomainName[] = [
  "settings",
  "ai",
  "asr",
  "search",
  "live",
  "searchHealth",
  "searchOrder"
];

const FAMILY_LIST_STORAGE: Record<string, string> = {
  ai: AI_PROVIDERS_STORAGE,
  asr: ASR_PROVIDERS_STORAGE,
  search: SEARCH_PROVIDERS_STORAGE,
  live: LIVE_PROVIDERS_STORAGE
};
const FAMILY_KEYS_STORAGE: Record<string, string> = {
  ai: AI_PROVIDER_KEYS_STORAGE,
  asr: ASR_PROVIDER_KEYS_STORAGE,
  search: SEARCH_PROVIDER_KEYS_STORAGE,
  live: LIVE_PROVIDER_KEYS_STORAGE
};

function allDomainFixtures() {
  return {
    syncFixture: {
      defaultModel: "openai",
      [AI_PROVIDERS_STORAGE]: [AI_PROVIDER],
      [ASR_PROVIDERS_STORAGE]: [ASR_PROVIDER],
      [SEARCH_PROVIDERS_STORAGE]: [SEARCH_PROVIDER],
      [LIVE_PROVIDERS_STORAGE]: [LIVE_PROVIDER],
      [SEARCH_PROVIDER_ORDER_STORAGE]: []
    },
    localFixture: {
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-ai" },
      [ASR_PROVIDER_KEYS_STORAGE]: { whisper: "sk-asr" },
      [SEARCH_PROVIDER_KEYS_STORAGE]: { tavily: "sk-search" },
      [LIVE_PROVIDER_KEYS_STORAGE]: { "moss-live": "sk-live" },
      [SEARCH_HEALTH_KEY]: {}
    }
  };
}

async function warmAllDomains(snapshot: SnapshotModule): Promise<void> {
  await snapshot.getSettingsSnapshot();
  await snapshot.getProviderStore("ai");
  await snapshot.getProviderStore("asr");
  await snapshot.getProviderStore("search");
  await snapshot.getProviderStore("live");
  await snapshot.getSearchProviderOrder();
  await snapshot.getSearchHealth();
}

async function readDomain(snapshot: SnapshotModule, domain: SnapshotDomainName): Promise<void> {
  if (domain === "settings") await snapshot.getSettingsSnapshot();
  else if (domain === "searchOrder") await snapshot.getSearchProviderOrder();
  else if (domain === "searchHealth") await snapshot.getSearchHealth();
  else await snapshot.getProviderStore(domain);
}

function syncGetArgs(): unknown[] {
  return vi.mocked(chrome.storage.sync.get).mock.calls.map((call) => call[0]);
}
function localGetArgs(): unknown[] {
  return vi.mocked(chrome.storage.local.get).mock.calls.map((call) => call[0]);
}
function readKeysInclude(args: unknown[], storageKey: string): boolean {
  return args.some((arg) => Array.isArray(arg) && arg.includes(storageKey));
}

async function domainWasInvalidated(snapshot: SnapshotModule, domain: SnapshotDomainName): Promise<boolean> {
  vi.mocked(chrome.storage.sync.get).mockClear();
  vi.mocked(chrome.storage.local.get).mockClear();
  await readDomain(snapshot, domain);
  const syncArgs = syncGetArgs();
  const localArgs = localGetArgs();
  switch (domain) {
    case "settings":
      return syncArgs.some((arg) => Boolean(arg) && typeof arg === "object" && !Array.isArray(arg));
    case "searchOrder":
      return readKeysInclude(syncArgs, SEARCH_PROVIDER_ORDER_STORAGE);
    case "searchHealth":
      return localArgs.some((arg) => typeof arg === "string");
    default:
      return (
        readKeysInclude(syncArgs, FAMILY_LIST_STORAGE[domain]) ||
        readKeysInclude(localArgs, FAMILY_KEYS_STORAGE[domain])
      );
  }
}

async function invalidatedDomains(snapshot: SnapshotModule): Promise<SnapshotDomainName[]> {
  const missed: SnapshotDomainName[] = [];
  for (const domain of DOMAIN_PROBE_ORDER) {
    if (await domainWasInvalidated(snapshot, domain)) missed.push(domain);
  }
  return missed;
}

describe("写入口：落盘 + 失效一次做完（invalidatingWrite）", () => {
  it("失效时机 = 落盘 await 完成之后（写未落地时缓存仍命中）", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    await snapshot.getSettingsSnapshot();

    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = snapshot.invalidatingWrite(() => landed, ["defaultModel"]);
    const writing = write();

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettingsSnapshot();
    expect(vi.mocked(chrome.storage.sync.get), "落盘未完成前不得失效").not.toHaveBeenCalled();

    release();
    await writing;
    await snapshot.getSettingsSnapshot();
    expect(vi.mocked(chrome.storage.sync.get), "落盘完成即失效").toHaveBeenCalled();
  });

  it("透传落盘返回值（provider CRUD 的回包负载取它）", async () => {
    vi.stubGlobal("chrome", makeStub());
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    const write = snapshot.invalidatingWrite(async () => [{ id: "openai", hasSavedKey: true }], ["aiProviders"]);
    await expect(write()).resolves.toEqual([{ id: "openai", hasSavedKey: true }]);
  });

  it("落盘失败：原样 reject 且不失效（没落地就没有要作废的读缓存）", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    await snapshot.getSettingsSnapshot();

    const write = snapshot.invalidatingWrite(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    }, ["defaultModel"]);
    await expect(write()).rejects.toThrow("QUOTA_BYTES quota exceeded");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettingsSnapshot();
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });

  it("族键面形态：包住 store 的 saveProviders 后重读命中新列表与新 Key", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { [AI_PROVIDERS_STORAGE]: [AI_PROVIDER] },
      localFixture: { [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-old" } }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    const store = await import("../../extension/core/ai-provider-store.js");

    await snapshot.getProviderStore("ai");
    const save = snapshot.invalidatingWrite(
      store.aiProviderStore.saveProviders,
      snapshot.PROVIDER_FAMILY_STORAGE_KEYS.ai
    );
    await save([{ ...AI_PROVIDER, apiKey: "sk-new" }]);

    const after = await snapshot.getProviderStore("ai");
    expect(after.keys).toEqual({ openai: "sk-new" });
  });

  it("派生键面形态（save-settings 的 payload 键集同款）：写什么键失效什么域", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    await snapshot.getSettingsSnapshot();

    const saveSettingsWithInvalidate = snapshot.invalidatingWrite(
      async (payload: Record<string, unknown>) => {
        await chrome.storage.sync.set(payload);
      },
      (payload: Record<string, unknown>) => Object.keys(payload)
    );
    await saveSettingsWithInvalidate({ defaultModel: "anthropic" });

    expect(await snapshot.getSettingsSnapshot()).toMatchObject({ defaultModel: "anthropic" });
  });
});

describe("裸落盘入口：writeSnapshotKeys（区由键面表决定，写后立即失效）", () => {
  it("逐键落区：sync 键进 sync 区、local 键进 local 区，调用方不报区", async () => {
    vi.stubGlobal("chrome", makeStub());
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.writeSnapshotKeys({
      defaultModel: "anthropic",
      [AI_PROVIDERS_STORAGE]: [AI_PROVIDER],
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-new" },
      [SEARCH_HEALTH_KEY]: {}
    });

    expect(vi.mocked(chrome.storage.sync.set)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chrome.storage.sync.set)).toHaveBeenCalledWith({
      defaultModel: "anthropic",
      [AI_PROVIDERS_STORAGE]: [AI_PROVIDER]
    });
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-new" },
      [SEARCH_HEALTH_KEY]: {}
    });
  });

  it("落盘后立即失效：写后读拿到新值（settings / ai 族各一次）", async () => {
    vi.stubGlobal("chrome", makeStub({
      syncFixture: { defaultModel: "openai", [AI_PROVIDERS_STORAGE]: [AI_PROVIDER] },
      localFixture: { [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-old" } }
    }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSettingsSnapshot();
    await snapshot.getProviderStore("ai");

    await snapshot.writeSnapshotKeys({
      defaultModel: "anthropic",
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-new" }
    });

    expect((await snapshot.getSettingsSnapshot()).defaultModel).toBe("anthropic");
    expect((await snapshot.getProviderStore("ai")).keys).toEqual({ openai: "sk-new" });
  });

  it("未知键抛错且零落盘（区不可推导，不猜一个区落在半路）", async () => {
    vi.stubGlobal("chrome", makeStub());
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await expect(
      snapshot.writeSnapshotKeys({ defaultModel: "anthropic", someUnknownKey: 1 })
    ).rejects.toThrow(/未知的设置快照键/);

    expect(vi.mocked(chrome.storage.sync.set)).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();
  });

  it("落盘失败：原样 reject 且不失效（没落地就没有要作废的读缓存）", async () => {
    vi.stubGlobal("chrome", makeStub({ syncFixture: { defaultModel: "openai" } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");
    await snapshot.getSettingsSnapshot();

    vi.mocked(chrome.storage.sync.set).mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));
    await expect(snapshot.writeSnapshotKeys({ defaultModel: "anthropic" })).rejects.toThrow("QUOTA_BYTES");

    vi.mocked(chrome.storage.sync.get).mockClear();
    expect((await snapshot.getSettingsSnapshot()).defaultModel).toBe("openai");
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });
});

describe("键 → 域单源：SNAPSHOT_STORAGE_KEYS（invalidate 判据与 onChanged 订阅面共用）", () => {
  it("表 = 键面全集（settings 键面 ∪ 四族平台键 ∪ 搜索顺序 ∪ 健康度），键互异、区标注正确", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    const expected = [
      ...Object.keys(DEFAULT_SETTINGS).map((key) => ({ key, area: "sync", domain: "settings" })),
      { key: AI_PROVIDERS_STORAGE, area: "sync", domain: "ai" },
      { key: AI_PROVIDER_KEYS_STORAGE, area: "local", domain: "ai" },
      { key: AI_PROVIDER_MODELS_LOCAL_KEY, area: "local", domain: "ai" },
      { key: ASR_PROVIDERS_STORAGE, area: "sync", domain: "asr" },
      { key: ASR_PROVIDER_KEYS_STORAGE, area: "local", domain: "asr" },
      { key: SEARCH_PROVIDERS_STORAGE, area: "sync", domain: "search" },
      { key: SEARCH_PROVIDER_KEYS_STORAGE, area: "local", domain: "search" },
      { key: LIVE_PROVIDERS_STORAGE, area: "sync", domain: "live" },
      { key: LIVE_PROVIDER_KEYS_STORAGE, area: "local", domain: "live" },
      { key: SEARCH_PROVIDER_ORDER_STORAGE, area: "sync", domain: "searchOrder" },
      { key: SEARCH_HEALTH_KEY, area: "local", domain: "searchHealth" }
    ];
    const fingerprint = (rows: ReadonlyArray<{ key: string; area: string; domain: string }>) =>
      rows.map((row) => `${row.key}|${row.area}|${row.domain}`).sort();

    expect(fingerprint(SNAPSHOT_STORAGE_KEYS)).toEqual(fingerprint(expected));
    const keys = SNAPSHOT_STORAGE_KEYS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("逐键失效：invalidate 只清该键所属的域（表驱动，加键漏映射即红）；ai 域按凭据引用例外连带清 search", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    for (const entry of SNAPSHOT_STORAGE_KEYS) {
      resetModuleState();
      vi.stubGlobal("chrome", makeStub(allDomainFixtures()));
      const snapshot = await import("../../extension/core/settings-snapshot.js");
      await warmAllDomains(snapshot);

      snapshot.invalidate([entry.key]);

      const expected = entry.domain === "ai" ? ["ai", "search"] : [entry.domain];
      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 应且只应清 ${expected.join(" + ")}`
      ).toEqual(expected);
    }
  });

  it("逐键 onChanged：声明区命中即清该域，另一区的同一键不触发（表驱动，区写错即红）；ai 域连带清 search", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    for (const entry of SNAPSHOT_STORAGE_KEYS) {
      resetModuleState();
      vi.stubGlobal("chrome", makeStub(allDomainFixtures()));
      const snapshot = await import("../../extension/core/settings-snapshot.js");
      await warmAllDomains(snapshot);
      const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
      const expected = entry.domain === "ai" ? ["ai", "search"] : [entry.domain];

      listener({ [entry.key]: { newValue: null } }, entry.area === "sync" ? "local" : "sync");
      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 在另一区不应触发失效`
      ).toEqual([]);

      listener({ [entry.key]: { newValue: null } }, entry.area);
      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 应且只应清 ${expected.join(" + ")}`
      ).toEqual(expected);
    }
  });
});
