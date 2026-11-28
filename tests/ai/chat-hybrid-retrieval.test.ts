import { describe, expect, it, vi } from "vitest";
import {
  buildFastPathContext,
  detectInteractionAnchorPlan,
  doesPromptNeedVisualFrame,
  isLongVideoForHybridChat,
  isSimpleGreetingPrompt,
  mergeL0ContextWindows,
  parseL1RouterOutput,
  resolveLongVideoHybridContext,
  STAGE_B_TOTAL_SUBTITLE_MAX_CHARS
} from "../../extension/ai/chat-hybrid-retrieval.js";
import { buildMessages, formatDynamicTurnUserContent } from "../../extension/ai/context.js";
import { buildL1VideoIndex } from "../../extension/ai/l1-directory.js";
import { normalizeL0SubtitleLines } from "../../extension/ai/l0-bm25.js";
import { runLadderChat, type RunLadderChatDeps } from "../../extension/ai/ladder.js";
import { createExplainIntentController, setPendingExplainIntent } from "../../extension/reader/explain-intent.js";
import type { L0ContextWindow, L1VideoIndexCacheRecord } from "../../extension/ai/long-video-hybrid-types.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { ChatMessage } from "../../extension/ai/types.js";

function buildLongVideoFixture() {
  const rawBody: Array<{ from: number; to: number; content: string }> = [];
  for (let i = 0; i < 90; i += 1) {
    const from = i * 30;
    const to = from + 28;
    let content = `第 ${i} 句常规技术讲解内容`;
    if (i === 5) {
      content = "这一句专门介绍注意力机制中的 Softmax 数值稳定性问题";
    } else if (i === 18) {
      content = "现在来看板书上的 FlashAttention 分块矩阵计算图解";
    } else if (i === 42) {
      content = "这里演示用 WebAssembly SIMD 加速本地词法检索的性能对比图表";
    } else if (i === 72) {
      content = "最后总结长上下文 KV Cache 量化与显存回收的工程落地结论";
    }
    rawBody.push({ from, to, content });
  }
  const l0Lines = normalizeL0SubtitleLines(rawBody);
  const l1Index: L1VideoIndexCacheRecord = buildL1VideoIndex({
    bvid: "BV1hybridTest",
    cid: "1001",
    subtitleId: "sub-zh",
    subtitleLang: "zh-CN",
    subtitleSignature: "sig-hybrid",
    videoDuration: 2700,
    globalSummary: "本片系统拆解大模型注意力优化、WebAssembly 加速与 KV Cache 量化落地。",
    lines: l0Lines,
    chapters: [
      {
        from: 0,
        to: 900,
        title: "注意力数值稳定性与 FlashAttention",
        coreThesis: "介绍 Softmax 稳定性及 FlashAttention 分块矩阵板书推导",
        keyEntities: ["Softmax", "FlashAttention", "分块矩阵"]
      },
      {
        from: 900,
        to: 1800,
        title: "WebAssembly 本地词法检索加速",
        coreThesis: "利用 SIMD 加速本地分词与 BM25 索引构建",
        keyEntities: ["WebAssembly", "SIMD", "BM25"]
      },
      {
        from: 1800,
        to: 2700,
        title: "KV Cache 量化与工程总结",
        coreThesis: "通过量化压缩降低长上下文显存占用",
        keyEntities: ["KV Cache", "量化", "显存"]
      }
    ]
  });
  return { rawBody, l0Lines, l1Index };
}

