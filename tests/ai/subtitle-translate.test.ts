import { describe, expect, it, vi } from "vitest";
import {
  TARGET_LANG_NAME_MAP,
  buildSubtitleTranslateRequest,
  formatSubtitleNumberedLines,
  parseSubtitleNumberedLines,
  resolveSubtitleTranslateProvider,
  resolveSubtitleTranslateProtocolMode,
  resolveTargetLangDisplayName,
  translateSubtitleItems
} from "../../extension/ai/subtitle-translate.js";
import { providerFetchViaOffscreen } from "../../extension/core/provider-http-offscreen.js";
import { LIVE_INTERPRET_TARGET_LANG_OPTIONS } from "../../extension/live/interpret-subtitle-preferences.js";
import {
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODELS,
  INDEX_TRANSLATE_PROVIDER_ID,
  isIndexTranslateModelId,
  normalizeIndexTranslateModel,
  resolveSubtitleTranslateProviderConfig
} from "../../extension/ai/subtitle-translate-config.js";
import {
  INDEX_TRANSLATE_DEFAULT_MODEL as SHARED_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODELS as SHARED_MODELS,
  isIndexTranslateModelId as sharedIsIndexTranslateModelId,
  normalizeIndexTranslateModel as sharedNormalizeIndexTranslateModel
} from "../../extension/shared/subtitle-glossary.js";
import { buildL1VideoIndex } from "../../extension/ai/l1-directory.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import type { ProviderListEntry } from "../../extension/shared/messaging-protocol.js";

describe("字幕翻译平台与模型解析 resolveSubtitleTranslateProviderConfig", () => {
  const sampleProviders: ProviderListEntry[] = [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-chat", "deepseek-reasoner"],
      requiresKey: true,
      hasSavedKey: true,
      enabled: true,
      protocol: "openai"
    },
    {
      id: "openai-custom",
      name: "OpenAI Proxy",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o-mini", "gpt-4o"],
      requiresKey: true,
      hasSavedKey: true,
      enabled: true,
      protocol: "openai"
    },
    {
      id: "local-ollama",
      name: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      models: ["qwen2.5:7b"],
      requiresKey: false,
      hasSavedKey: false,
      enabled: true,
      protocol: "openai"
    },
    {
      id: "disabled-provider",
      name: "Disabled AI",
      baseUrl: "https://api.disabled.com",
      models: ["disabled-model"],
      requiresKey: true,
      hasSavedKey: false,
      enabled: false,
      protocol: "openai"
    }
  ];

  const sampleKeys: Record<string, string> = {
    deepseek: "sk-deepseek-123",
    "openai-custom": "sk-openai-456"
  };

  it("专属平台与模型优先：指定了有效平台与模型时精准命中并返回", () => {
    const resolution = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "openai-custom",
        subtitleTranslateModel: "gpt-4o-mini"
      }
    );

    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider.id).toBe("openai-custom");
    expect(resolution.model).toBe("gpt-4o-mini");
    expect(resolution.apiKey).toBe("sk-openai-456");
    expect(resolution.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("专属平台指定但未指定模型时，回落至该专属平台的首个模型", () => {
    const resolution = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "deepseek",
        subtitleTranslateModel: ""
      }
    );

    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider.id).toBe("deepseek");
    expect(resolution.model).toBe("deepseek-chat");
    expect(resolution.apiKey).toBe("sk-deepseek-123");
  });

  it("未指定专属平台时，默认使用免 Key 的内置 Index-Translate（不受已配置自定义平台或 defaultModel 影响）", () => {
    const resolution = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "",
        subtitleTranslateModel: ""
      }
    );

    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(resolution.model).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
    expect(resolution.apiKey).toBe("");
  });

  it("专属自定义平台已被删除或禁用时，平滑回落至内置免 Key Index-Translate 默认模型", () => {
    // 目标平台已禁用
    const resDisabled = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "disabled-provider",
        subtitleTranslateModel: "disabled-model"
      }
    );
    expect(resDisabled.isFallback).toBe(true);
    expect(resDisabled.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(resDisabled.model).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
    expect(resDisabled.apiKey).toBe("");

    // 目标平台不存在
    const resNonExistent = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "ghost-provider",
        subtitleTranslateModel: "ghost-model"
      }
    );
    expect(resNonExistent.isFallback).toBe(true);
    expect(resNonExistent.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(resNonExistent.model).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
    expect(resNonExistent.apiKey).toBe("");
  });

  it("无任何已配置自定义平台时默认开箱即用走内置 Index-Translate（无需 API Key）", () => {
    const emptyRes = resolveSubtitleTranslateProviderConfig([], {}, {});
    expect(emptyRes.isFallback).toBe(false);
    expect(emptyRes.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(emptyRes.model).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
    expect(emptyRes.apiKey).toBe("");

    const allDisabled: ProviderListEntry[] = [
      {
        id: "p1",
        enabled: false,
        models: ["m1"],
        hasSavedKey: false
      }
    ];
    const disabledRes = resolveSubtitleTranslateProviderConfig(allDisabled, {}, {});
    expect(disabledRes.isFallback).toBe(false);
    expect(disabledRes.provider.id).toBe(INDEX_TRANSLATE_PROVIDER_ID);
    expect(disabledRes.model).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
  });

  it("需要 Key 但未配置时抛出可读错误", () => {
    expect(() =>
      resolveSubtitleTranslateProviderConfig(
        sampleProviders,
        {}, // 缺 Key
        { subtitleTranslateProviderId: "deepseek" }
      )
    ).toThrow("该平台 API Key 未配置");
  });

  it("免 Key 平台（requiresKey: false）无需 API Key 即可通过解析", () => {
    const resolution = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      {},
      { subtitleTranslateProviderId: "local-ollama" }
    );
    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider.id).toBe("local-ollama");
    expect(resolution.apiKey).toBe("");
    expect(resolution.model).toBe("qwen2.5:7b");
  });

  it("异步 resolveSubtitleTranslateProvider 支持依赖注入执行", async () => {
    const resolution = await resolveSubtitleTranslateProvider({
      getSettings: async () => ({
        subtitleTranslateProviderId: "openai-custom",
        subtitleTranslateModel: "gpt-4o-mini"
      }),
      loadProviders: async () => sampleProviders,
      loadKeys: async () => sampleKeys
    });

    expect(resolution.isFallback).toBe(false);
    expect(resolution.provider.id).toBe("openai-custom");
    expect(resolution.model).toBe("gpt-4o-mini");
  });
});

