// 工单 03：offscreen 文档只保留标准 Web API + chrome.runtime 消息能力。
//
// 三段验证：
//   1. 静态扫描：entry/offscreen*.ts 与 offscreen.html 的代码（剥注释后）不再
//      出现 chrome.storage / chrome.offscreen / 其他扩展级 API——storage 读写、
//      closeDocument 等扩展级操作一律由 SW 代执行；
//   2. 调试日志门消息化：初始开关经 "get-debug-log-gate" 向 SW 读，变更靠
//      SW 广播的 "debug-log-gate-changed" 翻转（offscreen 侧零 chrome.storage）；
//   3. ASR 任务终态自关：直调 chrome.offscreen.closeDocument 改为
//      "offscreen-request-close" 消息请求 SW 代执行——SW 明确 ok:false 时记
//      日志，回包丢失（文档已在关闭中）静默不抛。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installMinimalChromeHost, type MinimalChromeHost, type MinimalChromeHostOptions } from "../helpers/chrome-runtime-host.js";
import type { createAsrDecodeHandler } from "../../extension/entry/offscreen-asr.js";

const { createAsrDecodeHandlerMock } = vi.hoisted(() => ({
  createAsrDecodeHandlerMock: vi.fn<typeof createAsrDecodeHandler>()
}));

// sender / sendResponse 可选：测试里按消息单参直调广播监听
type OnMessageListener = (
  message: unknown,
  sender?: chrome.runtime.MessageSender,
  sendResponse?: chrome.runtime.SendMessageCallback
) => void;

vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: createAsrDecodeHandlerMock
}));

// ===== 1. 静态扫描：offscreen 侧零扩展级 API =====

const OFFSCREEN_SOURCES = [
  "../../extension/entry/offscreen.ts",
  "../../extension/entry/offscreen-asr.ts",
  "../../extension/entry/offscreen-lifecycle.ts",
  "../../extension/entry/offscreen-subtitle-slot.ts",
  "../../extension/entry/offscreen.html",
  // 概览代发通道的 offscreen 半边（overview-offscreen-transport）：接收端在
  // core/provider-http-offscreen.ts，同文件另有 content 侧发送端（不在本文档内运行）
  "../../extension/core/provider-http-offscreen.ts",
  // 概览代发链的传输层公共件叶（两端共用）：叶子纪律零 chrome.*，已由
  // tests/core/provider-http-shared.test.ts 钉住，此处双保险
  "../../extension/core/provider-http-shared.ts",
  // 页面半边（内容脚本侧，见上方注释）：纵深防御收编（r1 审查 P2）
  "../../extension/asr/offscreen-bridge.page.ts"
];

// 扩展级 Chrome API 黑名单：offscreen 只保留标准 Web API + chrome.runtime 消息
const FORBIDDEN_API_RE = /chrome\.(storage|offscreen|declarativeNetRequest|tabs|permissions|scripting|action|alarms|windows|downloads)\b/g;

// offscreen-bridge.page.ts 是内容脚本侧（offscreen 桥的页面半边），不在
// offscreen 文档内运行，本就不受「offscreen 只剩 chrome.runtime」的平台约束；
// 收编进扫描是 r1 审查 P2 的纵深防御要求：桥链两端的运行时源码都不得新增
// 扩展级 chrome API（该文件现仅用 chrome.runtime.connect/sendMessage）。

