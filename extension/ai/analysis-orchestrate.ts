// 「概览数据管线」三片之编排（arch-slim-3 #11 自 ai/analysis.ts 切出）：双路径分派、
// 两级缓存接线、成本护栏与 inflightOverviews promise 复用（全仓唯一的 analysis 模块态）。
// 静态依赖两个纯片 analysis-validate / analysis-prompts；对外经 analysis.ts 壳再导出。

import { buildSubtitleSourceKey, buildSubtitleSignature, normalizeSubtitleItems } from "../subtitle/cache.js";
import { logError } from "../shared/logging.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import { createCacheFamily } from "../core/cache-lru.js";
// 概览请求的传输层（overview-offscreen-transport）：content 直发服从网页 CORS，
// 平台网关的预检白名单不含 Anthropic 的 x-api-key / anthropic-version（实测
// ModelScope），故概览的每一次调用都经 offscreen 代发（长请求宿主，见模块头注）。
import { providerFetchViaOffscreen } from "../core/provider-http-offscreen.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { buildCostGuardNotice as _buildCostGuardNotice } from "./cost-guard.js";
import { chatCompletion as _chatCompletion } from "./completion.js";
import { parseLooseJson } from "./json-repair.js";
import { buildProgressNotice } from "./map-reduce.js";
import { runMapBounded, DEFAULT_MAP_CONCURRENCY } from "./pool.js";
import { budgetScaleSuffix, segmentCacheKeyFields } from "./segment-cache.js";
import {
  MAX_ANALYSIS_CHAPTERS,
  mergeAnalyses,
  validateAnalysis,
  type AnalysisChapter,
  type OverviewAnalysis,
} from "./analysis-validate.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  QUOTES_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildQuotesPrompt,
  estimateOutputTokens,
  hotCommentsText,
  parseChapterOutline,
  tailItems,
  type BuiltAnalysisPrompt,
  type OutlineChapter,
} from "./analysis-prompts.js";
import type { BudgetPlan, BudgetPlanSegment, ChatMessage } from "./types.js";

// FNV-1a 32 位哈希与字幕签名族已迁 subtitle/cache.ts（arch-slim-3 #1，键族同居）；
// 本模块经上方 import 消费同一实现。

// 整份概览结果缓存键前缀（键形：前缀 + bvid + cid + 字幕轨 source key + 字幕签名）。
const ANALYSIS_FINAL_PREFIX = "biliscript_lvs_analysis_final_";
// 概览分段产物缓存键前缀（键形与 biliscript_lvs_summary_ 同族：…+ 段序号 [+ 预算代]）。
// 注意它是 ANALYSIS_FINAL_PREFIX 的父前缀——两族都已注册进 core/cache-lru.ts 的
// CACHE_FAMILIES（前缀撞车语义见该处注释），本模块不再自行扩展淘汰名单。
const ANALYSIS_SEGMENT_PREFIX = "biliscript_lvs_analysis_";
// 前情回顾字数：每段开头附带的上一段结尾字数（对齐参考仓库 ANALYSIS_OVERLAP_CHARS）。
const ANALYSIS_CONTEXT_CHARS = 400;

// 空正文重试的输出预算上限：思考型模型（如 step-3.7-flash）会无视关思考字段族
// 强制思考，思考把 max_tokens 耗尽（finish_reason=length）后 content 空串返回，
// parseLooseJson 只会抛出难懂的「Unexpected end of JSON input」。首次调用空正文
// 时按原估算加倍（封顶此处）重试一次，给思考之后的正文留出落出空间。
const EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING = 16384;

// ============================================================
// 缓存（chrome.storage.local + 统一 LRU 淘汰；读取失败静默返回 null）
// ============================================================

// 两族缓存实例（arch-slim-2/08 缓存族参数化）：键拼装 / 静默读 / LRU 淘汰写 /
// 失败日志口径全部出自 core/cache-lru.ts 的 createCacheFamily，本模块只剩族参数。
// 两族已注册进 CACHE_FAMILIES（core/cache-lru.ts），不再在本模块自行扩展淘汰名单。
function isOverviewShape(value: unknown): value is OverviewAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

const analysisFinalFamily = createCacheFamily<OverviewAnalysis>({
  prefix: ANALYSIS_FINAL_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BILISCRIPT] failed to save analysis cache after eviction", info)
});

