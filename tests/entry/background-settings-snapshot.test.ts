// 设置快照收编后的 SW handler 集成测试（sw-settings-snapshot 票）。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款
// （真实 background 入口 + 路由监听器直调），在整条消息链上锁三事：
//   1. 热路径命中：四个读 handler（resolve-ai-provider / resolve-search-provider /
//      get-asr-runtime-config / get-settings）二次调用 storage 读为 0；
//   2. 写后读失效：providers-save/delete、save-settings 落盘后，读 handler 拿新值
//      （写 handler inline 失效接通，onChanged 桩不触发也成立）；
//   3. 响应负载与收编前一致（协议形状零变化）。
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

const ASR_PROVIDER = {
  id: "whisper",
  presetId: "local-whisper",
  name: "本地 Whisper",
  type: "openai-transcriptions",
  baseUrl: "http://localhost:9000/v1",
  model: "whisper-large-v3",
  supportsTimestamps: true,
  enabled: true
};

function stubStorage({
  syncFixture = {},
  localFixture = {}
}: { syncFixture?: Record<string, unknown>; localFixture?: Record<string, unknown> } = {}) {
  // set 真实写回 fixture：写后读失效断言依赖「落盘 → 重读拿新值」全链成立
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
        get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
          const requested = (
            Array.isArray(keys) ? keys : typeof keys === "object" && keys ? Object.keys(keys) : [keys]
          ) as string[];
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
        get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
          const requested = (Array.isArray(keys) ? keys : [keys]) as string[];
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
  });
  return { syncFixture, localFixture };
}

async function importBackground() {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
}

// chrome-types.d.ts 的 OnMessage 监听器形状（background.ts 注册的路由监听器）。
type BackgroundMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

