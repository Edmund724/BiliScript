import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { clipState, state } from "../../extension/core/state.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { normalizeSettings } from "../../extension/core/settings-store.js";
import { buildSubtitleSignature, buildTranslationSignature, saveSubtitleToCache } from "../../extension/subtitle/cache.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";
import { resolveChapterSource } from "../../extension/shared/chapter-outline.js";
import {
  filterGlossaryForText as sharedFilterGlossaryForText,
  normalizeModelForSignature,
  parseSubtitleGlossary as sharedParseSubtitleGlossary
} from "../../extension/shared/subtitle-glossary.js";
import { buildL1VideoIndex, L1_INDEX_CACHE_PREFIX } from "../../extension/ai/l1-directory.js";
import {
  buildChunkSubtitleContext,
  buildSubtitleContextPromptBlock,
  cleanVideoDescription,
  extractPreviousBilingualLines,
  extractPreviousBilingualLinesBeforeTime,
  extractVideoStaticContext,
  filterGlossaryForText,
  formatMultiPartTitle,
  parseSubtitleGlossary,
  readCachedL1VideoIndex,
  readCachedOverviewSummary,
  resolveL1ChapterTranslateContext
} from "../../extension/ai/subtitle-context.js";
import { translateSubtitleItems } from "../../extension/ai/subtitle-translate.js";
import {
  parseSubtitleGlossary as configParseSubtitleGlossary,
  type SubtitleTranslateProviderResolution
} from "../../extension/ai/subtitle-translate-config.js";

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

