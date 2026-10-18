// search-health 记账消息族的**消费面**测试（spec §12.4 第 5–8 条 / §12.5 第 10–11 行、
// §10 第 66–67、73 行、票 15 §4）：本文件只留「记账经消息落到 SW 之后，resolve 路由与
// 健康度快照位如何消费它」的整合用例——这些用例跨 handler 族（search-health 记账 +
// 组合根的 resolve-search-provider），必须起真 background 入口：
//   ① 冷却消费：连败触发后 resolve 路由跳过该引擎（inline 失效保证写后读）、
//      到期回链、全部冷却 → chain 缺省 + chainEmptyReason:'cooldown'（专属文案，
//      不误报未配置，spec §12.7 第 6 条翻案）、单选不拦但账照记；
//   ② 快照位：健康度读命中零重复读、写 handler 落盘后 inline 失效（下一次 resolve
//      重读）；脏存储 / 读失败按无冷却（不拦任何链）。
// 记账族自身的 handler 面（落盘单键 / SW 侧盖时间戳 / 脏载荷）由本文件的真入口
// 记账消费与 tests/search/search-health.test.ts 的健康度核心覆盖。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款
//（真实 background 入口 + 路由监听器直调）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_HEALTH_KEY } from "../../extension/search/search-health.js";
import type {
  MessageSender,
  ResolveSearchProviderResponse,
  SearchHealthResponse,
  SearchHealthMessage
} from "../../extension/shared/messaging-protocol.js";

const TAVILY_ENTRY = {
  id: "tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

const FIRECRAWL_ENTRY = {
  id: "search_firecrawl",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  enabled: true
};

const TAVILY_CANDIDATE = {
  provider: {
    id: "tavily",
    presetId: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com",
    access: "keyless"
  },
  apiKey: ""
};

const FIRECRAWL_CANDIDATE = {
  provider: {
    id: "search_firecrawl",
    presetId: "firecrawl",
    name: "Firecrawl",
    type: "firecrawl",
    baseUrl: "https://api.firecrawl.dev",
    access: "keyless"
  },
  apiKey: ""
};

// content / 页内来源（解释卡链与工具循环同走此消息族，不得被 offscreen-only 名单拒）
const TAB_SENDER: MessageSender = { tab: { id: 7 }, url: "https://www.bilibili.com/video/BV1/" };

let syncFixture: Record<string, unknown>;
let localFixture: Record<string, unknown>;

function asKeys(keys: unknown): string[] {
  return (Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]) as string[];
}

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of asKeys(keys)) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

function stubStorage({
  syncSeed = {},
  localSeed = {}
}: { syncSeed?: Record<string, unknown>; localSeed?: Record<string, unknown> } = {}) {
  syncFixture = { ...syncSeed };
  localFixture = { ...localSeed };
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "9.9.9" })
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      sync: {
        get: vi.fn(async (keys: unknown) => readFixture(syncFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(syncFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of asKeys(keys)) delete syncFixture[key];
        })
      },
      local: {
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of asKeys(keys)) delete localFixture[key];
        })
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
}

type Listener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

async function importBackground(): Promise<Listener> {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0] as Listener;
}

function callHandler(listener: Listener, message: unknown): Promise<any> {
  return new Promise((resolve) => {
    listener(message, TAB_SENDER, (resp) => resolve(resp));
    setTimeout(() => resolve(undefined), 50);
  });
}

function recordHealth(listener: Listener, message: SearchHealthMessage): Promise<SearchHealthResponse> {
  return callHandler(listener, message) as Promise<SearchHealthResponse>;
}

function resolveProvider(listener: Listener): Promise<ResolveSearchProviderResponse> {
  return callHandler(listener, { type: "resolve-search-provider" }) as Promise<ResolveSearchProviderResponse>;
}

// 健康度快照位的 storage.local.get 次数（键面命中计数）。
function healthReads(): number {
  return vi.mocked(chrome.storage.local.get).mock.calls.filter(([keys]) =>
    asKeys(keys).includes(SEARCH_HEALTH_KEY)
  ).length;
}

