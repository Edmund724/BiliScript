import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  installMinimalChromeHost,
  type MinimalChromeHost,
  type MinimalChromeHostOptions
} from "../helpers/chrome-runtime-host.js";
import { resolveAsrProvider, type AsrRuntimeConfig } from "../../extension/entry/offscreen-asr.js";

const RUNTIME_CONFIG_OK: AsrRuntimeConfig = {
  asrAutoFallback: true,
  activeAsrProviderId: "p1",
  providers: [
    {
      id: "p1",
      type: "openai-transcriptions",
      name: "硅基流动",
      presetId: "preset-siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "FunASR-Nano-2512",
      supportsTimestamps: true,
      enabled: true
    }
  ],
  activeKey: "sk-test",
  asrLanguage: "auto"
};

let host: MinimalChromeHost;

function refuseSendMessage(): never {
  throw new Error("Extension context invalidated");
}

function swapHost(options: MinimalChromeHostOptions) {
  const registered = host.onConnectListeners.slice();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    ...options
  });
  host.onConnectListeners.push(...registered);
}

beforeEach(() => {
  resetModuleState();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replyStyle: "both",
    replies: { "get-debug-log-gate": { ok: true } }
  });
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

describe("resolveAsrProvider 结构化 skip 原因", () => {
  it("快照关闭（asrAutoFallback === false）：asr-skip 且 reason=asr-disabled", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_OK, asrAutoFallback: false })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "asr-disabled",
        message: "ASR 自动回退未开启"
      })
    );
  });

  it("平台列表为空：asr-skip 且 reason=no-asr-config", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_OK, providers: [], activeAsrProviderId: "" })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "no-asr-config",
        message: "没有激活的语音识别平台"
      })
    );
  });

  it("列表非空但 activeAsrProviderId 为空或悬空：自动回退到列表首项", () => {
    expect(resolveAsrProvider({ ...RUNTIME_CONFIG_OK, activeAsrProviderId: "" })).toMatchObject({
      id: "p1",
      apiKey: "sk-test"
    });
    expect(resolveAsrProvider({ ...RUNTIME_CONFIG_OK, activeAsrProviderId: "ghost" })).toMatchObject({
      id: "p1",
      apiKey: "sk-test"
    });
  });

  it("配置齐全：不抛错，provider 附 Key 与生效语言", () => {
    const provider = resolveAsrProvider(RUNTIME_CONFIG_OK);

    expect(provider).toMatchObject({
      id: "p1",
      type: "openai-transcriptions",
      apiKey: "sk-test",
      language: "auto"
    });
  });
});

describe("handleAsrDecodeTask 错误消息携带 reason（port 透传契约）", () => {
  it("asr-skip 的结构化 reason 随 { type: error } 消息 postMessage 回页面", async () => {
    await loadOffscreen();
    swapHost({
      replies: {
        "get-asr-runtime-config": { ok: true },
        "offscreen-request-close": { ok: true }
      }
    });
    const { port, taskListener } = connectAsrDecodePort();

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(port.postMessage.mock.calls[0][0]).toEqual({
      type: "error",
      error: "没有激活的语音识别平台",
      code: "asr-skip",
      reason: "no-asr-config"
    });
  });

  it("config 消息失败/超时的 asr-skip 不带 reason（未知，页面归 null）", async () => {
    await loadOffscreen();
    swapHost({
      replyStyle: "both",
      replies: {
        "get-debug-log-gate": refuseSendMessage,
        "get-asr-runtime-config": refuseSendMessage,
        "offscreen-request-close": refuseSendMessage
      }
    });
    const { port, taskListener } = connectAsrDecodePort();

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    const payload = port.postMessage.mock.calls[0][0];
    expect(payload.type).toBe("error");
    expect(payload.code).toBe("asr-skip");
    expect(payload.reason).toBeUndefined();
    expect(payload.kind).toBeUndefined();
  });
});

describe("handleAsrDecodeTask 管线级失败携带 kind（port 透传契约）", () => {
  const CONFIG_WITH_PROVIDER = {
    ok: true,
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    providers: [
      {
        id: "p1",
        type: "openai-transcriptions",
        name: "硅基流动",
        presetId: "preset-siliconflow",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "FunASR-Nano-2512",
        supportsTimestamps: true,
        enabled: true
      }
    ],
    activeKey: "sk-test",
    asrLanguage: "auto"
  };

  async function runWithDownloadFailure() {
    await loadOffscreen();
    swapHost({
      replies: {
        "get-asr-runtime-config": CONFIG_WITH_PROVIDER,
        "check-provider-origin": { granted: true },
        "offscreen-request-close": { ok: true }
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const { port, taskListener } = connectAsrDecodePort();
    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    return port.postMessage.mock.calls[0][0] as Record<string, unknown>;
  }

  it("音轨下载失败（媒体来源）→ kind=asr-media", async () => {
    const payload = await runWithDownloadFailure();

    expect(payload.type).toBe("error");
    expect(payload.error).toBe("音频下载失败");
    expect(payload.kind).toBe("asr-media");
  });
});
