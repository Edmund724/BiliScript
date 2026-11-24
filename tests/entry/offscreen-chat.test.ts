import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPort, RunLadderChatArgs, RunLadderChatDeps } from "../../extension/ai/ladder.js";
import { HOST_INVALID_ORIGIN_HINT, HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";
import {
  SEARCH_COOLDOWN_NOTICE,
  SEARCH_NOT_CONFIGURED_NOTICE
} from "../../extension/search/search-runtime.js";
import {
  installMinimalChromeHost,
  type MinimalChromeHost,
  type RuntimeReplies
} from "../helpers/chrome-runtime-host.js";
import { setupEnvironment } from "../setup.js";

const runLadderChatMock = vi.fn();

function defaultProviderReply() {
  return {
    ok: true,
    provider: {
      id: "p1",
      name: "测试平台",
      baseUrl: "https://api.example.com/v1",
      model: "m1",
      enabled: true,
      requiresKey: false,
      hasSavedKey: true
    },
    apiKey: "test-key"
  };
}

function installChatHost(replies: RuntimeReplies, { offscreen = true }: { offscreen?: boolean } = {}): MinimalChromeHost {
  setupEnvironment();
  return installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    ...(offscreen ? { offscreen: true } : {}),
    replies
  });
}

async function importMockedOffscreen(
  replies: RuntimeReplies = { "resolve-ai-provider": defaultProviderReply }
): Promise<MinimalChromeHost> {
  vi.resetModules();
  vi.doMock("../../extension/ai/ladder.js", () => ({
    runLadderChat: runLadderChatMock
  }));
  const host = installChatHost(replies);
  await import("../../extension/entry/offscreen.js");
  return host;
}

function sseData(delta: { reasoning_content?: unknown; content?: unknown; tool_calls?: unknown }) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  };
}

async function importRealOffscreen(
  replies: RuntimeReplies,
  options: { offscreen?: boolean; fetchImpl?: (...args: any[]) => unknown } = {}
) {
  vi.resetModules();
  vi.doUnmock("../../extension/ai/ladder.js");
  const host = installChatHost(replies, { offscreen: options.offscreen ?? true });
  const fetchMock = vi.fn(
    options.fetchImpl ??
      (async () => sseResponse([sseData({ content: "你好" }), "data: [DONE]\n\n"]))
  );
  vi.stubGlobal("fetch", fetchMock);
  await import("../../extension/entry/offscreen.js");
  return { host, fetchMock };
}

function makeChatPort() {
  const listeners: { message: Array<(message: unknown) => unknown>; disconnect: Array<() => void> } = {
    message: [],
    disconnect: []
  };
  const postedMessages: unknown[] = [];
  let disconnected = false;
  const port = {
    name: "offscreen-chat",
    onMessage: {
      addListener: (fn: (message: unknown) => unknown) => listeners.message.push(fn),
      removeListener: (_fn: (message: unknown) => unknown) => {}
    },
    onDisconnect: {
      addListener: (fn: () => void) => listeners.disconnect.push(fn),
      removeListener: (_fn: () => void) => {}
    },
    postMessage: vi.fn((data: unknown) => {
      if (disconnected) {
        throw new Error("Attempting to use a disconnected port object");
      }
      postedMessages.push(data);
    }),
    disconnect: vi.fn()
  };
  return {
    port,
    listeners,
    postedMessages,
    send: (msg: unknown) => listeners.message[0](msg),
    fireDisconnect: () => {
      disconnected = true;
      for (const fn of listeners.disconnect) fn();
    }
  };
}

function connectChat(host: MinimalChromeHost, { assertSingleListener = false }: { assertSingleListener?: boolean } = {}) {
  if (assertSingleListener) {
    expect(host.onConnectListeners).toHaveLength(1);
  }
  const session = makeChatPort();
  host.onConnectListeners.at(-1)!(session.port as unknown as chrome.runtime.Port);
  return session;
}

async function flushTicks() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../../extension/ai/ladder.js");
});

