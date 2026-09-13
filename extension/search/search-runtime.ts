// extension/search/search-runtime.ts
// 联网搜索运行时解析器（spec §2.3/§2.4）：resolve-search-provider 单趟往返拿
// 激活平台（id/name/type/baseUrl）+ Key + 单轮上限，组装 executeSearch 闭包。
// offscreen 与选区解释链（reader）同走此解析（纯 runtime 消息，无 chrome.storage
// 依赖）；未配置 / 解析失败返回 undefined，调用方 notice 后走原无工具路径——
// 搜索是增强，缺失不阻塞问答。
import { executeWebSearch } from "./search-executor.js";
import type { SearchProviderType } from "../core/presets.js";
import type { NormalizedSearchResult } from "./adapters/types.js";
import type { ResolveSearchProviderResponse } from "../shared/messaging-protocol.js";

// executeSearch 的产物面：results 用归一形状（对 ai/ladder 的 WebSearchRuntime
// 窄面 unknown[] 与 ai/explain 的 ToolLoopSearchOutcome 均结构兼容）。
export interface WebSearchRuntime {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<{ results: NormalizedSearchResult[]; platform: string }>;
}

// signal 透传 executeWebSearch：调用方（聊天 abort controller / 解释卡中止器）
// 停止可中断在途搜索。
export async function resolveWebSearchRuntime(
  signal?: AbortSignal | null
): Promise<WebSearchRuntime | undefined> {
  try {
    // runtime 消息直发（MV3 Promise 风格，见 offscreen 同款解析）；await 的
    // unknown 回包在传输边界收窄为协议响应类型（arch-slim-2/02 单点 cast 同性质）。
    const resp = (await chrome.runtime.sendMessage({
      type: "resolve-search-provider"
    })) as ResolveSearchProviderResponse | null;
    if (!resp?.ok || !resp.provider || !resp.apiKey) {
      return undefined;
    }
    const config = {
      type: resp.provider.type as SearchProviderType,
      baseUrl: resp.provider.baseUrl,
      apiKey: resp.apiKey
    };
    const maxToolCalls = Number(resp.maxToolCalls) > 0 ? Number(resp.maxToolCalls) : 5;
    return {
      maxToolCalls,
      executeSearch: (query) => executeWebSearch(config, query, undefined, signal ?? null)
    };
  } catch {
    // 消息失败/无接收方（SW 冷启动竞态等）：维持无联网，与未配置同路径。
    return undefined;
  }
}
