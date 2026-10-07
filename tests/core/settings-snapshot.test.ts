// extension/core/settings-snapshot.js 设置快照模块测试（sw-settings-snapshot 票）。
// 锁四族不变量：
//   1. 命中断言：快照建立后二次读取零 storage 调用（热路径 storage 读归 0）；
//   2. 写后读失效：invalidate(存储键) 后重读拿新值（写路径 inline 失效语义）；
//   3. onChanged 兜底：跨上下文/跨设备 sync 变更经真实 chrome.storage.onChanged
//      监听按键域失效（未订阅键不失效）；
//   4. 写侧收口：两个落盘入口——invalidatingWrite（包住调用方给的落盘动作）与
//      writeSnapshotKeys（裸 storage 写：调用方只交「哪些键的新值」，区由键面表反查）
//      + 键 → 域 / 键 → 区唯一真源 SNAPSHOT_STORAGE_KEYS（invalidate 判据、onChanged
//      订阅面与落区判据共用一张表，逐键逐区表驱动）。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款：
// 每用例重装 stub + 动态 import（vi.resetModules 换干净模块态）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { AI_PROVIDER_KEYS_STORAGE, AI_PROVIDERS_STORAGE } from "../../extension/core/ai-provider-store.js";
import { ASR_PROVIDER_KEYS_STORAGE, ASR_PROVIDERS_STORAGE } from "../../extension/asr/asr-provider-store.js";
import {
  SEARCH_PROVIDER_KEYS_STORAGE,
  SEARCH_PROVIDERS_STORAGE,
  SEARCH_PROVIDER_ORDER_STORAGE
} from "../../extension/search/search-provider-store.js";
import { SEARCH_HEALTH_KEY } from "../../extension/search/search-health.js";

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

  it("local 区 providerKeys 变更 → family 快照失效", async () => {
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

  it("sync 区 provider 列表键变更 → family 快照失效（收编原用例标题声称的覆盖）", async () => {
    const syncFixture: Record<string, unknown> = { aiProviders: [AI_PROVIDER] };
    vi.stubGlobal("chrome", makeStub({ syncFixture, localFixture: { aiProviderKeys: { openai: "sk-test" } } }));
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getProviderStore("ai");
    // 跨设备 sync 落盘先到 storage 再到 onChanged：fixture 先行变更，再触发事件
    syncFixture.aiProviders = [{ ...AI_PROVIDER, name: "OpenAI 2" }];
    fireOnChanged({ aiProviders: { newValue: syncFixture.aiProviders } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const reloaded = await snapshot.getProviderStore("ai");
    expect(storageGetCalls()).toBeGreaterThan(0);
    expect(reloaded.providers[0].name).toBe("OpenAI 2");
  });

  it("三族 × 两区：list 键 fire 在 sync、keys 键 fire 在 local → 对应族失效（分区约定）", async () => {
    // 键面分区不是自由选择：watch-storage-keys 按区过滤，声明进错区的键在该区
    // 事件里被静默丢弃（shared/watch-storage-keys.ts:39-43）。逐族逐区各 fire 一次，
    // 谁把 list 键挪进 local（或反之）这里立刻红。
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

// spec §12.3 / §12.5 第 9 行：searchProviderOrder 是 sync 上的记录 id 数组偏好，
// 由本模块提供归一后的快照读（键缺席 = 无自定义顺序；脏值整体作废 → []；读失败 → []）。
// 归一判据要拿「当前记录集合」：本模块内部经 search 族快照取，两个位共享同一份缓存。
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

    // 面板直写 sync（content 有完整 storage 权限）后事件先到 storage 再到 onChanged
    const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    listener({ searchProviderOrder: { newValue: ["search_firecrawl", "tavily"] } }, "sync");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSearchProviderOrder();
    expect(vi.mocked(chrome.storage.sync.get)).toHaveBeenCalled();
  });
});

// ===== 写侧收口：写入口 + 键 → 域单源 =====
// 失败方式 → 用例对照：
//   ① 写点漏失效 → 脏读：写入口把「落盘」与「按键域失效」绑成一次调用，
//      时机用例（写未完成不失效 / 完成后立刻失效）+ background 的逐写点用例；
//   ② 键 → 域映射改一处漏一处：SNAPSHOT_STORAGE_KEYS 的表驱动用例（逐键失效、
//      逐键 onChanged、区标注、键互异）；
//   ③ 写点绕过写入口手抄 storage 键名：派生键面形态用例（写什么键失效什么域）
//      + tests/entry 的源码防线；
//   ④ onChanged 与 inline 失效两套判据分叉：订阅面与 invalidate 判据都由同一张
//      表派生，逐键 onChanged 用例与逐键失效用例吃同一份期望。
// 六个缓存域的探针口径（命中 = 该域特有的 storage.get 形态被打到）：
//   settings → 默认值对象形态；ai/asr/search → list 键数组 / keys 键数组；
//   searchOrder → order 键数组；searchHealth → local 单键字符串形态。
// 只看形态不看次数：order 读取会连带读 search 族，签名判别不受连带影响。
type SnapshotModule = typeof import("../../extension/core/settings-snapshot.js");
type SnapshotDomainName = "settings" | "ai" | "asr" | "search" | "searchOrder" | "searchHealth";

const DOMAIN_PROBE_ORDER: readonly SnapshotDomainName[] = [
  "settings",
  "ai",
  "asr",
  "search",
  "searchHealth",
  "searchOrder"
];

const FAMILY_LIST_STORAGE: Record<string, string> = {
  ai: AI_PROVIDERS_STORAGE,
  asr: ASR_PROVIDERS_STORAGE,
  search: SEARCH_PROVIDERS_STORAGE
};
const FAMILY_KEYS_STORAGE: Record<string, string> = {
  ai: AI_PROVIDER_KEYS_STORAGE,
  asr: ASR_PROVIDER_KEYS_STORAGE,
  search: SEARCH_PROVIDER_KEYS_STORAGE
};

// 六域同时可缓存的夹具（每域都有可读内容）。
function allDomainFixtures() {
  return {
    syncFixture: {
      defaultModel: "openai",
      [AI_PROVIDERS_STORAGE]: [AI_PROVIDER],
      [ASR_PROVIDERS_STORAGE]: [ASR_PROVIDER],
      [SEARCH_PROVIDERS_STORAGE]: [SEARCH_PROVIDER],
      [SEARCH_PROVIDER_ORDER_STORAGE]: []
    },
    localFixture: {
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-ai" },
      [ASR_PROVIDER_KEYS_STORAGE]: { whisper: "sk-asr" },
      [SEARCH_PROVIDER_KEYS_STORAGE]: { tavily: "sk-search" },
      [SEARCH_HEALTH_KEY]: {}
    }
  };
}

async function warmAllDomains(snapshot: SnapshotModule): Promise<void> {
  await snapshot.getSettings();
  await snapshot.getProviderStore("ai");
  await snapshot.getProviderStore("asr");
  await snapshot.getProviderStore("search");
  await snapshot.getSearchProviderOrder();
  await snapshot.getSearchHealth();
}

async function readDomain(snapshot: SnapshotModule, domain: SnapshotDomainName): Promise<void> {
  if (domain === "settings") await snapshot.getSettings();
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
      // getMergedSettings 传默认值对象：唯一以对象形态读 sync 的域
      return syncArgs.some((arg) => Boolean(arg) && typeof arg === "object" && !Array.isArray(arg));
    case "searchOrder":
      return readKeysInclude(syncArgs, SEARCH_PROVIDER_ORDER_STORAGE);
    case "searchHealth":
      // readSearchHealth 传单键字符串：唯一以字符串形态读 local 的域
      return localArgs.some((arg) => typeof arg === "string");
    default:
      return (
        readKeysInclude(syncArgs, FAMILY_LIST_STORAGE[domain]) ||
        readKeysInclude(localArgs, FAMILY_KEYS_STORAGE[domain])
      );
  }
}

// 探针本身会把命中的域重新暖上，故顺序固定 DOMAIN_PROBE_ORDER：order 的连带读
// search 族排在 search 之后，不会把 search 的冷读误记到 order 头上。
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
    await snapshot.getSettings();

    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = snapshot.invalidatingWrite(() => landed, ["defaultModel"]);
    const writing = write();

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettings();
    expect(vi.mocked(chrome.storage.sync.get), "落盘未完成前不得失效").not.toHaveBeenCalled();

    release();
    await writing;
    await snapshot.getSettings();
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
    await snapshot.getSettings();

    const write = snapshot.invalidatingWrite(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    }, ["defaultModel"]);
    await expect(write()).rejects.toThrow("QUOTA_BYTES quota exceeded");

    vi.mocked(chrome.storage.sync.get).mockClear();
    await snapshot.getSettings();
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
    await snapshot.getSettings();

    const saveSettingsWithInvalidate = snapshot.invalidatingWrite(
      async (payload: Record<string, unknown>) => {
        await chrome.storage.sync.set(payload);
      },
      (payload: Record<string, unknown>) => Object.keys(payload)
    );
    await saveSettingsWithInvalidate({ defaultModel: "anthropic" });

    expect(await snapshot.getSettings()).toMatchObject({ defaultModel: "anthropic" });
  });
});