describe("交互锚点免路由直通（Fast Path）", () => {
  it("划词解释意图（explain-selection）跳过路由，精确锚定目标行前后扩窗与所属 L1 章节摘要", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn();

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "请解释「FlashAttention 分块矩阵」在这句话里的含义",
      l1Index,
      interactionAnchor: {
        kind: "explain-selection",
        from: 540,
        lineContent: "现在来看板书上的 FlashAttention 分块矩阵计算图解",
        selection: "FlashAttention 分块矩阵"
      },
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(routeSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe("interaction-anchor");
    expect(result.anchorKind).toBe("explain-selection");
    expect(result.degraded).toBe(false);
    expect(result.coreTimestamp).toBe(540);
    expect(result.hybridRetrievalMarkdown).toContain("注意力数值稳定性与 FlashAttention");
    expect(result.hybridRetrievalMarkdown).toContain("→ [9:00] 现在来看板书上的 FlashAttention 分块矩阵计算图解");
    expect(result.hybridRetrievalMarkdown).toContain("划词：「FlashAttention 分块矩阵」");
    expect(result.windows.length).toBe(1);
    expect(result.windows[0].lines.some((l) => l.lineNumber === 18)).toBe(true);
  });

  it("显式时间戳提问跳过路由直通 L0 扩窗，支持多时间戳合并", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn();

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "21:00 和 36:00 分别讲了什么？",
      l1Index,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(routeSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe("interaction-anchor");
    expect(result.anchorKind).toBe("timestamp");
    expect(result.coreTimestamp).toBe(1260);
    expect(result.hybridRetrievalMarkdown).toContain("WebAssembly SIMD 加速本地词法检索的性能对比图表");
    expect(result.hybridRetrievalMarkdown).toContain("KV Cache 量化与显存回收的工程落地结论");
  });

  it("当前播放进度指代提问触发 playback-cursor 直通；宏观/指定章节提问不误触发", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();

    const cursorPlan = detectInteractionAnchorPlan({
      userPrompt: "刚才这里讲的图表是什么意思？",
      playbackCursorSeconds: 1265,
      l1Chapters: l1Index.chapters
    });
    expect(cursorPlan?.anchorKind).toBe("playback-cursor");
    expect(cursorPlan?.anchors[0].from).toBe(1265);

    const macroPlan = detectInteractionAnchorPlan({
      userPrompt: "总结一下这期视频的核心内容",
      playbackCursorSeconds: 1265,
      l1Chapters: l1Index.chapters
    });
    expect(macroPlan).toBeNull();

    const chapterPlan = detectInteractionAnchorPlan({
      userPrompt: "第3章最后是怎么收尾的？",
      playbackCursorSeconds: 1265,
      l1Chapters: l1Index.chapters
    });
    expect(chapterPlan).toBeNull();

    const routeSpy = vi.fn();
    const resolved = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "现在这里写的什么？",
      playbackCursorSeconds: 542,
      l1Index,
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });
    expect(routeSpy).not.toHaveBeenCalled();
    expect(resolved.anchorKind).toBe("playback-cursor");
    expect(resolved.hybridRetrievalMarkdown).toContain("FlashAttention 分块矩阵计算图解");
  });

  it("explain-intent 控制器在发送与追问时透传 interactionAnchor", async () => {
    setPendingExplainIntent({
      from: 540,
      content: "现在来看板书上的 FlashAttention 分块矩阵计算图解",
      selection: "FlashAttention 分块矩阵",
      createdAt: Date.now()
    });
    const sendPrompt = vi.fn<
      (text: string, options?: { interactionAnchor?: import("../../extension/ai/chat-hybrid-retrieval.js").InteractionAnchorHint }) => Promise<boolean>
    >(async () => true);
    const controller = createExplainIntentController({
      card: null,
      sendPrompt
    });

    await controller.consumeIfPending();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][1]).toEqual({
      interactionAnchor: {
        kind: "explain-selection",
        from: 540,
        lineContent: "现在来看板书上的 FlashAttention 分块矩阵计算图解",
        selection: "FlashAttention 分块矩阵"
      }
    });

    setPendingExplainIntent({
      from: 1260,
      content: "这里演示用 WebAssembly SIMD 加速",
      selection: "SIMD",
      explanation: "单指令多数据流加速技术。",
      createdAt: Date.now()
    });
    expect(controller.getPendingFollowUpAnchor()).toEqual({
      kind: "explain-selection",
      from: 1260,
      lineContent: "这里演示用 WebAssembly SIMD 加速",
      selection: "SIMD"
    });
  });
});

