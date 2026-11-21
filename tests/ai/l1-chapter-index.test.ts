import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_FINAL_PREFIX,
  buildAnalysisFinalCacheKey,
  buildClipOverviewIdentity,
  buildL1IndexCacheKey,
  buildL1VideoIndex,
  clearL1IndexMemoryCache,
  createL1IndexCacheStore,
  estimateCompactPromptTokens,
  L1_INDEX_CACHE_PREFIX,
  L1_INDEX_SCHEMA_VERSION,
  loadAnalysisFinal,
  readCachedClipL1Index,
  readCachedClipOverviewArtifacts,
  saveAnalysisFinal,
  serializeL1DirectoryPrompt,
  unwrapL1IndexEnvelope
} from "../../extension/ai/l1-chapter-index.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";

describe("L1 章节目录构建、紧凑序列化与本地缓存", () => {
  let host: ChromeHost;

  beforeEach(() => {
    clearL1IndexMemoryCache();
    host = installChromeHost();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("buildL1VideoIndex（时间轴 / AI 章节构建与 L0 行号锚定）", () => {
    const subtitleLines = [
      { from: 0, to: 5, content: "欢迎收看本期长视频架构拆解" },
      { from: 12, to: 18, content: "第一步我们先看 BM25 词法索引为什么零依赖" },
      { from: 45, to: 52, content: "因为浏览器原生 Intl.Segmenter 已经足够切分中英文" },
      { from: 125, to: 132, content: "接下来看状态卡如何接力传递未闭合话题" },
      { from: 180, to: 188, content: "没有状态卡的话跨切点专有名词很容易漂移" }
    ];

    it("从视频自带时间轴构建 L1 索引并映射 L0 行号区间", () => {
      const index = buildL1VideoIndex({
        bvid: "BV1xx411c7mD",
        cid: "10001",
        subtitleId: "998877",
        subtitleLang: "zh-CN",
        subtitleSignature: "sig_v4_abc",
        videoDuration: 240,
        lines: subtitleLines,
        chapters: [
          { seconds: 0, title: "开场与动机" },
          { seconds: 120, title: "状态接力设计" }
        ],
        now: 1700000000000
      });

      expect(index.schemaVersion).toBe(L1_INDEX_SCHEMA_VERSION);
      expect(index.bvid).toBe("BV1xx411c7mD");
      expect(index.cid).toBe("10001");
      expect(index.sourceKey).toBe("id_998877");
      expect(index.lineCount).toBe(5);
      expect(index.videoDuration).toBe(240);
      expect(index.chapters).toHaveLength(2);
      expect(index.chapters[0]).toMatchObject({
        chapterIndex: 0,
        title: "开场与动机",
        from: 0,
        to: 120,
        startLineNumber: 0,
        endLineNumber: 2
      });
      expect(index.chapters[1]).toMatchObject({
        chapterIndex: 1,
        title: "状态接力设计",
        from: 120,
        to: 240,
        startLineNumber: 3,
        endLineNumber: 4
      });
    });

    it("从 AI OverviewAnalysis 构建索引并自动将精选金句锚定至 L0 行号与所属章节", () => {
      const index = buildL1VideoIndex({
        bvid: "BV1xx411c7mD",
        cid: "10001",
        subtitleLang: "asr-zh",
        subtitleSignature: "sig_v4_ai",
        lines: subtitleLines,
        overviewAnalysis: {
          summary: "本片讲解如何在浏览器扩展中实现零体积的长视频检索与接力总结。",
          chapters: [
            { from: 0, to: 120, title: "L0 词法检索", summary: "利用原生分词实现本地 BM25 检索" },
            { from: 120, to: 200, title: "状态卡接力", summary: "通过滚动状态卡维持跨段一致性" }
          ],
          quotes: [
            { from: 46, content: "浏览器原生 Intl.Segmenter 已经足够切分中英文" },
            { from: 179, content: "没有状态卡的话跨切点专有名词很容易漂移" }
          ]
        }
      });

      expect(index.globalSummary).toContain("零体积");
      expect(index.quotes).toHaveLength(2);
      expect(index.quotes[0]).toMatchObject({ lineNumber: 2, chapterIndex: 0 });
      expect(index.quotes[1]).toMatchObject({ lineNumber: 4, chapterIndex: 1 });
      expect(index.chapters[0].quoteLineNumbers).toEqual([2]);
      expect(index.chapters[1].quoteLineNumbers).toEqual([4]);
      expect(index.chapters[0].keyEntities.length).toBeGreaterThan(0);
    });
  });

  describe("serializeL1DirectoryPrompt（紧凑 Prompt 序列化与 1200 Token 预算控制）", () => {
    it("常规多章节视频输出紧凑目录且包含全片简介、核心论点与实体", () => {
      const index = buildL1VideoIndex({
        bvid: "BV1a",
        cid: "1",
        subtitleSignature: "sig1",
        videoDuration: 900,
        globalSummary: "系统介绍 BiliScript 长视频双层索引与单跳召回架构。",
        chapters: [
          { from: 0, to: 300, title: "背景瓶颈", coreThesis: "全量字幕塞上下文太贵", keyEntities: ["BM25", "Token"] },
          { from: 300, to: 600, title: "L1/L0 分层", coreThesis: "目录粗筛加词法精排", keyEntities: ["Intl.Segmenter"] },
          { from: 600, to: 900, title: "隐私与体积", coreThesis: "全部本地运行零外部依赖", keyEntities: ["chrome.storage.local"] }
        ]
      });

      const prompt = serializeL1DirectoryPrompt(index);
      expect(prompt).toContain("全片简介：");
      expect(prompt).toContain("[0:00-5:00] 背景瓶颈");
      expect(prompt).toContain("词:BM25/Token");
      expect(prompt.length).toBeLessThanOrEqual(1200);
      expect(estimateCompactPromptTokens(prompt)).toBeLessThanOrEqual(1200);
    });

    it("超长 100 章时间轴视频经多级降维与分桶严格控制在 1200 字符与 Token 以内", () => {
      const manyChapters = Array.from({ length: 100 }, (_, i) => ({
        from: i * 180,
        to: (i + 1) * 180,
        title: `第${i + 1}阶段深入剖析现代前端编译器与运行时架构演进细节`,
        coreThesis: `本章节详细讨论第${i + 1}个关键性能瓶颈以及内存调度策略的权衡方案`,
        keyEntities: ["Compiler", "Runtime", `Module${i + 1}`]
      }));

      const index = buildL1VideoIndex({
        bvid: "BV1mega",
        cid: "99",
        subtitleSignature: "sig_mega",
        videoDuration: 18000,
        globalSummary: "长达五小时的前端编译器与运行时深度技术讲座，覆盖词法分析到垃圾回收全部细节。",
        chapters: manyChapters
      });

      const prompt = serializeL1DirectoryPrompt(index, { maxTokens: 1200, maxChars: 1200 });
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt.length).toBeLessThanOrEqual(1200);
      expect(estimateCompactPromptTokens(prompt)).toBeLessThanOrEqual(1200);
      expect(prompt).toContain("0:00:00");
      expect(prompt).toContain("5:00:00");
    });

    it("空索引返回空串；极窄自定义预算也不溢出", () => {
      expect(serializeL1DirectoryPrompt(null)).toBe("");
      const empty = buildL1VideoIndex({ bvid: "BV1e", cid: "1", subtitleSignature: "s", chapters: [] });
      expect(serializeL1DirectoryPrompt(empty)).toBe("");

      const index = buildL1VideoIndex({
        bvid: "BV1n",
        cid: "1",
        subtitleSignature: "s",
        globalSummary: "一段较长的视频简介内容用于测试极小预算边界。",
        chapters: Array.from({ length: 20 }, (_, i) => ({
          from: i * 60,
          to: (i + 1) * 60,
          title: `章节主题名称编号${i + 1}`
        }))
      });
      const narrow = serializeL1DirectoryPrompt(index, { maxTokens: 180, maxChars: 180 });
      expect(narrow.length).toBeLessThanOrEqual(180);
      expect(estimateCompactPromptTokens(narrow)).toBeLessThanOrEqual(180);
    });
  });

  describe("L1 内存缓存与 chrome.storage.local 本机持久化隔离（PRIVACY.md）", () => {
    it("写入后命中内存缓存免读 storage；清内存后可从 local 恢复，且绝不触碰 sync", async () => {
      const store = createL1IndexCacheStore({ maxMemoryEntries: 2 });
      const record = buildL1VideoIndex({
        bvid: "BV1save1",
        cid: "11",
        subtitleId: "sub1",
        subtitleSignature: "sig1",
        globalSummary: "测试持久化摘要",
        chapters: [{ from: 0, to: 60, title: "第一章" }]
      });
      const key = buildL1IndexCacheKey({
        bvid: "BV1save1",
        cid: "11",
        subtitleId: "sub1",
        subtitleSignature: "sig1"
      });

      expect(key.startsWith(L1_INDEX_CACHE_PREFIX)).toBe(true);
      const saveResult = await store.save(key, record);
      expect(saveResult.ok).toBe(true);

      expect(host.syncMap.size).toBe(0);
      expect(host.local.set).not.toHaveBeenCalled();

      const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
      const getArtifactSpy = vi.spyOn(defaultSubtitleIdbStore, "getAiArtifact");
      const memHit = await store.load(key);
      expect(memHit).toEqual(record);
      expect(getArtifactSpy).not.toHaveBeenCalled();

      store.clearMemory();
      const persistedHit = await store.load(key);
      expect(persistedHit).toEqual(record);
      expect(getArtifactSpy).toHaveBeenCalledWith(key);
      getArtifactSpy.mockRestore();

      await store.remove(key);
      expect(store.getMemory(key)).toBeNull();
      expect(await defaultSubtitleIdbStore.getAiArtifact(key)).toBeNull();
    });

    it("接入统一 LRU 淘汰：第 4 个视频写入不淘汰，100 视频对齐上限内保留", async () => {
      vi.useFakeTimers();
      const store = createL1IndexCacheStore();
      const saveAt = async (n: number) => {
        vi.setSystemTime(n * 1000);
        const bvid = `BV1s${n}`;
        await store.save(
          buildL1IndexCacheKey({ bvid, cid: "1", subtitleLang: "zh", subtitleSignature: `s${n}` }),
          buildL1VideoIndex({ bvid, cid: "1", subtitleLang: "zh", subtitleSignature: `s${n}`, chapters: [{ from: 0, to: 10, title: String(n) }] })
        );
      };

      await Promise.all([saveAt(1), saveAt(2), saveAt(3), saveAt(4)]);

      const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
      expect(await defaultSubtitleIdbStore.getAiArtifact(buildL1IndexCacheKey({ bvid: "BV1s1", cid: "1", subtitleLang: "zh", subtitleSignature: "s1" }))).not.toBeNull();
      expect(await defaultSubtitleIdbStore.getAiArtifact(buildL1IndexCacheKey({ bvid: "BV1s2", cid: "1", subtitleLang: "zh", subtitleSignature: "s2" }))).not.toBeNull();
      expect(await defaultSubtitleIdbStore.getAiArtifact(buildL1IndexCacheKey({ bvid: "BV1s3", cid: "1", subtitleLang: "zh", subtitleSignature: "s3" }))).not.toBeNull();
      expect(await defaultSubtitleIdbStore.getAiArtifact(buildL1IndexCacheKey({ bvid: "BV1s4", cid: "1", subtitleLang: "zh", subtitleSignature: "s4" }))).not.toBeNull();
    });

    it("内存缓存严格遵守 maxMemoryEntries 上限；缺少 bvid/cid 拒绝写盘", async () => {
      const store = createL1IndexCacheStore({ maxMemoryEntries: 2 });
      const r1 = buildL1VideoIndex({ bvid: "BV1m1", cid: "1", subtitleSignature: "s1", globalSummary: "1" });
      const r2 = buildL1VideoIndex({ bvid: "BV1m2", cid: "1", subtitleSignature: "s2", globalSummary: "2" });
      const r3 = buildL1VideoIndex({ bvid: "BV1m3", cid: "1", subtitleSignature: "s3", globalSummary: "3" });

      store.setMemory("k1", r1);
      store.setMemory("k2", r2);
      expect(store.getMemory("k1")).toEqual(r1);
      store.setMemory("k3", r3);

      expect(store.getMemory("k2")).toBeNull();
      expect(store.getMemory("k1")).toEqual(r1);
      expect(store.getMemory("k3")).toEqual(r3);

      const invalidSave = await store.save(
        "bad_key",
        buildL1VideoIndex({ bvid: "", cid: "", subtitleSignature: "s" })
      );
      expect(invalidSave.ok).toBe(false);
    });
  });

  describe("概览整份产物与 L1 目录统一身份、封包拆包及单趟读取", () => {
    it("buildClipOverviewIdentity 兼容 clipState 与 AiContext 两种字段名并产出逐字节一致的双族缓存键", () => {
      const body = [
        { from: 0, to: 10, content: "第一句字幕" },
        { from: 10, to: 20, content: "第二句字幕" }
      ];
      const timelineDesc = "00:00 开场\n00:10 深入";

      const fromClipState = buildClipOverviewIdentity({
        bvid: "BV1id001",
        cid: "888",
        description: timelineDesc,
        selectedSubtitleId: "sub-id",
        selectedSubtitleLang: "zh-CN",
        subtitleBody: body
      });
      const fromAiContext = buildClipOverviewIdentity({
        bvid: "BV1id001",
        cid: "888",
        videoDescription: timelineDesc,
        selectedSubtitleId: "sub-id",
        subtitleLang: "zh-CN",
        subtitleBody: body
      });

      expect(fromClipState.hasCacheIdentity).toBe(true);
      expect(fromClipState.signature).toBe(fromAiContext.signature);
      expect(fromClipState.finalKey).toBe(fromAiContext.finalKey);
      expect(fromClipState.l1Key).toBe(fromAiContext.l1Key);
      expect(fromClipState.finalKey.startsWith(ANALYSIS_FINAL_PREFIX)).toBe(true);
      expect(fromClipState.finalKey).toBe(
        buildAnalysisFinalCacheKey(
          { bvid: "BV1id001", cid: "888", selectedSubtitleId: "sub-id", subtitleLang: "zh-CN" },
          fromClipState.signature
        )
      );

      expect(buildClipOverviewIdentity({ bvid: "", cid: "888", subtitleBody: body }).hasCacheIdentity).toBe(false);
      expect(buildClipOverviewIdentity({ bvid: "BV1id001", cid: "888", subtitleBody: [] }).hasCacheIdentity).toBe(false);
    });

    it("unwrapL1IndexEnvelope 安全校验并拆包 L1 缓存封包", () => {
      const validRecord = buildL1VideoIndex({
        bvid: "BV1env1",
        cid: "1",
        subtitleSignature: "sig",
        globalSummary: "摘要"
      });
      expect(unwrapL1IndexEnvelope({ index: validRecord, timestamp: 1 })).toEqual(validRecord);
      expect(unwrapL1IndexEnvelope(null)).toBeNull();
      expect(unwrapL1IndexEnvelope("bad")).toBeNull();
      expect(unwrapL1IndexEnvelope({ index: { ...validRecord, schemaVersion: 999 } })).toBeNull();
    });

    it("saveAnalysisFinal/loadAnalysisFinal 与 readCachedClipOverviewArtifacts 复用内存 LRU 且不触碰 sync", async () => {
      const clipInput = {
        bvid: "BV1art1",
        cid: "77",
        description: "测试简介",
        selectedSubtitleId: "cc-1",
        selectedSubtitleLang: "en",
        subtitleBody: [{ from: 0, to: 5, content: "Hello world" }]
      };
      const identity = buildClipOverviewIdentity(clipInput);
      const analysis = {
        summary: "整片摘要",
        chapters: [{ from: 0, to: 5, title: "开篇", summary: "介绍" }],
        quotes: []
      };
      const l1Record = buildL1VideoIndex({
        bvid: "BV1art1",
        cid: "77",
        subtitleId: "cc-1",
        subtitleLang: "en",
        subtitleSignature: identity.signature,
        globalSummary: "L1 摘要"
      });

      const saveRes = await saveAnalysisFinal(identity.finalKey, analysis);
      expect(saveRes.ok).toBe(true);
      expect(host.syncMap.size).toBe(0);
      expect(await loadAnalysisFinal(identity.finalKey)).toEqual(analysis);

      await host.local.set({ [identity.l1Key]: { index: l1Record, timestamp: Date.now() } });
      host.local.get.mockClear();

      const firstArtifacts = await readCachedClipOverviewArtifacts(clipInput);
      expect(firstArtifacts).toEqual({ analysisFinal: analysis, l1Index: l1Record });
      expect(host.local.get).toHaveBeenCalledTimes(1);
      expect(host.local.get).toHaveBeenCalledWith([identity.l1Key]);
      expect(host.hasEntry(identity.l1Key)).toBe(false);

      host.local.get.mockClear();
      expect(await readCachedClipL1Index(clipInput)).toEqual(l1Record);
      expect(host.local.get).not.toHaveBeenCalled();

      const secondArtifacts = await readCachedClipOverviewArtifacts(clipInput);
      expect(secondArtifacts).toEqual({ analysisFinal: analysis, l1Index: l1Record });
      expect(host.local.get).not.toHaveBeenCalled();

      host.local.get.mockClear();
      expect(await readCachedClipOverviewArtifacts({ bvid: "", cid: "77", subtitleBody: [] })).toEqual({
        analysisFinal: null,
        l1Index: null
      });
      expect(await readCachedClipL1Index(null)).toBeNull();
      expect(host.local.get).not.toHaveBeenCalled();
    });
  });
});
