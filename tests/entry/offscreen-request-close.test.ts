import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

const OFFSCREEN_URL = "chrome-extension://test/entry/offscreen.html";

function stubSwEnv({
  closeError,
  bilibiliTabs = []
}: {
  closeError?: Error;
  bilibiliTabs?: Array<{ id: number; url?: string }>;
} = {}) {
  const closeDocument = vi.fn(async () => {
    if (closeError) throw closeError;
  });
  const tabsQuery = vi.fn(async () => bilibiliTabs);
  const onRemovedAddListener = vi.fn();
  const sendMessage = vi.fn((_message, callback) => {
    callback?.({ ok: true });
    return undefined;
  });
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getContexts: vi.fn(async () => [{ contextType: "OFFSCREEN_DOCUMENT" }]),
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "9.9.9" })
    },
    tabs: {
      query: tabsQuery,
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: onRemovedAddListener }
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    offscreen: { closeDocument }
  });
  return { closeDocument, tabsQuery, onRemovedAddListener, sendMessage };
}

const offscreenSender: MessageSender = { url: OFFSCREEN_URL };
const tabSender: MessageSender = { tab: { id: 7 }, url: "https://www.bilibili.com/video/BV1/" };
const extensionPageSender: MessageSender = { url: "chrome-extension://test/entry/background.html" };

beforeEach(() => {
  resetModuleState();
});

describe("handleOffscreenRequestClose 执行器", () => {
  it("offscreen 文档来源：执行 closeDocument 并回 { ok:true }", async () => {
    const { closeDocument } = stubSwEnv();
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("closeDocument 抛错：明确回 { ok:false, error }（原始错误文案）", async () => {
    stubSwEnv({ closeError: new Error("No current offscreen document") });
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "No current offscreen document" });
  });

  it.each([
    ["content script（有 sender.tab）", tabSender],
    ["URL 不符的扩展上下文", extensionPageSender],
    ["空 sender", {}]
  ])("非 offscreen 来源（%s）被拒绝：回 ok:false 且 closeDocument 不被触碰", async (_label, sender) => {
    const { closeDocument } = stubSwEnv();
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose({}, sender, sendResponse);

    expect(closeDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
  });

  it("SW 重启（模块重载 = 新实例）：执行器照常工作，自关不失效", async () => {
    const { closeDocument } = stubSwEnv();
    await import("../../extension/asr/offscreen-bridge.bg.js");
    resetModuleState();
    const fresh = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await fresh.handleOffscreenRequestClose({}, offscreenSender, sendResponse);

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("onlyIfNoBilibiliTabs=true 且仍有打开的 B 站标签页：跳过关闭并回 { ok:true, closed:false }", async () => {
    const { closeDocument, tabsQuery } = stubSwEnv({
      bilibiliTabs: [{ id: 12, url: "https://www.bilibili.com/video/BV1/" }]
    });
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose(
      { type: "offscreen-request-close", reason: "no-bilibili-tabs", onlyIfNoBilibiliTabs: true },
      offscreenSender,
      sendResponse
    );

    expect(tabsQuery).toHaveBeenCalledWith({ url: "*://*.bilibili.com/*" });
    expect(closeDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, closed: false });
  });

  it("onlyIfNoBilibiliTabs=true 且全部 B 站标签页已关闭：执行 closeDocument 并回 { ok:true }", async () => {
    const { closeDocument, tabsQuery } = stubSwEnv({ bilibiliTabs: [] });
    const bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleOffscreenRequestClose(
      { type: "offscreen-request-close", reason: "no-bilibili-tabs", onlyIfNoBilibiliTabs: true },
      offscreenSender,
      sendResponse
    );

    expect(tabsQuery).toHaveBeenCalledWith({ url: "*://*.bilibili.com/*" });
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

describe("background 消息入口：offscreen-request-close 的来源守卫", () => {
  async function freshEntry() {
    const { closeDocument } = stubSwEnv();
    resetModuleState();
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
    return { closeDocument, listener };
  }

  it("offscreen 来源放行：closeDocument 执行、回 { ok:true }、保持通道", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "offscreen-request-close" }, offscreenSender, sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });

  it("tab 来源被入口守卫拦截：回 { ok:false } 且不触发 closeDocument", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    const keepOpen = listener({ type: "offscreen-request-close" }, tabSender, sendResponse);

    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(closeDocument).not.toHaveBeenCalled();
  });

  it("扩展页来源同样被拦截（offscreen 专属消息族不含扩展页）", async () => {
    const { closeDocument, listener } = await freshEntry();

    const sendResponse = vi.fn();
    listener({ type: "offscreen-request-close" }, extensionPageSender, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "仅接受 offscreen 文档发送" });
    expect(closeDocument).not.toHaveBeenCalled();
  });

  it("tabs.onRemoved：全部 B 站标签页关闭且 offscreen 存活时广播 offscreen-bilibili-tabs-empty；仍有标签页时不广播", async () => {
    const { onRemovedAddListener, sendMessage, tabsQuery } = stubSwEnv({
      bilibiliTabs: [{ id: 5, url: "https://www.bilibili.com/" }]
    });
    resetModuleState();
    await import("../../extension/entry/background.js");
    const onRemoved = onRemovedAddListener.mock.calls[0][0] as () => void;

    onRemoved();
    await vi.waitFor(() => expect(tabsQuery).toHaveBeenCalledTimes(1));
    expect(sendMessage).not.toHaveBeenCalledWith({ type: "offscreen-bilibili-tabs-empty" });

    tabsQuery.mockResolvedValueOnce([]);
    onRemoved();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({ type: "offscreen-bilibili-tabs-empty" })
    );
  });
});

describe("ensure-offscreen-chat：创建失败沿消息通道上抛为 ok:false", () => {
  it("createDocument 真实失败 → { ok:false, error } 带原始错误", async () => {
    stubSwEnv();
    chrome.runtime.getContexts = vi.fn(async () => []);
    chrome.offscreen = {
      createDocument: vi.fn(async () => { throw new Error("offscreen reasons invalid"); }),
      closeDocument: vi.fn(async () => {})
    };
    resetModuleState();
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];

    const sendResponse = vi.fn();
    listener({ type: "ensure-offscreen-chat" }, extensionPageSender, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "offscreen reasons invalid" })
    );
  });
});
