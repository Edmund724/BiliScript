// ai/followup-router.js 跨会话回退测试（原始字幕缓存跨会话接线）：
// (c) plan.segments 为空（恢复会话/新会话，内存原始段已不在）时，追问上下文回退到
//     段缓存落盘的原始字幕段（loadRawSegments 家族键），分段小结与按需检索都恢复；
//     内存 plan.segments 存在时仍完全优先内存路径（不触达段缓存枚举）；
//     两级皆空 → 维持返回 null 交回完整 Map-Reduce。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let storage;
let segCache;
let router;
let sendMessageMock;

// 内存 Map 实现的 chrome.storage.local：get 需支持 null（全量枚举）。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of want) {
        if (map.has(k)) {
          out[k] = map.get(k);
        }
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys) => {
      const want = Array.isArray(keys) ? keys : [keys];
      for (const k of want) {
        map.delete(k);
      }
    })
  };
  return { map, local };
}

// 段缓存宿主迁 SW（arch-review-2026-09/05）后，resolveFollowupContext 的缺省
// loadStoredSegments 走消息代理——测试把 chrome.runtime.sendMessage 路由到真实
// SW handler（createSegmentCacheHandler），跨会话回退走真实消息与真实键位装配。
async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  const handler = (await import("../../extension/ai/segment-cache-handler.js")).createSegmentCacheHandler();
  sendMessageMock = vi.fn((message) => {
    if (message?.type === "segment-cache") {
      return new Promise((resolve) => handler(message, null, resolve));
    }
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal("chrome", {
    storage: { local: storage.local },
    runtime: { sendMessage: sendMessageMock }
  });
  segCache = await import("../../extension/ai/segment-cache.js");
  router = await import("../../extension/ai/followup-router.js");
}

// 预置某视频 3 段的原始字幕段 + 分段小结（键位与 map-reduce 落盘一致）。
async function seedVideoCache({ bvid, cid, subtitleId, segments }) {
  for (const seg of segments) {
    await segCache.saveRawSegments(
      segCache.getRawSegmentKey({ bvid, cid, subtitleId, segmentIndex: seg.index }),
      seg.items
    );
    await segCache.saveSegmentSummary(
      segCache.getSegmentSummaryKey({ bvid, cid, subtitleId, segmentIndex: seg.index }),
      `小结${seg.index}：第${seg.index}段摘要。`
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

const storedSegments = [
  { index: 1, items: [{ from: 0, to: 500, content: "开场白内容ABC" }] },
  { index: 2, items: [{ from: 500, to: 1000, content: "后续内容DEF" }] },
  { index: 3, items: [{ from: 1000, to: 1500, content: "结尾内容GHI" }] }
];

const history = [{ role: "assistant", content: "# 视频笔记：《跨会话视频》\n完整笔记正文。" }];

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("跨会话回退：plan.segments 为空时从段缓存恢复", () => {
  it("落盘原始段恢复检索注入：时间戳命中 + 分段小结齐备 → 返回压缩上下文", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "09:00 那里讲了什么" // 540s → 命中第 2 段
    });

    expect(result).not.toBeNull();
    // 分段小结从段缓存恢复（会话内内存段已不在）
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    // 检索注入命中落盘的原始段
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
    // 压缩上下文语义不变：不含原始全文、subtitleBody 置空、视频身份保留
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
    expect(result.subtitleBody).toEqual([]);
    expect(result.bvid).toBe(context.bvid);
    expect(result.cid).toBe(context.cid);
  });

  it("段缓存缺失（同视频不同轨/未落盘）→ 维持 null 交回完整 Map-Reduce", async () => {
    await seedVideoCache({ bvid: "BV1other", cid: "1", subtitleId: "s", segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });

  it("缺 bvid/cid 的追问上下文不回退（键位无法定位）→ null", async () => {
    const result = await router.resolveFollowupContext({
      context: { ...context, bvid: "", cid: "" },
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "随便问"
    });
    expect(result).toBeNull();
  });

  it("loadStoredRawSegments：按键尾段序升序返回，from/to 由 items 首末项推导", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const restored = await segCache.loadStoredRawSegments({
      bvid: context.bvid,
      cid: context.cid,
      subtitleId: context.selectedSubtitleId
    });
    expect(restored.map((seg) => seg.index)).toEqual([1, 2, 3]);
    expect(restored[0]).toMatchObject({ index: 1, from: 0, to: 500 });
    expect(restored[2]).toMatchObject({ index: 3, from: 1000, to: 1500 });
    expect(restored[1].items).toEqual([{ from: 500, to: 1000, content: "后续内容DEF" }]);

    // 换轨不串：不同 subtitleId 枚举不到
    expect(
      await segCache.loadStoredRawSegments({ bvid: context.bvid, cid: context.cid, subtitleId: "sub-other" })
    ).toEqual([]);
  });
});

describe("08 票：追问段缓存批量与命中段传输", () => {
  it("N 段追问的小结加载一次批量往返（load-summaries），不再逐段 load-summary", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    sendMessageMock.mockClear();

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "09:00 那里讲了什么" // 540s → 命中第 2 段
    });

    expect(result).not.toBeNull();
    const cacheMessages = sendMessageMock.mock.calls.map(([m]) => m).filter((m) => m?.type === "segment-cache");
    // 小结：恰一条批量 op（3 段 1 次往返），无逐段 op
    const batchOps = cacheMessages.filter((m) => m.op === "load-summaries");
    expect(batchOps).toHaveLength(1);
    expect(batchOps[0].segmentIndexes).toEqual([1, 2, 3]);
    expect(cacheMessages.filter((m) => m.op === "load-summary")).toHaveLength(0);
    // 压缩摘要仍含全部 3 段小结（批量返回按段序对齐，行为不变）
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
  });

  it("load-stored-raw 带 prompt：非命中段 items 不回传（传输量下降），命中段保留、注入结果不变", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: "09:00 那里讲了什么" // 540s → 命中第 2 段
    });

    expect(result).not.toBeNull();
    // 定位 load-stored-raw 的响应
    const callIndex = sendMessageMock.mock.calls.findIndex(([m]) => m?.type === "segment-cache" && m?.op === "load-stored-raw");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const request = sendMessageMock.mock.calls[callIndex][0];
    expect(request.prompt).toBe("09:00 那里讲了什么");
    const response = await sendMessageMock.mock.results[callIndex].value;
    expect(response.ok).toBe(true);
    const byIndex = new Map(response.storedSegments.map((seg) => [seg.index, seg]));
    // 非命中段 items 被剥离（数 MB 整篇 → 仅命中段过线），命中段原样
    expect(byIndex.get(1).items).toEqual([]);
    expect(byIndex.get(3).items).toEqual([]);
    expect(byIndex.get(2).items).toEqual([{ from: 500, to: 1000, content: "后续内容DEF" }]);
    // 段元数据（index/from/to）保留 → 分段小结枚举与检索结果与整篇回传逐字节一致
    expect(byIndex.get(1)).toMatchObject({ index: 1, from: 0, to: 500 });
    expect(result.compressedSummaryMarkdown).toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("后续内容DEF");
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
    expect(result.compressedSummaryMarkdown).toContain("小结3：第3段摘要。");
  });

  it("空 prompt 追问：load-stored-raw 不带 prompt → 回退整篇（行为与旧一致）", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });

    const result = await router.resolveFollowupContext({
      context,
      plan: { mode: "map-reduce", segments: [] },
      history,
      userPrompt: ""
    });

    const callIndex = sendMessageMock.mock.calls.findIndex(([m]) => m?.type === "segment-cache" && m?.op === "load-stored-raw");
    const request = sendMessageMock.mock.calls[callIndex][0];
    expect(request.prompt).toBeUndefined();
    const response = await sendMessageMock.mock.results[callIndex].value;
    // 整篇回传：全部段的 items 保留
    for (const seg of response.storedSegments) {
      expect(seg.items.length).toBeGreaterThan(0);
    }
    // 无命中 → 无注入，但压缩摘要成立
    expect(result).not.toBeNull();
    expect(result.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
    expect(result.compressedSummaryMarkdown).toContain("小结1：第1段摘要。");
  });
});

