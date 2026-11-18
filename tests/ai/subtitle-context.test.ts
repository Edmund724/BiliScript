import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { clipState, state } from "../../extension/core/state.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings } from "../../extension/core/settings-store.js";
import { buildSubtitleSignature, saveSubtitleToCache } from "../../extension/subtitle/cache.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";
import { resolveChapterSource } from "../../extension/shared/chapter-outline.js";
import {
  buildSubtitleContextPromptBlock,
  cleanVideoDescription,
  extractPreviousBilingualLines,
  extractPreviousBilingualLinesBeforeTime,
  extractVideoStaticContext,
  filterGlossaryForText,
  formatMultiPartTitle,
  parseSubtitleGlossary,
  readCachedOverviewSummary
} from "../../extension/ai/subtitle-context.js";
import { translateSubtitleItems } from "../../extension/ai/subtitle-translate.js";
import type { SubtitleTranslateProviderResolution } from "../../extension/ai/subtitle-translate-config.js";

const PROVIDER_RESOLUTION: SubtitleTranslateProviderResolution = {
  provider: {
    id: "p1",
    name: "Test Provider",
    baseUrl: "https://api.test",
    models: ["m1"],
    enabled: true,
    hasSavedKey: true
  },
  apiKey: "sk-test",
  baseUrl: "https://api.test",
  model: "m1",
  presetId: "custom",
  isFallback: false
};

beforeEach(() => {
  resetModuleState();
  state.setSettings({ ...DEFAULT_SETTINGS });
  clipState.setBvid("");
  clipState.setCid("");
  clipState.setTitle("");
  clipState.setPageCount(0);
  clipState.setPageTitle("");
  clipState.setAuthor("");
  clipState.setDescription("");
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setChapters([]);
  clipState.setHotComments([]);
});

describe("静态视频语境提取：多 P 标题组合与简介清洗截断", () => {
  it("多 P 视频拼接主标题与分 P 标题，单 P 或同名分 P 不重复拼接", () => {
    expect(formatMultiPartTitle("MIT 6.824 分布式系统", "Lecture 1: MapReduce", 20)).toBe(
      "MIT 6.824 分布式系统 - Lecture 1: MapReduce"
    );
    expect(formatMultiPartTitle("CUDA 架构解析", "raw_capture_01.mp4", 1)).toBe("CUDA 架构解析");
    expect(formatMultiPartTitle("CUDA 架构解析", "CUDA 架构解析", 3)).toBe("CUDA 架构解析");
  });

  it("清洗简介中的网址与抽奖文案并截断至前 400 字符以内", () => {
    const longTechBody = "深入剖析现代 GPU 的 SM 架构、Warp Scheduler 与 Tensor Core 张量核心设计。".repeat(12);
    const rawDescription = [
      "课程源码：https://github.com/example/gpu-arch",
      "资料地址 www.nvidia.com/cuda 与 b23.tv/xyz123",
      "互动抽奖：关注+转发本视频抽 3 位送机械键盘，12月1日开奖！",
      "一键三连抽 2 位送大会员！",
      longTechBody
    ].join("\n");

    const cleaned = cleanVideoDescription(rawDescription);

    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("www.nvidia.com");
    expect(cleaned).not.toContain("b23.tv");
    expect(cleaned).not.toContain("互动抽奖");
    expect(cleaned).not.toContain("机械键盘");
    expect(cleaned).not.toContain("一键三连");
    expect(cleaned).not.toContain("课程源码：");
    expect(cleaned).toContain("深入剖析现代 GPU 的 SM 架构");
    expect(cleaned.length).toBeLessThanOrEqual(400);
    expect(cleaned.endsWith("…")).toBe(true);
  });

  it("extractVideoStaticContext 同时兼容 VideoMeta 与 clipState 字段命名", () => {
    const staticCtx = extractVideoStaticContext({
      title: "CS149 并行计算",
      pageTitle: "P2 GPU SIMT Execution",
      pageCount: 12,
      author: "Stanford CS",
      description: "讲解 SIMT 与 Warp Divergence。项目地址：https://gf.dev/cs149"
    });

    expect(staticCtx).toEqual({
      title: "CS149 并行计算 - P2 GPU SIMT Execution",
      ownerName: "Stanford CS",
      description: "讲解 SIMT 与 Warp Divergence。"
    });
  });

  it("免费复用概览缓存摘要注入上下文（零额外 API 调用）", async () => {
    const body = [
      { from: 0, to: 4, content: "Welcome to CUDA programming." },
      { from: 4, to: 8, content: "Today we examine Warp Scheduler." }
    ];
    clipState.setBvid("BV1ctx000001");
    clipState.setCid("98765");
    clipState.setTitle("GPU 架构公开课");
    clipState.setPageCount(4);
    clipState.setPageTitle("Lec 2 Warp Scheduler");
    clipState.setAuthor("极客公开课");
    clipState.setDescription("深入理解 Warp Scheduler。https://example.com");
    clipState.setSelectedSubtitleId("cc-en");
    clipState.setSelectedSubtitleLang("en");
    clipState.setSubtitleBody(body);

    const chapterSource = resolveChapterSource(clipState.description, [], []);
    const signature = buildSubtitleSignature({
      lang: "en",
      subtitleId: "cc-en",
      subtitleUrl: "",
      body,
      chapters: chapterSource.signatureChapters,
      chapterOutline: chapterSource.chapters
    });
    const sourceKey = buildSubtitleSourceKey("cc-en", "", "en");
    const finalKey = `biliscript_lvs_analysis_final_BV1ctx000001_98765_${sourceKey}_${signature}`;

    await chrome.storage.local.set({
      [finalKey]: {
        analysis: {
          summary: "本节系统讲解 GPU 线程束调度器如何掩盖显存访问延迟。",
          chapters: [{ title: "Warp 调度原理", summary: "双发射与记分牌机制", from: 0, to: 120 }],
          quotes: []
        },
        timestamp: Date.now()
      }
    });

    const summary = await readCachedOverviewSummary(clipState);
    expect(summary).toContain("本节系统讲解 GPU 线程束调度器如何掩盖显存访问延迟。");
    expect(summary).toContain("Warp 调度原理：双发射与记分牌机制");

    const mockChat = vi.fn().mockResolvedValue(
      JSON.stringify([
        { id: "0", translation: "欢迎来到 CUDA 编程。" },
        { id: "1", translation: "今天我们研究线程束调度器。" }
      ])
    );

    await translateSubtitleItems({
      items: body,
      targetLang: "zh",
      providerResolution: PROVIDER_RESOLUTION,
      chatCompletionFn: mockChat as any
    });

    const sysPrompt = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(sysPrompt).toContain("# Context");
    expect(sysPrompt).toContain("视频标题：GPU 架构公开课 - Lec 2 Warp Scheduler");
    expect(sysPrompt).toContain("UP 主：极客公开课");
    expect(sysPrompt).toContain("视频简介：深入理解 Warp Scheduler。");
    expect(sysPrompt).not.toContain("https://example.com");
    expect(sysPrompt).toContain("内容摘要：本节系统讲解 GPU 线程束调度器如何掩盖显存访问延迟。");
  });
});

