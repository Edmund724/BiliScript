// resolve-search-provider SW 端路由测试（spec §1 S4、§2、§3 落点表第 11 行）。
// offscreen 文档无 chrome.storage，工具循环的搜索配置（**有序候选链 + 各自 Key**
// + 单轮上限）经本消息单趟往返——链的形状锁在回包全等断言里；三种分支：命中
// （ok + chain + maxToolCalls）、keyless 无 Key（仍产出候选，apiKey:""）、
// 无任何在组记录（ok:true 且 chain 缺省，不算错误）。
// chrome stub 手法与 tests/entry/offscreen-request-close.test.ts 同款（真实
// background 入口 + 路由监听器直调）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";

const PROVIDER_ENTRY = {
  id: "tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

// free-quota 家（Exa）：无 Key 不进链、有 Key 才进（spec §2 调用形状表）
const EXA_ENTRY = {
  id: "exa",
  presetId: "exa",
  name: "Exa",
  type: "exa",
  baseUrl: "https://api.exa.ai",
  enabled: true
};

const TAVILY_CANDIDATE = {
  provider: { id: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
  apiKey: ""
};

function stubStorage({ syncFixture = {}, localFixture = {} }: { syncFixture?: Record<string, unknown>; localFixture?: Record<string, unknown> } = {}) {
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "9.9.9" })
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      // get 的 keys 形状两种：数组（provider-store）与默认值对象（getMergedSettings
      // 传 DEFAULT_SETTINGS）——统一按请求键从 fixture 取值。
      sync: {
        get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null | undefined) => {
          const requested = (Array.isArray(keys) ? keys : typeof keys === "object" && keys ? Object.keys(keys) : [keys]) as string[];
          const out: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in syncFixture) {
              out[key] = syncFixture[key];
            }
          }
          return out;
        }),
        set: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async (keys: string | string[] | null | undefined) => {
          const requested = (Array.isArray(keys) ? keys : [keys]) as string[];
          const out: Record<string, unknown> = {};
          for (const key of requested) {
            if (key in localFixture) {
              out[key] = localFixture[key];
            }
          }
          return out;
        }),
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
    const resolved = listener(message, sender, (resp) => resolve(resp));
    // 处理器返回 false（同步无回包）时直接判失败，避免用例挂死
    setTimeout(() => resolve(undefined), 50);
    void sender;
  });
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("resolve-search-provider 路由", () => {
  it("命中：有序候选链（各自 Key）+ webSearchMaxToolCalls 一起回传", async () => {
    stubStorage({
      syncFixture: {
        activeSearchProviderId: "tavily",
        webSearchMaxToolCalls: 5,
        searchProviders: [PROVIDER_ENTRY]
      },
      localFixture: { searchProviderKeys: { tavily: "tvly-key" } }
    });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response).toEqual({
      ok: true,
      chain: [
        {
          provider: { id: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
          apiKey: "tvly-key"
        }
      ],
      maxToolCalls: 5
    });
  });

  it("keyless 无 Key 也产出 chain 候选（apiKey:''），必填性按预设 access 判", async () => {
    stubStorage({
      syncFixture: { activeSearchProviderId: "tavily", searchProviders: [PROVIDER_ENTRY] },
      localFixture: {}
    });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("无任何在组记录：ok:true 且 chain 缺省（不算错误）", async () => {
    stubStorage({ syncFixture: {} });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response).toEqual({ ok: true });
    expect(response.chain).toBeUndefined();
  });

  it("free-quota 无 Key 不进链（同批 keyless 记录仍在链）", async () => {
    stubStorage({
      syncFixture: { activeSearchProviderId: "", searchProviders: [EXA_ENTRY, PROVIDER_ENTRY] },
      localFixture: {}
    });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("free-quota 有 Key 进链，排序按预设表（链首在最前）", async () => {
    stubStorage({
      syncFixture: { activeSearchProviderId: "exa", searchProviders: [PROVIDER_ENTRY, EXA_ENTRY] },
      localFixture: { searchProviderKeys: { exa: "exa-key" } }
    });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response.chain).toEqual([
      {
        provider: { id: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai" },
        apiKey: "exa-key"
      },
      TAVILY_CANDIDATE
    ]);
  });

  it("presetId 查不到预设表的记录不进链（脏值按最保守处理）", async () => {
    stubStorage({
      syncFixture: {
        activeSearchProviderId: "",
        searchProviders: [
          { id: "search_brave", presetId: "brave", name: "Brave", type: "tavily", baseUrl: "https://api.search.brave.com", enabled: true },
          PROVIDER_ENTRY
        ]
      },
      localFixture: {}
    });
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const response = (await callHandler(listener, { type: "resolve-search-provider" })) as ResolveSearchProviderResponse;

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });
});