describe("字幕翻译请求装配与思考关闭 buildSubtitleTranslateRequest", () => {
  it("固定将思考档位设为关闭（off），不继承高思考强度", () => {
    const request = buildSubtitleTranslateRequest({
      provider: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "deepseek-chat",
        protocol: "openai"
      },
      messages: [
        { role: "system", content: "You are a translator." },
        { role: "user", content: "1. Hello world" }
      ],
      stream: false,
      // 故意传入高思考档位测试
      thinkingLevel: "high"
    });

    // 必须强制设为 off，且默认走 offscreen 代发传输
    expect(request.thinkingLevel).toBe("off");
    expect(request.fetchImpl).toBe(providerFetchViaOffscreen);
    expect(request.messages).toHaveLength(2);
    expect(request.provider.model).toBe("deepseek-chat");

    // 验证 planThinkingWire 与适配器线格式：思考字段关闭生效
    const wireGlm = planThinkingWire({
      protocol: "openai",
      model: "glm-4.5",
      level: request.thinkingLevel,
      stream: false,
      probe: false
    });
    expect(wireGlm.fields).toEqual({ thinking: { type: "disabled" } });

    const wireMimo = planThinkingWire({
      protocol: "openai",
      model: "mimo-v2",
      level: request.thinkingLevel,
      stream: false,
      probe: false
    });
    expect(wireMimo.fields).toEqual({ enable_thinking: false });

    const wireGemini = planThinkingWire({
      protocol: "gemini",
      model: "gemini-3-flash-preview",
      presetId: "gemini",
      level: request.thinkingLevel,
      stream: false,
      probe: false
    });
    expect(wireGemini.fields.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
      includeThoughts: false
    });
  });
});