describe("offscreen 多端口并发 AI 对话隔离", () => {
  const KEY_A = "video:BVA|101";
  const KEY_B = "video:BVB|202";
  const BODY_A = [{ from: 0, to: 5, content: "视频A字幕" }];
  const BODY_B = [{ from: 0, to: 5, content: "视频B字幕" }];

  beforeEach(() => {
    runLadderChatMock.mockReset();
  });

  it("双端口同时流式总结互不中止、回吐各自隔离且附带对应 cachedContextKey", async () => {
    const activeRuns: Array<{
      port: ChatPort;
      signal: AbortSignal | null;
      resolve: () => void;
    }> = [];

    runLadderChatMock.mockImplementation(({ port, signal }: RunLadderChatArgs) => {
      return new Promise<void>((resolve) => {
        activeRuns.push({ port, signal, resolve });
      });
    });

    const host = await importMockedOffscreen();
    const portA = connectChat(host);
    const portB = connectChat(host);

    portA.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A", subtitleBody: BODY_A },
      prompt: "总结A"
    });
    portB.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B", subtitleBody: BODY_B },
      prompt: "总结B"
    });

    await vi.waitFor(() => expect(activeRuns).toHaveLength(2));
    expect(activeRuns[0].signal?.aborted).toBe(false);
    expect(activeRuns[1].signal?.aborted).toBe(false);

    activeRuns[0].port.postMessage({ type: "token", data: "A内容" });
    activeRuns[1].port.postMessage({ type: "token", data: "B内容" });
    activeRuns[0].port.postMessage({ type: "done" });
    activeRuns[1].port.postMessage({ type: "done" });
    activeRuns[0].resolve();
    activeRuns[1].resolve();

    await vi.waitFor(() => expect(portA.postedMessages).toHaveLength(2));
    await vi.waitFor(() => expect(portB.postedMessages).toHaveLength(2));

    expect(portA.postedMessages).toEqual([
      { type: "token", data: "A内容", cachedContextKey: KEY_A },
      { type: "done", cachedContextKey: KEY_A }
    ]);
    expect(portB.postedMessages).toEqual([
      { type: "token", data: "B内容", cachedContextKey: KEY_B },
      { type: "done", cachedContextKey: KEY_B }
    ]);
  });

  it("双端口交替发起省略 subtitleBody 的追问，均能命中多槽缓存各自字幕体", async () => {
    runLadderChatMock.mockImplementation(async ({ port }: RunLadderChatArgs) => {
      port.postMessage({ type: "done" });
    });

    const host = await importMockedOffscreen();
    const portA1 = connectChat(host);
    const portB1 = connectChat(host);

    portA1.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A", subtitleBody: BODY_A },
      prompt: "首轮A"
    });
    portB1.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B", subtitleBody: BODY_B },
      prompt: "首轮B"
    });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(2));

    const portA2 = connectChat(host);
    const portB2 = connectChat(host);
    portA2.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A" },
      prompt: "追问A"
    });
    portB2.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B" },
      prompt: "追问B"
    });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(4));

    const msgA2 = (runLadderChatMock.mock.calls[2][0] as RunLadderChatArgs).msg;
    const msgB2 = (runLadderChatMock.mock.calls[3][0] as RunLadderChatArgs).msg;
    expect(msgA2.context?.subtitleBody).toBe(BODY_A);
    expect(msgB2.context?.subtitleBody).toBe(BODY_B);
  });

  it("单侧发送 stop 或端口断连仅中止自身，不影响另一并发端口", async () => {
    const signals: Array<AbortSignal | null> = [];
    runLadderChatMock.mockImplementation(({ signal }: RunLadderChatArgs) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    });

    const host = await importMockedOffscreen();
    const portA = connectChat(host);
    const portB = connectChat(host);
    const portC = connectChat(host);

    portA.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A", subtitleBody: BODY_A },
      prompt: "A"
    });
    portB.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B", subtitleBody: BODY_B },
      prompt: "B"
    });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    portA.send({ action: "stop" });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    portC.send({
      action: "chat",
      providerId: "p1",
      contextKey: "video:BVC|303",
      context: { title: "视频C", subtitleBody: BODY_A },
      prompt: "C"
    });
    await vi.waitFor(() => expect(signals).toHaveLength(3));

    portB.fireDisconnect();
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
  });

  it("单侧 90 秒空闲超时仅中止超时端口，另一活跃端口不受影响", async () => {
    vi.useFakeTimers();
    const runs: Array<{ signal: AbortSignal | null; deps: RunLadderChatDeps }> = [];
    runLadderChatMock.mockImplementation(({ signal }: RunLadderChatArgs, deps: RunLadderChatDeps) => {
      runs.push({ signal, deps });
      return new Promise<void>(() => {});
    });

    const host = await importMockedOffscreen();
    const portA = connectChat(host);
    const portB = connectChat(host);

    portA.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A", subtitleBody: BODY_A },
      prompt: "A"
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50_000);
    portB.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B", subtitleBody: BODY_B },
      prompt: "B"
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(40_000);

    expect(runs[0].signal?.aborted).toBe(true);
    expect(runs[1].signal?.aborted).toBe(false);
    expect(portA.postedMessages).toContainEqual(
      expect.objectContaining({ type: "error", error: expect.stringContaining("90 秒未返回任何数据") })
    );
    expect(portB.postedMessages).toEqual([]);
  });

  it("双端口并发等待成本护栏与视频截帧时，各自回执独立结算不串台", async () => {
    let costA: boolean | undefined;
    let costB: boolean | undefined;
    let frameA: unknown;
    let frameB: unknown;

    runLadderChatMock
      .mockImplementationOnce(async ({ port, captureCurrentVideoFrame }: RunLadderChatArgs, deps: RunLadderChatDeps) => {
        costA = Boolean(await deps.askCostGuard(port, "确认A？"));
        frameA = await captureCurrentVideoFrame?.();
      })
      .mockImplementationOnce(async ({ port, captureCurrentVideoFrame }: RunLadderChatArgs, deps: RunLadderChatDeps) => {
        costB = Boolean(await deps.askCostGuard(port, "确认B？"));
        frameB = await captureCurrentVideoFrame?.();
      });

    const host = await importMockedOffscreen();
    const portA = connectChat(host);
    const portB = connectChat(host);

    portA.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_A,
      context: { title: "视频A", subtitleBody: BODY_A },
      videoFrameToolEnabled: true,
      prompt: "A"
    });
    portB.send({
      action: "chat",
      providerId: "p1",
      contextKey: KEY_B,
      context: { title: "视频B", subtitleBody: BODY_B },
      videoFrameToolEnabled: true,
      prompt: "B"
    });

    await vi.waitFor(() => {
      expect(portA.postedMessages.some((m: any) => m?.type === "cost-guard")).toBe(true);
      expect(portB.postedMessages.some((m: any) => m?.type === "cost-guard")).toBe(true);
    });

    portB.send({ action: "cost-guard-confirm", ok: false });
    portA.send({ action: "cost-guard-confirm", ok: true });

    await vi.waitFor(() => {
      expect(portA.postedMessages.some((m: any) => m?.type === "video-frame-request")).toBe(true);
      expect(portB.postedMessages.some((m: any) => m?.type === "video-frame-request")).toBe(true);
    });

    const reqA = portA.postedMessages.find((m: any) => m?.type === "video-frame-request") as { requestId: string };
    const reqB = portB.postedMessages.find((m: any) => m?.type === "video-frame-request") as { requestId: string };

    portB.send({
      action: "video-frame-result",
      requestId: reqB.requestId,
      image: { mime: "image/jpeg", data: "BBB" },
      currentTime: 22
    });
    portA.send({
      action: "video-frame-result",
      requestId: reqA.requestId,
      image: { mime: "image/jpeg", data: "AAA" },
      currentTime: 11
    });

    await vi.waitFor(() => {
      expect(frameA).toBeDefined();
      expect(frameB).toBeDefined();
    });

    expect(costA).toBe(true);
    expect(costB).toBe(false);
    expect(frameA).toEqual({ image: { mime: "image/jpeg", data: "AAA" }, currentTime: 11 });
    expect(frameB).toEqual({ image: { mime: "image/jpeg", data: "BBB" }, currentTime: 22 });
  });
});

