import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createProviderMessageHandlers, createAsrRuntimeConfigHandler, createSubtitleTranslateProviderHandler } from "../../extension/core/provider-handlers.js";

function makeChannel<T = unknown>() {
  let resolveResponse: (payload: unknown) => void = () => {};
  const response = new Promise<T>((resolve) => {
    resolveResponse = resolve as (payload: unknown) => void;
  });
  const sendResponse = vi.fn((payload: unknown) => resolveResponse(payload));
  return { sendResponse, response };
}

function makeDeps(overrides = {}) {
  return {
    loadProviders: vi.fn(async () => [{ id: "p1", name: "P1", hasSavedKey: true }]),
    saveProviders: vi.fn(async (items: any[]) => items.map((p) => ({ ...p, hasSavedKey: false }))),
    deleteProvider: vi.fn(async () => [{ id: "p2", name: "P2", hasSavedKey: false }]),
    loadKeys: vi.fn(async () => ({ p1: "stored-key" })),
    ...overrides
  };
}

beforeEach(() => {
  resetModuleState();
});

describe("list / save / remove", () => {
  it("list 回包 { ok: true, providers }，返回 void（回包在返回之后，异步口径归注册表）", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.list({}, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(await response).toEqual({
      ok: true,
      providers: [{ id: "p1", name: "P1", hasSavedKey: true }]
    });
    expect(deps.loadProviders).toHaveBeenCalledTimes(1);
  });

  it("save 把 message.providers 透传给 saveProviders，缺失时为空数组", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);

    const first = makeChannel();
    expect(handlers.save({ providers: [{ id: "p1" }] }, {}, first.sendResponse)).toBeUndefined();
    expect(await first.response).toEqual({ ok: true, providers: [{ id: "p1", hasSavedKey: false }] });
    expect(deps.saveProviders).toHaveBeenCalledWith([{ id: "p1" }]);

    const second = makeChannel();
    handlers.save({}, {}, second.sendResponse);
    expect(await second.response).toEqual({ ok: true, providers: [] });
    expect(deps.saveProviders).toHaveBeenLastCalledWith([]);
  });

  it("remove 透传 String(providerId)，回包 { ok: true, providers }", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.remove({ providerId: 42 }, {}, sendResponse)).toBeUndefined();
    expect(await response).toEqual({
      ok: true,
      providers: [{ id: "p2", name: "P2", hasSavedKey: false }]
    });
    expect(deps.deleteProvider).toHaveBeenCalledWith("42");
  });

  it("store 失败时回包 { ok: false, error }", async () => {
    const deps = makeDeps({
      loadProviders: vi.fn(async () => {
        throw new Error("storage down");
      })
    });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.list({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "storage down" });
  });
});

describe("缺省 toError（withOkResponse 的默认错误文案单源）", () => {
  it("非 Error 拒绝 → error 是可读串（不写成 undefined）", async () => {
    const deps = makeDeps({
      loadProviders: vi.fn(async () => {
        throw "raw failure";
      })
    });
    const { sendResponse, response } = makeChannel();

    createProviderMessageHandlers(deps).list({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "raw failure" });
  });

  it("undefined 拒绝 → 回包照发（error 走 String，不在包装内自抛）", async () => {
    const deps = makeDeps({
      loadProviders: vi.fn(async () => {
        throw undefined;
      })
    });
    const { sendResponse, response } = makeChannel();

    createProviderMessageHandlers(deps).list({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "undefined" });
  });
});

describe("get（读取已存 Key）", () => {
  it("回包 { ok: true, apiKey }（trim 后），异步路径返回 \"hold\"（branch 活判定：入口据它持有通道）", async () => {
    const deps = makeDeps({ loadKeys: vi.fn(async () => ({ p1: "  spaced  " })) });
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    expect(handlers.get({ providerId: " p1 " }, {}, sendResponse)).toBe("hold");
    expect(await response).toEqual({ ok: true, apiKey: "spaced" });
  });

  it("未存 Key 的平台回空串", async () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse, response } = makeChannel();

    handlers.get({ providerId: "nope" }, {}, sendResponse);
    expect(await response).toEqual({ ok: true, apiKey: "" });
  });

  it("缺 providerId 同步回包错误并返回 \"answered\"（branch 活判定），不读 Key 存储", () => {
    const deps = makeDeps();
    const handlers = createProviderMessageHandlers(deps);
    const { sendResponse } = makeChannel();

    expect(handlers.get({}, {}, sendResponse)).toBe("answered");
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "缺少 providerId" });
    expect(deps.loadKeys).not.toHaveBeenCalled();
  });
});