// ===== 裸落盘入口：区由本模块的键面表决定（候选 7）=====
// 失败方式 → 用例对照：
//   ① 写点自己报区、报错区 → 事件被 onChanged 的区过滤静默丢弃：区不再是入参，
//      逐键落区用例钉住「键的 area 声明决定它落在哪个区」（表里改区即红）；
//   ② 裸写漏失效 → 脏读：写后读用例（三个域各一次）；
//   ③ 未知键没有可推导的区 → 抛错且零落盘（不猜一个区落在半路）。
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

    // 一次调用按键面分区：两区各一次 set，载荷里只有本区的键
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

    // 预热两个域的读缓存（桩的 onChanged 不派发：失效只能来自写入口的 inline 调用）
    await snapshot.getSettings();
    await snapshot.getProviderStore("ai");

    await snapshot.writeSnapshotKeys({
      defaultModel: "anthropic",
      [AI_PROVIDER_KEYS_STORAGE]: { openai: "sk-new" }
    });

    expect((await snapshot.getSettings()).defaultModel).toBe("anthropic");
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
    await snapshot.getSettings();

    vi.mocked(chrome.storage.sync.set).mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));
    await expect(snapshot.writeSnapshotKeys({ defaultModel: "anthropic" })).rejects.toThrow("QUOTA_BYTES");

    vi.mocked(chrome.storage.sync.get).mockClear();
    expect((await snapshot.getSettings()).defaultModel).toBe("openai");
    expect(vi.mocked(chrome.storage.sync.get)).not.toHaveBeenCalled();
  });
});

