import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPACT_BATCH_TURNS,
  COMPACT_HARD_FALLBACK_TURNS,
  COMPACT_MAX_TOKENS,
  COMPACT_SUMMARY_MAX_CHARS,
  COMPACT_TRIGGER_TURNS,
  FOLDED_TOOL_RESULT_PLACEHOLDER,
  SUMMARY_ANCHOR_ASSISTANT_ACK,
  SUMMARY_ANCHOR_USER_PREFIX,
  foldHistoricalToolResults,
  isCompleteUserTurnBoundary,
  planConversationCompaction,
  sliceActiveHistoryWithFallback,
  synthesizeCompactedSummary
} from "../../extension/ai/compaction.js";
import { buildMessages } from "../../extension/ai/context.js";
import { chatCompletion } from "../../extension/ai/completion.js";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { geminiAdapter } from "../../extension/ai/adapters/gemini.js";
import { openaiAdapter } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import type { ChatMessage, ConversationSummaryAnchor } from "../../extension/ai/types.js";
import { createOffscreenLifetime, DEFAULT_LIGHT_IDLE_MS } from "../../extension/entry/offscreen-lifecycle.js";
import { attachOffscreenChatPort } from "../../extension/entry/offscreen-chat-port.js";
import { createSubtitleBodySlot } from "../../extension/entry/offscreen-subtitle-slot.js";
import { createSubtitleIdbStore } from "../../extension/subtitle/idb-store.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import { createFakeIdbEnvironment } from "../helpers/fake-idb.js";

function buildTurns(count: number, prefix = "T"): Array<ChatMessage & { id: string }> {
  const out: Array<ChatMessage & { id: string }> = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(
      { id: `${prefix}${i}-u`, role: "user", content: `${prefix}${i} 提问` },
      { id: `${prefix}${i}-a`, role: "assistant", content: `${prefix}${i} 回答` }
    );
  }
  return out;
}

function makeMockPort() {
  const posted: unknown[] = [];
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    name: "offscreen-chat",
    postMessage: vi.fn((msg: unknown) => {
      posted.push(msg);
    }),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((fn: (msg: unknown) => void) => {
        messageListeners.push(fn);
      })
    },
    onDisconnect: {
      addListener: vi.fn((fn: () => void) => {
        disconnectListeners.push(fn);
      })
    }
  };
  return {
    port: port as unknown as chrome.runtime.Port,
    posted,
    emitMessage: (msg: unknown) => {
      for (const fn of messageListeners) fn(msg);
    },
    emitDisconnect: () => {
      for (const fn of disconnectListeners) fn();
    }
  };
}

describe("Gemini 原生 temperature 请求体修复（#29）", () => {
  it("Gemini 原生协议将 temperature 放入 generationConfig.temperature 且不写顶层字段", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "归档结论" }] } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const out = await chatCompletion({
      provider: {
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
        model: "gemini-2.5-flash"
      },
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "请摘要" }
      ],
      stream: false,
      thinkingLevel: "off",
      maxTokens: 512,
      temperature: 0,
      fetchImpl
    });

    expect(out).toBe("归档结论");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty("temperature");
    expect((capturedBody as unknown as { generationConfig?: Record<string, unknown> }).generationConfig?.temperature).toBe(0);
    expect((capturedBody as unknown as { generationConfig?: Record<string, unknown> }).generationConfig?.maxOutputTokens).toBe(512);
  });

  it("OpenAI 与 Anthropic 保持顶层 temperature 字段", () => {
    const openaiWire = planThinkingWire({ protocol: "openai", model: "gpt-4o", level: "off", stream: false, probe: false });
    const openaiBody = openaiAdapter.buildBody({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinkingWire: openaiWire,
      maxTokens: 512,
      temperature: 0
    });
    expect(openaiBody.temperature).toBe(0);

    const anthropicWire = planThinkingWire({
      protocol: "anthropic",
      model: "claude-sonnet-4-5",
      level: "off",
      stream: false,
      probe: false
    });
    const anthropicBody = anthropicAdapter.buildBody({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      thinkingWire: anthropicWire,
      maxTokens: 512,
      temperature: 0
    });
    expect(anthropicBody.temperature).toBe(0);
  });
});

