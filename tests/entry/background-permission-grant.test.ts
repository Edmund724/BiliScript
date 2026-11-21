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

function installMinimalBackgroundStub() {
  const requestMock = vi.fn(async () => true);
  const containsMock = vi.fn(async () => true);
  const removeMock = vi.fn(async () => true);
  const onConnectListeners: Array<(port: unknown) => void> = [];

  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      lastError: null,
      getURL: (path: string) => `moz-extension://ext-test-uuid/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() },
      onConnect: { addListener: vi.fn((fn: (port: unknown) => void) => onConnectListeners.push(fn)) },
      onInstalled: { addListener: vi.fn() },
      getManifest: () => ({ version: "2.7.4", host_permissions: [] })
    },
    tabs: { onUpdated: { addListener: vi.fn() } },
    storage: {
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    permissions: {
      request: requestMock,
      contains: containsMock,
      remove: removeMock
    }
  });

  return { requestMock, containsMock, removeMock, onConnectListeners };
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

describe("entry/background host 权限消息族接线", () => {
  it("四条权限消息均派发至 createHostPermissionHandlers 工厂产物并贯通 chrome.permissions", async () => {
    const stub = installMinimalBackgroundStub();
    await import("../../extension/entry/background.js");
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0] as RuntimeListener;

    expect(
      await sendToBackground(listener, {
        type: "request-provider-origins",
        baseUrls: ["http://localhost:11434/v1"]
      })
    ).toEqual({ ok: true });
    expect(stub.requestMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });

    expect(
      await sendToBackground(listener, {
        type: "check-provider-origin",
        origin: "http://localhost:11434/*"
      })
    ).toEqual({ granted: true, status: "granted" });
    expect(stub.containsMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });

    expect(
      await sendToBackground(listener, {
        type: "revoke-provider-origin",
        origin: "http://localhost:11434/v1"
      })
    ).toEqual({ origins: ["http://localhost/*"], revoked: true });
    expect(stub.removeMock).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });

    expect(
      await sendToBackground(
        listener,
        { type: "permission-grant-result", reqId: "missing", ok: true },
        { url: "https://www.bilibili.com/video/BV1test000000", id: "ext-test-id" }
      )
    ).toEqual({ ok: false, error: "拒绝非授权扩展页面的权限回包" });
  });

  it("background onConnect 接管 permission-grant-keepalive 端口并在断开后移除监听", async () => {
    const stub = installMinimalBackgroundStub();
    await import("../../extension/entry/background.js");
    const onConnect = stub.onConnectListeners[0];
    expect(typeof onConnect).toBe("function");

    const disconnectListeners = new Set<() => void>();
    const removeListener = vi.fn((fn: () => void) => disconnectListeners.delete(fn));
    const port = {
      name: "permission-grant-keepalive",
      sender: {
        id: "ext-test-id",
        url: "moz-extension://ext-test-uuid/entry/permission-grant.html?reqId=req-1"
      },
      disconnect: vi.fn(),
      onDisconnect: {
        addListener: vi.fn((fn: () => void) => disconnectListeners.add(fn)),
        removeListener
      }
    };

    onConnect(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(disconnectListeners.size).toBe(1);

    [...disconnectListeners].forEach((fn) => fn());
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(disconnectListeners.size).toBe(0);
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

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      origins: ["http://localhost/*", "https://api.example.com/*"]
    });
    expect(allowBtn.textContent).toBe("等待浏览器确认…");
    const statusEl = document.getElementById("permissionGrantStatus") as HTMLElement;
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.textContent).toContain("请在浏览器弹出的权限提示中点击允许");

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

  it("包含品牌标识、favicon、授权原因说明，并跟随扩展 readerTheme / readerPalette 配色", async () => {
    installPermissionGrantDom(PERMISSION_GRANT_HTML);
    expect(document.title).toContain("BiliScript");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("../icons/icon32.png");
    expect(document.querySelector(".grant-brand-title")?.textContent).toContain("BiliScript");
    expect(document.querySelector(".grant-reason")?.textContent).toContain("自定义或本地域名");

    const syncStorage = {
      get: vi.fn(async function (this: unknown) {
        if (this !== syncStorage) {
          throw new TypeError("Illegal invocation");
        }
        return {
          readerTheme: "dark",
          readerThemeUserSet: true,
          readerPalette: "editorial"
        };
      })
    };
    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true) },
      runtime: { sendMessage: vi.fn(), lastError: null },
      storage: { sync: syncStorage }
    });

    const { initPermissionGrantPage } = await import("../../extension/entry/permission-grant.js");
    initPermissionGrantPage(`?reqId=req-3&origins=${encodeURIComponent(JSON.stringify(["http://localhost/*"]))}`);

    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.getAttribute("data-palette")).toBe("editorial");
    });
    expect(document.documentElement.getAttribute("data-biliscript-onboarding")).toBe("1");
  });

  it("弹窗打开期间保持 permission-grant-keepalive 端口防 Event Page 休眠，结果回传后断开并关闭窗口", async () => {
    vi.useFakeTimers();
    installPermissionGrantDom(PERMISSION_GRANT_HTML);

    const events: string[] = [];
    const portDisconnect = vi.fn(() => {
      events.push("keepalive:disconnect");
    });
    const connectMock = vi.fn(() => {
      events.push("keepalive:connect");
      return {
        name: "permission-grant-keepalive",
        disconnect: portDisconnect,
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
      };
    });
    const requestMock = vi.fn(async () => true);
    const sendMessageMock = vi.fn((_msg: unknown, cb?: (resp: unknown) => void) => {
      events.push("result:send");
      cb?.({ ok: true });
      return undefined;
    });

    vi.stubGlobal("chrome", {
      permissions: { request: requestMock },
      runtime: { connect: connectMock, sendMessage: sendMessageMock, lastError: null }
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {
      events.push("window:close");
    });

    const { initPermissionGrantPage, PERMISSION_GRANT_KEEPALIVE_PORT_NAME } = await import(
      "../../extension/entry/permission-grant.js"
    );
    initPermissionGrantPage(`?reqId=req-keepalive&origins=${encodeURIComponent(JSON.stringify(["http://localhost/*"]))}`);

    expect(connectMock).toHaveBeenCalledWith({ name: PERMISSION_GRANT_KEEPALIVE_PORT_NAME });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(portDisconnect).not.toHaveBeenCalled();

    const allowBtn = document.getElementById("permissionGrantAllowBtn") as HTMLButtonElement;
    allowBtn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(portDisconnect).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "keepalive:connect",
      "result:send",
      "keepalive:disconnect",
      "window:close"
    ]);
  });

  it("窗口未点击按钮直接关闭（pagehide）时主动断开 keepalive 端口且幂等", async () => {
    installPermissionGrantDom(PERMISSION_GRANT_HTML);
    const portDisconnect = vi.fn();
    const connectMock = vi.fn(() => ({
      name: "permission-grant-keepalive",
      disconnect: portDisconnect,
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() }
    }));

    vi.stubGlobal("chrome", {
      permissions: { request: vi.fn(async () => true) },
      runtime: { connect: connectMock, sendMessage: vi.fn(), lastError: null }
    });

    const { initPermissionGrantPage } = await import("../../extension/entry/permission-grant.js");
    initPermissionGrantPage(`?reqId=req-close&origins=${encodeURIComponent(JSON.stringify(["http://localhost/*"]))}`);

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("beforeunload"));
    expect(portDisconnect).toHaveBeenCalledTimes(1);
  });
});
