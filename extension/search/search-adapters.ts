// extension/search/search-adapters.ts
// 搜索适配器注册表（对齐 ai/protocol-adapter.ts 的 PROTOCOL_ADAPTERS）：执行器
// 不再自带三路 switch，只按 provider type 取适配器。加第 4 家 = 新建一个
// adapters/<name>.ts 适配器 + 此处登记一行；漏登记时 Record<SearchProviderType,…>
// 编译期即报。

import type { SearchProviderType } from "../core/presets.js";
import { tavilyAdapter } from "./adapters/tavily.js";
import { exaAdapter } from "./adapters/exa.js";
import { braveAdapter } from "./adapters/brave.js";
import type { SearchAdapter } from "./adapters/types.js";

// Record 而非 Partial：新增 SearchProviderType 成员而未登记 = 编译期错误。
export const SEARCH_ADAPTERS: Record<SearchProviderType, SearchAdapter> = {
  tavily: tavilyAdapter,
  exa: exaAdapter,
  brave: braveAdapter
};

// 搜索解析单点：未知 / 非字符串值 → tavily（兜底语义对齐 resolveAdapter 的
// openai 兜底）。type 在写入路径已被 normalizeSearchProvider 拦过，脏值只可能
// 经 runtime 的 as cast 漏入；搜索链的终点是降级 + notice，不把存储脏值变成
// 用户可见的抛错。
export function resolveSearchAdapter(type: unknown): SearchAdapter {
  if (typeof type === "string" && type in SEARCH_ADAPTERS) {
    return SEARCH_ADAPTERS[type as SearchProviderType];
  }
  return SEARCH_ADAPTERS.tavily;
}
