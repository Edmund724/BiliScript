import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { L0SubtitleLine, StateRelayCard } from "../../extension/ai/long-video-hybrid-types.js";

let analysisMod: typeof import("../../extension/ai/analysis.js");
let l1Mod: typeof import("../../extension/ai/l1-chapter-index.js");
let l0Mod: typeof import("../../extension/ai/l0-bm25.js");
let relayMod: typeof import("../../extension/ai/state-relay.js");
let storage: ChromeHost;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = installChromeHost();
  analysisMod = await import("../../extension/ai/analysis.js");
  l1Mod = await import("../../extension/ai/l1-chapter-index.js");
  l0Mod = await import("../../extension/ai/l0-bm25.js");
  relayMod = await import("../../extension/ai/state-relay.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeProvider() {
  return { baseUrl: "https://api-inference.modelscope.cn/v1", model: "Qwen/Qwen2.5-14B-Instruct", apiKey: "sk-ms" };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    title: "超长技术架构深度拆解",
    author: "UP 主",
    bvid: "BV1longRelay",
    cid: "888",
    selectedSubtitleId: "sub-asr",
    subtitleLang: "asr-zh",
    ...overrides
  };
}

function emitTokens(input: Pick<ChatCompletionInput, "onEvent">, text: string, step = 13): void {
  for (let i = 0; i < text.length; i += step) {
    input.onEvent?.({ type: "token", data: text.slice(i, i + step) });
  }
}

function buildTimedSubtitleBody(durationSec: number, stepSec = 15, prefix = "第"): Array<{ from: number; to: number; content: string }> {
  const out: Array<{ from: number; to: number; content: string }> = [];
  for (let t = 0, idx = 0; t < durationSec; t += stepSec, idx += 1) {
    out.push({
      from: t,
      to: Math.min(durationSec, t + stepSec - 1),
      content: `${prefix}${idx}句在 ${Math.floor(t / 60)} 分讲解了 Transformer 与 KV Cache 优化细节`
    });
  }
  return out;
}

describe("分流阈值与 10～15 分钟平滑窗口切分（对齐 5 分钟转写边界）", () => {
  it("30 分钟以内且 <=200k 字符走单次直通；60 分钟常规语速视频按 15 分钟对齐 300s 边界切窗", () => {
    const shortBody = buildTimedSubtitleBody(1200, 15);
    const shortDecision = relayMod.decideOverviewRelaySplit(shortBody);
    expect(shortDecision.shouldRelay).toBe(false);
    expect(shortDecision.windows).toEqual([]);

    const hourBody = buildTimedSubtitleBody(3600, 15);
    const longDecision = relayMod.decideOverviewRelaySplit(hourBody);
    expect(longDecision.shouldRelay).toBe(true);
    expect(longDecision.windows).toHaveLength(4);
    expect(longDecision.windows.map((w) => [w.fromSeconds, w.toSeconds])).toEqual([
      [0, 899],
      [900, 1799],
      [1800, 2699],
      [2700, 3599]
    ]);
    for (let i = 1; i < longDecision.windows.length; i += 1) {
      expect(longDecision.windows[i].fromSeconds % 300).toBe(0);
      expect(longDecision.windows[i].overlapLines.length).toBeGreaterThan(0);
    }
  });

  it("40 分钟视频（非 15m 整倍数）均分对齐 5 分钟网格，避免尾部出现几分钟碎窗", () => {
    const body40m = buildTimedSubtitleBody(2400, 20);
    const decision = relayMod.decideOverviewRelaySplit(body40m);
    expect(decision.shouldRelay).toBe(true);
    expect(decision.windows.map((w) => [w.fromSeconds, w.toSeconds])).toEqual([
      [0, 899],
      [900, 1499],
      [1500, 2399]
    ]);
  });

  it("每行字幕渲染包含明确 0-based 行号与 [M:SS] 时间戳标识", () => {
    const lines: L0SubtitleLine[] = [
      { lineNumber: 0, from: 0, to: 5, content: "开场白" },
      { lineNumber: 42, from: 630, to: 635, content: "关键转折点" }
    ];
    expect(relayMod.renderL0LinesWithNumbers(lines)).toBe("#0 [0:00] 开场白\n#42 [10:30] 关键转折点");
  });
});