describe("双路字幕合并去重与两阶段单跳混合召回", () => {
  it("mergeL0ContextWindows 将重叠与相邻窗口按时间顺序去重合并，并严格遵守字符预算", () => {
    const { l0Lines } = buildLongVideoFixture();
    const winA: L0ContextWindow = {
      anchorLineNumber: 18,
      startLineNumber: 16,
      endLineNumber: 20,
      from: l0Lines[16].from,
      to: l0Lines[20].to,
      lines: l0Lines.slice(16, 21)
    };
    const winB: L0ContextWindow = {
      anchorLineNumber: 19,
      startLineNumber: 18,
      endLineNumber: 22,
      from: l0Lines[18].from,
      to: l0Lines[22].to,
      lines: l0Lines.slice(18, 23)
    };
    const winC: L0ContextWindow = {
      anchorLineNumber: 42,
      startLineNumber: 40,
      endLineNumber: 44,
      from: l0Lines[40].from,
      to: l0Lines[44].to,
      lines: l0Lines.slice(40, 45)
    };

    const merged = mergeL0ContextWindows(l0Lines, [[winC], [winA, winB]], {
      mergeGapSeconds: 2,
      maxInjectedChars: 5000
    });

    expect(merged.windows).toHaveLength(2);
    expect(merged.windows[0].startLineNumber).toBe(16);
    expect(merged.windows[0].endLineNumber).toBe(22);
    expect(merged.windows[0].lines.map((l) => l.lineNumber)).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(merged.windows[1].startLineNumber).toBe(40);
    expect(merged.windows[1].endLineNumber).toBe(44);
    expect(merged.truncated).toBe(false);

    const capped = mergeL0ContextWindows(l0Lines, [[winA, winB], [winC]], { maxInjectedChars: 120 });
    expect(capped.truncated).toBe(true);
    expect(capped.injectedChars).toBeLessThanOrEqual(120);

    const largeLines = normalizeL0SubtitleLines(
      Array.from({ length: 120 }, (_, i) => ({
        from: i * 10,
        to: i * 10 + 9,
        content: `L${i}_` + "长字幕文本".repeat(199)
      }))
    );
    const fullWin: L0ContextWindow = {
      anchorLineNumber: 0,
      startLineNumber: 0,
      endLineNumber: largeLines.length - 1,
      from: largeLines[0].from,
      to: largeLines[largeLines.length - 1].to,
      lines: largeLines
    };
    const defaultCapped = mergeL0ContextWindows(largeLines, [[fullWin]]);
    expect(defaultCapped.truncated).toBe(true);
    expect(defaultCapped.injectedChars).toBeLessThanOrEqual(STAGE_B_TOTAL_SUBTITLE_MAX_CHARS);
    expect(defaultCapped.injectedChars).toBeGreaterThan(STAGE_B_TOTAL_SUBTITLE_MAX_CHARS - 2000);
  });

  it("简单寒暄免路由直接进入直答", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn();

    expect(isSimpleGreetingPrompt("你好")).toBe(true);
    expect(isSimpleGreetingPrompt("FlashAttention 怎么算的")).toBe(false);

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "谢谢！",
      l1Index,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(routeSpy).not.toHaveBeenCalled();
    expect(result.mode).toBe("direct-answer");
    expect(result.windows).toEqual([]);
    expect(result.staticDirectoryMarkdown).toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).toBe("");
  });

  it("阶段 A 宏观问题标记 direct-answer 时不展开 L0，静态 L1 目录与动态召回块分离", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn(async (req: ChatCompletionInput) => {
      expect(req.stream).toBe(false);
      expect(req.thinkingLevel).toBe("off");
      return '<think>这是个宏观总结问题</think>\n```json\n{"mode":"direct-answer","ranges":[],"terms":[]}\n```';
    });

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "这期视频整体讲了哪几个部分？",
      l1Index,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("direct-answer");
    expect(result.degraded).toBe(false);
    expect(result.windows).toEqual([]);
    expect(result.staticDirectoryMarkdown).toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).toBe("");
  });

  it("阶段 A 细节问题选定 1~2 章节区间与补充词 → 阶段 B 与 BM25 结果按时间顺序去重合并", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn(async () =>
      JSON.stringify({
        mode: "expand",
        ranges: [{ from: "15:00", to: "30:00" }],
        terms: ["SIMD", "BM25"]
      })
    );

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "Softmax 稳定性和 SIMD 本地加速是怎么对比的？",
      l1Index,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("hybrid-single-hop");
    expect(result.degraded).toBe(false);
    const lineNumbers = result.windows.flatMap((w) => w.lines.map((l) => l.lineNumber));
    expect(lineNumbers).toContain(5);
    expect(lineNumbers).toContain(42);
    expect(new Set(lineNumbers).size).toBe(lineNumbers.length);
    for (let i = 1; i < lineNumbers.length; i += 1) {
      expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]);
    }
    expect(result.staticDirectoryMarkdown).toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).not.toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).toContain("召回的原始字幕片段（按时间顺序去重合并）");
  });

  it("parseL1RouterOutput 兼容 <think> 块、chapterIndex 与时间区间上限裁剪（最多 2 个区间）", () => {
    const { l1Index } = buildLongVideoFixture();
    const parsed = parseL1RouterOutput(
      '<think>分析目录</think>\n{"mode":"expand","ranges":[{"chapterIndex":0},{"from":"15:00","to":"30:00"},{"from":"30:00","to":"45:00"}],"terms":["A","B"]}',
      l1Index
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.plan.mode === "hybrid-single-hop") {
      expect(parsed.plan.chapterRanges).toHaveLength(2);
      expect(parsed.plan.chapterRanges[0]).toMatchObject({ from: 0, to: 900, chapterIndex: 0 });
      expect(parsed.plan.chapterRanges[1]).toMatchObject({ from: 900, to: 1800 });
      expect(parsed.plan.lexicalTerms).toEqual(["A", "B"]);
    }
  });
});

