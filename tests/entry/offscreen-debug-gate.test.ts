import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installMinimalChromeHost, type MinimalChromeHost, type MinimalChromeHostOptions } from "../helpers/chrome-runtime-host.js";
import type { createAsrDecodeHandler } from "../../extension/entry/offscreen-asr.js";

const { createAsrDecodeHandlerMock } = vi.hoisted(() => ({
  createAsrDecodeHandlerMock: vi.fn<typeof createAsrDecodeHandler>()
}));

type OnMessageListener = (
  message: unknown,
  sender?: chrome.runtime.MessageSender,
  sendResponse?: chrome.runtime.SendMessageCallback
) => void;

vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: createAsrDecodeHandlerMock
}));

const OFFSCREEN_SOURCES = [
  "../../extension/entry/offscreen.ts",
  "../../extension/entry/offscreen-chat-port.ts",
  "../../extension/entry/offscreen-asr.ts",
  "../../extension/entry/offscreen-lifecycle.ts",
  "../../extension/entry/offscreen-subtitle-slot.ts",
  "../../extension/entry/offscreen.html",
  "../../extension/core/provider-http-offscreen.ts",
  "../../extension/core/provider-http-shared.ts",
  "../../extension/asr/offscreen-bridge.page.ts"
];

const FORBIDDEN_API_RE = /chrome\.(storage|offscreen|declarativeNetRequest|tabs|permissions|scripting|action|alarms|windows|downloads)\b/g;

