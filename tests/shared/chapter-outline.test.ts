// shared/chapter-outline.ts 章节来源叶子测试（概览分章票 03 决议）：
// 分章来源优先级（简介/评论时间轴 > 官方章节 > AI 自由分章）、官方章节归一，
// 以及管线与 reader 概览 tab 共用的「签名侧章节字段」（同构口径）。

import { describe, expect, it } from "vitest";
import {
  hotCommentsText,
  manuscriptChapterOutline,
  parseChapterOutline,
  resolveChapterSource,
  splitOutlineChapterTitle
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

// 简介/评论接口正文常带 HTML 字符实体：标题解析时还原成真实字符（下游渲染
// 统一 escapeHtml，解码不引入 XSS 面）。
describe("parseChapterOutline HTML 实体解码", () => {
  it("常见命名与数字实体解码为明文字符", () => {
    expect(
      parseChapterOutline(
        [
          '00:00 Q&amp;A&quot;开场&#39;',
          "01:00 语义化&lt;标签&gt;",
          "02:00 &quot;尾&quot;"
        ].join("\n")
      ).map((item) => item.title)
    ).toEqual(['Q&A"开场\'', "语义化<标签>", '"尾"']);
  });

  it("十六进制数字实体与 &apos; 同样解码", () => {
    expect(
      parseChapterOutline(["00:00 &#x22;十六进制&#x27;", "01:00 &apos;撇号&apos;"].join("\n")).map(
        (item) => item.title
      )
    ).toEqual(['"十六进制\'', "'撇号'"]);
  });

  it("&nbsp; 解码为空格；未识别实体原样保留", () => {
    const titles = parseChapterOutline(["00:00 主标&nbsp;题", "01:00 未知&foo;实体"].join("\n")).map(
      (item) => item.title
    );
    expect(titles[0]).toBe("主标 题");
    expect(titles[1]).toBe("未知&foo;实体");
  });

  it("实体解码后的标题进 resolveChapterSource 目录（全链）", () => {
    const source = resolveChapterSource('00:00 &quot;引号&quot;开场\n03:00 &amp;符号', [], []);
    expect(source.kind).toBe("outline");
    expect(source.chapters.map((item) => item.title)).toEqual(['"引号"开场', "&符号"]);
  });
});

describe("splitOutlineChapterTitle 主副标题拆分", () => {
  it("全角/半角冒号与成对破折号都触发拆分", () => {
    expect(splitOutlineChapterTitle("环境准备：安装与配置")).toEqual({ primary: "环境准备", secondary: "安装与配置" });
    expect(splitOutlineChapterTitle("Part 1: Setup")).toEqual({ primary: "Part 1", secondary: "Setup" });
    expect(splitOutlineChapterTitle("常见问题——答疑")).toEqual({ primary: "常见问题", secondary: "答疑" });
  });

  it("多种分隔符同时出现：按出现位置取最早者", () => {
    expect(splitOutlineChapterTitle("A: B——C")).toEqual({ primary: "A", secondary: "B——C" });
    expect(splitOutlineChapterTitle("A——B: C")).toEqual({ primary: "A", secondary: "B: C" });
  });

  it("单个未成对的 — 不算分隔符", () => {
    expect(splitOutlineChapterTitle("序章 — 引子")).toBeNull();
    expect(splitOutlineChapterTitle("A—B：C")).toEqual({ primary: "A—B", secondary: "C" });
  });

  it("不含分隔符、空标题或分隔符任一侧为空：不拆分（返回 null）", () => {
    expect(splitOutlineChapterTitle("评论区正题")).toBeNull();
    expect(splitOutlineChapterTitle("")).toBeNull();
    expect(splitOutlineChapterTitle("：只有副标题")).toBeNull();
    expect(splitOutlineChapterTitle("只有主标题：")).toBeNull();
  });

  it("分隔符两侧空白被 trim", () => {
    expect(splitOutlineChapterTitle("主标题 ： 次级说明")).toEqual({ primary: "主标题", secondary: "次级说明" });
  });
});

// 楼中楼续篇并入（F4）：置顶目录的第二段是楼中楼，续篇正文挂在顶层评论的
// subMessages 上，拼进目录解析文本；聊天展示只用 message（ai/context.ts）。
describe("hotCommentsText 楼中楼续篇并入", () => {
  const withSub = {
    uname: "UP",
    like: 520,
    message: "00:00 开场\n05:12 正题",
    subMessages: ["25:00 核心原则\n30:00 尾声"]
  };

  it("subMessages 续篇正文拼在顶层 message 之后", () => {
    expect(hotCommentsText([withSub, { uname: "观众", like: 1, message: "讲得好" }])).toBe(
      "00:00 开场\n05:12 正题\n25:00 核心原则\n30:00 尾声\n讲得好"
    );
  });

  it("无 subMessages 的评论：文本与旧口径一致", () => {
    expect(hotCommentsText([{ uname: "观众", like: 1, message: "讲得好" }])).toBe("讲得好");
    expect(hotCommentsText([{ uname: "观众", like: 1, message: "讲得好", subMessages: [] }])).toBe("讲得好");
  });

  it("目录解析能识别续篇里的章节行（resolveChapterSource 全链）", () => {
    const source = resolveChapterSource("普通简介，无时间轴", [withSub], []);
    expect(source.kind).toBe("outline");
    expect(source.chapters).toEqual([
      { seconds: 0, title: "开场" },
      { seconds: 5 * 60 + 12, title: "正题" },
      { seconds: 25 * 60, title: "核心原则" },
      { seconds: 30 * 60, title: "尾声" }
    ]);
  });
});
