import { mapSearchResultRows } from "./rows.js";
import {
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
  };
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    results: mapSearchResultRows(results, (row) => ({ title: row.title, url: row.url, snippet: row.content }))
  };
}

export const tavilyAdapter: SearchAdapter = {
  type: "tavily",
  name: "Tavily",
  build: buildTavilySearchRequest,
  parse: parseTavilySearchResponse
};
