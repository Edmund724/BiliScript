// extension/search/adapters/firecrawl.ts
// Firecrawl 搜索适配器（spec §2 调用形状表）：POST /v2/search，**无鉴权头**
// （keyless 模式完全不发 Authorization）。请求体 { query, limit }。响应
// data.web[].title/url/description（v2 的 data 是对象；v1 的扁平数组不用）。
// 纯函数，零 Chrome API / 零 DOM。

import { mapSearchResultRows } from "./rows.js";
import {
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildFirecrawlSearchRequest({ baseUrl, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/v2/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      limit: count
    })
  };
}

export function parseFirecrawlSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    data?: { web?: unknown };
  };
  const results = Array.isArray(data.data?.web) ? data.data?.web : [];
  return {
    results: mapSearchResultRows(results, (row) => ({ title: row.title, url: row.url, snippet: row.description }))
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const firecrawlAdapter: SearchAdapter = {
  type: "firecrawl",
  name: "Firecrawl",
  build: buildFirecrawlSearchRequest,
  parse: parseFirecrawlSearchResponse
};
