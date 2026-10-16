// ai/chapter-plan.ts 分章计划单源的测试（arch-review-2026-09 候选 2）：三个来源
// （auto / outline / manuscript）各自的产物字段（systemPrompt 三选一、titlesOnly、
// promptVars.chapterOutline、budgetChapters）、末章界的单源（graft 在构造时闭包捕获
// endSeconds，调用方拿不到第二个 end 值）、越界过滤口径（givenChapters 按
// `seconds <= endSeconds` 过滤，budgetChapters 冻结在未过滤的 signatureChapters 上——
// 这是刻意保留的现状语义，切段输入口径不变）与 manuscript 缺章打标（missingSummary，
// 含缓存装载路径的 flagMissingChapterSummaries 补标）。

import { describe, expect, it } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  GIVEN_CHAPTERS_SYSTEM_PROMPT,
  OUTLINE_QUOTES_SYSTEM_PROMPT
} from "../../extension/ai/analysis-prompts.js";
import { resolveChapterPlan, flagMissingChapterSummaries } from "../../extension/ai/chapter-plan.js";
import { resolveChapterSource } from "../../extension/shared/chapter-outline.js";

// 与 analysis.test.ts 同源的素材：简介/评论时间轴（3 条）与 B 站官方章节（2 条）。
const COMMENT_TIMELINE = "00:00 评论区开场\n01:40 评论区正题\n04:20 评论区收尾";
const MANUSCRIPT_CHAPTERS = [
  { from: 0, to: 100, title: "官方开场" },
  { from: 100, to: 300, title: "官方正题" }
];

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    title: "测试视频",
    author: "UP 主甲",
    videoDescription: "简介原文",
    videoDuration: 300,
    ...overrides
  };
}

function modelChapter(from: number, summary: string) {
  return { from, to: from + 5, title: `模型章 ${from}`, summary };
}

