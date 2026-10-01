// extension/search/adapters/doubao.ts
// 豆包（火山联网搜索）适配器（spec §2 调用形状表）：POST /search_api/web_search，
// authorization: Bearer <key>（必填，无 Key 不进链）。请求体 PascalCase
// （Query/SearchType/Count/NeedSummary）。响应 Result.WebResults[].Title/.Url，
// 摘要按 Summary → Content → Snippet 三级回退。额度与限流藏在 HTTP 200 信封
// （ResponseMetadata.Error，按 Code/CodeN 双查，码可能是字符串）：命中即抛带
// providerCode 的错，让链侧分类（search-chain.ts 的 classifySearchFailure；
// 适配器只原样抛出，不做映射）。纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
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

// Code / CodeN 双查：真实响应里码可能是字符串，数值也可能落在 CodeN；0 / 空串
// 视为「无错误码」。
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
    results: (results as unknown[]).map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        Title?: unknown;
        Url?: unknown;
        Summary?: unknown;
        Content?: unknown;
        Snippet?: unknown;
      };
      return {
        title: String(row.Title || ""),
        url: String(row.Url || ""),
        snippet: truncateSnippet(row.Summary || row.Content || row.Snippet)
      };
    })
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const doubaoAdapter: SearchAdapter = {
  type: "doubao",
  name: "豆包",
  build: buildDoubaoSearchRequest,
  parse: parseDoubaoSearchResponse
};
