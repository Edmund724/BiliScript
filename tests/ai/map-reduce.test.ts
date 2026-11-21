import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";

let mod: typeof import("../../extension/ai/map-reduce.js");
let segmentCacheLoop: Awaited<ReturnType<typeof installSegmentCacheLoop>>;

async function installSegmentCacheLoop() {
  const handler = (await import("../../extension/ai/segment-cache-handler.js")).createSegmentCacheHandler();
  const sendMessage = vi.fn((message) => {
    if (message?.type === "segment-cache") {
      return new Promise((resolve) => handler(message, null, resolve));
    }
    return Promise.resolve({ ok: true });
  });
  const storage = installChromeHost({ runtime: { sendMessage } });
  return { storage, sendMessage };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  segmentCacheLoop = await installSegmentCacheLoop();
  mod = await import("../../extension/ai/map-reduce.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    subtitleBody: makeSubtitleBody(210000),
    chapters: []
  };
}

function makePort() {
  return { postMessage: vi.fn() };
}

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function buildSequencedMock() {
  const summaryTexts: Record<number, string> = {
    1: "小结一：事实A。",
    2: "小结二：事实B。",
    3: "小结三：事实C。",
    4: "小结四：事实D。",
    5: "小结五：事实E。"
  };
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1]?.content || "";
    const isSegment = user.includes("连续片段");
    if (isSegment) {
      const m = user.match(/第 (\d+)\//);
      const idx = m ? Number(m[1]) : 1;
      return jsonResponse({ choices: [{ message: { content: summaryTexts[idx] || "小结" } }] });
    }
    return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n完整笔记正文。" } }] });
  });
  return { fetchMock, summaryTexts };
}

describe("buildProgressNotice 进度序号与百分比", () => {
  it("percent = round(index/total*100)，序号从 1 开始", () => {
    expect(mod.buildProgressNotice(1, 3)).toBe("正在整理第 1/3 段（33%）");
    expect(mod.buildProgressNotice(2, 3)).toBe("正在整理第 2/3 段（67%）");
    expect(mod.buildProgressNotice(3, 3)).toBe("正在整理第 3/3 段（100%）");
  });

  it("边界与非法入参：total 为 0/负/非数时回落到 1；index 越界收敛到 [1, total]", () => {
    expect(mod.buildProgressNotice(0, 3)).toBe("正在整理第 1/3 段（33%）");
    expect(mod.buildProgressNotice(5, 3)).toBe("正在整理第 3/3 段（100%）");
    expect(mod.buildProgressNotice(2, 0)).toBe("正在整理第 1/1 段（100%）");
    expect(mod.buildProgressNotice(2, -4)).toBe("正在整理第 1/1 段（100%）");
    expect(mod.buildProgressNotice(2, "x")).toBe("正在整理第 1/1 段（100%）");
  });
});

describe("orchestrateMapReduce 切片→小结→成稿编排", () => {
  it("逐段产出小结（带进度 notice）→ 成稿一次 → token+done 回吐", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(5);

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(result.segmentSummaries).toEqual([
      "小结一：事实A。",
      "小结二：事实B。",
      "小结三：事实C。",
      "小结四：事实D。",
      "小结五：事实E。"
    ]);

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    const notices = postMessages.filter((m) => m.type === "notice");
    expect(notices.map((n) => n.data).sort()).toEqual([
      "正在整理第 1/5 段（20%）",
      "正在整理第 2/5 段（40%）",
      "正在整理第 3/5 段（60%）",
      "正在整理第 4/5 段（80%）",
      "正在整理第 5/5 段（100%）"
    ]);

    const tokens = postMessages.filter((m) => m.type === "token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].data).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(postMessages.some((m) => m.type === "done")).toBe(true);
    const tokenIdx = postMessages.findIndex((m) => m.type === "token");
    const doneIdx = postMessages.findIndex((m) => m.type === "done");
    expect(doneIdx).toBeGreaterThan(tokenIdx);

    expect(fetchMock).toHaveBeenCalledTimes(6);

    const storageKeys = [...segmentCacheLoop.storage.map.keys()];
    expect(storageKeys.filter((k) => k.startsWith("biliscript_lvs_raw_"))).toHaveLength(0);
    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    const artifacts = await defaultSubtitleIdbStore.listAllAiArtifacts();
    expect(artifacts.filter((a) => a.family === "biliscript_lvs_summary_")).toHaveLength(5);
  });

  it("小结 prompt 忠实压缩且保留时间戳（对齐蓝本 _chunk_prompt 措辞）", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    const segmentPrompt = userContents.find((c) => c.includes("连续片段"));
    expect(segmentPrompt).toContain("视频标题：测试视频");
    expect(segmentPrompt).toContain("这是第 1/5 个连续片段");
    expect(segmentPrompt).toContain("请把这个片段忠实压缩到原文的约五分之一");
    expect(segmentPrompt).toContain("保留重要事实、例子、论证关系和原有时间点");
    expect(segmentPrompt).toContain("不做评价，不补充外部知识");
    expect(segmentPrompt).toMatch(/\[0:00-0:05\]/);
  });

  it("成稿 prompt 对齐蓝本 _note_prompt：材料带「### 片段 i」标注，标题 # 视频笔记", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    const notePrompt = userContents.find((c) => c.includes("视频笔记"));
    expect(notePrompt).toContain("写一份翔实、自然的 Markdown 视频笔记");
    expect(notePrompt).toContain("不要加入外部知识或评价");
    expect(notePrompt).toContain("标题使用：# 视频笔记：《测试视频》");
    expect(notePrompt).toContain("### 片段 1");
    expect(notePrompt).toContain("### 片段 2");
    expect(notePrompt).toContain("### 片段 3");
    expect(notePrompt).toContain("### 片段 4");
    expect(notePrompt).toContain("### 片段 5");
    expect(notePrompt).toContain("小结一：事实A。");
    expect(notePrompt).toContain("小结五：事实E。");
  });

  it("成稿输出 clamp 到 FINAL_OUTPUT_CHARS（16000）以内", async () => {
    const { fetchMock } = buildSequencedMock();
    const longDraft = "z".repeat(20000);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: longDraft } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });
    expect(result.draft.length).toBeLessThanOrEqual(16000);
    expect(result.draft).toBe(longDraft.slice(0, 16000));
    const tokenMsg = port.postMessage.mock.calls.map((c) => c[0]).find((m) => m.type === "token");
    expect(tokenMsg.data.length).toBeLessThanOrEqual(16000);
  });

  it("分段小结超 10k 时截断（clamp 到 SEGMENT_SUMMARY_CHARS）", async () => {
    const { fetchMock } = buildSequencedMock();
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "q".repeat(12000) } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });
    expect(result.segmentSummaries[0].length).toBeLessThanOrEqual(10000);
    expect(result.segmentSummaries[0]).toBe("q".repeat(10000));
  });
});