describe("字幕翻译序号行协议", () => {
  const originalItems = [
    { from: 0, to: 2.5, content: "Hello world" },
    { from: 2.5, to: 5.0, content: "How are you today?" },
    { from: 5.0, to: 8.0, content: "Let's learn something new." }
  ];

  it("formatSubtitleNumberedLines 生成严格 1..N 序号行", () => {
    const formatted = formatSubtitleNumberedLines(originalItems);
    expect(formatted).toBe("1. Hello world\n2. How are you today?\n3. Let's learn something new.");
  });

  it("parseSubtitleNumberedLines 解析序号行并 1:1 对齐时间戳", () => {
    const llmOutput = "1. 你好，世界\n2. 你今天好吗？\n3. 让我们学点新东西。";
    const parsed = parseSubtitleNumberedLines(llmOutput, originalItems);

    expect(parsed).toEqual([
      { from: 0, to: 2.5, content: "你好，世界" },
      { from: 2.5, to: 5.0, content: "你今天好吗？" },
      { from: 5.0, to: 8.0, content: "让我们学点新东西。" }
    ]);
  });

  it("容错支持多种标点变体（如 1、 1:）与额外前言后语", () => {
    const llmOutput = [
      "这是翻译结果：",
      "1、你好，世界",
      "2: 你今天好吗？",
      "3. 让我们学点新东西。",
      "希望对你有帮助！"
    ].join("\n");

    const parsed = parseSubtitleNumberedLines(llmOutput, originalItems);
    expect(parsed).toEqual([
      { from: 0, to: 2.5, content: "你好，世界" },
      { from: 2.5, to: 5.0, content: "你今天好吗？" },
      { from: 5.0, to: 8.0, content: "让我们学点新东西。" }
    ]);
  });

  it("某行缺失时自动回退原文，时间戳不偏移", () => {
    const llmOutput = "1. 你好，世界\n3. 让我们学点新东西。";
    const parsed = parseSubtitleNumberedLines(llmOutput, originalItems);

    expect(parsed).toEqual([
      { from: 0, to: 2.5, content: "你好，世界" },
      { from: 2.5, to: 5.0, content: "How are you today?" },
      { from: 5.0, to: 8.0, content: "让我们学点新东西。" }
    ]);
  });

  it("fallbackToOriginal=false 时，遗漏行返回空串而不混入原文", () => {
    const llmOutput = "1. 你好，世界\n3. 让我们学点新东西。";
    const parsed = parseSubtitleNumberedLines(llmOutput, originalItems, { fallbackToOriginal: false });

    expect(parsed).toEqual([
      { from: 0, to: 2.5, content: "你好，世界" },
      { from: 2.5, to: 5.0, content: "" },
      { from: 5.0, to: 8.0, content: "让我们学点新东西。" }
    ]);
  });

  it("translateSubtitleItems 对人工精校 CC 轨发送严格 ID JSON 数组并返回对齐条目及双轨元数据", async () => {
    const mockChatCompletion = vi.fn().mockResolvedValue(
      JSON.stringify([
        { id: "0", translation: "你好" },
        { id: "1", translation: "你好吗" },
        { id: "2", translation: "学新知识" }
      ])
    );
    const result = await translateSubtitleItems({
      items: originalItems,
      targetLang: "zh",
      providerResolution: {
        provider: { id: "p1", name: "P1", baseUrl: "https://api.test", models: ["m1"], enabled: true, hasSavedKey: true },
        apiKey: "test-key",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      },
      chatCompletionFn: mockChatCompletion as any
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchImpl: providerFetchViaOffscreen,
        thinkingLevel: "off"
      })
    );
    expect(JSON.parse(mockChatCompletion.mock.calls[0][0].messages[1].content)).toEqual([
      { id: "0", text: "Hello world" },
      { id: "1", text: "How are you today?" },
      { id: "2", text: "Let's learn something new." }
    ]);
    expect(result.mode).toBe("cc-json");
    expect(result).toEqual([
      { from: 0, to: 2.5, content: "你好" },
      { from: 2.5, to: 5.0, content: "你好吗" },
      { from: 5.0, to: 8.0, content: "学新知识" }
    ]);
    expect(result.items).toEqual(originalItems);
    expect(result.translations).toEqual([
      { from: 0, to: 2.5, content: "你好" },
      { from: 2.5, to: 5.0, content: "你好吗" },
      { from: 5.0, to: 8.0, content: "学新知识" }
    ]);
  });

  it("人工 CC 轨首轮截断或漏行时自动发起 1 次漏行单补", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        '```json\n[{"id":"0","translation":"你好"},{"id":"2","translation":"学新知识"}]'
      )
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "你今天好吗？" }])
      );

    const result = await translateSubtitleItems({
      items: originalItems,
      targetLang: "zh",
      providerResolution: {
        provider: { id: "p1", name: "P1", baseUrl: "https://api.test", models: ["m1"], enabled: true, hasSavedKey: true },
        apiKey: "test-key",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      },
      chatCompletionFn: mockChatCompletion as any
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockChatCompletion.mock.calls[1][0].messages[1].content)).toEqual([
      { id: "0", text: "How are you today?" }
    ]);
    expect(result).toEqual([
      { from: 0, to: 2.5, content: "你好" },
      { from: 2.5, to: 5.0, content: "你今天好吗？" },
      { from: 5.0, to: 8.0, content: "学新知识" }
    ]);
  });

  it("translateSubtitleItems 默认 fallbackToOriginal=false，单补后仍缺失的行返回空串而不污染共享译文缓存", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: "0", translation: "你好" },
          { id: "2", translation: "学新知识" }
        ])
      )
      .mockResolvedValueOnce("[]");

    const result = await translateSubtitleItems({
      items: originalItems,
      targetLang: "zh",
      providerResolution: {
        provider: { id: "p1", name: "P1", baseUrl: "https://api.test", models: ["m1"], enabled: true, hasSavedKey: true },
        apiKey: "test-key",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      },
      chatCompletionFn: mockChatCompletion as any
    });

    expect(result).toEqual([
      { from: 0, to: 2.5, content: "你好" },
      { from: 2.5, to: 5.0, content: "" },
      { from: 5.0, to: 8.0, content: "学新知识" }
    ]);
  });

  it("translateSubtitleItems 显式开启 fallbackToOriginal=true 时回退原文", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: "0", translation: "你好" },
          { id: "2", translation: "学新知识" }
        ])
      )
      .mockResolvedValueOnce("[]");

    const result = await translateSubtitleItems({
      items: originalItems,
      targetLang: "zh",
      fallbackToOriginal: true,
      providerResolution: {
        provider: { id: "p1", name: "P1", baseUrl: "https://api.test", models: ["m1"], enabled: true, hasSavedKey: true },
        apiKey: "test-key",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      },
      chatCompletionFn: mockChatCompletion as any
    });

    expect(result).toEqual([
      { from: 0, to: 2.5, content: "你好" },
      { from: 2.5, to: 5.0, content: "How are you today?" },
      { from: 5.0, to: 8.0, content: "学新知识" }
    ]);
  });

  it("双通道分流：ai-* 轨、asr 伪轨与无标点长轨走 boundary-v3，精校 CC 轨走 cc-json", () => {
    expect(
      resolveSubtitleTranslateProtocolMode({
        trackLan: "ai-en",
        items: originalItems
      })
    ).toBe("boundary-v3");

    expect(
      resolveSubtitleTranslateProtocolMode({
        selectedSubtitleId: "asr",
        items: originalItems
      })
    ).toBe("boundary-v3");

    const unpunctuatedTrack = Array.from({ length: 12 }, (_, idx) => ({
      from: idx,
      to: idx + 1,
      content: "unpunctuated spoken words stream fragment"
    }));
    expect(
      resolveSubtitleTranslateProtocolMode({
        trackLan: "en-US",
        items: unpunctuatedTrack
      })
    ).toBe("boundary-v3");

    expect(
      resolveSubtitleTranslateProtocolMode({
        trackLan: "en-US",
        items: originalItems
      })
    ).toBe("cc-json");
  });

  it("目标语言展示名从 LIVE_INTERPRET_TARGET_LANG_OPTIONS 派生并覆盖全部 14 种语言", () => {
    const expectedCodes = LIVE_INTERPRET_TARGET_LANG_OPTIONS.map((option) => option.value);
    expect(Object.keys(TARGET_LANG_NAME_MAP)).toEqual(expectedCodes);
    expect(resolveTargetLangDisplayName("en")).toBe("英文");
    expect(resolveTargetLangDisplayName("ja")).toBe("日语");
    expect(resolveTargetLangDisplayName("ZH")).toBe("中文");
    expect(resolveTargetLangDisplayName("unknown-lang")).toBe("unknown-lang");
  });

  it("空列表直接返回空数组，不发起请求", async () => {
    const mockChatCompletion = vi.fn();
    const result = await translateSubtitleItems({
      items: [],
      targetLang: "zh",
      chatCompletionFn: mockChatCompletion as any
    });
    expect(result).toEqual([]);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });
});

