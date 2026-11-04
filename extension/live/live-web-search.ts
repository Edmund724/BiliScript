import { serializeSearchResults } from "../ai/tool-loop.js";
import { resolveWebSearchRuntime } from "../search/search-runtime.js";
import { formatPaidFallbackNotice } from "../search/search-chain.js";

export interface LiveWebSearchOutcome {
  output: string;
  resultCount: number;
  platform?: string;
}

export type LiveWebSearchExecutor = (
  query: string,
  signal: AbortSignal,
  toolCallIndex?: number
) => Promise<LiveWebSearchOutcome>;

export async function executeLiveWebSearch(
  query: string,
  signal: AbortSignal,
  toolCallIndex = 0
): Promise<LiveWebSearchOutcome> {
  const resolution = await resolveWebSearchRuntime(signal);
  if (signal.aborted) {
    throw new Error("搜索已中止");
  }
  if (!resolution.runtime) {
    throw new Error(resolution.notice || "联网搜索不可用");
  }
  if (toolCallIndex >= resolution.runtime.maxToolCalls) {
    throw new Error(`本轮的搜索次数已达上限（${resolution.runtime.maxToolCalls} 次），请基于已有搜索结果作答。`);
  }

  const outcome = await resolution.runtime.executeSearch(query);
  if (signal.aborted) {
    throw new Error("搜索已中止");
  }
  const paidBadge = outcome.paid ? "（付费）" : "";
  const sourceNote = outcome.downgradedFrom
    ? `首选 ${outcome.downgradedFrom} 未成功，以下结果来自 ${outcome.platform}${paidBadge}。\n`
    : `以下结果来自 ${outcome.platform}${paidBadge}。\n`;
  const paidFallbackNote = outcome.paidFallback
    ? `${formatPaidFallbackNotice(outcome.paidFallback)}\n`
    : "";
  if (outcome.results.length === 0) {
    return {
      output: `${paidFallbackNote}${sourceNote}联网搜索完成，但没有找到与“${query}”相关的结果。请明确告诉用户没有查到相关事实，不要编造。`,
      resultCount: 0,
      platform: outcome.platform
    };
  }

  return {
    output: `${paidFallbackNote}${sourceNote}请根据以下来源回答用户，并保留可核验的标题与链接：\n${serializeSearchResults(outcome.results)}`,
    resultCount: outcome.results.length,
    platform: outcome.platform
  };
}
