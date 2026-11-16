import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const mocks = vi.hoisted(() => ({
  executeWebSearch: vi.fn(),
  queryAiCredentialKey: vi.fn(),
  getAiCredentialStatusText: vi.fn((_target: string, status: string) => `status:${status}`),
  resolveDraftApiKey: vi.fn()
}));

vi.mock("../../extension/search/search-executor.js", () => ({
  executeWebSearch: mocks.executeWebSearch
}));

vi.mock("../../extension/core/ai-credential-reference.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/core/ai-credential-reference.js")>();
  return {
    ...actual,
    queryAiCredentialKey: mocks.queryAiCredentialKey,
    getAiCredentialStatusText: mocks.getAiCredentialStatusText
  };
});

vi.mock("../../extension/search/search-provider-store.js", () => ({
  searchProviderStore: {
    resolveDraftApiKey: mocks.resolveDraftApiKey
  }
}));

async function loadModule() {
  return import("../../extension/search/provider-test.js");
}

beforeEach(() => {
  resetModuleState();
  mocks.executeWebSearch.mockReset();
  mocks.queryAiCredentialKey.mockReset();
  mocks.getAiCredentialStatusText.mockClear();
  mocks.resolveDraftApiKey.mockReset().mockResolvedValue("");
});

describe("testSearchConnection", () => {
  it("空 baseUrl 直接拦截，不查 Key、不发搜索", async () => {
    const { testSearchConnection } = await loadModule();
    await expect(testSearchConnection({ presetId: "tavily", type: "tavily", baseUrl: "   " })).resolves.toEqual({
      ok: false,
      error: "请填写 API 地址"
    });
    expect(mocks.resolveDraftApiKey).not.toHaveBeenCalled();
    expect(mocks.executeWebSearch).not.toHaveBeenCalled();
  });

  it("Key 必填预设未填且无已存 Key 时返回「请先填写 API Key」", async () => {
    const { testSearchConnection } = await loadModule();
    mocks.resolveDraftApiKey.mockResolvedValueOnce("");
    await expect(
      testSearchConnection({
        id: "search_exa",
        presetId: "exa",
        type: "exa",
        baseUrl: "https://api.exa.ai",
        apiKey: "",
        requiresKey: true
      })
    ).resolves.toEqual({
      ok: false,
      error: "请先填写 API Key"
    });
    expect(mocks.resolveDraftApiKey).toHaveBeenCalledWith("", "search_exa");
    expect(mocks.executeWebSearch).not.toHaveBeenCalled();
  });

  it("非 DeepSeek 平台经 resolveDraftApiKey 取草稿或已存 Key 并发起单引擎常量测试", async () => {
    const { SEARCH_TEST_QUERY, testSearchConnection } = await loadModule();
    mocks.resolveDraftApiKey.mockResolvedValueOnce("sk-resolved");
    mocks.executeWebSearch.mockResolvedValueOnce({
      results: [
        { title: "1", url: "https://a.example.com", snippet: "a" },
        { title: "2", url: "https://b.example.com", snippet: "b" }
      ],
      platform: "Exa"
    });

    await expect(
      testSearchConnection({
        id: "search_exa",
        presetId: "exa",
        type: "exa",
        baseUrl: "https://api.exa.ai",
        apiKey: "",
        requiresKey: true
      })
    ).resolves.toEqual({
      ok: true,
      message: "连接成功 · 2 条结果"
    });
    expect(SEARCH_TEST_QUERY).toBe("联网搜索测试");
    expect(mocks.executeWebSearch).toHaveBeenCalledWith(
      { type: "exa", baseUrl: "https://api.exa.ai", apiKey: "sk-resolved" },
      "联网搜索测试"
    );
  });

  it("DeepSeek 经 queryAiCredentialKey 引用 AI Key，缺失时按状态映射文案", async () => {
    const { testSearchConnection } = await loadModule();
    mocks.queryAiCredentialKey.mockResolvedValueOnce({ key: "", status: "no-record" });
    await expect(
      testSearchConnection({
        presetId: "deepseek",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com"
      })
    ).resolves.toEqual({
      ok: false,
      error: "status:no-record"
    });
    expect(mocks.resolveDraftApiKey).not.toHaveBeenCalled();
    expect(mocks.executeWebSearch).not.toHaveBeenCalled();

    mocks.queryAiCredentialKey.mockResolvedValueOnce({ key: "sk-ai-ds", status: "ok" });
    mocks.executeWebSearch.mockResolvedValueOnce({
      results: [{ title: "1", url: "https://a.example.com", snippet: "a" }],
      platform: "DeepSeek"
    });
    await expect(
      testSearchConnection({
        presetId: "deepseek",
        type: "deepseek",
        baseUrl: "https://api.deepseek.com"
      })
    ).resolves.toEqual({
      ok: true,
      message: "连接成功 · 1 条结果"
    });
    expect(mocks.executeWebSearch).toHaveBeenCalledWith(
      { type: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-ai-ds" },
      "联网搜索测试"
    );
  });

  it("映射 0 结果 / quota / auth / 其余失败五态", async () => {
    const { testSearchConnection } = await loadModule();

    mocks.executeWebSearch.mockResolvedValueOnce({ results: [], platform: "Tavily" });
    await expect(
      testSearchConnection({ presetId: "tavily", type: "tavily", baseUrl: "https://api.tavily.com" })
    ).resolves.toEqual({ ok: false, error: "未返回结果" });

    mocks.executeWebSearch.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { status: 429 }));
    await expect(
      testSearchConnection({ presetId: "tavily", type: "tavily", baseUrl: "https://api.tavily.com" })
    ).resolves.toEqual({ ok: false, error: "额度已用尽" });

    mocks.executeWebSearch.mockRejectedValueOnce(Object.assign(new Error("HTTP 401"), { status: 401 }));
    await expect(
      testSearchConnection({ presetId: "tavily", type: "tavily", baseUrl: "https://api.tavily.com" })
    ).resolves.toEqual({ ok: false, error: "Key 无效或无权限" });

    mocks.executeWebSearch.mockRejectedValueOnce(new Error("network timeout"));
    await expect(
      testSearchConnection({ presetId: "tavily", type: "tavily", baseUrl: "https://api.tavily.com" })
    ).resolves.toEqual({ ok: false, error: "连接失败：network timeout" });
  });
});