describe("跨分块末尾 2 条只读双语前情注入", () => {
  it("extractPreviousBilingualLines 仅提取末尾最多 2 条有效双语对照并按格式注入", () => {
    const items = [
      { from: 0, to: 2, content: "Line one." },
      { from: 2, to: 4, content: "Line two." },
      { from: 4, to: 6, content: "Line three." }
    ];
    const translations = [
      { from: 0, to: 2, content: "第一句。" },
      { from: 2, to: 4, content: "第二句。" },
      { from: 4, to: 6, content: "第三句。" }
    ];

    const prev = extractPreviousBilingualLines(items, translations, 2);
    expect(prev).toEqual([
      { original: "Line two.", translation: "第二句。" },
      { original: "Line three.", translation: "第三句。" }
    ]);

    const block = buildSubtitleContextPromptBlock({
      title: "Test Talk",
      previousLines: prev
    });
    expect(block).toContain("Previous lines (for context only, do NOT re-translate):");
    expect(block).toContain("- Line two. => 第二句。");
    expect(block).toContain("- Line three. => 第三句。");
    expect(block).not.toContain("Line one.");
  });

  it("extractPreviousBilingualLinesBeforeTime 能从已累积翻译中取紧邻上一窗口末尾 2 条", () => {
    const primary = [
      { from: 0, to: 5, content: "Chunk 0 line 1." },
      { from: 10, to: 15, content: "Chunk 0 line 2." },
      { from: 20, to: 25, content: "Chunk 0 line 3." },
      { from: 60, to: 65, content: "Chunk 1 line 1." }
    ];
    const translated = [
      { from: 0, to: 5, content: "片0第1句。" },
      { from: 10, to: 15, content: "片0第2句。" },
      { from: 20, to: 25, content: "片0第3句。" }
    ];

    expect(extractPreviousBilingualLinesBeforeTime(primary, translated, 60, 2)).toEqual([
      { original: "Chunk 0 line 2.", translation: "片0第2句。" },
      { original: "Chunk 0 line 3.", translation: "片0第3句。" }
    ]);
  });

  it("translateSubtitleItems 多分块翻译时第 2 块自动携带第 1 块末尾 2 条只读上下文", async () => {
    const items = [
      { from: 0, to: 2, content: "Alpha." },
      { from: 2, to: 4, content: "Beta." },
      { from: 4, to: 6, content: "Gamma." },
      { from: 6, to: 8, content: "Delta." }
    ];
    const mockChat = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: "0", translation: "阿尔法。" },
          { id: "1", translation: "贝塔。" },
          { id: "2", translation: "伽马。" }
        ])
      )
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "德尔塔。" }])
      );

    await translateSubtitleItems({
      items,
      targetLang: "zh",
      maxChunkChars: 18,
      providerResolution: PROVIDER_RESOLUTION,
      chatCompletionFn: mockChat as any
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    const firstSys = mockChat.mock.calls[0][0].messages[0].content as string;
    const secondSys = mockChat.mock.calls[1][0].messages[0].content as string;
    expect(firstSys).not.toContain("Previous lines (for context only, do NOT re-translate):");
    expect(secondSys).toContain("Previous lines (for context only, do NOT re-translate):");
    expect(secondSys).toContain("- Beta. => 贝塔。");
    expect(secondSys).toContain("- Gamma. => 伽马。");
    expect(secondSys).not.toContain("Alpha.");
  });
});

