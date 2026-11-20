// 「概览数据管线」三片之编排（arch-slim-3 #11 自 ai/analysis.ts 切出；ADR-0027 升级）：
// 分章来源裁定、短视频单发直通、超长视频滑动状态卡接力 + L0 行号金句回填 + L1 章节目录固化、
// 两级缓存接线、成本护栏与 inflightOverviews promise 复用（全仓唯一的 analysis 模块态）。
// 对外经 analysis.ts 壳再导出。

// source key（轨身份编码单点）归键位叶 subtitle/source-key；纯签名与归一化归 subtitle/signature。
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { normalizeSubtitleItems } from "../subtitle/signature.js";
import { logError } from "../shared/logging.js";
import { makeAbortedError, isAbortedMarkerError } from "../shared/error-helpers.js";
import { createAiArtifactFamily } from "../subtitle/ai-artifact-cache.js";
// 概览请求的传输层（overview-offscreen-transport）：content 直发服从网页 CORS，
// 平台网关的预检白名单不含 Anthropic 的 x-api-key / anthropic-version（实测
// ModelScope），故概览的每一次调用都经 offscreen 代发（长请求宿主，见模块头注）。
import { providerFetchViaOffscreen } from "../core/provider-http-offscreen.js";
import { buildCostGuardNotice as _buildCostGuardNotice, runCostGuard } from "./cost-guard.js";
import { chatCompletion as _chatCompletion } from "./completion.js";
import { parseLooseJson } from "./json-repair.js";
// 空正文重试的触发判定与预算（empty-text-retry.ts，与 chat 链同源）。
import { isEmptyTextRetryable, retryBudget } from "./empty-text-retry.js";
// 「加倍重跑还值不值得发」的判定（learned-budget.ts）：平台学到的上限已到顶时，
// 加倍请求会与上一次完全相同，重跑只是白花一次调用。
import { canRaiseBudget } from "./learned-budget.js";
import { buildProgressNotice } from "./map-reduce.js";
import { budgetScaleSuffix } from "./segment-cache.js";
// 段缓存键位字段清单与命名投影的单源（零依赖叶，候选 5）：概览族的键位装配不再手抄
// 字段名或强转口径，与 SW 段缓存装配 / offscreen 出站点 / 协议载荷类型同一份表。
import { segmentCacheKeyStringFields } from "./segment-cache-key-fields.js";
// 成本护栏 token 数字的唯一换算函数（实测比 / CHAR_PER_TOKEN 回落）：与阶梯链
// （ai/ladder.ts）共用同一实现，两条链的数字因此同源。
import { estimateTokensFromChars } from "./usage-stats.js";
import { validateAnalysis, type OverviewAnalysis } from "./analysis-validate.js";
import {
  buildAnalysisPrompt,
  buildStateRelayFinalSummaryPrompt,
  buildStateRelayStepPrompt,
  estimateOutputTokens,
  STATE_RELAY_FINAL_SUMMARY_SYSTEM_PROMPT,
  STATE_RELAY_GIVEN_CHAPTERS_SYSTEM_PROMPT,
  STATE_RELAY_OUTLINE_QUOTES_SYSTEM_PROMPT,
  STATE_RELAY_SYSTEM_PROMPT,
  type BuiltAnalysisPrompt
} from "./analysis-prompts.js";
// 分章计划单源（arch-review-2026-09 候选 2）：来源裁定的解释、越界过滤、切段输入与
// 末章界全部收敛到 ai/chapter-plan.ts，本模块只读它的产物。
import { resolveChapterPlan, flagMissingChapterSummaries, type ChapterPlan } from "./chapter-plan.js";
import { normalizeL0SubtitleLines } from "./l0-bm25.js";
import {
  buildAnalysisFinalCacheKey,
  buildClipOverviewIdentity,
  buildL1VideoIndex,
  isOverviewShape,
  loadAnalysisFinal,
  loadL1Index,
  saveAnalysisFinal,
  saveL1Index,
  type ClipOverviewIdentity
} from "./l1-chapter-index.js";
export { buildAnalysisFinalCacheKey };
import {
  advanceFallbackStateCard,
  decideOverviewRelaySplit,
  mergeRelayOutcomes,
  parseRelayFinalSummary,
  parseStateRelayOutput,
  type RawRelayStepData
} from "./state-relay.js";
import type { L0SubtitleLine, L1ChapterNode, L1QuoteRef, StateRelayCard } from "./long-video-hybrid-types.js";
import type { ChatMessage, ProviderRequest } from "./types.js";
// 未归一的档位外部值的声明面（词表叶；本层只透传，不判不归）。纯类型引入：无运行时依赖边。
import type { ThinkingLevelInput } from "./thinking-levels.js";

