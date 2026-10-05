// tests/reader/quick-prompts.test.ts
// 初始快捷问题的预热编排契约（extension/reader/quick-prompts.ts）：
// 字幕就绪 → 解析激活平台 → 一次流式短调用 → 聚合正文 → 解析问题 → 写缓存。
// 约束：无字幕 / 无视频身份 / 用户配了自定义问题 / 已有缓存 时不发请求；
// 任何失败（平台缺失、网络、输出不可解析）静默吞掉，由渲染侧回落固定三条。
//
// 手法：ai/active-provider、ai/completion、core/provider-http-offscreen 三个
// 外部边界以 vi.mock 替身（各自都有独立测试），get-settings 经 chrome stub 注入。
// chatCompletion 替身按流式契约作答：正文只经 onEvent 的 token 事件回吐，
// 返回值是 { done: true }（正文不在返回值里——这是流式与非流式最易踩的形状差）。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

const mocks = vi.hoisted(() => ({
  resolveActiveProvider: vi.fn(),
  chatCompletion: vi.fn(),
  providerFetchViaOffscreen: vi.fn()
}));

vi.mock("../../extension/ai/active-provider.js", () => ({
  resolveActiveProvider: mocks.resolveActiveProvider
}));
vi.mock("../../extension/ai/completion.js", () => ({
  chatCompletion: mocks.chatCompletion
}));
vi.mock("../../extension/core/provider-http-offscreen.js", () => ({
  providerFetchViaOffscreen: mocks.providerFetchViaOffscreen
}));

let warmUpInitialQuickPrompts: typeof import("../../extension/reader/quick-prompts.js").warmUpInitialQuickPrompts;
let readCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").readCachedQuickPrompts;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let subscribeQuickPromptsChange: typeof import("../../extension/chat/quick-prompt-cache.js").subscribeQuickPromptsChange;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;

const CONTEXT_KEY = "video:BV1quick00000|1000";

const SOURCE = {
  bvid: "BV1quick00000",
  cid: "1000",
  title: "缓存穿透的三种成因",
  subtitleBody: [
    { from: 0, to: 5, content: "今天我们聊缓存穿透" },
    { from: 5, to: 10, content: "先看它的三种成因" }
  ]
};

const ANSWER = '["核心结论是什么","三种成因分别是什么","怎么避免缓存穿透"]';

// 流式替身：把 text 逐片经 onEvent 的 token 事件回吐后返回 { done: true }。
// 分片按 3 字切，好让「漏聚合」「reasoning 混入」「reset 未清缓冲」三类失败
// 在断言里显形（一次性回吐时它们会互相掩盖）。
// 用 mockImplementation（常驻默认）而非 Once：beforeEach 装默认答案，用例再调一次
// 即替换它；Once 是队列语义，beforeEach 那次会先被消费掉。
function streamAnswer(text: string, opts: { reasoning?: string } = {}) {
  mocks.chatCompletion.mockImplementation(async (args: Record<string, unknown>) => {
    const onEvent = args.onEvent as ((event: { type: string; data?: string }) => void) | undefined;
    if (opts.reasoning) {
      onEvent?.({ type: "reasoning", data: opts.reasoning });
    }
    for (let i = 0; i < text.length; i += 3) {
      onEvent?.({ type: "token", data: text.slice(i, i + 3) });
    }
    return { done: true };
  });
}

async function importModules() {
  const warmup = await import("../../extension/reader/quick-prompts.js");
  const cache = await import("../../extension/chat/quick-prompt-cache.js");
  warmUpInitialQuickPrompts = warmup.warmUpInitialQuickPrompts;
  readCachedQuickPrompts = cache.readCachedQuickPrompts;
  writeCachedQuickPrompts = cache.writeCachedQuickPrompts;
  subscribeQuickPromptsChange = cache.subscribeQuickPromptsChange;
  resetQuickPromptCacheForTests = cache.resetQuickPromptCacheForTests;
}

