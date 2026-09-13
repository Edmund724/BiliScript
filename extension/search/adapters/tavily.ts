// extension/search/adapters/tavily.ts
// Tavily 搜索适配器：POST /search，Authorization: Bearer 鉴权（spec §3.1/§6）。
// 请求体 { query, max_results, include_raw_content: false }（不取全文，只要
// 摘要——素材预算同款约束）。响应 results[].title/url/content（content 即
// snippet）。纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse
} from "./types.js";

export function buildTavilySearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
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
