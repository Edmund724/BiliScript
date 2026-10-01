// extension/search/adapters/types.ts
// 搜索适配器共享形状（spec §5/§6）：三家平台请求构造与响应解析统一映射为
// { title, url, snippet }[]，tool-loop（后续 effort）据 BuiltSearchRequest 走
// provider-http 通道由 SW 发请求。纯类型，零运行时依赖。

import type { SearchProviderType } from "../../core/presets.js";

// 统一结果条目：Tavily content / Exa summary / Firecrawl description / 豆包 Summary
// / AnySearch snippet / Parallel excerpts[0] 都映射到 snippet，单条截断 500 字符
// （spec §8，解析期收口）。
export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface BuiltSearchRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface BuildSearchRequestInput {
  baseUrl: string;
  // keyless 预设无 Key 也可调用（spec §3 第 2 行）：空 / 缺省即不产鉴权头
  // （Tavily 是唯一按有无 Key 分岔的一家，见 adapters/tavily.ts）。
  apiKey?: string;
  query: string;
  count: number;
}

// 解析产物：results 为统一形状；credits 为响应中可读的计费/额度信息（如
// Tavily usage.credits），可读时透传，供后续额度提示迭代。
export interface ParsedSearchResponse {
  results: NormalizedSearchResult[];
  credits?: number;
}

// 搜索适配器接口：type 自陈归属（注册表登记即多态），name 为展示名
// （tool-status / UI）。请求构造与响应解析两件事，由 search-adapters.ts 的
// SEARCH_ADAPTERS 注册表收编执行器分派。
export interface SearchAdapter {
  readonly type: SearchProviderType;
  readonly name: string;
  build(input: BuildSearchRequestInput): BuiltSearchRequest;
  parse(payload: unknown): ParsedSearchResponse;
}

// snippet 截断上限（spec §5 单源）
export const SEARCH_SNIPPET_MAX_LENGTH = 500;

export function truncateSnippet(value: unknown): string {
  return String(value || "").slice(0, SEARCH_SNIPPET_MAX_LENGTH);
}
