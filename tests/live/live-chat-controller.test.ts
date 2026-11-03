// tests/live/live-chat-controller.test.ts
// LiveChatController 状态机、交互分支、手势同步性与迟到事件防御测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveChatController,
  type LiveChatController
} from "../../extension/live/live-chat-controller.js";

class FakePort {
  name: string;
  disconnected = false;
  postedMessages: any[] = [];
  messageListeners: ((msg: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];

  constructor(name = "test-port") {
    this.name = name;
  }

  get onMessage() {
    return {
      addListener: (fn: (msg: any) => void) => {
        this.messageListeners.push(fn);
      }
    };
  }

  get onDisconnect() {
    return {
      addListener: (fn: () => void) => {
        this.disconnectListeners.push(fn);
      }
    };
  }

  postMessage(msg: any) {
    this.postedMessages.push(msg);
  }

  disconnect() {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) {
      fn();
    }
  }

  simulateMessage(msg: any) {
    for (const fn of this.messageListeners) {
      fn(msg);
    }
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("LiveChatController", () => {
  function setupTest(overrides: {
    getTargetOrigin?: () => string;
    requestOrigins?: (origins: string[]) => Promise<{ ok: boolean; error?: string }>;
    sendRuntimeMessage?: (msg: any) => Promise<any>;
    port?: FakePort;
  } = {}) {
    const liveButton = document.createElement("button");
    const showNotice = vi.fn();
    const fakePort = overrides.port || new FakePort();
    const connectPort = vi.fn(() => fakePort as any);

    const requestOrigins = overrides.requestOrigins || vi.fn(async () => ({ ok: true }));
    const sendRuntimeMessage = overrides.sendRuntimeMessage || vi.fn(async (msg: any) => {
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          provider: {
            id: "moss-1",
            baseUrl: "https://api.mosi.cn",
            model: "moss-live-1.0"
          }
        };
      }
      if (msg.type === "live-session-cleanup") {
        return { ok: true };
      }
      return { ok: true };
    });

    const controller = createLiveChatController({
      liveButton,
      showNotice,
      connectPort,
      sendRuntimeMessage,
      requestOrigins,
      getTargetOrigin: overrides.getTargetOrigin
    });

    return {
      controller,
      liveButton,
      showNotice,
      fakePort,
      connectPort,
      sendRuntimeMessage,
      requestOrigins
    };
  }

  it("initializes with idle state and appropriate attributes", () => {
    const { controller, liveButton } = setupTest();

    expect(controller.getState()).toBe("idle");
    expect(liveButton.dataset.state).toBe("idle");
    expect(liveButton.getAttribute("aria-pressed")).toBe("false");
    expect(liveButton.getAttribute("aria-busy")).toBe("false");
    expect(liveButton.title).toContain("开启实时伴看");
  });

  it("initiates permission request synchronously from start before any await tick", () => {
    let permCalled = false;
    const requestOrigins = vi.fn(async () => {
      permCalled = true;
      return { ok: true };
    });

    const { controller } = setupTest({ requestOrigins });

    // Call start synchronously
    const startPromise = controller.start();

    // Must be invoked synchronously in the same call frame (preserves user gesture)
    expect(permCalled).toBe(true);
    expect(requestOrigins).toHaveBeenCalledWith(["https://api.mosi.cn"]);

    return startPromise;
  });

  it("requests custom origin synchronously from getTargetOrigin without requesting default api.mosi.cn", async () => {
    const requestOrigins = vi.fn(async () => ({ ok: true }));
    const { controller } = setupTest({
      getTargetOrigin: () => "https://custom.live.mosi.cn:8080",
      requestOrigins
    });

    await controller.start();

    expect(requestOrigins).toHaveBeenCalledWith(["https://custom.live.mosi.cn:8080"]);
    expect(requestOrigins).not.toHaveBeenCalledWith(["https://api.mosi.cn"]);
  });

  it("surfaces actionable re-save-in-settings error when background check detects revoked permission", async () => {
    const { controller, liveButton, showNotice } = setupTest({
      sendRuntimeMessage: async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return {
            ok: false,
            error: "未授予平台域名权限（https://custom.live.mosi.cn），请在设置中重新保存该平台以授予权限"
          };
        }
        return { ok: true };
      }
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith(
      "未授予平台域名权限（https://custom.live.mosi.cn），请在设置中重新保存该平台以授予权限"
    );
  });

  it("handles user denial of host permissions with actionable failure state", async () => {
    const { controller, liveButton, showNotice } = setupTest({
      requestOrigins: async () => ({
        ok: false,
        error: "用户拒绝授予 host_permissions：未授权 https://api.mosi.cn/*"
      })
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("未授权 https://api.mosi.cn/*"));
  });

  it("handles preparation failure (e.g. missing API key)", async () => {
    const { controller, liveButton, showNotice } = setupTest({
      sendRuntimeMessage: async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return { ok: false, error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key" };
        }
        return { ok: true };
      }
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith("未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key");
  });

  it("transitions to connecting, posts start to port, and switches to connected upon connected event", async () => {
    const { controller, liveButton, fakePort } = setupTest();

    const startPromise = controller.start();
    expect(controller.getState()).toBe("connecting");
    expect(liveButton.classList.contains("is-connecting")).toBe(true);

    const ok = await startPromise;
    expect(ok).toBe(true);

    // Posted start message to port
    expect(fakePort.postedMessages).toEqual([
      { action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0" }
    ]);

    // Simulate connected event
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");
    expect(liveButton.classList.contains("is-connected")).toBe(true);
    expect(liveButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("transitions to failure and cleans up rule on port error message", async () => {
    const { controller, liveButton, fakePort, showNotice, sendRuntimeMessage } = setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");

    fakePort.simulateMessage({ type: "error", error: "WebSocket 连接失败" });

    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith("WebSocket 连接失败");
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });

  it("stop() closes connection, calls cleanup, and resets to idle", async () => {
    const { controller, liveButton, fakePort, sendRuntimeMessage } = setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    await controller.stop();

    expect(controller.getState()).toBe("idle");
    expect(liveButton.dataset.state).toBe("idle");
    expect(liveButton.classList.contains("is-connected")).toBe(false);
    expect(fakePort.postedMessages).toContainEqual({ action: "stop" });
    expect(fakePort.disconnected).toBe(true);
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });

  it("rejects late events from stopped session (generation check)", async () => {
    const { controller, liveButton, fakePort } = setupTest();

    await controller.start();
    // Stop session while still in connecting
    await controller.stop();
    expect(controller.getState()).toBe("idle");

    // Late connected event arrives from old port
    fakePort.simulateMessage({ type: "connected" });

    // Should still be idle, NOT flipped to connected
    expect(controller.getState()).toBe("idle");
    expect(liveButton.classList.contains("is-connected")).toBe(false);
  });

  it("regression: when stop() races in-flight live-session-prepare, stale return cleans up session rule", async () => {
    let resolvePrepare!: (val: any) => void;
    const preparePromise = new Promise((resolve) => {
      resolvePrepare = resolve;
    });

    const { controller, sendRuntimeMessage } = setupTest({
      sendRuntimeMessage: vi.fn(async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return preparePromise;
        }
        return { ok: true };
      })
    });

    const startPromise = controller.start();
    expect(controller.getState()).toBe("connecting");

    // User calls stop while prepare is in-flight
    await controller.stop();
    expect(controller.getState()).toBe("idle");

    // Now background prepare resolves
    resolvePrepare({
      ok: true,
      provider: { id: "moss-1", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" }
    });

    const ok = await startPromise;
    expect(ok).toBe(false);
    expect(controller.getState()).toBe("idle");
    // Verify cleanup was invoked for the stale prepare completion so rule does not leak
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });
});
