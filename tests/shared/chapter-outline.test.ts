// shared/chapter-outline.ts 章节来源叶子测试（概览分章票 03 决议）：
// 分章来源优先级（简介/评论时间轴 > 官方章节 > AI 自由分章）、官方章节归一，
// 以及管线与 reader 概览 tab 共用的「签名侧章节字段」（同构口径）。

import { describe, expect, it } from "vitest";
import {
  manuscriptChapterOutline,
  parseChapterOutline,
  resolveChapterSource
} from "../../extension/shared/chapter-outline.js";

const MANUSCRIPT = [
  { from: 0, to: 100, title: "官方开场" },
  { from: 100, to: 300, title: "官方正题" }
];

describe("resolveChapterSource 分章来源优先级", () => {
  it("简介时间轴 ≥2 条：时间轴优先，官方章节让位（签名模式位置空）", () => {
    const source = resolveChapterSource("时间轴：\n00:00 评论区开场\n01:40 评论区正题", [], MANUSCRIPT);
    expect(source.kind).toBe("outline");
    expect(source.chapters).toEqual([
      { seconds: 0, title: "评论区开场" },
      { seconds: 100, title: "评论区正题" }
    ]);
    expect(source.signatureChapters).toEqual([]);
  });

  it("评论时间轴同样参与（与简介合并解析）", () => {
    const source = resolveChapterSource("普通简介，无时间轴", [{ uname: "UP", like: 9, message: "00:00 甲\n02:00 乙" }], []);
    expect(source.kind).toBe("outline");
    expect(source.chapters.map((item) => item.title)).toEqual(["甲", "乙"]);
  });

  it("无时间轴但有官方章节：官方章节作给定章节，原始章节数组进签名模式位", () => {
    const source = resolveChapterSource("普通简介，无时间轴", [], MANUSCRIPT);
    expect(source.kind).toBe("manuscript");
    expect(source.chapters).toEqual([
      { seconds: 0, title: "官方开场", to: 100 },
      { seconds: 100, title: "官方正题", to: 300 }
    ]);
    expect(source.signatureChapters).toBe(MANUSCRIPT); // 同一引用（模式位口径）
  });

  it("两者都无：auto，给定章节与签名模式位都为空", () => {
    expect(resolveChapterSource("普通简介", [], [])).toEqual({ kind: "auto", chapters: [], signatureChapters: [] });
  });

  it("单条时间戳行不构成目录（回落官方章节）", () => {
    expect(resolveChapterSource("00:00 只有一条", [], MANUSCRIPT).kind).toBe("manuscript");
  });
});

describe("manuscriptChapterOutline 官方章节归一", () => {
  it("剔空标题/非法 from、按 from 升序、同 from 去重，保留 to", () => {
    expect(
      manuscriptChapterOutline([
        { from: 100, to: 300, title: " 官方正题 " },
        { from: 0, to: 100, title: "官方开场" },
        { from: 0, to: 50, title: "同秒重复" },
        { from: 400, to: 500, title: "   " },
        { title: "无时间戳" }
      ])
    ).toEqual([
      { seconds: 0, title: "官方开场", to: 100 },
      { seconds: 100, title: "官方正题", to: 300 }
    ]);
  });
});

describe("parseChapterOutline 上限可参数化", () => {
  const lines = ["00:00 章0", "01:00 章1", "02:00 章2", "03:00 章3"].join("\n");

  it("默认上限 100；显式 limit 生效", () => {
    expect(parseChapterOutline(lines)).toHaveLength(4);
    expect(parseChapterOutline(lines, 2)).toHaveLength(2);
  });
});