const analysisSegmentFamily = createCacheFamily<OverviewAnalysis>({
  prefix: ANALYSIS_SEGMENT_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BILISCRIPT] failed to save analysis cache after eviction", info)
});

function contextKeyFields(context: Record<string, unknown> | undefined | null): {
  bvid: unknown;
  cid: unknown;
  subtitleId: string;
  subtitleUrl: string;
  lang: string;
} {
  const fields = segmentCacheKeyFields(context);
  return {
    bvid: fields.bvid,
    cid: fields.cid,
    subtitleId: String(fields.subtitleId ?? ""),
    subtitleUrl: String(fields.subtitleUrl ?? ""),
    lang: String(fields.lang ?? "")
  };
}

/**
 * 整份概览结果缓存键：bvid + cid + 字幕轨 source key + 字幕签名。
 * 签名随字幕内容（条数/首末时间戳/文本量）与轨道变化，重抓字幕/换轨/切分P 自然 miss。
 */
export function buildAnalysisFinalCacheKey(context: Record<string, unknown> | undefined | null, signature: unknown): string {
  return analysisFinalFamily.key(contextKeyFields(context), String(signature ?? ""));
}

/**
 * 概览分段产物缓存键：与 biliscript_lvs_summary_ 同族键形（…+ 段序号 [+ 预算代]），
 * 仅族前缀不同——产物不共享、键位机制共享（07 票决议）；预算代后缀逻辑继承
 * segment-cache 的 budgetScaleSuffix（_b50 等），段边界漂移不串内容。
 */
export function buildAnalysisSegmentCacheKey(
  context: Record<string, unknown> | undefined | null,
  segmentIndex: number | string | unknown,
  budgetScale: number | string | unknown = 1
): string {
  return analysisSegmentFamily.key(contextKeyFields(context), `${segmentIndex}${budgetScaleSuffix(budgetScale)}`);
}

// ============================================================
// 编排入口：双路径分派 + promise 复用 + 成本护栏
// ============================================================

// 以下三个依赖注入类型仅本模块的编排签名使用（runOverviewAnalysis 的入参 /
// deps 形状），arch-slim-2/08 转私有：生产消费方（reader/overview.ts）传对象
// 字面量无需引用类型；ladder.ts 的同名类型声明形状不同（宽松 BudgetPlan，
// 供测试 fake 只填 mode 等少数字段），刻意不合并（见工单 Comments 裁定）。
type ChatCompletionFn = (input: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  messages: ChatMessage[];
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  maxTokens?: number | null;
  // 传输层注入（overview-offscreen-transport）：概览一律经 offscreen 代发
  fetchImpl?: typeof fetch;
  // 流式（概览改流式）：正文增量经 onEvent 吐出（{ type: "token", data }，思考
  // 增量是 { type: "reasoning", data }），流式成功返回 { done: true }；读流中断
  // 重试时 onStreamReset 通报代际切换（completion.ts 的契约）。
  stream?: boolean;
  onEvent?: (event: unknown) => void;
  onStreamReset?: () => void;
}) => Promise<unknown>;

// 流式进度计数（requestValidatedPart 的 onTokenProgress 契约）：正文与思考各自
// 已接收的字符数，文案与节流由消费侧（单发路径）负责。
interface TokenProgressState {
  contentChars: number;
  reasoningChars: number;
}

type BuildBudgetPlanFn = (args: { body?: unknown[]; chapters?: unknown[] }) => BudgetPlan;

type BuildCostGuardNoticeFn = (args: { estimatedCalls?: unknown; estimatedTokens?: unknown }) => {
  shouldPrompt: boolean;
  message: string;
};

interface RunOverviewAnalysisArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  /** AI 上下文（AiContext 形状）：bvid/cid/字幕轨三键位 + title/author/videoDescription + subtitleBody/chapters。 */
  context: Record<string, unknown>;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  /** 跳过整份缓存读取重新生成（分段缓存仍复用——重试只重跑未落盘段）。 */
  forceRefresh?: boolean;
}

interface RunOverviewAnalysisDeps {
  chatCompletion?: ChatCompletionFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  /** 成本护栏确认钩子（≥5 次调用时）；未注入则不阻塞、直接生成（接线由集成步骤负责）。 */
  askCostGuard?: (message: string) => Promise<unknown>;
  /** 分段进度回调（可选，数据层无 port）。 */
  onProgress?: (notice: string) => void;
}

