// check-provider-origin SW 端路由测试（S2 收紧 host_permissions 后）。
// content script 没有 chrome.permissions，概览/快捷提示词的 offscreen 代发在发起
// 请求前经本消息代查该 origin 的 host 权限，把「网络错误：Failed to fetch」换成
// 可操作提示（与 SW 代发通道的预检同一口径）。锁三种回复：已授权、未授权、origin
// 缺失或非法（按已授权 fail-open，不把这条查询变成新的拦截面）。
// chrome stub 手法与 tests/entry/background-resolve-search-provider.test.ts 同款
//（真实 background 入口 + 路由监听器直调）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { CheckProviderOriginResponse } from "../../extension/shared/messaging-protocol.js";

function stubChrome({ granted = true, contains }: { granted?: boolean; contains?: () => Promise<boolean> } = {}) {
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
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    permissions: { contains: vi.fn(contains ?? (async () => granted)) }
  });
}

async function importBackgroundListener() {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0] as (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void;
}

function callHandler(
  listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
  message: unknown
): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, { url: "chrome-extension://test/entry/reader.js" }, (resp) => resolve(resp));
    // 处理器同步不回复时直接判失败，避免用例挂死
    setTimeout(() => resolve(undefined), 50);
  });
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("check-provider-origin 路由", () => {
  it("已授权：contains 收到该 origin，回 { granted: true }", async () => {
    stubChrome({ granted: true });
    const listener = await importBackgroundListener();

    const response = (await callHandler(listener, {
      type: "check-provider-origin",
      origin: "https://api.openai.com/*"
    })) as CheckProviderOriginResponse;

    expect(response).toEqual({ granted: true });
    expect(chrome.permissions.contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
  });

  it("未授权：回 { granted: false }（不抛错，由 content 侧转可操作文案）", async () => {
    stubChrome({ contains: async () => false });
    const listener = await importBackgroundListener();

    const response = (await callHandler(listener, {
      type: "check-provider-origin",
      origin: "https://api.openai.com/*"
    })) as CheckProviderOriginResponse;

    expect(response).toEqual({ granted: false });
  });

  it("origin 缺失 / 非法：按已授权回 { granted: true }，不查 permissions", async () => {
    stubChrome();
    const listener = await importBackgroundListener();

    expect(await callHandler(listener, { type: "check-provider-origin" })).toEqual({ granted: true });
    expect(await callHandler(listener, { type: "check-provider-origin", origin: "oops" })).toEqual({ granted: true });
    expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });
});
