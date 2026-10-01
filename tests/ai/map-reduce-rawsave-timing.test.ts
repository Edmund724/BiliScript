// ai/map-reduce 原始段写会话收口测试（写单元 run-scoped 重构）：
// 原始段盘改为 run-scoped 写会话：saveRaw 同步入会话缓冲、返回 void（不再有 per-op
// 结果，也不阻塞段小结的模型调用）；会话由 orchestrateMapReduce 创建、生命周期 = 整个
// 编排调用（跨溢出重跑两轮），所有出口（done / stopped / 溢出重跑 / 异常上抛）统一
// close 一次，close 的落盘失败经 onWriteError 接到既有 notifyCacheWriteError 去重门
// （不抛、不影响 draft）。小结盘仍是 await（复用语义依赖）。
// 会话工厂经 orchestrateMapReduce 的 createWriteSession 注入缝换桩
//（arch-review-2026-09/05：宿主迁 SW 后段缓存不再静态入 chunk），模型调用经既有
// chatCompletion 注入缝；本文件第三条用例用真实写会话 adapter 验证 close 失败路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

// 可控写会话桩：saveRaw 返回 void（同步缓冲），close 由编排收尾调用
const session = vi.hoisted(() => ({
  loadSummary: vi.fn(),
  loadSummaries: vi.fn(),
  loadStoredRaw: vi.fn(),
  saveSummary: vi.fn(),
  saveRaw: vi.fn(),
  close: vi.fn()
}));

let mod: typeof import("../../extension/ai/map-reduce.js");

type Port = ReturnType<typeof makePort>;
type Deferred = ReturnType<typeof makeDeferred>;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/map-reduce.js");
}

beforeEach(async () => {
  // clearMocks 只清调用记录不清实现，这里统一重设默认行为：
  // 小结缓存未命中、写盘成功、close 空操作
  session.loadSummary.mockResolvedValue(null);
  session.saveSummary.mockResolvedValue({ ok: true });
  session.saveRaw.mockReturnValue(undefined);
  session.close.mockResolvedValue(undefined);
  await importModules();
});

function makeProvider() {
  return { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
}

function makeContext() {
  return {
    title: "测试视频",
    bvid: "BV1test",
    cid: "123",
    selectedSubtitleId: "sub-1",
    // 溢出重跑按 context 现场重算 plan：这里给真实字幕体（首轮用注入 plan）
    subtitleBody: makeSubtitleBody(210000),
    chapters: []
  };
}

function makePort() {
  return { postMessage: vi.fn() };
}

async function makePlan() {
  const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
  return buildBudgetPlan({ body: makeSubtitleBody(210000), chapters: [] });
}

// 可控 promise：外部手动 resolve/reject（时序锁的载体）
function makeDeferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 排空微任务队列（真实计时器：一个宏任务边界足以冲刷全部挂起的微任务链）
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 依 messages[user].content 识别分段小结/成稿调用
function isSegmentCall(input: { messages?: Array<{ content?: string }> }) {
  return String(input.messages?.at(-1)?.content || "").includes("连续片段");
}

function cacheWriteNotices(port: Port) {
  return port.postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m.type === "notice" && String(m.data || "").includes("缓存写入失败"));
}

