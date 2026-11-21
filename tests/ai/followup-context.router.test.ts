import { describe, expect, it, vi } from "vitest";
import {
  lastAssistantContent,
  loadSegmentSummaries,
  resolveFollowupContext
} from "../../extension/ai/followup-context.js";
import { buildBudgetPlan } from "../../extension/ai/budgeter.js";

const body = Array.from({ length: 210 }, (_, i) => ({
  from: i * 5,
  to: i * 5 + 5,
  content: "x".repeat(1000)
}));
const plan = buildBudgetPlan({ body, chapters: [] });

const context = {
  title: "测试视频",
  bvid: "BV1test",
  cid: "123",
  selectedSubtitleId: "sub-1",
  subtitleLang: "zh",
  chapters: [],
  subtitleBody: body
};

const summariesFixture = ["小结一：事实A。", "小结二：事实B。", "小结三：事实C。"];

describe("lastAssistantContent", () => {
  it("取最近一条非空 assistant 正文", () => {
    expect(lastAssistantContent([
      { role: "user", content: "问" },
      { role: "assistant", content: "  第一条回答  " },
      { role: "user", content: "再问" },
      { role: "assistant", content: "最后一条回答" }
    ])).toBe("最后一条回答");
  });

  it("无 assistant / 全空 → 空串", () => {
    expect(lastAssistantContent([])).toBe("");
    expect(lastAssistantContent([{ role: "user", content: "仅提问" }])).toBe("");
    expect(lastAssistantContent([{ role: "assistant", content: "   " }])).toBe("");
  });
});

describe("loadSegmentSummaries", () => {
  it("按段序批量加载非空小结，注入 loader 生效（一次往返、null/空被过滤、段序保持）", async () => {
    let seenIndexes: Array<number | string> | undefined;
    const loader = vi.fn(async (input: { segmentIndexes?: Array<number | string> }) => {
      seenIndexes = input.segmentIndexes;
      return ["小结一", null, "   ", "小结四", "小结五"];
    });
    const summaries = await loadSegmentSummaries({ context, plan, loadSummaries: loader });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(seenIndexes).toEqual([1, 2, 3, 4, 5]);
    expect(summaries).toEqual(["小结一", "小结四", "小结五"]);
  });

  it("缺省 loader 走段缓存消息代理（无 SW 回路 → 未命中 → 空）", async () => {
    const summaries = await loadSegmentSummaries({ context, plan });
    expect(summaries).toEqual([]);
  });
});

describe("resolveFollowupContext", () => {
  it("≤200k（mode=single）→ null", async () => {
    const singlePlan = buildBudgetPlan({ body: [{ from: 0, to: 5, content: "短字幕" }], chapters: [] });
    const result = await resolveFollowupContext({
      context,
      plan: singlePlan,
      history: [{ role: "assistant", content: "笔记" }],
      loadSummaries: async () => summariesFixture
    });
    expect(result).toBeNull();
  });

  it("首轮（history 空）→ null", async () => {
    const result = await resolveFollowupContext({
      context,
      plan,
      history: [],
      loadSummaries: async () => summariesFixture
    });
    expect(result).toBeNull();
  });

  it("尚未成稿（无分段小结）→ null", async () => {
    const result = await resolveFollowupContext({
      context,
      plan,
      history: [{ role: "assistant", content: "笔记" }],
      loadSummaries: async () => []
    });
    expect(result).toBeNull();
  });

  it("成稿后追问 → 纯压缩上下文（含笔记+小结、不含原始全文、subtitleBody 置空）", async () => {
    const result = (await resolveFollowupContext({
      context,
      plan,
      history: [{ role: "assistant", content: "# 视频笔记：《测试视频》\n完整笔记正文。" }],
      loadSummaries: async () => summariesFixture
    }))!;
    expect(result).not.toBeNull();
    expect(result.subtitleBody).toEqual([]);
    expect(result.compressedSummaryMarkdown).toContain("完整笔记正文。");
    expect(result.compressedSummaryMarkdown).toContain("小结一：事实A。");
    expect(result.compressedSummaryMarkdown).not.toContain("__RAW_FULL__");
    expect(result.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
  });
});