describe("短视频单次直通与 L1 缓存顺带固化", () => {
  it("阈值以下短视频保持单次请求不变，并在完成后顺带写入 L1 章节索引缓存", async () => {
    const body = [
      { from: 0, to: 10, content: "大家好今天介绍本地 BM25 索引" },
      { from: 30, to: 42, content: "浏览器原生 Intl.Segmenter 零依赖实现中英文分词" },
      { from: 120, to: 135, content: "总结来说体积零膨胀才是最优解" }
    ];
    const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
      emitTokens(
        input,
        JSON.stringify({
          summary: "视频讲解零依赖本地词法索引的实现思路。",
          chapters: [
            { title: "动机介绍", timestampSeconds: 0, summary: "介绍背景" },
            { title: "核心总结", timestampSeconds: 120, summary: "强调零体积收益" }
          ],
          keyQuotes: [
            { quote: "浏览器原生 Intl.Segmenter 零依赖实现中英文分词", timestampSeconds: 30 }
          ]
        })
      );
      return { done: true, finishReason: "stop" } as const;
    });

    const result = await analysisMod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDuration: 150 }) },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.chapters).toHaveLength(2);
    expect(result.quotes).toEqual([{ from: 30, content: "浏览器原生 Intl.Segmenter 零依赖实现中英文分词" }]);

    const l1Key = l1Mod.buildL1IndexCacheKey({
      bvid: "BV1longRelay",
      cid: "888",
      subtitleId: "sub-asr",
      subtitleLang: "asr-zh",
      subtitleSignature: (await import("../../extension/subtitle/cache.js")).buildSubtitleSignature({
        lang: "asr-zh",
        subtitleId: "sub-asr",
        body
      })
    });
    const l1Index = await l1Mod.loadL1Index(l1Key);
    expect(l1Index).not.toBeNull();
    expect(l1Index?.globalSummary).toContain("零依赖");
    expect(l1Index?.quotes[0]).toMatchObject({ lineNumber: 1, chapterIndex: 0 });
    expect(storage.syncMap.size).toBe(0);
  });
});