describe("原始段写会话（run-scoped）", () => {
  it("用例A：saveRaw 同步入缓冲（返回 void、不阻塞模型调用），收尾统一 close 一次", async () => {
    const plan = await makePlan();
    expect(plan.segments).toHaveLength(5);

    const events: string[] = [];
    session.saveRaw.mockImplementation(() => {
      events.push("rawsave:buffer");
    });
    session.close.mockImplementation(async () => {
      events.push("close");
    });
    let segmentCalls = 0;
    const chatImpl = vi.fn(async (input) => {
      if (!isSegmentCall(input)) {
        events.push("model:note");
        return "# 视频笔记：《测试视频》\n完整笔记正文。";
      }
      segmentCalls += 1;
      events.push("model:segment");
      return `小结${segmentCalls}。`;
    });

    const port = makePort();
    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context: makeContext(),
      plan,
      port,
      chatCompletion: chatImpl,
      createWriteSession: () => session
    });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    // 5 段各一次同步 saveRaw：无 per-op 结果（void），且缓冲先于该段模型调用（不阻塞）
    expect(session.saveRaw).toHaveBeenCalledTimes(5);
    for (const call of session.saveRaw.mock.results) {
      expect(call.value).toBeUndefined();
    }
    expect(events.indexOf("rawsave:buffer")).toBeLessThan(events.indexOf("model:segment"));
    // 小结盘仍 awaited：5 段各一次
    expect(session.saveSummary).toHaveBeenCalledTimes(5);
    // 收尾统一 close 一次（挂在全部模型调用之后、本函数结算之前）
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe("close");
    expect(cacheWriteNotices(port)).toHaveLength(0);
  });

  it("用例B：小结盘仍 await——saveSummary resolve 前编排不结算", async () => {
    const plan = await makePlan();
    const deferreds: Deferred[] = [];
    session.saveSummary.mockImplementation(() => {
      const d = makeDeferred();
      deferreds.push(d);
      return d.promise;
    });
    const chatImpl = vi.fn(async (input) => (isSegmentCall(input) ? "小结。" : "# 视频笔记：《测试视频》\n完整笔记正文。"));

    const port = makePort();
    const orchestration = mod.orchestrateMapReduce({
      provider: makeProvider(),
      context: makeContext(),
      plan,
      port,
      chatCompletion: chatImpl,
      createWriteSession: () => session
    });

    // 首波三段（并发 3）模型调用完成、小结盘全部挂起：成稿未开始、无 done/token 回吐
    await flushMicrotasks();
    expect(chatImpl).toHaveBeenCalledTimes(3);
    expect(deferreds).toHaveLength(3);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);

    // 放行小结盘 → 编排才结算（复用语义依赖不变）。并发 3 共两波：已 resolve 的
    // 重复 resolve 无害，第二波新挂起的小结盘靠第二次放行收尾。
    deferreds.forEach((d) => d.resolve({ ok: true }));
    await flushMicrotasks();
    deferreds.forEach((d) => d.resolve({ ok: true }));
    const result = await orchestration;
    expect(result.aborted).toBe(false);
    expect(chatImpl).toHaveBeenCalledTimes(6);
    expect(port.postMessage.mock.calls.map((c) => c[0]).some((m) => m.type === "done")).toBe(true);
  });

  it("用例B2：溢出重跑两轮共用一个会话，收尾只 close 一次", async () => {
    const plan = await makePlan();
    let noteCalls = 0;
    const chatImpl = vi.fn(async (input) => {
      if (isSegmentCall(input)) {
        return "小结。";
      }
      noteCalls += 1;
      if (noteCalls === 1) {
        throw Object.assign(new Error("maximum context length exceeded"), { overflow: true });
      }
      return "# 视频笔记：《测试视频》\n完整笔记正文。";
    });

    const port = makePort();
    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context: makeContext(),
      plan,
      port,
      chatCompletion: chatImpl,
      createWriteSession: () => session
    });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    // 两轮（常态档 + 0.5 档）各自的段小结写盘共用同一会话，收尾只 close 一次
    expect(session.close).toHaveBeenCalledTimes(1);
    // 常态档 5 段 saveRaw（0.5 档不写原始段）
    expect(session.saveRaw).toHaveBeenCalledTimes(5);
  });

  it("用例C：收尾 close 落盘残留失败（真实写会话 adapter）→ 一条去重 notice、不抛、不影响 draft", async () => {
    const plan = await makePlan();
    // 真实写会话 adapter 的消息层打桩：段小结读未命中、save-summary 直通成功、
    // close 的 save-raw 失败（模拟 LRU 淘汰后重试仍失败）
    const sendMessageMock = vi.fn(async (message: { op?: string }) => {
      if (message.op === "load-summary") return { ok: true, summary: null };
      if (message.op === "save-summary") return { ok: true };
      if (message.op === "save-raw") {
        return { ok: false, error: "缓存写入失败（已淘汰旧视频后重试仍失败）：quota" };
      }
      return { ok: true };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage: sendMessageMock } });
    const { createSegmentCacheWriteSession } = await import("../../extension/ai/segment-cache-proxy.js");

    // 首轮：并发 3 段的原始段已入缓冲（saveRaw 先于模型调用），段调用随即溢出 →
    // 整轮按 0.5 档重跑（重跑档不写原始段、合并键不同）→ 首轮 3 段残留只能由收尾
    // close 补落；重跑成功出稿，故 close 失败不影响 draft。
    let segmentAttempts = 0;
    const chatImpl = vi.fn(async (input) => {
      if (isSegmentCall(input)) {
        if (segmentAttempts < 3) {
          segmentAttempts += 1;
          throw Object.assign(new Error("maximum context length exceeded"), { overflow: true });
        }
        return "小结。";
      }
      return "# 视频笔记：《测试视频》\n完整笔记正文。";
    });

    const port = makePort();
    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context: makeContext(),
      plan,
      port,
      chatCompletion: chatImpl,
      createWriteSession: createSegmentCacheWriteSession
    });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    // 首轮 3 段残留经 close 按 save-raw 补落，全部失败 → 去重门只提示一次
    const ops = sendMessageMock.mock.calls.map((c) => c[0].op);
    expect(ops.filter((op) => op === "save-raw")).toHaveLength(3);
    expect(ops.filter((op) => op === "save-summary-raw")).toHaveLength(0);
    expect(cacheWriteNotices(port)).toHaveLength(1);
    // 重跑的小结盘（save-summary 直通）不受 close 失败影响
    expect(ops.filter((op) => op === "save-summary").length).toBeGreaterThan(0);
  });

  it("用例D：abort 收束与异常上抛同样经 close 收尾", async () => {
    const plan = await makePlan();
    const controller = new AbortController();
    const chatImpl = vi.fn(async (input) => {
      if (isSegmentCall(input)) {
        controller.abort();
        throw Object.assign(new Error("已停止生成"), { aborted: true });
      }
      return "成稿";
    });

    const port = makePort();
    const aborted = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context: makeContext(),
      plan,
      port,
      signal: controller.signal,
      chatCompletion: chatImpl,
      createWriteSession: () => session
    });
    expect(aborted.aborted).toBe(true);
    expect(session.close).toHaveBeenCalledTimes(1);

    // 异常上抛路径：close 已收尾后才抛出（port 不出现 done）
    session.close.mockClear();
    const failing = vi.fn(async (input) => {
      if (isSegmentCall(input)) {
        throw new Error("HTTP 500");
      }
      return "成稿";
    });
    const port2 = makePort();
    await expect(
      mod.orchestrateMapReduce({
        provider: makeProvider(),
        context: makeContext(),
        plan,
        port: port2,
        chatCompletion: failing,
        createWriteSession: () => session
      })
    ).rejects.toThrow("HTTP 500");
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
