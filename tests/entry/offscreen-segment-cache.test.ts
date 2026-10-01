// offscreen 段缓存消息族端到端回归（arch-review-2026-09/05，原 storage 桥测试改造）：
// 平台限制——offscreen 文档只有 chrome.runtime、没有 chrome.storage，段缓存宿主
// 是 SW。本测试构造「runtime 消息路由到 SW 端 segment-cache handler（内存
// storage）」的环境，跑通真实 ladder → map-reduce → segment-cache-proxy →
// 消息 → segment-cache 链路，断言：
// - 原始段 / 分段小结读写全部经 segment-cache 消息族落 SW（内存 store 可见）；
// - 写聚合（段缓存写聚合 ticket）：saveRaw 入 run-scoped 写会话缓冲、随 saveSummary
//   合成 save-summary-raw 合并 op（5 段 = 5 条合并写，无单独 save-raw）；
// - 用户停止（abort）→ 编排收束（abortReturn）→ 会话收尾 close 把残留 raw 按
//   save-raw 落 SW（offscreen 侧不再有 flush 调用点）；
// - 会话收尾即落盘：上一轮残留不会遗留到下一轮 chat（新 chat 接力 flush 已删）；
// - LRU 索引登记了两个族；
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
let onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
let memoryArea: ReturnType<typeof makeMemoryArea>;
let segmentCacheHandler: ReturnType<typeof createSegmentCacheHandler>;
let sendMessageMock: ReturnType<typeof vi.fn>;

function makeMemoryArea() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (keys: string | string[] | null) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items || {})) store.set(k, v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    })
  };
}

function stubChromeRuntime() {
  sendMessageMock = vi.fn(async (message: unknown) => {
    const msg = message as { type?: string } & Record<string, unknown>;
    if (msg.type === "resolve-ai-provider") {
      return {
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
      };
    }
    if (msg.type === "segment-cache") {
      // 路由到 SW 端真实 handler（segment-cache 单源 + 内存 storage）
      return new Promise((resolve) => segmentCacheHandler(msg as SegmentCacheMessage, {}, resolve));
    }
    return { ok: true };
  });
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: { addListener: (fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn) },
      sendMessage: sendMessageMock
    },
    // SW 侧 handler 直调 segment-cache → chrome.storage.local（内存实现）
    storage: { local: memoryArea },
    offscreen: { closeDocument: vi.fn(async () => {}) }
  });
}

async function importOffscreen() {
  vi.resetModules();
  resetModuleState();
  onConnectListeners = [];
  stubChromeRuntime();
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
  onConnectListeners[0](port);
  return {
    port,
    send: (msg: unknown) => onMessageListener!(msg)
  };
}