// 概览分段产物缓存键前缀（键形与 biliscript_lvs_summary_ 同族：…+ 段序号 [+ 预算代]）。
// 两族（整份概览产物在 ai/l1-chapter-index.ts）均已注册进 core/cache-lru.ts 的 CACHE_FAMILIES。
const ANALYSIS_SEGMENT_PREFIX = "biliscript_lvs_analysis_";

// ============================================================
// 缓存（扩展源 IndexedDB `ai_artifacts` + SW RPC + 懒迁移；读取失败静默返回 null）
// ============================================================

interface RelaySegmentCacheEntry extends OverviewAnalysis {
  relayVersion: 1;
  nextStateCard: StateRelayCard;
  l1Chapters: L1ChapterNode[];
  l1Quotes: L1QuoteRef[];
}

function isRelaySegmentCacheEntry(value: unknown): value is RelaySegmentCacheEntry {
  if (!isOverviewShape(value)) {
    return false;
  }
  const entry = value as Partial<RelaySegmentCacheEntry>;
  return (
    entry.relayVersion === 1 &&
    Boolean(entry.nextStateCard && typeof entry.nextStateCard === "object") &&
    Array.isArray(entry.l1Chapters) &&
    Array.isArray(entry.l1Quotes)
  );
}

const analysisSegmentFamily = createAiArtifactFamily<OverviewAnalysis>({
  family: ANALYSIS_SEGMENT_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BILISCRIPT] failed to save analysis cache after eviction", info)
});

/**
 * 概览分段产物缓存键：与 biliscript_lvs_summary_ 同族键形（…+ 段序号 [+ 预算代]，
 * 尾部再挂字幕签名），仅族前缀不同——产物不共享、键位机制共享。
 */
export function buildAnalysisSegmentCacheKey(
  context: Record<string, unknown> | undefined | null,
  segmentIndex: number | string | unknown,
  signature: unknown,
  budgetScale: number | string | unknown = 1
): string {
  return analysisSegmentFamily.key(
    segmentCacheKeyStringFields(context),
    `${segmentIndex}${budgetScaleSuffix(budgetScale)}_${String(signature ?? "")}`
  );
}

// ============================================================
// 编排入口：双路径分派 + promise 复用 + 成本护栏 + L1 缓存固化
// ============================================================

type ChatCompletionFn = typeof _chatCompletion;

interface TokenProgressState {
  contentChars: number;
  reasoningChars: number;
}

type BuildCostGuardNoticeFn = typeof _buildCostGuardNotice;

interface RunOverviewAnalysisArgs {
  provider: ProviderRequest;
  /** AI 上下文（AiContext 形状）：bvid/cid/字幕轨三键位 + title/author/videoDescription + subtitleBody/chapters。 */
  context: Record<string, unknown>;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  /** 跳过整份缓存读取重新生成（分段缓存仍复用——重试只重跑未落盘段）。 */
  forceRefresh?: boolean;
}

interface RunOverviewAnalysisDeps {
  chatCompletion?: ChatCompletionFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  /** 成本护栏确认钩子（≥5 次调用时）；未注入则不阻塞、直接生成。 */
  askCostGuard?: (message: string) => Promise<unknown>;
  /** 分段进度回调（可选，数据层无 port）。 */
  onProgress?: (notice: string) => void;
}

const inflightOverviews = new Map<string, Promise<OverviewAnalysis>>();

function makeOverviewCancelledError(): Error & { cancelled: true } {
  const error = new Error("已取消") as Error & { cancelled: true };
  error.cancelled = true;
  return error;
}

function makeEmptyAnalysisError(): Error {
  return new Error("模型没有产出有效的简介、章节或金句，请重试。");
}

/**
 * 流式模型请求统一入口（传输钉死 offscreen 代发，含空正文与 finish_reason=length 加倍重试）。
 */
