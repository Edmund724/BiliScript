import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { normalizeSubtitleItems } from "../subtitle/signature.js";
import { logError } from "../shared/logging.js";
import { makeAbortedError, isAbortedMarkerError } from "../shared/error-helpers.js";
import { createAiArtifactFamily } from "../subtitle/ai-artifact-cache.js";
import { providerFetchViaOffscreen } from "../core/provider-http-offscreen.js";
import { runCostGuard } from "./cost-guard.js";
import { chatCompletion as _chatCompletion } from "./completion.js";
import { parseLooseJson } from "./json-repair.js";
import { isEmptyTextRetryable, retryBudget } from "./empty-text-retry.js";
import { canRaiseBudget } from "./learned-budget.js";
import { buildProgressNotice } from "./map-reduce.js";
import { budgetScaleSuffix } from "./segment-cache.js";
import { segmentCacheKeyStringFields } from "./segment-cache-key-fields.js";
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
import type { AiContext, ChatMessage, ProviderRequest, StreamChatEvent } from "./types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";

const ANALYSIS_SEGMENT_PREFIX = "biliscript_lvs_analysis_";

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

export function buildAnalysisSegmentCacheKey(
  context: AiContext | undefined | null,
  segmentIndex: number | string | unknown,
  signature: unknown,
  budgetScale: number | string | unknown = 1
): string {
  return analysisSegmentFamily.key(
    segmentCacheKeyStringFields(context),
    `${segmentIndex}${budgetScaleSuffix(budgetScale)}_${String(signature ?? "")}`
  );
}

type ChatCompletionFn = typeof _chatCompletion;

interface TokenProgressState {
  contentChars: number;
  reasoningChars: number;
}

export interface RunOverviewAnalysisArgs {
  provider: ProviderRequest;
  context: AiContext;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  forceRefresh?: boolean;
}

interface RunOverviewAnalysisDeps {
  chatCompletion?: ChatCompletionFn;
  askCostGuard?: (message: string) => Promise<unknown>;
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

  const onEvent = (event: StreamChatEvent): void => {
    if (event.type === "token") {
      text += event.data;
    } else if (event.type === "reasoning") {
      reasoningChars += event.data.length;
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
    }
  };

  const firstResult = await chatCompletionImpl({ ...requestBase, maxTokens: baseMaxTokens });
  const truncated = typeof firstResult === "object" && firstResult !== null && firstResult.finishReason === "length";
  if (
    canRaiseBudget(provider, baseMaxTokens, raisedMaxTokens) &&
    (isEmptyTextRetryable({ hasBody: Boolean(text.trim()) }) || truncated)
  ) {
    text = "";
    reasoningChars = 0;
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
    void promise.then(cleanup, cleanup);
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: ProviderRequest;
  ctx: AiContext;
  identity: ClipOverviewIdentity;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  forceRefresh: boolean;
  chatCompletionImpl: ChatCompletionFn;
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

  const windows = relayDecision.windows;
  if (typeof askCostGuard === "function") {
    await runCostGuard({
      estimatedCalls: windows.length + 1,
      estimatedTokens: estimateTokensFromChars(provider, relayDecision.totalChars),
      taskLabel: "当前视频较长，生成「全片概览」",
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
