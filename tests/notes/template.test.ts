import { beforeEach, describe, expect, it } from "vitest";
import {
  buildNoteTemplateVariables,
  buildNoteTimestampDeepLink,
  buildObsidianUri,
  DEFAULT_NOTE_TEMPLATE,
  LEGACY_DEFAULT_NOTE_TEMPLATE,
  linkifyNoteTimestamps,
  renderNoteTemplate
} from "../../extension/notes/template.js";
import { NOTE_TEMPLATE_VARIABLES_HELP } from "../../extension/notes/template-defaults.js";
import { normalizeNoteExportTemplate } from "../../extension/core/validators.js";
import { encodeVideoStorageBvid } from "../../extension/shared/site.js";
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

  it("支持 {{ai_note}} 完整拼装、site/video_id 元信息与无概览时避免简介重复污染", () => {
    expect(NOTE_TEMPLATE_VARIABLES_HELP).toContain("{{ai_note}}");

    const withAiOnly = buildNoteTemplateVariables({
      meta: {
        site: "bilibili",
        title: "系统设计实战",
        bvid: "BV1ainote001",
        author: "架构师UP",
        url: "https://www.bilibili.com/video/BV1ainote001/",
        uploadDate: "2026-11-26",
        description: "视频原始简介不应在已有AI笔记且无概览时重复出现"
      },
      overview: null,
      highlights: [
        { id: "h1", text: "核心吞吐瓶颈在序列化", from: 145, source: "subtitle", subtitleIndex: 2, createdAt: 1000 }
      ],
      aiNote: "### 核心结论\n\n采用零拷贝通道将延迟压到 1ms 内 [02:25]。"
    });

    expect(withAiOnly.summary).toBe("");
    expect(withAiOnly.ai_note).toContain("采用零拷贝通道");

    const renderedWithAiOnly = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, withAiOnly);
    expect(renderedWithAiOnly).toContain('site: "bilibili"');
    expect(renderedWithAiOnly).toContain('video_id: "BV1ainote001"');
    expect(renderedWithAiOnly).toContain('bvid: "BV1ainote001"');
    expect(renderedWithAiOnly).toContain("## 视频笔记");
    expect(renderedWithAiOnly).toContain("采用零拷贝通道将延迟压到 1ms 内 [02:25]。");
    expect(renderedWithAiOnly).toContain("## 划词笔记");
    expect(renderedWithAiOnly).not.toContain("## 摘要");
    expect(renderedWithAiOnly).not.toContain("视频原始简介不应在已有AI笔记且无概览时重复出现");

    const withOverviewAndAi = buildNoteTemplateVariables({
      meta: {
        site: "youtube",
        title: "Systems Deep Dive",
        bvid: encodeVideoStorageBvid("youtube", "_a-B1234567"),
        author: "Systems Channel",
        url: "https://www.youtube.com/watch?v=_a-B1234567",
        uploadDate: "2026-11-26",
        description: "Raw description"
      },
      overview: {
        summary: "概览提炼摘要",
        chapters: [{ from: 0, to: 95, title: "Architecture", summary: "Overview" }],
        quotes: [{ from: 95, content: "Latency matters most." }]
      },
      aiNote: "详细视频笔记正文 [01:35]。"
    });

    expect(withOverviewAndAi.summary).toBe("概览提炼摘要");
    const renderedBoth = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, withOverviewAndAi);
    expect(renderedBoth).toContain('site: "youtube"');
    expect(renderedBoth).toContain('videoId: "_a-B1234567"');
    expect(renderedBoth).not.toContain("video_id:");
    expect(renderedBoth).not.toContain("bvid:");
    expect(renderedBoth).not.toContain("yt~");
    expect(renderedBoth).toContain("## 摘要\n\n概览提炼摘要");
    expect(renderedBoth).toContain("## 视频笔记\n\n详细视频笔记正文 [01:35]。");
    expect(renderedBoth).toContain("## 章节");
    expect(renderedBoth).toContain("## 金句");

    const withoutAiFallback = buildNoteTemplateVariables({
      meta: {
        title: "无AI笔记回退简介",
        bvid: "BV1desc0001",
        description: "保留原始简介兜底"
      },
      overview: null
    });
    expect(withoutAiFallback.summary).toBe("保留原始简介兜底");
    expect(withoutAiFallback.ai_note).toBe("");
    const renderedWithoutAi = renderNoteTemplate(DEFAULT_NOTE_TEMPLATE, withoutAiFallback);
    expect(renderedWithoutAi).toContain("## 摘要\n\n保留原始简介兜底");
    expect(renderedWithoutAi).not.toContain("## 视频笔记");

    const migratedLegacy = renderNoteTemplate(LEGACY_DEFAULT_NOTE_TEMPLATE, withAiOnly);
    expect(migratedLegacy).toContain("## 视频笔记");
    expect(normalizeNoteExportTemplate(LEGACY_DEFAULT_NOTE_TEMPLATE)).toBe(DEFAULT_NOTE_TEMPLATE);
  });
});

