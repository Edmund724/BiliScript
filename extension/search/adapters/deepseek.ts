import { mapSearchResultRows } from "./rows.js";
import {
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildDeepseekSearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/v1/tools/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      count,
      need_content: false
    })
  };
}

export function parseDeepseekSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    results?: unknown;
  };
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    results: mapSearchResultRows(results, (row) => ({ title: row.title, url: row.url, snippet: row.summary || row.snippet }))
  };
}

export const deepseekAdapter: SearchAdapter = {
  type: "deepseek",
  name: "DeepSeek Search",
  build: buildDeepseekSearchRequest,
  parse: parseDeepseekSearchResponse
};
