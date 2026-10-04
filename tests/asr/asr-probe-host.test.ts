// asr/offscreen-bridge.page.js 探针客户端（probeAsrProviderViaOffscreen）测试。
//
// 页面侧（content script）把草稿 provider 交给 offscreen 的真适配器跑一次连通性
// 探针，本文件钉住这条客户端的边界契约：
//   - 任务消息形状：草稿字段（type/baseUrl/model/apiKey/language）随 asr-probe
//     任务过去——含用户在表单里新输、还没保存的 Key；
//   - 任何「没等到回执」的路径都以可读错误收口，**绝不当成通过**（这是本次修复
//     的要害：旧探针在 content script 里自己发 fetch，无 chrome.permissions 故
//     权限门必然 fail-open，域名未授权也能报「连接成功」）：
//     ① offscreen 文档自愈失败（ensure-offscreen-chat 回 ok:false）→ 连端口都
//        不连；② 端口连上即断（文档未就绪）→ 可读错误；③ 超时 → 可读错误 +
//        断开端口（测试按钮不会永远转圈）；
//   - 回执 ok:false 的文案原样透传（与实际转写同一串，如 HTTP 401 的报文）；
//   - 不经 offload-task 的 prepare/cleanup：探针不发音轨请求，不占防盗链规则 id。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { ASR_PROBE_TIMEOUT_MS } from "../../extension/asr/protocol.js";

// 与 offscreen-chunk-host.test.ts 同款 connect mock：捕获每次 connect，把端口的
// onMessage/onDisconnect 监听器存下来，用例内手动派发。
function installChromeStub(options: { ensureReply?: unknown; ensureThrows?: boolean } = {}) {
  const connections: any[] = [];
  const sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    if (message?.type === "ensure-offscreen-chat") {
      if (options.ensureThrows) {
        throw new Error("no receiving end");
      }
      callback?.(options.ensureReply ?? { ok: true, ensured: true });
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
  const connect = vi.fn(() => {
    const listeners = new Set<(msg: unknown) => void>();
    const disconnectListeners = new Set<() => void>();
    const port = {
      name: "asr-decode",
      posted: [] as unknown[],
      postMessage: vi.fn((msg: unknown) => port.posted.push(msg)),
      onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.add(fn) },
      onDisconnect: { addListener: (fn: () => void) => disconnectListeners.add(fn) },
      disconnect: vi.fn(),
      _emit: (msg: unknown) => listeners.forEach((fn) => fn(msg)),
      _emitDisconnect: () => disconnectListeners.forEach((fn) => fn())
    };
    connections.push(port);
    return port;
  });
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: { ...globalThis.chrome.runtime, sendMessage, connect }
  });
  return { connect, connections, sendMessage };
}

const PROBE_INPUT = {
  type: "openai-transcriptions",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "XingChenAGI/XingChenASR-V3.2",
  apiKey: "sk-draft",
  language: "auto"
};

beforeEach(() => {
  resetModuleState();
});

async function loadBridge() {
  return import("../../extension/asr/offscreen-bridge.page.js");
}

describe("探针客户端：任务下发与回执", () => {
  it("草稿 provider 随 asr-probe 任务过去（含新输 Key 与语言档位），成功后断开端口", async () => {
    const { connect, connections } = installChromeStub();
    const bridge = await loadBridge();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const port = connections[0];

    expect(connect).toHaveBeenCalledWith({ name: "asr-decode" });
    expect(port.posted).toEqual([{ action: "asr-probe", task: PROBE_INPUT }]);

    port._emit({ type: "probe-result", ok: true });
    expect(await promise).toEqual({ ok: true });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("回执失败：文案原样透传（与实际转写同一串），不吞报文", async () => {
    const { connections } = installChromeStub();
    const bridge = await loadBridge();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0]._emit({
      type: "probe-result",
      ok: false,
      error: 'HTTP 401: {"code":30014,"data":null,"message":"Token is invalid."}',
      kind: "asr-auth",
      status: 401
    });

    expect(await promise).toEqual({
      ok: false,
      error: 'HTTP 401: {"code":30014,"data":null,"message":"Token is invalid."}'
    });
  });

  it("其他类型消息（如解码通道的 done）不误收为探针回执", async () => {
    const { connections } = installChromeStub();
    const bridge = await loadBridge();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0]._emit({ type: "done", totalChunks: 0, skippedSegments: 0, failedChunks: 0 });
    connections[0]._emit({ type: "probe-result", ok: true });

    expect(await promise).toEqual({ ok: true });
  });
});

describe("探针客户端：未等到回执一律不报通过", () => {
  it("offscreen 文档自愈失败 → 回可读错误，连端口都不连", async () => {
    const { connect } = installChromeStub({ ensureReply: { ok: false, error: "offscreen 创建失败" } });
    const bridge = await loadBridge();

    expect(await bridge.probeAsrProviderViaOffscreen(PROBE_INPUT)).toEqual({
      ok: false,
      error: "offscreen 创建失败"
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("端口连上即断（文档未就绪）→ 回可读错误，不当成通过", async () => {
    const { connections } = installChromeStub();
    const bridge = await loadBridge();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]._emitDisconnect();

    const out = await promise;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("断开");
  });

  it("超时（ASR_PROBE_TIMEOUT_MS 无回执）→ 回可读错误并断开端口", async () => {
    const { connections } = installChromeStub();
    const bridge = await loadBridge();
    vi.useFakeTimers();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ASR_PROBE_TIMEOUT_MS);

    const out = await promise;
    expect(out.ok).toBe(false);
    expect(out.error).toContain("超时");
    expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("探针客户端：不占防盗链规则", () => {
  it("不经 offload-task 的 prepare/cleanup（探针不发音轨请求，不分配 DNR 规则 id）", async () => {
    const { sendMessage, connections } = installChromeStub();
    const bridge = await loadBridge();

    const promise = bridge.probeAsrProviderViaOffscreen(PROBE_INPUT);
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]._emit({ type: "probe-result", ok: true });
    await promise;

    const offloadCalls = sendMessage.mock.calls.filter(
      (call) => (call[0] as { type?: string })?.type === "offload-task"
    );
    expect(offloadCalls).toEqual([]);
  });
});
