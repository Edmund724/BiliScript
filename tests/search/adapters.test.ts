// 搜索适配器测试（spec §2 调用形状表 / §8）：请求构造（endpoint / 鉴权头 / body
// 形状）与响应解析（统一 { title, url, snippet }，snippet 截断 500 字符，计费
// 可读时透传）。适配器是纯函数，直接调用。

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_SNIPPET_MAX_LENGTH } from "../../extension/search/adapters/types.js";
import { buildTavilySearchRequest, parseTavilySearchResponse } from "../../extension/search/adapters/tavily.js";
import { buildExaSearchRequest, parseExaSearchResponse } from "../../extension/search/adapters/exa.js";
import { buildFirecrawlSearchRequest, parseFirecrawlSearchResponse } from "../../extension/search/adapters/firecrawl.js";
import { buildDoubaoSearchRequest, parseDoubaoSearchResponse } from "../../extension/search/adapters/doubao.js";
import { buildAnySearchRequest, parseAnySearchResponse } from "../../extension/search/adapters/anysearch.js";
import { buildParallelSearchRequest, parseParallelSearchResponse } from "../../extension/search/adapters/parallel.js";

beforeEach(() => {
  resetModuleState();
});

const INPUT = { baseUrl: "https://api.tavily.com", apiKey: "key-1", query: "B站 UP 主", count: 5 };
const LONG_SNIPPET = "x".repeat(600);

// 「完全无鉴权头」= 任何形式的凭据头都不发（spec §2 调用形状表的三家 keyless）
function authHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers)
    .map((key) => key.toLowerCase())
    .filter((key) => key === "authorization" || key.includes("api-key") || key.includes("token") || key.includes("access-mode"));
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("期望抛出错误，但未抛出");
}

describe("Tavily 适配器", () => {
  it("POST /search + Bearer 头，body 含 query/max_results/include_raw_content=false", () => {
    const req = buildTavilySearchRequest(INPUT);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.tavily.com/search");
    expect(req.headers.Authorization).toBe("Bearer key-1");
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", max_results: 5, include_raw_content: false });
  });

  it("无 Key：发 x-tavily-access-mode: keyless 且不发 Authorization（spec §2）", () => {
    const req = buildTavilySearchRequest({ ...INPUT, apiKey: "" });
    expect(req.headers["x-tavily-access-mode"]).toBe("keyless");
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", max_results: 5, include_raw_content: false });
  });

  it("有 Key：Authorization: Bearer，不发 keyless 头", () => {
    const req = buildTavilySearchRequest(INPUT);
    expect(req.headers.Authorization).toBe("Bearer key-1");
    expect(req.headers["x-tavily-access-mode"]).toBeUndefined();
  });

  it("baseUrl 尾斜杠去重", () => {
    expect(buildTavilySearchRequest({ ...INPUT, baseUrl: "https://api.tavily.com/" }).url).toBe("https://api.tavily.com/search");
  });

  it("results[].content 映射为 snippet", () => {
    const out = parseTavilySearchResponse({
      results: [{ title: "T1", url: "https://a", content: "摘要" }],
      usage: { credits: 3 }
    });
    expect(out.results).toEqual([{ title: "T1", url: "https://a", snippet: "摘要" }]);
    expect(out.credits).toBe(3);
  });

  it("snippet 截断到 500 字符；畸形响应回落空数组", () => {
    const out = parseTavilySearchResponse({ results: [{ title: "T", url: "https://a", content: LONG_SNIPPET }] });
    expect(out.results[0].snippet.length).toBe(SEARCH_SNIPPET_MAX_LENGTH);
    expect(parseTavilySearchResponse(null).results).toEqual([]);
    expect(parseTavilySearchResponse({ results: "nope" }).results).toEqual([]);
  });
});

