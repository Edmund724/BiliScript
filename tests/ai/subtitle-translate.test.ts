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
import { resolveSubtitleTranslateProviderConfig } from "../../extension/ai/subtitle-translate-config.js";
import { NO_ACTIVE_PROVIDER_MESSAGE } from "../../extension/core/provider-handlers.js";
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

  it("未指定专属平台时，回落首个含模型的启用 AI 平台（不受 defaultModel 影响）", () => {
    const resolution = resolveSubtitleTranslateProviderConfig(
      sampleProviders,
      sampleKeys,
      {
        subtitleTranslateProviderId: "",
        subtitleTranslateModel: ""
      }
    );

    expect(resolution.isFallback).toBe(true);
    expect(resolution.provider.id).toBe("deepseek");
    expect(resolution.model).toBe("deepseek-chat");
    expect(resolution.apiKey).toBe("sk-deepseek-123");
  });

  it("专属平台已被删除或禁用时，平滑回落至首个含模型的启用 AI 平台", () => {
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
    expect(resDisabled.provider.id).toBe("deepseek");
    expect(resDisabled.model).toBe("deepseek-chat");

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
    expect(resNonExistent.provider.id).toBe("deepseek");
    expect(resNonExistent.model).toBe("deepseek-chat");
  });

  it("无任何启用平台时抛出可读错误", () => {
    expect(() =>
      resolveSubtitleTranslateProviderConfig([], {}, {})
    ).toThrow(NO_ACTIVE_PROVIDER_MESSAGE);

    const allDisabled: ProviderListEntry[] = [
      {
        id: "p1",
        enabled: false,
        models: ["m1"],
        hasSavedKey: false
      }
    ];
    expect(() =>
      resolveSubtitleTranslateProviderConfig(allDisabled, {}, {})
    ).toThrow(NO_ACTIVE_PROVIDER_MESSAGE);
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