function readStrippedSource(relativePath: string) {
  const url = new URL(relativePath, import.meta.url);
  expect(existsSync(fileURLToPath(url)), `扫描目标存在：${relativePath}`).toBe(true);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  // 剥块注释与整行注释：注释里的 API 名举例（如「chrome.offscreen 由 SW 代执行」）
  // 不参与扫描
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

// ===== 2/3. 行为测试：消息式调试门 + 自关请求 =====

let host: MinimalChromeHost;
let onMessageListeners: OnMessageListener[];

// 本文件原有的 runtime 面是 lastError / onConnect / onMessage / sendMessage：共享宿主
// 收编按 type 分发的 sendMessage 与 onConnect 登记袋；其余成员宿主不装，仍在宿主装好的
// 最小面上补回（本文件要 onMessage 接 SW 的 debug-log-gate-changed 广播），chrome 面
// 与替换前逐字相同。
function installRuntimeExtras() {
  const runtime = chrome.runtime as unknown as Record<string, unknown>;
  runtime.lastError = null;
  runtime.onMessage = {
    addListener: (fn: OnMessageListener) => onMessageListeners.push(fn),
    removeListener: vi.fn(),
    hasListener: vi.fn()
  };
}

// 缺省面：原桩缺省对任何 type 回 { ok: true }，本文档会发的只有加载期的
// get-debug-log-gate，故登记这一条。replyStyle "both"：原桩回包只经 callback，宿主
// 两种风格同答（多出的 promise 返回值无人读）；「不回包」的用例按需覆盖为 "promise"。
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
    // 只答 get-debug-log-gate，回包带 enabled=true（原 impl 的判别即此一条）
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

    // 非门广播（其他消息）不翻转
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
      // 回包前置 lastError、回包后复位：宿主的回包表只回答「回什么」，表达不了回包前后
      // 改 lastError 这条事实，故本用例仍按原 impl 接管宿主公开的 sendMessage Mock。
      host.sendMessage.mockImplementation((_message, callback?: (response?: unknown) => void) => {
        // chrome-types 里 lastError 是只读 const，测试替身需可写
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

describe("ASR 任务终态自关：closeDocument 改经 offscreen-request-close 消息", () => {
  function armTerminalEcho() {
    // 任务执行器立即回终态：触发 lifetime.noteAsrTerminal（端口已入集、
    // 无聊天端口 → 应自关）
    createAsrDecodeHandlerMock.mockImplementation(({ onTaskTerminal }) => {
      return async (_task, port) => {
        onTaskTerminal(port);
      };
    });
  }

  it("终态后向 SW 发 offscreen-request-close；SW 回 ok:true 不告警", async () => {
    armTerminalEcho();
    // 原 impl 只答 offscreen-request-close；加载期的 get-debug-log-gate 无实质回包
    //（宿主以回 undefined 表达「无应答」，与真实 MV3 同形）
    await importOffscreen({
      replies: {
        "get-debug-log-gate": undefined,
        "offscreen-request-close": { ok: true }
      }
    });

    const session = makeAsrPort();
    host.onConnectListeners[0](session.port);
    session.send({ action: "asr-decode", task: {} });

    await vi.waitFor(() =>
      expect(host.sendMessage).toHaveBeenCalledWith(
        { type: "offscreen-request-close" },
        expect.any(Function)
      )
    );
  });

  it("SW 明确回 ok:false（请求被拒/关闭失败）：记 logWarn，不抛", async () => {
    armTerminalEcho();
    await importOffscreen({
      replies: {
        "get-debug-log-gate": undefined,
        "offscreen-request-close": { ok: false, error: "仅接受 offscreen 文档发送" }
      }
    });

    // logWarn 走调试门：先经广播把门打开，告警才可观测
    onMessageListeners[0]({ type: "debug-log-gate-changed", enabled: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = makeAsrPort();
    host.onConnectListeners[0](session.port);
    session.send({ action: "asr-decode", task: {} });

    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] offscreen closeDocument after asr task failed",
        { error: "仅接受 offscreen 文档发送" }
      )
    );
    warnSpy.mockRestore();
  });

  it("回包丢失（成功关闭时文档随之销毁）：静默，不告警也不抛 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // 原 impl 不回任何包：promise 风格只给返回值、不答 callback（sendRuntimeMessage
      // 的 promise 永不 settle）。回包值无人读，本文档会发的两条仍按宿主契约登记。
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

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      warnSpy.mockRestore();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
