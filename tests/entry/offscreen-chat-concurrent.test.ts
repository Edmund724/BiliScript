import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPort, RunLadderChatArgs, RunLadderChatDeps } from "../../extension/ai/ladder.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";
import { setupEnvironment } from "../setup.js";

const { runLadderChatMock } = vi.hoisted(() => ({ runLadderChatMock: vi.fn() }));

vi.mock("../../extension/ai/ladder.js", () => ({
  runLadderChat: runLadderChatMock
}));
vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: vi.fn(() => vi.fn(async () => {})),
  createAsrProbeHandler: vi.fn(() => vi.fn(async () => {}))
}));

let host: MinimalChromeHost;

function installHost() {
  setupEnvironment();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    offscreen: true,
    replies: {
      "resolve-ai-provider": () => ({
        ok: true,
        provider: { id: "p1", name: "测试平台", baseUrl: "https://api.example.com/v1", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
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

function connectChat() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const postedMessages: unknown[] = [];
  const port = {
    name: "offscreen-chat",
    onMessage: {
      addListener: (fn: (message: unknown) => void) => messageListeners.push(fn),
      removeListener: () => {}
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: () => {}
    },
    postMessage: vi.fn((data: unknown) => {
      postedMessages.push(data);
    }),
    disconnect: vi.fn()
  };
  host.onConnectListeners.at(-1)!(port as unknown as chrome.runtime.Port);
  return {
    port,
    postedMessages,
    send: (msg: unknown) => messageListeners[0](msg),
    fireDisconnect: () => disconnectListeners.forEach((fn) => fn())
  };
}

const KEY_A = "video:BVA|101";
const KEY_B = "video:BVB|202";
const BODY_A = [{ from: 0, to: 5, content: "视频A字幕" }];
const BODY_B = [{ from: 0, to: 5, content: "视频B字幕" }];

beforeEach(() => {
  runLadderChatMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("offscreen 多端口并发 AI 对话隔离", () => {
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

    await importOffscreen();
    const portA = connectChat();
    const portB = connectChat();

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

    await importOffscreen();
    const portA1 = connectChat();
    const portB1 = connectChat();

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

    const portA2 = connectChat();
    const portB2 = connectChat();
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

    await importOffscreen();
    const portA = connectChat();
    const portB = connectChat();
    const portC = connectChat();

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

    await importOffscreen();
    const portA = connectChat();
    const portB = connectChat();

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

    await importOffscreen();
    const portA = connectChat();
    const portB = connectChat();

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
