import { afterEach, describe, expect, it } from "vitest";
import {
  buildL0SemanticChunks,
  CHAR_BIGRAM_WEIGHT,
  clearL0Bm25Cache,
  computeLocalTextSimilarity,
  createL0ContextualBm25Index,
  DEFAULT_SEMANTIC_CHUNK_MAX_CHARS,
  expandAndMergeHitWindows,
  findLineIndexByLineNumber,
  findNearestLineIndexBySeconds,
  getL0Bm25CacheStats,
  getOrCreateL0ContextualBm25Index,
  matchChapterByTitle,
  MAX_CACHED_BM25_VIDEOS,
  normalizeL0SubtitleLines,
  parseL0SecondsValue,
  resolveCachedL0SubtitleLines,
  tokenizeDualGranularity,
  tokenizeLexicalText,
  WORD_TOKEN_WEIGHT
} from "../../extension/ai/l0-bm25.js";
import type { L0SubtitleLine } from "../../extension/ai/long-video-hybrid-types.js";

describe("L0 词法分词与 BM25 检索引擎", () => {
  describe("tokenizeLexicalText（原生 Intl.Segmenter 分词与停用词过滤）", () => {
    it("正确切分中英混合、专有名词、版本号与 B 站视频编号并统一小写", () => {
      const tokens = tokenizeLexicalText(
        "今天我们讲解 Transformer 架构与 LoRA 微调，对比 GPT-4o 和 Qwen2.5，参考 BV1xx411c7mD！"
      );

      expect(tokens).toContain("transformer");
      expect(tokens).toContain("lora");
      expect(tokens).toContain("微调");
      expect(tokens).toContain("gpt");
      expect(tokens).toContain("4o");
      expect(tokens).toContain("qwen2.5");
      expect(tokens).toContain("bv1xx411c7md");
      expect(tokens).not.toContain("我们");
      expect(tokens).not.toContain("与");
      expect(tokens).not.toContain("和");
      expect(tokens).not.toContain("！");
    });

    it("过滤常见中英文停用词，保留有意义的英文缩写与数字", () => {
      const tokens = tokenizeLexicalText("What is the difference between TypeScript and WebAssembly in 2026?");

      expect(tokens).toEqual(["difference", "between", "typescript", "webassembly", "2026"]);
    });

    it("空串、纯空白、纯标点或纯停用词返回空词元列表", () => {
      expect(tokenizeLexicalText("")).toEqual([]);
      expect(tokenizeLexicalText("   \n\t  ")).toEqual([]);
      expect(tokenizeLexicalText("！？，。、...")).toEqual([]);
      expect(tokenizeLexicalText("这个那个怎么为什么 the is and")).toEqual([]);
    });
  });

  describe("expandAndMergeHitWindows（命中行前后扩窗与时间戳去重合并）", () => {
    const lines: L0SubtitleLine[] = normalizeL0SubtitleLines([
      { from: 0, to: 3, content: "第零句" },
      { from: 3, to: 6, content: "第一句" },
      { from: 6, to: 10, content: "第二句命中A" },
      { from: 10, to: 14, content: "第三句" },
      { from: 14, to: 18, content: "第四句命中B" },
      { from: 18, to: 22, content: "第五句" },
      { from: 30, to: 34, content: "第六句远端间隔" },
      { from: 34, to: 38, content: "第七句命中C" },
      { from: 38, to: 42, content: "第八句" }
    ]);

    it("支持按 N 句扩窗并将重叠或相邻窗口合并为连续上下文块", () => {
      const windows = expandAndMergeHitWindows(
        lines,
        [
          { lineNumber: 2, score: 3.1 },
          { lineNumber: 4, score: 4.5 },
          { lineNumber: 7, score: 2.0 }
        ],
        { windowRadiusLines: 1 }
      );

      expect(windows).toHaveLength(2);
      expect(windows[0]).toMatchObject({
        anchorLineNumber: 4,
        startLineNumber: 1,
        endLineNumber: 5,
        from: 3,
        to: 22
      });
      expect(windows[0].lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5]);

      expect(windows[1]).toMatchObject({
        anchorLineNumber: 7,
        startLineNumber: 6,
        endLineNumber: 8,
        from: 30,
        to: 42
      });
      expect(windows[1].lines.map((l) => l.lineNumber)).toEqual([6, 7, 8]);
    });

    it("支持按 M 秒时间窗口扩窗并在首尾边界处安全钳制", () => {
      const windows = expandAndMergeHitWindows(lines, [0], {
        windowRadiusLines: 0,
        windowRadiusSeconds: 7
      });

      expect(windows).toHaveLength(1);
      expect(windows[0].startLineNumber).toBe(0);
      expect(windows[0].endLineNumber).toBe(2);
      expect(windows[0].from).toBe(0);
      expect(windows[0].to).toBe(10);
    });
  });

  describe("L0 局部相似度、行号/时间戳二分定位与秒级时间戳解析", () => {
    it("computeLocalTextSimilarity 支持忽略标点空格的大小写无关子串与容错相似匹配", () => {
      expect(computeLocalTextSimilarity("Transformer 架构！", "transformer架构")).toBe(1);
      expect(computeLocalTextSimilarity("FlashAttention 分块", "现在来看板书上的 FlashAttention 分块矩阵计算图解")).toBeGreaterThan(0.55);

      const closeScore = computeLocalTextSimilarity(
        "没有行号锚定的金句回填，迟早会在改写里走样",
        "没有行号锚定的金句回填，迟早会在二次改写里走样。"
      );
      const unrelatedScore = computeLocalTextSimilarity(
        "没有行号锚定的金句回填，迟早会在改写里走样",
        "今天天气真不错我们去散步吧"
      );
      expect(closeScore).toBeGreaterThan(0.7);
      expect(closeScore).toBeGreaterThan(unrelatedScore);
      expect(computeLocalTextSimilarity("", "非空")).toBe(0);
      expect(computeLocalTextSimilarity("...", "非空")).toBe(0);
    });

    it("findLineIndexByLineNumber 同时支持连续数组与稀疏切片数组二分查找", () => {
      const dense = normalizeL0SubtitleLines([
        { from: 0, to: 2, content: "L0" },
        { from: 2, to: 4, content: "L1" },
        { from: 4, to: 6, content: "L2" }
      ]);
      expect(findLineIndexByLineNumber(dense, 0)).toBe(0);
      expect(findLineIndexByLineNumber(dense, 2)).toBe(2);
      expect(findLineIndexByLineNumber(dense, 3)).toBe(-1);
      expect(findLineIndexByLineNumber(dense, -1)).toBe(-1);
      expect(findLineIndexByLineNumber(dense, 1.5)).toBe(-1);

      const sparse = [dense[1], dense[2]];
      expect(findLineIndexByLineNumber(sparse, 1)).toBe(0);
      expect(findLineIndexByLineNumber(sparse, 2)).toBe(1);
      expect(findLineIndexByLineNumber(sparse, 0)).toBe(-1);
      expect(findLineIndexByLineNumber([], 0)).toBe(-1);
    });

    it("findNearestLineIndexBySeconds 精确命中覆盖行或间距最近行并安全钳制边界", () => {
      const lines: L0SubtitleLine[] = [
        { lineNumber: 0, from: 0, to: 5, content: "第一句" },
        { lineNumber: 1, from: 15, to: 20, content: "第二句" },
        { lineNumber: 2, from: 20, to: 30, content: "第三句" }
      ];
      expect(findNearestLineIndexBySeconds(lines, 3)).toBe(0);
      expect(findNearestLineIndexBySeconds(lines, 6)).toBe(0);
      expect(findNearestLineIndexBySeconds(lines, 12)).toBe(1);
      expect(findNearestLineIndexBySeconds(lines, 24)).toBe(2);
      expect(findNearestLineIndexBySeconds(lines, 99)).toBe(2);
      expect(findNearestLineIndexBySeconds([], 10)).toBe(-1);
      expect(findNearestLineIndexBySeconds(lines, Number.NaN)).toBe(-1);
    });

    it("parseL0SecondsValue 统一解析数字、数字串与 M:SS / H:MM:SS 时刻文本", () => {
      expect(parseL0SecondsValue(42.9)).toBe(42);
      expect(parseL0SecondsValue(0)).toBe(0);
      expect(parseL0SecondsValue(" 125.7 ")).toBe(125);
      expect(parseL0SecondsValue("2:30")).toBe(150);
      expect(parseL0SecondsValue("1:02:05")).toBe(3725);
      expect(parseL0SecondsValue(-1)).toBeNull();
      expect(parseL0SecondsValue("")).toBeNull();
      expect(parseL0SecondsValue("   ")).toBeNull();
      expect(parseL0SecondsValue("99:99")).toBeNull();
      expect(parseL0SecondsValue("not-a-time")).toBeNull();
      expect(parseL0SecondsValue(null)).toBeNull();
    });

    it("matchChapterByTitle 忽略大小写、空白与标点匹配章节标题，畸形输入不抛错", () => {
      const chapters = [
        { from: 0, to: 600, title: "开场白" },
        { from: 600, to: 1200, title: "技术讲解" },
        { from: 1200, to: 1800, title: "FlashAttention" }
      ];
      expect(matchChapterByTitle("讲讲开场白", chapters).map((c) => c.title)).toEqual(["开场白"]);
      expect(matchChapterByTitle(" 技术讲解 是什么？", chapters).map((c) => c.title)).toEqual(["技术讲解"]);
      expect(matchChapterByTitle("flashattention 原理", chapters).map((c) => c.title)).toEqual(["FlashAttention"]);
      expect(matchChapterByTitle("technology", chapters)).toEqual([]);
      expect(matchChapterByTitle("", chapters)).toEqual([]);

      const badChapters = [null, { title: "开场白" }, { from: "x", to: 600, title: "开场白" }];
      expect(matchChapterByTitle("开场白", badChapters).map((c) => c.title)).toEqual(["开场白", "开场白"]);
      expect(matchChapterByTitle(null, chapters)).toEqual([]);
    });
  });

  describe("25s 语境滑窗 Contextual BM25、双粒度容错与 3 槽 LRU 缓存", () => {
    afterEach(() => {
      clearL0Bm25Cache();
    });

    it("稀有专有名词排序、章节归属、timeRanges 区间过滤与扩展词低权召回", () => {
      const lines = normalizeL0SubtitleLines([
        { from: 0, to: 10, content: "开场先聊聊日常编程工程实践与目录结构配置" },
        { from: 30, to: 42, content: "这里使用 WebAssembly 加速音视频解码，明显降低内存占用" },
        { from: 60, to: 72, content: "相比之下纯 JavaScript 解码大文件容易触发 OOM 崩溃" },
        { from: 90, to: 104, content: "WebAssembly 配合 SIMD 指令集后，WebAssembly 吞吐提升三倍" },
        { from: 120, to: 132, content: "最后补充 Service Worker 的生命周期限制说明" }
      ]);
      const chapters = [
        { chapterIndex: 0, from: 0, to: 60, title: "基础与解码" },
        { chapterIndex: 1, from: 60, to: 140, title: "SIMD 加速实测" }
      ];
      const index = createL0ContextualBm25Index(lines, { chapters });

      const ranked = index.search({
        query: "WebAssembly SIMD 吞吐提升",
        topK: 3
      });
      expect(ranked.hits.length).toBeGreaterThanOrEqual(2);
      expect(ranked.hits[0].chunk.fromSeconds).toBe(90);
      expect(ranked.hits[0].chapterIndex).toBe(1);
      expect(ranked.hits[0].matchedTerms).toContain("webassembly");
      expect(ranked.hits[0].coreTermCoverage).toBeGreaterThan(0.5);
      expect(ranked.hits[0].score).toBeGreaterThan(ranked.hits[1].score);
      expect(ranked.meanScore).toBeGreaterThan(0);
      expect(ranked.stdDevScore).toBeGreaterThan(0);

      const scoped = index.search({
        terms: ["WebAssembly", "解码"],
        timeRanges: [{ from: 25, to: 50 }],
        topK: 5
      });
      expect(scoped.hits).toHaveLength(1);
      expect(scoped.hits[0].chunk.fromSeconds).toBe(30);
      expect(scoped.totalChunksScanned).toBe(1);

      const expanded = index.search({
        query: "生命周期限制",
        expansionTerms: ["WebAssembly", "SIMD"],
        expansionWeight: 0.35
      });
      expect(expanded.hits.length).toBeGreaterThanOrEqual(1);
      expect(expanded.hits[0].chunk.fromSeconds).toBe(120);
    });

    it("空字幕、全空白字幕与单句超短字幕边界下不崩溃并返回可预期结果", () => {
      const emptyResolved = resolveCachedL0SubtitleLines([], { bvid: "BVempty", cid: "0" });
      expect(emptyResolved.lines).toEqual([]);

      const emptyIndex = createL0ContextualBm25Index(emptyResolved.lines);
      expect(emptyIndex.lineCount).toBe(0);
      expect(emptyIndex.chunkCount).toBe(0);
      expect(emptyIndex.avgDocLength).toBe(0);
      expect(emptyIndex.search("任意关键词")).toMatchObject({
        hits: [],
        totalChunksScanned: 0,
        meanScore: 0,
        stdDevScore: 0
      });

      const blankLines = normalizeL0SubtitleLines([
        { from: 0, to: 2, content: "   " },
        { from: 2, to: 4, content: "..." }
      ]);
      expect(createL0ContextualBm25Index(blankLines).search("测试").hits).toEqual([]);

      const tinyLines = normalizeL0SubtitleLines([
        { from: 0, to: 3, content: "Rust 所有权模型与借用检查器" }
      ]);
      const tinyRes = createL0ContextualBm25Index(tinyLines).search("借用检查器");
      expect(tinyRes.hits).toHaveLength(1);
      expect(tinyRes.hits[0].score).toBeGreaterThan(0);
      expect(Number.isFinite(tinyRes.hits[0].score)).toBe(true);
      expect(tinyRes.hits[0].chunk.lines).toHaveLength(1);
    });

    it("buildL0SemanticChunks 按 25s 目标窗口、5s 重叠与 600 字上限确定性切块并附带章节语境前缀", () => {
      const denseLines = normalizeL0SubtitleLines(
        Array.from({ length: 14 }, (_, i) => ({
          from: i * 5,
          to: (i + 1) * 5,
          content: `第${i}段硬件参数测试说明内容`
        }))
      );
      const chapters = [
        {
          chapterIndex: 0,
          from: 0,
          to: 35,
          title: "主板供电架构",
          coreThesis: "拆解 18 相供电与电感散热设计",
          keyEntities: ["DrMOS", "电感"]
        },
        {
          chapterIndex: 1,
          from: 35,
          to: 70,
          title: "PCIe 网卡实测",
          coreThesis: "对比三款 2.5G 与万兆网卡功耗",
          keyEntities: ["RTL8126", "万兆网卡"]
        }
      ];

      const chunks = buildL0SemanticChunks(denseLines, chapters);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0]).toMatchObject({
        startLineIdx: 0,
        endLineIdx: 4,
        fromSeconds: 0,
        toSeconds: 25,
        chapterIndex: 0
      });
      expect(chunks[0].contextPrefix).toContain("主板供电架构");
      expect(chunks[0].contextPrefix).toContain("DrMOS");
      expect(chunks[1].fromSeconds).toBe(20);
      expect(chunks[1].toSeconds - chunks[1].fromSeconds).toBeLessThanOrEqual(25);
      expect(chunks[0].toSeconds - chunks[1].fromSeconds).toBe(5);
      expect(chunks.at(-1)?.endLineIdx).toBe(denseLines.length - 1);
      expect(chunks.at(-1)?.chapterIndex).toBe(1);
      expect(chunks.at(-1)?.contextPrefix).toContain("RTL8126");

      const longLines = normalizeL0SubtitleLines(
        Array.from({ length: 10 }, (_, i) => ({
          from: i * 2,
          to: i * 2 + 2,
          content: `段${i}` + "字".repeat(198)
        }))
      );
      const cappedChunks = buildL0SemanticChunks(longLines);
      expect(cappedChunks.length).toBeGreaterThan(1);
      expect(
        cappedChunks.every(
          (ch) => ch.lines.reduce((s, l) => s + l.content.length, 0) <= DEFAULT_SEMANTIC_CHUNK_MAX_CHARS
        )
      ).toBe(true);
    });

    it("双粒度分词（词级 1.0 + 中文二元组 0.45）支持同音错字「机器学系」命中「机器学习」", () => {
      const dual = tokenizeDualGranularity("机器学习");
      expect(dual.some((t) => !t.isBigram && t.weight === WORD_TOKEN_WEIGHT)).toBe(true);
      expect(dual.some((t) => t.isBigram && t.term === "器学" && t.weight === CHAR_BIGRAM_WEIGHT)).toBe(true);

      const lines = normalizeL0SubtitleLines([
        { from: 0, to: 10, content: "开场先聊聊今天天气和生活分享" },
        { from: 30, to: 45, content: "这一段详细讲解机器学习中的梯度下降与反向传播" },
        { from: 60, to: 75, content: "最后演示厨房里如何制作手冲咖啡" }
      ]);
      const index = createL0ContextualBm25Index(lines);
      const result = index.search("机器学系");
      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      expect(result.hits[0].chunk.bodyText).toContain("机器学习");
    });

    it("章节标题/核心要点/关键词语境前缀可召回正文未重复该标题词的滑窗", () => {
      const lines = normalizeL0SubtitleLines([
        { from: 0, to: 20, content: "大家好欢迎来到频道，我们先看整体外观" },
        { from: 300, to: 320, content: "实测温度只有四十五度，风扇转速很低且噪音几乎不可闻" },
        { from: 600, to: 620, content: "总结一下今天所有的对比体验" }
      ]);
      const chapters = [
        { chapterIndex: 0, from: 0, to: 300, title: "开箱外观", coreThesis: "展示包装与机身接口", keyEntities: ["外观"] },
        { chapterIndex: 1, from: 300, to: 600, title: "烤机散热表现", coreThesis: "双烤功耗与噪音控制", keyEntities: ["双烤", "液金散热"] },
        { chapterIndex: 2, from: 600, to: 900, title: "购买建议", coreThesis: "适合人群与性价比", keyEntities: ["性价比"] }
      ];
      const index = createL0ContextualBm25Index(lines, { chapters });
      const res = index.search("液金散热烤机表现");
      expect(res.hits.length).toBeGreaterThanOrEqual(1);
      expect(res.hits[0].chunk.fromSeconds).toBe(300);
      expect(res.hits[0].chunk.bodyText).toContain("四十五度");
    });

    it("resolveCachedL0SubtitleLines 与 3 槽 LRU 缓存：复用已归一化引用、支持透传预归一化行、第 4 支视频淘汰最旧槽并在目录变化时隔离索引", () => {
      expect(MAX_CACHED_BM25_VIDEOS).toBe(3);
      clearL0Bm25Cache();

      const makeVideo = (id: string) => {
        const raw = [{ from: 0, to: 10, content: `视频 ${id} 专属内容关键词` }];
        const meta = { bvid: `BV${id}`, cid: id };
        const resolved = resolveCachedL0SubtitleLines(raw, meta);
        return { raw, meta, ...resolved };
      };

      const v1 = makeVideo("1");
      const v2 = makeVideo("2");
      const v3 = makeVideo("3");
      const v4 = makeVideo("4");

      const passthrough = resolveCachedL0SubtitleLines(v1.raw, v1.meta, {
        preNormalizedLines: v1.lines,
        subtitleCacheKey: v1.subtitleKey
      });
      expect(passthrough.lines).toBe(v1.lines);
      expect(passthrough.subtitleKey).toBe(v1.subtitleKey);

      const idx1 = getOrCreateL0ContextualBm25Index({ subtitleKey: v1.subtitleKey, lines: v1.lines });
      getOrCreateL0ContextualBm25Index({ subtitleKey: v2.subtitleKey, lines: v2.lines });
      getOrCreateL0ContextualBm25Index({ subtitleKey: v3.subtitleKey, lines: v3.lines });
      expect(getL0Bm25CacheStats().size).toBe(3);

      const idx1Hit = getOrCreateL0ContextualBm25Index({ subtitleKey: v1.subtitleKey, lines: v1.lines });
      expect(idx1Hit).toBe(idx1);
      expect(resolveCachedL0SubtitleLines(v1.raw, v1.meta).lines).toBe(v1.lines);

      getOrCreateL0ContextualBm25Index({ subtitleKey: v4.subtitleKey, lines: v4.lines });
      expect(getL0Bm25CacheStats().size).toBe(3);
      expect(resolveCachedL0SubtitleLines(v2.raw, v2.meta).lines).not.toBe(v2.lines);
      expect(resolveCachedL0SubtitleLines(v1.raw, v1.meta).lines).toBe(v1.lines);
      expect(resolveCachedL0SubtitleLines(v3.raw, v3.meta).lines).toBe(v3.lines);
      expect(resolveCachedL0SubtitleLines(v4.raw, v4.meta).lines).toBe(v4.lines);

      const idx1WithChapters = getOrCreateL0ContextualBm25Index({
        subtitleKey: v1.subtitleKey,
        lines: v1.lines,
        chapters: [{ chapterIndex: 0, from: 0, to: 10, title: "新章节目录" }]
      });
      expect(idx1WithChapters).not.toBe(idx1);
      expect(getL0Bm25CacheStats().size).toBe(3);

      clearL0Bm25Cache();
      expect(getL0Bm25CacheStats().size).toBe(0);
      expect(resolveCachedL0SubtitleLines(v1.raw, v1.meta).lines).not.toBe(v1.lines);
      expect(resolveCachedL0SubtitleLines(v4.raw, v4.meta).lines).not.toBe(v4.lines);
    });
  });
});
