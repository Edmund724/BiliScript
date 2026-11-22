import { mapSearchResultRows } from "./rows.js";
import {
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildExaSearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey || ""
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
  };
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    results: mapSearchResultRows(results, (row) => ({ title: row.title, url: row.url, snippet: row.summary }))
  };
}

export const exaAdapter: SearchAdapter = {
  type: "exa",
  name: "Exa",
  build: buildExaSearchRequest,
  parse: parseExaSearchResponse
};
