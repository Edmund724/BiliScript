// extension/search/search-executor.ts
// 搜索执行器（spec §2.4）：按 provider type 经 SEARCH_ADAPTERS 取适配器构造
// BuiltSearchRequest，经 providerFetchViaBackground 发起（provider-http 消息
// 通道，background SW 收口——URL 合法性 / host 权限预检 / 15s 超时都在 SW 端，
// 密钥不出 SW），响应交同一适配器归一为 { title, url, snippet }[]。
// offscreen 文档可 import（纯 runtime 消息，无 chrome.storage 依赖）；测试经
// deps.fetchImpl 注入。
import { providerFetchViaBackground } from "../core/provider-http.js";
import type { SearchProviderType } from "../core/presets.js";
import { resolveSearchAdapter } from "./search-adapters.js";
import type { ParsedSearchResponse } from "./adapters/types.js";

// 每家默认条数（spec §3.1：对应各自的 max_results / numResults / count 字段）。
export const SEARCH_RESULT_COUNT = 5;

export interface SearchExecutorConfig {
  type: SearchProviderType;
  baseUrl: string;
  apiKey: string;
}

export interface ExecuteWebSearchDeps {
  // 缺省 providerFetchViaBackground（provider-http 消息通道，SW 发起）。
  fetchImpl?: typeof fetch;
}

// 搜索产物：platform 为平台名（tool-status 透传 / UI 展示用）。
export interface WebSearchOutcome extends ParsedSearchResponse {
  platform: string;
}

/**
 * 单次搜索（tool-loop 的 executeSearch 实现）。!response.ok 抛 `HTTP <status>`
 * （SW 端 4xx/5xx 以 ok:true + status 透传，本端统一抛错）；中止照
 * providerFetchViaBackground 的 AbortError 形状上抛，tool-loop 收口为中止。
 */
export async function executeWebSearch(
  config: SearchExecutorConfig,
  query: string,
  deps?: ExecuteWebSearchDeps,
  signal?: AbortSignal | null
): Promise<WebSearchOutcome> {
  const fetchImpl = deps?.fetchImpl ?? providerFetchViaBackground;
  const adapter = resolveSearchAdapter(config.type);
  const built = adapter.build({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    query,
    count: SEARCH_RESULT_COUNT
  });

  const response = await fetchImpl(built.url, {
    method: built.method,
    headers: built.headers,
    ...(built.body !== undefined ? { body: built.body } : {}),
    signal: signal ?? undefined
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch (e) {
    throw new Error(`搜索响应解析失败：${(e as { message?: unknown })?.message || e}`);
  }
  const parsed = adapter.parse(payload);
  return { ...parsed, platform: adapter.name };
}
