import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { HOST_INVALID_ORIGIN_HINT, HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const ASR_BASE_URL = "https://api.siliconflow.cn/v1";

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

let host: MinimalChromeHost;
let fetchMock: ReturnType<typeof vi.fn>;
let events: string[] = [];
let checkReply: unknown;

function installHost() {
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replyStyle: "both",
    replies: {
      "get-asr-runtime-config": () => {
        events.push("msg:get-asr-runtime-config");
        return RUNTIME_CONFIG;
      },
      "check-provider-origin": () => {
        events.push("msg:check-provider-origin");
        return checkReply;
      }
    }
  });
}

beforeEach(() => {
  resetModuleState();
  events = [];
  checkReply = { granted: true };
  installHost();
  fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) => {
    events.push(`fetch:${init?.method || "GET"}`);
    return { ok: false, status: 500 };
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function loadOffscreen() {
  return import("../../extension/entry/offscreen.js");
}

function connectAsrDecodePort() {
  const listener = host.onConnectListeners.at(-1)!;
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

    expect(payload).toEqual({ type: "error", error: HOST_PERMISSION_HINT, kind: "no-asr-config" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.indexOf("msg:check-provider-origin")).toBeGreaterThan(events.indexOf("msg:get-asr-runtime-config"));
    expect(events.filter((event) => event.startsWith("fetch:"))).toEqual([]);
  });

  it("已授权（{ granted: true }）→ 预检放行，下载照常开始", async () => {
    await loadOffscreen();
    checkReply = { granted: true };

    const { payload } = await runDecodeTask();

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

  it("ASR provider.baseUrl 非法 → 显式报 no-asr-config，不发 check-provider-origin 也不下载音频", async () => {
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      replyStyle: "both",
      replies: {
        "get-asr-runtime-config": () => ({
          ...RUNTIME_CONFIG,
          providers: [{ ...RUNTIME_CONFIG.providers[0], baseUrl: "oops" }]
        }),
        "check-provider-origin": () => {
          events.push("msg:check-provider-origin");
          return { granted: true, status: "granted" };
        }
      }
    });
    await loadOffscreen();

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: HOST_INVALID_ORIGIN_HINT, kind: "no-asr-config" });
    expect(events).not.toContain("msg:check-provider-origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
