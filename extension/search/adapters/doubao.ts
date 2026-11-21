import { mapSearchResultRows } from "./rows.js";
import {
  type BuildSearchRequestInput,
  type BuiltSearchRequest,
  type ParsedSearchResponse,
  type SearchAdapter
} from "./types.js";

export function buildDoubaoSearchRequest({ baseUrl, apiKey, query, count }: BuildSearchRequestInput): BuiltSearchRequest {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search_api/web_search`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      Query: query,
      SearchType: "web",
      Count: count,
      NeedSummary: true
    })
  };
}

function readErrorCode(error: { Code?: unknown; CodeN?: unknown }): string {
  const code = [error.Code, error.CodeN]
    .map((value) => (value === undefined || value === null ? "" : String(value).trim()))
    .find((value) => value !== "" && value !== "0");
  return code || "";
}

export function parseDoubaoSearchResponse(payload: unknown): ParsedSearchResponse {
  const data = (payload && typeof payload === "object" ? payload : {}) as {
    ResponseMetadata?: { Error?: unknown };
    Result?: { WebResults?: unknown };
  };
  const error = (data.ResponseMetadata?.Error && typeof data.ResponseMetadata.Error === "object"
    ? data.ResponseMetadata.Error
    : null) as { Code?: unknown; CodeN?: unknown; Message?: unknown } | null;
  if (error) {
    const code = readErrorCode(error);
    const message = String(error.Message || "").trim();
    if (code) {
      throw Object.assign(new Error(`豆包联网搜索返回错误码 ${code}${message ? `：${message}` : ""}`), { providerCode: code });
    }
    if (message) {
      throw new Error(`豆包联网搜索返回错误：${message}`);
    }
  }
  const results = Array.isArray(data.Result?.WebResults) ? data.Result?.WebResults : [];
  return {
    results: mapSearchResultRows(results, (row) => ({
      title: row.Title,
      url: row.Url,
      snippet: row.Summary || row.Content || row.Snippet
    }))
  };
}

export const doubaoAdapter: SearchAdapter = {
  type: "doubao",
  name: "豆包",
  build: buildDoubaoSearchRequest,
  parse: parseDoubaoSearchResponse
};
