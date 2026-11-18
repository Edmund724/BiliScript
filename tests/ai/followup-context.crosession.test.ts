// ai/followup-context.js 跨会话回退测试：
// - plan.segments 为空时：
//   - 常规路径：从 IndexedDB 原始字幕轨（或遗留 biliscript_lvs_raw_* 键）恢复分段结构与按需检索；
//   - skipRawRetrieval: true（L0+L1 混合召回路径）：直接经 load-stored-summaries 枚举分段小结，不触达原始段；
// - 内存 plan.segments 存在时仍优先内存路径；两级皆空维持返回 null 交回完整 Map-Reduce。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";
import type { BudgetPlan } from "../../extension/ai/types.js";

let storage: ChromeHost;
let segCache: typeof import("../../extension/ai/segment-cache.js");
let idbStore: typeof import("../../extension/subtitle/idb-store.js")["defaultSubtitleIdbStore"];
let router: typeof import("../../extension/ai/followup-context.js");
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
  storage = installChromeHost({ runtime: { sendMessage: sendMessageMock } });
  idbStore = (await import("../../extension/subtitle/idb-store.js")).defaultSubtitleIdbStore;
  await idbStore.clearAll();
  segCache = await import("../../extension/ai/segment-cache.js");
  router = await import("../../extension/ai/followup-context.js");
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

async function seedLegacyRawCache({ bvid, cid, subtitleId, segments }: {
  bvid: string;
  cid: string;
  subtitleId: string;
  segments: Array<{ index: number; items: Array<{ from: number; to: number; content: string }> }>;
}) {
  const sourceKey = buildSubtitleSourceKey(subtitleId, "", "");
  const payload: Record<string, unknown> = {};
  for (const seg of segments) {
    payload[`biliscript_lvs_raw_${bvid}_${cid}_${sourceKey}_${seg.index}`] = {
      segments: seg.items,
      timestamp: 100
    };
  }
  await storage.local.set(payload);
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

const storedSegments = [
  { index: 1, items: [{ from: 0, to: 500, content: "开场白内容ABC" }] },
  { index: 2, items: [{ from: 500, to: 1000, content: "后续内容DEF" }] },
  { index: 3, items: [{ from: 1000, to: 1500, content: "结尾内容GHI" }] }
];

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

describe("跨会话回退：IndexedDB 主路径与遗留键回退", () => {
  it("主路径：IndexedDB rawTrack + 分段小结齐备 → 返回压缩上下文并命中检索注入", async () => {
    await idbStore.putRawTrack({
      bvid: context.bvid,
      cid: context.cid,
      trackKey: buildSubtitleSourceKey(context.selectedSubtitleId, "", context.subtitleLang),
      items: [
        { from: 0, to: 500, content: "a".repeat(50000) },
        { from: 500, to: 1000, content: "关键段落内容IDB_HIT" }
      ]
    });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2] });

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "09:00 那里讲了什么"
    }))!;

    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结2：第2段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("关键段落内容IDB_HIT");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
    expect(result.subtitleBody).toEqual([]);
  });

  it("遗留兼容：无 IDB 轨但存在遗留 biliscript_lvs_raw_* 键 → 仍可恢复检索注入", async () => {
    await seedLegacyRawCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "09:00 那里讲了什么"
    }))!;

    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
    expect(result.subtitleBody).toEqual([]);
    expect(result.bvid).toBe(context.bvid);
    expect(result.cid).toBe(context.cid);
  });

  it("skipRawRetrieval: true + EMPTY_SEGMENT_PLAN → 直接枚举分段小结，不发送 load-stored-raw", async () => {
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });
    sendMessageMock.mockClear();

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "09:00 那里讲了什么",
      skipRawRetrieval: true
    }))!;

    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    expect(result.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
    const ops = sendMessageMock.mock.calls.map(([m]) => m?.op);
    expect(ops).toContain("load-stored-summaries");
    expect(ops).not.toContain("load-stored-raw");
  });

  it("段缓存缺失（同视频不同轨/未落盘）→ 维持 null 交回完整 Map-Reduce", async () => {
    await seedLegacyRawCache({ bvid: "BV1other", cid: "1", subtitleId: "s", segments: storedSegments });
    await seedSummaryCache({ bvid: "BV1other", cid: "1", subtitleId: "s", indexes: [1, 2, 3] });

    const result = await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });

  it("缺 bvid/cid 的追问上下文不回退（键位无法定位）→ null", async () => {
    const result = await router.resolveFollowupContext({
      context: { ...context, bvid: "", cid: "" },
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });
});