function emitSseDeltas(
  onEvent: ((event: { type: "token"; data: string }) => void) | undefined,
  deltas: readonly string[]
): void {
  deltas.forEach((data) => {
    onEvent?.({ type: "token", data });
  });
}

function createStreamErrorThenNonStreamSuccessMock(nonStreamPayload: string) {
  let calls = 0;
  return vi.fn(async (request: { stream?: boolean }) => {
    calls += 1;
    if (calls === 1 && request.stream === true) {
      throw new Error("HTTP 400: streaming unsupported by relay");
    }
    return nonStreamPayload;
  });
}

function createAbortingStreamMock(abortError: Error) {
  return vi.fn(async (_request: { stream?: boolean }) => {
    throw abortError;
  });
}

describe("流式 SSE 逐句即出与异常无感降级", () => {
  const providerResolution = {
    provider: {
      id: "p1",
      name: "P1",
      baseUrl: "https://api.test",
      models: ["m1"],
      enabled: true,
      hasSavedKey: true
    },
    apiKey: "test-key",
    baseUrl: "https://api.test",
    model: "m1",
    presetId: "custom",
    isFallback: false
  };

  it("buildSubtitleTranslateRequest 默认开启 stream: true，显式传 false 时保持关闭", () => {
    const defaultReq = buildSubtitleTranslateRequest({
      provider: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "deepseek-chat"
      },
      messages: [{ role: "user", content: "hello" }]
    });
    expect(defaultReq.stream).toBe(true);

    const nonStreamReq = buildSubtitleTranslateRequest({
      provider: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        model: "deepseek-chat"
      },
      messages: [{ role: "user", content: "hello" }],
      stream: false
    });
    expect(nonStreamReq.stream).toBe(false);
  });

  it("流式请求途中抛非中止错误时，自动无感降级调用一次 stream: false 并成功返回", async () => {
    const items = [
      { from: 0, to: 2, content: "First sentence." },
      { from: 2, to: 5, content: "Second sentence." }
    ];
    const mockChatCompletion = createStreamErrorThenNonStreamSuccessMock(
      JSON.stringify([
        { id: "0", translation: "第一句。" },
        { id: "1", translation: "第二句。" }
      ])
    );
    const onCueReady = vi.fn();

    const result = await translateSubtitleItems({
      items,
      targetLang: "zh",
      providerResolution,
      onCueReady,
      chatCompletionFn: mockChatCompletion as any
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    expect(mockChatCompletion.mock.calls[0]?.[0]?.stream).toBe(true);
    expect(mockChatCompletion.mock.calls[1]?.[0]?.stream).toBe(false);
    expect(result).toEqual([
      { from: 0, to: 2, content: "第一句。" },
      { from: 2, to: 5, content: "第二句。" }
    ]);
    expect(onCueReady).toHaveBeenCalledTimes(2);
  });

  it("流式请求触发 AbortError 时直接中止抛出，不触发非流式降级重试", async () => {
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError"
    });
    const mockChatCompletion = createAbortingStreamMock(abortError);

    await expect(
      translateSubtitleItems({
        items: [{ from: 0, to: 2, content: "Hello world." }],
        targetLang: "zh",
        providerResolution,
        chatCompletionFn: mockChatCompletion as any
      })
    ).rejects.toThrow("aborted");

    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0]?.[0]?.stream).toBe(true);
  });

  it("SSE delta 分片到达时在响应完成前即逐句触发 onCueReady，且完整返回后不重复触发", async () => {
    const items = [
      { from: 0, to: 2, content: "Hello" },
      { from: 2, to: 4, content: "World" }
    ];
    const onCueReady = vi.fn();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const mockChatCompletion = vi.fn(async (req: any) => {
      emitSseDeltas(req.onEvent, [
        '{"groups":[{"ids":["0"],"text":"Hello","trans',
        'lation":"你好"},'
      ]);
      await streamGate;
      emitSseDeltas(req.onEvent, ['{"ids":["1"],"text":"World","translation":"世界"}]}']);
      return { done: true };
    });

    const runPromise = translateSubtitleItems({
      items,
      mode: "boundary-v3",
      targetLang: "zh",
      providerResolution,
      onCueReady,
      chatCompletionFn: mockChatCompletion as any
    });

    await vi.waitFor(() => expect(onCueReady).toHaveBeenCalledTimes(1));
    expect(onCueReady).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startIndex: 0, endIndex: 0, translation: "你好" })
    );

    releaseStream();
    const result = await runPromise;

    expect(onCueReady).toHaveBeenCalledTimes(2);
    expect(onCueReady).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startIndex: 1, endIndex: 1, translation: "世界" })
    );
    expect(result).toEqual([
      { from: 0, to: 2, content: "你好" },
      { from: 2, to: 4, content: "世界" }
    ]);
  });
});