// get-settings 响应注入：settings 为 null 表示「用户没配自定义问题」。
function stubSettings(settings: Record<string, unknown> | null) {
  const sendMessage = (globalThis.chrome as unknown as { runtime: { sendMessage: Mock } }).runtime.sendMessage;
  sendMessage.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
    if (message?.type === "get-settings") {
      callback?.(settings ? { ok: true, settings } : { ok: true });
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
}

beforeEach(async () => {
  resetModuleState();
  await importModules();
  resetQuickPromptCacheForTests();
  mocks.resolveActiveProvider.mockReset();
  mocks.chatCompletion.mockReset();
  mocks.providerFetchViaOffscreen.mockReset();
  mocks.resolveActiveProvider.mockResolvedValue({
    baseUrl: "https://api.test/v1",
    apiKey: "sk-test",
    model: "test-model",
    presetId: "custom"
  });
  streamAnswer(ANSWER);
  mocks.providerFetchViaOffscreen.mockResolvedValue({ ok: true });
  stubSettings(null);
});

describe("预热成功路径", () => {
  it("字幕就绪：发一次流式短调用，聚合 token 事件的结果写进该视频的缓存并通知订阅者", async () => {
    const listener = vi.fn();
    subscribeQuickPromptsChange(listener);

    await warmUpInitialQuickPrompts(SOURCE);

    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    const args = mocks.chatCompletion.mock.calls[0][0] as Record<string, unknown>;
    // 流式的首要理由：streamOnly 规则遇非流式按「无事实」处理（Q14A），
    // 那类模型的 off 会被级联到开档——预热反而打开思考。流式才照发关思考字段。
    expect(args.stream).toBe(true);
    // 思考档位显式钉死 off（与概览生成同口径：这类短任务不开思考）
    expect(args.thinkingLevel).toBe("off");
    // 预热是尽力而为：不为重试花两次钱。
    expect(args.retries).toBe(0);
    expect(args.fetchImpl).toBe(mocks.providerFetchViaOffscreen);
    expect(args.provider).toMatchObject({ baseUrl: "https://api.test/v1", model: "test-model" });
    const messages = args.messages as { role: string; content: string }[];
    expect(messages[1].content).toContain("缓存穿透的三种成因");
    expect(messages[1].content).toContain("先看它的三种成因");

    expect(readCachedQuickPrompts(CONTEXT_KEY)).toEqual([
      "核心结论是什么",
      "三种成因分别是什么",
      "怎么避免缓存穿透"
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("正文只认 token 事件：思考增量不混进缓存（否则思考文本会污染 JSON 解析）", async () => {
    streamAnswer(ANSWER, { reasoning: "先想想这三个角度该怎么排……" });
    await warmUpInitialQuickPrompts(SOURCE);
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toEqual([
      "核心结论是什么",
      "三种成因分别是什么",
      "怎么避免缓存穿透"
    ]);
  });

  it("读流中断重试（onStreamReset）：旧代缓冲作废，两代不拼接", async () => {
    // 第一代吐半截后中断，reset 清缓冲，第二代从头完整作答。
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockImplementationOnce(async (args: Record<string, unknown>) => {
      const onEvent = args.onEvent as ((event: { type: string; data?: string }) => void) | undefined;
      const onStreamReset = args.onStreamReset as (() => void) | undefined;
      onEvent?.({ type: "token", data: ANSWER.slice(0, 12) });
      onStreamReset?.();
      onEvent?.({ type: "token", data: ANSWER });
      return { done: true };
    });
    await warmUpInitialQuickPrompts(SOURCE);
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toEqual([
      "核心结论是什么",
      "三种成因分别是什么",
      "怎么避免缓存穿透"
    ]);
  });

  it("已有该视频缓存：不再调用模型", async () => {
    writeCachedQuickPrompts(CONTEXT_KEY, ["已缓存一", "已缓存二"]);
    await warmUpInitialQuickPrompts(SOURCE);
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toEqual(["已缓存一", "已缓存二"]);
  });

  it("并发重复触发（字幕就绪 + 对账兜底）：同一视频只发一次请求", async () => {
    const first = warmUpInitialQuickPrompts(SOURCE);
    const second = warmUpInitialQuickPrompts(SOURCE);
    await Promise.all([first, second]);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("不该发请求的情形", () => {
  it("无字幕体：不解析平台、不调用模型", async () => {
    await warmUpInitialQuickPrompts({ ...SOURCE, subtitleBody: [] });
    expect(mocks.resolveActiveProvider).not.toHaveBeenCalled();
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });

  it("无视频身份（bvid/cid 皆空）：不调用模型", async () => {
    await warmUpInitialQuickPrompts({ ...SOURCE, bvid: "", cid: "" });
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });

  it("用户配置了自定义初始问题（留空才自动生成）：不调用模型", async () => {
    stubSettings({ aiInitialQuickPrompts: ["自定义问题一"] });
    await warmUpInitialQuickPrompts(SOURCE);
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toBeNull();
  });
});

describe("失败静默（渲染侧回落固定三条）", () => {
  it("平台解析失败：不抛错、不写缓存", async () => {
    mocks.resolveActiveProvider.mockRejectedValueOnce(new Error("还没有配置 AI 平台"));
    await expect(warmUpInitialQuickPrompts(SOURCE)).resolves.toBeUndefined();
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toBeNull();
  });

  it("模型调用失败：不抛错、不写缓存", async () => {
    mocks.chatCompletion.mockRejectedValueOnce(new Error("网络错误：Failed to fetch"));
    await expect(warmUpInitialQuickPrompts(SOURCE)).resolves.toBeUndefined();
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toBeNull();
  });

  it("输出解析不出问题：不写缓存（不落垃圾 chip）", async () => {
    streamAnswer("抱歉，我无法根据这段字幕生成问题。");
    await warmUpInitialQuickPrompts(SOURCE);
    expect(readCachedQuickPrompts(CONTEXT_KEY)).toBeNull();
  });

  it("读设置失败（消息异常）：不调用模型", async () => {
    const sendMessage = (globalThis.chrome as unknown as { runtime: { sendMessage: Mock } }).runtime.sendMessage;
    sendMessage.mockImplementation((_message: unknown, callback?: (resp: unknown) => void) => {
      callback?.({ ok: false, error: "存储不可用" });
      return undefined;
    });
    await expect(warmUpInitialQuickPrompts(SOURCE)).resolves.toBeUndefined();
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });
});
