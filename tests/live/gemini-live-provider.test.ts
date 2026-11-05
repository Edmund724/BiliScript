import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  LIVE_PROVIDER_KEYS_STORAGE,
  LIVE_PROVIDER_PRESETS,
  listLiveModels,
  liveProviderStore,
  normalizeLiveProvider,
  resolveLiveModelsUrl,
  testLiveConnection
} from "../../extension/live/live-provider-store.js";

const GEMINI_AI = {
  id: "p_gemini",
  presetId: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  enabled: true,
  hasSavedKey: true
};

type SentMessage = { type: string } & Record<string, any>;

function installRuntime({
  aiProviders = [GEMINI_AI],
  apiKey = "shared-gemini-key",
  response = { models: [] }
}: {
  aiProviders?: Record<string, unknown>[];
  apiKey?: string;
  response?: unknown;
} = {}) {
  const sent: SentMessage[] = [];
  const sendMessage = vi.fn((message: SentMessage, callback: (response: unknown) => void) => {
    sent.push(message);
    if (message.type === "ai-providers-list") callback({ ok: true, providers: aiProviders });
    else if (message.type === "get-ai-provider-key") callback({ ok: true, apiKey });
    else if (message.type === "provider-http") callback({ ok: true, status: 200, body: JSON.stringify(response) });
    else callback({ ok: false });
  });
  vi.stubGlobal("chrome", {
    ...chrome,
    runtime: { ...chrome.runtime, sendMessage }
  });
  return sent;
}

beforeEach(() => {
  resetModuleState();
});

describe("Gemini Live 平台预设与归一化", () => {
  it("登记免自有 Key 的 Gemini Live 预设", () => {
    expect(LIVE_PROVIDER_PRESETS).toContainEqual({
      id: "gemini-live",
      name: "Gemini Live",
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.8-live",
      requiresKey: false,
      note: "Gemini Live 全双工实时音画伴看"
    });
  });

  it("接受 gemini-live 类型并应用平台默认值", () => {
    expect(normalizeLiveProvider({ id: "live_gemini", type: "gemini-live" })).toEqual({
      id: "live_gemini",
      presetId: "gemini-live",
      name: "Gemini Live",
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.8-live",
      enabled: true
    });
  });

  it("保存 Gemini Live 时不向 liveProviderKeys 写入引用密钥", async () => {
    await liveProviderStore.saveProviders([
      {
        id: "live_gemini",
        presetId: "gemini-live",
        name: "Gemini Live",
        type: "gemini-live",
        baseUrl: "https://generativelanguage.googleapis.com",
        model: "gemini-3.8-live",
        enabled: true,
        apiKey: "must-not-be-persisted"
      }
    ]);
    const stored = await chrome.storage.local.get([LIVE_PROVIDER_KEYS_STORAGE]);
    const keys = stored[LIVE_PROVIDER_KEYS_STORAGE] as Record<string, string> | undefined;
    expect(keys?.live_gemini).toBeUndefined();
  });
});

describe("Gemini Live 模型探针", () => {
  it("使用 /v1beta/models、x-goog-api-key，过滤双向模型并置顶保底项", async () => {
    const sent = installRuntime({
      response: {
        models: [
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-custom-live", supportedGenerationMethods: ["bidiGenerateContent"] },
          { name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] },
          { name: "models/gemini-no-methods" }
        ]
      }
    });

    expect(resolveLiveModelsUrl("https://generativelanguage.googleapis.com", "gemini-live")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models"
    );
    await expect(listLiveModels({
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com"
    })).resolves.toEqual({
      ok: true,
      models: ["gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-custom-live"]
    });

    const request = sent.find((message) => message.type === "provider-http");
    expect(request).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      method: "GET"
    });
    expect(request?.headers).toMatchObject({ "x-goog-api-key": "shared-gemini-key" });
    expect(request?.headers.Authorization).toBeUndefined();
  });

  it("凭据未就绪时返回对应提示且不发模型请求", async () => {
    const sent = installRuntime({ aiProviders: [] });
    await expect(listLiveModels({
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com"
    })).resolves.toEqual({ ok: false, error: "请先在 AI 平台添加官方 Gemini 记录" });
    expect(sent.some((message) => message.type === "provider-http")).toBe(false);
  });

  it("连通测试复用引用 Key，并在非官方凭据端点时直接失败", async () => {
    installRuntime();
    await expect(testLiveConnection({
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.8-live"
    })).resolves.toEqual({ ok: true });

    const sent = installRuntime({
      aiProviders: [{ ...GEMINI_AI, baseUrl: "https://proxy.example.com" }]
    });
    await expect(testLiveConnection({
      type: "gemini-live",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-3.8-live"
    })).resolves.toEqual({ ok: false, error: "AI 平台配置的并非 Gemini 官方接口地址" });
    expect(sent.some((message) => message.type === "provider-http")).toBe(false);
  });
});