describe("路由频控限流、超时与非预期格式静默降级", () => {
  it("阶段 A 触发 HTTP 429 免费接口限流时静默降级为「L1 目录 + 本地 BM25 Top 扩窗」", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const rateLimitError = Object.assign(new Error("HTTP 429: rate limit exceeded"), { status: 429 });
    const routeSpy = vi.fn(async () => {
      throw rateLimitError;
    });

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "FlashAttention 分块矩阵怎么计算的？",
      l1Index,
      provider: { baseUrl: "https://api-inference.modelscope.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(result.mode).toBe("degraded-bm25");
    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe("router-rate-limited");
    expect(result.staticDirectoryMarkdown).toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).not.toContain("视频 L1 章节目录");
    expect(result.hybridRetrievalMarkdown).toContain("FlashAttention 分块矩阵计算图解");
  });

  it("阶段 A 路由请求超时时静默降级为「L1 目录 + 本地 BM25 Top 扩窗」，不报错卡死", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn(
      (req: ChatCompletionInput) =>
        new Promise<string>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "KV Cache 量化效果如何？",
      l1Index,
      routerTimeoutMs: 500,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(result.mode).toBe("degraded-bm25");
    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe("router-timeout");
    expect(result.hybridRetrievalMarkdown).toContain("KV Cache 量化与显存回收的工程落地结论");
  });

  it("阶段 A 返回非预期文本/乱码格式时静默降级为「L1 目录 + 本地 BM25 Top 扩窗」", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const routeSpy = vi.fn(async () => "抱歉，我无法输出 JSON，这里是一段乱七八糟的纯文本。");

    const result = await resolveLongVideoHybridContext({
      context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
      userPrompt: "Softmax 稳定性问题是什么？",
      l1Index,
      provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
      routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
    });

    expect(result.mode).toBe("degraded-bm25");
    expect(result.degraded).toBe(true);
    expect(result.degradeReason).toBe("router-invalid-output");
    expect(result.hybridRetrievalMarkdown).toContain("Softmax 数值稳定性问题");
  });

  it("用户主动中止（父 signal aborted）正常上抛中止错误，不吞掉停止意图", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const controller = new AbortController();
    const routeSpy = vi.fn(
      (req: ChatCompletionInput) =>
        new Promise<string>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          controller.abort();
        })
    );

    await expect(
      resolveLongVideoHybridContext({
        context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700 },
        userPrompt: "Softmax 稳定性",
        l1Index,
        signal: controller.signal,
        provider: { baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
        routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion
      })
    ).rejects.toMatchObject({ aborted: true });
  });
});

