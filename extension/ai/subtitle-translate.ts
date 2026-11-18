// extension/ai/subtitle-translate.ts
// 字幕翻译双通道协议与请求装配（平台解析在零请求叶 ai/subtitle-translate-config.ts，
// 纯编解码与容错原语在 subtitle/boundary-protocol.ts）：
//
// 1. 粗粒度/碎句轨（`ai-*` 轨、无标点轨、`asr` 伪轨）：走 `boundary-v3` 索引区间联合断句 + 翻译协议，
//    配合截断 JSON 抢救 → 连续无跳号前缀提取 → 最多 1 次 Tail Retry → 本地规则降级闭环；
// 2. 人工精校 CC 字幕轨：走 JSON 数组严格 ID 对齐批量翻译协议，具备截断 JSON 抢救与最多 1 次漏行单补；
// 3. 请求装配固定将思考档位设为关闭（`thinkingLevel: "off"`），降低首字延迟与 token 成本。

import { sendRuntimeMessage } from "../shared/messaging.js";
import { providerFetchViaOffscreen } from "../core/provider-http-offscreen.js";
import type { ProviderTransport } from "../core/provider-http-shared.js";
import {
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";
import {
  INDEX_TRANSLATE_BASE_URL,
  INDEX_TRANSLATE_BUILTIN_PROVIDER,
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODEL,
  INDEX_TRANSLATE_MODELS,
  INDEX_TRANSLATE_MODEL_OPTIONS,
  INDEX_TRANSLATE_PROVIDER_ID,
  createIndexTranslateResolution,
  isIndexTranslateModelId,
  isIndexTranslateProvider,
  normalizeIndexTranslateModel,
  resolveSubtitleTranslateProviderConfig,
  type IndexTranslateModelId,
  type IndexTranslateModelOption,
  type SubtitleTranslateProviderResolution
} from "./subtitle-translate-config.js";
import {
  createIndexTranslateRateLimiter,
  createThinkBlockStreamFilter,
  defaultIndexTranslateLimiter,
  formatIndexTranslateError,
  getHttpStatusFromError,
  isIndexTranslateRetryableError,
  runWithIndexTranslateRetry,
  stripThinkBlocks,
  type IndexTranslateRateLimiter,
  type IndexTranslateRetryOptions
} from "./index-translate.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ChatMessage, SubtitleBodyItem } from "./types.js";
import { chatCompletion, type ChatCompletionInput } from "./completion.js";
import type { ProviderListEntry } from "../shared/messaging-protocol.js";
import type { Settings } from "../core/defaults.js";
import {
  shouldSegmentTrack,
  toAtomicSubtitleEvents,
  type AtomicSubtitleEvent,
  type CoarseSubtitleInput
} from "../subtitle/segmentation.js";
import { isNonSpeechSegment } from "../subtitle/text-classification.js";
import {
  isAbortNamedError,
  isAbortedMarkerError,
  isCancelledError
} from "../shared/error-helpers.js";
import {
  createStreamingSubtitleParser,
  type StreamingSubtitleCue
} from "../subtitle/streaming-parser.js";
import {
  finalizeAiCues,
  formatBoundaryEvents,
  formatCcSubtitleItems,
  mapBoundaryGroupsToCues,
  parseCcTranslationMap,
  salvageTruncatedSubtitleJson,
  splitEventsIntoAiChunks,
  type BoundaryCue
} from "../subtitle/boundary-protocol.js";

import {
  buildChunkSubtitleContext,
  buildSubtitleContextPromptBlock,
  extractPreviousBilingualLines,
  readCachedL1VideoIndex,
  resolveL1ChapterTranslateContext,
  resolveRuntimeSubtitleContext,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput,
  type SubtitlePreviousLine,
  type SubtitleTimeItemHint,
  type SubtitleTranslatePromptContext
} from "./subtitle-context.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";

export type {
  IndexTranslateModelId,
  IndexTranslateModelOption,
  StreamingSubtitleCue,
  SubtitleGlossaryEntry,
  SubtitleGlossaryInput,
  SubtitlePreviousLine,
  SubtitleTranslatePromptContext
};

export {
  INDEX_TRANSLATE_BASE_URL,
  INDEX_TRANSLATE_BUILTIN_PROVIDER,
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODEL,
  INDEX_TRANSLATE_MODELS,
  INDEX_TRANSLATE_MODEL_OPTIONS,
  INDEX_TRANSLATE_PROVIDER_ID,
  createIndexTranslateRateLimiter,
  createIndexTranslateResolution,
  createThinkBlockStreamFilter,
  isIndexTranslateModelId,
  isIndexTranslateProvider,
  normalizeIndexTranslateModel,
  stripThinkBlocks
};

export type SubtitleTranslateProtocolMode = "boundary-v3" | "cc-json";

export interface ResolveSubtitleTranslateProviderDeps {
  getSettings?: () => Promise<Partial<Settings>>;
  loadProviders?: () => Promise<ProviderListEntry[]>;
  loadKeys?: () => Promise<Record<string, string>>;
}

/**
 * 异步解析字幕翻译运行时配置（依赖注入或经 runtime 消息向 SW 请求）。
 */
export async function resolveSubtitleTranslateProvider(
  deps?: ResolveSubtitleTranslateProviderDeps
): Promise<SubtitleTranslateProviderResolution> {
  if (deps?.getSettings && deps?.loadProviders && deps?.loadKeys) {
    const [settings, providers, keys] = await Promise.all([
      deps.getSettings(),
      deps.loadProviders(),
      deps.loadKeys()
    ]);
    return resolveSubtitleTranslateProviderConfig(providers, keys, settings);
  }

  const resp = await sendRuntimeMessage({ type: "resolve-subtitle-translate-provider" });
  if (!resp?.ok) {
    throw new Error(String(resp?.error || "解析字幕翻译平台配置失败"));
  }
  const provider = resp.provider!;
  return {
    provider,
    apiKey: String(resp.apiKey || "").trim(),
    baseUrl: String(provider.baseUrl || "").trim(),
    model: String(resp.model || provider.model || "").trim(),
    presetId: String(provider.presetId || ""),
    protocol: provider.protocol as AiProtocol | undefined,
    isFallback: resp.isFallback === true
  };
}

export interface SubtitleTranslateRequestInput {
  provider: {
    id?: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    presetId?: string;
    protocol?: AiProtocol;
  };
  messages: ChatMessage[];
  stream?: boolean;
  retries?: number;
  signal?: AbortSignal | null;
  maxTokens?: number | null;
  fetchImpl?: ProviderTransport;
  onEvent?: ChatCompletionInput["onEvent"];
  onStreamReset?: ChatCompletionInput["onStreamReset"];
  /** 外部传入的任何思考档位将被显式忽略，强制收敛为 "off"。 */
  thinkingLevel?: unknown;
}

/**
 * 装配字幕翻译模型请求：
 * 默认开启流式（`stream: true`）并固定将思考档位设为关闭（`off`），不继承对话面板的高思考强度档位，
 * 降低首字延迟与 token 消耗；传输默认走 offscreen 代发通道以绕过页面 CORS 预检。
 * 对内置 Bilibili Index-Translate 通道额外显式注入 `temperature: 0` 与
 * `chat_template_kwargs: { enable_thinking: false }`。
 */
export function buildSubtitleTranslateRequest(
  input: SubtitleTranslateRequestInput
): ChatCompletionInput {
  const isIndexTranslate = isIndexTranslateProvider(input.provider);
  const rawBaseUrl = String(input.provider.baseUrl || "").trim();
  const rawModel = String(input.provider.model || "").trim();
  const rawPresetId = String(input.provider.presetId || "").trim();

  return {
    provider: {
      baseUrl: rawBaseUrl || (isIndexTranslate ? INDEX_TRANSLATE_BASE_URL : ""),
      apiKey: String(input.provider.apiKey || "").trim(),
      model: isIndexTranslate ? normalizeIndexTranslateModel(rawModel) : rawModel,
      presetId: rawPresetId || (isIndexTranslate ? INDEX_TRANSLATE_PROVIDER_ID : "custom"),
      protocol: isIndexTranslate ? "openai" : (input.provider.protocol || "openai")
    },
    messages: input.messages,
    stream: input.stream ?? true,
    ...(input.retries !== undefined ? { retries: input.retries } : {}),
    signal: input.signal ?? null,
    maxTokens: input.maxTokens ?? null,
    ...(isIndexTranslate
      ? {
          temperature: 0,
          extraBody: { chat_template_kwargs: { enable_thinking: false } }
        }
      : {}),
    fetchImpl: input.fetchImpl ?? providerFetchViaOffscreen,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.onStreamReset ? { onStreamReset: input.onStreamReset } : {}),
    // 固定将思考档位设为关闭（off），不继承对话面板的高思考强度档位
    thinkingLevel: "off"
  };
}

