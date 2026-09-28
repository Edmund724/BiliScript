// tests/reader/quick-prompts.test.ts
// 初始快捷问题的预热编排契约（extension/reader/quick-prompts.ts）：
// 字幕就绪 → 解析激活平台 → 一次非流式短调用 → 解析问题 → 写缓存。
// 约束：无字幕 / 无视频身份 / 用户配了自定义问题 / 已有缓存 时不发请求；
// 任何失败（平台缺失、网络、输出不可解析）静默吞掉，由渲染侧回落固定三条。
//
// 手法：ai/active-provider、ai/completion、core/provider-http-offscreen 三个
// 外部边界以 vi.mock 替身（各自都有独立测试），get-settings 经 chrome stub 注入。

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
  mocks.chatCompletion.mockResolvedValue('["核心结论是什么","三种成因分别是什么","怎么避免缓存穿透"]');
  mocks.providerFetchViaOffscreen.mockResolvedValue({ ok: true });
  stubSettings(null);
});

describe("预热成功路径", () => {
  it("字幕就绪：发一次非流式短调用，解析结果写进该视频的缓存并通知订阅者", async () => {
    const listener = vi.fn();
    subscribeQuickPromptsChange(listener);

    await warmUpInitialQuickPrompts(SOURCE);

    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    const args = mocks.chatCompletion.mock.calls[0][0] as Record<string, unknown>;
    expect(args.stream).toBe(false);
    // 思考档位显式钉死 off（与概览生成同口径：这类短任务不开思考）
    expect(args.thinkingLevel).toBe("off");
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
    mocks.chatCompletion.mockResolvedValueOnce("抱歉，我无法根据这段字幕生成问题。");
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