function makeRuntimeDeps(overrides = {}) {
  return {
    getMergedSettings: vi.fn(async () => ({
      activeAsrProviderId: " p1 ",
      asrLanguage: "auto",
      asrAutoFallback: true
    })),
    loadProviders: vi.fn(async () => [
      {
        id: "p1",
        presetId: "custom",
        type: "openai-transcriptions",
        name: "本地 Whisper",
        baseUrl: "https://asr.example/v1",
        model: "whisper-large-v3",
        supportsTimestamps: true,
        enabled: true,
        hasSavedKey: false
      }
    ]),
    getAsrProviderKey: vi.fn(async () => "sk-local"),
    ...overrides
  };
}

describe("get-asr-runtime-config（createAsrRuntimeConfigHandler）", () => {
  it("回包一致快照：providers 无 Key，仅激活平台附 activeKey，返回 void（异步口径归注册表）", async () => {
    const deps = makeRuntimeDeps();
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    expect(handler({}, {}, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(await response).toEqual({
      ok: true,
      providers: [
        {
          id: "p1",
          presetId: "custom",
          type: "openai-transcriptions",
          name: "本地 Whisper",
          baseUrl: "https://asr.example/v1",
          model: "whisper-large-v3",
          supportsTimestamps: true,
          enabled: true,
          hasSavedKey: false
        }
      ],
      activeAsrProviderId: "p1",
      activeKey: "sk-local",
      asrLanguage: "auto",
      asrAutoFallback: true
    });
    expect(deps.loadProviders).toHaveBeenCalledTimes(1);
    expect(deps.getAsrProviderKey).toHaveBeenCalledTimes(1);
    expect(deps.getAsrProviderKey).toHaveBeenCalledWith("p1");
  });

  it("无激活平台时不读 Key 存储，activeKey 为空串", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => ({
        activeAsrProviderId: "",
        asrLanguage: "zh",
        asrAutoFallback: false
      })),
      loadProviders: vi.fn(async () => [])
    });
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({
      ok: true,
      providers: [],
      activeAsrProviderId: "",
      activeKey: "",
      asrLanguage: "zh",
      asrAutoFallback: false
    });
    expect(deps.getAsrProviderKey).not.toHaveBeenCalled();
  });

  it("列表非空但 activeAsrProviderId 为空或悬空时自动回退到首项并读取对应 Key", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => ({
        activeAsrProviderId: "ghost",
        asrLanguage: "auto",
        asrAutoFallback: true
      }))
    });
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toMatchObject({
      ok: true,
      activeAsrProviderId: "p1",
      activeKey: "sk-local"
    });
    expect(deps.getAsrProviderKey).toHaveBeenCalledWith("p1");
  });

  it("settings 读取失败回包 { ok: false, error }", async () => {
    const deps = makeRuntimeDeps({
      getMergedSettings: vi.fn(async () => {
        throw new Error("storage timeout");
      })
    });
    const handler = createAsrRuntimeConfigHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "storage timeout" });
    expect(deps.getAsrProviderKey).not.toHaveBeenCalled();
  });
});

import { createAiResolvedProviderHandler } from "../../extension/core/provider-handlers.js";

function makeResolvedDeps(overrides = {}) {
  return {
    getMergedSettings: vi.fn(async () => ({ defaultModel: "p1" })),
    loadProviders: vi.fn(async () => [
      { id: "p1", name: "P1", model: "m1", enabled: true, hasSavedKey: true },
      { id: "p2", name: "P2", model: "m2", enabled: true, hasSavedKey: true }
    ]),
    loadKeys: vi.fn(async () => ({ p1: "key-p1", p2: "key-p2" })),
    ...overrides
  };
}

