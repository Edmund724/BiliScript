// extension/search/adapters/anysearch.ts
// AnySearch 搜索适配器（spec §2 调用形状表）：POST /v1/search，**无鉴权**。
// 请求体 { query, max_results }。响应 data.results[].title/url/snippet（同项另有
// 更长的 content，不用）。纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildAnySearchRequest({ baseUrl, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/v1/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      max_results: count
    })
  };
}

export function parseAnySearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    data?: { results?: unknown };
  };
  const results = Array.isArray(data.data?.results) ? data.data?.results : [];
  return {
    results: (results as unknown[]).map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        snippet?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        snippet: truncateSnippet(row.snippet)
      };
    })
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const anysearchAdapter: SearchAdapter = {
  type: "anysearch",
  name: "AnySearch",
  build: buildAnySearchRequest,
  parse: parseAnySearchResponse
};