describe("offscreen 聊天通道断连容错", () => {
  const CONTEXT_KEY = "video:BV1body|101";
  const BODY = [{ from: 0, to: 5, content: "第一句" }];
  const CHAT_MSG = {
    action: "chat",
    providerId: "p1",
    contextKey: CONTEXT_KEY,
    context: { title: "长视频", subtitleBody: BODY },
    prompt: "总结"
  };

  beforeEach(() => {
    runLadderChatMock.mockReset();
  });

  it("断连后 ladder 的迟到回执不抛 disconnected port 错误", async () => {
    let ladderPort: ChatPort | null = null;
    runLadderChatMock.mockImplementation(async ({ port }: { port: ChatPort }) => {
      ladderPort = port;
      await new Promise(() => {});
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

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
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

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

  it("历史帧调用把目标时间随请求发到宿主，并解析有序三帧回执", async () => {
    let capturedFrames: unknown;
    runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: { captureCurrentVideoFrame: (targetTime?: number) => Promise<unknown> }) => {
      capturedFrames = await captureCurrentVideoFrame(90);
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({ ...CHAT_MSG, videoFrameToolEnabled: true });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "video-frame-request",
      requestId: expect.any(String),
      targetTime: 90
    })));
    const calls = session.port.postMessage.mock.calls as unknown as Array<[{ type: string; requestId: string }]>;
    const request = calls.find(([message]) => message.type === "video-frame-request")![0];
    const frames = [88, 90, 92].map((currentTime, index) => ({
      image: { mime: "image/jpeg", data: ["Rk9S", "Q0VO", "QUZU"][index] },
      currentTime
    }));

    session.send({
      action: "video-frame-result",
      requestId: request.requestId,
      frames
    });
    await vi.waitFor(() => expect(capturedFrames).toEqual(frames));
  });

  it("停止回答会取消页面侧在飞取帧并结束等待", async () => {
    let captureError: unknown;
    runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: { captureCurrentVideoFrame: () => Promise<unknown> }) => {
      try {
        await captureCurrentVideoFrame();
      } catch (error) {
        captureError = error;
      }
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({ ...CHAT_MSG, videoFrameToolEnabled: true });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "video-frame-request" })));
    const calls = session.port.postMessage.mock.calls as unknown as Array<[{ type: string; requestId: string }]>;
    const request = calls.find(([message]) => message.type === "video-frame-request")![0];

    session.send({ action: "stop" });

    await vi.waitFor(() => expect(captureError).toEqual(new Error("截图请求已中止")));
    expect(session.port.postMessage).toHaveBeenCalledWith({
      type: "video-frame-cancel",
      requestId: request.requestId,
      cachedContextKey: CONTEXT_KEY
    });
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
      const host = await importMockedOffscreen();
      const session = connectChat(host, { assertSingleListener: true });

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

  it("双端口并发互不中止，旧端口断连只中止自身不影响另一端口", async () => {
    const signals: AbortSignal[] = [];
    runLadderChatMock.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      await new Promise(() => {});
    });
    const host = await importMockedOffscreen();
    const first = connectChat(host, { assertSingleListener: true });
    first.send(CHAT_MSG);
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    const second = connectChat(host, { assertSingleListener: true });
    second.send(CHAT_MSG);
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(false);

    first.fireDisconnect();
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
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
      const host = await importMockedOffscreen();
      const session = connectChat(host, { assertSingleListener: true });

      session.send(CHAT_MSG);
      await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

      session.fireDisconnect();
      rejectLadder!(new Error("网络中断"));
      await flushTicks();

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});

