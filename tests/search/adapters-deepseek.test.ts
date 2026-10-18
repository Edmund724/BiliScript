// extension/search/adapters/deepseek.ts 测试：请求构造（端点 / 鉴权头 / 固定
// need_content:false / count 透传）与响应映射形状（snippet 取 summary、缺 summary
// 回落 snippet、空结果合法）。行映射不变量（坏行不抛、截 500）单源在
// adapter-rows.test.ts，此处不复测。HTTP 402/429 的非 2xx 分支由执行器
//（search-executor）抛 `HTTP <status>`，分类走 classifySearchFailure（既有用例），
// 此处不重复；不写真付费请求。
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

describe("注册表", () => {
  it("deepseek 已登记进 SEARCH_ADAPTERS（漏登记 = Record 编译期红，此处钉运行面）", () => {
    expect(SEARCH_ADAPTERS.deepseek).toBe(deepseekAdapter);
    expect(deepseekAdapter.type).toBe("deepseek");
  });
});