// 冷却中的引擎账（预设表无关的纯数据）。
function cooled(presetId: string, cooldownUntil: number, cooldownLevel = 1) {
  return {
    [presetId]: {
      attempts: [{ ok: false, latencyMs: 10 }],
      consecutiveFailures: 0,
      cooldownLevel,
      cooldownUntil
    }
  };
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("resolve 路由消费冷却图（§12.4 第 5–6 条 / §10 第 66–67 行）", () => {
  it("连败触发后 resolve 跳过冷却中的引擎（inline 失效保证写后读）", async () => {
    stubStorage({
      syncSeed: {
        activeSearchProviderId: "",
        searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY]
      }
    });
    const listener = await importBackground();

    const before = await resolveProvider(listener);
    expect(before.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);

    for (let index = 0; index < 3; index += 1) {
      await recordHealth(listener, { type: "search-health", op: "record", presetId: "tavily", ok: false, latencyMs: 5 });
    }

    const after = await resolveProvider(listener);
    expect(after.chain).toEqual([FIRECRAWL_CANDIDATE]);
  });

  it("cooldownUntil ≤ now（到期）→ 引擎回链，按内置默认序排", async () => {
    stubStorage({
      syncSeed: { activeSearchProviderId: "", searchProviders: [FIRECRAWL_ENTRY, TAVILY_ENTRY] },
      localSeed: { [SEARCH_HEALTH_KEY]: cooled("tavily", Date.now() - 1) }
    });
    const listener = await importBackground();

    const response = await resolveProvider(listener);

    expect(response.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);
    // 到期即回链：链非空 → 无空链归因（恢复正常，不残留冷却文案）
    expect(response.chainEmptyReason).toBeUndefined();
  });

  it("部分引擎冷却 → chain = 未冷却记录，回包不带 chainEmptyReason", async () => {
    stubStorage({
      syncSeed: { activeSearchProviderId: "", searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY] },
      localSeed: { [SEARCH_HEALTH_KEY]: cooled("tavily", Date.now() + 600_000) }
    });
    const listener = await importBackground();

    const response = await resolveProvider(listener);

    expect(response.chain).toEqual([FIRECRAWL_CANDIDATE]);
    expect(response.chainEmptyReason).toBeUndefined();
  });

  it("全部引擎冷却 → chain 缺省 + chainEmptyReason:'cooldown'（专属文案，不误报未配置）", async () => {
    stubStorage({
      syncSeed: { activeSearchProviderId: "", searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY] },
      localSeed: {
        [SEARCH_HEALTH_KEY]: { ...cooled("tavily", Date.now() + 600_000), ...cooled("firecrawl", Date.now() + 600_000) }
      }
    });
    const listener = await importBackground();

    const response = await resolveProvider(listener);

    expect(response).toEqual({ ok: true, chainEmptyReason: "cooldown" });
    expect(response.chain).toBeUndefined();
  });

  it("单选模式不消费冷却：冷却中的记录仍是唯一候选（尊重用户明示选择）", async () => {
    stubStorage({
      syncSeed: {
        activeSearchProviderId: "tavily",
        searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY]
      },
      localSeed: { [SEARCH_HEALTH_KEY]: cooled("tavily", Date.now() + 600_000) }
    });
    const listener = await importBackground();

    const response = await resolveProvider(listener);

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("脏存储（整图非对象 / 单条非法）→ 按无冷却，不拦任何链", async () => {
    for (const dirty of ["junk", { tavily: "junk" }, null]) {
      resetModuleState();
      stubStorage({
        syncSeed: { activeSearchProviderId: "", searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY] },
        localSeed: { [SEARCH_HEALTH_KEY]: dirty }
      });
      const listener = await importBackground();

      const response = await resolveProvider(listener);

      expect(response.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);
    }
  });

  it("健康度读失败（storage.get 抛）→ 按无冷却，不拦链也不报错", async () => {
    stubStorage({
      syncSeed: { activeSearchProviderId: "", searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY] }
    });
    const listener = await importBackground();
    const get = vi.mocked(chrome.storage.local.get);
    get.mockImplementation(async (keys: unknown) => {
      if (asKeys(keys).includes(SEARCH_HEALTH_KEY)) throw new Error("storage failure");
      return readFixture(localFixture, keys);
    });

    const response = await resolveProvider(listener);

    expect(response.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);
  });

  it("快照位：连续 resolve 只读一次健康度；写 handler 落盘后 inline 失效 → 再读一次", async () => {
    stubStorage({
      syncSeed: { activeSearchProviderId: "", searchProviders: [TAVILY_ENTRY, FIRECRAWL_ENTRY] }
    });
    const listener = await importBackground();

    await resolveProvider(listener);
    await resolveProvider(listener);
    expect(healthReads()).toBe(1);

    // 记账 handler 自身读-改-写读一次（第 2 次），落盘后 inline 失效健康度快照
    await recordHealth(listener, { type: "search-health", op: "record", presetId: "tavily", ok: true, latencyMs: 3 });
    expect(healthReads()).toBe(2);

    // inline 失效后 resolve 重读一次（若缺失效则是缓存命中，仍为 2）
    await resolveProvider(listener);
    expect(healthReads()).toBe(3);
  });
});

describe("记账消息族的 op 边界", () => {
  it("search-health 未知 op → ok:false + 错误文案（消息边界不静默吞）", async () => {
    stubStorage({ syncSeed: { activeSearchProviderId: "", searchProviders: [] } });
    const listener = await importBackground();

    const response = await recordHealth(
      listener,
      { type: "search-health", op: "purge" } as unknown as SearchHealthMessage
    );

    expect(response).toEqual({
      ok: false,
      error: "不支持的搜索健康度操作：purge"
    });
  });
});
