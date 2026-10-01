// extension/search/adapters/parallel.ts
// Parallel 搜索适配器（spec §2 调用形状表）：POST /mcp，JSON-RPC tools/call +
// web_search，**无鉴权**。响应是两层 JSON 信封（不是 SSE）：取
// result.structuredContent.results[].title/url/excerpts[0]。纯函数，零 Chrome
// API / 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildParallelSearchRequest({ baseUrl, query }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/mcp`,
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: {
          objective: query,
          search_queries: [query]
        }
      }
    })
  };
}

export function parseParallelSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    result?: { structuredContent?: { results?: unknown } };
  };
  const results = Array.isArray(data.result?.structuredContent?.results) ? data.result?.structuredContent?.results : [];
  return {
    results: (results as unknown[]).map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        excerpts?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        snippet: truncateSnippet(Array.isArray(row.excerpts) ? row.excerpts[0] : undefined)
      };
    })
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const parallelAdapter: SearchAdapter = {
  type: "parallel",
  name: "Parallel",
  build: buildParallelSearchRequest,
  parse: parseParallelSearchResponse
};