describe("滑动状态卡接力、金句行号零失真回填与轻量收尾汇总", () => {
  it("串行接力传递约 100 Token 状态卡，金句按行号从 L0 精确回填原文，收尾仅消费 L1 与状态卡并固化 L1 缓存", async () => {
    const body = buildTimedSubtitleBody(2400, 20);
    body[10] = { from: 200, to: 215, content: "工具是人手的延伸，而状态卡是长程记忆的脊梁。" };
    body[60] = { from: 1200, to: 1215, content: "没有行号锚定的金句回填，迟早会在二次改写里走样。" };
    body[100] = { from: 2000, to: 2010, content: "第一句拼合测试，" };
    body[101] = { from: 2010, to: 2020, content: "第二句接续形成完整金句。" };

    const calls: ChatCompletionInput[] = [];
    const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
      calls.push(input);
      const system = input.messages[0]?.content ?? "";
      const user = input.messages.at(-1)?.content ?? "";

      if (system.includes("仅根据全片 L1 章节目录节点与最终主线状态卡")) {
        expect(user).not.toContain("#0 [0:00]");
        expect(user).toContain("全片 L1 章节目录：");
        expect(user).toContain("最终状态卡摘要：");
        expect(user).toContain("KV-Cache");
        emitTokens(input, JSON.stringify({ summary: "全片围绕状态卡接力与 L0/L1 混合检索展开，实现高保真长视频概览。" }));
        return { done: true, finishReason: "stop" } as const;
      }

      if (user.includes("第 1 / 3 段")) {
        expect(user).not.toContain("前序状态卡");
        emitTokens(
          input,
          JSON.stringify({
            chapters: [
              { title: "长视频瓶颈", timestampSeconds: 0, summary: "剖析切点断裂问题", keyEntities: ["状态卡", "KV-Cache"] }
            ],
            keyQuotes: [
              { startLine: 10, endLine: 10, hint: "工具是延伸状态卡是脊梁（模型改写版）" }
            ],
            nextStateCard: {
              rollingSummary: "已确立用滑动状态卡解决跨段语义断裂。",
              openThreads: ["如何保证金句不被改写"],
              confirmedEntities: ["KV-Cache", "State Card"]
            }
          })
        );
      } else if (user.includes("第 2 / 3 段")) {
        expect(user).toContain("前序状态卡");
        expect(user).toContain("已确立用滑动状态卡解决跨段语义断裂");
        expect(user).toContain("如何保证金句不被改写");
        expect(user).toContain("KV-Cache/State Card");
        emitTokens(
          input,
          JSON.stringify({
            chapters: [
              { title: "L0 行号锚定", timestampSeconds: 1200, summary: "提出行号回填机制", keyEntities: ["L0", "BM25"] }
            ],
            keyQuotes: [
              { startLine: 58, endLine: 58, hint: "没有行号锚定的金句回填，迟早会在改写里走样" }
            ],
            nextStateCard: {
              rollingSummary: "通过 L0 行号回填消除了二次改写失真。",
              openThreads: ["如何控制最终汇总耗时"],
              confirmedEntities: ["KV-Cache", "BM25"]
            }
          })
        );
      } else {
        expect(user).toContain("通过 L0 行号回填消除了二次改写失真");
        emitTokens(
          input,
          JSON.stringify({
            chapters: [
              { title: "L1 索引固化", timestampSeconds: 1800, summary: "直接由 L1 节点提炼全局脉络", keyEntities: ["L1索引"] }
            ],
            keyQuotes: [
              { startLine: 100, endLine: 101 }
            ],
            nextStateCard: {
              rollingSummary: "全片完成从窗口扫描到 L1 目录固化的闭环。",
              openThreads: [],
              confirmedEntities: ["KV-Cache", "BM25", "L1索引"]
            }
          })
        );
      }
      return { done: true, finishReason: "stop" } as const;
    });

    const result = await analysisMod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDuration: 2400 }) },
      { chatCompletion }
    );

    expect(chatCompletion).toHaveBeenCalledTimes(4);
    expect(result.summary).toBe("全片围绕状态卡接力与 L0/L1 混合检索展开，实现高保真长视频概览。");
    expect(result.chapters).toEqual([
      { from: 0, to: 1200, title: "长视频瓶颈", summary: "剖析切点断裂问题" },
      { from: 1200, to: 1800, title: "L0 行号锚定", summary: "提出行号回填机制" },
      { from: 1800, to: 2400, title: "L1 索引固化", summary: "直接由 L1 节点提炼全局脉络" }
    ]);
    expect(result.quotes).toEqual([
      { from: 200, content: "工具是人手的延伸，而状态卡是长程记忆的脊梁。" },
      { from: 1200, content: "没有行号锚定的金句回填，迟早会在二次改写里走样。" },
      { from: 2000, content: "第一句拼合测试，第二句接续形成完整金句。" }
    ]);

    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    const l1Keys = (await defaultSubtitleIdbStore.listAllAiArtifacts())
      .filter((a) => a.family === "biliscript_lvs_l1_index_")
      .map((a) => a.key);
    expect(l1Keys).toHaveLength(1);
    const l1 = await l1Mod.loadL1Index(l1Keys[0]);
    expect(l1?.chapters[0].keyEntities).toEqual(["状态卡", "KV-Cache"]);
    expect(l1?.chapters[0].quoteLineNumbers).toEqual([10]);
    expect(l1?.chapters[1].quoteLineNumbers).toEqual([60]);
    expect(l1?.chapters[2].quoteLineNumbers).toEqual([100]);
    expect(l1?.quotes.map((q) => q.lineNumber)).toEqual([10, 60, 100]);
    expect(storage.syncMap.size).toBe(0);
  });

  it("状态卡序列化保持紧凑有界（<= 220 字符 / 约 100 Token 上限，跨多段不膨胀）", () => {
    const bloatedCard: StateRelayCard = {
      windowIndex: 8,
      coveredUntilSeconds: 7200,
      coveredUntilLineNumber: 900,
      rollingSummary: "主线".repeat(120),
      activeTopic: { title: "超长跨段话题".repeat(5), from: 7100, thesisDraft: "草稿".repeat(40) },
      confirmedEntities: Array.from({ length: 20 }, (_, i) => `超长实体词_${i}_${"X".repeat(20)}`),
      openThreads: Array.from({ length: 10 }, (_, i) => `悬念_${i}_${"Y".repeat(30)}`),
      recentChapterTitles: ["一", "二", "三", "四", "五"],
      collectedQuoteCount: 12
    };
    const serialized = relayMod.serializeStateRelayCard(bloatedCard);
    expect(serialized.length).toBeLessThanOrEqual(220);
    expect(l1Mod.estimateCompactPromptTokens(serialized)).toBeLessThanOrEqual(160);
  });
});

