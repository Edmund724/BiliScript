// search/search-executor.ts 搜索执行器测试（spec §2.4/§3）。
// 经 deps.fetchImpl 注入假 fetch，锁适配器分派、请求形状（SW 经 provider-http
// 发起的载荷与 BuiltSearchRequest 一致）、!ok 抛错（附 status）与解析透传。
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeWebSearch, SEARCH_RESULT_COUNT } from "../../extension/search/search-executor.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFetch(payload: unknown, ok = true, status = 200) {
  return {
    fetchImpl: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
      ok,
      status,
      json: async () => payload
    }) as unknown as Response)
  };
}

describe("executeWebSearch 适配器分派", () => {
  it("Tavily：POST /search，Bearer 鉴权，body query/max_results=5", async () => {
    const { fetchImpl } = makeFetch({ results: [{ title: "t", url: "u", content: "c" }], usage: { credits: 3 } });
    const outcome = await executeWebSearch(
      { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "tvly-k" },
      "bilibili ai",
      { fetchImpl }
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    const init = fetchImpl.mock.calls[0][1]! as { method?: string; headers: Record<string, string>; body?: string };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tvly-k");
    expect(JSON.parse(init.body!)).toEqual({ query: "bilibili ai", max_results: SEARCH_RESULT_COUNT, include_raw_content: false });
    expect(outcome).toMatchObject({ platform: "Tavily", credits: 3 });
    expect(outcome.results[0]).toEqual({ title: "t", url: "u", snippet: "c" });
  });

  it("Exa：POST /search，x-api-key 鉴权，body numResults + contents.summary", async () => {
    const { fetchImpl } = makeFetch({ results: [{ title: "t", url: "u", summary: "s" }] });
    const outcome = await executeWebSearch(
      { type: "exa", baseUrl: "https://api.exa.ai", apiKey: "exa-k" },
      "q",
      { fetchImpl }
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.exa.ai/search");
    const init = fetchImpl.mock.calls[0][1]! as { method?: string; headers: Record<string, string>; body?: string };
    expect(init.headers["x-api-key"]).toBe("exa-k");
    expect(JSON.parse(init.body!)).toEqual({ query: "q", numResults: SEARCH_RESULT_COUNT, contents: { summary: true } });
    expect(outcome.platform).toBe("Exa");
  });

  // row 8：apiKey: "" 构造时 build 不产鉴权头，URL 与 body 不变。
  it("Firecrawl：apiKey 为空 → 完全无鉴权头，URL 与 body 不变", async () => {
    const { fetchImpl } = makeFetch({ success: true, data: { web: [{ title: "f", url: "u", description: "d" }] } });
    const outcome = await executeWebSearch(
      { type: "firecrawl", baseUrl: "https://api.firecrawl.dev", apiKey: "" },
      "bilibili ai",
      { fetchImpl }
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.firecrawl.dev/v2/search");
    const init = fetchImpl.mock.calls[0][1]! as { method?: string; headers: Record<string, string>; body?: string };
    expect(Object.keys(init.headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(init.headers).map((key) => key.toLowerCase())).not.toContain("x-api-key");
    expect(JSON.parse(init.body!)).toEqual({ query: "bilibili ai", limit: SEARCH_RESULT_COUNT });
    expect(outcome).toMatchObject({ platform: "Firecrawl" });
    expect(outcome.results[0]).toEqual({ title: "f", url: "u", snippet: "d" });
  });

  it("Tavily：apiKey 为空 → 换成 x-tavily-access-mode: keyless 头，URL 与 body 不变", async () => {
    const { fetchImpl } = makeFetch({ results: [{ title: "t", url: "u", content: "c" }] });
    const outcome = await executeWebSearch(
      { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "" },
      "bilibili ai",
      { fetchImpl }
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    const init = fetchImpl.mock.calls[0][1]! as { method?: string; headers: Record<string, string>; body?: string };
    expect(init.headers["x-tavily-access-mode"]).toBe("keyless");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body!)).toEqual({ query: "bilibili ai", max_results: SEARCH_RESULT_COUNT, include_raw_content: false });
    expect(outcome.results[0]).toEqual({ title: "t", url: "u", snippet: "c" });
  });

  it("!response.ok：抛 `HTTP <status>`（SW 端 4xx/5xx 以 ok:true + status 透传）", async () => {
    const { fetchImpl } = makeFetch({}, false, 401);
    await expect(
      executeWebSearch(
        { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "k" },
        "q",
        { fetchImpl }
      )
    ).rejects.toThrow("HTTP 401");
  });

  // §3「失败分类的落点」：!ok 抛出的错误附 status 属性（供链侧 classifySearchFailure）
  it("!response.ok：抛出的 Error 带 status 属性", async () => {
    const { fetchImpl } = makeFetch({}, false, 429);
    const error = await executeWebSearch(
      { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "k" },
      "q",
      { fetchImpl }
    ).catch((e) => e);
    expect(error.status).toBe(429);
    expect(error.message).toBe("HTTP 429");
  });

  it("响应体非 JSON：抛「搜索响应解析失败」", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("bad json"); }
    }) as unknown as Response);
    await expect(
      executeWebSearch(
        { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "k" },
        "q",
        { fetchImpl }
      )
    ).rejects.toThrow("搜索响应解析失败");
  });
});