// 响应信封随消息类型变化（ai/search/asr/settings 各族），统一按 any 解开。
function callHandler(listener: BackgroundMessageListener, message: unknown): Promise<any> {
  return new Promise<any>((resolve) => {
    const sender: chrome.runtime.MessageSender = { url: "chrome-extension://test/entry/offscreen.html" };
    const resolved = listener(message, sender, (resp) => resolve(resp));
    // 处理器返回 false（同步无回包）时直接判失败，避免用例挂死
    setTimeout(() => resolve(undefined), 50);
    void sender;
    void resolved;
  });
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

describe("热路径命中：四个读 handler 二次调用 storage 读为 0", () => {
  async function assertSecondCallZeroReads(message: unknown, firstAssert: (response: any) => void) {
    const listener = await importBackground();
    const first = await callHandler(listener, message);
    firstAssert(first);

    vi.mocked(chrome.storage.sync.get).mockClear();
    vi.mocked(chrome.storage.local.get).mockClear();
    const second = await callHandler(listener, message);
    expect(second).toEqual(first);
    expect(storageGetCalls()).toBe(0);
  }

  it("resolve-ai-provider（缺省档：settings + ai 族快照）", async () => {
    stubStorage({
      syncFixture: { defaultModel: "openai", aiProviders: [AI_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-test" } }
    });
    await assertSecondCallZeroReads({ type: "resolve-ai-provider" }, (response) => {
      expect(response).toEqual({
        ok: true,
        provider: { ...AI_PROVIDER, hasSavedKey: true },
        apiKey: "sk-test"
      });
    });
  });

  it("resolve-search-provider", async () => {
    stubStorage({
      syncFixture: {
        activeSearchProviderId: "tavily",
        webSearchMaxToolCalls: 5,
        searchProviders: [SEARCH_PROVIDER]
      },
      localFixture: { searchProviderKeys: { tavily: "tvly-key" } }
    });
    await assertSecondCallZeroReads({ type: "resolve-search-provider" }, (response) => {
      expect(response).toEqual({
        ok: true,
        provider: { id: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
        apiKey: "tvly-key",
        maxToolCalls: 5
      });
    });
  });

  it("get-asr-runtime-config", async () => {
    stubStorage({
      syncFixture: {
        activeAsrProviderId: "whisper",
        asrLanguage: "auto",
        asrAutoFallback: true,
        asrProviders: [ASR_PROVIDER]
      },
      localFixture: { asrProviderKeys: { whisper: "sk-local" } }
    });
    await assertSecondCallZeroReads({ type: "get-asr-runtime-config" }, (response) => {
      expect(response).toEqual({
        ok: true,
        providers: [{ ...ASR_PROVIDER, hasSavedKey: true }],
        activeAsrProviderId: "whisper",
        activeKey: "sk-local",
        asrLanguage: "auto",
        asrAutoFallback: true
      });
    });
  });

  it("get-settings", async () => {
    stubStorage({ syncFixture: { defaultModel: "openai", readerTheme: "dark" } });
    await assertSecondCallZeroReads({ type: "get-settings" }, (response) => {
      expect(response.ok).toBe(true);
      expect(response.settings.defaultModel).toBe("openai");
      expect(response.settings.readerTheme).toBe("dark");
    });
  });
});

describe("写后读失效：写消息落盘后读 handler 拿新值", () => {
  it("ai-providers-save 后 resolve-ai-provider 拿新列表 + 新 Key", async () => {
    stubStorage({
      syncFixture: { defaultModel: "openai", aiProviders: [AI_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-old" } }
    });
    const listener = await importBackground();

    const before = await callHandler(listener, { type: "resolve-ai-provider" });
    expect(before.apiKey).toBe("sk-old");

    const saved = await callHandler(listener, {
      type: "ai-providers-save",
      providers: [{ ...AI_PROVIDER, apiKey: "sk-new" }]
    });
    expect(saved).toEqual({ ok: true, providers: [{ ...AI_PROVIDER, hasSavedKey: true }] });

    const after = await callHandler(listener, { type: "resolve-ai-provider" });
    expect(after.ok).toBe(true);
    expect(after.apiKey).toBe("sk-new");
  });

  it("ai-providers-delete 后 resolve-ai-provider 精确匹配落空", async () => {
    stubStorage({
      syncFixture: { defaultModel: "openai", aiProviders: [AI_PROVIDER] },
      localFixture: { aiProviderKeys: { openai: "sk-test" } }
    });
    const listener = await importBackground();

    const removed = await callHandler(listener, { type: "ai-providers-delete", providerId: "openai" });
    expect(removed).toEqual({ ok: true, providers: [] });

    const after = await callHandler(listener, { type: "resolve-ai-provider", providerId: "openai" });
    expect(after).toEqual({ ok: false, error: "未找到选中的平台" });
  });

  it("save-settings 后 get-settings 拿新值（payload 外键被白名单忽略）", async () => {
    stubStorage({ syncFixture: { defaultModel: "openai" } });
    const listener = await importBackground();

    const saved = await callHandler(listener, {
      type: "save-settings",
      settings: { defaultModel: "anthropic", strayKey: "ignored" }
    });
    expect(saved).toEqual({ ok: true });

    const after = await callHandler(listener, { type: "get-settings" });
    expect(after.settings.defaultModel).toBe("anthropic");
  });

  it("search-providers-save 后 resolve-search-provider 命中新激活平台", async () => {
    stubStorage({
      syncFixture: {
        activeSearchProviderId: "exa",
        webSearchMaxToolCalls: 3,
        searchProviders: [SEARCH_PROVIDER]
      },
      localFixture: { searchProviderKeys: {} }
    });
    const listener = await importBackground();

    const before = await callHandler(listener, { type: "resolve-search-provider" });
    expect(before).toEqual({ ok: true });

    const EXA = { ...SEARCH_PROVIDER, id: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai" };
    await callHandler(listener, {
      type: "search-providers-save",
      providers: [SEARCH_PROVIDER, { ...EXA, apiKey: "exa-key" }]
    });

    const after = await callHandler(listener, { type: "resolve-search-provider" });
    expect(after).toEqual({
      ok: true,
      provider: { id: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai" },
      apiKey: "exa-key",
      maxToolCalls: 3
    });
  });

  it("asr-providers-save 后 get-asr-runtime-config 拿新列表", async () => {
    stubStorage({
      syncFixture: { activeAsrProviderId: "", asrProviders: [] },
      localFixture: { asrProviderKeys: {} }
    });
    const listener = await importBackground();

    await callHandler(listener, {
      type: "asr-providers-save",
      providers: [{ ...ASR_PROVIDER, apiKey: "sk-local" }]
    });

    const after = await callHandler(listener, { type: "get-asr-runtime-config" });
    expect(after.providers).toEqual([{ ...ASR_PROVIDER, hasSavedKey: true }]);
  });
});