// 生成中 promise 复用（对齐 ensureSummarizeChain 的 promise 缓存手法）：
// 同一 finalKey 的重复触发共享同一 promise；落定（成功或失败）即移除，
// 之后触发改走缓存读取或重新生成。
const inflightOverviews = new Map<string, Promise<OverviewAnalysis>>();

// 分段 worker 的单段结果：失败不炸整单（07 票决议），以 ok 标记带出段区间。
interface SegmentOutcome {
  ok: boolean;
  part?: OverviewAnalysis;
  from?: number;
  to?: number;
  error?: unknown;
}

// 稿件章节 → 产物章节（短路径：章节取稿件标题，模型不再分章）。
// to 缺失/不合法时回落到下一章 from（末章 maxSeconds），与 AI 分章产物同构。
function normalizeManuscriptChapters(chapters: unknown, maxSeconds: number): AnalysisChapter[] {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((raw) => {
      const item = raw as { from?: unknown; to?: unknown; title?: unknown };
      return {
        from: Math.floor(Number(item?.from)),
        to: Math.floor(Number(item?.to)),
        title: typeof item?.title === "string" ? item.title.trim().slice(0, 300) : ""
      };
    })
    .filter((item) => Number.isFinite(item.from) && item.from >= 0 && item.title)
    .sort((a, b) => a.from - b.from);

  const out: AnalysisChapter[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (seen.has(item.from)) continue;
    seen.add(item.from);
    const nextFrom = i + 1 < list.length ? list[i + 1].from : null;
    const to =
      Number.isFinite(item.to) && item.to > item.from
        ? item.to
        : nextFrom !== null && nextFrom > item.from
          ? nextFrom
          : maxSeconds;
    out.push({ from: item.from, to, title: item.title, summary: "" });
  }
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

// 取消错误：err.cancelled = true 标记（house style 类型化标记；消费方查标记分流）。
function makeOverviewCancelledError(): Error & { cancelled: true } {
  const error = new Error("已取消") as Error & { cancelled: true };
  error.cancelled = true;
  return error;
}

// 空产物错误：模型没给出任何有效章节与金句（对齐参考仓库 EMPTY_ANALYSIS 语义）。
function makeEmptyAnalysisError(): Error {
  return new Error("模型没有产出有效的章节或金句，请重试。");
}

// 单次模型调用 → 宽容解析 → 校验。maxTokens 按正文长度估算（ratio 0.5，
// 前情回顾只进输入不进输出）；显式 retries 由调用方给（单次 2 / 分段走池层重试）。
// 调用形态为流式（stream: true）——网关对非流式长请求整体超时（实测 19 分钟后
// HTTP 500 Request timed out），流式既躲开它又给面板真实进度；正文只能从 token
// 事件聚合（流式成功返回 { done: true }）。空正文（含纯空白）按「思考占满输出
// 预算」加倍预算重试一次，仍空则抛可读错误（EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING
// 处有根因说明）。
async function requestValidatedPart({
  provider,
  systemPrompt,
  built,
  minSeconds,
  thinkingLevel,
  signal,
  retries,
  chatCompletionImpl,
  onTokenProgress
}: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  systemPrompt: string;
  built: BuiltAnalysisPrompt;
  minSeconds: number;
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  chatCompletionImpl: ChatCompletionFn;
  onTokenProgress?: (state: TokenProgressState) => void;
}): Promise<OverviewAnalysis> {
  if (signal?.aborted) {
    throw makeAbortedError();
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: built.prompt }
  ];
  const baseMaxTokens = estimateOutputTokens(built.transcriptChars, { ratio: 0.5, floor: 2048 });
  // 正文从流式事件聚合（流式成功的返回值只有 { done: true }）；读流中断重试的
  // 代际切换由下方 onStreamReset 归零。
  let text = "";
  let reasoningChars = 0;
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
  // 传输层钉死在 offscreen 代发（空正文重试与分段路径共用本函数，一处覆盖）：
  // 概览是流式请求，正文经端口分块回吐读出（core/provider-http-offscreen.ts），
  // 不得回落 globalThis.fetch 的页面源直发。
  const requestBase = {
    provider,
    messages,
    thinkingLevel,
    signal,
    retries,
    fetchImpl: providerFetchViaOffscreen,
    stream: true,
    onEvent,
    // 读流中断重试（completion 的 kind=stream）会重吐整条流：清零已聚合的正文，
    // 否则两代流拼接成重复文本（completion.ts 的 onStreamReset 契约）。
    onStreamReset: () => {
      text = "";
    }
  };
  await chatCompletionImpl({ ...requestBase, maxTokens: baseMaxTokens });
  if (!text.trim()) {
    await chatCompletionImpl({
      ...requestBase,
      maxTokens: Math.min(baseMaxTokens * 2, EMPTY_TEXT_RETRY_MAX_TOKENS_CEILING)
    });
  }
  if (!text.trim()) {
    throw new Error("模型没有返回正文（输出预算可能被思考过程占满），请重试。");
  }
  return validateAnalysis(parseLooseJson(text), built.timing.maxTimestampSeconds, minSeconds);
}