describe("追问段缓存批量与命中段传输", () => {
  it("N 段追问的小结加载一次批量往返（load-summaries），不再逐段 load-summary", async () => {
    await seedLegacyRawCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });
    sendMessageMock.mockClear();

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "09:00 那里讲了什么"
    }))!;

    expect(result).not.toBeNull();
    const cacheMessages = sendMessageMock.mock.calls.map(([m]) => m).filter((m) => m?.type === "segment-cache");
    const batchOps = cacheMessages.filter((m) => m.op === "load-summaries");
    expect(batchOps).toHaveLength(1);
    expect(batchOps[0].segmentIndexes).toEqual([1, 2, 3]);
    expect(cacheMessages.filter((m) => m.op === "load-summary")).toHaveLength(0);
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
  });

  it("load-stored-raw 带 prompt：非命中段 items 不回传，命中段保留", async () => {
    await seedLegacyRawCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: "09:00 那里讲了什么"
    }))!;

    expect(result).not.toBeNull();
    const callIndex = sendMessageMock.mock.calls.findIndex(([m]) => m?.type === "segment-cache" && m?.op === "load-stored-raw");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const request = sendMessageMock.mock.calls[callIndex][0];
    expect(request.prompt).toBe("09:00 那里讲了什么");
    const response = await sendMessageMock.mock.results[callIndex].value;
    expect(response.ok).toBe(true);
    const byIndex = new Map<number, any>(response.storedSegments.map((seg: { index: number }) => [seg.index, seg]));
    expect(byIndex.get(1).items).toEqual([]);
    expect(byIndex.get(3).items).toEqual([]);
    expect(byIndex.get(2).items).toEqual([{ from: 500, to: 1000, content: "后续内容DEF" }]);
    expect(byIndex.get(1)).toMatchObject({ index: 1, from: 0, to: 500 });
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
  });

  it("空 prompt 追问：load-stored-raw 不带 prompt → 回退整篇", async () => {
    await seedLegacyRawCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });

    const result = (await router.resolveFollowupContext({
      context,
      plan: EMPTY_SEGMENT_PLAN,
      history,
      userPrompt: ""
    }))!;

    const callIndex = sendMessageMock.mock.calls.findIndex(([m]) => m?.type === "segment-cache" && m?.op === "load-stored-raw");
    const request = sendMessageMock.mock.calls[callIndex][0];
    expect(request.prompt).toBeUndefined();
    const response = await sendMessageMock.mock.results[callIndex].value;
    expect(response.storedSegments.every((seg: { items: unknown[] }) => seg.items.length > 0)).toBe(true);
    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
  });
});

describe("会话内路径不变：plan.segments 存在时完全优先内存段", () => {
  it("检索注入用内存段，且不触达段缓存的存储枚举", async () => {
    await seedLegacyRawCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    await seedSummaryCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, indexes: [1, 2, 3] });
    storage.local.get.mockClear();

    const inMemoryPlan: BudgetPlan = {
      ...EMPTY_SEGMENT_PLAN,
      segments: [
        { index: 1, from: 0, to: 500, chars: 9, items: [{ from: 0, to: 500, content: "内存版本内容XYZ" }] },
        { index: 2, from: 500, to: 1000, chars: 7, items: [{ from: 500, to: 1000, content: "内存第二段内容" }] }
      ]
    };
    const result = (await router.resolveFollowupContext({
      context,
      plan: inMemoryPlan,
      history,
      userPrompt: "09:00 那里讲了什么"
    }))!;

    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).toContain("内存第二段内容");
    expect(result.compressedSummaryMarkdown).not.toContain("后续内容DEF");
    expect(storage.local.get).not.toHaveBeenCalledWith(null);
  });

  it("既有会话内行为回归：成稿后追问的压缩上下文语义不变", async () => {
    const body = Array.from({ length: 210 }, (_, i) => ({
      from: i * 5,
      to: i * 5 + 5,
      content: "x".repeat(1000)
    }));
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({ body, chapters: [] });
    const result = (await router.resolveFollowupContext({
      context: { ...context, subtitleBody: body },
      plan,
      history,
      userPrompt: "再讲讲",
      loadSummaries: async () => ["小结一：事实A。"]
    }))!;
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.compressedSummaryMarkdown).toContain("小结一：事实A。");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
  });
});
