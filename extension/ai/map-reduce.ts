import { makeAbortedError, isAbortedMarkerError } from "../shared/error-helpers.js";
import { formatSegmentHeading, formatSegmentItem } from "./subtitle-prompt.js";
import { buildBudgetPlan, FINAL_OUTPUT_CHARS, SEGMENT_SUMMARY_CHARS, SEGMENT_INPUT_CHARS, REDUCE_GROUP_INPUT_CHARS } from "./budgeter.js";
import { chatCompletion } from "./completion.js";
import { runCachedMap } from "./pool.js";
import { shouldReduce, reduceSummaries } from "./reduce.js";
import { segmentCacheProxy, type SegmentCacheOps } from "./segment-cache-proxy.js";
import type { BudgetPlan, BudgetPlanSegment, ChatMessage, ProviderRequest } from "./types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import type { ChatPort, ChatPortMessage } from "../chat/protocol.js";

const MAX_ITEM_CHARS = 4000;

const NOTE_EDITOR_SYSTEM_PROMPT =
  "你是视频笔记编辑。忠实理解语境与作者意图，允许结合上下文保守修正明显的口误、笔误和语音转写错误。" +
  "字幕是自动语音识别（ASR）生成的：同音错别字多，人名、品牌名与术语尤其易错——按视频标题与上下文推断本字后再写入笔记，但不要改写原意。";

const OVERFLOW_RETRY_BUDGET_SCALE = 0.5;
const OVERFLOW_RETRY_NOTICE = "模型上下文不足，已自动调低单段素材量并重试";
const OVERFLOW_STILL_MESSAGE = "该视频素材在调低分段量后仍超出模型上下文，请更换上下文窗口更大的模型后重试";

type ChatCompletionImpl = typeof chatCompletion;

export function buildProgressNotice(index: number | unknown, total: number | unknown): string {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeIndex = Math.min(Math.max(1, Number(index) || 1), safeTotal);
  const percent = Math.round((safeIndex / safeTotal) * 100);
  return `正在整理第 ${safeIndex}/${safeTotal} 段（${percent}%）`;
}

function buildSegmentPrompt({ title, index, total, items }: { title: string; index: number; total: number; items: unknown[] }): string {
  const segmentLines = (Array.isArray(items) ? items : []).map((item) => {
    const text = formatSegmentItem(item);
    return text.length > MAX_ITEM_CHARS ? text.slice(0, MAX_ITEM_CHARS) + "…" : text;
  });
  return `视频标题：${title}
这是第 ${index}/${total} 个连续片段。

请把这个片段忠实压缩到原文的约五分之一（重要内容多可适当放宽），供后续撰写完整笔记使用。
保留重要事实、例子、论证关系和原有时间点；
结合上下文理解表达意图，不做评价，不补充外部知识。

字幕：
${segmentLines.join("\n")}`;
}

function buildNotePrompt({ title, material }: { title: string; material: string }): string {
  return `写一份翔实、自然的 Markdown 视频笔记。完整复原内容脉络、具体例子、核心观点及其依据，
并在有帮助时加入关键时间点。不要加入外部知识或评价。信息点要齐全，长视频不要过度压缩；
全文以一万二千字以内为宜，密度优先，不要为凑长度注水。

视频标题：${title}

以准确理解语境和作者立场为先。时间点只能取自材料。可在上下文支持时直接修正明显的口误、
笔误或转写错误。结构按内容自然组织，不必凑固定模板。标题使用：# 视频笔记：《${title}》

材料：
${material}`;
}

function buildMaterial(summaries: unknown[]): string {
  const list = Array.isArray(summaries) ? summaries : [];
  return list
    .map((summary, i) => `${formatSegmentHeading(i)}\n${String(summary || "")}`)
    .join("\n\n");
}

interface SummarizeSegmentInput {
  provider: ProviderRequest;
  context: Record<string, unknown>;
  segment: BudgetPlanSegment;
  total: number;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  chatCompletionImpl: ChatCompletionImpl;
  segmentCache: SegmentCacheOps;
  notifyCacheWriteError: () => void;
  budgetScale?: number | unknown;
}