describe("术语表解析容错、保留原词模式与按分块原文过滤", () => {
  it("parseSubtitleGlossary 支持指定译文、留空保留原词及异常行容错", () => {
    const raw = [
      "",
      "   # 这是注释行",
      "// 这也是注释行",
      "=== 分隔符误写 ===",
      "   = 缺原文的异常行",
      "Warp Scheduler = 线程束调度器",
      "CUDA = CUDA",
      "Tensor Core = ",
      "NVLink",
      "Warp Scheduler ＝ 线程束调度单元",
      "Formula = A = B"
    ].join("\n");

    const parsed = parseSubtitleGlossary(raw);
    expect(parsed).toEqual([
      { source: "CUDA", target: "CUDA" },
      { source: "Tensor Core", target: "" },
      { source: "NVLink", target: "" },
      { source: "Warp Scheduler", target: "线程束调度单元" },
      { source: "Formula", target: "A = B" }
    ]);
  });

  it("filterGlossaryForText 大小写不敏感匹配并防止短缩写误伤普通英文单词", () => {
    const glossary = [
      "CUDA = CUDA",
      "Warp Scheduler = 线程束调度器",
      "Tensor Core = ",
      "AI = 人工智能",
      "IR = 中间表示",
      "Ray Tracing = 光线追踪"
    ].join("\n");

    // wait 含 ai、first 含 ir，但不应命中 AI / IR
    const matched = filterGlossaryForText(
      glossary,
      "Wait for the first frame: cuda uses warp scheduler and tensor cores."
    );

    expect(matched).toEqual([
      { source: "CUDA", target: "CUDA" },
      { source: "Warp Scheduler", target: "线程束调度器" },
      { source: "Tensor Core", target: "" }
    ]);
  });

  it("translateSubtitleItems 按当前分块原文仅注入命中的术语及防加括号规则", async () => {
    state.setSettings({
      ...DEFAULT_SETTINGS,
      subtitleTranslateGlossary: [
        "Warp Scheduler = 线程束调度器",
        "Tensor Core = ",
        "Ray Tracing = 光线追踪"
      ].join("\n")
    });

    const items = [
      { from: 0, to: 3, content: "The warp scheduler issues instructions to Tensor Core." },
      { from: 3, to: 6, content: "Hardware Ray Tracing accelerates reflections." }
    ];

    const mockChat = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "线程束调度器向 Tensor Core 发射指令。" }])
      )
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "硬件光线追踪加速反射计算。" }])
      );

    await translateSubtitleItems({
      items,
      targetLang: "zh",
      maxChunkChars: 55,
      providerResolution: PROVIDER_RESOLUTION,
      chatCompletionFn: mockChat as any
    });

    expect(mockChat).toHaveBeenCalledTimes(2);

    const chunk1Sys = mockChat.mock.calls[0][0].messages[0].content as string;
    expect(chunk1Sys).toContain("# Glossary");
    expect(chunk1Sys).toContain("严禁擅自加括号附注原文");
    expect(chunk1Sys).toContain("- Warp Scheduler -> 线程束调度器");
    expect(chunk1Sys).toContain("- Tensor Core -> 保留原词（Tensor Core）");
    expect(chunk1Sys).not.toContain("Ray Tracing");

    const chunk2Sys = mockChat.mock.calls[1][0].messages[0].content as string;
    const chunk2Glossary = chunk2Sys.slice(chunk2Sys.indexOf("# Glossary"));
    expect(chunk2Sys).toContain("# Glossary");
    expect(chunk2Glossary).toContain("- Ray Tracing -> 光线追踪");
    expect(chunk2Glossary).not.toContain("Warp Scheduler");
    expect(chunk2Glossary).not.toContain("Tensor Core");
  });

  it("settings-store 对 subtitleTranslateGlossary 做规范化且非法值回落空串", () => {
    expect(DEFAULT_SETTINGS.subtitleTranslateGlossary).toBe("");
    expect(normalizeSettings({}).subtitleTranslateGlossary).toBe("");
    expect(
      normalizeSettings({ subtitleTranslateGlossary: "  CUDA = CUDA\r\nTensor Core =  " })
        .subtitleTranslateGlossary
    ).toBe("CUDA = CUDA\nTensor Core =");
    expect(normalizeSettings({ subtitleTranslateGlossary: 12345 }).subtitleTranslateGlossary).toBe("");
  });
});
