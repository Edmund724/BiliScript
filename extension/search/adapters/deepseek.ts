// extension/search/adapters/deepseek.ts
// DeepSeek 付费搜索适配器（GLOSSARY「付费平台」）：POST /v1/tools/search，
// Authorization: Bearer <key>（Key 经凭据引用取自 AI 族，链装配时已就绪）。
// 请求体固定 need_content: false——按成功请求次数计费（¥5/1000 次）与返回量无关，
// 正文徒增体积；count 对齐 SEARCH_RESULT_COUNT（统一取值，spec §3.1）。
// 响应 results[] 的 snippet 取 summary 字段（官方定位为给模型阅读，600-800 字符；
// snippet 字段是给前端的短摘要，不用）；解析期截断 500（SEARCH_SNIPPET_MAX_LENGTH）。
// results 为空数组 = 合法无结果（map 出空数组，不抛错）。HTTP 402 = 余额不足 /
// 429 = 限速：非 2xx 由执行器（search-executor）抛 `HTTP <status>` 带 status，
// 链侧 classifySearchFailure 归额度类（与 Tavily/豆包同一张映射表），适配器不做映射。
// 纯函数，零 Chrome API / 零 DOM。

import {
  truncateSnippet,
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
    results: (results as unknown[]).map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as {
        title?: unknown;
        url?: unknown;
        summary?: unknown;
        snippet?: unknown;
      };
      return {
        title: String(row.title || ""),
        url: String(row.url || ""),
        // summary 优先（给模型阅读的长摘要）；老响应缺 summary 时回落 snippet
        snippet: truncateSnippet(row.summary || row.snippet)
      };
    })
  };
}

// 注册表项（search/search-adapters.ts 登记）：具名函数保持导出，测试直调零改动。
export const deepseekAdapter: SearchAdapter = {
  type: "deepseek",
  name: "DeepSeek Search",
  build: buildDeepseekSearchRequest,
  parse: parseDeepseekSearchResponse
};