describe("单源术语/模型叶与 L1 章节索引翻译上下文复用", () => {
  it("subtitle-context、subtitle-translate-config 与 shared/subtitle-glossary 共享单源术语函数并保持签名归一一致", () => {
    expect(parseSubtitleGlossary).toBe(sharedParseSubtitleGlossary);
    expect(configParseSubtitleGlossary).toBe(sharedParseSubtitleGlossary);
    expect(filterGlossaryForText).toBe(sharedFilterGlossaryForText);

    expect(normalizeModelForSignature("index-translate-9b")).toBe("Index-Translate-9B");
    expect(normalizeModelForSignature("INDEX-TRANSLATE-2B")).toBe("Index-Translate-2B");
    expect(normalizeModelForSignature("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(normalizeModelForSignature("")).toBe("");

    const sigLower = buildTranslationSignature({
      model: "index-translate-35b-a3b",
      protocolVersion: "cc-json",
      targetLang: "zh",
      glossary: "Warp Scheduler = 线程束调度器",
      sourceText: "Warp Scheduler runs."
    });
    const sigCanonical = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      glossary: [{ source: "warp scheduler", target: "线程束调度器" }],
      sourceText: "Warp Scheduler runs."
    });
    expect(sigLower).toBe(sigCanonical);
  });

  it("analysis_final 未命中时回落读取 L1 章节索引，并提取当前分块章节主旨与消歧实体（不覆盖用户术语）", async () => {
    const body = [
      { from: 5, to: 15, content: "Welcome to CUDA architecture overview." },
      { from: 65, to: 75, content: "The warp scheduler dispatches warps to tensor cores." },
      { from: 130, to: 140, content: "NVLink connects multiple GPUs." }
    ];
    clipState.setBvid("BV1l1ctx0001");
    clipState.setCid("654321");
    clipState.setTitle("GPU 架构长视频");
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
    const l1Key = `${L1_INDEX_CACHE_PREFIX}BV1l1ctx0001_654321_${sourceKey}_${signature}`;

    const l1Index = buildL1VideoIndex({
      bvid: "BV1l1ctx0001",
      cid: "654321",
      subtitleId: "cc-en",
      subtitleLang: "en",
      subtitleSignature: signature,
      videoDuration: 180,
      globalSummary: "全片系统梳理 GPU 执行模型与多卡互联。",
      lines: body,
      chapters: [
        {
          from: 0,
          to: 60,
          title: "CUDA 架构总览",
          coreThesis: "介绍 SM 与流式多处理器组成",
          keyEntities: ["CUDA", "SM"]
        },
        {
          from: 60,
          to: 120,
          title: "Warp 调度原理",
          coreThesis: "双发射与记分牌机制掩盖延迟",
          keyEntities: ["Warp Scheduler", "Tensor Core", "Scoreboard"]
        },
        {
          from: 120,
          to: 180,
          title: "NVLink 互联",
          coreThesis: "多卡高速缓存一致性通信",
          keyEntities: ["NVLink", "PCIe"]
        }
      ]
    });

    await chrome.storage.local.set({
      [l1Key]: { index: l1Index, timestamp: Date.now() }
    });

    const loadedIndex = await readCachedL1VideoIndex(clipState);
    expect(loadedIndex?.bvid).toBe("BV1l1ctx0001");

    const fallbackSummary = await readCachedOverviewSummary(clipState);
    expect(fallbackSummary).toContain("全片系统梳理 GPU 执行模型与多卡互联。");
    expect(fallbackSummary).toContain("Warp 调度原理：双发射与记分牌机制掩盖延迟");

    // 边界 [0, 60) 不应误命中第二章
    const ch0Ctx = resolveL1ChapterTranslateContext({
      l1Index: loadedIndex,
      chunkFromSec: 0,
      chunkToSec: 60
    });
    expect(ch0Ctx).toEqual({
      chapterContext: "CUDA 架构总览：介绍 SM 与流式多处理器组成",
      referenceEntities: ["CUDA", "SM"]
    });

    // 用户显式术语表覆盖的实体（忽略大小写）从 referenceEntities 中排除
    const ch1Ctx = resolveL1ChapterTranslateContext({
      l1Index: loadedIndex,
      chunkFromSec: 60,
      chunkToSec: 120,
      glossary: "warp scheduler = 线程束调度器"
    });
    expect(ch1Ctx).toEqual({
      chapterContext: "Warp 调度原理：双发射与记分牌机制掩盖延迟",
      referenceEntities: ["Tensor Core", "Scoreboard"]
    });

    // 跨章分块合并涉及章节且实体大小写去重
    const overlapCtx = resolveL1ChapterTranslateContext({
      l1Index: loadedIndex,
      chunkFromSec: 50,
      chunkToSec: 75,
      glossary: "CUDA = CUDA"
    });
    expect(overlapCtx.chapterContext).toBe(
      "CUDA 架构总览：介绍 SM 与流式多处理器组成；Warp 调度原理：双发射与记分牌机制掩盖延迟"
    );
    expect(overlapCtx.referenceEntities).toEqual(["SM", "Warp Scheduler", "Tensor Core", "Scoreboard"]);
  });

  it("buildSubtitleContextPromptBlock 与 buildChunkSubtitleContext 区分渲染参考实体与硬性术语表", () => {
    const chunkContext = buildChunkSubtitleContext(
      {
        title: "GPU 架构公开课",
        chapterContext: "Warp 调度原理：双发射与记分牌机制",
        referenceEntities: ["Warp Scheduler", "Tensor Core", "Scoreboard"],
        glossary: "Warp Scheduler = 线程束调度器\nUnused = 无关词"
      },
      "The warp scheduler works with scoreboard."
    );

    expect(chunkContext?.chapterContext).toBe("Warp 调度原理：双发射与记分牌机制");
    expect(chunkContext?.referenceEntities).toEqual(["Tensor Core", "Scoreboard"]);

    const block = buildSubtitleContextPromptBlock(chunkContext);
    const contextSection = block.slice(0, block.indexOf("# Glossary"));
    const glossarySection = block.slice(block.indexOf("# Glossary"));

    expect(contextSection).toContain("当前章节：Warp 调度原理：双发射与记分牌机制");
    expect(contextSection).toContain("参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：Tensor Core、Scoreboard");
    expect(contextSection).not.toContain("Warp Scheduler");
    expect(glossarySection).toContain("- Warp Scheduler -> 线程束调度器");
    expect(glossarySection).not.toContain("Scoreboard");
  });

  it("translateSubtitleItems 多分块翻译自动从本地 L1 缓存按分块时间窗注入对应章节与参考实体", async () => {
    const items = [
      { from: 5, to: 15, content: "CUDA uses streaming multiprocessors." },
      { from: 65, to: 75, content: "The warp scheduler feeds tensor cores." }
    ];
    clipState.setBvid("BV1l1e2e0002");
    clipState.setCid("222333");
    clipState.setTitle("CUDA 进阶");
    clipState.setSelectedSubtitleId("cc-en");
    clipState.setSelectedSubtitleLang("en");
    clipState.setSubtitleBody(items);
    state.setSettings({
      ...DEFAULT_SETTINGS,
      subtitleTranslateGlossary: "Warp Scheduler = 线程束调度器"
    });

    const chapterSource = resolveChapterSource(clipState.description, [], []);
    const signature = buildSubtitleSignature({
      lang: "en",
      subtitleId: "cc-en",
      subtitleUrl: "",
      body: items,
      chapters: chapterSource.signatureChapters,
      chapterOutline: chapterSource.chapters
    });
    const sourceKey = buildSubtitleSourceKey("cc-en", "", "en");
    const l1Key = `${L1_INDEX_CACHE_PREFIX}BV1l1e2e0002_222333_${sourceKey}_${signature}`;

    const l1Index = buildL1VideoIndex({
      bvid: "BV1l1e2e0002",
      cid: "222333",
      subtitleId: "cc-en",
      subtitleLang: "en",
      subtitleSignature: signature,
      videoDuration: 120,
      globalSummary: "讲解 CUDA SM 与线程束调度器。",
      lines: items,
      chapters: [
        {
          from: 0,
          to: 60,
          title: "SM 基础",
          coreThesis: "流式多处理器架构概述",
          keyEntities: ["CUDA", "SM"]
        },
        {
          from: 60,
          to: 120,
          title: "Warp 调度",
          coreThesis: "线程束指令发射机制",
          keyEntities: ["Warp Scheduler", "Tensor Core"]
        }
      ]
    });

    await chrome.storage.local.set({
      [l1Key]: { index: l1Index, timestamp: Date.now() }
    });

    const sigBefore = buildTranslationSignature({
      model: PROVIDER_RESOLUTION.model,
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      glossary: state.settings.subtitleTranslateGlossary,
      sourceText: items.map((item) => item.content).join("\n")
    });

    const mockChat = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "0", translation: "CUDA 使用流式多处理器。" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: "0", translation: "线程束调度器驱动 Tensor Core。" }]));

    await translateSubtitleItems({
      items,
      targetLang: "zh",
      maxChunkChars: 40,
      providerResolution: PROVIDER_RESOLUTION,
      chatCompletionFn: mockChat as any
    });

    expect(mockChat).toHaveBeenCalledTimes(2);

    const chunk1Sys = mockChat.mock.calls[0][0].messages[0].content as string;
    const chunk1ChapterLine = chunk1Sys
      .split("\n")
      .find((line) => line.startsWith("当前章节："));
    expect(chunk1Sys).toContain("内容摘要：讲解 CUDA SM 与线程束调度器。");
    expect(chunk1ChapterLine).toBe("当前章节：SM 基础：流式多处理器架构概述");
    expect(chunk1Sys).toContain("参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：CUDA、SM");

    const chunk2Sys = mockChat.mock.calls[1][0].messages[0].content as string;
    const chunk2ChapterLine = chunk2Sys
      .split("\n")
      .find((line) => line.startsWith("当前章节："));
    expect(chunk2ChapterLine).toBe("当前章节：Warp 调度：线程束指令发射机制");
    expect(chunk2Sys).toContain("参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：Tensor Core");
    expect(chunk2Sys).toContain("- Warp Scheduler -> 线程束调度器");

    // 确认 L1 动态上下文不影响缓存签名
    const sigAfter = buildTranslationSignature({
      model: PROVIDER_RESOLUTION.model,
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      glossary: state.settings.subtitleTranslateGlossary,
      sourceText: items.map((item) => item.content).join("\n")
    });
    expect(sigAfter).toBe(sigBefore);
  });
});