const PROMPT_LANG_NAME_OVERRIDES: Partial<Record<LiveInterpretTargetLang, string>> = {
  en: "英文"
};

export const TARGET_LANG_NAME_MAP: Record<string, string> = Object.fromEntries(
  LIVE_INTERPRET_TARGET_LANG_OPTIONS.map((option) => [
    option.value,
    PROMPT_LANG_NAME_OVERRIDES[option.value] ?? option.label
  ])
);

export function resolveTargetLangDisplayName(lang: string): string {
  const code = String(lang || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TARGET_LANG_NAME_MAP, code)) {
    return TARGET_LANG_NAME_MAP[code];
  }
  const primary = code.replace(/^(ai|asr)[-_]/, "").split(/[-_]/)[0] || "";
  return Object.prototype.hasOwnProperty.call(TARGET_LANG_NAME_MAP, primary)
    ? TARGET_LANG_NAME_MAP[primary]
    : lang;
}

/**
 * 兼容旧版序号行编码：`1. 第一句话\n2. 第二句话`
 */
export function formatSubtitleNumberedLines(items: Array<{ content?: unknown }>): string {
  return (items || [])
    .map((item, idx) => `${idx + 1}. ${String(item?.content || "").trim()}`)
    .join("\n");
}

export interface ParseSubtitleNumberedLinesOptions {
  fallbackToOriginal?: boolean;
}

/**
 * 兼容旧版序号行解析：从「序号. 译文」按原数组长度 1:1 对齐时间轴。
 */
export function parseSubtitleNumberedLines(
  response: string,
  originalItems: SubtitleBodyItem[],
  options: ParseSubtitleNumberedLinesOptions = {}
): SubtitleBodyItem[] {
  const { fallbackToOriginal = true } = options;
  if (!Array.isArray(originalItems) || originalItems.length === 0) {
    return [];
  }
  const lines = String(response || "").split(/\r?\n/);
  const translationMap = new Map<number, string>();
  const linePattern = /^\s*(\d+)[\.、:：\s]+(.*)$/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = linePattern.exec(trimmed);
    if (match) {
      const lineNum = Number(match[1]);
      const content = match[2].trim();
      if (lineNum > 0 && !translationMap.has(lineNum)) {
        translationMap.set(lineNum, content);
      }
    }
  }

  return originalItems.map((item, idx) => {
    const lineNum = idx + 1;
    const translated = translationMap.get(lineNum);
    return {
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content:
        translated && translated.length > 0
          ? translated
          : fallbackToOriginal
            ? String(item.content || "").trim()
            : ""
    };
  });
}

