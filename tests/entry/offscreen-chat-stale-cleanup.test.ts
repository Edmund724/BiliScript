import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPort, RunLadderChatArgs, RunLadderChatDeps } from "../../extension/ai/ladder.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const { runLadderChatMock } = vi.hoisted(() => ({ runLadderChatMock: vi.fn() }));

vi.mock("../../extension/ai/ladder.js", () => ({
  runLadderChat: runLadderChatMock
}));
vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: vi.fn(() => vi.fn(async () => {})),
  createAsrProbeHandler: vi.fn(() => vi.fn(async () => {}))
}));

let host: MinimalChromeHost;
let resolveAiProviderHandler: () => unknown;

function defaultProviderReply() {
  return {
    ok: true,
    provider: { id: "p1", name: "测试平台", baseUrl: "https://api.example.com/v1", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
    apiKey: "test-key"
  };
}

function installHost() {
  host = installMinimalChromeHost({
    onConnect: true,
    offscreen: true,
    replies: {
      "resolve-ai-provider": () => resolveAiProviderHandler()
    }
  });
}

async function importOffscreen() {
  vi.resetModules();
  installHost();
  return import("../../extension/entry/offscreen.js");
}

function makeChatPort() {
  let messageHandler: ((message: unknown) => void) | null = null;
  const postedMessages: unknown[] = [];
  const port = {
    name: "offscreen-chat",
    onMessage: {
      addListener: (fn: (message: unknown) => void) => {
        messageHandler = fn;
      }
    },
    onDisconnect: {
      addListener: () => {}
    },
    postMessage: vi.fn((data: unknown) => {
      postedMessages.push(data);
    }),
    disconnect: vi.fn()
  };
  return { port, getHandler: () => messageHandler, postedMessages };
}

function connectChat() {
  expect(host.onConnectListeners).toHaveLength(1);
  const p = makeChatPort();
  host.onConnectListeners.at(-1)!(p.port as unknown as chrome.runtime.Port);
  return {
    port: p.port,
    postedMessages: p.postedMessages,
    send: (msg: unknown) => p.getHandler()!(msg)
  };
}

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

beforeEach(() => {
  runLadderChatMock.mockReset();
  resolveAiProviderHandler = defaultProviderReply;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Offscreen 请求代际与过期工作清理", () => {
  it("异步前置阶段交错：旧请求在 resolve-ai-provider 等待期间被新请求接管，旧请求唤醒后不继续执行", async () => {
    let resolveFirstProvider: ((val: unknown) => void) | null = null;
    resolveAiProviderHandler = () => new Promise((resolve) => {
      resolveFirstProvider = resolve;
    });

    await importOffscreen();
    const session = connectChat();

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

    await importOffscreen();
    const session = connectChat();

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
    await importOffscreen();
    const session = connectChat();

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

    await importOffscreen();
    const session = connectChat();

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
