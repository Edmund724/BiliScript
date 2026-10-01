// 删除搜索平台记录时的 order 剔除（spec §12.2 末条 / §12.3 / §10 第 85 行）。
// 「删除平台」是撤回的次入口；若删除后 searchProviderOrder 仍留该 id，整份自定义
// 顺序会因「未知 id → 整体作废」被丢掉。故删除入口在删掉记录后把该 id 从数组剔除
// （仅在存在时写回 + inline 失效），写失败静默（顺序是偏好不是数据）。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款，
// 差别在 set 真实写回 fixture（断言落盘值）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../../extension/search/search-provider-store.js";

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

let syncFixture: Record<string, unknown>;
let syncSetMock: Mock;
let failOrderWrite: boolean;

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const requested = (
    Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]
  ) as string[];
  const out: Record<string, unknown> = {};
  for (const key of requested) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

function stubStorage() {
  syncFixture = {};
  failOrderWrite = false;
  syncSetMock = vi.fn(async (obj: Record<string, unknown>) => {
    if (failOrderWrite && SEARCH_PROVIDER_ORDER_STORAGE in obj) {
      throw new Error("QUOTA_BYTES quota exceeded");
    }
    Object.assign(syncFixture, obj);
  });
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
      sync: { get: vi.fn(async (keys: unknown) => readFixture(syncFixture, keys)), set: syncSetMock },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
}

async function importBackground() {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
}

function callHandler(
  listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
  message: unknown
) {
  return new Promise((resolve) => {
    const sender: chrome.runtime.MessageSender = { url: "chrome-extension://test/entry/offscreen.html" };
    void listener(message, sender, (resp) => resolve(resp));
  });
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  stubStorage();
});

describe("删除记录时剔除 searchProviderOrder 中的该 id（§10 第 85 行）", () => {
  it("删除数组内的 id → 写回剔除后的数组，其余顺序保持", async () => {
    syncFixture.searchProviders = [TAVILY_ENTRY, FIRECRAWL_ENTRY];
    syncFixture[SEARCH_PROVIDER_ORDER_STORAGE] = ["search_firecrawl", "tavily"];
    const listener = await importBackground();

    const response = (await callHandler(listener, { type: "search-providers-delete", providerId: "tavily" })) as {
      ok: boolean;
    };

    expect(response.ok).toBe(true);
    expect(syncFixture[SEARCH_PROVIDER_ORDER_STORAGE]).toEqual(["search_firecrawl"]);
  });

  it("删除不在数组内的 id → 不写 order（仅在存在时写回）", async () => {
    syncFixture.searchProviders = [TAVILY_ENTRY, FIRECRAWL_ENTRY];
    syncFixture[SEARCH_PROVIDER_ORDER_STORAGE] = ["search_firecrawl"];
    const listener = await importBackground();

    await callHandler(listener, { type: "search-providers-delete", providerId: "tavily" });

    expect(syncSetMock.mock.calls.some((call) => SEARCH_PROVIDER_ORDER_STORAGE in (call[0] as object))).toBe(false);
    expect(syncFixture[SEARCH_PROVIDER_ORDER_STORAGE]).toEqual(["search_firecrawl"]);
  });

  it("order 键缺席 / 脏值（非数组）→ 删除只删记录，不写 order、不抛", async () => {
    for (const stored of [undefined, "tavily", { 0: "tavily" }]) {
      resetModuleState();
      stubStorage();
      syncFixture.searchProviders = [TAVILY_ENTRY];
      if (stored !== undefined) syncFixture[SEARCH_PROVIDER_ORDER_STORAGE] = stored;
      const listener = await importBackground();

      const response = (await callHandler(listener, {
        type: "search-providers-delete",
        providerId: "tavily"
      })) as { ok: boolean };

      expect(response.ok).toBe(true);
      expect(syncSetMock.mock.calls.some((call) => SEARCH_PROVIDER_ORDER_STORAGE in (call[0] as object))).toBe(false);
    }
  });

  it("order 写失败静默：删除仍回 ok:true，记录照删", async () => {
    syncFixture.searchProviders = [TAVILY_ENTRY, FIRECRAWL_ENTRY];
    syncFixture[SEARCH_PROVIDER_ORDER_STORAGE] = ["tavily", "search_firecrawl"];
    const listener = await importBackground();
    failOrderWrite = true;

    const response = (await callHandler(listener, { type: "search-providers-delete", providerId: "tavily" })) as {
      ok: boolean;
      providers?: unknown[];
    };

    expect(response.ok).toBe(true);
    expect((syncFixture.searchProviders as Array<{ id: string }>).map((record) => record.id)).toEqual([
      "search_firecrawl"
    ]);
  });

  it("删除后 resolve-search-provider 的链不再含该记录，其余顺序保持", async () => {
    syncFixture.activeSearchProviderId = "";
    syncFixture.searchProviders = [TAVILY_ENTRY, FIRECRAWL_ENTRY];
    syncFixture[SEARCH_PROVIDER_ORDER_STORAGE] = ["tavily", "search_firecrawl"];
    const listener = await importBackground();

    await callHandler(listener, { type: "search-providers-delete", providerId: "tavily" });
    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as {
      chain?: Array<{ provider: { id: string } }>;
    };

    expect(response.chain?.map((candidate) => candidate.provider.id)).toEqual(["search_firecrawl"]);
  });
});