describe("runLadderChat 联动关键帧采样、思考强度与联网搜索", () => {
  it("isLongVideoForHybridChat 正确识别 >30 分钟或 >200k 字符长视频", () => {
    const { l0Lines } = buildLongVideoFixture();
    expect(isLongVideoForHybridChat(l0Lines, { videoDuration: 2700 })).toBe(true);
    expect(isLongVideoForHybridChat(normalizeL0SubtitleLines([{ from: 0, to: 10, content: "短视频" }]), { videoDuration: 300 })).toBe(false);
  });

  it("视觉/板书类提问复用召回核心时间戳触发关键帧采样，且与 thinkingLevel / webSearch 互不冲突", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const portMessages: Array<Record<string, unknown>> = [];
    const port = { postMessage: (m: unknown) => { portMessages.push(m as Record<string, unknown>); } };
    const streamCalls: Array<Record<string, unknown>> = [];
    const routeSpy = vi.fn(async () =>
      JSON.stringify({ mode: "expand", ranges: [{ from: "0:00", to: "15:00" }], terms: ["板书", "FlashAttention"] })
    );
    const captureCurrentVideoFrame = vi.fn(async (targetTime?: number) => [
      { image: { mime: "image/jpeg", data: "ZnJhbWUx" }, currentTime: (targetTime ?? 540) - 2 },
      { image: { mime: "image/jpeg", data: "ZnJhbWUy" }, currentTime: targetTime ?? 540 }
    ]);
    const webSearch = {
      maxToolCalls: 3,
      executeSearch: vi.fn(async () => ({ results: [], platform: "Tavily" }))
    };

    expect(doesPromptNeedVisualFrame("板书上写的 FlashAttention 矩阵公式是什么？")).toBe(true);

    await runLadderChat(
      {
        msg: {
          context: { bvid: "BV1hybridTest", cid: "1001", subtitleBody: rawBody, videoDuration: 2700, chapters: [] },
          history: [],
          prompt: "板书上写的 FlashAttention 矩阵公式是什么？",
          thinkingLevel: "high",
          images: [{ mime: "image/webp", data: "dXNlckltZw==" }]
        },
        provider: { id: "p1", baseUrl: "https://api.example.com/v1", model: "qwen-vl", apiKey: "sk" },
        port,
        signal: new AbortController().signal,
        webSearch,
        captureCurrentVideoFrame
      },
      {
        loadL1Index: vi.fn(async () => l1Index),
        routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion,
        streamChat: vi.fn(async (args) => {
          streamCalls.push(args as unknown as Record<string, unknown>);
          return { done: true as const };
        }),
        askCostGuard: vi.fn(async () => true)
      }
    );

    expect(captureCurrentVideoFrame).toHaveBeenCalledTimes(1);
    expect(captureCurrentVideoFrame.mock.calls[0][0]).toBe(540);
    const frameStatuses = portMessages.filter((m) => m.type === "tool-status" && m.tool === "capture_video_frame_at_time");
    expect(frameStatuses.map((m) => m.status)).toEqual(["searching", "done"]);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].thinkingLevel).toBe("high");
    expect(streamCalls[0].webSearch).toBe(webSearch);
    expect(streamCalls[0].captureCurrentVideoFrame).toBeUndefined();
    expect(streamCalls[0].userImages).toEqual([
      { mime: "image/webp", data: "dXNlckltZw==" },
      { mime: "image/jpeg", data: "ZnJhbWUx" },
      { mime: "image/jpeg", data: "ZnJhbWUy" }
    ]);
    const passedContext = streamCalls[0].context as Record<string, unknown>;
    expect(passedContext.subtitleBody).toEqual([]);
    expect(passedContext.hybridRetrievalMarkdown).toContain("FlashAttention 分块矩阵计算图解");
    expect(passedContext.frameContextNote).toContain("已联动视频关键帧采样");
  });

  it("超预算视频（>200k）走 Fast Path（划词/时间戳）时跳过成本护栏与 Map-Reduce，直接流式生成", async () => {
    const hugeBody = Array.from({ length: 210 }, (_, i) => ({
      from: i * 15,
      to: i * 15 + 14,
      content: i === 20 ? "关键锚点段落内容" : "填充字符".repeat(260)
    }));
    const askCostGuard = vi.fn(async () => false);
    const orchestrateMapReduce = vi.fn<NonNullable<RunLadderChatDeps["orchestrateMapReduce"]>>();
    const streamChat = vi.fn<NonNullable<RunLadderChatDeps["streamChat"]>>(async () => ({ done: true }));
    const routeSpy = vi.fn();

    await runLadderChat(
      {
        msg: {
          context: { bvid: "BV1hugeFast", cid: "1", subtitleBody: hugeBody, chapters: [] },
          history: [],
          prompt: "05:00 这段讲了什么？",
          thinkingLevel: "medium"
        },
        provider: { id: "p1", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk" },
        port: { postMessage: () => {} },
        signal: new AbortController().signal
      },
      {
        loadL1Index: vi.fn(async () => null),
        routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion,
        askCostGuard,
        orchestrateMapReduce,
        streamChat
      }
    );

    expect(askCostGuard).not.toHaveBeenCalled();
    expect(orchestrateMapReduce).not.toHaveBeenCalled();
    expect(routeSpy).not.toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(streamChat.mock.calls[0][0].context?.hybridRetrievalMarkdown).toContain("关键锚点段落内容");
  });
});

