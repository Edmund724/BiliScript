// offscreen 侧概览代发接线（overview-offscreen-transport）：
// - 端口 provider-http-offscreen 被认领后，请求在 offscreen 里 fetch 并按
//   「响应头 → 正文分片 → done」分块回吐；
// - 代发请求在飞期间，ASR 任务终态不得自关文档（概览是分钟级请求，被自关吞掉
//   的话回吐永远不到）；
// - 代发结束后，ASR 终态照旧自关（既有行为不被破坏）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { createAsrDecodeHandler } from "../../extension/entry/offscreen-asr.js";

const { createAsrDecodeHandlerMock } = vi.hoisted(() => ({
  createAsrDecodeHandlerMock: vi.fn<typeof createAsrDecodeHandler>()
}));

vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: createAsrDecodeHandlerMock
}));

type OnConnectListener = (port: chrome.runtime.Port) => void;
type OnMessageListener = (
  message: unknown,
  sender?: chrome.runtime.MessageSender,
  sendResponse?: chrome.runtime.SendMessageCallback
) => void;

let onConnectListeners: OnConnectListener[];
let onMessageListeners: OnMessageListener[];
let sentMessages: Array<{ type?: string } & Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

function stubOffscreenEnv() {
  onConnectListeners = [];
  onMessageListeners = [];
  sentMessages = [];
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      onConnect: { addListener: (fn: OnConnectListener) => onConnectListeners.push(fn) },
      onMessage: {
        addListener: (fn: OnMessageListener) => onMessageListeners.push(fn),
        removeListener: vi.fn(),
        hasListener: vi.fn()
      },
      sendMessage: vi.fn((message: { type?: string }, callback?: (response?: unknown) => void) => {
        sentMessages.push(message);
        callback?.({ ok: true });
        return undefined;
      })
    }
  });
}

async function importOffscreen() {
  vi.resetModules();
  resetModuleState();
  stubOffscreenEnv();
  return import("../../extension/entry/offscreen.js");
}

function makePort(name: string) {
  const listeners: { message: Array<(msg: unknown) => void>; disconnect: Array<() => void> } = {
    message: [],
    disconnect: []
  };
  return {
    port: {
      name,
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => listeners.message.push(fn),
        removeListener: () => {}
      },
      onDisconnect: {
        addListener: (fn: () => void) => listeners.disconnect.push(fn),
        removeListener: () => {}
      },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    send: (msg: unknown) => listeners.message.forEach((fn) => fn(msg)),
    fireDisconnect: () => listeners.disconnect.forEach((fn) => fn())
  };
}

function closeRequests() {
  return sentMessages.filter((message) => message?.type === "offscreen-request-close");
}

// 流式响应体的最小假体：按 chunks 顺序供 reader.read()，供完即 done。
function bodyStream(chunks: string[]) {
  const parts = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < parts.length ? { value: parts[index++], done: false } : { value: undefined, done: true }
    })
  };
}

// ASR 任务到达即回终态（触发自关判定），端口已入集
function armTerminalEcho() {
  createAsrDecodeHandlerMock.mockImplementation(({ onTaskTerminal }) => {
    return async (_task, port) => {
      onTaskTerminal(port);
    };
  });
}

beforeEach(() => {
  createAsrDecodeHandlerMock.mockReset();
  fetchMock = vi.fn(async () => ({ status: 200, body: bodyStream(["ok"]) }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("offscreen 概览代发端口", () => {
  it("provider-http-offscreen 请求在 offscreen 里 fetch 并按「响应头 → 分片 → done」回吐", async () => {
    await importOffscreen();
    const session = makePort("provider-http-offscreen");
    onConnectListeners[0](session.port);

    session.send({
      action: "provider-http",
      url: "https://api-inference.modelscope.cn/v1/messages",
      method: "POST",
      headers: { "x-api-key": "sk-1", "anthropic-version": "2023-06-01" },
      body: '{"model":"m"}'
    });

    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledTimes(3));
    expect(session.port.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { ok: true, status: 200 },
      { ok: true, status: 200, chunk: "ok" },
      { ok: true, status: 200, done: true }
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-inference.modelscope.cn/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("sk-1");
    expect(init.body).toBe('{"model":"m"}');
  });

  it("代发在飞期间 ASR 终态不自关文档（回执通道不得被关闭吞掉）", async () => {
    armTerminalEcho();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await importOffscreen();

    const relay = makePort("provider-http-offscreen");
    onConnectListeners[0](relay.port);
    relay.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const asr = makePort("asr-decode");
    onConnectListeners[0](asr.port);
    asr.send({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closeRequests()).toEqual([]);
  });

  it("代发端口断开后，ASR 终态照常自关（既有行为不变）", async () => {
    armTerminalEcho();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await importOffscreen();

    const relay = makePort("provider-http-offscreen");
    onConnectListeners[0](relay.port);
    relay.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    relay.fireDisconnect();

    const asr = makePort("asr-decode");
    onConnectListeners[0](asr.port);
    asr.send({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(closeRequests()).toHaveLength(1));
  });

  it("代发端口断连即 abort 在飞 fetch（挂起请求不留在文档里）", async () => {
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          seenSignal = init.signal!;
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    await importOffscreen();

    const relay = makePort("provider-http-offscreen");
    onConnectListeners[0](relay.port);
    relay.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });
    await vi.waitFor(() => expect(seenSignal).toBeTruthy());

    relay.fireDisconnect();

    expect(seenSignal!.aborted).toBe(true);
    expect(relay.port.postMessage).not.toHaveBeenCalled();
  });
});