async function summarizeSegment({
  provider,
  context,
  segment,
  total,
  signal,
  thinkingLevel,
  chatCompletionImpl,
  segmentCache,
  notifyCacheWriteError,
  budgetScale = 1
}: SummarizeSegmentInput): Promise<string> {
  if (signal?.aborted) {
    throw makeAbortedError();
  }

  const prompt = buildSegmentPrompt({
    title: String(context?.title || "未知"),
    index: segment.index,
    total,
    items: segment.items || []
  });
  const summary = await chatCompletionImpl({
    provider,
    messages: [
      { role: "system", content: NOTE_EDITOR_SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ],
    thinkingLevel,
    signal
  });

  const trimmed = String(summary || "").trim();
  const clamped = trimmed.length > SEGMENT_SUMMARY_CHARS ? trimmed.slice(0, SEGMENT_SUMMARY_CHARS) : trimmed;
  const savedSummary = await segmentCache.saveSummary({ context, segmentIndex: segment.index, budgetScale, summary: clamped });
  if (savedSummary && savedSummary.ok === false && typeof notifyCacheWriteError === "function") {
    notifyCacheWriteError();
  }
  return clamped;
}

interface OrchestrateMapReduceInput {
  provider: ProviderRequest;
  context?: Record<string, unknown> | null;
  plan?: BudgetPlan | null;
  port?: ChatPort | null;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  onProgress?: (notice: string) => void;
  chatCompletion?: ChatCompletionImpl;
  segmentCache?: SegmentCacheOps;
}

interface MapReduceResult {
  draft: string;
  segmentSummaries: string[];
  aborted: boolean;
}

export async function orchestrateMapReduce({
  provider,
  context,
  plan,
  port,
  signal,
  thinkingLevel,
  onProgress,
  chatCompletion: chatCompletionImpl = chatCompletion,
  segmentCache = segmentCacheProxy
}: OrchestrateMapReduceInput): Promise<MapReduceResult> {
  const ctx = context || {};
  const post = (message: ChatPortMessage) => {
    if (port && typeof port.postMessage === "function") {
      port.postMessage(message);
    }
  };

  const abortReturn = (segmentSummaries: string[] = []): MapReduceResult => {
    post({ type: "stopped", reason: "已停止生成" });
    return { draft: "", segmentSummaries, aborted: true };
  };

  let cacheWriteNoticeShown = false;
  const notifyCacheWriteError = () => {
    if (cacheWriteNoticeShown) {
      return;
    }
    cacheWriteNoticeShown = true;
    post({ type: "notice", data: "本地字幕缓存写入失败（已自动清理旧视频缓存仍失败），本次结果可能无法跨会话复用。" });
  };

  interface RunOnceInput {
    budgetScale: number;
    injectedPlan: BudgetPlan | null | undefined;
  }

  const runOnce = async ({ budgetScale, injectedPlan }: RunOnceInput): Promise<MapReduceResult> => {
    const resolvedPlan =
      injectedPlan ||
      buildBudgetPlan(
        {
          body: Array.isArray(ctx.subtitleBody) ? ctx.subtitleBody : [],
          chapters: Array.isArray(ctx.chapters) ? ctx.chapters : []
        },
        {
          segmentInputChars: Math.round(SEGMENT_INPUT_CHARS * budgetScale),
          reduceGroupInputChars: Math.round(REDUCE_GROUP_INPUT_CHARS * budgetScale)
        }
      );
    const segments = Array.isArray(resolvedPlan.segments) ? resolvedPlan.segments : [];
    const total = segments.length;

    const segmentSummaries: string[] = [];

    const emitProgress = (index: number) => {
      const notice = buildProgressNotice(index, total);
      emitNotice(notice);
    };
    const emitNotice = (notice: string) => {
      if (typeof onProgress === "function") {
        onProgress(notice);
      } else {
        post({ type: "notice", data: notice });
      }
    };

    let done: { segment: BudgetPlanSegment; summary: string }[];
    try {
      done = await runCachedMap({
        items: segments,
        loadCached: async (segment) => {
          const cached = await segmentCache.loadSummary({ context: ctx, segmentIndex: segment.index, budgetScale });
          return cached != null ? { segment, summary: cached } : null;
        },
        run: async (segment) => ({
          segment,
          summary: await summarizeSegment({
            provider,
            context: ctx,
            segment,
            total,
            signal,
            thinkingLevel,
            chatCompletionImpl,
            segmentCache,
            notifyCacheWriteError,
            budgetScale
          })
        }),
        signal,
        onItemDone: (result, index) => {
          segmentSummaries[index] = result?.summary || "";
          emitProgress(result?.segment?.index ?? index + 1);
        }
      });
    } catch (e) {
      if (isAbortedMarkerError(e) || signal?.aborted) {
        return abortReturn(segmentSummaries);
      }
      throw e;
    }

    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    let materialSummaries = done.map((r) => r?.summary || "").filter((s) => s != null);
    if (shouldReduce(resolvedPlan) && materialSummaries.length > 1) {
      let merged;
      try {
        merged = await reduceSummaries({
          summaries: materialSummaries,
          title: String(ctx.title || "未知"),
          groupInputChars: resolvedPlan.reduceGroupInputChars,
          runPrompts: async ({ prompt, messages }: { prompt?: string; messages?: unknown[] }) => {
            const text = await chatCompletionImpl({
              provider,
              messages: (messages as ChatMessage[] | undefined) || [
                { role: "system", content: NOTE_EDITOR_SYSTEM_PROMPT },
                { role: "user", content: prompt || "" }
              ],
              thinkingLevel,
              signal
            });
            return String(text || "");
          },
          signal,
          onProgress: emitNotice
        });
      } catch (e) {
        if (isAbortedMarkerError(e) || signal?.aborted) {
          return abortReturn(segmentSummaries);
        }
        throw e;
      }
      materialSummaries = Array.isArray(merged?.merged) ? merged.merged : materialSummaries;
    }
    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    const material = buildMaterial(materialSummaries);
    const notePrompt = buildNotePrompt({ title: String(ctx.title || "未知"), material });

    let draft = "";
    try {
      draft = String(
        await chatCompletionImpl({
          provider,
          messages: [
            { role: "system", content: NOTE_EDITOR_SYSTEM_PROMPT },
            { role: "user", content: notePrompt }
          ],
          thinkingLevel,
          signal
        }) || ""
      ).trim();
    } catch (e) {
      if (isAbortedMarkerError(e) || signal?.aborted) {
        return abortReturn(segmentSummaries);
      }
      throw e;
    }

    if (signal?.aborted) {
      return abortReturn(segmentSummaries);
    }

    if (draft.length > FINAL_OUTPUT_CHARS) {
      draft = draft.slice(0, FINAL_OUTPUT_CHARS);
    }

    post({ type: "token", data: draft });
    post({ type: "done" });
    return { draft, segmentSummaries, aborted: false };
  };

  try {
    return await runOnce({ budgetScale: 1, injectedPlan: plan });
  } catch (e) {
    if (isAbortedMarkerError(e) || signal?.aborted) {
      return abortReturn();
    }
    if (!(e as { overflow?: boolean })?.overflow) {
      throw e;
    }
    post({ type: "notice", data: OVERFLOW_RETRY_NOTICE });
    try {
      return await runOnce({ budgetScale: OVERFLOW_RETRY_BUDGET_SCALE, injectedPlan: null });
    } catch (e2) {
      if (isAbortedMarkerError(e2) || signal?.aborted) {
        return abortReturn();
      }
      if ((e2 as { overflow?: boolean })?.overflow) {
        throw new Error(OVERFLOW_STILL_MESSAGE);
      }
      throw e2;
    }
  }
}