// 单发路径的流式进度文案：正文有增量报已收字数、只有思考增量报思考态；1 秒节流
// 并跳过重复文案——每个 token 都推给面板只会造成无意义的连续重渲染。分段路径的
// 「正在整理第 x/y 段」由 runMapBounded 的 onItemDone 产出，不接本回调。
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

/**
 * 概览生成编排入口（纯数据层，依赖注入对齐 ladder / orchestrateMapReduce 惯例）：
 * 1. 双路径分派：字幕 ≤200k 字符（buildBudgetPlan mode=single）单次流式调用
 *    （显式 retries: 2）；>200k 走 buildBudgetPlan 切段 + runMapBounded 有界并发
 *    每段生成 + 段产物合并。
 * 2. 自带章节短路径：context.chapters 非空时只跑金句挑选调用（短提示词），
 *    章节取稿件标题，产物与 AI 分章完全同构。
 * 3. 失败语义：分段路径段失败 → 跳过出部分结果 + failedRanges 记录（全部段
 *    失败 → 抛第一个真实错误）；单次路径失败 → 抛错由调用方处理。
 * 4. 缓存：整份结果按 (bvid, cid, 字幕轨, 字幕签名) 落 chrome.storage.local；
 *    分段产物按段缓存复用——重试（forceRefresh）天然只重跑未落盘段。
 * 5. 生成编排：同视频生成中重复触发 → 复用进行中的 promise（ensureSummarizeChain
 *    手法：promise 缓存按 finalKey 去重、落定即清），与笔记管线互不阻塞。
 * 返回归一化产物；abort / 取消 / 失败以异常上浮（err.aborted / err.cancelled 标记）。
 * 本函数刻意非 async：直接返回内部 promise，重复触发拿到的是同一个 promise 引用。
 */