describe("Offscreen 请求代际与过期工作清理", () => {
  const CHAT_MSG_1 = {
    action: "chat",
    providerId: "p1",
    contextKey: "video:BV1stale1|101",
    context: { title: "视频一", subtitleBody: [{ from: 0, to: 5, content: "一" }] },
    prompt: "问题一"
  };

  const CHAT_MSG_2 = {
    action: "chat",
    providerId: "p1",
    contextKey: "video:BV1stale2|101",
    context: { title: "视频二", subtitleBody: [{ from: 0, to: 5, content: "二" }] },
    prompt: "问题二"
  };

  let resolveAiProviderHandler: () => unknown;

  beforeEach(() => {
    runLadderChatMock.mockReset();
    resolveAiProviderHandler = defaultProviderReply;
    vi.useFakeTimers();
  });

  async function importStaleOffscreen() {
    return importMockedOffscreen({
      "resolve-ai-provider": () => resolveAiProviderHandler()
    });
  }

  it("异步前置阶段交错：旧请求在 resolve-ai-provider 等待期间被新请求接管，旧请求唤醒后不继续执行", async () => {
    let resolveFirstProvider: ((val: unknown) => void) | null = null;
    resolveAiProviderHandler = () => new Promise((resolve) => {
      resolveFirstProvider = resolve;
    });

    const host = await importStaleOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).not.toHaveBeenCalled();
    expect(resolveFirstProvider).not.toBeNull();

    resolveAiProviderHandler = defaultProviderReply;
    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect((runLadderChatMock.mock.calls[0][0] as RunLadderChatArgs).msg.prompt).toBe("问题二");

    resolveFirstProvider!(defaultProviderReply());
    await vi.advanceTimersByTimeAsync(10);

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(session.postedMessages.filter((m: any) => m?.type === "error")).toHaveLength(0);
  });

  it("旧请求晚收尾：旧请求的 onActivity 与 finally 不能重武装或清理新请求的空闲超时和控制器", async () => {
    let capturedDeps1: RunLadderChatDeps | null = null;
    let capturedSignal1: AbortSignal | null = null;
    let finishRequest1: (() => void) | null = null;

    let capturedSignal2: AbortSignal | null = null;

    runLadderChatMock.mockImplementationOnce(async ({ signal }: RunLadderChatArgs, deps: RunLadderChatDeps) => {
      capturedSignal1 = signal;
      capturedDeps1 = deps;
      return new Promise<void>((resolve) => {
        finishRequest1 = resolve;
      });
    });

    runLadderChatMock.mockImplementationOnce(async ({ signal }: RunLadderChatArgs) => {
      capturedSignal2 = signal;
      return new Promise<void>(() => {});
    });

    const host = await importStaleOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal1).not.toBeNull();

    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).toHaveBeenCalledTimes(2);
    expect(capturedSignal1!.aborted).toBe(true);
    expect(capturedSignal2).not.toBeNull();
    expect(capturedSignal2!.aborted).toBe(false);

    const deps1 = capturedDeps1 as RunLadderChatDeps | null;
    deps1?.onActivity?.();

    finishRequest1!();
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(90_000);

    expect(capturedSignal2!.aborted).toBe(true);
    const timeoutErrors = session.postedMessages.filter(
      (m: any) => m?.type === "error" && String(m?.error || "").includes("90 秒未返回任何数据")
    );
    expect(timeoutErrors).toHaveLength(1);
  });

  it("截帧期间空闲超时会取消页面工作并结束工具等待", async () => {
    let captureError: unknown;
    runLadderChatMock.mockImplementation(async ({ captureCurrentVideoFrame }: RunLadderChatArgs) => {
      try {
        await captureCurrentVideoFrame?.(90);
      } catch (error) {
        captureError = error;
      }
    });
    const host = await importStaleOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({ ...CHAT_MSG_1, videoFrameToolEnabled: true });
    await vi.advanceTimersByTimeAsync(10);
    const request = session.postedMessages.find((message: any) => message?.type === "video-frame-request") as any;

    await vi.advanceTimersByTimeAsync(90_000);

    expect(captureError).toEqual(new Error("截图请求已中止"));
    expect(session.postedMessages).toContainEqual({
      type: "video-frame-cancel",
      requestId: request.requestId,
      cachedContextKey: CHAT_MSG_1.contextKey
    });
    expect(session.postedMessages).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.stringContaining("90 秒未返回任何数据")
    }));
  });

  it("成本确认跨代保护：旧请求在成本护栏等待期间被新请求接管，旧请求等待正常取消", async () => {
    let costGuardResult1: boolean | null = null;

    runLadderChatMock.mockImplementationOnce(async ({ port }: RunLadderChatArgs, deps: RunLadderChatDeps) => {
      const confirmed = await deps.askCostGuard(port, "预计调用过多，是否继续？");
      costGuardResult1 = Boolean(confirmed);
    });

    runLadderChatMock.mockImplementationOnce(async () => {
      return new Promise<void>(() => {});
    });

    const host = await importStaleOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);

    const costGuardRequests = session.postedMessages.filter((m: any) => m?.type === "cost-guard");
    expect(costGuardRequests).toHaveLength(1);

    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);

    expect(costGuardResult1).toBe(false);

    session.send({ action: "cost-guard-confirm", ok: true });
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe("offscreen 聊天字幕体单槽缓存接线", () => {
  const CONTEXT_KEY = "video:BV1body|101";
  const BODY = [{ from: 0, to: 5, content: "第一句" }];

  beforeEach(() => {
    runLadderChatMock.mockReset();
  });

  it("自带字幕体的消息 → 槽登记，回执统一附带 cachedContextKey", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "token", data: "x" });
      port.postMessage({ type: "done" });
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: BODY },
      prompt: "总结"
    });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    const ladderMsg = runLadderChatMock.mock.calls[0][0].msg;
    expect(ladderMsg.context.subtitleBody).toBe(BODY);
    expect(ladderMsg.contextKey).toBe(CONTEXT_KEY);

    for (const call of session.port.postMessage.mock.calls) {
      expect((call[0] as { cachedContextKey?: string }).cachedContextKey).toBe(CONTEXT_KEY);
    }
  });

  it("未携带 + 槽 key 匹配 → 从槽补齐给 ladder，追问不再需要重传", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(2));

    const followupMsg = runLadderChatMock.mock.calls[1][0].msg;
    expect(followupMsg.context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 槽 key 不匹配 → 字幕体缺失错误（不带 cachedContextKey），ladder 不再调", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    const host = await importMockedOffscreen();
    const session = connectChat(host, { assertSingleListener: true });

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: "video:BV2|202", context: { title: "另一个视频" } });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledTimes(2));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(session.port.postMessage).toHaveBeenLastCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });

  it("offscreen 文档重启（模块重载）后槽为空 → 未携带消息回缺失错误", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    const firstHost = await importMockedOffscreen();
    const first = connectChat(firstHost, { assertSingleListener: true });
    first.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    const secondHost = await importMockedOffscreen();
    const second = connectChat(secondHost, { assertSingleListener: true });
    second.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(second.port.postMessage).toHaveBeenCalledTimes(1));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(second.port.postMessage).toHaveBeenCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });
});

