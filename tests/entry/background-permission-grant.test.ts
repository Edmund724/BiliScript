import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const PERMISSION_GRANT_HTML = readFileSync(
  join(process.cwd(), "extension", "entry", "permission-grant.html"),
  "utf8"
);

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

interface BackgroundHarnessOptions {
  requestImpl?: (permissions: { origins?: string[] }) => Promise<boolean>;
  containsImpl?: (permissions: { origins?: string[] }) => Promise<boolean>;
  createWindowImpl?: (options: Record<string, unknown>) => Promise<{ id?: number }>;
}

function installBackgroundChromeStub(options: BackgroundHarnessOptions = {}) {
  const windowRemovedListeners = new Set<(windowId: number) => void>();

  const requestMock = vi.fn(options.requestImpl ?? (async () => true));
  const containsMock = vi.fn(options.containsImpl ?? (async () => false));
  const createWindowMock = vi.fn(options.createWindowImpl ?? (async () => ({ id: 42 })));
  const removeWindowMock = vi.fn(async () => {});
  const addRemovedListener = vi.fn((fn: (windowId: number) => void) => {
    windowRemovedListeners.add(fn);
  });
  const removeRemovedListener = vi.fn((fn: (windowId: number) => void) => {
    windowRemovedListeners.delete(fn);
  });

  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      lastError: null,
      getURL: (path: string) => `moz-extension://ext-test-uuid/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "2.7.4" })
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
    permissions: {
      request: requestMock,
      contains: containsMock
    },
    windows: {
      create: createWindowMock,
      remove: removeWindowMock,
      onRemoved: {
        addListener: addRemovedListener,
        removeListener: removeRemovedListener
      }
    }
  });

  return {
    requestMock,
    containsMock,
    createWindowMock,
    removeWindowMock,
    addRemovedListener,
    removeRemovedListener,
    windowRemovedListeners
  };
}

async function importBackgroundListener(): Promise<RuntimeListener> {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0] as RuntimeListener;
}

function sendToBackground(
  listener: RuntimeListener,
  message: unknown,
  sender: chrome.runtime.MessageSender = { url: "https://www.bilibili.com/video/BV1test000000" }
): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, sender, (resp) => resolve(resp));
  });
}

function extractPopupReqId(popupUrl: string): string {
  return new URL(popupUrl).searchParams.get("reqId") || "";
}

function installPermissionGrantDom(html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("request-provider-origins：无端口 pattern 与 Firefox 授权回退", () => {
  it("正常路径：向 permissions.request 传入去重后的无端口 pattern", async () => {
    const stub = installBackgroundChromeStub({ requestImpl: async () => true });
    const listener = await importBackgroundListener();

    const response = await sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["http://localhost:11434/v1", "http://localhost:8000/v1"]
    });

    expect(response).toEqual({ ok: true });
    expect(stub.requestMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
    expect(stub.createWindowMock).not.toHaveBeenCalled();
  });

  it("非手势类异常：保持原有失败语义，不查 contains 也不拉起弹窗", async () => {
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("permissions API unavailable");
      }
    });
    const listener = await importBackgroundListener();

    const response = await sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["https://custom-relay.example.com/v1"]
    });

    expect(response).toEqual({
      ok: false,
      error: "申请域名权限失败：permissions API unavailable"
    });
    expect(stub.containsMock).not.toHaveBeenCalled();
    expect(stub.createWindowMock).not.toHaveBeenCalled();
  });

  it("Firefox 手势报错且命中常驻域（contains 为 true）→ 静默放行，不弹窗", async () => {
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => true
    });
    const listener = await importBackgroundListener();

    const response = await sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["https://api.openai.com/v1"]
    });

    expect(response).toEqual({ ok: true });
    expect(stub.containsMock).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(stub.createWindowMock).not.toHaveBeenCalled();
  });

  it("Firefox 手势报错且未授权自定义域 → 拉起小窗并在允许回包后返回 ok，清理监听器", async () => {
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("Missing user gesture");
      },
      containsImpl: async () => false,
      createWindowImpl: async () => ({ id: 88 })
    });
    const listener = await importBackgroundListener();

    const pending = sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["http://localhost:11434/v1"]
    });

    await vi.waitFor(() => expect(stub.createWindowMock).toHaveBeenCalledTimes(1));
    const createArgs = stub.createWindowMock.mock.calls[0][0] as {
      url: string;
      type: string;
      width: number;
      height: number;
      focused: boolean;
    };
    expect(createArgs.type).toBe("popup");
    expect(createArgs.width).toBe(440);
    expect(createArgs.height).toBe(260);
    expect(createArgs.focused).toBe(true);
    expect(createArgs.url).toContain("moz-extension://ext-test-uuid/entry/permission-grant.html?");

    const reqId = extractPopupReqId(createArgs.url);
    expect(reqId).not.toBe("");

    // 非授权来源（content script / 其他页面）伪造回包必须被拒绝且不影响挂起请求
    const forgedResp = await sendToBackground(
      listener,
      { type: "permission-grant-result", reqId, ok: true },
      { url: "https://www.bilibili.com/video/BV1test000000", id: "ext-test-id" }
    );
    expect(forgedResp).toEqual({ ok: false, error: "拒绝非授权扩展页面的权限回包" });

    // 来自扩展授权小窗本身的合法回包完成授权
    const ackResp = await sendToBackground(
      listener,
      { type: "permission-grant-result", reqId, ok: true },
      {
        url: createArgs.url,
        id: "ext-test-id",
        tab: { id: 101, url: createArgs.url }
      }
    );
    expect(ackResp).toEqual({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(stub.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(stub.windowRemovedListeners.size).toBe(0);
  });

  it("弹窗被用户直接关闭（windows.onRemoved）→ 按取消回包并清理监听器", async () => {
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: async () => ({ id: 99 })
    });
    const listener = await importBackgroundListener();

    const pending = sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["http://localhost:11434/v1"]
    });

    await vi.waitFor(() => expect(stub.createWindowMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stub.addRemovedListener).toHaveBeenCalledTimes(1));

    const [onRemoved] = [...stub.windowRemovedListeners];
    onRemoved(99);

    const response = (await pending) as { ok: boolean; error?: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("未授权 http://localhost/*");
    expect(stub.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(stub.windowRemovedListeners.size).toBe(0);
  });

  it("弹窗 120s 未响应 → 超时失败回包并清理监听器与弹窗", async () => {
    vi.useFakeTimers();
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: async () => ({ id: 77 })
    });
    const listener = await importBackgroundListener();

    const pending = sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["https://relay.example.com/v1"]
    });

    await vi.waitFor(() => expect(stub.createWindowMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120_000);

    const response = (await pending) as { ok: boolean; error?: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain("授权超时");
    expect(stub.removeWindowMock).toHaveBeenCalledWith(77);
    expect(stub.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(stub.windowRemovedListeners.size).toBe(0);
  });

  it("windows.create 同步抛错 → 立即失败回包并清理监听器", async () => {
    const stub = installBackgroundChromeStub({
      requestImpl: async () => {
        throw new Error("permissions.request may only be called from a user input handler");
      },
      containsImpl: async () => false,
      createWindowImpl: () => {
        throw new Error("popup blocked");
      }
    });
    const listener = await importBackgroundListener();

    const response = (await sendToBackground(listener, {
      type: "request-provider-origins",
      baseUrls: ["https://relay.example.com/v1"]
    })) as { ok: boolean; error?: string };

    expect(response).toEqual({
      ok: false,
      error: "申请域名权限失败：popup blocked"
    });
    expect(stub.removeRemovedListener).toHaveBeenCalledTimes(1);
    expect(stub.windowRemovedListeners.size).toBe(0);
  });
});

describe("permission-grant.html / permission-grant.ts 扩展授权页", () => {
  it("以纯文本节点渲染域名（不解析 HTML 标签）且点击允许在同步手势内请求权限并关闭窗口", async () => {
    installPermissionGrantDom(PERMISSION_GRANT_HTML);
    const requestMock = vi.fn(async () => true);
    const sendMessageMock = vi.fn((_msg: unknown, cb?: (resp: unknown) => void) => {
      cb?.({ ok: true });
      return undefined;
    });
    vi.stubGlobal("chrome", {
      permissions: { request: requestMock },
      runtime: { sendMessage: sendMessageMock, lastError: null }
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    const { initPermissionGrantPage } = await import("../../extension/entry/permission-grant.js");
    const search = `?reqId=req-1&origins=${encodeURIComponent(
      JSON.stringify(["http://localhost:11434/v1", "https://api.example.com/<img src=x onerror=alert(1)>"])
    )}`;
    initPermissionGrantPage(search);

    const items = [...document.querySelectorAll("#permissionGrantOrigins li")];
    expect(items.map((el) => el.textContent)).toEqual([
      "http://localhost/*",
      "https://api.example.com/*"
    ]);
    expect(document.querySelectorAll("#permissionGrantOrigins img")).toHaveLength(0);

    const allowBtn = document.getElementById("permissionGrantAllowBtn") as HTMLButtonElement;
    allowBtn.click();

    // 同步手势内直调 chrome.permissions.request
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      origins: ["http://localhost/*", "https://api.example.com/*"]
    });

    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));
    expect(sendMessageMock).toHaveBeenCalledWith(
      {
        type: "permission-grant-result",
        reqId: "req-1",
        ok: true,
        error: undefined
      },
      expect.any(Function)
    );
  });

  it("点击取消回传 ok: false 并关闭窗口", async () => {
    installPermissionGrantDom(PERMISSION_GRANT_HTML);
    const requestMock = vi.fn(async () => true);
    const sendMessageMock = vi.fn((_msg: unknown, cb?: (resp: unknown) => void) => {
      cb?.({ ok: true });
      return undefined;
    });
    vi.stubGlobal("chrome", {
      permissions: { request: requestMock },
      runtime: { sendMessage: sendMessageMock, lastError: null }
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    const { initPermissionGrantPage } = await import("../../extension/entry/permission-grant.js");
    const search = `?reqId=req-2&origins=${encodeURIComponent(JSON.stringify(["http://localhost/*"]))}`;
    initPermissionGrantPage(search);

    const cancelBtn = document.getElementById("permissionGrantCancelBtn") as HTMLButtonElement;
    cancelBtn.click();

    expect(requestMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission-grant-result",
        reqId: "req-2",
        ok: false
      }),
      expect.any(Function)
    );
  });
});