async function requestStreamedAnalysisText({
  provider,
  systemPrompt,
  built,
  thinkingLevel,
  signal,
  retries,
  chatCompletionImpl,
  onTokenProgress
}: {
  provider: ProviderRequest;
  systemPrompt: string;
  built: BuiltAnalysisPrompt;
  thinkingLevel?: ThinkingLevelInput;
  signal?: AbortSignal | null;
  retries?: number;
  chatCompletionImpl: ChatCompletionFn;
  onTokenProgress?: (state: TokenProgressState) => void;
}): Promise<string> {
  if (signal?.aborted) {
    throw makeAbortedError();
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: built.prompt }
  ];
  const baseMaxTokens = estimateOutputTokens(built.transcriptChars, { ratio: 0.5, floor: 2048 });
  const raisedMaxTokens = retryBudget(baseMaxTokens);
  let text = "";
  let reasoningChars = 0;
  let truncated = false;

  const onEvent = (event: unknown): void => {
    const streamEvent = event as { type?: string; data?: unknown } | null;
    if (streamEvent?.type === "token") {
      text += String(streamEvent.data ?? "");
    } else if (streamEvent?.type === "reasoning") {
      reasoningChars += String(streamEvent.data ?? "").length;
    } else {
      return;
    }
    onTokenProgress?.({ contentChars: text.length, reasoningChars });
  };

  const requestBase = {
    provider,
    messages,
    thinkingLevel,
    signal,
    retries,
    fetchImpl: providerFetchViaOffscreen,
    stream: true,
    onEvent,
    onStreamReset: () => {
      text = "";
    },
    onFinishReason: (reason: string | null) => {
      truncated = reason === "length";
    }
  };

  await chatCompletionImpl({ ...requestBase, maxTokens: baseMaxTokens });
  if (
    canRaiseBudget(provider, baseMaxTokens, raisedMaxTokens) &&
    (isEmptyTextRetryable({ hasBody: Boolean(text.trim()) }) || truncated)
  ) {
    text = "";
    reasoningChars = 0;
    truncated = false;
    await chatCompletionImpl({
      ...requestBase,
      maxTokens: raisedMaxTokens
    });
  }
  if (!text.trim()) {
    throw new Error("模型没有返回正文（输出预算可能被思考过程占满），请重试。");
  }
  return text;
}

const OVERVIEW_TOKEN_PROGRESS_THROTTLE_MS = 1000;

function buildTokenProgressReporter(
  onProgress?: (notice: string) => void
): ((state: TokenProgressState) => void) | undefined {
  if (typeof onProgress !== "function") {
    return undefined;
  }
  let lastAt = 0;
  let lastNotice = "";
  return ({ contentChars, reasoningChars }) => {
    const notice = contentChars > 0 ? `正在生成概览…（已接收 ${contentChars} 字）` : reasoningChars > 0 ? "模型正在思考…" : "";
    if (!notice || notice === lastNotice) {
      return;
    }
    const now = Date.now();
    if (now - lastAt < OVERVIEW_TOKEN_PROGRESS_THROTTLE_MS) {
      return;
    }
    lastAt = now;
    lastNotice = notice;
    onProgress(notice);
  };
}

function selectRelaySystemPrompt(chapterPlan: ChapterPlan): string {
  if (!chapterPlan.hasGivenChapters) {
    return STATE_RELAY_SYSTEM_PROMPT;
  }
  return chapterPlan.titlesOnly
    ? STATE_RELAY_OUTLINE_QUOTES_SYSTEM_PROMPT
    : STATE_RELAY_GIVEN_CHAPTERS_SYSTEM_PROMPT;
}

async function persistL1IndexForOverview({
  identity,
  videoDuration,
  l0Lines,
  analysis,
  l1Chapters,
  l1Quotes,
  fallbackGlobalSummary
}: {
  identity: ClipOverviewIdentity;
  videoDuration: unknown;
  l0Lines: readonly L0SubtitleLine[];
  analysis: OverviewAnalysis;
  l1Chapters?: readonly L1ChapterNode[];
  l1Quotes?: readonly L1QuoteRef[];
  fallbackGlobalSummary?: string;
}): Promise<void> {
  if (!identity.bvid || !identity.cid) {
    return;
  }
  const globalSummary = String(analysis.summary || fallbackGlobalSummary || "").trim();
  const record = buildL1VideoIndex({
    bvid: identity.bvid,
    cid: identity.cid,
    subtitleId: identity.subtitleId,
    subtitleUrl: identity.subtitleUrl,
    subtitleLang: identity.subtitleLang,
    subtitleSignature: identity.signature,
    videoDuration: Number(videoDuration) || undefined,
    globalSummary,
    lines: l0Lines,
    chapters: l1Chapters ?? analysis.chapters,
    quotes: l1Quotes ?? analysis.quotes
  });
  await saveL1Index(identity.l1Key, record);
}