function postedNotices(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): string[] {
  return session.port.postMessage.mock.calls
    .map((call) => call[0] as { type?: string; data?: unknown } | null)
    .filter((message): message is { type?: string; data?: unknown } => message?.type === "notice")
    .map((message) => String(message.data || ""));
}

function postedTypes(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): Array<string | undefined> {
  return session.port.postMessage.mock.calls.map((call) => (call[0] as { type?: string } | null)?.type);
}

function postedErrors(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): Array<{ type?: string; error?: unknown }> {
  return session.port.postMessage.mock.calls
    .map((call) => call[0] as { type?: string; error?: unknown } | null)
    .filter((message): message is { type?: string; error?: unknown } => message?.type === "error");
}

function createHostPermissionHarness() {
  const BASE_URL = "https://api.siliconflow.cn/v1";
  let host: MinimalChromeHost;
  let fetchMock: ReturnType<typeof vi.fn>;
  let events: string[] = [];
  let checkReply: unknown = { granted: true };
  let searchReply: unknown = { ok: true };

  async function loadOffscreen(providerOverride?: Record<string, unknown>, fetchImpl?: (...args: any[]) => unknown) {
    events = [];
    checkReply = { granted: true };
    searchReply = { ok: true };
    const result = await importRealOffscreen(
      {
        "resolve-ai-provider": () => {
          events.push("msg:resolve-ai-provider");
          return {
            ok: true,
            provider: {
              id: "p1",
              presetId: "custom",
              name: "硅基流动",
              baseUrl: BASE_URL,
              model: "deepseek-ai/DeepSeek-V3",
              enabled: true,
              requiresKey: true,
              hasSavedKey: true,
              ...providerOverride
            },
            apiKey: "sk-test"
          };
        },
        "check-provider-origin": () => {
          events.push("msg:check-provider-origin");
          return checkReply;
        },
        "resolve-search-provider": () => {
          events.push("msg:resolve-search-provider");
          return searchReply;
        }
      },
      {
        offscreen: false,
        fetchImpl:
          fetchImpl ??
          (async () => {
            events.push("fetch");
            return sseResponse([sseData({ content: "你好" }), "data: [DONE]\n\n"]);
          })
      }
    );
    host = result.host;
    fetchMock = result.fetchMock;
  }

  async function runChatTurn(extra: Record<string, unknown> = {}) {
    const session = connectChat(host, { assertSingleListener: true });
    await session.send({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "测试视频",
        bvid: "BV1test000000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "总结一下",
      ...extra
    });
    return session;
  }

  return {
    loadOffscreen,
    runChatTurn,
    getFetchMock: () => fetchMock,
    getEvents: () => events,
    setCheckReply: (reply: unknown) => {
      checkReply = reply;
    },
    setSearchReply: (reply: unknown) => {
      searchReply = reply;
    }
  };
}

