// ai/followup-context.js 追问上下文压缩测试：
// 覆盖 hasFinalNote 判定、buildCompressedSummary 组装与边界（分段小结独立上限、maxChars 截断尾部、
// verbatim 保留）、trimRecentTurns 近 N 轮封顶，以及 resolveFollowupContext 组装纯压缩摘要。

import { describe, expect, it, vi } from "vitest";
import {
  RECENT_TURNS_DEFAULT,
  SEGMENT_SUMMARIES_MAX_CHARS,
  hasFinalNote,
  trimRecentTurns,
  buildCompressedSummary,
  resolveFollowupContext
} from "../../extension/ai/followup-context.js";

describe("hasFinalNote：首轮 / 尚未成稿判定", () => {
  it("空入参 → false", () => {
    expect(hasFinalNote()).toBe(false);
    expect(hasFinalNote({})).toBe(false);
  });

  it("只有 note 或只有 segmentSummaries → false（缺一即未成稿）", () => {
    expect(hasFinalNote({ note: "成稿笔记" })).toBe(false);
    expect(hasFinalNote({ segmentSummaries: ["小结一"] })).toBe(false);
  });

  it("note 为空白串 / summaries 空数组 / 非数组 → false", () => {
    expect(hasFinalNote({ note: "   ", segmentSummaries: ["小结一"] })).toBe(false);
    expect(hasFinalNote({ note: "笔记", segmentSummaries: [] })).toBe(false);
    expect(hasFinalNote({ note: "笔记", segmentSummaries: "小结一" as unknown as unknown[] })).toBe(false);
  });

  it("note 非空 + 非空 summaries → true（已「成稿」）", () => {
    expect(hasFinalNote({ note: "笔记", segmentSummaries: ["小结一"] })).toBe(true);
  });
});

