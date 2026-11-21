import { describe, expect, it } from "vitest";
import {
  buildDeepseekSearchRequest,
  deepseekAdapter,
  parseDeepseekSearchResponse
} from "../../extension/search/adapters/deepseek.js";
import { SEARCH_ADAPTERS } from "../../extension/search/search-adapters.js";

const INPUT = { baseUrl: "https://api.deepseek.com", apiKey: "sk-deepseek", query: "B站 UP 主", count: 5 };

describe("buildDeepseekSearchRequest", () => {
  it("POST {baseUrl}/v1/tools/search，Bearer 鉴权 + JSON 头，固定 need_content:false", () => {
    const req = buildDeepseekSearchRequest(INPUT);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(req.headers.Authorization).toBe("Bearer sk-deepseek");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req.body!)).toEqual({ query: "B站 UP 主", count: 5, need_content: false });
  });

  it("baseUrl 去尾斜杠后拼路径", () => {
    expect(buildDeepseekSearchRequest({ ...INPUT, baseUrl: "https://api.deepseek.com/" }).url).toBe(
      "https://api.deepseek.com/v1/tools/search"
    );
  });
});

describe("parseDeepseekSearchResponse", () => {
  it("results[] 映射统一形状，snippet 取 summary（非 snippet 短摘要）", () => {
    const parsed = parseDeepseekSearchResponse({
      results: [
        { title: "标题 A", url: "https://a.example.com", snippet: "前端短摘要", summary: "给模型阅读的长摘要（600-800 字符）" },
        { title: "标题 B", url: "https://b.example.com", summary: "" }
      ]
    });
    expect(parsed.results).toEqual([
      { title: "标题 A", url: "https://a.example.com", snippet: "给模型阅读的长摘要（600-800 字符）" },
      { title: "标题 B", url: "https://b.example.com", snippet: "" }
    ]);
  });

  it("空结果（results 为空数组）= 合法无结果，非错误", () => {
    expect(parseDeepseekSearchResponse({ results: [] }).results).toEqual([]);
    expect(parseDeepseekSearchResponse({}).results).toEqual([]);
  });

  it("summary 缺失时回落 snippet 字段", () => {
    const parsed = parseDeepseekSearchResponse({ results: [{ title: "t", url: "https://x", snippet: "短摘要" }] });
    expect(parsed.results[0].snippet).toBe("短摘要");
  });
});