describe("offscreen 对话链 host 权限预检", () => {
  it("未授权（SW 回 { granted: false }）→ port 回可操作文案，一个请求都不发", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setCheckReply({ granted: false });

    const session = await harness.runChatTurn();

    expect(harness.getFetchMock()).not.toHaveBeenCalled();
    expect(postedErrors(session)).toEqual([expect.objectContaining({ error: HOST_PERMISSION_HINT })]);
    expect(harness.getEvents()).toContain("msg:check-provider-origin");
    expect(harness.getEvents().indexOf("msg:check-provider-origin")).toBeGreaterThan(
      harness.getEvents().indexOf("msg:resolve-ai-provider")
    );
  });

  it("已授权（{ granted: true }）→ 照常走完一轮（预检不改变既有成功路径）", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setCheckReply({ granted: true });

    const session = await harness.runChatTurn();

    expect(harness.getFetchMock()).toHaveBeenCalledTimes(1);
    expect(harness.getEvents().indexOf("msg:check-provider-origin")).toBeLessThan(
      harness.getEvents().indexOf("fetch")
    );
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open，不新造拦截面", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setCheckReply(undefined);

    const session = await harness.runChatTurn();

    expect(harness.getFetchMock()).toHaveBeenCalledTimes(1);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });

  it("provider.baseUrl 缺失或非法 → 显式失败，不发 check-provider-origin 也不发 fetch", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen({ name: "坏配置平台", baseUrl: "not-a-url" }, () => undefined);
    harness.setCheckReply({ granted: true, status: "granted" });

    const session = await harness.runChatTurn();

    expect(harness.getFetchMock()).not.toHaveBeenCalled();
    expect(harness.getEvents()).not.toContain("msg:check-provider-origin");
    expect(postedErrors(session)).toEqual([expect.objectContaining({ error: HOST_INVALID_ORIGIN_HINT })]);
  });
});

