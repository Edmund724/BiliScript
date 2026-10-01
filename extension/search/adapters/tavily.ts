// extension/search/adapters/tavily.ts
// Tavily 搜索适配器：POST /search（spec §2 调用形状表）。**唯一按有无 Key 分岔
// 鉴权头的一家**：无 Key 必须带 x-tavily-access-mode: keyless（否则 401），有 Key
// 走 Authorization: Bearer。请求体 { query, max_results, include_raw_content:
// false }（不取全文，只要摘要——素材预算同款约束）。响应
// results[].title/url/content（content 即 snippet）。纯函数，零 Chrome API /
// 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildTavilySearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  const key = String(apiKey || "").trim();
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : { "x-tavily-access-mode": "keyless" })
    },
    body: JSON.stringify({
      query,
      max_results: count,
      include_raw_content: false
    })
  };
}

export function parseTavilySearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    results?: unknown;
    usage?: { credits?: unknown };
  };
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    results: results.map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        content?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        snippet: truncateSnippet(row.content)
      };
    }),
    ...(Number.isFinite(Number(data.usage?.credits)) ? { credits: Number(data.usage?.credits) } : {})
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const tavilyAdapter: SearchAdapter = {
  type: "tavily",
  name: "Tavily",
  build: buildTavilySearchRequest,
  parse: parseTavilySearchResponse
};