beforeEach(() => {
  chatCompletionMock.mockReset();
  chatCompletionMock.mockImplementation(async () => "分段小结内容");
  memoryArea = makeMemoryArea();
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

    // raw / summary 两族的读（miss）与写都经 segment-cache 消息族过 SW；
    // 写聚合：5 段的 saveRaw 全部随 saveSummary 合成 save-summary-raw（5 条合并写，
    // 无单独 save-summary / save-raw 消息）
    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "load-summary").length).toBe(5);
    expect(ops.filter((op) => op === "save-summary-raw").length).toBe(5);
    expect(ops.filter((op) => op === "save-summary").length).toBe(0);
    expect(ops.filter((op) => op === "save-raw").length).toBe(0);

    const storeKeys = [...memoryArea.store.keys()];
    const rawKeys = storeKeys.filter((k) => k.startsWith("biliscript_lvs_raw_"));
    const summaryKeys = storeKeys.filter((k) => k.startsWith("biliscript_lvs_summary_"));
    expect(rawKeys.length).toBe(5);
    expect(summaryKeys.length).toBe(5);
    expect(storeKeys).toContain("biliscript_cache_lru_index");

    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("用户停止（abort）：编排收束后写会话 close 把缓冲的 raw 按 save-raw 落 SW", async () => {
    // 分段模型调用挂起在 abort 上（saveRaw 已入会话缓冲、saveSummary 未到达）
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

    // 首波并发 3 段的模型调用已发出（每段的 saveRaw 已入会话缓冲）
    await vi.waitFor(() => {
      expect(segmentCalls).toBe(3);
    });
    session.send({ action: "stop" });

    // 编排收束为 stopped；收尾 close 把缓冲的 3 段 raw 按 save-raw 落 SW
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "stopped")).toBe(true);
    });
    await vi.waitFor(() => {
      const rawKeys = [...memoryArea.store.keys()].filter((k) => k.startsWith("biliscript_lvs_raw_"));
      expect(rawKeys.length).toBe(3);
    });

    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "save-raw").length).toBe(3);
    // 未完成的段没有 summary 落盘，也没有合并 op
    expect(ops.filter((op) => op === "save-summary-raw").length).toBe(0);
    expect(ops.filter((op) => op === "save-summary").length).toBe(0);
    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("会话收尾即落盘：上一轮残留不遗留到下一轮 chat（本轮无遗留 save-raw）", async () => {
    // 首轮分段调用挂起在 abort 上（stop 后首轮收束，收尾 close 落盘残留）
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

    // 第一轮停止 → 收束 → close 落盘 3 段残留（落盘完成才等下一轮 chat）
    session.send({ action: "stop" });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "stopped")).toBe(true);
    });
    await vi.waitFor(() => {
      expect([...memoryArea.store.keys()].filter((k) => k.startsWith("biliscript_lvs_raw_")).length).toBe(3);
    });

    // 第二轮 chat（追问接力）：上一轮的 close 已在该轮 return 前 await 完成，
    // 本轮开始时没有任何遗留缓冲（接力 flush 调用点已随写会话收口删除）
    firstRound = false;
    const callsBeforeRound2 = sendMessageMock.mock.calls.length;
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: makeBody() },
      prompt: "再总结"
    });
    // 第二轮同样 ≥5 次调用：先弹成本护栏，确认后编排才启动
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.filter((c) => c[0]?.type === "cost-guard").length).toBe(2);
    });
    session.send({ action: "cost-guard-confirm", ok: true });
    await vi.waitFor(() => {
      expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "done")).toBe(true);
    });

    const rawCallIndexes = sendMessageMock.mock.calls
      .map((c, index) => ({ index, message: c[0] }))
      .filter(({ message }) => message?.type === "segment-cache" && message.op === "save-raw")
      .map(({ index }) => index);
    // 3 条 save-raw 全部来自上一轮收尾，无一落在本轮（本轮无遗留）
    expect(rawCallIndexes).toHaveLength(3);
    expect(rawCallIndexes.every((index) => index < callsBeforeRound2)).toBe(true);
    // 第二轮 5 段全部合并写
    const ops = sendMessageMock.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "segment-cache")
      .map((m) => m.op);
    expect(ops.filter((op) => op === "save-summary-raw").length).toBe(5);
    expect([...memoryArea.store.keys()].filter((k) => k.startsWith("biliscript_lvs_raw_")).length).toBe(5);
    const notices = session.port.postMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "notice");
    expect(notices.some((m) => String(m.data || "").includes("本地字幕缓存写入失败"))).toBe(false);
  });

  it("空闲超时：中断仍报超时错误；段缓存写入不再有超时 flush 调用点", async () => {
    // 单次流式路径（≤200k）：空闲计时不被 ladder 的 map-reduce 暂停，超时可真实触发；
    // 模型调用挂起不返回 → 90 秒窗口到点即 abort + error 回吐。
    // 注：map-reduce 期间计时被 ladder 暂停（offscreen-map-reduce-idle-timeout 回归），
    // 故「空闲超时 × 原始段缓冲」不可同时发生——残留落盘的唯一出口是编排收尾的
    // close（用户停止用例已覆盖同一 abort 路径）。
    chatCompletionMock.mockImplementation(() => new Promise(() => {}));

    vi.resetModules();
    resetModuleState();
    onConnectListeners = [];
    stubChromeRuntime();
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

    // 超时路径不再 flush（写单元收口后无 flush 调用点）：本路径也没有任何段缓存写入
    const ops = sendMessageMock.mock.calls.map((c) => c[0]).filter((m) => m?.type === "segment-cache");
    expect(ops).toHaveLength(0);
  });
});
