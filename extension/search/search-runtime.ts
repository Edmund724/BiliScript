// extension/search/search-runtime.ts
// 联网搜索运行时解析器（spec §1 S4、§3 落点表第 14 行）：resolve-search-provider
// 单趟往返拿**回退链**（有序候选 + 各自 Key）+ 单轮上限，组装 executeSearch 闭包。
// offscreen 与选区解释链（reader）同走此解析（纯 runtime 消息，无 chrome.storage
// 依赖）；chain 为空 / 解析失败返回 undefined，调用方 notice 后走原无工具路径——
// 搜索是增强，缺失不阻塞问答。
import { executeWebSearch, type SearchExecutorConfig } from "./search-executor.js";
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
    // 第二道闸（spec §3 第 14 行）：判据是 chain 非空——keyless 候选的 apiKey 允许
    // 空串，按 apiKey 非空判会把免 Key 家误判成「未配置」。
    const chain = resp?.ok && Array.isArray(resp.chain) ? resp.chain : [];
    if (chain.length === 0) {
      return undefined;
    }
    const candidates: SearchExecutorConfig[] = chain.map((candidate) => ({
      type: candidate.provider.type as SearchProviderType,
      baseUrl: candidate.provider.baseUrl,
      apiKey: candidate.apiKey
    }));
    const platforms = chain.map((candidate) => candidate.provider.name);
    const maxToolCalls = Number(resp?.maxToolCalls) > 0 ? Number(resp?.maxToolCalls) : 5;
    return {
      maxToolCalls,
      // 最小链执行（批次②换成正式 executeSearchChain）：按候选顺序逐个尝试，
      // 单候选失败静默试下一个，首个成功返回（platform 取实际成功家）；全部失败
      // 抛出最后一个错误。链级预算 30s、失败分类与中止出口属批次②。
      executeSearch: async (query) => {
        let lastError: unknown = new Error("搜索失败：无可用搜索平台");
        for (let index = 0; index < candidates.length; index += 1) {
          try {
            const outcome = await executeWebSearch(candidates[index], query, undefined, signal ?? null);
            return { results: outcome.results, platform: platforms[index] };
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      }
    };
  } catch {
    // 消息失败/无接收方（SW 冷启动竞态等）：维持无联网，与未配置同路径。
    return undefined;
  }
}