export function runOverviewAnalysis(
  { provider, context, signal, thinkingLevel, forceRefresh = false }: RunOverviewAnalysisArgs,
  deps: RunOverviewAnalysisDeps = {}
): Promise<OverviewAnalysis> {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? (ctx.subtitleBody as unknown[]) : [];
  // 短路径判定：自带章节非空 → 只挑金句（章节取稿件标题）。
  const manuscriptChapters = Array.isArray(ctx.chapters) ? ctx.chapters : [];
  const shortPath = manuscriptChapters.length > 0;
  // 现成章节目录：简介 + 热门评论里的时间戳目录（「00:00 开场」行）。
  // 短路径（稿件自带章节）不需要目录——章节边界已有权威来源。
  const chapterOutline = shortPath ? [] : parseChapterOutline([ctx.videoDescription, hotCommentsText(ctx.hotComments)].join("\n"));

  const signature = buildSubtitleSignature({
    lang: ctx.subtitleLang,
    subtitleId: ctx.selectedSubtitleId,
    subtitleUrl: ctx.selectedSubtitleUrl,
    body,
    chapters: manuscriptChapters,
    chapterOutline
  });
  const finalKey = buildAnalysisFinalCacheKey(ctx, signature);

  // 生成编排：进行中 promise 复用（forceRefresh 的显式重生成不去重）。
  const inflight = forceRefresh ? undefined : inflightOverviews.get(finalKey);
  if (inflight) {
    return inflight;
  }
  // 整轮一个会话身份：概览一轮会发出多次请求（分段并发逐段、空正文加倍重试），
  // 平台会话头（Opencode Go 的 x-opencode-session，见 ai/preset-headers.ts）必须
  // 整轮同值——身份在这里挂一次，而不是留给下游逐调用现造一个随机 id（那会把
  // 同一轮概览拆成多个会话，平台侧的路由与 prompt 缓存都按会话走）。身份取本轮
  // 整份缓存键：同一视频同一字幕轨的一次概览就是一个会话，重跑也落在同一条上。
  // 复制而非原地挂：调用方的 provider 不因一次生成被改写。
  const runProvider = { ...provider, sessionId: finalKey };
  const promise = executeOverviewRun({
    provider: runProvider,
    ctx,
    body,
    shortPath,
    manuscriptChapters,
    chapterOutline,
    finalKey,
    signal,
    thinkingLevel,
    forceRefresh,
    chatCompletionImpl: deps.chatCompletion ?? (_chatCompletion as unknown as ChatCompletionFn),
    buildBudgetPlanImpl: deps.buildBudgetPlan ?? (_buildBudgetPlan as unknown as BuildBudgetPlanFn),
    buildCostGuardNoticeImpl:
      deps.buildCostGuardNotice ?? (_buildCostGuardNotice as unknown as BuildCostGuardNoticeFn),
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
        // 拒绝在此收口（原 then(cleanup, cleanup) 不外抛），仅保证清理执行。
      } finally {
        cleanup();
      }
    })();
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  ctx: Record<string, unknown>;
  body: unknown[];
  shortPath: boolean;
  manuscriptChapters: unknown[];
  chapterOutline: OutlineChapter[];
  finalKey: string;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  forceRefresh: boolean;
  chatCompletionImpl: ChatCompletionFn;
  buildBudgetPlanImpl: BuildBudgetPlanFn;
  buildCostGuardNoticeImpl: BuildCostGuardNoticeFn;
  askCostGuard?: (message: string) => Promise<unknown>;
  onProgress?: (notice: string) => void;
}

