// offscreen 段缓存消息族端到端回归：
// 平台限制——offscreen 文档只有 chrome.runtime、没有 chrome.storage，段缓存宿主
// 是 SW。本测试构造「runtime 消息路由到 SW 端 segment-cache handler（内存
// storage）」的环境，跑通真实 ladder → map-reduce → segment-cache-proxy →
// 消息 → segment-cache 链路，断言：
// - 分段小结读写全部经 segment-cache 消息族落 SW（内存 store 可见）；
// - map-reduce 仅写 biliscript_lvs_summary_*，不写 biliscript_lvs_raw_* 到 chrome.storage.local；
// - LRU 索引登记了 biliscript_lvs_summary_ 族；
// - 全程无「本地字幕缓存写入失败」提示。

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

// 208k 字符（>200k 预算线 → map-reduce；5 段 + 成稿 = 6 次调用 ≥5 → 弹成本护栏，
// 测试内自动确认）
function makeBody() {
  return Array.from({ length: 2600 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

// 8k 字符（≤200k → 单次流式路径；空闲超时用例用：本路径计时不被 ladder 暂停）
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

// 本用例的宿主：runtime（resolve-ai-provider 与 segment-cache 两条回包，后者路由到 SW 端
// 真实 handler）+ 内存 storage.local（SW 侧 handler 直调 segment-cache 时读它）+ offscreen。
function installHost() {
  host = installMinimalChromeHost({
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
  // 原实现把监听挂在 port._onMessage 上；chrome-types 的 Port 无此字段，改挂局部
  // 变量（单监听覆盖语义与运行时行为不变）
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
      context: { title: "长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    // 抬线（200k）后夹具预估 6 次调用 ≥5 → 先弹成本护栏：自动确认后编排才启动
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    });
    session.send({ action: "cost-guard-confirm", ok: true });

    // 成稿回吐 = 编排完整跑完（map 5 段 + 成稿，缓存全部经消息落 SW）
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    // 仅读写分段小结（5 次 load-summary + 5 次 save-summary）
    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "load-summary").length).toBe(5);
    expect(ops.filter((op) => op === "save-summary").length).toBe(5);

    const storeKeys = Object.keys((await host.storage!.get(null)) as Record<string, unknown>);
    const rawKeys = storeKeys.filter((k) => k.startsWith("biliscript_lvs_raw_"));
    const summaryKeys = storeKeys.filter((k) => k.startsWith("biliscript_lvs_summary_"));
    expect(rawKeys.length).toBe(0);
    expect(summaryKeys.length).toBe(5);
    expect(storeKeys).toContain("biliscript_cache_lru_index");

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
      context: { title: "长视频", subtitleBody: makeBody() },
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
      context: { title: "长视频", subtitleBody: makeBody() },
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
      context: { title: "长视频", subtitleBody: makeBody() },
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
    expect(storeKeys.filter((k) => k.startsWith("biliscript_lvs_summary_")).length).toBe(5);
    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("空闲超时：中断仍报超时错误，且单次路径不产生段缓存写入", async () => {
    // 单次流式路径（≤200k）：空闲计时不被 ladder 的 map-reduce 暂停，超时可真实触发；
    // 模型调用挂起不返回 → 90 秒窗口到点即 abort + error 回吐。
    chatCompletionMock.mockImplementation(() => new Promise(() => {}));

    vi.resetModules();
    resetModuleState();
    installHost();
    // 假时钟下动态 import 会挂起：真实时钟先把模块图预热（含 offscreen 的 ladder 懒加载）
    await import("../../extension/ai/ladder.js");
    await import("../../extension/entry/offscreen.js");
    vi.useFakeTimers();

    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "短视频", subtitleBody: makeSmallBody() },
      prompt: "总结"
    });

    // 单次路径无成本护栏；推进到挂起的模型调用
    for (let i = 0; i < 50 && chatCompletionMock.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(chatCompletionMock.mock.calls.length).toBeGreaterThan(0);
    expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(false);

    // 90 秒空闲窗口到点：abort + 超时错误
    await vi.advanceTimersByTimeAsync(90_000);
    const posted = session.port.postMessage.mock.calls.map((c) => c[0]);
    expect(posted.some((m) => m?.type === "error" && String(m.error || "").includes("请求超时"))).toBe(true);

    const ops = sendMessageMock.mock.calls.map((c) => c[0]).filter((m) => m?.type === "segment-cache");
    expect(ops).toHaveLength(0);
  });
});
