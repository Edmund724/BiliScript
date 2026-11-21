import { mapSearchResultRows } from "./rows.js";
import {
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
    results: mapSearchResultRows(results, (row) => ({ title: row.title, url: row.url, snippet: row.snippet }))
  };
}

export const anysearchAdapter: SearchAdapter = {
  type: "anysearch",
  name: "AnySearch",
  build: buildAnySearchRequest,
  parse: parseAnySearchResponse
};
