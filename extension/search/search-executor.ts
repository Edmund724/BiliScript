import { providerFetchViaBackground } from "../core/provider-http.js";
import type { SearchProviderType } from "../core/presets.js";
import { resolveSearchAdapter } from "./search-adapters.js";
import type { ParsedSearchResponse } from "./adapters/types.js";

export const SEARCH_RESULT_COUNT = 5;

export interface SearchExecutorConfig {
  type: SearchProviderType;
  baseUrl: string;
  apiKey?: string;
}

export interface ExecuteWebSearchDeps {
  fetchImpl?: typeof fetch;
}

export interface WebSearchOutcome extends ParsedSearchResponse {
  platform: string;
}

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
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
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