async function executeOverviewRun({
  provider,
  ctx,
  body,
  shortPath,
  manuscriptChapters,
  chapterOutline,
  finalKey,
  signal,
  thinkingLevel,
  forceRefresh,
  chatCompletionImpl,
  buildBudgetPlanImpl,
  buildCostGuardNoticeImpl,
  askCostGuard,
  onProgress
}: ExecuteOverviewRunArgs): Promise<OverviewAnalysis> {
  if (normalizeSubtitleItems(body).length === 0) {
    throw new Error("没有可用的字幕");
  }
  const systemPrompt = shortPath ? QUOTES_SYSTEM_PROMPT : ANALYSIS_SYSTEM_PROMPT;
  const buildPrompt = shortPath ? buildQuotesPrompt : buildAnalysisPrompt;
  // 整份缓存命中直接复用（短路径的章节取自稿件，返回前以稿件现值覆盖，防章节晚于字幕更新）。
  if (!forceRefresh) {
    const cached = await analysisFinalFamily.load(finalKey);
    if (cached) {
      return shortPath
        ? { ...cached, chapters: normalizeManuscriptChapters(manuscriptChapters, cached.chapters.at(-1)?.to ?? 0) }
        : cached;
    }
  }

  const promptVars = {
    title: ctx.title,
    ownerName: ctx.author,
    videoDescription: ctx.videoDescription,
    chapterOutline
  };
  const plan = buildBudgetPlanImpl({ body, chapters: manuscriptChapters });
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const segmented = plan.mode === "map-reduce" && segments.length > 0;

  // 成本护栏：分段路径预估 ≥5 次调用时经注入的确认钩子询问（对齐 ladder 手法；
  // 钩子未注入则不阻塞——护栏 UI 接线由集成步骤负责）。
  if (segmented) {
    const guard = buildCostGuardNoticeImpl({
      estimatedCalls: segments.length,
      estimatedTokens: plan.totalChars
    });
    if (guard.shouldPrompt && typeof askCostGuard === "function") {
      if (signal?.aborted) {
        throw makeAbortedError();
      }
      const confirmed = Boolean(await askCostGuard(guard.message));
      if (!confirmed) {
        throw makeOverviewCancelledError();
      }
    }
  }

  if (!segmented) {
    // —— 单次路径：预算内一次调用，失败整体抛错由调用方处理（07 票决议）——
    const items = normalizeSubtitleItems(body);
    const startSeconds = Math.max(0, Math.floor(Number(items[0]?.from) || 0));
    const built = buildPrompt({
      ...promptVars,
      items: body,
      contextItems: [],
      videoDuration: ctx.videoDuration,
      startSeconds,
      segmentIndex: 1,
      totalSegments: 1
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: startSeconds,
      thinkingLevel,
      signal,
      retries: 2,
      chatCompletionImpl,
      // 单发路径是长视频（数万字素材）唯一一次调用，流式正文增量直接进面板；
      // 分段路径接流式进度会与「正在整理第 x/y 段」抢同一条文案，故不接。
      onTokenProgress: buildTokenProgressReporter(onProgress)
    });
    const analysis = shortPath
      ? {
          ...part,
          chapters: normalizeManuscriptChapters(manuscriptChapters, built.timing.maxTimestampSeconds)
        }
      : part;
    if (!analysis.chapters.length && !analysis.quotes.length) {
      throw makeEmptyAnalysisError();
    }
    await analysisFinalFamily.save(finalKey, analysis);
    return analysis;
  }

  // —— 分段路径：有界并发逐段生成（段缓存复用），段失败跳过出部分结果 ——
  const total = segments.length;
  let done = 0;

  const analyzeSegment = async (segment: BudgetPlanSegment, index: number): Promise<OverviewAnalysis> => {
    const segKey = buildAnalysisSegmentCacheKey(ctx, segment.index, 1);
    const cached = await analysisSegmentFamily.load(segKey);
    if (cached) {
      return cached;
    }
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    // 前情回顾：上一段结尾字幕（只作上下文，产出限定在本段区间，靠 minSeconds 兜底）。
    const contextItems = index > 0 ? tailItems(segments[index - 1]?.items, ANALYSIS_CONTEXT_CHARS) : [];
    const built = buildPrompt({
      ...promptVars,
      items: segment.items,
      contextItems,
      // 时长变量按本段区间算（对齐参考仓库 analyzeChunk 传 chunk.endSeconds）。
      videoDuration: segment.to,
      startSeconds: segment.from,
      segmentIndex: index + 1,
      totalSegments: total
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: segment.from,
      thinkingLevel,
      signal,
      chatCompletionImpl
    });
    // 先落盘再返回：失败重试只重跑未落盘段（segment-cache 复用语义）。
    await analysisSegmentFamily.save(segKey, part);
    return part;
  };

  const worker = async (segment: BudgetPlanSegment, index: number): Promise<SegmentOutcome> => {
    try {
      const part = await analyzeSegment(segment, index);
      return { ok: true, part };
    } catch (e) {
      // 中止仍整体上抛（池层收束）；其余失败按 07 票决议跳过该段、记录区间。
      if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
        throw e;
      }
      return { ok: false, from: segment.from, to: segment.to, error: e };
    }
  };

  let outcomes: SegmentOutcome[];
  try {
    outcomes = await runMapBounded({
      items: segments,
      worker,
      concurrency: DEFAULT_MAP_CONCURRENCY,
      signal,
      onItemDone: () => {
        done += 1;
        onProgress?.(buildProgressNotice(done, total));
      }
    });
  } catch (e) {
    if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
      throw e;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const parts = outcomes.filter((outcome) => outcome?.ok && outcome.part).map((outcome) => outcome.part as OverviewAnalysis);
  const failedRanges = outcomes
    .filter((outcome) => !outcome?.ok)
    .map((outcome) => ({ from: Math.floor(Number(outcome?.from) || 0), to: Math.floor(Number(outcome?.to) || 0) }));

  // 全军覆没时把第一个真实错误透出去，它比「生成失败」有用得多。
  if (parts.length === 0) {
    const firstError = outcomes.find((outcome) => !outcome?.ok)?.error;
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error(firstError ? String(firstError) : "概览生成失败。");
  }

  const merged = mergeAnalyses(parts);
  const analysis: OverviewAnalysis = shortPath
    ? {
        ...merged,
        chapters: normalizeManuscriptChapters(manuscriptChapters, merged.chapters.at(-1)?.to ?? 0)
      }
    : merged;
  if (!analysis.chapters.length && !analysis.quotes.length) {
    throw makeEmptyAnalysisError();
  }
  if (failedRanges.length) {
    analysis.failedRanges = failedRanges;
  }
  // 部分结果照常落缓存（含 failedRanges）：重试走 forceRefresh，段缓存让已成功段免重付费。
  await analysisFinalFamily.save(finalKey, analysis);
  return analysis;
}
