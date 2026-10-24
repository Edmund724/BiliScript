// tests/entry/offscreen-chat-stale-cleanup.test.ts
// 工单 06：关闭会话与请求接力时清理过期工作
// 验证：
// 1. 异步前置阶段交错：旧请求在 resolve-ai-provider / 动态加载期间被新请求接管，异步等待后只有当前代际才能继续；
// 2. 旧请求晚收尾：旧请求的 onActivity 与 finally 不能重武装或清理新请求的空闲超时与控制器；
// 3. 成本确认跨代保护：旧请求在成本护栏等待期间被新请求打断，旧请求 Promise 正常结算为 false。

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
    provider: { id: "p1", name: "测试平台", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
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
    // 第一次 resolve-ai-provider 挂起
    let resolveFirstProvider: ((val: unknown) => void) | null = null;
    resolveAiProviderHandler = () => new Promise((resolve) => {
      resolveFirstProvider = resolve;
    });

    await importOffscreen();
    const session = connectChat();

    // 发送请求 1（卡在前置 resolve-ai-provider）
    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).not.toHaveBeenCalled();
    expect(resolveFirstProvider).not.toBeNull();

    // 在请求 1 挂起期间，恢复 provider 正常解析，并发送请求 2
    resolveAiProviderHandler = defaultProviderReply;
    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);

    // 请求 2 前置完成，进入 runLadderChat
    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect((runLadderChatMock.mock.calls[0][0] as RunLadderChatArgs).msg.prompt).toBe("问题二");

    // 此时请求 1 唤醒
    resolveFirstProvider!(defaultProviderReply());
    await vi.advanceTimersByTimeAsync(10);

    // 请求 1 已过期，不得再次调用 runLadderChat（仍应为 1 次）
    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    // 也没有向端口发送错误
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

    // 发送请求 1
    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal1).not.toBeNull();

    // 发送请求 2（新代际接管，请求 1 的 controller 应该被 abort）
    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);
    expect(runLadderChatMock).toHaveBeenCalledTimes(2);
    expect(capturedSignal1!.aborted).toBe(true);
    expect(capturedSignal2).not.toBeNull();
    expect(capturedSignal2!.aborted).toBe(false);

    // 此时请求 1 的晚 onActivity 被调用
    // 如果没有代际隔离，它会以旧 controller 或全局 activeAbortController 重置新请求的空闲超时
    const deps1 = capturedDeps1 as RunLadderChatDeps | null;
    deps1?.onActivity?.();

    // 请求 1 结束并跑 finally（调用 clearIdleTimeout 和 clearActiveRequestState）
    // 如果没有代际隔离，请求 1 的 finally 会把请求 2 的 idleTimeout 和 activeAbortController 清掉！
    finishRequest1!();
    await vi.advanceTimersByTimeAsync(10);

    // 验证请求 2 的控制器未被清理或置空：推进假时钟 90 秒，触发请求 2 的空闲超时
    await vi.advanceTimersByTimeAsync(90_000);

    // 请求 2 的控制器应当因 90 秒超时被中止
    expect(capturedSignal2!.aborted).toBe(true);
    // 端口收到 90 秒请求超时错误
    const timeoutErrors = session.postedMessages.filter(
      (m: any) => m?.type === "error" && String(m?.error || "").includes("90 秒未返回任何数据")
    );
    expect(timeoutErrors).toHaveLength(1);
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

    // 发送请求 1
    session.send(CHAT_MSG_1);
    await vi.advanceTimersByTimeAsync(10);

    // 端口收到成本护栏询问
    const costGuardRequests = session.postedMessages.filter((m: any) => m?.type === "cost-guard");
    expect(costGuardRequests).toHaveLength(1);

    // 在确认前，发送请求 2（新代际接管）
    session.send(CHAT_MSG_2);
    await vi.advanceTimersByTimeAsync(10);

    // 请求 1 的成本护栏 Promise 应已安全 resolve 为 false（被取消）
    expect(costGuardResult1).toBe(false);

    // 迟到的 cost-guard-confirm 回复不影响系统
    session.send({ action: "cost-guard-confirm", ok: true });
    await vi.advanceTimersByTimeAsync(10);
  });
});
