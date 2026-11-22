import type { SearchProviderType } from "../core/presets.js";
import { firecrawlAdapter } from "./adapters/firecrawl.js";
import { tavilyAdapter } from "./adapters/tavily.js";
import { doubaoAdapter } from "./adapters/doubao.js";
import { anysearchAdapter } from "./adapters/anysearch.js";
import { parallelAdapter } from "./adapters/parallel.js";
import { exaAdapter } from "./adapters/exa.js";
import { deepseekAdapter } from "./adapters/deepseek.js";
import type { SearchAdapter } from "./adapters/types.js";

export const SEARCH_ADAPTERS: Record<SearchProviderType, SearchAdapter> = {
  firecrawl: firecrawlAdapter,
  tavily: tavilyAdapter,
  doubao: doubaoAdapter,
  anysearch: anysearchAdapter,
  parallel: parallelAdapter,
  exa: exaAdapter,
  deepseek: deepseekAdapter
};

const SEARCH_ADAPTER_MAP: ReadonlyMap<string, SearchAdapter> = new Map(Object.entries(SEARCH_ADAPTERS));

export function resolveSearchAdapter(type: unknown): SearchAdapter {
  if (typeof type === "string") {
    return SEARCH_ADAPTER_MAP.get(type) ?? SEARCH_ADAPTERS.tavily;
  }
  return SEARCH_ADAPTERS.tavily;
}
