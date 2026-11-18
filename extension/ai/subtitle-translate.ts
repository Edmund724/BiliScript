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
  resolveSubtitleTranslateProviderConfig,
  type SubtitleTranslateProviderResolution
} from "./subtitle-translate-config.js";
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
  finalizeAiCues,
  formatBoundaryEvents,
  formatCcSubtitleItems,
  mapBoundaryGroupsToCues,
  parseCcTranslationMap,
  salvageTruncatedSubtitleJson,
  splitEventsIntoAiChunks,
  type BoundaryCue
} from "../subtitle/boundary-protocol.js";

export type SubtitleTranslateProtocolMode = "boundary-v3" | "cc-json";

export type SubtitleGlossaryEntry = {
  source: string;
  target: string;
  note?: string;
};

export type SubtitleGlossaryInput =
  | string
  | readonly SubtitleGlossaryEntry[]
  | Readonly<Record<string, string>>;

export interface SubtitleTranslatePromptContext {
  title?: string;
  description?: string;
  summary?: string;
  glossary?: SubtitleGlossaryInput;
}

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
    baseUrl: string;
    apiKey: string;
    model: string;
    presetId?: string;
    protocol?: AiProtocol;
  };
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  maxTokens?: number | null;
  fetchImpl?: ProviderTransport;
  /** 外部传入的任何思考档位将被显式忽略，强制收敛为 "off"。 */
  thinkingLevel?: unknown;
}

/**
 * 装配字幕翻译模型请求：
 * 固定将思考档位设为关闭（`off`），不继承对话面板的高思考强度档位，
 * 降低首字延迟与 token 消耗；传输默认走 offscreen 代发通道以绕过页面 CORS 预检。
 */