describe("offscreen 对话链搜索运行时的未配置 notice（spec §10 第 10 行）", () => {
  it("keyless 无 Key（链非空、apiKey:''）→ 不弹「未配置搜索平台，本轮未联网」", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setSearchReply({
      ok: true,
      chain: [
        {
          provider: { id: "search_firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev" },
          apiKey: ""
        }
      ],
      maxToolCalls: 2
    });

    const session = await harness.runChatTurn({ webSearchEnabled: true });

    expect(harness.getEvents()).toContain("msg:resolve-search-provider");
    expect(postedNotices(session).some((data) => data.includes("未配置搜索平台"))).toBe(false);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });

  it("对照：chain 缺省（未配置）→ 仍弹该 notice（缺省分支未被动过）", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setSearchReply({ ok: true });

    const session = await harness.runChatTurn({ webSearchEnabled: true });

    expect(postedNotices(session)).toContain(SEARCH_NOT_CONFIGURED_NOTICE);
    expect(postedTypes(session)).toContain("done");
  });

  it("智能链合格记录全在冷却中 → 弹冷却专属文案，不误报「未配置」（spec §12.7 第 6 条翻案）", async () => {
    const harness = createHostPermissionHarness();
    await harness.loadOffscreen();
    harness.setSearchReply({ ok: true, chainEmptyReason: "cooldown" });

    const session = await harness.runChatTurn({ webSearchEnabled: true });

    const notices = postedNotices(session);
    expect(notices).toContain(SEARCH_COOLDOWN_NOTICE);
    expect(notices.some((data) => data.includes("未配置搜索平台"))).toBe(false);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });
});

