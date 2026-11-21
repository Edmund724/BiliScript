import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import type { BudgetPlan } from "../../extension/ai/types.js";

let segCache: typeof import("../../extension/ai/segment-cache.js");
let followup: typeof import("../../extension/ai/followup-context.js");
let sendMessageMock: ReturnType<typeof vi.fn>;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  const handler = (await import("../../extension/ai/segment-cache-handler.js")).createSegmentCacheHandler();
  sendMessageMock = vi.fn((message) => {
    if (message?.type === "segment-cache") {
      return new Promise((resolve) => handler(message, null, resolve));
    }
    return Promise.resolve({ ok: true });
  });
  installChromeHost({ runtime: { sendMessage: sendMessageMock } });
  segCache = await import("../../extension/ai/segment-cache.js");
  followup = await import("../../extension/ai/followup-context.js");
}

async function seedSummaryCache({ bvid, cid, subtitleId, indexes }: {
  bvid: string;
  cid: string;
  subtitleId: string;
  indexes: number[];
}) {
  for (const index of indexes) {
    await segCache.saveSegmentSummary(
      segCache.getSegmentSummaryKey({ bvid, cid, subtitleId, segmentIndex: index }),
      `小结${index}：第${index}段摘要。`
    );
  }
}

const context = {
  title: "跨会话视频",
  bvid: "BV1cross",
  cid: "9",
  selectedSubtitleId: "sub-9",
  subtitleLang: "zh",
  chapters: [],
  subtitleBody: [{ from: 0, to: 5, content: "整篇原始字幕全文的唯一标记 __RAW_FULL__" }]
};

const history = [{ role: "assistant", content: "# 视频笔记：《跨会话视频》\n完整笔记正文。" }];

const EMPTY_SEGMENT_PLAN: BudgetPlan = {
  totalChars: 0,
  estimatedTokens: 0,
  mode: "map-reduce",
  segments: [],
  estimatedCalls: 0,
  needsReduce: false,
  reduceGroupInputChars: 0
};

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("跨会话压缩摘要恢复（load-stored-summaries）", () => {
  it("plan.segments 为空但存在分段小结缓存 → 经 load-stored-summaries 恢复纯压缩摘要", async () => {
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });
    sendMessageMock.mockClear();

    const result = (await followup.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history
    }))!;

    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    expect(result.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
    expect(result.subtitleBody).toEqual([]);
    expect(result.bvid).toBe(context.bvid);
    expect(result.cid).toBe(context.cid);

    const ops = sendMessageMock.mock.calls.map(([m]) => m?.op);
    expect(ops).toEqual(["load-stored-summaries"]);
  });

  it("段小结缺失（同视频不同轨/未落盘）→ 维持 null 交回完整 Map-Reduce", async () => {
    await seedSummaryCache({ bvid: "BV1other", cid: "1", subtitleId: "s", indexes: [1, 2, 3] });

    const result = await followup.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history
    });
    expect(result).toBeNull();
  });

  it("缺 bvid/cid 的追问上下文不回退（键位无法定位）→ null", async () => {
    const result = await followup.resolveFollowupContext({
      context: { ...context, bvid: "", cid: "" },
      plan: EMPTY_SEGMENT_PLAN,
      history
    });
    expect(result).toBeNull();
  });
});

describe("会话内路径：plan.segments 存在时走批量 load-summaries", () => {
  it("N 段追问的小结加载一次批量往返（load-summaries），不逐段 load-summary", async () => {
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2] });
    sendMessageMock.mockClear();

    const inMemoryPlan: BudgetPlan = {
      ...EMPTY_SEGMENT_PLAN,
      segments: [
        { index: 1, from: 0, to: 500, chars: 9, items: [{ from: 0, to: 500, content: "内存版本内容XYZ" }] },
        { index: 2, from: 500, to: 1000, chars: 7, items: [{ from: 500, to: 1000, content: "内存第二段内容" }] }
      ]
    };
    const result = (await followup.resolveFollowupContext({
      context,
      plan: inMemoryPlan,
      history
    }))!;

    expect(result).not.toBeNull();
    const cacheMessages = sendMessageMock.mock.calls.map(([m]) => m).filter((m) => m?.type === "segment-cache");
    expect(cacheMessages.map((m) => m.op)).toEqual(["load-summaries"]);
    expect(cacheMessages[0].segmentIndexes).toEqual([1, 2]);
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结2：第2段摘要。");
    expect(result.compressedSummaryMarkdown).not.toContain("内存第二段内容");
  });

  it("既有会话内行为回归：成稿后追问的压缩上下文语义不变", async () => {
    const body = Array.from({ length: 210 }, (_, i) => ({
      from: i * 5,
      to: i * 5 + 5,
      content: "x".repeat(1000)
    }));
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({ body, chapters: [] });
    const result = (await followup.resolveFollowupContext({
      context: { ...context, subtitleBody: body },
      plan,
      history,
      loadSummaries: async () => ["小结一：事实A。"]
    }))!;
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.compressedSummaryMarkdown).toContain("小结一：事实A。");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
  });
});
