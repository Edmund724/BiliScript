// ai/active-model-projection.ts 测试（票 05：AI 默认平台与模型生效投影）。
//
// 覆盖验收清单的解析侧场景：显式默认、首项回落（isFallback 自报透传）、
// 不可用（ok:false / 消息异常两路）、模型规则与真实请求复用（对话选中模型优先，
// 回落目录首项 / 历史 model 字段）、字幕翻译跟随投影（真实回落 / 不可用）。
// 投影与 ai/active-provider.ts 共用模型规则叶子——此处钉住投影侧口径，
// active-provider.test.ts 钉住请求侧口径，两侧同源不再分叉。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

let projection: typeof import("../../extension/ai/active-model-projection.js");
let sendMessageMock: Mock;

type ProviderFixture = Record<string, unknown>;

function stubMessages(
  overrides: {
    aiProvider?: {
      ok: boolean;
      provider?: ProviderFixture;
      apiKey?: string;
      model?: string;
      isFallback?: boolean;
      error?: string;
    };
    subtitle?: { ok: boolean; provider?: ProviderFixture; apiKey?: string; model?: string; isFallback?: boolean; error?: string };
  } = {}
) {
  const aiProvider = overrides.aiProvider ?? { ok: true, provider: { id: "p1" }, apiKey: "sk" };
  const subtitle = overrides.subtitle ?? {
    ok: true,
    provider: { id: "p1", name: "平台一" },
    model: "m1",
    isFallback: false
  };
  sendMessageMock.mockImplementation((message, callback) => {
    if (message?.type === "resolve-ai-provider") {
      callback(aiProvider);
    } else if (message?.type === "resolve-subtitle-translate-provider") {
      callback(subtitle);
    } else {
      callback({ ok: true });
    }
    return undefined;
  });
}

beforeEach(async () => {
  resetModuleState();
  sendMessageMock = vi.fn();
  (chrome as unknown as { runtime: { sendMessage: Mock } }).runtime.sendMessage = sendMessageMock;
  projection = await import("../../extension/ai/active-model-projection.js");
});

describe("resolveAiActiveModelProjection（生效投影）", () => {
  it("显式默认：ok + 平台 + 模型，isFallback 未携带时为 false", async () => {
    stubMessages({
      aiProvider: {
        ok: true,
        provider: { id: "p1", name: "DeepSeek 官方", models: ["deepseek-chat", "deepseek-reasoner"] },
        apiKey: "sk"
      }
    });

    const result = await projection.resolveAiActiveModelProjection();

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.provider.id).toBe("p1");
    expect(result.model).toBe("deepseek-chat");
    expect(result.isFallback).toBe(false);
  });

  it("首项回落：处理器自报 isFallback:true 原样透传（投影不另写回落判定）", async () => {
    stubMessages({
      aiProvider: {
        ok: true,
        isFallback: true,
        provider: { id: "p2", name: "硅基流动", models: ["Qwen3"] },
        apiKey: "sk"
      }
    });

    const result = await projection.resolveAiActiveModelProjection();

    expect(result).toMatchObject({ state: "ok", isFallback: true, model: "Qwen3" });
  });

  it("解析回包携带 model 时优先采用（独立于对话 tab 本地选中）", async () => {
    (chrome.storage.local.get as Mock).mockImplementation(async () => ({
      biliscript_ai_selected_provider: `p1${String.fromCharCode(1)}glm-4.5`
    }));
    stubMessages({
      aiProvider: {
        ok: true,
        provider: { id: "p1", name: "P1", models: ["glm-4.5", "glm-5.1"] },
        apiKey: "sk",
        model: "glm-5.1"
      }
    });

    const result = await projection.resolveAiActiveModelProjection();

    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.model).toBe("glm-5.1");
  });

  it("回包未携带 model 时回落目录首项，再回落历史 model 字段", async () => {
    stubMessages({
      aiProvider: { ok: true, provider: { id: "p1", name: "P1", models: ["first", "second"] }, apiKey: "sk" }
    });
    const withCatalog = await projection.resolveAiActiveModelProjection();
    if (withCatalog.state === "ok") expect(withCatalog.model).toBe("first");

    stubMessages({
      aiProvider: { ok: true, provider: { id: "legacy", name: "旧记录", model: "gpt-5.1" }, apiKey: "sk" }
    });
    const legacy = await projection.resolveAiActiveModelProjection();
    if (legacy.state === "ok") expect(legacy.model).toBe("gpt-5.1");
  });

  it("不可用（无平台 / 缺 Key）：ok:false 的 error 原样收敛为 unavailable 投影", async () => {
    stubMessages({
      aiProvider: { ok: false, error: "该平台 API Key 未配置" }
    });

    const result = await projection.resolveAiActiveModelProjection();

    expect(result).toEqual({ state: "unavailable", error: "该平台 API Key 未配置" });
  });

  it("不可用（消息异常）：sendMessage 抛错不向上传播，收敛为 unavailable 投影", async () => {
    sendMessageMock.mockImplementation(() => {
      throw new Error("未登记的 runtime 消息类型：resolve-ai-provider");
    });

    const result = await projection.resolveAiActiveModelProjection();

    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") return;
    expect(result.error).toContain("resolve-ai-provider");
  });
});

describe("resolveSubtitleFollowProjection（字幕跟随投影）", () => {
  it("ok：给出跟随目标平台名 + 模型与回落标记（专属配置失效时 isFallback:true）", async () => {
    stubMessages({
      subtitle: { ok: true, provider: { id: "p1", name: "DeepSeek 官方" }, model: "deepseek-chat", isFallback: true }
    });

    const result = await projection.resolveSubtitleFollowProjection();

    expect(result).toEqual({
      state: "ok",
      providerName: "DeepSeek 官方",
      model: "deepseek-chat",
      isFallback: true
    });
  });

  it("不可用：ok:false / 消息异常两路都收敛为 unavailable（不抛错）", async () => {
    stubMessages({ subtitle: { ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" } });
    expect(await projection.resolveSubtitleFollowProjection()).toEqual({
      state: "unavailable",
      error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
    });

    sendMessageMock.mockImplementation(() => {
      throw new Error("storage down");
    });
    const result = await projection.resolveSubtitleFollowProjection();
    expect(result.state).toBe("unavailable");
  });
});
