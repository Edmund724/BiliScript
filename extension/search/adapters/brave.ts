// extension/search/adapters/brave.ts
// Brave Search 适配器：GET /res/v1/web/search，X-Subscription-Token 头鉴权
// （spec §3.1/§6）。查询参数 q=<query>&count=<n>&extra_snippets=false。响应
// web.results[].title/url/description。纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse
} from "./types.js";

export function buildBraveSearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  const base = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ q: query, count: String(count), extra_snippets: "false" });
  return {
    url: `${base}/res/v1/web/search?${params.toString()}`,
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey
    }
  };
}

export function parseBraveSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    web?: { results?: unknown };
  };
  const results = Array.isArray(data.web?.results) ? data.web?.results : [];
  return {
    results: (results as unknown[]).map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        description?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        snippet: truncateSnippet(row.description)
      };
    })
  };
}