function readStrippedSource(relativePath: string) {
  const url = new URL(relativePath, import.meta.url);
  expect(existsSync(fileURLToPath(url)), `扫描目标存在：${relativePath}`).toBe(true);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("静态扫描：offscreen 文档不触碰扩展级 Chrome API", () => {
  it.each(OFFSCREEN_SOURCES)("代码里零 chrome.storage/offscreen/tabs 等扩展级 API：%s", (source) => {
    const offenders = readStrippedSource(source).match(FORBIDDEN_API_RE) || [];
    expect(offenders, `${source} 出现扩展级 API：${[...new Set(offenders)].join(", ")}`).toEqual([]);
  });

  it("chrome.runtime 消息能力保留（守卫不误伤）", () => {
    expect(readStrippedSource("../../extension/entry/offscreen.ts")).toMatch(/chrome\.runtime\./);
  });
});

let host: MinimalChromeHost;
let onMessageListeners: OnMessageListener[];

function installRuntimeExtras() {
  const runtime = chrome.runtime as unknown as Record<string, unknown>;
  runtime.lastError = null;
  runtime.onMessage = {
    addListener: (fn: OnMessageListener) => onMessageListeners.push(fn),
    removeListener: vi.fn(),
    hasListener: vi.fn()
  };
}

function stubOffscreenEnv(options: MinimalChromeHostOptions = {}) {
  onMessageListeners = [];
  host = installMinimalChromeHost({
    onConnect: true,
    replyStyle: "both",
    replies: { "get-debug-log-gate": { ok: true } },
    ...options
  });
  installRuntimeExtras();
}

async function importOffscreen(envOptions?: MinimalChromeHostOptions) {
  vi.resetModules();
  stubOffscreenEnv(envOptions);
  return import("../../extension/entry/offscreen.js");
}

function makeAsrPort() {
  const listeners: { message: Array<(msg: unknown) => void>; disconnect: Array<() => void> } = {
    message: [],
    disconnect: []
  };
  return {
    port: {
      name: "asr-decode",
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => {
          listeners.message.push(fn);
        },
        removeListener: () => {}
      },
      onDisconnect: {
        addListener: (fn: () => void) => {
          listeners.disconnect.push(fn);
        },
        removeListener: () => {}
      },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    send: (msg: unknown) => listeners.message.forEach((fn) => fn(msg)),
    fireDisconnect: () => listeners.disconnect.forEach((fn) => fn())
  };
}

beforeEach(() => {
  createAsrDecodeHandlerMock.mockReset();
});

describe("offscreen 调试日志门：初始读 + 变更广播都走 runtime 消息", () => {
  it("启动即向 SW 请求初始开关：get-debug-log-gate，enabled=true 时门打开", async () => {
    stubOffscreenEnv({
      replies: { "get-debug-log-gate": { ok: true, enabled: true } }
    });
    await import("../../extension/entry/offscreen.js");

    expect(host.sendMessage).toHaveBeenCalledWith(
      { type: "get-debug-log-gate" },
      expect.any(Function)
    );

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logging = await import("../../extension/shared/logging.js");
    await vi.waitFor(() => {
      logging.logInfo("[BILISCRIPT] gate on");
      expect(infoSpy).toHaveBeenCalledWith("[BILISCRIPT] gate on");
    });
    infoSpy.mockRestore();
  });

  it("SW 广播 debug-log-gate-changed 翻转本地门（true/false 双向）", async () => {
    await importOffscreen();
    expect(onMessageListeners.length).toBeGreaterThanOrEqual(1);
    const broadcastListener = onMessageListeners[0];

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logging = await import("../../extension/shared/logging.js");

    broadcastListener({ type: "debug-log-gate-changed", enabled: true });
    logging.logInfo("[BILISCRIPT] on");
    expect(infoSpy).toHaveBeenCalledTimes(1);

    broadcastListener({ type: "debug-log-gate-changed", enabled: false });
    logging.logInfo("[BILISCRIPT] off");
    expect(infoSpy).toHaveBeenCalledTimes(1);

    broadcastListener({ type: "something-else" });
    broadcastListener({ type: "debug-log-gate-changed" });
    logging.logInfo("[BILISCRIPT] still off");
    expect(infoSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
  });

  it("初始请求失败（lastError）：门维持缺省关，不抛未处理拒绝", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      stubOffscreenEnv();
      host.sendMessage.mockImplementation((_message, callback?: (response?: unknown) => void) => {
        const mutableRuntime = chrome.runtime as { lastError: chrome.runtime.LastError | null };
        mutableRuntime.lastError = { message: "Receiving end does not exist" };
        callback?.(undefined);
        mutableRuntime.lastError = null;
      });
      await import("../../extension/entry/offscreen.js");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logging = await import("../../extension/shared/logging.js");
      await new Promise((resolve) => setTimeout(resolve, 0));
      logging.logWarn("[BILISCRIPT] quiet");
      expect(warnSpy).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      warnSpy.mockRestore();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

import { DEFAULT_ASR_IDLE_GRACE_MS } from "../../extension/entry/offscreen-lifecycle.js";

describe("ASR 任务终态自关：closeDocument 改经 offscreen-request-close 消息", () => {
  function armTerminalEcho() {
    createAsrDecodeHandlerMock.mockImplementation(({ onTaskTerminal }) => {
      return async (_task, port) => {
        onTaskTerminal(port);
      };
    });
  }

  it("终态后在短宽限窗口到期向 SW 发 offscreen-request-close；SW 回 ok:true 不告警", async () => {
    vi.useFakeTimers();
    try {
      armTerminalEcho();
      await importOffscreen({
        replies: {
          "get-debug-log-gate": undefined,
          "offscreen-request-close": { ok: true }
        }
      });

      const session = makeAsrPort();
      host.onConnectListeners[0](session.port);
      session.send({ action: "asr-decode", task: {} });

      await vi.advanceTimersByTimeAsync(DEFAULT_ASR_IDLE_GRACE_MS);
      expect(host.sendMessage).toHaveBeenCalledWith(
        { type: "offscreen-request-close", reason: "asr-idle" },
        expect.any(Function)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("SW 明确回 ok:false（请求被拒/关闭失败）：记 logWarn，不抛", async () => {
    vi.useFakeTimers();
    try {
      armTerminalEcho();
      await importOffscreen({
        replies: {
          "get-debug-log-gate": undefined,
          "offscreen-request-close": { ok: false, error: "仅接受 offscreen 文档发送" }
        }
      });

      onMessageListeners[0]({ type: "debug-log-gate-changed", enabled: true });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = makeAsrPort();
      host.onConnectListeners[0](session.port);
      session.send({ action: "asr-decode", task: {} });

      await vi.advanceTimersByTimeAsync(DEFAULT_ASR_IDLE_GRACE_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] offscreen closeDocument after asr task failed",
        { error: "仅接受 offscreen 文档发送" }
      );
      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("回包丢失（成功关闭时文档随之销毁）：静默，不告警也不抛 unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      armTerminalEcho();
      await importOffscreen({
        replyStyle: "promise",
        replies: {
          "get-debug-log-gate": { ok: true },
          "offscreen-request-close": { ok: true }
        }
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = makeAsrPort();
      host.onConnectListeners[0](session.port);
      session.send({ action: "asr-decode", task: {} });

      await vi.advanceTimersByTimeAsync(DEFAULT_ASR_IDLE_GRACE_MS + 10);
      expect(unhandled).toEqual([]);
      warnSpy.mockRestore();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });
});