describe("单源模型归一与 boundary-v3 分块 L1 章节上下文注入", () => {
  it("INDEX_TRANSLATE_MODELS 与 normalizeIndexTranslateModel 从 shared/subtitle-glossary 单源导出", () => {
    expect(INDEX_TRANSLATE_MODELS).toBe(SHARED_MODELS);
    expect(INDEX_TRANSLATE_DEFAULT_MODEL).toBe(SHARED_DEFAULT_MODEL);
    expect(isIndexTranslateModelId).toBe(sharedIsIndexTranslateModelId);
    expect(normalizeIndexTranslateModel).toBe(sharedNormalizeIndexTranslateModel);
    expect(normalizeIndexTranslateModel("index-translate-2b")).toBe("Index-Translate-2B");
    expect(normalizeIndexTranslateModel("unknown")).toBe(INDEX_TRANSLATE_DEFAULT_MODEL);
  });

  it("boundary-v3 模式按 AtomicSubtitleEvent 毫秒时间窗从 l1Index 分片注入当前章节与参考实体", async () => {
    const l1Index = buildL1VideoIndex({
      bvid: "BV1bnd0001",
      cid: "111",
      subtitleId: "ai-en",
      subtitleLang: "ai-en",
      subtitleSignature: "sig1",
      videoDuration: 150,
      globalSummary: "讨论大模型推理加速。",
      chapters: [
        {
          from: 0,
          to: 60,
          title: "KV Cache 基础",
          coreThesis: "减少自回归解码重复计算",
          keyEntities: ["KV Cache", "Prefill"]
        },
        {
          from: 60,
          to: 150,
          title: "PagedAttention",
          coreThesis: "显存分页管理避免碎片",
          keyEntities: ["PagedAttention", "vLLM"]
        }
      ]
    });

    const mockChat = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [{ ids: ["0"], text: "Prefill fills KV Cache", translation: "预填充阶段填充 KV Cache" }]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [{ ids: ["0"], text: "PagedAttention powers vLLM", translation: "PagedAttention 驱动 vLLM" }]
        })
      );

    const translated = await translateSubtitleItems({
      items: [],
      events: [
        { text: "Prefill fills KV Cache", startMs: 5_000, endMs: 12_000 },
        { text: "PagedAttention powers vLLM", startMs: 70_000, endMs: 78_000 }
      ],
      mode: "boundary-v3",
      targetLang: "zh",
      maxChunkChars: 28,
      l1Index,
      glossary: "KV Cache = 键值缓存",
      providerResolution: {
        provider: {
          id: "p1",
          name: "P1",
          baseUrl: "https://api.test",
          models: ["m1"],
          enabled: true,
          hasSavedKey: true
        },
        apiKey: "test-key",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      },
      chatCompletionFn: mockChat as any
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    const firstSys = mockChat.mock.calls[0][0].messages[0].content as string;
    const firstChapterLine = firstSys
      .split("\n")
      .find((line) => line.startsWith("当前章节："));
    expect(firstChapterLine).toBe("当前章节：KV Cache 基础：减少自回归解码重复计算");
    expect(firstSys).toContain("参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：Prefill");
    expect(firstSys).toContain("- KV Cache -> 键值缓存");

    const secondSys = mockChat.mock.calls[1][0].messages[0].content as string;
    const secondChapterLine = secondSys
      .split("\n")
      .find((line) => line.startsWith("当前章节："));
    expect(secondChapterLine).toBe("当前章节：PagedAttention：显存分页管理避免碎片");
    expect(secondSys).toContain("参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：PagedAttention、vLLM");
    expect(translated.map((item) => item.content)).toEqual([
      "预填充阶段填充 KV Cache",
      "PagedAttention 驱动 vLLM"
    ]);
  });
});
