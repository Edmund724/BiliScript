// extension/search/adapters/exa.ts
// Exa 搜索适配器：POST /search，x-api-key 头鉴权（spec §3.1/§6）。请求体
// { query, numResults, contents: { summary: true } }——只有请求 summary 才有
// 摘要可回。响应 results[].title/url/summary。纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse
} from "./types.js";

export function buildExaSearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      query,
      numResults: count,
      contents: { summary: true }
    })
  };
}

export function parseExaSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    results?: unknown;
    // Exa 计费字段（credits / costDollars）随 API 版本漂移：可读即透传
    credits?: unknown;
    costDollars?: { total?: unknown };
  };
  const results = Array.isArray(data.results) ? data.results : [];
  const credits = [data.credits, data.costDollars?.total].find((value) => Number.isFinite(Number(value)));
  return {
    results: results.map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        summary?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        snippet: truncateSnippet(row.summary)
      };
    }),
    ...(credits !== undefined ? { credits: Number(credits) } : {})
  };
}