describe("回合边界对齐、滚动摘要合成、前缀稳定性与 16 轮硬裁剪兜底", () => {
  it("第 1–11 轮不触发压缩；第 12 轮按完整用户回合边界归并最早 8 轮且绝不切在 tool_calls 与 tool 之间", () => {
    expect(COMPACT_TRIGGER_TURNS).toBe(12);
    expect(COMPACT_BATCH_TURNS).toBe(8);
    expect(COMPACT_HARD_FALLBACK_TURNS).toBe(16);

    expect(planConversationCompaction(buildTurns(11))).toBeNull();

    const turnsWithTools: Array<ChatMessage & { id: string }> = [];
    for (let i = 1; i <= 12; i += 1) {
      if (i === 8) {
        turnsWithTools.push(
          {
            id: "t8-u",
            role: "user",
            content: "T8 搜索",
            images: [{ mime: "image/jpeg", data: "BIG_BASE64_PAYLOAD" }]
          },
          {
            id: "t8-a-tc",
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_8", type: "function", function: { name: "web_search", arguments: "{\"query\":\"q8\"}" } }]
          },
          {
            id: "t8-tool",
            role: "tool",
            tool_call_id: "call_8",
            content: "X".repeat(800)
          },
          { id: "t8-a-final", role: "assistant", content: "T8 最终结论" }
        );
      } else {
        turnsWithTools.push(
          { id: `t${i}-u`, role: "user", content: `T${i} 提问` },
          { id: `t${i}-a`, role: "assistant", content: `T${i} 回答` }
        );
      }
    }

    expect(isCompleteUserTurnBoundary(turnsWithTools, 15)).toBe(false);
    expect(isCompleteUserTurnBoundary(turnsWithTools, 16)).toBe(false);
    expect(isCompleteUserTurnBoundary(turnsWithTools, 17)).toBe(false);
    expect(isCompleteUserTurnBoundary(turnsWithTools, 18)).toBe(true);

    const plan = planConversationCompaction(turnsWithTools);
    expect(plan).not.toBeNull();
    expect(plan!.coveredMessageCount).toBe(18);
    expect(turnsWithTools[plan!.coveredMessageCount].id).toBe("t9-u");
    expect(plan!.expectedBoundaryContent).toBe("T8 最终结论");
    expect(plan!.expectedCoveredMessageIds).toHaveLength(18);
    expect(plan!.batchMessages.some((m) => m.content.includes("BIG_BASE64_PAYLOAD"))).toBe(false);
    expect(plan!.batchMessages.some((m) => m.content.includes("[附带图片]"))).toBe(true);
    expect(plan!.batchMessages.some((m) => m.content.includes("X".repeat(100)))).toBe(false);
  });

  it("synthesizeCompactedSummary 使用 thinkingLevel=off / maxTokens=512 / temperature=0 并约束 <= 300 字", async () => {
    const plan = planConversationCompaction(buildTurns(12))!;
    const complete = vi.fn(async () => "```text\n" + "核".repeat(420) + "\n```");

    const anchor = await synthesizeCompactedSummary({
      provider: { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
      plan,
      complete,
      now: () => 99_000
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: false,
        thinkingLevel: "off",
        maxTokens: COMPACT_MAX_TOKENS,
        temperature: 0,
        retries: 0
      })
    );
    expect(anchor).toEqual({
      text: "核".repeat(COMPACT_SUMMARY_MAX_CHARS),
      coveredMessageCount: 16,
      updatedAt: 99_000
    });
  });

  it("第 13–19 轮构造请求的归档摘要问答对与未归档前 4 轮前缀逐字节稳定", () => {
    const base12 = buildTurns(12);
    const anchor: ConversationSummaryAnchor = {
      text: "已确认结论：视频核心讲解 KV Cache 前缀稳定性，重点在 03:15 与 08:40。",
      coveredMessageCount: 16,
      updatedAt: 50_000
    };
    const context = {
      title: "KV 缓存解析",
      author: "UP主",
      uploadDate: "2026-01-01",
      subtitleBody: [{ from: 0, to: 10, content: "字幕正文" }]
    };

    const prefixes: string[] = [];
    const rollingHistory: ChatMessage[] = [...base12];

    for (let turn = 13; turn <= 19; turn += 1) {
      const built = buildMessages({
        context,
        history: rollingHistory,
        summaryAnchor: anchor,
        userPrompt: `第 ${turn} 轮追问`
      });

      expect(built[1]).toEqual({
        role: "user",
        content: `${SUMMARY_ANCHOR_USER_PREFIX}${anchor.text}`
      });
      expect(built[2]).toEqual({
        role: "assistant",
        content: SUMMARY_ANCHOR_ASSISTANT_ACK
      });
      expect(built[3].content).toBe("T9 提问");
      expect(built[10].content).toBe("T12 回答");

      prefixes.push(JSON.stringify(built.slice(0, 11)));

      rollingHistory.push(
        { role: "user", content: `第 ${turn} 轮追问` },
        { role: "assistant", content: `第 ${turn} 轮回答` }
      );
    }

    expect(new Set(prefixes).size).toBe(1);
  });

  it("后台摘要失败无 anchor 时：15 轮保留原文，16 轮一次性硬裁剪 8 轮（完整回合边界），16–23 轮前缀稳定", () => {
    const turns15 = buildTurns(15);
    const slice15 = sliceActiveHistoryWithFallback(turns15, null);
    expect(slice15.hardTrimmedTurns).toBe(0);
    expect(slice15.activeRawHistory).toHaveLength(30);

    const turns16 = buildTurns(16);
    const slice16 = sliceActiveHistoryWithFallback(turns16, null);
    expect(slice16.hardTrimmedTurns).toBe(8);
    expect(slice16.activeRawHistory).toHaveLength(16);
    expect(slice16.activeRawHistory[0].content).toBe("T9 提问");

    const turns23 = buildTurns(23);
    const slice23 = sliceActiveHistoryWithFallback(turns23, null);
    expect(slice23.hardTrimmedTurns).toBe(8);
    expect(slice23.activeRawHistory[0].content).toBe("T9 提问");

    const turns24 = buildTurns(24);
    const slice24 = sliceActiveHistoryWithFallback(turns24, null);
    expect(slice24.hardTrimmedTurns).toBe(16);
    expect(slice24.activeRawHistory[0].content).toBe("T17 提问");
  });
});

