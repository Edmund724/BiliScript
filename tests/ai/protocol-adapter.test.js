// ai/protocol-adapter.js 注册表与协议解析单测（multi-protocol-ai 第一部分）：
// resolveAdapter 是唯一读路径——缺字段/未知值/非字符串一律兜底 openai（存量
// 记录零变化）；chatCompletion 经 provider.protocol 穿线到 adapter（端点/鉴权/
// 请求体随协议切换，core 重试/中止/溢出/探针语义不变）。
// anthropic/responses 本期为占位 adapter（后续排期实现），调用即抛清晰错误。

import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_ADAPTERS, resolveAdapter } from "../../extension/ai/protocol-adapter.js";
import { chatCompletion } from "../../extension/ai/completion.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(payload) {
  return { ok: true, status: 200, text: vi.fn(async () => JSON.stringify(payload)), json: async () => payload };
}

describe("resolveAdapter（协议解析单点）", () => {
  it("三个协议值各自命中注册表", () => {
    expect(resolveAdapter("openai")).toBe(PROTOCOL_ADAPTERS.openai);
    expect(resolveAdapter("anthropic")).toBe(PROTOCOL_ADAPTERS.anthropic);
    expect(resolveAdapter("responses")).toBe(PROTOCOL_ADAPTERS.responses);
  });

  it("缺字段 / 未知值 / 非字符串 → openai 兜底（存量记录零变化）", () => {
    for (const value of [undefined, null, "", "gemini", "OPENAI", 42, {}, true]) {
      expect(resolveAdapter(value), String(value)).toBe(PROTOCOL_ADAPTERS.openai);
    }
  });

  it("未实现协议的占位 adapter：任何调用都抛带协议名的清晰错误", () => {
    for (const protocol of ["anthropic", "responses"]) {
      const adapter = PROTOCOL_ADAPTERS[protocol];
      expect(adapter.protocol).toBe(protocol);
      expect(() => adapter.endpoint("https://x")).toThrow(new RegExp(protocol));
      expect(() => adapter.authHeaders("sk")).toThrow(new RegExp(protocol));
      expect(() => adapter.buildBody({ model: "m", messages: [], stream: false, probe: false, baseUrl: "https://x" })).toThrow(new RegExp(protocol));
      expect(() => adapter.extractErrorDetail("{}")).toThrow(new RegExp(protocol));
      expect(() => adapter.parseResponse({})).toThrow(new RegExp(protocol));
    }
  });
});

describe("协议穿线（chatCompletion → resolveAdapter）", () => {
  it("protocol 缺省 / 显式 openai / 未知值 → 行为一致（/chat/completions + Bearer）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await chatCompletion({ provider: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk" }, messages: [], fetchImpl: fetchMock });
    await chatCompletion({ provider: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk", protocol: "openai" }, messages: [], fetchImpl: fetchMock });
    await chatCompletion({ provider: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk", protocol: "gemini" }, messages: [], fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(init.headers.Authorization).toBe("Bearer sk");
    }
  });

  it("provider.protocol 为未实现协议 → adapter 调用期抛错，不发请求", async () => {
    const fetchMock = vi.fn();

    await expect(
      chatCompletion({
        provider: { baseUrl: "https://x", model: "m", protocol: "anthropic" },
        messages: [],
        retries: 0,
        retryDelayMs: 0,
        fetchImpl: fetchMock
      })
    ).rejects.toThrow(/anthropic/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