describe("linkifyNoteTimestamps 与 buildNoteTimestampDeepLink 双站时间戳深链", () => {
  it("构造 B 站单 P / 多 P 与 YouTube 原始 11 位 ID 深链", () => {
    expect(
      buildNoteTimestampDeepLink(145, {
        site: "bilibili",
        pageUrl: "https://www.bilibili.com/video/BV1test00001/",
        bvid: "BV1test00001"
      })
    ).toBe("https://www.bilibili.com/video/BV1test00001/?t=145");

    expect(
      buildNoteTimestampDeepLink(145, {
        site: "bilibili",
        pageUrl: "https://www.bilibili.com/video/BV1test00001/?p=3&spm_id_from=333",
        bvid: "BV1test00001"
      })
    ).toBe("https://www.bilibili.com/video/BV1test00001/?p=3&t=145");

    expect(
      buildNoteTimestampDeepLink(95, {
        site: "youtube",
        pageUrl: "https://www.youtube.com/watch?v=_a-B1234567&t=10s",
        videoId: encodeVideoStorageBvid("youtube", "_a-B1234567")
      })
    ).toBe("https://www.youtube.com/watch?v=_a-B1234567&t=95s");
  });

  it("重写正文 [MM:SS] / [HH:MM:SS] 与行首章节/金句/划词时间戳，并严格免疫代码块、图片与已有链接", () => {
    const biliCtx = {
      site: "bilibili" as const,
      pageUrl: "https://www.bilibili.com/video/BV1multi0001/?p=3",
      bvid: "BV1multi0001"
    };
    const input = [
      "---",
      'title: "回放 [02:25]"',
      "---",
      "",
      "关键转折出现在 [02:25]，长视频节点在 [01:02:03]，非法时间 [99:99] 不转换。",
      "",
      "- `02:25` **分节标题**：总结内容",
      "> `01:02:03` 一句金句",
      "- `0:45` 划词批注",
      "",
      "内联代码 `const t = \"[02:25]\"` 与 `foo 02:25` 以及 `[02:25]` 保持原样。",
      "已有链接 [02:25](https://www.bilibili.com/video/BV1multi0001/?p=3&t=145) 不重复包裹。",
      "图片语法 ![架构图 [02:25]](data:image/webp;base64,AAAA) 保持原样。",
      "```ts",
      "const marker = '[02:25]';",
      "```",
      "~~~md",
      "- `02:25` fenced tilde block",
      "~~~"
    ].join("\n");

    const linked = linkifyNoteTimestamps(input, biliCtx);
    expect(linked).toContain('title: "回放 [02:25]"');
    expect(linked).toContain(
      "关键转折出现在 [02:25](https://www.bilibili.com/video/BV1multi0001/?p=3&t=145)，长视频节点在 [01:02:03](https://www.bilibili.com/video/BV1multi0001/?p=3&t=3723)，非法时间 [99:99] 不转换。"
    );
    expect(linked).toContain("- [02:25](https://www.bilibili.com/video/BV1multi0001/?p=3&t=145) **分节标题**：总结内容");
    expect(linked).toContain("> [01:02:03](https://www.bilibili.com/video/BV1multi0001/?p=3&t=3723) 一句金句");
    expect(linked).toContain("- [0:45](https://www.bilibili.com/video/BV1multi0001/?p=3&t=45) 划词批注");
    expect(linked).toContain("内联代码 `const t = \"[02:25]\"` 与 `foo 02:25` 以及 `[02:25]` 保持原样。");
    expect(linked).toContain("已有链接 [02:25](https://www.bilibili.com/video/BV1multi0001/?p=3&t=145) 不重复包裹。");
    expect(linked).toContain("图片语法 ![架构图 [02:25]](data:image/webp;base64,AAAA) 保持原样。");
    expect(linked).toContain("const marker = '[02:25]';");
    expect(linked).toContain("- `02:25` fenced tilde block");
    expect(linkifyNoteTimestamps(linked, biliCtx)).toBe(linked);
  });

  it("YouTube 含 _ 与 - 的视频 ID 正确生成 &t=<seconds>s 深链并保持幂等", () => {
    const ytCtx = {
      site: "youtube" as const,
      pageUrl: "https://www.youtube.com/watch?v=_a-B1234567",
      videoId: "_a-B1234567"
    };
    const input = "核心推导见 [01:35]，复盘见 [01:02:03]。";
    const linked = linkifyNoteTimestamps(input, ytCtx);
    expect(linked).toBe(
      "核心推导见 [01:35](https://www.youtube.com/watch?v=_a-B1234567&t=95s)，复盘见 [01:02:03](https://www.youtube.com/watch?v=_a-B1234567&t=3723s)。"
    );
    expect(linkifyNoteTimestamps(linked, ytCtx)).toBe(linked);
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