describe("buildCompressedSummary：组装与边界", () => {
  it("空入参 / 空小结与空笔记 → 空串", () => {
    expect(buildCompressedSummary()).toBe("");
    expect(buildCompressedSummary({ segmentSummaries: [], note: "" })).toBe("");
  });

  it("只有小结 → 含「## 分段小结」与各小结小标题+正文；不含成稿笔记节", () => {
    const out = buildCompressedSummary({ segmentSummaries: ["小结A内容", "小结B内容"] });
    expect(out).toContain("## 分段小结");
    expect(out).toContain("### 片段 1\n小结A内容");
    expect(out).toContain("### 片段 2\n小结B内容");
    expect(out).not.toContain("## 成稿笔记");
  });

  it("只有笔记 → 只含成稿笔记节，保留笔记原文", () => {
    const out = buildCompressedSummary({ note: "笔记原文XYZ" });
    expect(out).toContain("## 成稿笔记\n\n笔记原文XYZ");
    expect(out).not.toContain("## 分段小结");
  });

  it("小结 + 笔记齐备 → 分段小结在前、成稿笔记在后，均保留原文（verbatim）", () => {
    const note = "成稿笔记：第一段要点。\n**加粗要点**、`代码`、特殊符号 ①②③。";
    const summaries = ["小结一：事实A（时间点 01:09:15）。", "小结二：\n多行内容行二。"];
    const out = buildCompressedSummary({ segmentSummaries: summaries, note });
    expect(out.indexOf("## 分段小结")).toBeLessThan(out.indexOf("## 成稿笔记"));
    expect(out).toContain(note);
    expect(out).toContain(summaries[0]);
    expect(out).toContain(summaries[1]);
  });

  it("maxChars 截断尾部：结果 ≤ maxChars、含截断标记、保留头部", () => {
    const note = "N".repeat(1000);
    const out = buildCompressedSummary({ note, maxChars: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("已截断尾部");
    expect(out.startsWith("## 成稿笔记\n\n")).toBe(true);
    expect(out).not.toContain(note);
  });

  it("maxChars 极小（≤ 截断标记长度）时仍不超限", () => {
    const out = buildCompressedSummary({ note: "x".repeat(500), maxChars: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("分段小结独立上限：小结部分 ≤ SEGMENT_SUMMARIES_MAX_CHARS，笔记不随其截断", () => {
    const note = "N".repeat(200);
    const summaries = Array.from({ length: 10 }, () => "S".repeat(8000));
    const out = buildCompressedSummary({ segmentSummaries: summaries, note });
    const summariesEnd = out.indexOf("## 成稿笔记");
    const summariesSpan = summariesEnd - out.indexOf("## 分段小结");
    expect(summariesSpan).toBeLessThanOrEqual(SEGMENT_SUMMARIES_MAX_CHARS + 100);
    expect(out).toContain(note);
  });

  it("非数组 segmentSummaries 容错为空", () => {
    expect(buildCompressedSummary({ segmentSummaries: "小结一" as unknown as unknown[] })).toBe("");
    expect(buildCompressedSummary({ segmentSummaries: null as unknown as unknown[], note: "笔记" })).toContain("## 成稿笔记");
  });
});

describe("trimRecentTurns：近 N 轮 verbatim 封顶", () => {
  it("只保留最近 turns 轮（每轮 user+assistant 两条），超长历史被裁剪", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第${i}条`
    }));
    const trimmed = trimRecentTurns(history, 3);
    expect(trimmed).toHaveLength(6);
    expect(trimmed[0]).toEqual({ role: "user", content: "第14条" });
    expect(trimmed[trimmed.length - 1]).toEqual({ role: "assistant", content: "第19条" });
  });

  it("缺省 turns 用 RECENT_TURNS_DEFAULT；历史不足 N 轮时原样返回", () => {
    const short = [
      { role: "user", content: "问" },
      { role: "assistant", content: "答" }
    ];
    expect(trimRecentTurns(short)).toEqual(short);
    expect(trimRecentTurns(short, RECENT_TURNS_DEFAULT)).toEqual(short);
    expect(RECENT_TURNS_DEFAULT).toBe(6);
  });

  it("非法 turns / 非数组历史 → 安全回落", () => {
    const history = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" }
    ];
    expect(trimRecentTurns(history, 0)).toEqual(history);
    expect(trimRecentTurns(history, "x")).toEqual(history);
    expect(trimRecentTurns(null)).toEqual([]);
  });
});

describe("resolveFollowupContext：纯压缩摘要组装", () => {
  const history = [{ role: "assistant", content: "成稿笔记正文。" }];
  const basePlan = {
    totalChars: 210000,
    estimatedTokens: 210000,
    mode: "map-reduce" as const,
    estimatedCalls: 5,
    needsReduce: false,
    reduceGroupInputChars: 100000
  };

  it("plan.segments 为空时直接调用 loadStoredSummaries 枚举小结并组装纯压缩摘要", async () => {
    const loadStoredSummaries = vi.fn(async () => ["小结1", "小结2"]);

    const result = await resolveFollowupContext({
      context: { title: "测试", bvid: "BV1h", cid: "1" },
      plan: { ...basePlan, segments: [] },
      history,
      loadStoredSummaries
    });

    expect(loadStoredSummaries).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.compressedSummaryMarkdown).toContain("## 分段小结");
    expect(result?.compressedSummaryMarkdown).toContain("小结1");
    expect(result?.compressedSummaryMarkdown).toContain("## 成稿笔记");
    expect(result?.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
  });

  it("plan.segments 存在时经 loadSummaries 批量读取，产出与原始字幕长度无关的纯压缩摘要", async () => {
    const result = await resolveFollowupContext({
      context: {
        title: "测试",
        bvid: "BV1h",
        cid: "1",
        subtitleBody: [{ from: 0, to: 10, content: "原始全文独有标记 __UNIQUE_RAW__" }]
      },
      plan: {
        ...basePlan,
        segments: [{ index: 1, from: 0, to: 100, chars: 10, items: [{ from: 0, to: 10, content: "原始段命中" }] }]
      },
      history,
      loadSummaries: async () => ["小结1"]
    });

    expect(result?.subtitleBody).toEqual([]);
    expect(result?.compressedSummaryMarkdown).toContain("小结1");
    expect(result?.compressedSummaryMarkdown).not.toContain("## 相关原始字幕段");
    expect(result?.compressedSummaryMarkdown).not.toContain("原始段命中");
    expect(result?.compressedSummaryMarkdown).not.toContain("__UNIQUE_RAW__");
  });
});
