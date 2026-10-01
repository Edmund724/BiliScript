// extension/search/search-runtime.ts
// 联网搜索运行时解析器（spec §1 S4、§3 落点表第 14 行、§5 查询缓存）：resolve-search-provider
// 单趟往返拿**回退链**（有序候选 + 各自 Key）+ 单轮上限，组装 executeSearch 闭包。
// offscreen 与选区解释链（reader）同走此解析（纯 runtime 消息，无 chrome.storage
// 依赖）；chain 为空 / 解析失败返回 undefined，调用方 notice 后走原无工具路径——
// 搜索是增强，缺失不阻塞问答。
// executeSearch 的顺序（§5「缓存层次 = 链层·引擎无关」）：先 search-cache get →
// 命中直回（platform 取缓存记录的那家、跳过整条链）→ 未命中跑 executeSearchChain →
// 链成功返回（含空结果集）后 put；失败 / 中止在链处抛出，天然不写缓存。
import type { NormalizedSearchResult } from "./adapters/types.js";
import { searchCacheClient } from "./search-cache-client.js";
import { executeSearchChain } from "./search-chain.js";
import type { ResolveSearchProviderResponse } from "../shared/messaging-protocol.js";

// executeSearch 的产物面：results 用归一形状（对 ai/ladder 的 WebSearchRuntime 窄面
// unknown[] 与 ai/explain 的 ToolLoopSearchOutcome 均结构兼容）；downgradedFrom 供
// 模型侧降级注记（透传至 ai/tool-loop.ts 的注记行）。
export interface WebSearchRuntime {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<{
    results: NormalizedSearchResult[];
    platform: string;
    downgradedFrom?: string;
  }>;
}

// signal 透传 executeSearchChain → executeWebSearch：调用方（聊天 abort controller /
// 解释卡中止器）停止可中断在途搜索，且中止不写缓存。
export async function resolveWebSearchRuntime(
  signal?: AbortSignal | null
): Promise<WebSearchRuntime | undefined> {
  try {
    // runtime 消息直发（MV3 Promise 风格，见 offscreen 同款解析）；await 的
    // unknown 回包在传输边界收窄为协议响应类型（arch-slim-2/02 单点 cast 同性质）。
    const resp = (await chrome.runtime.sendMessage({
      type: "resolve-search-provider"
    })) as ResolveSearchProviderResponse | null;
    // 第二道闸（spec §3 第 14 行）：判据是 chain 非空——keyless 候选的 apiKey 允许
    // 空串，按 apiKey 非空判会把免 Key 家误判成「未配置」。
    const chain = resp?.ok && Array.isArray(resp.chain) ? resp.chain : [];
    if (chain.length === 0) {
      return undefined;
    }
    const maxToolCalls = Number(resp?.maxToolCalls) > 0 ? Number(resp?.maxToolCalls) : 5;
    return {
      maxToolCalls,
      executeSearch: async (query) => {
        // 缓存层次 = 链层·引擎无关（§5）：命中即跳过整条链（含链首）。
        const cached = await searchCacheClient.get(query);
        if (cached) {
          return { results: cached.results, platform: cached.platform };
        }
        const outcome = await executeSearchChain(chain, query, { signal: signal ?? null });
        // 只有链成功返回（含空结果集）才写；写失败静默、不阻塞回答（fire-and-forget）。
        void searchCacheClient.put({
          query,
          results: outcome.results,
          platform: outcome.platform
        });
        return outcome;
      }
    };
  } catch {
    // 消息失败/无接收方（SW 冷启动竞态等）：维持无联网，与未配置同路径。
    return undefined;
  }
}