describe("orchestrateMapReduce 中止", () => {
  it("段间 abort：aborted=true、无 done、无最终 token", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    let callCount = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      callCount += 1;
      if (user.includes("连续片段") && callCount === 2) {
        controller.abort();
      }
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    expect(result.draft).toBe("");
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    const notices = postMessages.filter((m) => m.type === "notice").map((n) => n.data);
    expect(new Set(notices).size).toBe(notices.length);
    for (const notice of notices) {
      expect(notice).toMatch(/^正在整理第 \d\/5 段（\d+%）$/);
    }
  });

  it("abort 抛出的错误不再 post error（静默收束，已回吐内容不串数据）", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const abortError = Object.assign(new Error("已停止生成"), { aborted: true });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段") && user.includes("第 2/5")) {
        throw abortError;
      }
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "error")).toBe(false);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "stopped")).toBe(true);
  });

  it("已 abort 的 signal 直接短路：一次模型调用都不发", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    controller.abort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.filter((m) => m.type === "stopped").length).toBeLessThanOrEqual(1);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    expect(postMessages.some((m) => m.type === "error")).toBe(false);
  });
});

describe("plan.mode==='map-reduce' 才编排（不归并/超预算判定）", () => {
  it("预算内 body（100k）→ mode=single，不进入编排", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const plan = buildBudgetPlan({ body: makeSubtitleBody(100000) });
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
  });

  it("200k 边界一越 → mode=map-reduce 且 needsReduce=false；500k 段数=10 不归并", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const single = buildBudgetPlan({ body: makeSubtitleBody(200000) });
    expect(single.mode).toBe("single");

    const over = buildBudgetPlan({ body: makeSubtitleBody(200001) });
    expect(over.mode).toBe("map-reduce");
    expect(over.needsReduce).toBe(false);

    const big = buildBudgetPlan({ body: makeSubtitleBody(500000) });
    expect(big.segments).toHaveLength(10);
    expect(big.needsReduce).toBe(false);
  });

});

describe("缓存写入最终失败的上浮（LRU 淘汰后重试仍失败）", () => {
  it("存储写持续失败 → 经 port notice 上浮一次，编排不中断、照常成稿回吐", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const { setSubtitleCacheWriteInterceptorForTests } = await import("../../extension/subtitle/store-client.js");
    setSubtitleCacheWriteInterceptorForTests(() => {
      throw new Error("quota");
    });
    const port = makePort();

    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });
    setSubtitleCacheWriteInterceptorForTests(null);

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    const cacheNotices = postMessages.filter(
      (m) => m.type === "notice" && String(m.data || "").includes("缓存写入失败")
    );
    expect(cacheNotices).toHaveLength(1);
    expect(postMessages.some((m) => m.type === "done")).toBe(true);
  });
});

