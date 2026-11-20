// tests/notes/template.test.ts
// 模板化笔记导出（变量渲染、条件段落清理、Obsidian URI 及超长剪贴板回退、高亮笔记存储）。

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildNoteTemplateVariables,
  buildObsidianUri,
  DEFAULT_NOTE_TEMPLATE,
  renderNoteTemplate
} from "../../extension/notes/template.js";
import {
  addVideoHighlight,
  loadVideoHighlights,
  removeSubtitleIndexHighlights,
  removeVideoHighlight,
  resetHighlightMemoryStoreForTests
} from "../../extension/notes/highlights-store.js";

describe("notes/template 渲染器", () => {
  it("渲染默认模板并正确填充元信息、摘要、章节、金句与划词笔记", () => {
    const vars = buildNoteTemplateVariables({
      meta: {
        title: "深入理解注意力机制",
        bvid: "BV1note00001",
        author: "技术UP主",
        url: "https://www.bilibili.com/video/BV1note00001/",
        uploadDate: "2026-11-20",
        description: "原始简介"
      },
      body: [
        { from: 5, to: 10, content: "大家好今天讲注意力机制" },
        { from: 75, to: 82, content: "核心是 Q K V 点积缩放" }
      ],
      overview: {
        summary: "本视频系统讲解自注意力计算与复杂度优化。",
        chapters: [
          { from: 0, to: 60, title: "动机引入", summary: "为什么 RNN 难以并行" },
          { from: 60, to: 120, title: "缩放点积", summary: "除以根号 d_k 稳定梯度" }
        ],
        quotes: [
          { from: 75, content: "注意力本质上是可微的软寻址。" }
        ]
      },
      highlights: [
        { id: "h1", text: "核心是 Q K V 点积缩放", from: 75, source: "subtitle", subtitleIndex: 1, createdAt: 1000 },
        { id: "h2", text: "自注意力计算与复杂度优化", from: null, source: "overview", createdAt: 2000 }
      ]
    });

    const md = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, vars);
    expect(md).toContain('title: "深入理解注意力机制"');
    expect(md).toContain('bvid: "BV1note00001"');
    expect(md).toContain('author: "技术UP主"');
    expect(md).toContain("https://www.bilibili.com/video/BV1note00001/");
    expect(md).toContain("本视频系统讲解自注意力计算与复杂度优化。");
    expect(md).toContain("- `0:00` **动机引入**：为什么 RNN 难以并行");
    expect(md).toContain("> `1:15` 注意力本质上是可微的软寻址。");
    expect(md).toContain("- `1:15` 核心是 Q K V 点积缩放");
    expect(md).toContain("- 自注意力计算与复杂度优化");
  });

  it("支持用户自定义模板与 {{#if var}} 空段落自动移除", () => {
    const custom = [
      "# {{title}} ({{bvid}})",
      "{{#if notes}}\n## 笔记\n{{notes}}\n{{/if}}",
      "{{#if quotes}}\n## 金句\n{{quotes}}\n{{/if}}",
      "{{subtitles}}"
    ].join("\n\n");

    const vars = buildNoteTemplateVariables({
      meta: { title: "测试标题", bvid: "BV1empty001" },
      body: [{ from: 12, to: 15, content: "这是一条字幕" }],
      settings: { includeTimestampInBody: true },
      highlights: []
    });

    const rendered = renderNoteTemplate(custom, vars);
    expect(rendered).toContain("# 测试标题 (BV1empty001)");
    expect(rendered).not.toContain("## 笔记");
    expect(rendered).not.toContain("## 金句");
    expect(rendered).toContain("`0:12` 这是一条字幕");
  });
});

describe("buildObsidianUri", () => {
  it("常规长度直接构造带 content 参数的 obsidian://new URI", () => {
    const res = buildObsidianUri({
      vault: "MyVault",
      folder: "Clippings/Bilibili",
      fileName: "视频笔记.md",
      content: "# 标题\n正文"
    });
    expect(res.usedClipboardFallback).toBe(false);
    expect(res.uri).toContain("obsidian://new?");
    expect(res.uri).toContain("vault=MyVault");
    expect(res.uri).toContain(`file=${encodeURIComponent("Clippings/Bilibili/视频笔记")}`);
    expect(res.uri).toContain(`content=${encodeURIComponent("# 标题\n正文")}`);
  });

  it("编码超限时自动回退到 clipboard=true 模式防协议截断", () => {
    const longContent = "这是一段很长的笔记内容。".repeat(400);
    const res = buildObsidianUri({
      vault: "Knowledge",
      fileName: "长笔记",
      content: longContent,
      maxUriLength: 500
    });
    expect(res.usedClipboardFallback).toBe(true);
    expect(res.uri).toContain("obsidian://new?vault=Knowledge&name=");
    expect(res.uri).toContain("clipboard=true");
    expect(res.uri).not.toContain("content=");
  });
});

describe("highlights-store 高亮笔记持久化", () => {
  beforeEach(() => {
    resetHighlightMemoryStoreForTests();
  });

  it("支持按视频追加、同句去重、按 id 与按 subtitleIndex 移除", async () => {
    const first = await addVideoHighlight("BV1hl001", {
      text: "第一条高亮",
      from: 42,
      source: "subtitle",
      subtitleIndex: 3
    });
    expect(first.added).toBe(true);
    expect(first.items).toHaveLength(1);

    // 重复添加同一文本与时间戳不会重复落盘
    const dup = await addVideoHighlight("BV1hl001", {
      text: "第一条高亮",
      from: 42.1,
      source: "subtitle",
      subtitleIndex: 3
    });
    expect(dup.added).toBe(false);
    expect(dup.items).toHaveLength(1);

    const second = await addVideoHighlight("BV1hl001", {
      text: "简介里的重点",
      from: null,
      source: "overview"
    });
    expect(second.added).toBe(true);
    expect(await loadVideoHighlights("BV1hl001")).toHaveLength(2);

    const removedSub = await removeSubtitleIndexHighlights("BV1hl001", 3);
    expect(removedSub.removedCount).toBe(1);
    expect(removedSub.items).toHaveLength(1);
    expect(removedSub.items[0].source).toBe("overview");

    const removedById = await removeVideoHighlight("BV1hl001", second.item!.id);
    expect(removedById.removed).toBe(true);
    expect(await loadVideoHighlights("BV1hl001")).toHaveLength(0);
  });
});