describe("resolveChapterPlan 来源 × 路径矩阵", () => {
  it("无给定章节（auto）：自由分章提示词、无目录、无预算切段章、graft 原样返回", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, undefined);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext(),
      body: makeSubtitleBody(50000)
    });

    expect(plan.kind).toBe("auto");
    expect(plan.hasGivenChapters).toBe(false);
    expect(plan.titlesOnly).toBe(false);
    expect(plan.givenChapters).toEqual([]);
    expect(plan.systemPrompt).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(plan.promptVars).toEqual({
      title: "测试视频",
      ownerName: "UP 主甲",
      videoDescription: "简介原文",
      chapterOutline: [],
      titlesOnly: false
    });
    expect(plan.budgetChapters).toEqual([]);

    const modelChapters = [modelChapter(5, "甲")];
    expect(plan.graft(modelChapters)).toBe(modelChapters);
  });

  it("outline 时间轴：只挑金句提示词、titlesOnly、目录进 promptVars、时间轴不参与预算切段", () => {
    const chapterSource = resolveChapterSource(COMMENT_TIMELINE, undefined, MANUSCRIPT_CHAPTERS);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext(),
      body: makeSubtitleBody(50000)
    });

    expect(plan.kind).toBe("outline");
    expect(plan.hasGivenChapters).toBe(true);
    expect(plan.titlesOnly).toBe(true);
    expect(plan.givenChapters.map((chapter) => chapter.seconds)).toEqual([0, 100, 260]);
    expect(plan.systemPrompt).toBe(OUTLINE_QUOTES_SYSTEM_PROMPT);
    expect(plan.promptVars).toEqual({
      title: "测试视频",
      ownerName: "UP 主甲",
      videoDescription: "简介原文",
      chapterOutline: plan.givenChapters,
      titlesOnly: true
    });
    // 时间轴可能每几十秒一条，进切段会把调用数按目录条数放大——只决定章节与提示词。
    expect(plan.budgetChapters).toEqual([]);

    // graft：标题与边界照抄目录，简介一律空串（即使模型硬写简介也丢弃）。
    const grafted = plan.graft([modelChapter(0, "不该出现的简介")]);
    expect(grafted).toEqual([
      { from: 0, to: 100, title: "评论区开场", summary: "" },
      { from: 100, to: 260, title: "评论区正题", summary: "" },
      { from: 260, to: 300, title: "评论区收尾", summary: "" }
    ]);
  });

  it("manuscript 官方章节：补大意提示词、目录进 promptVars、signatureChapters 重映射进预算切段", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, MANUSCRIPT_CHAPTERS);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext(),
      body: makeSubtitleBody(50000)
    });

    expect(plan.kind).toBe("manuscript");
    expect(plan.hasGivenChapters).toBe(true);
    expect(plan.titlesOnly).toBe(false);
    expect(plan.systemPrompt).toBe(GIVEN_CHAPTERS_SYSTEM_PROMPT);
    expect(plan.promptVars).toEqual({
      title: "测试视频",
      ownerName: "UP 主甲",
      videoDescription: "简介原文",
      chapterOutline: plan.givenChapters,
      titlesOnly: false
    });
    expect(plan.budgetChapters).toEqual([
      { from: 0, title: "官方开场" },
      { from: 100, title: "官方正题" }
    ]);

    // graft：标题与边界照抄稿件，模型只贡献 summary（按 from 最近邻一对一）；
    // 认领不到的章留空串并打 missingSummary 标记（UI 显示「本章概括缺失」）。
    expect(plan.graft([modelChapter(3, "漂移摘要")])).toEqual([
      { from: 0, to: 100, title: "官方开场", summary: "漂移摘要" },
      { from: 100, to: 300, title: "官方正题", summary: "", missingSummary: true }
    ]);
  });

  it("给定章节全被越界过滤：hasGivenChapters 假 → 回落自由分章提示词（kind 仍是 outline）", () => {
    const chapterSource = resolveChapterSource("10:00 越界甲\n20:00 越界乙", undefined, undefined);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      body: makeSubtitleBody(50000) // 字幕覆盖 0..250s
    });

    expect(plan.kind).toBe("outline");
    expect(plan.givenChapters).toEqual([]);
    expect(plan.hasGivenChapters).toBe(false);
    expect(plan.systemPrompt).toBe(ANALYSIS_SYSTEM_PROMPT);
    const modelChapters = [modelChapter(5, "甲")];
    expect(plan.graft(modelChapters)).toBe(modelChapters);
  });
});

describe("resolveChapterPlan 越界过滤与预算切段的双口径", () => {
  it("越界条目：givenChapters 与 promptVars 只收 seconds <= endSeconds 的条目", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, [
      ...MANUSCRIPT_CHAPTERS,
      { from: 600, to: 900, title: "越界章" }
    ]);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      body: makeSubtitleBody(50000) // 末条 to = 250s，endSeconds = max(300, 250) = 300
    });

    expect(plan.givenChapters.map((chapter) => chapter.title)).toEqual(["官方开场", "官方正题"]);
    expect(plan.promptVars.chapterOutline).toBe(plan.givenChapters);
    expect(plan.graft([])).toEqual([
      { from: 0, to: 100, title: "官方开场", summary: "", missingSummary: true },
      { from: 100, to: 300, title: "官方正题", summary: "", missingSummary: true }
    ]);
  });

  it("budgetChapters 行为冻结：manuscript 用**未过滤**的 signatureChapters 重映射 {from, title}", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, [
      ...MANUSCRIPT_CHAPTERS,
      { from: 600, to: 900, title: "越界章" }
    ]);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      body: makeSubtitleBody(50000)
    });

    // 刻意保留现状：切段输入不跟着给定章节的越界过滤走（口径不变）。
    expect(plan.budgetChapters).toEqual([
      { from: 0, title: "官方开场" },
      { from: 100, title: "官方正题" },
      { from: 600, title: "越界章" }
    ]);
  });
});