export interface BuildBoundaryTranslateMessagesOptions {
  /** 仅请求输出 ids + translation，省去原文回显字段（适用于 Index-Translate 等翻译专用模型）。 */
  omitTextField?: boolean;
}

/**
 * `boundary-v3` 联合断句 + 翻译 System/User Prompt 装配（支持可选注入 title/description/summary/glossary/previousLines）。
 */
export function buildBoundaryTranslateMessages(
  events: readonly AtomicSubtitleEvent[],
  targetLang: string,
  context?: SubtitleTranslatePromptContext,
  options: BuildBoundaryTranslateMessagesOptions = {}
): ChatMessage[] {
  const langName = resolveTargetLangDisplayName(targetLang);
  const contextBlock = buildSubtitleContextPromptBlock(context);
  const encodedEvents = formatBoundaryEvents(events);
  const omitTextField = options.omitTextField === true;

  const formatRule = omitTextField
    ? `1. 输出格式：仅输出严格合法的 JSON 对象，结构为 {"groups":[{"ids":["0","2"],"translation":"..."}]}；当某组仅含单个片段时写 {"ids":["3"],"translation":"..."}，含连续多个片段时写首尾端点 ["startId","endId"]。严禁输出 \`\`\`json 等 Markdown 围栏、前言或任何解释文字；translation 字段必须仅填写${langName}译文，禁止回显原文。`
    : `1. 输出格式：仅输出严格合法的 JSON 对象，结构为 {"groups":[{"ids":["0","2"],"text":"...","translation":"..."}]}；当某组仅含单个片段时写 {"ids":["3"],"text":"...","translation":"..."}，含连续多个片段时写首尾端点 ["startId","endId"]。严禁输出 \`\`\`json 等 Markdown 围栏、前言或任何解释文字。`;

  const systemContent =
    `你是一个专业的音视频字幕智能断句与翻译专家。请将输入的细粒度字幕片段按自然语义合并断句，并翻译为${langName}。\n` +
    `输入格式为 JSON 数组，每项包含唯一递增字符串索引 "id"、片段文本 "text"，以及可选的与下一片段的静音停顿毫秒数 "pauseMs"。\n\n` +
    `严格遵守以下协议与断句规则：\n` +
    `${formatRule}\n` +
    `2. 硬性长度上限：空格分隔源语言（如英文等）每组原文 <= 15 词（有自然停顿时目标控制在 8–12 词）；中日韩等无空格分隔源语言每组原文 <= 30 字。超长从句必须在逗号、连词或自然意群处拆分，禁止生成超长单条字幕。\n` +
    `3. 句界与停顿约束：严禁将两个完整句子合并到同一组；请结合句末标点与 pauseMs 停顿强度判断自然句界，纯音效/音乐标记（如 [Music]、♪）单独成组。\n` +
    `4. 完整覆盖不变量：所有 groups 的 ids 必须从 "0" 开始单调递增、无遗漏、无重叠地精确覆盖全部输入片段一次。` +
    contextBlock;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: JSON.stringify(encodedEvents) }
  ];
}

/**
 * 人工精校 CC 字幕批量 JSON 严格 ID 对齐翻译 Prompt 装配。
 */