describe("会话内路径不变：plan.segments 存在时完全优先内存段", () => {
  it("检索注入用内存段（内容不同可区分），且不触达段缓存的全量枚举", async () => {
    await seedVideoCache({ bvid: context.bvid, cid: context.cid, subtitleId: context.selectedSubtitleId, segments: storedSegments });
    storage.local.get.mockClear();

    const inMemoryPlan = {
      mode: "map-reduce",
      segments: [
        { index: 1, from: 0, to: 500, items: [{ from: 0, to: 500, content: "内存版本内容XYZ" }] },
        { index: 2, from: 500, to: 1000, items: [{ from: 500, to: 1000, content: "内存第二段内容" }] }
      ]
    };
    const result = await router.resolveFollowupContext({
      context,
      plan: inMemoryPlan,
      history,
      userPrompt: "09:00 那里讲了什么"
    });

    expect(result).not.toBeNull();
    // 09:00（540s）命中内存第 2 段（500-1000）
    expect(result.compressedSummaryMarkdown).toContain("内存第二段内容");
    expect(result.compressedSummaryMarkdown).not.toContain("后续内容DEF");
    // 内存段在 → 无跨会话回退（loadStoredRawSegments 的 get(null) 枚举不发生）
    expect(storage.local.get).not.toHaveBeenCalledWith(null);
  });

  it("既有会话内行为回归：成稿后追问的压缩上下文语义不变", async () => {
    const body = Array.from({ length: 210 }, (_, i) => ({
      from: i * 5,
      to: i * 5 + 5,
      content: "x".repeat(1000)
    }));
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({ body, chapters: [] });
    const result = await router.resolveFollowupContext({
      context: { ...context, subtitleBody: body },
      plan,
      history,
      userPrompt: "再讲讲",
      loadSummaries: async () => ["小结一：事实A。"]
    });
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.compressedSummaryMarkdown).toContain("小结一：事实A。");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
  });
});
