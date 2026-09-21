// 搜索适配器测试（spec §5/§6）：请求构造（endpoint / 鉴权头 / body 形状）与
// 响应解析（统一 { title, url, snippet }，snippet 截断 500 字符，计费可读时
// 透传）。适配器是纯函数，直接调用。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_SNIPPET_MAX_LENGTH } from "../../extension/search/adapters/types.js";
import { buildTavilySearchRequest, parseTavilySearchResponse } from "../../extension/search/adapters/tavily.js";
import { buildExaSearchRequest, parseExaSearchResponse } from "../../extension/search/adapters/exa.js";
import { buildBraveSearchRequest, parseBraveSearchResponse } from "../../extension/search/adapters/brave.js";

beforeEach(() => {
  resetModuleState();
});

const INPUT = { baseUrl: "https://api.tavily.com", apiKey: "key-1", query: "B站 UP 主", count: 5 };

describe("Tavily 适配器", () => {
  it("POST /search + Bearer 头，body 含 query/max_results/include_raw_content=false", () => {
    const req = buildTavilySearchRequest(INPUT);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.tavily.com/search");
    expect(req.headers.Authorization).toBe("Bearer key-1");
    expect(JSON.parse(req.body)).toEqual({ query: "B站 UP 主", max_results: 5, include_raw_content: false });
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
    const long = "x".repeat(600);
    const out = parseTavilySearchResponse({ results: [{ title: "T", url: "https://a", content: long }] });
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
    expect(JSON.parse(req.body)).toEqual({ query: "B站 UP 主", numResults: 5, contents: { summary: true } });
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

describe("Brave 适配器", () => {
  it("GET /res/v1/web/search + X-Subscription-Token 头，q/count/extra_snippets 查询参数", () => {
    const req = buildBraveSearchRequest({ ...INPUT, baseUrl: "https://api.search.brave.com" });
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.search.brave.com/res/v1/web/search?q=B%E7%AB%99+UP+%E4%B8%BB&count=5&extra_snippets=false");
    expect(req.headers["X-Subscription-Token"]).toBe("key-1");
  });

  it("web.results[].description 映射为 snippet；畸形响应回落空数组", () => {
    const out = parseBraveSearchResponse({
      web: { results: [{ title: "B1", url: "https://b", description: "描述" }] }
    });
    expect(out.results).toEqual([{ title: "B1", url: "https://b", snippet: "描述" }]);
    expect(parseBraveSearchResponse({}).results).toEqual([]);
    expect(parseBraveSearchResponse(null).results).toEqual([]);
  });
});