describe("createAiResolvedProviderHandler（resolve-ai-provider 单趟解析）", () => {
  it("providerId 精确匹配档：带 id 查找并回 provider 记录 + apiKey，不读 settings", async () => {
    const deps = makeResolvedDeps();
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    expect(handler({ providerId: "p2" }, {}, sendResponse)).toBeUndefined();
    expect(await response).toEqual({
      ok: true,
      provider: { id: "p2", name: "P2", model: "m2", enabled: true, hasSavedKey: true },
      apiKey: "key-p2"
    });
    expect(deps.getMergedSettings).not.toHaveBeenCalled();
  });

  it("providerId 精确匹配落空 → { ok: false, error: 未找到选中的平台 }", async () => {
    const deps = makeResolvedDeps();
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({ providerId: "nope" }, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "未找到选中的平台" });
  });

  it("缺省档：defaultModel 优先，无命中回落首个启用平台", async () => {
    const deps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "p2" }))
    });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel<{ provider: { id: string } }>();

    handler({}, {}, sendResponse);
    expect((await response).provider.id).toBe("p2");

    const fallbackDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "ghost" }))
    });
    const fallbackHandler = createAiResolvedProviderHandler(fallbackDeps);
    const fallbackChannel = makeChannel<{ provider: { id: string } }>();
    fallbackHandler({}, {}, fallbackChannel.sendResponse);
    expect((await fallbackChannel.response).provider.id).toBe("p1");
  });

  it("缺省档回落自报 isFallback：显式默认命中不携带，悬空默认回落带 true（票 05 投影标注真实回落）", async () => {
    const matchedDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "p1" }))
    });
    const matchedHandler = createAiResolvedProviderHandler(matchedDeps);
    const matchedChannel = makeChannel<{ ok: boolean; isFallback?: boolean }>();
    matchedHandler({}, {}, matchedChannel.sendResponse);
    const matchedPayload = await matchedChannel.response;
    expect(matchedPayload.ok).toBe(true);
    expect("isFallback" in matchedPayload).toBe(false);

    const fallbackDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "ghost" }))
    });
    const fallbackHandler = createAiResolvedProviderHandler(fallbackDeps);
    const fallbackChannel = makeChannel<{ ok: boolean; isFallback?: boolean }>();
    fallbackHandler({}, {}, fallbackChannel.sendResponse);
    expect(await fallbackChannel.response).toMatchObject({ ok: true, isFallback: true });

    const noExplicitDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "" }))
    });
    const noExplicitHandler = createAiResolvedProviderHandler(noExplicitDeps);
    const noExplicitChannel = makeChannel<{ ok: boolean; isFallback?: boolean }>();
    noExplicitHandler({}, {}, noExplicitChannel.sendResponse);
    const noExplicitPayload = await noExplicitChannel.response;
    expect(noExplicitPayload.ok).toBe(true);
    expect("isFallback" in noExplicitPayload).toBe(false);
  });

  it("providerId 精确匹配档不携带 isFallback（无回落语义）", async () => {
    const deps = makeResolvedDeps();
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel<{ ok: boolean; isFallback?: boolean }>();

    handler({ providerId: "p2" }, {}, sendResponse);
    const payload = await response;
    expect(payload.ok).toBe(true);
    expect("isFallback" in payload).toBe(false);
  });

  it("无启用平台 → { ok: false, error: NO_ACTIVE_PROVIDER_MESSAGE }", async () => {
    const deps = makeResolvedDeps({ loadProviders: vi.fn(async () => []) });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({
      ok: false,
      error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    });
  });

  it("requiresKey !== false 且密钥缺失 → 解析期拒绝（content 侧统一收紧）", async () => {
    const deps = makeResolvedDeps({ loadKeys: vi.fn(async () => ({ p2: "key-p2" })) });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel();

    handler({ providerId: "p1" }, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "该平台 API Key 未配置" });
  });

  it("requiresKey === false 平台密钥缺失照常放行（本地端点）", async () => {
    const deps = makeResolvedDeps({
      loadProviders: vi.fn(async () => [
        { id: "local", name: "Ollama", model: "llama3.2", enabled: true, requiresKey: false, hasSavedKey: false }
      ]),
      loadKeys: vi.fn(async () => ({}))
    });
    const handler = createAiResolvedProviderHandler(deps);
    const { sendResponse, response } = makeChannel<{ ok: boolean; apiKey: string }>();

    handler({ providerId: "local" }, {}, sendResponse);
    const payload = await response;
    expect(payload.ok).toBe(true);
    expect(payload.apiKey).toBe("");
  });

  it("disabled 平台不参与解析（精确匹配与回落均跳过）", async () => {
    const deps = makeResolvedDeps({
      loadProviders: vi.fn(async () => [
        { id: "p1", name: "P1", model: "m1", enabled: false, hasSavedKey: true }
      ])
    });
    const handler = createAiResolvedProviderHandler(deps);

    const exact = makeChannel();
    handler({ providerId: "p1" }, {}, exact.sendResponse);
    expect(await exact.response).toEqual({ ok: false, error: "未找到选中的平台" });

    const fallback = makeChannel();
    handler({}, {}, fallback.sendResponse);
    expect(await fallback.response).toEqual({
      ok: false,
      error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    });
  });

  it("缺省档按 defaultAiModel 解析 model；悬空或不在目录内回落平台首项", async () => {
    const multiDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "p1", defaultAiModel: "m1b" })),
      loadProviders: vi.fn(async () => [
        { id: "p1", name: "P1", models: ["m1a", "m1b"], enabled: true, hasSavedKey: true },
        { id: "p2", name: "P2", models: ["m2a", "m2b"], enabled: true, hasSavedKey: true }
      ])
    });
    const handler = createAiResolvedProviderHandler(multiDeps);
    const ch1 = makeChannel<{ ok: boolean; model?: string; provider: { id: string } }>();
    handler({}, {}, ch1.sendResponse);
    expect(await ch1.response).toMatchObject({ ok: true, provider: { id: "p1" }, model: "m1b" });

    const staleDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "p1", defaultAiModel: "deleted-model" })),
      loadProviders: vi.fn(async () => [
        { id: "p1", name: "P1", models: ["m1a", "m1b"], enabled: true, hasSavedKey: true }
      ])
    });
    const ch2 = makeChannel<{ ok: boolean; model?: string }>();
    createAiResolvedProviderHandler(staleDeps)({}, {}, ch2.sendResponse);
    expect(await ch2.response).toMatchObject({ ok: true, model: "m1a" });

    const fallbackDeps = makeResolvedDeps({
      getMergedSettings: vi.fn(async () => ({ defaultModel: "ghost", defaultAiModel: "m2b" })),
      loadProviders: vi.fn(async () => [
        { id: "p2", name: "P2", models: ["m2a", "m2b"], enabled: true, hasSavedKey: true }
      ])
    });
    const ch3 = makeChannel<{ ok: boolean; model?: string; isFallback?: boolean }>();
    createAiResolvedProviderHandler(fallbackDeps)({}, {}, ch3.sendResponse);
    expect(await ch3.response).toMatchObject({ ok: true, isFallback: true, model: "m2a" });
  });
});