export function buildCcTranslateMessages(
  items: ReadonlyArray<{ content?: unknown }>,
  targetLang: string,
  context?: SubtitleTranslatePromptContext
): ChatMessage[] {
  const langName = resolveTargetLangDisplayName(targetLang);
  const contextBlock = buildSubtitleContextPromptBlock(context);
  const payload = formatCcSubtitleItems(items);

  const systemContent =
    `你是一个专业的音视频字幕翻译专家。用户将提供已精校的人工 CC 字幕 JSON 数组 [{"id":"0","text":"..."}]，请将其逐条翻译为${langName}。\n\n` +
    `严格遵守以下规则：\n` +
    `1. 仅输出严格合法的 JSON 数组，格式为 [{"id":"0","translation":"..."}]；严禁输出 \`\`\`json 等 Markdown 围栏、前言或任何解释文字。\n` +
    `2. 严格保持 id 与输入数组 1:1 对应，禁止合并、拆分、打乱顺序或遗漏任何 id。\n` +
    `3. 结合上下文保持口语自然流畅与术语统一。` +
    contextBlock;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

/**
 * 默认字幕翻译消息构造入口（人工精校 CC 批量 JSON 协议）。
 */
export function buildSubtitleTranslateMessages(
  items: SubtitleBodyItem[],
  targetLang: string,
  context?: SubtitleTranslatePromptContext
): ChatMessage[] {
  return buildCcTranslateMessages(items, targetLang, context);
}

export interface SubtitleProtocolRouteInput {
  mode?: "auto" | SubtitleTranslateProtocolMode;
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  items?: readonly CoarseSubtitleInput[];
  events?: readonly AtomicSubtitleEvent[];
}

/**
 * 判定当前字幕轨应采用 `boundary-v3`（`ai-*` 轨、无标点轨、`asr` 伪轨）还是 `cc-json`（人工精校 CC 轨）。
 */
export function resolveSubtitleTranslateProtocolMode({
  mode = "auto",
  selectedSubtitleId = "",
  selectedSubtitleLang = "",
  trackLan = "",
  items = [],
  events
}: SubtitleProtocolRouteInput): SubtitleTranslateProtocolMode {
  if (mode === "boundary-v3" || mode === "cc-json") {
    return mode;
  }
  if (Array.isArray(events) && events.length > 0) {
    return "boundary-v3";
  }

  const idLower = String(selectedSubtitleId || "").trim().toLowerCase();
  if (idLower.startsWith("ai-")) {
    return "boundary-v3";
  }

  const needsBoundary = shouldSegmentTrack({
    strategy: "auto",
    selectedSubtitleId,
    selectedSubtitleLang,
    trackLan,
    items
  });

  return needsBoundary ? "boundary-v3" : "cc-json";
}

export interface TranslateSubtitleItemsInput extends SubtitleTranslatePromptContext {
  items: SubtitleBodyItem[];
  events?: readonly AtomicSubtitleEvent[];
  targetLang: string;
  sourceLang?: string;
  mode?: "auto" | SubtitleTranslateProtocolMode;
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  context?: SubtitleTranslatePromptContext;
  l1Index?: L1VideoIndexCacheRecord | null;
  chunkFromSec?: number;
  chunkToSec?: number;
  maxChunkChars?: number;
  providerResolution?: SubtitleTranslateProviderResolution;
  stream?: boolean;
  onCueReady?: (cue: StreamingSubtitleCue) => void;
  signal?: AbortSignal | null;
  fallbackToOriginal?: boolean;
  chatCompletionFn?: typeof chatCompletion;
  fetchImpl?: ProviderTransport;
  indexTranslateOptions?: Omit<IndexTranslateRetryOptions, "signal" | "onRetry"> & {
    limiter?: IndexTranslateRateLimiter;
  };
}

export interface TranslateSubtitleTrackResult {
  mode: SubtitleTranslateProtocolMode;
  items: SubtitleBodyItem[];
  translations: SubtitleBodyItem[];
}

export type TranslatedSubtitleItemsArray = SubtitleBodyItem[] & {
  readonly mode: SubtitleTranslateProtocolMode;
  readonly items: SubtitleBodyItem[];
  readonly translations: SubtitleBodyItem[];
};

const DEFAULT_MAX_CHUNK_CHARS = 1000;

function splitCcItemsIntoBatches(
  items: readonly SubtitleBodyItem[],
  maxChunkChars = DEFAULT_MAX_CHUNK_CHARS
): SubtitleBodyItem[][] {
  if (items.length === 0) {
    return [];
  }
  const hardLimit = Math.max(1, Math.floor(Number(maxChunkChars) || DEFAULT_MAX_CHUNK_CHARS));
  const batches: SubtitleBodyItem[][] = [];
  let current: SubtitleBodyItem[] = [];
  let currentChars = 0;

  for (const item of items) {
    const len = String(item?.content ?? "").length;
    if (current.length > 0 && currentChars + len > hardLimit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += len;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

async function invokeSingleTranslationAttempt(args: {
  providerConfig: SubtitleTranslateRequestInput["provider"];
  messages: ChatMessage[];
  stream: boolean;
  retries?: number;
  signal?: AbortSignal | null;
  fetchImpl: ProviderTransport;
  chatCompletionFn: typeof chatCompletion;
  onDelta?: (delta: string) => void;
  onStreamReset?: () => void;
}): Promise<string> {
  const {
    providerConfig,
    messages,
    stream,
    retries,
    signal,
    fetchImpl,
    chatCompletionFn,
    onDelta,
    onStreamReset
  } = args;

  if (!stream) {
    const request = buildSubtitleTranslateRequest({
      provider: providerConfig,
      messages,
      stream: false,
      ...(retries !== undefined ? { retries } : {}),
      signal,
      fetchImpl
    });
    const rawResult = await chatCompletionFn(request);
    const cleaned = stripThinkBlocks(typeof rawResult === "string" ? rawResult : "");
    if (cleaned) {
      onDelta?.(cleaned);
    }
    return cleaned;
  }

  let streamedText = "";
  const thinkFilter = onDelta
    ? createThinkBlockStreamFilter((cleanChunk) => onDelta(cleanChunk))
    : null;
  const resetStream = (): void => {
    streamedText = "";
    thinkFilter?.reset();
    onStreamReset?.();
  };

  const streamRequest = buildSubtitleTranslateRequest({
    provider: providerConfig,
    messages,
    stream: true,
    retries: retries ?? 0,
    signal,
    fetchImpl,
    onEvent: (event) => {
      if (event.type === "token" && event.data) {
        streamedText += event.data;
        thinkFilter?.push(event.data);
      }
    },
    onStreamReset: resetStream
  });

  const rawResult = await chatCompletionFn(streamRequest);
  thinkFilter?.flush();
  if (typeof rawResult === "string") {
    const cleanedRaw = stripThinkBlocks(rawResult);
    if (!streamedText && cleanedRaw) {
      onDelta?.(cleanedRaw);
      return cleanedRaw;
    }
    return stripThinkBlocks(streamedText) || cleanedRaw;
  }
  return stripThinkBlocks(streamedText);
}

async function invokeTranslationLlm(args: {
  resolved: SubtitleTranslateProviderResolution;
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  fetchImpl: ProviderTransport;
  chatCompletionFn: typeof chatCompletion;
  onDelta?: (delta: string) => void;
  onStreamReset?: () => void;
  indexTranslateOptions?: TranslateSubtitleItemsInput["indexTranslateOptions"];
}): Promise<string> {
  throwIfAborted(args.signal);
  const useStream = args.stream ?? true;
  const providerConfig: SubtitleTranslateRequestInput["provider"] = {
    id: args.resolved.provider?.id,
    baseUrl: args.resolved.baseUrl,
    apiKey: args.resolved.apiKey,
    model: args.resolved.model,
    presetId: args.resolved.presetId,
    protocol: args.resolved.protocol
  };
  const isIndexTranslate = isIndexTranslateProvider(providerConfig);

  if (isIndexTranslate) {
    const retryOpts: IndexTranslateRetryOptions = {
      ...(args.indexTranslateOptions ?? {}),
      limiter: args.indexTranslateOptions?.limiter ?? defaultIndexTranslateLimiter,
      signal: args.signal,
      onRetry: () => {
        args.onStreamReset?.();
      }
    };

    if (!useStream) {
      return runWithIndexTranslateRetry(
        () =>
          invokeSingleTranslationAttempt({
            providerConfig,
            messages: args.messages,
            stream: false,
            retries: 0,
            signal: args.signal,
            fetchImpl: args.fetchImpl,
            chatCompletionFn: args.chatCompletionFn,
            onDelta: args.onDelta
          }),
        retryOpts
      );
    }

    try {
      return await runWithIndexTranslateRetry(
        () =>
          invokeSingleTranslationAttempt({
            providerConfig,
            messages: args.messages,
            stream: true,
            retries: 0,
            signal: args.signal,
            fetchImpl: args.fetchImpl,
            chatCompletionFn: args.chatCompletionFn,
            onDelta: args.onDelta,
            onStreamReset: args.onStreamReset
          }),
        retryOpts
      );
    } catch (err) {
      if (
        args.signal?.aborted ||
        isAbortedMarkerError(err) ||
        isAbortNamedError(err) ||
        isCancelledError(err)
      ) {
        throw err;
      }
      // 限流/网络/服务端错误或 412 风控拦截在重试后直接以清晰错误上抛，不再无延迟重复撞击
      if (isIndexTranslateRetryableError(err) || getHttpStatusFromError(err) === 412) {
        throw err;
      }
      // 其余仅流式不支持类错误（如 400 streaming unsupported）静默回退一次非流式
      args.onStreamReset?.();
      throwIfAborted(args.signal);
      return runWithIndexTranslateRetry(
        () =>
          invokeSingleTranslationAttempt({
            providerConfig,
            messages: args.messages,
            stream: false,
            retries: 0,
            signal: args.signal,
            fetchImpl: args.fetchImpl,
            chatCompletionFn: args.chatCompletionFn,
            onDelta: args.onDelta
          }),
        retryOpts
      );
    }
  }

  if (!useStream) {
    return invokeSingleTranslationAttempt({
      providerConfig,
      messages: args.messages,
      stream: false,
      signal: args.signal,
      fetchImpl: args.fetchImpl,
      chatCompletionFn: args.chatCompletionFn,
      onDelta: args.onDelta
    });
  }

  try {
    return await invokeSingleTranslationAttempt({
      providerConfig,
      messages: args.messages,
      stream: true,
      retries: 0,
      signal: args.signal,
      fetchImpl: args.fetchImpl,
      chatCompletionFn: args.chatCompletionFn,
      onDelta: args.onDelta,
      onStreamReset: args.onStreamReset
    });
  } catch (err) {
    if (
      args.signal?.aborted ||
      isAbortedMarkerError(err) ||
      isAbortNamedError(err) ||
      isCancelledError(err)
    ) {
      throw err;
    }

    // 流式异常无感降级：清空流式解析缓冲后无缝回退调用一次非流式 stream: false
    args.onStreamReset?.();
    throwIfAborted(args.signal);

    return invokeSingleTranslationAttempt({
      providerConfig,
      messages: args.messages,
      stream: false,
      signal: args.signal,
      fetchImpl: args.fetchImpl,
      chatCompletionFn: args.chatCompletionFn,
      onDelta: args.onDelta
    });
  }
}

async function translateCcBatchWithRetry(args: {
  batch: readonly SubtitleBodyItem[];
  targetLang: string;
  context?: SubtitleTranslatePromptContext;
  previousLines?: readonly SubtitlePreviousLine[];
  resolved: SubtitleTranslateProviderResolution;
  stream?: boolean;
  signal?: AbortSignal | null;
  fallbackToOriginal: boolean;
  chatCompletionFn: typeof chatCompletion;
  fetchImpl: ProviderTransport;
  allowMissingRetry: boolean;
  batchOffset?: number;
  emittedKeys?: Set<string>;
  onCueReady?: (cue: StreamingSubtitleCue) => void;
  indexTranslateOptions?: TranslateSubtitleItemsInput["indexTranslateOptions"];
}): Promise<{ items: SubtitleBodyItem[]; translations: SubtitleBodyItem[] }> {
  const {
    batch,
    targetLang,
    context,
    previousLines,
    resolved,
    stream,
    signal,
    fallbackToOriginal,
    chatCompletionFn,
    fetchImpl,
    allowMissingRetry,
    batchOffset = 0,
    emittedKeys = new Set<string>(),
    onCueReady,
    indexTranslateOptions
  } = args;

  const normalizedItems: SubtitleBodyItem[] = batch.map((item) => ({
    from: Number(item?.from) || 0,
    to: Number(item?.to) || 0,
    content: String(item?.content ?? "").trim()
  }));

  const batchText = normalizedItems.map((item) => item.content).join(" ");
  const chunkContext = buildChunkSubtitleContext(context, batchText, previousLines ?? context?.previousLines);
  const primaryMessages = buildCcTranslateMessages(normalizedItems, targetLang, chunkContext);
  const primaryParser = onCueReady
    ? createStreamingSubtitleParser({
        items: normalizedItems,
        mode: "cc-json",
        indexOffset: batchOffset,
        emittedKeys,
        onCueReady
      })
    : null;
  const primaryRaw = await invokeTranslationLlm({
    resolved,
    messages: primaryMessages,
    stream,
    signal,
    fetchImpl,
    chatCompletionFn,
    onDelta: primaryParser ? (delta) => primaryParser.feed(delta) : undefined,
    onStreamReset: primaryParser ? () => primaryParser.resetStreamAttempt() : undefined,
    indexTranslateOptions
  });

  const translationMap = parseCcTranslationMap(primaryRaw, normalizedItems.length);

  if (allowMissingRetry) {
    const missingIndices: number[] = [];
    for (let i = 0; i < normalizedItems.length; i += 1) {
      const srcText = normalizedItems[i].content;
      if (srcText && !isNonSpeechSegment(srcText) && !translationMap.has(i)) {
        missingIndices.push(i);
      }
    }

    if (missingIndices.length > 0) {
      throwIfAborted(signal);
      const missingItems = missingIndices.map((idx) => ({
        content: normalizedItems[idx].content
      }));
      try {
        const missingText = missingItems.map((item) => item.content).join(" ");
        const retryContext = buildChunkSubtitleContext(context, missingText, previousLines ?? context?.previousLines);
        const retryMessages = buildCcTranslateMessages(missingItems, targetLang, retryContext);
        const retryRaw = await invokeTranslationLlm({
          resolved,
          messages: retryMessages,
          stream,
          signal,
          fetchImpl,
          chatCompletionFn,
          indexTranslateOptions
        });
        const retryMap = parseCcTranslationMap(retryRaw, missingIndices.length);
        for (const [retryIdx, translatedText] of retryMap.entries()) {
          const origIdx = missingIndices[retryIdx];
          if (origIdx !== undefined && translatedText) {
            translationMap.set(origIdx, translatedText);
            if (onCueReady) {
              const globalIdx = origIdx + batchOffset;
              const dedupeKey = `${globalIdx}:${globalIdx}`;
              if (!emittedKeys.has(dedupeKey)) {
                emittedKeys.add(dedupeKey);
                onCueReady({
                  startIndex: globalIdx,
                  endIndex: globalIdx,
                  from: normalizedItems[origIdx].from,
                  to: normalizedItems[origIdx].to,
                  text: normalizedItems[origIdx].content,
                  translation: translatedText
                });
              }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        // 单补请求失败时保留首轮已对齐结果，不中断整批字幕
      }
    }
  }

  const translations: SubtitleBodyItem[] = normalizedItems.map((item, idx) => {
    const translated = translationMap.get(idx);
    return {
      from: item.from,
      to: item.to,
      content:
        translated && translated.length > 0
          ? translated
          : fallbackToOriginal
            ? item.content
            : ""
    };
  });

  return { items: normalizedItems, translations };
}

async function translateBoundaryChunkWithRecovery(args: {
  chunkEvents: readonly AtomicSubtitleEvent[];
  targetLang: string;
  sourceLang?: string;
  context?: SubtitleTranslatePromptContext;
  previousLines?: readonly SubtitlePreviousLine[];
  resolved: SubtitleTranslateProviderResolution;
  stream?: boolean;
  signal?: AbortSignal | null;
  fallbackToOriginal: boolean;
  chatCompletionFn: typeof chatCompletion;
  fetchImpl: ProviderTransport;
  eventOffset?: number;
  emittedKeys?: Set<string>;
  onCueReady?: (cue: StreamingSubtitleCue) => void;
  indexTranslateOptions?: TranslateSubtitleItemsInput["indexTranslateOptions"];
}): Promise<{ items: SubtitleBodyItem[]; translations: SubtitleBodyItem[] }> {
  const {
    chunkEvents,
    targetLang,
    sourceLang,
    context,
    previousLines,
    resolved,
    stream,
    signal,
    fallbackToOriginal,
    chatCompletionFn,
    fetchImpl,
    eventOffset = 0,
    emittedKeys = new Set<string>(),
    onCueReady,
    indexTranslateOptions
  } = args;

  const chunkText = chunkEvents.map((ev) => String(ev?.text ?? "")).join(" ");
  const chunkContext = buildChunkSubtitleContext(context, chunkText, previousLines ?? context?.previousLines);
  const omitTextField = isIndexTranslateProvider(resolved.provider);
  const primaryMessages = buildBoundaryTranslateMessages(chunkEvents, targetLang, chunkContext, {
    omitTextField
  });
  const primaryParser = onCueReady
    ? createStreamingSubtitleParser({
        events: chunkEvents,
        sourceLang,
        mode: "boundary-v3",
        indexOffset: eventOffset,
        emittedKeys,
        onCueReady
      })
    : null;
  const primaryRaw = await invokeTranslationLlm({
    resolved,
    messages: primaryMessages,
    stream,
    signal,
    fetchImpl,
    chatCompletionFn,
    onDelta: primaryParser ? (delta) => primaryParser.feed(delta) : undefined,
    onStreamReset: primaryParser ? () => primaryParser.resetStreamAttempt() : undefined,
    indexTranslateOptions
  });

  // 第 1 重 & 第 2 重：截断 JSON 抢救 + 连续无跳号前缀回填
  const salvagedPrimary = salvageTruncatedSubtitleJson(primaryRaw);
  let cues: BoundaryCue[] = salvagedPrimary
    ? mapBoundaryGroupsToCues(salvagedPrimary, chunkEvents, sourceLang)
    : [];

  // 第 3 重（Tail Retry）：首轮部分覆盖时，对尾部未覆盖切片最多发起 1 次补算请求
  const coveredEnd = cues.length > 0 ? cues[cues.length - 1].endIndex : -1;
  if (coveredEnd >= 0 && coveredEnd < chunkEvents.length - 1) {
    throwIfAborted(signal);
    const offset = coveredEnd + 1;
    const tailEvents = chunkEvents.slice(offset);
    try {
      const tailText = tailEvents.map((ev) => String(ev?.text ?? "")).join(" ");
      const tailPrevLines = cues.length > 0
        ? cues
            .slice(-2)
            .filter((cue) => cue.text.trim().length > 0 && cue.translation.trim().length > 0)
            .map((cue) => ({ original: cue.text.trim(), translation: cue.translation.trim() }))
        : (previousLines ?? context?.previousLines);
      const tailContext = buildChunkSubtitleContext(context, tailText, tailPrevLines);
      const retryMessages = buildBoundaryTranslateMessages(tailEvents, targetLang, tailContext, {
        omitTextField
      });
      const tailParser = onCueReady
        ? createStreamingSubtitleParser({
            events: tailEvents,
            sourceLang,
            mode: "boundary-v3",
            indexOffset: eventOffset + offset,
            emittedKeys,
            onCueReady
          })
        : null;
      const retryRaw = await invokeTranslationLlm({
        resolved,
        messages: retryMessages,
        stream,
        signal,
        fetchImpl,
        chatCompletionFn,
        onDelta: tailParser ? (delta) => tailParser.feed(delta) : undefined,
        onStreamReset: tailParser ? () => tailParser.resetStreamAttempt() : undefined,
        indexTranslateOptions
      });
      const salvagedRetry = salvageTruncatedSubtitleJson(retryRaw);
      if (salvagedRetry) {
        const tailCues = mapBoundaryGroupsToCues(salvagedRetry, tailEvents, sourceLang);
        const shiftedTailCues: BoundaryCue[] = tailCues.map((cue) => ({
          ...cue,
          startIndex: cue.startIndex + offset,
          endIndex: cue.endIndex + offset
        }));
        cues = [...cues, ...shiftedTailCues];
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      // Tail Retry 失败时进入第 4 重本地规则降级
    }
  }

  // 第 4 重（一致性守卫与本地规则降级）
  const finalized = await finalizeAiCues(cues, chunkEvents, {
    sourceLang,
    fallbackToOriginal,
    translateFallbackLines: async (texts: string[]) => {
      throwIfAborted(signal);
      const pseudoItems: SubtitleBodyItem[] = texts.map((text, idx) => ({
        from: idx,
        to: idx + 1,
        content: text
      }));
      const res = await translateCcBatchWithRetry({
        batch: pseudoItems,
        targetLang,
        context,
        previousLines: previousLines ?? context?.previousLines,
        resolved,
        stream,
        signal,
        fallbackToOriginal: false,
        chatCompletionFn,
        fetchImpl,
        allowMissingRetry: false,
        indexTranslateOptions
      });
      return res.translations.map((t) => t.content);
    }
  });

  throwIfAborted(signal);
  if (onCueReady) {
    for (const cue of finalized.cues) {
      const globalStart = cue.startIndex + eventOffset;
      const globalEnd = cue.endIndex + eventOffset;
      const dedupeKey = `${globalStart}:${globalEnd}`;
      if (!emittedKeys.has(dedupeKey)) {
        emittedKeys.add(dedupeKey);
        onCueReady({
          startIndex: globalStart,
          endIndex: globalEnd,
          from: cue.from,
          to: cue.to,
          text: cue.text,
          translation: cue.translation
        });
      }
    }
  }

  return {
    items: finalized.items.map((item) => ({ ...item })),
    translations: finalized.translations.map((item) => ({ ...item }))
  };
}

function resolveChunkPromptContext(
  baseContext: SubtitleTranslatePromptContext | undefined,
  l1Index: L1VideoIndexCacheRecord | null,
  chunkItems: ReadonlyArray<SubtitleTimeItemHint>,
  chunkFromSec: number | undefined,
  chunkToSec: number | undefined,
  explicitChapterContext: unknown,
  explicitReferenceEntities: unknown
): SubtitleTranslatePromptContext | undefined {
  if (
    !l1Index ||
    (explicitChapterContext !== undefined && explicitReferenceEntities !== undefined)
  ) {
    return baseContext;
  }
  const l1Chapter = resolveL1ChapterTranslateContext({
    l1Index,
    items: chunkItems,
    ...(chunkFromSec !== undefined ? { chunkFromSec } : {}),
    ...(chunkToSec !== undefined ? { chunkToSec } : {}),
    glossary: baseContext?.glossary
  });
  if (
    !l1Chapter.chapterContext &&
    (!l1Chapter.referenceEntities || l1Chapter.referenceEntities.length === 0)
  ) {
    return baseContext;
  }
  return {
    ...(baseContext ?? {}),
    ...(explicitChapterContext === undefined && l1Chapter.chapterContext
      ? { chapterContext: l1Chapter.chapterContext }
      : {}),
    ...(explicitReferenceEntities === undefined && l1Chapter.referenceEntities?.length
      ? { referenceEntities: l1Chapter.referenceEntities }
      : {})
  };
}

/**
 * 双通道字幕翻译主入口：
 * 返回协议模式 `mode`、重组后的主轨 `items` 与对齐的译文副轨 `translations`。
 */
export async function translateSubtitleTrack(
  input: TranslateSubtitleItemsInput
): Promise<TranslateSubtitleTrackResult> {
  const {
    items = [],
    events: explicitEvents,
    targetLang,
    sourceLang,
    mode = "auto",
    selectedSubtitleId,
    selectedSubtitleLang,
    trackLan,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    providerResolution,
    stream,
    onCueReady,
    signal,
    fallbackToOriginal = false,
    chatCompletionFn = chatCompletion,
    fetchImpl = providerFetchViaOffscreen,
    indexTranslateOptions
  } = input;

  const hasExplicitEvents = Array.isArray(explicitEvents) && explicitEvents.length > 0;
  const hasItems = Array.isArray(items) && items.length > 0;

  const resolvedMode = resolveSubtitleTranslateProtocolMode({
    mode,
    selectedSubtitleId,
    selectedSubtitleLang,
    trackLan,
    items,
    events: explicitEvents
  });

  if (!hasExplicitEvents && !hasItems) {
    return { mode: resolvedMode, items: [], translations: [] };
  }

  const effectiveSourceLang = sourceLang ?? trackLan ?? selectedSubtitleLang;
  const explicitChapterContext = input.chapterContext ?? input.context?.chapterContext;
  const explicitReferenceEntities = input.referenceEntities ?? input.context?.referenceEntities;
  const needsL1Lookup =
    input.l1Index === undefined &&
    (explicitChapterContext === undefined || explicitReferenceEntities === undefined);
  const l1Index =
    input.l1Index !== undefined
      ? input.l1Index
      : needsL1Lookup
        ? await readCachedL1VideoIndex()
        : null;
  const baseContext = await resolveRuntimeSubtitleContext({
    ...input,
    items: undefined,
    chunkFromSec: undefined,
    chunkToSec: undefined,
    l1Index
  });
  const emittedKeys = new Set<string>();

  if (resolvedMode === "boundary-v3") {
    const atomicEvents = hasExplicitEvents
      ? explicitEvents!
      : toAtomicSubtitleEvents(items);

    if (atomicEvents.length === 0) {
      return { mode: "boundary-v3", items: [], translations: [] };
    }

    const resolved = providerResolution || (await resolveSubtitleTranslateProvider());
    const chunks = splitEventsIntoAiChunks(atomicEvents, maxChunkChars);
    const outItems: SubtitleBodyItem[] = [];
    const outTranslations: SubtitleBodyItem[] = [];
    let eventOffset = 0;
    let rollingPreviousLines = baseContext?.previousLines;

    for (const chunkEvents of chunks) {
      throwIfAborted(signal);
      const chunkContext = resolveChunkPromptContext(
        baseContext,
        l1Index,
        chunkEvents,
        input.chunkFromSec,
        input.chunkToSec,
        explicitChapterContext,
        explicitReferenceEntities
      );
      const chunkResult = await translateBoundaryChunkWithRecovery({
        chunkEvents,
        targetLang,
        sourceLang: effectiveSourceLang,
        context: chunkContext,
        previousLines: rollingPreviousLines,
        resolved,
        stream,
        signal,
        fallbackToOriginal,
        chatCompletionFn,
        fetchImpl,
        eventOffset,
        emittedKeys,
        onCueReady,
        indexTranslateOptions
      });
      outItems.push(...chunkResult.items);
      outTranslations.push(...chunkResult.translations);
      const nextPrevious = extractPreviousBilingualLines(chunkResult.items, chunkResult.translations, 2);
      if (nextPrevious.length > 0) {
        rollingPreviousLines = nextPrevious;
      }
      eventOffset += chunkEvents.length;
    }

    return {
      mode: "boundary-v3",
      items: outItems,
      translations: outTranslations
    };
  }

  // 人工精校 CC 字幕：严格 ID 对齐批量 JSON 协议
  const resolved = providerResolution || (await resolveSubtitleTranslateProvider());
  const batches = splitCcItemsIntoBatches(items, maxChunkChars);
  const outItems: SubtitleBodyItem[] = [];
  const outTranslations: SubtitleBodyItem[] = [];
  let batchOffset = 0;
  let rollingPreviousLines = baseContext?.previousLines;

  for (const batch of batches) {
    throwIfAborted(signal);
    const batchContext = resolveChunkPromptContext(
      baseContext,
      l1Index,
      batch,
      input.chunkFromSec,
      input.chunkToSec,
      explicitChapterContext,
      explicitReferenceEntities
    );
    const batchResult = await translateCcBatchWithRetry({
      batch,
      targetLang,
      context: batchContext,
      previousLines: rollingPreviousLines,
      resolved,
      stream,
      signal,
      fallbackToOriginal,
      chatCompletionFn,
      fetchImpl,
      allowMissingRetry: true,
      batchOffset,
      emittedKeys,
      onCueReady,
      indexTranslateOptions
    });
    outItems.push(...batchResult.items);
    outTranslations.push(...batchResult.translations);
    const nextPrevious = extractPreviousBilingualLines(batchResult.items, batchResult.translations, 2);
    if (nextPrevious.length > 0) {
      rollingPreviousLines = nextPrevious;
    }
    batchOffset += batch.length;
  }

  return {
    mode: "cc-json",
    items: outItems,
    translations: outTranslations
  };
}

function attachDualChannelMetadata(
  result: TranslateSubtitleTrackResult
): TranslatedSubtitleItemsArray {
  const arr = [...result.translations] as SubtitleBodyItem[];
  Object.defineProperties(arr, {
    mode: {
      value: result.mode,
      enumerable: false,
      configurable: true
    },
    items: {
      value: result.items,
      enumerable: false,
      configurable: true
    },
    translations: {
      value: result.translations,
      enumerable: false,
      configurable: true
    }
  });
  return arr as TranslatedSubtitleItemsArray;
}

/**
 * 兼容旧函数签名的字幕翻译核心入口：
 * 返回译文条目数组 `SubtitleBodyItem[]`（兼容现有副轨调用方），
 * 同时在返回值上挂载不可枚举属性 `items`（重组后的主轨）与 `translations`（对齐译文副轨），
 * 以便上层双语视图按需读取更新。
 */
export async function translateSubtitleItems(
  input: TranslateSubtitleItemsInput
): Promise<TranslatedSubtitleItemsArray> {
  const result = await translateSubtitleTrack(input);
  return attachDualChannelMetadata(result);
}