async function ensureL1IndexOnCacheHit({
  identity,
  videoDuration,
  l0Lines,
  analysis
}: {
  identity: ClipOverviewIdentity;
  videoDuration: unknown;
  l0Lines: readonly L0SubtitleLine[];
  analysis: OverviewAnalysis;
}): Promise<void> {
  if (!identity.bvid || !identity.cid) {
    return;
  }
  const existing = await loadL1Index(identity.l1Key);
  if (!existing) {
    await persistL1IndexForOverview({ identity, videoDuration, l0Lines, analysis });
  }
}

/**
 * 概览生成编排入口：
 * 1. 分流阈值判定：常规短视频（字幕跨度 ≤30 分钟且 ≤200k 字符）维持单次直通流程，结束后顺带构建 L1 缓存；
 *    超长视频按 10～15 分钟（对齐 5 分钟转写分片边界）切窗并执行「滑动状态卡串行接力 + L0 行号原文回填」。
 * 2. 轻量收尾汇总：仅基于各段汇总的 L1 章节节点与最终状态卡提炼全片总体简介，并固化 L1 缓存。
 * 3. 容错与断点续跑：单窗失败不中断整体生成（推进降级状态卡并记录 failedRanges）；每窗结果落段缓存供重试复用。
 */
export function runOverviewAnalysis(
  { provider, context, signal, thinkingLevel, forceRefresh = false }: RunOverviewAnalysisArgs,
  deps: RunOverviewAnalysisDeps = {}
): Promise<OverviewAnalysis> {
  const ctx = context || {};
  const identity = buildClipOverviewIdentity(ctx);
  const { finalKey } = identity;

  const inflight = forceRefresh ? undefined : inflightOverviews.get(finalKey);
  if (inflight) {
    return inflight;
  }
  const runProvider = { ...provider, sessionId: finalKey };
  const promise = executeOverviewRun({
    provider: runProvider,
    ctx,
    identity,
    signal,
    thinkingLevel,
    forceRefresh,
    chatCompletionImpl: deps.chatCompletion ?? _chatCompletion,
    buildCostGuardNoticeImpl: deps.buildCostGuardNotice ?? _buildCostGuardNotice,
    askCostGuard: deps.askCostGuard,
    onProgress: deps.onProgress
  });
  if (!forceRefresh) {
    inflightOverviews.set(finalKey, promise);
    const cleanup = () => {
      if (inflightOverviews.get(finalKey) === promise) {
        inflightOverviews.delete(finalKey);
      }
    };
    void (async () => {
      try {
        await promise;
      } catch {
        // 拒绝在此收口，仅保证清理执行。
      } finally {
        cleanup();
      }
    })();
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: ProviderRequest;
  ctx: Record<string, unknown>;
  identity: ClipOverviewIdentity;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  forceRefresh: boolean;
  chatCompletionImpl: ChatCompletionFn;
  buildCostGuardNoticeImpl: BuildCostGuardNoticeFn;
  askCostGuard?: (message: string) => Promise<unknown>;
  onProgress?: (notice: string) => void;
}

async function executeOverviewRun({
  provider,
  ctx,
  identity,
  signal,
  thinkingLevel,
  forceRefresh,
  chatCompletionImpl,
  buildCostGuardNoticeImpl,
  askCostGuard,
  onProgress
}: ExecuteOverviewRunArgs): Promise<OverviewAnalysis> {
  const { body, chapterSource, signature, finalKey } = identity;
  const normalizedItems = normalizeSubtitleItems(body);
  if (normalizedItems.length === 0) {
    throw new Error("没有可用的字幕");
  }
  const l0Lines = normalizeL0SubtitleLines(normalizedItems);
  const chapterPlan = resolveChapterPlan({ chapterSource, context: ctx, body });
  const expectsChapterSummaries = chapterPlan.hasGivenChapters && !chapterPlan.titlesOnly;

  if (!forceRefresh) {
    const cached = await loadAnalysisFinal(finalKey);
    if (cached) {
      const allSummariesEmpty =
        expectsChapterSummaries &&
        cached.chapters.length > 0 &&
        cached.chapters.every((chapter) => !String(chapter?.summary ?? "").trim());
      if (!allSummariesEmpty) {
        const result = expectsChapterSummaries ? flagMissingChapterSummaries(cached) : cached;
        await ensureL1IndexOnCacheHit({ identity, videoDuration: ctx.videoDuration, l0Lines, analysis: result });
        return result;
      }
    }
  }

  const relayDecision = decideOverviewRelaySplit(l0Lines, {
    budgetChapters: chapterPlan.budgetChapters
  });

  // —— 短视频单次直通路径（保持原有流程并在完成后顺带固化 L1 缓存）——
  if (!relayDecision.shouldRelay) {
    const startSeconds = Math.max(0, Math.floor(Number(normalizedItems[0]?.from) || 0));
    const built = buildAnalysisPrompt({
      ...chapterPlan.promptVars,
      items: body,
      contextItems: [],
      videoDuration: ctx.videoDuration,
      startSeconds,
      segmentIndex: 1,
      totalSegments: 1
    });
    const text = await requestStreamedAnalysisText({
      provider,
      systemPrompt: chapterPlan.systemPrompt,
      built,
      thinkingLevel,
      signal,
      retries: 2,
      chatCompletionImpl,
      onTokenProgress: buildTokenProgressReporter(onProgress)
    });
    const part = validateAnalysis(
      parseLooseJson(text),
      built.timing.maxTimestampSeconds,
      chapterPlan.hasGivenChapters ? 0 : startSeconds
    );
    const analysis: OverviewAnalysis = { ...part, chapters: chapterPlan.graft(part.chapters) };
    analysis.summaryFailed = !analysis.summary;
    if (!analysis.summary && !analysis.chapters.length && !analysis.quotes.length) {
      throw makeEmptyAnalysisError();
    }
    await saveAnalysisFinal(finalKey, analysis);
    await persistL1IndexForOverview({ identity, videoDuration: ctx.videoDuration, l0Lines, analysis });
    return analysis;
  }

  // —— 超长视频：10～15 分钟平滑窗口 + 滑动状态卡串行接力 + L0 行号原文回填 ——
  const windows = relayDecision.windows;
  if (typeof askCostGuard === "function") {
    await runCostGuard({
      estimatedCalls: windows.length + 1,
      estimatedTokens: estimateTokensFromChars(provider, relayDecision.totalChars),
      buildNotice: buildCostGuardNoticeImpl,
      precheck: () => {
        if (signal?.aborted) {
          throw makeAbortedError();
        }
      },
      ask: askCostGuard,
      onDecline: () => {
        throw makeOverviewCancelledError();
      }
    });
  }

  const relaySystemPrompt = selectRelaySystemPrompt(chapterPlan);
  const totalWindows = windows.length;
  const stepOutcomes: Array<{ ok: true; data: RawRelayStepData } | { ok: false; from: number; to: number; error: unknown }> = [];
  let previousStateCard: StateRelayCard | null = null;

  for (let i = 0; i < totalWindows; i += 1) {
    const win = windows[i];
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const segKey = buildAnalysisSegmentCacheKey(ctx, win.windowIndex + 1, signature);
    try {
      const cachedSeg = await analysisSegmentFamily.load(segKey);
      if (isRelaySegmentCacheEntry(cachedSeg)) {
        const reused: RawRelayStepData = {
          nextStateCard: cachedSeg.nextStateCard,
          chapters: cachedSeg.l1Chapters,
          quotes: cachedSeg.l1Quotes,
          windowSummary: cachedSeg.summary
        };
        stepOutcomes.push({ ok: true, data: reused });
        previousStateCard = reused.nextStateCard;
        onProgress?.(buildProgressNotice(i + 1, totalWindows));
        continue;
      }

      const built = buildStateRelayStepPrompt({
        title: ctx.title,
        ownerName: ctx.author,
        videoDescription: ctx.videoDescription,
        window: win,
        totalWindows,
        previousStateCard,
        chapterOutline: chapterPlan.givenChapters,
        titlesOnly: chapterPlan.titlesOnly
      });

      const rawText = await requestStreamedAnalysisText({
        provider,
        systemPrompt: relaySystemPrompt,
        built,
        thinkingLevel,
        signal,
        chatCompletionImpl
      });

      const stepData = parseStateRelayOutput(rawText, {
        allLines: l0Lines,
        window: win,
        previousStateCard,
        hasGivenChapters: chapterPlan.hasGivenChapters,
        titlesOnly: chapterPlan.titlesOnly
      });

      const cachePayload: RelaySegmentCacheEntry = {
        relayVersion: 1,
        summary: stepData.windowSummary,
        chapters: stepData.chapters.map((ch) => ({
          from: ch.from,
          to: ch.to,
          title: ch.title,
          summary: ch.coreThesis
        })),
        quotes: stepData.quotes.map((q) => ({
          from: q.from,
          content: q.content
        })),
        nextStateCard: stepData.nextStateCard,
        l1Chapters: stepData.chapters,
        l1Quotes: stepData.quotes
      };
      await analysisSegmentFamily.save(segKey, cachePayload);

      stepOutcomes.push({ ok: true, data: stepData });
      previousStateCard = stepData.nextStateCard;
    } catch (error) {
      if (isAbortedMarkerError(error) || signal?.aborted) {
        throw error;
      }
      stepOutcomes.push({ ok: false, from: win.fromSeconds, to: win.toSeconds, error });
      previousStateCard = advanceFallbackStateCard(previousStateCard, win);
    }
    onProgress?.(buildProgressNotice(i + 1, totalWindows));
  }

  const successfulSteps = stepOutcomes
    .filter((item): item is { ok: true; data: RawRelayStepData } => item.ok)
    .map((item) => item.data);
  const failedRanges = stepOutcomes
    .filter((item): item is { ok: false; from: number; to: number; error: unknown } => !item.ok)
    .map((item) => ({ from: item.from, to: item.to }));

  if (successfulSteps.length === 0) {
    const firstError = stepOutcomes.find((item) => !item.ok)?.error;
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error(firstError ? String(firstError) : "概览生成失败。");
  }

  const endSeconds = Math.max(
    Math.floor(Number(ctx.videoDuration) || 0),
    l0Lines.length > 0 ? Math.max(0, Math.floor(l0Lines[l0Lines.length - 1].to)) : 0
  );
  const merged = mergeRelayOutcomes(successfulSteps, chapterPlan, l0Lines, endSeconds);

  const analysis: OverviewAnalysis = {
    summary: "",
    chapters: merged.chapters,
    quotes: merged.quotes,
    ...(failedRanges.length > 0 ? { failedRanges } : {})
  };

  // —— 轻量收尾汇总：仅基于 L1 章节节点与最终状态卡提炼全片脉络 ——
  onProgress?.("正在生成全片简介…");
  try {
    const summaryBuilt = buildStateRelayFinalSummaryPrompt({
      title: ctx.title,
      videoDuration: endSeconds,
      chapters: merged.l1Chapters,
      finalStateCard: merged.finalStateCard
    });
    const summaryText = await requestStreamedAnalysisText({
      provider,
      systemPrompt: STATE_RELAY_FINAL_SUMMARY_SYSTEM_PROMPT,
      built: summaryBuilt,
      thinkingLevel,
      signal,
      retries: 2,
      chatCompletionImpl
    });
    const parsedSummary = parseRelayFinalSummary(summaryText);
    analysis.summary = parsedSummary || merged.finalStateCard?.rollingSummary || "";
    analysis.summaryFailed = !analysis.summary;
  } catch (error) {
    if (isAbortedMarkerError(error) || signal?.aborted) {
      throw error;
    }
    analysis.summaryFailed = true;
  }

  if (!analysis.summary && !analysis.chapters.length && !analysis.quotes.length) {
    throw makeEmptyAnalysisError();
  }

  await saveAnalysisFinal(finalKey, analysis);
  await persistL1IndexForOverview({
    identity,
    videoDuration: ctx.videoDuration,
    l0Lines,
    analysis,
    l1Chapters: merged.l1Chapters,
    l1Quotes: merged.l1Quotes,
    fallbackGlobalSummary: merged.finalStateCard?.rollingSummary
  });
  return analysis;
}