describe("历史工具结果折叠（Tool Result Clearing）与三协议合法性", () => {
  it("超过最近 2 轮且 > 300 字的 tool 结果动态折叠（不篡改原记录），最近 2 轮与短结果原样保留，三协议请求体 100% 合法", () => {
    const oldLongPayload = JSON.stringify({ results: Array.from({ length: 12 }, (_, i) => ({ title: `旧结果${i}`, snippet: "很长的内容".repeat(8) })) });
    const oldShortPayload = "{\"ok\":true}";
    const recent2LongPayload = "近两轮搜索原文".repeat(80);
    const recent1LongPayload = "最近一轮热评原文".repeat(80);
    expect(oldLongPayload.length).toBeGreaterThan(300);
    expect(oldShortPayload.length).toBeLessThanOrEqual(300);

    const history: ChatMessage[] = [
      { role: "user", content: "第 1 轮：查背景" },
      {
        role: "assistant",
        content: "",
        thoughtSignature: "gem-sig-1",
        thinkingBlocks: [{ type: "thinking", thinking: "思考过程 1", signature: "anth-sig-1" }],
        tool_calls: [
          { id: "call_old_long", type: "function", function: { name: "web_search", arguments: "{\"query\":\"背景\"}" } },
          { id: "call_old_short", type: "function", function: { name: "web_search", arguments: "{\"query\":\"简短\"}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_old_long", content: oldLongPayload },
      { role: "tool", tool_call_id: "call_old_short", content: oldShortPayload },
      { role: "assistant", content: "第 1 轮结论" },

      { role: "user", content: "第 2 轮：查近况" },
      {
        role: "assistant",
        content: "",
        thoughtSignature: "gem-sig-2",
        thinkingBlocks: [{ type: "thinking", thinking: "思考过程 2", signature: "anth-sig-2" }],
        tool_calls: [{ id: "call_recent_2", type: "function", function: { name: "web_search", arguments: "{\"query\":\"近况\"}" } }]
      },
      { role: "tool", tool_call_id: "call_recent_2", content: recent2LongPayload },
      { role: "assistant", content: "第 2 轮结论" },

      { role: "user", content: "第 3 轮：看热评" },
      {
        role: "assistant",
        content: "",
        thoughtSignature: "gem-sig-3",
        tool_calls: [{ id: "call_recent_1", type: "function", function: { name: "fetch_hot_comments", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "call_recent_1", content: recent1LongPayload },
      { role: "assistant", content: "第 3 轮结论" }
    ];

    const foldedStandalone = foldHistoricalToolResults(history);
    expect(foldedStandalone[2].content).toBe(FOLDED_TOOL_RESULT_PLACEHOLDER);
    expect(history[2].content).toBe(oldLongPayload);

    const anchor: ConversationSummaryAnchor = {
      text: "前序讨论了架构演进。",
      coveredMessageCount: 2,
      updatedAt: 1000
    };
    const fullHistory: ChatMessage[] = [
      { role: "user", content: "归档轮提问" },
      { role: "assistant", content: "归档轮回答" },
      ...history
    ];

    const messages = buildMessages({
      context: { title: "测试视频", subtitleBody: [{ from: 0, to: 5, content: "字幕" }] },
      history: fullHistory,
      summaryAnchor: anchor,
      userPrompt: "第 4 轮追问",
      includeToolHistory: true
    });

    const oldLongToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_old_long");
    const oldShortToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_old_short");
    const recent2ToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_recent_2");
    const recent1ToolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_recent_1");
    const oldAssistantToolMsg = messages.find(
      (m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === "call_old_long")
    );

    expect(oldLongToolMsg?.content).toBe(FOLDED_TOOL_RESULT_PLACEHOLDER);
    expect(oldShortToolMsg?.content).toBe(oldShortPayload);
    expect(recent2ToolMsg?.content).toBe(recent2LongPayload);
    expect(recent1ToolMsg?.content).toBe(recent1LongPayload);
    expect(oldAssistantToolMsg?.thoughtSignature).toBe("gem-sig-1");
    expect(oldAssistantToolMsg?.thinkingBlocks).toEqual([
      { type: "thinking", thinking: "思考过程 1", signature: "anth-sig-1" }
    ]);
    expect(fullHistory[4].content).toBe(oldLongPayload);

    const openaiBody = openaiAdapter.buildBody({
      model: "gpt-4o",
      messages,
      stream: true,
      thinkingWire: planThinkingWire({ protocol: "openai", model: "gpt-4o", level: "off", stream: true, probe: false })
    });
    const openaiMsgs = openaiBody.messages as Array<{ role: string; tool_call_id?: string; content: string }>;
    expect(openaiMsgs.find((m) => m.tool_call_id === "call_old_long")?.content).toBe(FOLDED_TOOL_RESULT_PLACEHOLDER);

    const anthropicBody = anthropicAdapter.buildBody({
      model: "claude-sonnet-4-5",
      messages,
      stream: true,
      thinkingWire: planThinkingWire({ protocol: "anthropic", model: "claude-sonnet-4-5", level: "medium", stream: true, probe: false })
    });
    const anthMsgs = anthropicBody.messages as Array<{ role: string; content: unknown }>;
    for (let i = 1; i < anthMsgs.length; i += 1) {
      expect(anthMsgs[i].role).not.toBe(anthMsgs[i - 1].role);
    }
    const anthAssistantWithThinking = anthMsgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "thinking")
    );
    expect(anthAssistantWithThinking).toBeDefined();
    expect((anthAssistantWithThinking!.content as Array<{ type: string; signature?: string }>)[0]).toEqual({
      type: "thinking",
      thinking: "思考过程 1",
      signature: "anth-sig-1"
    });
    const anthToolResultMsg = anthMsgs.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b: { tool_use_id?: string }) => b.tool_use_id === "call_old_long")
    );
    expect(
      (anthToolResultMsg!.content as Array<{ tool_use_id?: string; content?: string }>).find(
        (b) => b.tool_use_id === "call_old_long"
      )?.content
    ).toBe(FOLDED_TOOL_RESULT_PLACEHOLDER);

    const geminiBody = geminiAdapter.buildBody({
      model: "gemini-3-pro",
      messages,
      stream: true,
      thinkingWire: planThinkingWire({ protocol: "gemini", model: "gemini-3-pro", level: "low", stream: true, probe: false })
    });
    const gemContents = geminiBody.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(gemContents[0].role).toBe("user");
    expect(gemContents[1].role).toBe("model");
    for (let i = 1; i < gemContents.length; i += 1) {
      expect(gemContents[i].role).not.toBe(gemContents[i - 1].role);
    }
    const gemOldToolResp = gemContents
      .flatMap((c) => c.parts)
      .find((p) => (p.functionResponse as { id?: string } | undefined)?.id === "call_old_long");
    expect((gemOldToolResp?.functionResponse as { response?: { output?: string } })?.response?.output).toBe(
      FOLDED_TOOL_RESULT_PLACEHOLDER
    );
  });
});

describe("Offscreen 保活租约（lifetime.withTask）与延迟回写并发安全", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("压缩期间持有 lifetime.withTask 租约阻止 requestSelfClose，且并发第 13 轮写入零丢失", async () => {
    vi.useFakeTimers();
    const { factory } = createFakeIdbEnvironment();
    const store = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-29-offscreen-compact" });
    const cacheHandler = createSubtitleCacheHandler(store);

    const turns12 = buildTurns(12);
    await store.upsertConversationAtomic({
      conversation: {
        id: "conv-compact-1",
        title: "测试",
        contextKey: "video:BV129|1",
        contextTitle: "测试",
        contextUrl: "https://www.bilibili.com/video/BV129",
        isVideoContext: true,
        createdAt: 1000,
        updatedAt: 2000,
        contextRef: { site: "bilibili", bvid: "BV129", cid: "1" },
        messages: turns12
      }
    });

    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        sendMessage: vi.fn(async (message: Record<string, unknown>) => {
          if (message.type === "resolve-ai-provider") {
            return {
              ok: true,
              provider: { id: "p1", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
              apiKey: "secret-key"
            };
          }
          if (message.type === "check-provider-origin") {
            return { granted: true, status: "granted" };
          }
          if (message.type === "subtitle-cache") {
            return await new Promise((resolve) => {
              cacheHandler(message as never, {}, resolve);
            });
          }
          return { ok: false };
        })
      }
    });

    const closeSelf = vi.fn();
    const lifetime = createOffscreenLifetime({
      closeSelf,
      lightIdleMs: DEFAULT_LIGHT_IDLE_MS,
      lightTabCheckDelayMs: 1500
    });
    const mockPort = makeMockPort();
    lifetime.trackPort(mockPort.port);

    let resolveLlm!: (anchor: ConversationSummaryAnchor) => void;
    const llmPromise = new Promise<ConversationSummaryAnchor>((resolve) => {
      resolveLlm = resolve;
    });
    const loadCompaction = vi.fn(async () => async () => llmPromise);

    attachOffscreenChatPort(mockPort.port, {
      subtitleSlot: createSubtitleBodySlot(),
      loadLadder: async () => vi.fn(async () => ({})),
      withTask: (run) => lifetime.withTask(run),
      loadCompaction
    });

    const plan = planConversationCompaction(turns12)!;
    mockPort.emitMessage({
      action: "compact-history",
      conversationId: "conv-compact-1",
      providerId: "p1",
      model: "gemini-2.5-flash",
      previousSummaryText: plan.previousSummaryText,
      batchMessages: plan.batchMessages,
      coveredMessageCount: plan.coveredMessageCount,
      expectedCoveredMessageIds: plan.expectedCoveredMessageIds,
      expectedBoundaryContent: plan.expectedBoundaryContent
    });

    await Promise.resolve();
    await Promise.resolve();

    mockPort.emitDisconnect();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIGHT_IDLE_MS + 5000);
    expect(closeSelf).not.toHaveBeenCalled();

    const turns13 = [
      ...turns12,
      { id: "T13-u", role: "user", content: "第 13 轮并发提问" },
      { id: "T13-a", role: "assistant", content: "第 13 轮并发回答" }
    ];
    await store.upsertConversationAtomic({
      conversation: {
        id: "conv-compact-1",
        title: "测试",
        contextKey: "video:BV129|1",
        contextTitle: "测试",
        contextUrl: "https://www.bilibili.com/video/BV129",
        isVideoContext: true,
        createdAt: 1000,
        updatedAt: 3000,
        contextRef: { site: "bilibili", bvid: "BV129", cid: "1" },
        messages: turns13
      }
    });

    resolveLlm({
      text: "前 8 轮结构化摘要",
      coveredMessageCount: 16,
      updatedAt: 2500
    });

    await vi.waitFor(async () => {
      const saved = await store.getConversation("conv-compact-1");
      expect((saved as { summaryAnchor?: ConversationSummaryAnchor } | null)?.summaryAnchor?.text).toBe("前 8 轮结构化摘要");
    });

    const reloaded = (await store.getConversation("conv-compact-1")) as unknown as {
      messages: Array<{ id: string; content: string }>;
      summaryAnchor?: ConversationSummaryAnchor;
    };
    expect(reloaded.messages).toHaveLength(26);
    expect(reloaded.messages[24].content).toBe("第 13 轮并发提问");
    expect(reloaded.messages[25].content).toBe("第 13 轮并发回答");
    expect(reloaded.summaryAnchor).toEqual({
      text: "前 8 轮结构化摘要",
      coveredMessageCount: 16,
      updatedAt: 2500
    });

    await vi.advanceTimersByTimeAsync(1600);
    expect(closeSelf).toHaveBeenCalledWith({
      reason: "no-bilibili-tabs",
      onlyIfNoBilibiliTabs: true
    });
    lifetime.dispose();
  });

  it("后台压缩 LLM 报错时静默失败且不破坏会话存储", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        sendMessage: vi.fn(async (message: Record<string, unknown>) => {
          if (message.type === "resolve-ai-provider") {
            return {
              ok: true,
              provider: { id: "p1", protocol: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-4o" },
              apiKey: "k"
            };
          }
          if (message.type === "check-provider-origin") {
            return { granted: true, status: "granted" };
          }
          return { ok: true };
        })
      }
    });

    const mockPort = makeMockPort();
    attachOffscreenChatPort(mockPort.port, {
      subtitleSlot: createSubtitleBodySlot(),
      loadLadder: async () => vi.fn(async () => ({})),
      loadCompaction: async () => async () => {
        throw new Error("500 upstream error");
      }
    });

    const plan = planConversationCompaction(buildTurns(12))!;
    mockPort.emitMessage({
      action: "compact-history",
      conversationId: "conv-err",
      providerId: "p1",
      batchMessages: plan.batchMessages,
      coveredMessageCount: plan.coveredMessageCount,
      expectedBoundaryContent: plan.expectedBoundaryContent
    });

    await vi.waitFor(() => {
      expect(mockPort.posted).toContainEqual({
        type: "compact-history-result",
        conversationId: "conv-err",
        ok: false
      });
    });
    expect(mockPort.posted.some((m) => (m as { type?: string }).type === "error")).toBe(false);
  });
});
