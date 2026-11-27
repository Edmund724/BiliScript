import {
  detectSiteFromUrl,
  getSiteCapabilities,
  normalizeSiteId,
  YOUTUBE_UNIT_CID,
  type SiteId
} from "../shared/site.js";
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
import { validateAnalysis, type AnalysisChapter, type OverviewAnalysis } from "./analysis-validate.js";
import {
  buildLocalOutlineChapters,
  hasAnyOverviewAiSection,
  isFullOverviewAiSections,
  normalizeOverviewAiSections,
  overviewSectionsCacheSuffix,
  type OverviewAiSections
} from "../shared/overview-sections.js";
import {
  buildAnalysisPrompt,
  buildStateRelayFinalSummaryPrompt,
  buildStateRelayStepPrompt,
  estimateOutputTokens,
  getOverviewSystemPrompt,
  getStateRelaySystemPrompt,
  STATE_RELAY_FINAL_SUMMARY_SYSTEM_PROMPT,
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
  sections?: Partial<OverviewAiSections>;
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

function resolveOverviewSite(ctx: AiContext): SiteId {
  return normalizeSiteId(
    ctx.site ?? (ctx.cid === YOUTUBE_UNIT_CID ? "youtube" : ctx.url ? detectSiteFromUrl(ctx.url) : undefined)
  );
}

function appendOverviewSectionsDirective(prompt: string, sections: OverviewAiSections): string {
  if (isFullOverviewAiSections(sections)) {
    return prompt;
  }
  const skipped: string[] = [];
  if (!sections.summary) {
    skipped.push('顶层 "summary" 留空字符串 ""');
  }
  if (!sections.chapters) {
    skipped.push('"chapters" 返回空数组 []');
  }
  if (!sections.quotes) {
    skipped.push('"keyQuotes" / "quotes" 返回空数组 []');
  }
  return `${prompt}\n\n⚠️ 本次生成范围约束 ⚠️\n用户仅需要部分概览模块，请严格遵守：${skipped.join("；")}，不要为上述省略模块消耗输出。`;
}

function selectOverviewSystemPrompt(
  chapterPlan: ChapterPlan,
  site: SiteId,
  sections: OverviewAiSections
): string {
  const base = getOverviewSystemPrompt({
    site,
    hasGivenChapters: chapterPlan.hasGivenChapters,
    titlesOnly: chapterPlan.titlesOnly
  });
  return appendOverviewSectionsDirective(base, sections);
}

function selectRelaySystemPrompt(
  chapterPlan: ChapterPlan,
  site: SiteId,
  sections: OverviewAiSections
): string {
  const base = getStateRelaySystemPrompt({
    site,
    hasGivenChapters: chapterPlan.hasGivenChapters,
    titlesOnly: chapterPlan.titlesOnly
  });
  return appendOverviewSectionsDirective(base, sections);
}

function applyOverviewSections(
  analysis: OverviewAnalysis,
  sections: OverviewAiSections,
  localChapters: AnalysisChapter[]
): OverviewAnalysis {
  const summary = sections.summary ? String(analysis.summary || "") : "";
  const chapters = sections.chapters
    ? Array.isArray(analysis.chapters)
      ? analysis.chapters
      : []
    : localChapters;
  const quotes = sections.quotes ? (Array.isArray(analysis.quotes) ? analysis.quotes : []) : [];
  const next: OverviewAnalysis = {
    ...analysis,
    summary,
    chapters,
    quotes
  };
  if (!sections.summary) {
    next.summaryFailed = false;
  }
  return next;
}

function hasRequestedOverviewContent(analysis: OverviewAnalysis, sections: OverviewAiSections): boolean {
  return (
    (sections.summary && Boolean(String(analysis.summary || "").trim())) ||
    (sections.chapters && analysis.chapters.length > 0) ||
    (sections.quotes && analysis.quotes.length > 0)
  );
}

function normalizeOverviewContext(context: AiContext | undefined | null): { ctx: AiContext; site: SiteId } {
  const rawCtx = context || {};
  const site = resolveOverviewSite(rawCtx);
  const ctx: AiContext = getSiteCapabilities(site).supportsHotComments
    ? { ...rawCtx, site }
    : { ...rawCtx, site, hotComments: [] };
  return { ctx, site };
}

export async function loadCachedOverviewAnalysis(
  context: AiContext,
  rawSections?: Partial<OverviewAiSections>
): Promise<OverviewAnalysis | null> {
  const sections = normalizeOverviewAiSections(rawSections);
  if (!hasAnyOverviewAiSection(sections)) {
    return null;
  }
  const { ctx } = normalizeOverviewContext(context);
  const identity = buildClipOverviewIdentity(ctx);
  const normalizedItems = normalizeSubtitleItems(identity.body);
  if (normalizedItems.length === 0) {
    return null;
  }
  const l0Lines = normalizeL0SubtitleLines(normalizedItems);
  const chapterPlan = resolveChapterPlan({ chapterSource: identity.chapterSource, context: ctx, body: identity.body });
  const expectsChapterSummaries = sections.chapters && chapterPlan.hasGivenChapters && !chapterPlan.titlesOnly;
  const localChapters = buildLocalOutlineChapters(identity.chapterSource, ctx.videoDuration, normalizedItems);
  const sectionSuffix = overviewSectionsCacheSuffix(sections);
  const effectiveFinalKey = `${identity.finalKey}${sectionSuffix}`;

  const tryValidateCached = async (cached: OverviewAnalysis | null, fromFullCache: boolean): Promise<OverviewAnalysis | null> => {
    if (!cached) {
      return null;
    }
    const shaped = fromFullCache ? applyOverviewSections(cached, sections, localChapters) : cached;
    const allSummariesEmpty =
      expectsChapterSummaries &&
      shaped.chapters.length > 0 &&
      shaped.chapters.every((chapter) => !String(chapter?.summary ?? "").trim());
    if (allSummariesEmpty) {
      return null;
    }
    const result = expectsChapterSummaries ? flagMissingChapterSummaries(shaped) : shaped;
    if (isFullOverviewAiSections(sections)) {
      await ensureL1IndexOnCacheHit({ identity, videoDuration: ctx.videoDuration, l0Lines, analysis: result });
    }
    return result;
  };

  const direct = await tryValidateCached(await loadAnalysisFinal(effectiveFinalKey), false);
  if (direct) {
    return direct;
  }
  if (!isFullOverviewAiSections(sections)) {
    return tryValidateCached(await loadAnalysisFinal(identity.finalKey), true);
  }
  return null;
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
  { provider, context, signal, thinkingLevel, forceRefresh = false, sections: rawSections }: RunOverviewAnalysisArgs,
  deps: RunOverviewAnalysisDeps = {}
): Promise<OverviewAnalysis> {
  const { ctx, site } = normalizeOverviewContext(context);
  const sections = normalizeOverviewAiSections(rawSections);
  const identity = buildClipOverviewIdentity(ctx);
  const sectionSuffix = overviewSectionsCacheSuffix(sections);
  const effectiveFinalKey = `${identity.finalKey}${sectionSuffix}`;

  const inflight = forceRefresh ? undefined : inflightOverviews.get(effectiveFinalKey);
  if (inflight) {
    return inflight;
  }
  const runProvider = { ...provider, sessionId: effectiveFinalKey };
  const promise = executeOverviewRun({
    provider: runProvider,
    ctx,
    site,
    identity,
    sections,
    sectionSuffix,
    effectiveFinalKey,
    signal,
    thinkingLevel,
    forceRefresh,
    chatCompletionImpl: deps.chatCompletion ?? _chatCompletion,
    askCostGuard: deps.askCostGuard,
    onProgress: deps.onProgress
  });
  if (!forceRefresh) {
    inflightOverviews.set(effectiveFinalKey, promise);
    const cleanup = () => {
      if (inflightOverviews.get(effectiveFinalKey) === promise) {
        inflightOverviews.delete(effectiveFinalKey);
      }
    };
    void promise.then(cleanup, cleanup);
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: ProviderRequest;
  ctx: AiContext;
  site: SiteId;
  identity: ClipOverviewIdentity;
  sections: OverviewAiSections;
  sectionSuffix: string;
  effectiveFinalKey: string;
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
  site,
  identity,
  sections,
  sectionSuffix,
  effectiveFinalKey,
  signal,
  thinkingLevel,
  forceRefresh,
  chatCompletionImpl,
  askCostGuard,
  onProgress
}: ExecuteOverviewRunArgs): Promise<OverviewAnalysis> {
  const { body, chapterSource, signature } = identity;
  const normalizedItems = normalizeSubtitleItems(body);
  if (normalizedItems.length === 0) {
    throw new Error("没有可用的字幕");
  }
  const localChapters = buildLocalOutlineChapters(chapterSource, ctx.videoDuration, normalizedItems);
  if (!hasAnyOverviewAiSection(sections)) {
    return {
      summary: "",
      chapters: localChapters,
      quotes: []
    };
  }
  const l0Lines = normalizeL0SubtitleLines(normalizedItems);
  const chapterPlan = resolveChapterPlan({ chapterSource, context: ctx, body });

  if (!forceRefresh) {
    const cached = await loadCachedOverviewAnalysis(ctx, sections);
    if (cached) {
      return cached;
    }
  }

  const relayDecision = decideOverviewRelaySplit(l0Lines, {
    budgetChapters: chapterPlan.budgetChapters
  });

  if (!relayDecision.shouldRelay) {
    const startSeconds = Math.max(0, Math.floor(Number(normalizedItems[0]?.from) || 0));
    const built = buildAnalysisPrompt({
      ...chapterPlan.promptVars,
      site,
      items: body,
      contextItems: [],
      videoDuration: ctx.videoDuration,
      startSeconds,
      segmentIndex: 1,
      totalSegments: 1
    });
    const text = await requestStreamedAnalysisText({
      provider,
      systemPrompt: selectOverviewSystemPrompt(chapterPlan, site, sections),
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
    const rawAnalysis: OverviewAnalysis = {
      ...part,
      chapters: sections.chapters ? chapterPlan.graft(part.chapters) : localChapters
    };
    const analysis = applyOverviewSections(rawAnalysis, sections, localChapters);
    analysis.summaryFailed = sections.summary ? !analysis.summary : false;
    if (!hasRequestedOverviewContent(analysis, sections)) {
      throw makeEmptyAnalysisError();
    }
    await saveAnalysisFinal(effectiveFinalKey, analysis);
    if (isFullOverviewAiSections(sections)) {
      await persistL1IndexForOverview({ identity, videoDuration: ctx.videoDuration, l0Lines, analysis });
    }
    return analysis;
  }

  const windows = relayDecision.windows;
  if (typeof askCostGuard === "function") {
    await runCostGuard({
      estimatedCalls: windows.length + (sections.summary ? 1 : 0),
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

  const relaySystemPrompt = selectRelaySystemPrompt(chapterPlan, site, sections);
  const totalWindows = windows.length;
  const stepOutcomes: Array<{ ok: true; data: RawRelayStepData } | { ok: false; from: number; to: number; error: unknown }> = [];
  let previousStateCard: StateRelayCard | null = null;

  for (let i = 0; i < totalWindows; i += 1) {
    const win = windows[i];
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const segKey = buildAnalysisSegmentCacheKey(ctx, win.windowIndex + 1, `${signature}${sectionSuffix}`);
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
        site,
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
    chapters: sections.chapters ? merged.chapters : localChapters,
    quotes: sections.quotes ? merged.quotes : [],
    ...(failedRanges.length > 0 ? { failedRanges } : {})
  };

  if (sections.summary) {
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
  } else {
    analysis.summaryFailed = false;
  }

  if (!hasRequestedOverviewContent(analysis, sections)) {
    throw makeEmptyAnalysisError();
  }

  await saveAnalysisFinal(effectiveFinalKey, analysis);
  if (isFullOverviewAiSections(sections)) {
    await persistL1IndexForOverview({
      identity,
      videoDuration: ctx.videoDuration,
      l0Lines,
      analysis,
      l1Chapters: merged.l1Chapters,
      l1Quotes: merged.l1Quotes,
      fallbackGlobalSummary: merged.finalStateCard?.rollingSummary
    });
  }
  return analysis;
}
