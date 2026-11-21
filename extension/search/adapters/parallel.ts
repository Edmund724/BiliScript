import { mapSearchResultRows } from "./rows.js";
import {
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
    results: mapSearchResultRows(results, (row) => ({
      title: row.title,
      url: row.url,
      snippet: Array.isArray(row.excerpts) ? row.excerpts[0] : undefined
    }))
  };
}

export const parallelAdapter: SearchAdapter = {
  type: "parallel",
  name: "Parallel",
  build: buildParallelSearchRequest,
  parse: parseParallelSearchResponse
};
