import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setupEnvironment } from "../setup.js";

const wiring = vi.hoisted(() => ({
  resolveDeps: undefined as unknown,
  saveDeps: undefined as unknown,
  resolveProduct: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => {
    void message;
    void sender;
    sendResponse({ ok: true, wiring: "resolve-search-provider" });
  },
  saveProduct: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => {
    void message;
    void sender;
    sendResponse({ ok: true, wiring: "save-settings" });
  }
}));

vi.mock("../../extension/search/resolve-search-provider-handler.js", () => ({
  createResolveSearchProviderHandler: (deps: unknown) => {
    wiring.resolveDeps = deps;
    return wiring.resolveProduct;
  }
}));

vi.mock("../../extension/core/save-settings-handler.js", () => ({
  createSaveSettingsHandler: (deps: unknown) => {
    wiring.saveDeps = deps;
    return wiring.saveProduct;
  }
}));

function stubChrome() {
  setupEnvironment();
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "9.9.9" })
    },
    tabs: { ...globalThis.chrome.tabs, onUpdated: { addListener: vi.fn() } },
    storage: {
      ...globalThis.chrome.storage,
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
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
    listener(message, sender, (resp) => resolve(resp));
    setTimeout(() => resolve(undefined), 50);
  });
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  vi.resetModules();
  wiring.resolveDeps = undefined;
  wiring.saveDeps = undefined;
});

describe("搜索编排 handler 的 SW 接线", () => {
  it("resolve-search-provider：工厂吃五个读取 primitive + now，路由表登记且派发工厂产物", async () => {
    stubChrome();
    const listener = await importBackground();

    expect(Object.keys(wiring.resolveDeps as object)).toEqual([
      "getSettings",
      "getSearchStore",
      "getAiStore",
      "getOrder",
      "getHealth",
      "now"
    ]);
    const deps = wiring.resolveDeps as { getSearchStore: () => Promise<{ providers: unknown[]; keys: unknown }> };
    vi.mocked(chrome.storage.sync.get).mockResolvedValue({
      searchProviders: [{ id: "p1", presetId: "tavily", name: "T", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true }]
    });
    await expect(deps.getSearchStore()).resolves.toMatchObject({ providers: [{ id: "p1", presetId: "tavily" }] });

    const response = await callHandler(listener, { type: "resolve-search-provider" });
    expect(response).toEqual({ ok: true, wiring: "resolve-search-provider" });
  });

  it("save-settings：工厂吃落盘入口 / 设置快照 / 撤回钩子，路由表登记且派发工厂产物", async () => {
    stubChrome();
    const listener = await importBackground();

    expect(Object.keys(wiring.saveDeps as object)).toEqual([
      "saveSettingsWithInvalidate",
      "getSettingsSnapshot",
      "onSearchOptOut",
      "onSettingsSaved"
    ]);
    const deps = wiring.saveDeps as { onSearchOptOut: () => Promise<void>; onSettingsSaved: () => Promise<void> };
    expect(typeof deps.onSearchOptOut).toBe("function");
    expect(typeof deps.onSettingsSaved).toBe("function");

    const response = await callHandler(listener, { type: "save-settings", settings: {} });
    expect(response).toEqual({ ok: true, wiring: "save-settings" });
  });
});