describe("溢出放宽预算重跑（context-length 溢出的编排级兜底）", () => {
  function overflowResponse() {
    return { ok: false, status: 400, text: async () => "maximum context length exceeded" };
  }

  function buildOverflowSequencedMock({ overflowSegments = 0, overflowNotes = 0 } = {}) {
    let segmentCalls = 0;
    let noteCalls = 0;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        segmentCalls += 1;
        if (segmentCalls <= overflowSegments) {
          return overflowResponse();
        }
        const m = user.match(/第 (\d+)\//);
        return jsonResponse({ choices: [{ message: { content: `小结${m ? Number(m[1]) : 1}。` } }] });
      }
      noteCalls += 1;
      if (noteCalls <= overflowNotes) {
        return overflowResponse();
      }
      return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n完整笔记正文。" } }] });
    });
    return { fetchMock, counters: { get segmentCalls() { return segmentCalls; }, get noteCalls() { return noteCalls; } } };
  }

  it("段小结溢出 → notice 告知 → 按 0.5 倍预算重切段整轮重跑 → 成功回吐一次", async () => {
    const { fetchMock } = buildOverflowSequencedMock({ overflowSegments: 3 });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    expect(plan.segments).toHaveLength(5);

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.filter((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toHaveLength(1);
    expect(postMessages.filter((m) => m.type === "done")).toHaveLength(1);
    expect(postMessages.filter((m) => m.type === "token")).toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(13);
    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    expect(userContents.some((c) => c.includes("这是第 1/5 个连续片段"))).toBe(true);
    expect(userContents.some((c) => c.includes("这是第 1/9 个连续片段"))).toBe(true);
  });

  it("重跑仍溢出 → 带明确文案抛出（不静默），无 done/token", async () => {
    const { fetchMock } = buildOverflowSequencedMock({ overflowSegments: Infinity });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await expect(
      mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port })
    ).rejects.toThrow("调低分段量后仍超出模型上下文");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(true);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("非溢出错误（HTTP 500）→ 原样上抛，不触发预算重跑", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "server error" })));
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await expect(
      mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port })
    ).rejects.toThrow("HTTP 500");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(false);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
  });

  it("成稿阶段溢出 → 已完成段不浪费判断，整轮重跑后成稿成功", async () => {
    const { fetchMock } = buildOverflowSequencedMock({ overflowNotes: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(fetchMock).toHaveBeenCalledTimes(16);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.filter((m) => m.type === "done")).toHaveLength(1);
  });

  it("中止（aborted）不触发预算重跑：stopped 收束，无重试 notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = Object.assign(new Error("已停止生成"), { aborted: true });
      throw e;
    }));
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "stopped")).toBe(true);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(false);
  });
});

describe("presetId 穿线（概览 Map-Reduce 链 → 请求体）", () => {
  it("provider 记录的 presetId 抵达分段与成稿请求体：反代 host 无规则也按 modelscope 出 enable_thinking", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: {
        ...makeProvider(),
        baseUrl: "https://thinking-proxy.example.com/v1",
        model: "Qwen/Qwen3-32B",
        presetId: "modelscope"
      },
      context,
      plan,
      port,
      thinkingLevel: "off"
    });

    expect(result.aborted).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).toMatchObject({ enable_thinking: false });
    }
  });
});

describe("溢出重跑预算档隔离：_b50 不串常态档内容", () => {
  it("常态档已落盘小结不被 0.5 档重跑命中；两档 key 并存、内容各自", async () => {
    const storage = segmentCacheLoop.storage;
    const mr = mod;
    const sc = await import("../../extension/ai/segment-cache.js");

    const provider = makeProvider();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    const firstIndex = plan.segments[0].index;

    const { fetchMock: okFetch } = buildSequencedMock();
    vi.stubGlobal("fetch", okFetch);
    const run1 = await mr.orchestrateMapReduce({ provider, context, plan, port: makePort() });
    expect(run1.aborted).toBe(false);
    const scale1Key = sc.buildSegmentSummaryCacheKey(context, firstIndex, 1);
    expect(scale1Key).not.toMatch(/_b\d+$/);
    expect(await sc.loadSegmentSummary(scale1Key)).toBe("小结一：事实A。");

    let noteCalls = 0;
    const overflowFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        const m = user.match(/第 (\d+)\//);
        return jsonResponse({ choices: [{ message: { content: `收紧档小结${m ? Number(m[1]) : 1}。` } }] });
      }
      noteCalls += 1;
      if (noteCalls === 1) {
        return { ok: false, status: 400, text: async (): Promise<string> => "maximum context length exceeded" };
      }
      return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n收紧档正文。" } }] });
    });
    vi.stubGlobal("fetch", overflowFetch);
    const run2 = await mr.orchestrateMapReduce({ provider, context, plan, port: makePort() });

    expect(run2.aborted).toBe(false);
    expect(overflowFetch).toHaveBeenCalledTimes(11);

    const b50Key = sc.buildSegmentSummaryCacheKey(context, firstIndex, 0.5);
    expect(b50Key).toMatch(/_b50$/);
    expect(await sc.loadSegmentSummary(scale1Key)).toBe("小结一：事实A。");
    expect(await sc.loadSegmentSummary(b50Key)).toBe("收紧档小结1。");
    expect(run2.draft).toBe("# 视频笔记：《测试视频》\n收紧档正文。");
    expect(run2.segmentSummaries).toContain("收紧档小结1。");
    expect(run2.segmentSummaries).not.toContain("小结一：事实A。");
  });
});
