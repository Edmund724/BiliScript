// ASR 转写链 host 权限预检（ADR-0010 残留收口）。
//
// ASR 链的平台请求在 offscreen 内直发（asr/adapters/openai-transcriptions.ts 的
// fetch，由 entry/offscreen-asr.ts 驱动），而 offscreen 文档只有 chrome.runtime、
// 查不了 chrome.permissions——未授权落到 fetch 上只表现为「网络错误：Failed to
// fetch」。本轮在链入口（resolveAsrProvider 之后、下载/解码之前）补一层经 SW 代查
// 的预检：未授权即以 HOST_PERMISSION_HINT 失败，连音频都不下载（否则白下载解码
// 一场才报一个看不出原因的错）。
//
// 真链路（entry/offscreen.js 的 onConnect 接线 + 懒装载的 offscreen-asr.js）+
// promise 风格 sendMessage stub，手法沿 offscreen-asr-skip.test.js。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";

const ASR_BASE_URL = "https://api.siliconflow.cn/v1";

// get-asr-runtime-config 的完整快照（激活平台 + Key），让链一路走到下载
const RUNTIME_CONFIG = {
  ok: true,
  asrAutoFallback: true,
  activeAsrProviderId: "p1",
  providers: [
    {
      id: "p1",
      type: "openai-transcriptions",
      name: "硅基流动",
      presetId: "preset-siliconflow",
      baseUrl: ASR_BASE_URL,
      model: "FunASR-Nano-2512",
      supportsTimestamps: true,
      enabled: true
    }
  ],
  activeKey: "sk-test",
  asrLanguage: "auto"
};

let onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;
// 消息与请求的到达顺序：断言预检发生在下载之前
let events: string[] = [];
// check-provider-origin 的回包（undefined = 无回包，fail-open 用例）
let checkReply: unknown;

function replyFor(message: { type?: string } | null | undefined) {
  if (message?.type === "get-asr-runtime-config") {
    return RUNTIME_CONFIG;
  }
  if (message?.type === "check-provider-origin") {
    return checkReply;
  }
  return { ok: true };
}

// 同时支持两种发送方式：offscreen 本链的 get-asr-runtime-config 走 promise 风格直发，
// shared/messaging.js 的 sendRuntimeMessage 走回调——stub 两种都答，免得到依赖
// 某一种时挂住（既有 offscreen-asr-skip.test.js 的 stub 说明）。
function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      onConnect: {
        addListener: vi.fn((fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn))
      },
      sendMessage: vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
        events.push(`msg:${message?.type}`);
        const reply = replyFor(message);
        callback?.(reply);
        return Promise.resolve(reply);
      })
    }
  });
}

beforeEach(() => {
  resetModuleState();
  onConnectListeners = [];
  events = [];
  checkReply = { granted: true };
  stubChromeRuntime();
  // 下载一律失败：只想证明「预检放行了才走到下载」，不真跑解码/转写
  fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) => {
    events.push(`fetch:${init?.method || "GET"}`);
    return { ok: false, status: 500 };
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function loadOffscreen() {
  return import("../../extension/entry/offscreen.js");
}

// 连一个可手动驱动消息的 asr-decode 端口，返回 { port, taskListener }
function connectAsrDecodePort() {
  const listener = onConnectListeners[onConnectListeners.length - 1];
  expect(listener, "offscreen.js 应已在模块加载时注册 onConnect 监听").toBeTruthy();
  const listeners = new Set<(message: unknown) => void>();
  const port = {
    name: "asr-decode",
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: vi.fn()
    },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn()
  };
  listener(port);
  return { port, taskListener: [...listeners][0] };
}

// 跑一次解码任务，等终态消息（{ type: error }）落地后返回它
async function runDecodeTask() {
  const { port, taskListener } = connectAsrDecodePort();
  taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
  return { port, payload: port.postMessage.mock.calls[0][0] as { type?: string; error?: string; code?: string } };
}

describe("ASR 转写链 host 权限预检", () => {
  it("未授权（SW 回 { granted: false }）→ 可操作文案终态，连音频都不下载", async () => {
    await loadOffscreen();
    checkReply = { granted: false };

    const { payload } = await runDecodeTask();

    // kind 随 ERROR 到站（asr-error-reporting/03 Q2）：域名未授权是配置类问题，
    // 不是平台拒绝，故归 no-asr-config（票 04 判定次序第 0 步）。
    expect(payload).toEqual({ type: "error", error: HOST_PERMISSION_HINT, kind: "no-asr-config" });
    expect(fetchMock).not.toHaveBeenCalled();
    // 预检排在配置解析之后、没有任何下载请求
    expect(events.indexOf("msg:check-provider-origin")).toBeGreaterThan(events.indexOf("msg:get-asr-runtime-config"));
    expect(events.filter((event) => event.startsWith("fetch:"))).toEqual([]);
  });

  it("已授权（{ granted: true }）→ 预检放行，下载照常开始", async () => {
    await loadOffscreen();
    checkReply = { granted: true };

    const { payload } = await runDecodeTask();

    // 走到下载才失败（stub 的下载一律 500），而非被预检拦下；音轨下载失败属
    // 媒体来源（票 04 判定次序第 0 步：音轨下载 / 解码 / 切片类 → asr-media）
    expect(payload).toEqual({ type: "error", error: "音频下载失败", kind: "asr-media" });
    expect(events.indexOf("msg:check-provider-origin")).toBeLessThan(events.indexOf("fetch:HEAD"));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open，不新造拦截面", async () => {
    await loadOffscreen();
    checkReply = undefined;

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: "音频下载失败", kind: "asr-media" });
    expect(payload.code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });
});