describe("KV 前缀缓存锁死与动态检索块后置（#28）", () => {
  it("formatDynamicTurnUserContent 按标签包裹动态召回字幕与帧说明，前置拼接至 userPrompt 之前", () => {
    expect(
      formatDynamicTurnUserContent({
        hybridRetrievalMarkdown: "### [2:30-3:00]\n[2:30] Softmax 稳定性",
        frameContextNote: "[已联动视频关键帧采样：02:30]",
        userPrompt: "这一步公式怎么推导？"
      })
    ).toBe(
      "<retrieved_subtitles>\n### [2:30-3:00]\n[2:30] Softmax 稳定性\n</retrieved_subtitles>\n\n<video_frame_context>\n[已联动视频关键帧采样：02:30]\n</video_frame_context>\n\n这一步公式怎么推导？"
    );

    expect(
      formatDynamicTurnUserContent({
        hybridRetrievalMarkdown: "   ",
        frameContextNote: "",
        userPrompt: "总结全片大纲"
      })
    ).toBe("总结全片大纲");
  });

  it("多轮连续追问同一长视频：system 与静态 L1 目录跨轮逐字节全等，第 N-1 到第 N 轮前序纯净历史切片全等，动态块仅落末条 user 消息", async () => {
    const { rawBody, l1Index } = buildLongVideoFixture();
    const baseVideoContext = {
      title: "长视频缓存压测",
      author: "测试UP",
      uploadDate: "2026-01-01",
      bvid: "BV1hybridTest",
      cid: "1001",
      subtitleBody: rawBody,
      videoDuration: 2700,
      chapters: []
    };
    const capturedContexts: Array<Record<string, unknown>> = [];
    const routeSpy = vi.fn(async (req: ChatCompletionInput) => {
      const promptText = String(req.messages[req.messages.length - 1]?.content || "");
      const currentQuestion = promptText.split("\n").find((line) => line.startsWith("当前用户问题：")) ?? promptText;
      if (currentQuestion.includes("总结全片")) {
        return JSON.stringify({ mode: "direct-answer", ranges: [], terms: [] });
      }
      if (currentQuestion.includes("SIMD")) {
        return JSON.stringify({ mode: "expand", ranges: [{ from: "15:00", to: "30:00" }], terms: ["SIMD"] });
      }
      return JSON.stringify({ mode: "expand", ranges: [{ from: "0:00", to: "15:00" }], terms: ["Softmax"] });
    });

    const turns = [
      { prompt: "Softmax 数值稳定性是怎么处理的？", reply: "通过减去最大值防止指数溢出。" },
      { prompt: "21:00 这里展示的 SIMD 图表说明什么？", reply: "展示了本地词法检索加速倍数。" },
      { prompt: "总结全片的核心结构", reply: "全片分为注意力、WASM 与 KV 量化三部分。" },
      { prompt: "再展开讲一下 SIMD 和 BM25 的关系", reply: "SIMD 加速分词和倒排打分计算。" }
    ];

    const persistedHistory: ChatMessage[] = [];
    const builtTurnMessages: ChatMessage[][] = [];

    for (const turn of turns) {
      await runLadderChat(
        {
          msg: {
            context: baseVideoContext,
            history: persistedHistory.slice(),
            prompt: turn.prompt,
            thinkingLevel: "off"
          },
          provider: { id: "p1", baseUrl: "https://api.example.com/v1", model: "qwen-plus", apiKey: "sk" },
          port: { postMessage: () => {} },
          signal: new AbortController().signal,
          captureCurrentVideoFrame: async (targetTime?: number) => [
            { image: { mime: "image/jpeg", data: "ZnJhbWU=" }, currentTime: targetTime ?? 1260 }
          ]
        },
        {
          loadL1Index: vi.fn(async () => l1Index),
          routeChatCompletion: routeSpy as unknown as typeof import("../../extension/ai/completion.js").chatCompletion,
          streamChat: vi.fn(async (args) => {
            capturedContexts.push((args.context ?? {}) as Record<string, unknown>);
            builtTurnMessages.push(
              buildMessages({
                context: args.context,
                userPrompt: args.userPrompt,
                history: args.history,
                images: args.userImages
              })
            );
            return { done: true as const };
          }),
          askCostGuard: vi.fn(async () => true)
        }
      );

      persistedHistory.push({ role: "user", content: turn.prompt });
      persistedHistory.push({ role: "assistant", content: turn.reply });
    }

    expect(builtTurnMessages).toHaveLength(4);

    for (let i = 0; i < builtTurnMessages.length; i += 1) {
      const sys = builtTurnMessages[i][0].content;
      expect(sys).toContain("视频 L1 章节目录");
      expect(sys).not.toContain("（暂无字幕）");
      expect(sys).not.toContain("<retrieved_subtitles>");
      expect(sys).not.toContain("<video_frame_context>");
      expect(sys).not.toContain("## 召回的原始字幕片段");
      expect(sys).not.toContain("Softmax 数值稳定性问题");
    }

    expect(builtTurnMessages[1][0].content).toBe(builtTurnMessages[0][0].content);
    expect(builtTurnMessages[2][0].content).toBe(builtTurnMessages[0][0].content);
    expect(builtTurnMessages[3][0].content).toBe(builtTurnMessages[0][0].content);

    for (let turnIndex = 2; turnIndex < builtTurnMessages.length; turnIndex += 1) {
      const turnNumber = turnIndex + 1;
      const prevMessages = builtTurnMessages[turnIndex - 1];
      const currMessages = builtTurnMessages[turnIndex];
      const cleanPrefixEndExclusive = 2 * turnNumber - 3;
      expect(JSON.stringify(currMessages.slice(0, cleanPrefixEndExclusive))).toBe(
        JSON.stringify(prevMessages.slice(0, cleanPrefixEndExclusive))
      );
      for (let h = 1; h < currMessages.length - 1; h += 1) {
        expect(currMessages[h].content).not.toContain("<retrieved_subtitles>");
        expect(currMessages[h].content).not.toContain("<video_frame_context>");
      }
    }

    expect(builtTurnMessages[0].at(-1)?.content).toContain("<retrieved_subtitles>");
    expect(builtTurnMessages[0].at(-1)?.content).toContain("Softmax 数值稳定性问题");
    expect(builtTurnMessages[1].at(-1)?.content).toContain("<retrieved_subtitles>");
    expect(builtTurnMessages[1].at(-1)?.content).toContain("<video_frame_context>");
    expect(builtTurnMessages[2].at(-1)?.content).toBe("总结全片的核心结构");
    expect(builtTurnMessages[3].at(-1)?.content).toContain("<retrieved_subtitles>");
    expect(builtTurnMessages[3].at(-1)?.content).toContain("WebAssembly SIMD 加速本地词法检索的性能对比图表");
    expect(capturedContexts[0].staticDirectoryMarkdown).toBe(capturedContexts[1].staticDirectoryMarkdown);
  });
});