describe("ModelScope / 小参数模型容错解析与降级兜底", () => {
  it("容忍 <think> 标签泄露、markdown 围栏、字段别名（sections/quotes/stateCard/L行号）与时间戳回退", () => {
    const allLines = l0Mod.normalizeL0SubtitleLines([
      { from: 0, to: 5, content: "开场介绍背景" },
      { from: 25, to: 35, content: "ModelScope 免费小模型常把思考过程写进正文" },
      { from: 50, to: 60, content: "需要容错解析保证链路不断" }
    ]);
    const window = {
      windowIndex: 0,
      fromSeconds: 0,
      toSeconds: 60,
      startLineNumber: 0,
      endLineNumber: 2,
      chars: 40,
      lines: allLines,
      overlapLines: []
    };

    const noisyOutput = `<think>我先思考一下分章和行号……</think>
好的，下面是分析结果：
\`\`\`json
{
  "sections": [
    { "name": "模型容错背景", "timestamp": "0:00", "thesis": "小模型输出不稳定", "entities": "ModelScope, JSON" }
  ],
  "quotes": [
    { "line": "L1", "quote": "ModelScope 小模型常把思考写进正文" },
    { "timestamp": "0:50", "text": "需要容错解析保证链路不断" }
  ],
  "stateCard": {
    "mainline": "已识别小模型容错诉求",
    "unresolved": ["如何应对完全非JSON输出"],
    "terms": ["ModelScope"]
  }
}
\`\`\`
希望能帮到您！`;

    const parsed = relayMod.parseStateRelayOutput(noisyOutput, {
      allLines,
      window,
      previousStateCard: null
    });

    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]).toMatchObject({
      title: "模型容错背景",
      from: 0,
      coreThesis: "小模型输出不稳定",
      keyEntities: ["ModelScope", "JSON"]
    });
    expect(parsed.quotes).toEqual([
      { from: 25, content: "ModelScope 免费小模型常把思考过程写进正文", lineNumber: 1, chapterIndex: 0 },
      { from: 50, content: "需要容错解析保证链路不断", lineNumber: 2, chapterIndex: 0 }
    ]);
    expect(parsed.nextStateCard.rollingSummary).toBe("已识别小模型容错诉求");
    expect(parsed.nextStateCard.confirmedEntities).toContain("ModelScope");
  });

  it("完全非 JSON 的 Markdown 纯文本响应触发启发式兜底解析，不抛错中断", () => {
    const allLines = l0Mod.normalizeL0SubtitleLines([
      { from: 900, to: 910, content: "进入第二部分讨论架构演进" },
      { from: 930, to: 940, content: "先跑通端到端再做局部微调" }
    ]);
    const window = {
      windowIndex: 1,
      fromSeconds: 900,
      toSeconds: 940,
      startLineNumber: 0,
      endLine: 1,
      endLineNumber: 1,
      chars: 25,
      lines: allLines,
      overlapLines: []
    };
    const prevCard: StateRelayCard = {
      windowIndex: 0,
      coveredUntilSeconds: 900,
      coveredUntilLineNumber: 0,
      rollingSummary: "第一部分核心论点",
      confirmedEntities: ["架构演进"],
      openThreads: ["微调策略"],
      recentChapterTitles: ["开篇"],
      collectedQuoteCount: 1
    };

    const nonJsonOutput = `以下是本段整理：
- 15:00 架构演进实战：介绍工程落地顺序
- #L1 「先跑通端到端再做微调」`;

    const parsed = relayMod.parseStateRelayOutput(nonJsonOutput, {
      allLines,
      window,
      previousStateCard: prevCard
    });

    expect(parsed.usedFallbackParser).toBe(true);
    expect(parsed.chapters[0]).toMatchObject({
      title: "架构演进实战",
      from: 900,
      coreThesis: "介绍工程落地顺序"
    });
    expect(parsed.quotes[0]).toMatchObject({
      lineNumber: 1,
      content: "先跑通端到端再做局部微调"
    });
    expect(parsed.nextStateCard.confirmedEntities).toContain("架构演进");
    expect(parsed.nextStateCard.openThreads).toEqual(["微调策略"]);
  });

  it("接力过程中某窗口网络报错或收尾返回非 JSON 纯文本，整体仍稳健产出一份完整概览", async () => {
    const body = buildTimedSubtitleBody(2400, 20);
    const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
      const system = input.messages[0]?.content ?? "";
      const user = input.messages.at(-1)?.content ?? "";
      if (system.includes("仅根据全片 L1 章节目录节点与最终主线状态卡")) {
        emitTokens(input, "这是一份小模型直接以纯文本返回的整片脉络总结。");
        return { done: true, finishReason: "stop" } as const;
      }
      if (user.includes("第 2 / 3 段")) {
        throw new Error("HTTP 429: ModelScope rate limited");
      }
      if (user.includes("第 1 / 3 段")) {
        emitTokens(
          input,
          JSON.stringify({
            chapters: [{ title: "第一窗", timestampSeconds: 0, summary: "首窗内容" }],
            keyQuotes: [{ startLine: 2, endLine: 2 }],
            nextStateCard: { rollingSummary: "首窗主线", confirmedEntities: ["核心词"] }
          })
        );
      } else {
        expect(user).toContain("首窗主线");
        expect(user).toContain("核心词");
        emitTokens(
          input,
          JSON.stringify({
            chapters: [{ title: "第三窗", timestampSeconds: 1500, summary: "末窗内容" }],
            keyQuotes: [{ startLine: 80, endLine: 80 }],
            nextStateCard: { rollingSummary: "末窗收束主线", confirmedEntities: ["核心词"] }
          })
        );
      }
      return { done: true, finishReason: "stop" } as const;
    });

    const result = await analysisMod.runOverviewAnalysis(
      { provider: makeProvider(), context: makeContext({ subtitleBody: body, videoDuration: 2400 }) },
      { chatCompletion }
    );

    expect(result.summary).toBe("这是一份小模型直接以纯文本返回的整片脉络总结。");
    expect(result.summaryFailed).toBe(false);
    expect(result.chapters.map((c) => c.title)).toEqual(["第一窗", "第三窗"]);
    expect(result.failedRanges).toEqual([{ from: 900, to: 1499 }]);
    expect(result.quotes).toHaveLength(2);
  });
});
