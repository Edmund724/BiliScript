import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { chatCompletion } from "../../extension/ai/completion.js";
import type { SegmentCacheMessage } from "../../extension/shared/messaging-protocol.js";

const { chatCompletionMock } = vi.hoisted(() => ({
  chatCompletionMock: vi.fn<typeof chatCompletion>()
}));

vi.mock("../../extension/ai/completion.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chatCompletion: chatCompletionMock
}));

import { createSegmentCacheHandler } from "../../extension/ai/segment-cache-handler.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

function makeBody() {
  return Array.from({ length: 2600 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

function makeSmallBody() {
  return Array.from({ length: 100 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

const CONTEXT_KEY = "video:BV1bridge|101";
let host: MinimalChromeHost;
let segmentCacheHandler: ReturnType<typeof createSegmentCacheHandler>;
let sendMessageMock: ReturnType<typeof vi.fn>;

function installHost() {
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    offscreen: true,
    storage: true,
    replies: {
      "resolve-ai-provider": () => ({
        ok: true,
        provider: {
          baseUrl: "https://api.example.com/v1",
          id: "p1",
          name: "测试平台",
          model: "m1",
          enabled: true,
          requiresKey: false,
          hasSavedKey: true
        },
        apiKey: "test-key"
      }),
      "segment-cache": (message: unknown) =>
        new Promise((resolve) => segmentCacheHandler(message as SegmentCacheMessage, {}, resolve))
    }
  });
  sendMessageMock = host.sendMessage;
}

async function importOffscreen() {
  vi.resetModules();
  resetModuleState();
  installHost();
  return import("../../extension/entry/offscreen.js");
}

function connectChat() {
  let onMessageListener: ((message: unknown) => void) | undefined;
  const port: chrome.runtime.Port & { postMessage: ReturnType<typeof vi.fn> } = {
    name: "offscreen-chat",
    onMessage: {
      addListener: (fn: (message: unknown) => void) => {
        onMessageListener = fn;
      },
      removeListener: () => {}
    },
    onDisconnect: {
      addListener: (fn: () => void) => {},
      removeListener: () => {}
    },
    postMessage: vi.fn((_message: unknown) => {}),
    disconnect: vi.fn()
  };
  host.onConnectListeners[0](port);
  return {
    port,
    send: (msg: unknown) => onMessageListener!(msg)
  };
}

beforeEach(() => {
  chatCompletionMock.mockReset();
  chatCompletionMock.mockImplementation(async () => "分段小结内容");
  segmentCacheHandler = createSegmentCacheHandler();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("offscreen 段缓存消息族端到端（Map-Reduce 缓存落盘）", () => {
  it("offscreen 里跑 Map-Reduce：段缓存经消息落 SW、无写入失败提示", async () => {
    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { bvid: "BV1bridge", cid: "101", title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    });
    session.send({ action: "cost-guard-confirm", ok: true });

    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "load-summary").length).toBe(5);
    expect(ops.filter((op) => op === "save-summary").length).toBe(5);

    const storeKeys = Object.keys((await host.storage!.get(null)) as Record<string, unknown>);
    const rawKeys = storeKeys.filter((k) => k.startsWith("biliscript_lvs_raw_"));
    expect(rawKeys.length).toBe(0);
    expect(storeKeys.filter((k) => k.startsWith("biliscript_lvs_summary_")).length).toBe(0);
    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    const artifacts = await defaultSubtitleIdbStore.listAllAiArtifacts();
    expect(artifacts.filter((a) => a.family === "biliscript_lvs_summary_")).toHaveLength(5);

    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("用户停止（abort）：编排收束为 stopped，无原始段写入也无未完成小结落盘", async () => {
    let segmentCalls = 0;
    chatCompletionMock.mockImplementation(async (input) => {
      if (String(input.messages?.at(-1)?.content || "").includes("连续片段")) {
        segmentCalls += 1;
        return new Promise((resolve, reject) => {
          input.signal!.addEventListener("abort", () => {
            const error = new Error("aborted") as Error & { aborted: boolean };
            error.aborted = true;
            reject(error);
          });
        });
      }
      return "# 视频笔记：《长视频》\n完整笔记正文。";
    });

    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { bvid: "BV1bridge", cid: "101", title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    });
    session.send({ action: "cost-guard-confirm", ok: true });

    await vi.waitFor(() => {
      expect(segmentCalls).toBe(3);
    });
    session.send({ action: "stop" });

    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "stopped")).toBe(true);
    });

    const storeKeys = Object.keys(await host.storage!.get(null));
    expect(storeKeys.filter((k) => k.startsWith("biliscript_lvs_raw_")).length).toBe(0);

    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "save-summary").length).toBe(0);
    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("多轮连续 chat：上一轮中止后下一轮正常写入 5 段小结且不写入任何 raw 键", async () => {
    let firstRound = true;
    let segmentCalls = 0;
    chatCompletionMock.mockImplementation(async (input) => {
      if (String(input.messages?.at(-1)?.content || "").includes("连续片段")) {
        segmentCalls += 1;
        if (firstRound) {
          return new Promise((resolve, reject) => {
            input.signal!.addEventListener("abort", () => {
              const error = new Error("aborted") as Error & { aborted: boolean };
              error.aborted = true;
              reject(error);
            });
          });
        }
        return "分段小结内容";
      }
      return "# 视频笔记：《长视频》\n完整笔记正文。";
    });

    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { bvid: "BV1bridge", cid: "101", title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    });
    session.send({ action: "cost-guard-confirm", ok: true });
    await vi.waitFor(() => {
      expect(segmentCalls).toBe(3);
    });

    session.send({ action: "stop" });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "stopped")).toBe(true);
    });

    firstRound = false;
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { bvid: "BV1bridge", cid: "101", title: "长视频", subtitleBody: makeBody() },
      prompt: "再总结"
    });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.filter((c) => c[0]?.type === "cost-guard").length).toBe(2);
    });
    session.send({ action: "cost-guard-confirm", ok: true });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "save-summary").length).toBe(5);
    const storeKeys = Object.keys(await host.storage!.get(null));
    expect(storeKeys.filter((k) => k.startsWith("biliscript_lvs_raw_")).length).toBe(0);
    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    const artifacts = await defaultSubtitleIdbStore.listAllAiArtifacts();
    expect(artifacts.filter((a) => a.family === "biliscript_lvs_summary_")).toHaveLength(5);
    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("空闲超时：中断仍报超时错误，且单次路径不产生段缓存写入", async () => {
    chatCompletionMock.mockImplementation(() => new Promise(() => {}));

    vi.resetModules();
    resetModuleState();
    installHost();
    await import("../../extension/ai/ladder.js");
    await import("../../extension/entry/offscreen.js");
    vi.useFakeTimers();

    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { bvid: "BV1bridge", cid: "101", title: "短视频", subtitleBody: makeSmallBody() },
      prompt: "总结"
    });

    for (let i = 0; i < 50 && chatCompletionMock.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(chatCompletionMock.mock.calls.length).toBeGreaterThan(0);
    expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(false);

    await vi.advanceTimersByTimeAsync(90_000);
    const posted = session.port.postMessage.mock.calls.map((c) => c[0]);
    expect(posted.some((m) => m?.type === "error" && String(m.error || "").includes("请求超时"))).toBe(true);

    const ops = sendMessageMock.mock.calls.map((c) => c[0]).filter((m) => m?.type === "segment-cache");
    expect(ops).toHaveLength(0);
  });
});