describe("Exa 适配器", () => {
  it("POST /search + x-api-key 头，body 含 numResults 与 contents.summary=true", () => {
    const req = buildExaSearchRequest({ ...INPUT, baseUrl: "https://api.exa.ai" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.exa.ai/search");
    expect(req.headers["x-api-key"]).toBe("key-1");
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", numResults: 5, contents: { summary: true } });
  });

  it("results[].summary 映射为 snippet", () => {
    const out = parseExaSearchResponse({
      results: [{ title: "E1", url: "https://e", summary: "概要" }]
    });
    expect(out.results).toEqual([{ title: "E1", url: "https://e", snippet: "概要" }]);
  });

  it("credits 可读时透传（credits 或 costDollars.total），畸形响应回落空数组", () => {
    expect(parseExaSearchResponse({ results: [], credits: 7 }).credits).toBe(7);
    expect(parseExaSearchResponse({ results: [], costDollars: { total: 0.02 } }).credits).toBe(0.02);
    expect(parseExaSearchResponse({}).credits).toBeUndefined();
    expect(parseExaSearchResponse(null).results).toEqual([]);
  });
});

describe("Firecrawl 适配器", () => {
  it("POST /v2/search，完全无鉴权头，body 含 query/limit", () => {
    const req = buildFirecrawlSearchRequest({ ...INPUT, baseUrl: "https://api.firecrawl.dev" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(authHeaderNames(req.headers)).toEqual([]);
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", limit: 5 });
  });

  it("data.web[].description 映射为 snippet；超长截到 500；畸形响应回落空数组", () => {
    const out = parseFirecrawlSearchResponse({
      success: true,
      data: {
        web: [
          { title: "F1", url: "https://f", description: "描述" },
          { title: "F2", url: "https://g", description: LONG_SNIPPET }
        ]
      }
    });
    expect(out.results[0]).toEqual({ title: "F1", url: "https://f", snippet: "描述" });
    expect(out.results[1].snippet.length).toBe(SEARCH_SNIPPET_MAX_LENGTH);
    expect(parseFirecrawlSearchResponse(null).results).toEqual([]);
    expect(parseFirecrawlSearchResponse({ data: { web: "nope" } }).results).toEqual([]);
  });
});

describe("豆包适配器", () => {
  it("POST /search_api/web_search，authorization: Bearer，body PascalCase（Query/SearchType/Count/NeedSummary）", () => {
    const req = buildDoubaoSearchRequest({ ...INPUT, baseUrl: "https://open.feedcoopapi.com" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://open.feedcoopapi.com/search_api/web_search");
    expect(req.headers.authorization).toBe("Bearer key-1");
    expect(JSON.parse(req.body!)).toEqual({ Query: "B站 UP 主", SearchType: "web", Count: 5, NeedSummary: true });
  });

  it("Result.WebResults[] 映射 Title/Url，摘要按 Summary → Content → Snippet 回退", () => {
    const out = parseDoubaoSearchResponse({
      Result: {
        WebResults: [
          { Title: "D1", Url: "https://d", Summary: "长摘要" },
          { Title: "D2", Url: "https://e", Content: "正文回退" },
          { Title: "D3", Url: "https://f", Snippet: "片段回退" }
        ]
      }
    });
    expect(out.results).toEqual([
      { title: "D1", url: "https://d", snippet: "长摘要" },
      { title: "D2", url: "https://e", snippet: "正文回退" },
      { title: "D3", url: "https://f", snippet: "片段回退" }
    ]);
  });

  it("超长摘要截到 500 字符；畸形响应回落空数组", () => {
    const out = parseDoubaoSearchResponse({ Result: { WebResults: [{ Title: "D", Url: "https://d", Summary: LONG_SNIPPET }] } });
    expect(out.results[0].snippet.length).toBe(SEARCH_SNIPPET_MAX_LENGTH);
    expect(parseDoubaoSearchResponse(null).results).toEqual([]);
    expect(parseDoubaoSearchResponse({ Result: { WebResults: "nope" } }).results).toEqual([]);
  });

  it("HTTP 200 信封 data.ResponseMetadata.Error：按 Code / CodeN 双查（码可为字符串）抛出，Error 带 providerCode", () => {
    const byCode = thrownBy(() =>
      parseDoubaoSearchResponse({ ResponseMetadata: { Error: { Code: 10406, Message: "free quota exhausted" } }, Result: { WebResults: [] } })
    );
    expect(byCode.message).toContain("10406");
    expect((byCode as Error & { providerCode?: string }).providerCode).toBe("10406");

    const byCodeN = thrownBy(() =>
      parseDoubaoSearchResponse({ ResponseMetadata: { Error: { CodeN: "700901", Message: "invalid api key" } }, Result: { WebResults: [] } })
    );
    expect((byCodeN as Error & { providerCode?: string }).providerCode).toBe("700901");
  });
});

describe("AnySearch 适配器", () => {
  it("POST /v1/search，完全无鉴权头，body 含 query/max_results", () => {
    const req = buildAnySearchRequest({ ...INPUT, baseUrl: "https://api.anysearch.com" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.anysearch.com/v1/search");
    expect(authHeaderNames(req.headers)).toEqual([]);
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", max_results: 5 });
  });

  it("data.results[].snippet 映射为 snippet（不用更长的 content）；超长截到 500；畸形响应回落空数组", () => {
    const out = parseAnySearchResponse({
      data: {
        results: [
          { title: "A1", url: "https://a", snippet: "片段", content: "更长的正文" },
          { title: "A2", url: "https://b", snippet: LONG_SNIPPET }
        ]
      }
    });
    expect(out.results[0]).toEqual({ title: "A1", url: "https://a", snippet: "片段" });
    expect(out.results[1].snippet.length).toBe(SEARCH_SNIPPET_MAX_LENGTH);
    expect(parseAnySearchResponse(null).results).toEqual([]);
    expect(parseAnySearchResponse({ data: { results: "nope" } }).results).toEqual([]);
  });
});

describe("Parallel 适配器", () => {
  it("POST /mcp，JSON-RPC tools/call + web_search，完全无鉴权头", () => {
    const req = buildParallelSearchRequest({ ...INPUT, baseUrl: "https://search.parallel.ai" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://search.parallel.ai/mcp");
    expect(authHeaderNames(req.headers)).toEqual([]);
    expect(JSON.parse(req.body!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search", arguments: { objective: "B站 UP 主", search_queries: ["B站 UP 主"] } }
    });
  });

  it("两层 JSON 信封：result.structuredContent.results[] 的 title/url/excerpts[0]；超长截到 500；畸形响应回落空数组", () => {
    const out = parseParallelSearchResponse({
      result: {
        structuredContent: {
          results: [
            { title: "P1", url: "https://p", excerpts: ["摘录", "第二段"] },
            { title: "P2", url: "https://q", excerpts: [LONG_SNIPPET] }
          ]
        }
      }
    });
    expect(out.results[0]).toEqual({ title: "P1", url: "https://p", snippet: "摘录" });
    expect(out.results[1].snippet.length).toBe(SEARCH_SNIPPET_MAX_LENGTH);
    expect(parseParallelSearchResponse(null).results).toEqual([]);
    expect(parseParallelSearchResponse({ result: { structuredContent: { results: "nope" } } }).results).toEqual([]);
  });
});