describe("resolveChapterPlan 末章界单源", () => {
  it("endSeconds = max(视频时长, 字幕末条时间戳)，graft 的末章 to 用它", () => {
    // 官方章节不带 to（末章落界才需要兜底）。
    const chapterSource = resolveChapterSource(undefined, undefined, [
      { from: 0, title: "无尾章甲" },
      { from: 100, title: "无尾章乙" }
    ]);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      // 字幕末条 to = 500s > 视频时长 300：末章界取字幕末条。
      body: [
        { from: 0, to: 5, content: "x" },
        { from: 495, to: 500, content: "y" }
      ]
    });

    expect(plan.graft([]).at(-1)).toEqual({ from: 100, to: 500, title: "无尾章乙", summary: "", missingSummary: true });
  });

  it("graft 闭包捕获构造时的 endSeconds：调用方拿不到第二个 end 值", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, MANUSCRIPT_CHAPTERS);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      body: makeSubtitleBody(50000)
    });

    // 单参数闭包：契约上没有第二个 end 入参。
    expect(plan.graft.length).toBe(1);
    expect(Object.keys(plan)).not.toContain("endSeconds");

    // 同一计划两次 graft（模型给的时间戳不同）末章 to 恒为构造时的那一个值。
    const first = plan.graft([modelChapter(0, "甲"), modelChapter(100, "乙")]);
    const second = plan.graft([modelChapter(0, "丙")]);
    expect(first.at(-1)?.to).toBe(300);
    expect(second.at(-1)?.to).toBe(300);
  });

  it("字幕越界条目不改变末章界（过滤只作用于给定章节清单）", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, MANUSCRIPT_CHAPTERS);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext({ videoDuration: 300 }),
      body: makeSubtitleBody(50000)
    });
    // 模型给一个远超 endSeconds 的时间戳：graft 仍按给定清单出章，末章 to 不受影响。
    expect(plan.graft([{ from: 9999, to: 10000, title: "越界模型章", summary: "越界摘要" }])).toEqual([
      { from: 0, to: 100, title: "官方开场", summary: "越界摘要" },
      { from: 100, to: 300, title: "官方正题", summary: "", missingSummary: true }
    ]);
  });
});

describe("missingSummary 缺章打标", () => {
  it("manuscript：模型少返回一章时缺口落在清单尾部，认领落空与空串 summary 都打标", () => {
    const chapterSource = resolveChapterSource(undefined, undefined, [
      { from: 0, to: 100, title: "甲" },
      { from: 100, to: 200, title: "乙" },
      { from: 200, to: 300, title: "丙" }
    ]);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext(),
      body: makeSubtitleBody(50000)
    });

    // 模型只出两章：第一章正常，第二章认领到的 summary 是空串，第三章无人认领。
    const grafted = plan.graft([modelChapter(0, "甲概括"), modelChapter(100, "")]);
    expect(grafted.map((chapter) => chapter.missingSummary ?? false)).toEqual([false, true, true]);
  });

  it("outline：titlesOnly 的空串是设计内行为，一律不打标", () => {
    const chapterSource = resolveChapterSource(COMMENT_TIMELINE, undefined, undefined);
    const plan = resolveChapterPlan({
      chapterSource,
      context: makeContext(),
      body: makeSubtitleBody(50000)
    });

    const grafted = plan.graft([]);
    expect(grafted.length).toBeGreaterThan(0);
    expect(grafted.every((chapter) => chapter.summary === "" && chapter.missingSummary === undefined)).toBe(true);
  });

  it("flagMissingChapterSummaries：给旧缓存产物补标——空串打标、有概括的章原样保留", () => {
    const withSummary = { from: 0, to: 100, title: "甲", summary: "已有概括" };
    const flagged = flagMissingChapterSummaries({
      chapters: [withSummary, { from: 100, to: 200, title: "乙", summary: "" }],
      quotes: []
    });

    expect(flagged.chapters[0]).toBe(withSummary);
    expect(flagged.chapters[1]).toEqual({ from: 100, to: 200, title: "乙", summary: "", missingSummary: true });
  });
});