describe("键 → 域单源：SNAPSHOT_STORAGE_KEYS（invalidate 判据与 onChanged 订阅面共用）", () => {
  it("表 = 键面全集（settings 键面 ∪ 六族键 ∪ 搜索顺序 ∪ 健康度），键互异、区标注正确", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    const expected = [
      ...Object.keys(DEFAULT_SETTINGS).map((key) => ({ key, area: "sync", domain: "settings" })),
      { key: AI_PROVIDERS_STORAGE, area: "sync", domain: "ai" },
      { key: AI_PROVIDER_KEYS_STORAGE, area: "local", domain: "ai" },
      { key: ASR_PROVIDERS_STORAGE, area: "sync", domain: "asr" },
      { key: ASR_PROVIDER_KEYS_STORAGE, area: "local", domain: "asr" },
      { key: SEARCH_PROVIDERS_STORAGE, area: "sync", domain: "search" },
      { key: SEARCH_PROVIDER_KEYS_STORAGE, area: "local", domain: "search" },
      { key: SEARCH_PROVIDER_ORDER_STORAGE, area: "sync", domain: "searchOrder" },
      { key: SEARCH_HEALTH_KEY, area: "local", domain: "searchHealth" }
    ];
    const fingerprint = (rows: ReadonlyArray<{ key: string; area: string; domain: string }>) =>
      rows.map((row) => `${row.key}|${row.area}|${row.domain}`).sort();

    expect(fingerprint(SNAPSHOT_STORAGE_KEYS)).toEqual(fingerprint(expected));
    // 键互异：同一 storage 键只能归属一个域（重复键会让后来的域吃掉前一个）
    const keys = SNAPSHOT_STORAGE_KEYS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("逐键失效：invalidate 只清该键所属的域（表驱动，加键漏映射即红）", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    for (const entry of SNAPSHOT_STORAGE_KEYS) {
      resetModuleState();
      vi.stubGlobal("chrome", makeStub(allDomainFixtures()));
      const snapshot = await import("../../extension/core/settings-snapshot.js");
      await warmAllDomains(snapshot);

      snapshot.invalidate([entry.key]);

      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 应且只应清 ${entry.domain}`
      ).toEqual([entry.domain]);
    }
  });

  it("逐键 onChanged：声明区命中即清该域，另一区的同一键不触发（表驱动，区写错即红）", async () => {
    const { SNAPSHOT_STORAGE_KEYS } = await import("../../extension/core/settings-snapshot.js");
    for (const entry of SNAPSHOT_STORAGE_KEYS) {
      resetModuleState();
      vi.stubGlobal("chrome", makeStub(allDomainFixtures()));
      const snapshot = await import("../../extension/core/settings-snapshot.js");
      await warmAllDomains(snapshot);
      const listener = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];

      // 另一区：键不在该区分发的订阅清单里 → 事件被静默丢弃（区声明写错的判据）
      listener({ [entry.key]: { newValue: null } }, entry.area === "sync" ? "local" : "sync");
      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 在另一区不应触发失效`
      ).toEqual([]);

      listener({ [entry.key]: { newValue: null } }, entry.area);
      expect(
        await invalidatedDomains(snapshot),
        `${entry.key} 应且只应清 ${entry.domain}`
      ).toEqual([entry.domain]);
    }
  });
});
