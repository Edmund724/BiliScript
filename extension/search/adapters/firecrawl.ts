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

export const firecrawlAdapter: SearchAdapter = {
  type: "firecrawl",
  name: "Firecrawl",
  build: buildFirecrawlSearchRequest,
  parse: parseFirecrawlSearchResponse
};
