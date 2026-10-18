// ai/provider-models.js（AI 平台模型列表拉取的 content 侧薄壳）的行为契约：
//   - Key 回落：表单 apiKey 优先，为空且带 providerId 时按 providerId 代查已存 Key；
//   - adapter 分派（协议知识归 adapter 的 listModels）：openai/anthropic → OpenAI 兼容
//     `${baseUrl}/v1/models` + Bearer；gemini → 原生 `/v1beta/models` + x-goog-api-key；
//   - 错误文案分流：HTTP 错误回 `HTTP <status>: <body 截断>`；代发通道抛出的 Error
//     （未授权提示 / 超时）原样透传；响应体 JSON 解析失败回「无法解析模型列表」。
// 传输层 providerFetchViaBackground 与 aiProviderStore.loadKeys 整体 mock，
// fetchImpl 以 canned 响应直注（壳的 fetchImpl 固定注入代发，这里代发即桩）。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

const mocks = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  loadKeys: vi.fn()
}));

vi.mock("../../extension/core/provider-http.js", () => ({
  providerFetchViaBackground: mocks.providerFetch
}));

vi.mock("../../extension/core/ai-provider-store.js", () => ({
  aiProviderStore: {
    loadKeys: mocks.loadKeys
  }
}));

// 最小响应对象（adapter 只消费 ok / status / text / json）。
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
    json: vi.fn(async () => {
      if (typeof body === "string") throw new SyntaxError("Unexpected token");
      return body;
    })
  };
}

async function loadModule() {
  return import("../../extension/ai/provider-models.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  vi.clearAllMocks();
});

describe("fetchProviderModels 的 Key 回落", () => {
  it("表单 apiKey 优先：直通 Bearer，不代查已存 Key", async () => {
    mocks.providerFetch.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-4o" }] }));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-form",
      providerId: "p1"
    });

    expect(resp).toEqual({ ok: true, models: ["gpt-4o"] });
    expect(mocks.loadKeys).not.toHaveBeenCalled();
    const [url, init] = mocks.providerFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk-form");
  });

  it("空 apiKey 且带 providerId：按 providerId 代查已存 Key 后发请求", async () => {
    mocks.loadKeys.mockResolvedValue({ p1: "sk-stored" });
    mocks.providerFetch.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "https://api.openai.com", providerId: "p1" });

    expect(resp).toEqual({ ok: true, models: ["m1"] });
    expect(mocks.loadKeys).toHaveBeenCalledTimes(1);
    const init = mocks.providerFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk-stored");
  });

  it("空 apiKey 且无 providerId（新增平台）：裸 GET 不发 Authorization", async () => {
    mocks.providerFetch.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "https://api.openai.com" });

    expect(resp).toEqual({ ok: true, models: ["m1"] });
    expect(mocks.loadKeys).not.toHaveBeenCalled();
    const init = mocks.providerFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("空 baseUrl：回可操作提示，不发请求也不代查 Key", async () => {
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "   ", apiKey: "sk-1", providerId: "p1" });

    expect(resp).toEqual({ ok: false, error: "请填写 baseUrl" });
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.loadKeys).not.toHaveBeenCalled();
  });
});

describe("fetchProviderModels 的协议分派", () => {
  it("protocol=gemini：走 /v1beta/models + x-goog-api-key，滤掉非 generateContent 条目", async () => {
    mocks.providerFetch.mockResolvedValue(
      jsonResponse(200, {
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }
        ]
      })
    );
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gk-1",
      protocol: "gemini"
    });

    expect(resp).toEqual({ ok: true, models: ["gemini-2.5-pro", "gemini-2.5-flash"] });
    const [url, init] = mocks.providerFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(init.headers["x-goog-api-key"]).toBe("gk-1");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("protocol=anthropic：复用 OpenAI 兼容 /v1/models + Bearer（Messages 无 models.list）", async () => {
    mocks.providerFetch.mockResolvedValue(jsonResponse(200, { data: [{ id: "claude-compatible" }] }));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({
      baseUrl: "https://api.example.com/anthropic",
      apiKey: "sk-ant",
      protocol: "anthropic"
    });

    expect(resp).toEqual({ ok: true, models: ["claude-compatible"] });
    const [url, init] = mocks.providerFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.example.com/anthropic/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk-ant");
  });
});

describe("fetchProviderModels 的错误分流", () => {
  it("HTTP 错误：回 `HTTP <status>: <body 截断>`", async () => {
    mocks.providerFetch.mockResolvedValue(jsonResponse(401, "unauthorized"));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-1" });

    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("HTTP 401: unauthorized");
  });

  it("代发通道抛错（未授权提示 / 超时文案）：原样透传", async () => {
    mocks.providerFetch.mockRejectedValue(new Error("该平台域名未授权，请在保存时允许权限"));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
  });

  it("响应体 JSON 解析失败：回「无法解析模型列表」", async () => {
    mocks.providerFetch.mockResolvedValue(jsonResponse(200, "not-json"));
    const { fetchProviderModels } = await loadModule();

    const resp = await fetchProviderModels({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "无法解析模型列表" });
  });
});