export function buildSubtitleTranslateRequest(
  input: SubtitleTranslateRequestInput
): ChatCompletionInput {
  return {
    provider: {
      baseUrl: String(input.provider.baseUrl || "").trim(),
      apiKey: String(input.provider.apiKey || "").trim(),
      model: String(input.provider.model || "").trim(),
      presetId: String(input.provider.presetId || "custom").trim() || "custom",
      protocol: input.provider.protocol || "openai"
    },
    messages: input.messages,
    stream: input.stream ?? false,
    signal: input.signal ?? null,
    maxTokens: input.maxTokens ?? null,
    fetchImpl: input.fetchImpl ?? providerFetchViaOffscreen,
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
  return Object.prototype.hasOwnProperty.call(TARGET_LANG_NAME_MAP, code)
    ? TARGET_LANG_NAME_MAP[code]
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

function formatGlossarySection(glossary?: SubtitleGlossaryInput): string {
  if (!glossary) {
    return "";
  }
  if (typeof glossary === "string") {
    return glossary.trim();
  }
  if (Array.isArray(glossary)) {
    const lines = glossary
      .map((entry) => {
        const src = String(entry?.source ?? "").trim();
        const tgt = String(entry?.target ?? "").trim();
        const note = String(entry?.note ?? "").trim();
        if (!src || !tgt) return "";
        return note ? `- ${src} -> ${tgt} (${note})` : `- ${src} -> ${tgt}`;
      })
      .filter(Boolean);
    return lines.join("\n");
  }
  const entries = Object.entries(glossary as Record<string, string>)
    .map(([src, tgt]) => {
      const s = String(src ?? "").trim();
      const t = String(tgt ?? "").trim();
      return s && t ? `- ${s} -> ${t}` : "";
    })
    .filter(Boolean);
  return entries.join("\n");
}

function buildOptionalContextBlock(context?: SubtitleTranslatePromptContext): string {
  if (!context) {
    return "";
  }
  const sections: string[] = [];
  const title = String(context.title ?? "").trim();
  const description = String(context.description ?? "").trim();
  const summary = String(context.summary ?? "").trim();
  const glossaryText = formatGlossarySection(context.glossary);

  if (title) {
    sections.push(`视频标题：${title}`);
  }
  if (description) {
    sections.push(`视频简介：${description}`);
  }
  if (summary) {
    sections.push(`内容摘要：${summary}`);
  }
  if (glossaryText) {
    sections.push(`术语表（请严格保持专有名词译法一致）：\n${glossaryText}`);
  }

  if (sections.length === 0) {
    return "";
  }
  return `\n\n参考上下文：\n${sections.join("\n")}`;
}

/**
 * `boundary-v3` 联合断句 + 翻译 System/User Prompt 装配（支持可选注入 title/description/summary/glossary）。
 */
export function buildBoundaryTranslateMessages(
  events: readonly AtomicSubtitleEvent[],
  targetLang: string,
  context?: SubtitleTranslatePromptContext
): ChatMessage[] {
  const langName = resolveTargetLangDisplayName(targetLang);
  const contextBlock = buildOptionalContextBlock(context);
  const encodedEvents = formatBoundaryEvents(events);

  const systemContent =
    `你是一个专业的音视频字幕智能断句与翻译专家。请将输入的细粒度字幕片段按自然语义合并断句，并翻译为${langName}。\n` +
    `输入格式为 JSON 数组，每项包含唯一递增字符串索引 "id"、片段文本 "text"，以及可选的与下一片段的静音停顿毫秒数 "pauseMs"。\n\n` +
    `严格遵守以下协议与断句规则：\n` +
    `1. 输出格式：仅输出严格合法的 JSON 对象，结构为 {"groups":[{"ids":["0","2"],"text":"...","translation":"..."}]}；当某组仅含单个片段时写 {"ids":["3"],"text":"...","translation":"..."}，含连续多个片段时写首尾端点 ["startId","endId"]。严禁输出 \`\`\`json 等 Markdown 围栏、前言或任何解释文字。\n` +
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
  const contextBlock = buildOptionalContextBlock(context);
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
  maxChunkChars?: number;
  providerResolution?: SubtitleTranslateProviderResolution;
  signal?: AbortSignal | null;
  fallbackToOriginal?: boolean;
  chatCompletionFn?: typeof chatCompletion;
  fetchImpl?: ProviderTransport;
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

function mergePromptContext(input: TranslateSubtitleItemsInput): SubtitleTranslatePromptContext | undefined {
  const base = input.context;
  const title = input.title ?? base?.title;
  const description = input.description ?? base?.description;
  const summary = input.summary ?? base?.summary;
  const glossary = input.glossary ?? base?.glossary;
  if (!title && !description && !summary && !glossary) {
    return undefined;
  }
  return { title, description, summary, glossary };
}

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

async function invokeTranslationLlm(args: {
  resolved: SubtitleTranslateProviderResolution;
  messages: ChatMessage[];
  signal?: AbortSignal | null;
  fetchImpl: ProviderTransport;
  chatCompletionFn: typeof chatCompletion;
}): Promise<string> {
  throwIfAborted(args.signal);
  const request = buildSubtitleTranslateRequest({
    provider: {
      baseUrl: args.resolved.baseUrl,
      apiKey: args.resolved.apiKey,
      model: args.resolved.model,
      presetId: args.resolved.presetId,
      protocol: args.resolved.protocol
    },
    messages: args.messages,
    signal: args.signal,
    fetchImpl: args.fetchImpl
  });
  const rawResult = await args.chatCompletionFn(request);
  return typeof rawResult === "string" ? rawResult : "";
}

async function translateCcBatchWithRetry(args: {
  batch: readonly SubtitleBodyItem[];
  targetLang: string;
  context?: SubtitleTranslatePromptContext;
  resolved: SubtitleTranslateProviderResolution;
  signal?: AbortSignal | null;
  fallbackToOriginal: boolean;
  chatCompletionFn: typeof chatCompletion;
  fetchImpl: ProviderTransport;
  allowMissingRetry: boolean;
}): Promise<{ items: SubtitleBodyItem[]; translations: SubtitleBodyItem[] }> {
  const {
    batch,
    targetLang,
    context,
    resolved,
    signal,
    fallbackToOriginal,
    chatCompletionFn,
    fetchImpl,
    allowMissingRetry
  } = args;

  const normalizedItems: SubtitleBodyItem[] = batch.map((item) => ({
    from: Number(item?.from) || 0,
    to: Number(item?.to) || 0,
    content: String(item?.content ?? "").trim()
  }));

  const primaryMessages = buildCcTranslateMessages(normalizedItems, targetLang, context);
  const primaryRaw = await invokeTranslationLlm({
    resolved,
    messages: primaryMessages,
    signal,
    fetchImpl,
    chatCompletionFn
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
        const retryMessages = buildCcTranslateMessages(missingItems, targetLang, context);
        const retryRaw = await invokeTranslationLlm({
          resolved,
          messages: retryMessages,
          signal,
          fetchImpl,
          chatCompletionFn
        });
        const retryMap = parseCcTranslationMap(retryRaw, missingIndices.length);
        for (const [retryIdx, translatedText] of retryMap.entries()) {
          const origIdx = missingIndices[retryIdx];
          if (origIdx !== undefined && translatedText) {
            translationMap.set(origIdx, translatedText);
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
  resolved: SubtitleTranslateProviderResolution;
  signal?: AbortSignal | null;
  fallbackToOriginal: boolean;
  chatCompletionFn: typeof chatCompletion;
  fetchImpl: ProviderTransport;
}): Promise<{ items: SubtitleBodyItem[]; translations: SubtitleBodyItem[] }> {
  const {
    chunkEvents,
    targetLang,
    sourceLang,
    context,
    resolved,
    signal,
    fallbackToOriginal,
    chatCompletionFn,
    fetchImpl
  } = args;

  const primaryMessages = buildBoundaryTranslateMessages(chunkEvents, targetLang, context);
  const primaryRaw = await invokeTranslationLlm({
    resolved,
    messages: primaryMessages,
    signal,
    fetchImpl,
    chatCompletionFn
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
      const retryMessages = buildBoundaryTranslateMessages(tailEvents, targetLang, context);
      const retryRaw = await invokeTranslationLlm({
        resolved,
        messages: retryMessages,
        signal,
        fetchImpl,
        chatCompletionFn
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
        resolved,
        signal,
        fallbackToOriginal: false,
        chatCompletionFn,
        fetchImpl,
        allowMissingRetry: false
      });
      return res.translations.map((t) => t.content);
    }
  });

  throwIfAborted(signal);
  return {
    items: finalized.items.map((item) => ({ ...item })),
    translations: finalized.translations.map((item) => ({ ...item }))
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
    signal,
    fallbackToOriginal = false,
    chatCompletionFn = chatCompletion,
    fetchImpl = providerFetchViaOffscreen
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
  const context = mergePromptContext(input);

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

    for (const chunkEvents of chunks) {
      throwIfAborted(signal);
      const chunkResult = await translateBoundaryChunkWithRecovery({
        chunkEvents,
        targetLang,
        sourceLang: effectiveSourceLang,
        context,
        resolved,
        signal,
        fallbackToOriginal,
        chatCompletionFn,
        fetchImpl
      });
      outItems.push(...chunkResult.items);
      outTranslations.push(...chunkResult.translations);
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

  for (const batch of batches) {
    throwIfAborted(signal);
    const batchResult = await translateCcBatchWithRetry({
      batch,
      targetLang,
      context,
      resolved,
      signal,
      fallbackToOriginal,
      chatCompletionFn,
      fetchImpl,
      allowMissingRetry: true
    });
    outItems.push(...batchResult.items);
    outTranslations.push(...batchResult.translations);
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