describe("offscreen 对话链 presetId 穿线", () => {
  const PROXY_BASE_URL = "https://thinking-proxy.example.com/v1";
  const PRESET_REPLIES: RuntimeReplies = {
    "resolve-ai-provider": () => ({
      ok: true,
      provider: {
        id: "p1",
        presetId: "ollama",
        name: "本地 Ollama",
        baseUrl: PROXY_BASE_URL,
        model: "llama3.2",
        enabled: true,
        requiresKey: false,
        hasSavedKey: true
      },
      apiKey: "test-key"
    })
  };

  it("resolveProviderWithKey 带回 presetId → 对话请求体按 preset 平台规则出 reasoning_effort（host 反代无规则也命中）", async () => {
    const { host, fetchMock } = await importRealOffscreen(PRESET_REPLIES);
    const session = connectChat(host, { assertSingleListener: true });

    await session.send({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "测试视频",
        bvid: "BV1test000000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "总结一下"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY_BASE_URL}/chat/completions`);
    expect(JSON.parse(init.body)).toMatchObject({
      model: "llama3.2",
      stream: true,
      reasoning_effort: "none"
    });
    const types = session.port.postMessage.mock.calls.map((c) => (c[0] as { type?: string } | undefined)?.type);
    expect(types).toContain("done");
  });

  it("评论工具按当前对话 context.aid 拉取并回填，不依赖当前页面", async () => {
    const { host, fetchMock } = await importRealOffscreen(PRESET_REPLIES);
    const modelBodies: Array<{ messages?: Array<{ role?: string; content?: string }>; tools?: unknown[] }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (String(url).startsWith("https://api.bilibili.com/x/v2/reply/main")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              replies: [{ rpid: 1, member: { uname: "观众甲" }, like: 88, content: { message: "历史视频的热评" } }],
              top_replies: []
            }
          })
        };
      }
      modelBodies.push(JSON.parse(init!.body!));
      if (modelBodies.length === 1) {
        return sseResponse([
          `data: ${JSON.stringify({
            choices: [{
              delta: { tool_calls: [{ index: 0, id: "comment_1", type: "function", function: { name: "fetch_hot_comments", arguments: "{}" } }] },
              finish_reason: "tool_calls"
            }]
          })}\n\n`
        ]);
      }
      return sseResponse([sseData({ content: "评论回答" }), "data: [DONE]\n\n"]);
    });

    const session = connectChat(host);
    await session.send({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "置顶历史视频",
        aid: "987654",
        bvid: "BV1history000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "评论区在讨论什么"
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("oid=987654");
    expect(modelBodies[0].tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "fetch_hot_comments" }) })
    ]);
    expect(modelBodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "comment_1",
        content: JSON.stringify([{ uname: "观众甲", like: 88, message: "历史视频的热评" }])
      })
    ]));
    expect(session.port.postMessage.mock.calls.map((c) => (c[0] as { type?: string } | undefined)?.type)).toContain("done");
  });
});

describe("offscreen 对话链会话头穿线", () => {
  const BASE_URL = "https://opencode.ai/zen/go/v1";
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("conversationId → x-opencode-session：同会话恒同值、新会话换新值、缺失也有值", async () => {
    const { host, fetchMock } = await importRealOffscreen({
      "resolve-ai-provider": () => ({
        ok: true,
        provider: {
          id: "p1",
          presetId: "opencodego",
          name: "Opencode Go",
          baseUrl: BASE_URL,
          model: "glm-5.1",
          enabled: true,
          requiresKey: true,
          hasSavedKey: true
        },
        apiKey: "test-key"
      })
    });
    const session = connectChat(host, { assertSingleListener: true });

    const send = (conversationId?: string) =>
      session.send({
        action: "chat",
        providerId: "p1",
        ...(conversationId ? { conversationId } : {}),
        context: {
          title: "测试视频",
          bvid: "BV1test000000",
          cid: "1000",
          subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
        },
        prompt: "总结一下"
      });

    await send("conv_e2e_1");
    await send("conv_e2e_1");
    await send("conv_e2e_2");
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const headers = fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe(`${BASE_URL}/chat/completions`);
    }
    expect(headers[0]["x-opencode-session"]).toMatch(UUID_V4);
    expect(headers[1]["x-opencode-session"]).toBe(headers[0]["x-opencode-session"]);
    expect(headers[2]["x-opencode-session"]).not.toBe(headers[0]["x-opencode-session"]);
    expect(headers[3]["x-opencode-session"]).toMatch(UUID_V4);
    expect(headers[3]["x-opencode-session"]).not.toBe(headers[0]["x-opencode-session"]);
    expect(headers[0].Authorization).toBe("Bearer test-key");
  });
});
