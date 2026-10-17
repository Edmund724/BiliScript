// ai/provider-models.js（arch-slim-2/09 自 core/ai-provider-store.ts 搬入，
// 测试随迁）的模型列表探测（handleAiProvidersModels，经
// ai-providers-models 消息从 options 页模型下拉调用）在 S2 收紧
// host_permissions 后的权限预检：平台域名未授权时那条 GET 只会以 CORS 失败，
// 回包是「Failed to fetch」这类看不出原因的文案，必须换成可操作提示。
// 判定与 AI/ASR 连通性探针共用 core/host-permissions.js 的一份实现。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock: Mock;

async function loadModule() {
  return import("../../extension/ai/provider-models.js");
}

// 最小响应对象（探测代码只消费 ok / status / text / json）。
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
    json: vi.fn(async () => body)
  };
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    permissions: {
      contains: vi.fn(async () => true)
    }
  });
});

describe("handleAiProvidersModels 的 host 权限预检", () => {
  it("已授权 → 正常拉取 /v1/models 并回模型列表", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"]
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  });

  it("未授权 → 返回可操作提示且不发请求", async () => {
    vi.mocked(globalThis.chrome.permissions.contains).mockResolvedValue(false);
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不持有 chrome.permissions 实现时按已授权处理（不阻塞既有拉取）", async () => {
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      permissions: undefined
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: true, models: ["m1"] });
  });
});

describe("handleAiProvidersModels 的 gemini 协议分支", () => {
  it("走 /v1beta/models + x-goog-api-key，剥 models/ 前缀并滤掉非 generateContent 条目", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }
        ]
      })
    );
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gk-1",
      protocol: "gemini"
    });

    expect(resp).toEqual({ ok: true, models: ["gemini-2.5-pro", "gemini-2.5-flash"] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gk-1");
    expect(headers.Authorization).toBeUndefined();
  });

  it("baseUrl 带 /v1beta 尾段时不重复拼接；nextPageToken 翻页后合并", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "tok-2"
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }]
        })
      );
    const { handleAiProvidersModels } = await loadModule();

    const resp = await handleAiProvidersModels({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      apiKey: "gk-1",
      protocol: "gemini"
    });

    expect(resp).toEqual({ ok: true, models: ["gemini-2.5-pro", "gemini-2.5-flash"] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(fetchMock.mock.calls[1][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageToken=tok-2");
  });
});