describe("createSubtitleTranslateProviderHandler（resolve-subtitle-translate-provider）", () => {
  const SUBTITLE_PROVIDERS = [
    { id: "p1", name: "P1", enabled: true, models: ["m1"], hasSavedKey: true },
    { id: "p2", name: "P2", enabled: true, models: ["m2"], hasSavedKey: true }
  ];

  function makeSubtitleDeps(settings: Record<string, unknown>) {
    return {
      getMergedSettings: vi.fn(async () => settings),
      loadProviders: vi.fn(async () => SUBTITLE_PROVIDERS),
      loadKeys: vi.fn(async () => ({ p1: "k1", p2: "k2" }))
    };
  }

  it("未指定专属配置：使用默认内置 Index-Translate 且不携带 isFallback（不受 defaultModel 影响）", async () => {
    const handler = createSubtitleTranslateProviderHandler(makeSubtitleDeps({ defaultModel: "p2" }));
    const { sendResponse, response } = makeChannel<{ ok: boolean; isFallback?: boolean; provider: { id: string }; model?: string }>();

    handler({}, {}, sendResponse);
    const payload = await response;
    expect(payload.provider.id).toBe("bilibili-index-translate");
    expect(payload.model).toBe("Index-Translate-35B-A3B");
    expect("isFallback" in payload).toBe(false);
  });

  it("专属平台已删除：平滑回落内置 Index-Translate 并自报 isFallback", async () => {
    const handler = createSubtitleTranslateProviderHandler(
      makeSubtitleDeps({ subtitleTranslateProviderId: "ghost", defaultModel: "p2" })
    );
    const { sendResponse, response } = makeChannel<{ ok: boolean; isFallback?: boolean; provider: { id: string }; model?: string }>();

    handler({}, {}, sendResponse);
    expect(await response).toMatchObject({
      ok: true,
      isFallback: true,
      provider: { id: "bilibili-index-translate" },
      model: "Index-Translate-35B-A3B"
    });
  });

  it("显式切回自定义平台且未填 Key 时返回缺 Key 错误", async () => {
    const handler = createSubtitleTranslateProviderHandler({
      getMergedSettings: vi.fn(async () => ({ subtitleTranslateProviderId: "p1", subtitleTranslateModel: "m1" })),
      loadProviders: vi.fn(async () => SUBTITLE_PROVIDERS),
      loadKeys: vi.fn(async () => ({}))
    });
    const { sendResponse, response } = makeChannel<{ ok: boolean; error?: string }>();

    handler({}, {}, sendResponse);
    expect(await response).toEqual({ ok: false, error: "该平台 API Key 未配置" });
  });
});
