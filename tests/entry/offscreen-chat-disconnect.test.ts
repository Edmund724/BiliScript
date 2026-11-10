// offscreen.js 聊天通道的断连容错测试：
// 聊天中途端口断开（面板关闭 / SPA 换页 / 页面刷新）后——
// - ladder 迟到的流式回执（经 withCachedContextKey 包装）不得抛
//   "Attempting to use a disconnected port object"；
// - ladder 抛错后 catch 通道的错误回报不得再抛出，避免 async 消息监听器的
//   unhandled rejection（chrome://extensions 里的 "Uncaught (in promise)"）。
// 口径与 ASR 通道一致（offscreen.ts 的 dispatchAsrDecodeTask：port 已断开，
// postMessage 抛错被吞）。
//
// 假端口模拟 Chrome 行为：断连后 postMessage 抛错。chrome 依赖 mock 与
// 「vi.resetModules + 动态导入 = 文档纪元」手法沿 offscreen-chat-subtitle-slot.test.js。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPort } from "../../extension/ai/ladder.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const { runLadderChatMock } = vi.hoisted(() => ({ runLadderChatMock: vi.fn() }));

vi.mock("../../extension/ai/ladder.js", () => ({
  runLadderChat: runLadderChatMock
}));
vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: vi.fn(() => vi.fn(async () => {}))
}));

const CONTEXT_KEY = "video:BV1body|101";
const BODY = [{ from: 0, to: 5, content: "第一句" }];

let host: MinimalChromeHost;

function installHost() {
  host = installMinimalChromeHost({
    onConnect: true,
    offscreen: true,
    replies: {
      "resolve-ai-provider": () => ({
        ok: true,
        provider: { id: "p1", name: "测试平台", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
        apiKey: "test-key"
      })
    }
  });
}

async function importOffscreen() {
  vi.resetModules();
  installHost();
  return import("../../extension/entry/offscreen.js");
}

// 断连后 postMessage 抛错（Chrome 的 Port 行为）
function makeChatPort() {
  const listeners: { message: Array<(message: unknown) => void>; disconnect: Array<() => void> } = {
    message: [],
    disconnect: []
  };
  let disconnected = false;
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn: (message: unknown) => void) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(() => {
        if (disconnected) {
          throw new Error("Attempting to use a disconnected port object");
        }
      }),
      disconnect: vi.fn()
    },
    listeners,
    fireDisconnect: () => {
      disconnected = true;
      for (const fn of listeners.disconnect) fn();
    }
  };
}

function connectChat() {
  expect(host.onConnectListeners).toHaveLength(1);
  const session = makeChatPort();
  host.onConnectListeners.at(-1)!(session.port as unknown as chrome.runtime.Port);
  return {
    port: session.port,
    fireDisconnect: session.fireDisconnect,
    send: (msg: unknown) => session.listeners.message[0](msg)
  };
}

const CHAT_MSG = {
  action: "chat",
  providerId: "p1",
  contextKey: CONTEXT_KEY,
  context: { title: "长视频", subtitleBody: BODY },
  prompt: "总结"
};

async function flushTicks() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  runLadderChatMock.mockReset();
});

describe("offscreen 聊天通道断连容错", () => {
  it("断连后 ladder 的迟到回执不抛 disconnected port 错误", async () => {
    let ladderPort: ChatPort | null = null;
    // ladder 挂在半空（永不结算），模拟流式进行中端口被断开
    runLadderChatMock.mockImplementation(async ({ port }: { port: ChatPort }) => {
      ladderPort = port;
      await new Promise(() => {});
    });
    await importOffscreen();
    const session = connectChat();

    session.send(CHAT_MSG);
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));
    expect(ladderPort).not.toBeNull();

    session.fireDisconnect();
    expect(() => ladderPort!.postMessage({ type: "token", data: "late" })).not.toThrow();
  });

  it("截帧工具经聊天端口请求当前帧，并解析图片与播放时间回执", async () => {
    let capturedFrame: unknown;
    runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: { captureCurrentVideoFrame: () => Promise<unknown> }) => {
      capturedFrame = await captureCurrentVideoFrame();
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ ...CHAT_MSG, videoFrameToolEnabled: true });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "video-frame-request",
      requestId: expect.any(String)
    })));
    const calls = session.port.postMessage.mock.calls as unknown as Array<[{ type: string; requestId: string }]>;
    const request = calls.find(([message]) => message.type === "video-frame-request")![0];

    session.send({
      action: "video-frame-result",
      requestId: request.requestId,
      image: { mime: "image/jpeg", data: "/9j/" },
      currentTime: 151
    });
    await vi.waitFor(() => expect(capturedFrame).toEqual({
      image: { mime: "image/jpeg", data: "/9j/" },
      currentTime: 151
    }));
  });

  it("历史帧调用把目标时间随请求发到宿主，并解析实际截图时间", async () => {
    let capturedFrame: unknown;
    runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: { captureCurrentVideoFrame: (targetTime?: number) => Promise<unknown> }) => {
      capturedFrame = await captureCurrentVideoFrame(90);
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ ...CHAT_MSG, videoFrameToolEnabled: true });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "video-frame-request",
      requestId: expect.any(String),
      targetTime: 90
    })));
    const calls = session.port.postMessage.mock.calls as unknown as Array<[{ type: string; requestId: string }]>;
    const request = calls.find(([message]) => message.type === "video-frame-request")![0];

    session.send({
      action: "video-frame-result",
      requestId: request.requestId,
      image: { mime: "image/jpeg", data: "SElTVE9SWQ==" },
      currentTime: 88.25
    });
    await vi.waitFor(() => expect(capturedFrame).toEqual({
      image: { mime: "image/jpeg", data: "SElTVE9SWQ==" },
      currentTime: 88.25
    }));
  });

  it("截帧等待中断连会 reject 并收尾，不产生 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let captureError: unknown;
      runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: { captureCurrentVideoFrame: () => Promise<unknown> }) => {
        try {
          await captureCurrentVideoFrame();
        } catch (error) {
          captureError = error;
        }
      });
      await importOffscreen();
      const session = connectChat();

      session.send({ ...CHAT_MSG, videoFrameToolEnabled: true });
      await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "video-frame-request" })));
      session.fireDisconnect();

      await vi.waitFor(() => expect(captureError).toEqual(new Error("截图请求已中止")));
      await flushTicks();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("断连后 ladder 抛错：catch 通道的错误回报被吞，无 unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectLadder: ((reason?: unknown) => void) | null = null;
      runLadderChatMock.mockImplementation(
        () => new Promise((_, reject) => { rejectLadder = reject; })
      );
      await importOffscreen();
      const session = connectChat();

      session.send(CHAT_MSG);
      await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

      // 端口断开（面板关闭/换页/刷新），随后 ladder 才以失败收场——
      // catch 通道向已断开的端口回报错误
      session.fireDisconnect();
      rejectLadder!(new Error("网络中断"));
      await flushTicks();

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
