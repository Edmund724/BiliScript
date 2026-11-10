import { resolveActiveProvider } from "../ai/active-provider.js";
import { chatCompletion } from "../ai/completion.js";
import { buildSubtitlePrompt } from "../ai/subtitle-prompt.js";
import type { AiProvider, ChatMessage } from "../ai/types.js";
import type { OverviewAnalysis } from "../ai/analysis.js";
import { state, type ClipState } from "../core/state.js";
import { providerFetchViaOffscreen } from "../core/provider-http-offscreen.js";
import {
  getErrorMessage,
  isAbortedMarkerError,
  isAbortNamedError,
  makeAbortedError
} from "../shared/error-helpers.js";
import { formatClock } from "../shared/clock-text.js";
import { getReadingSubtitleItems, type ReadingSubtitleItem } from "../subtitle/core.js";

export const VIDEO_BACKEND_INJECTION_MAX_CHARS = 1799;
const MAX_SILENT_CHUNKS = 2;

const SPOKEN_PREFIX = "[后台文本模型已完成分析]\n核心脉络与结论如下：\n";
const SPOKEN_SUFFIX = "\n---\n【播报要求】：请用自然口语化的伴看语气，在 40~60 秒内把上述核心内容讲给用户听。先用一句话点明主旨，再串讲 2~3 个最关键的看点；千万不要逐字朗读具体时间戳数字（可用“在视频前半段/中段”代替），讲完后可顺嘴问用户对哪部分感兴趣、是否需要跳过去看。";

export type VideoBackendTaskScope = "full" | "time_range" | "query";

export interface VideoBackendTaskOptions {
  taskId: string;
  objective: string;
  scope?: VideoBackendTaskScope;
  timeRange?: { startSec?: number; endSec?: number };
  context?: string[];
  signal: AbortSignal;
  onSilentProgress: (factText: string) => void;
  onSpokenResult: (spokenBriefing: string) => void;
  onTextProgress?: (markdown: string) => void;
  onError?: (errText: string) => void;
}

export interface VideoBackendTaskResult {
  taskId: string;
  source: "overview" | "text-model";
  rawText: string;
  detailText: string;
  spokenBriefing: string;
}

type RunOverviewAnalysisFn = typeof import("../ai/analysis.js").runOverviewAnalysis;

export interface VideoBackendTaskDeps {
  getClip?: () => Partial<ClipState>;
  resolveProvider?: () => Promise<AiProvider>;
  chatCompletion?: typeof chatCompletion;
  runOverviewAnalysis?: RunOverviewAnalysisFn;
}

interface PreparedTask {
  rawText: string;
  detailText: string;
  spokenCore: string;
  source: VideoBackendTaskResult["source"];
}

function unicodeLength(text: string): number {
  return Array.from(text).length;
}

function takeUnicode(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

function truncateUnicode(text: string, maxChars: number): string {
  if (unicodeLength(text) <= maxChars) return text;
  if (maxChars <= 0) return "";
  return `${takeUnicode(text, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function splitVideoBackendFacts(
  text: string,
  maxChars = VIDEO_BACKEND_INJECTION_MAX_CHARS,
  maxChunks = MAX_SILENT_CHUNKS
): string[] {
  const paragraphs = String(text || "").trim().split(/\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (let paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (unicodeLength(candidate) <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
      if (chunks.length >= maxChunks) return chunks;
    }
    while (unicodeLength(paragraph) > maxChars && chunks.length < maxChunks) {
      chunks.push(takeUnicode(paragraph, maxChars));
      paragraph = Array.from(paragraph).slice(maxChars).join("").trimStart();
    }
    if (chunks.length >= maxChunks) return chunks;
    current = paragraph;
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

export function stripMarkdownForBriefing(text: string): string {
  return String(text || "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildSpokenBriefing(text: string): string {
  const plainText = stripMarkdownForBriefing(text);
  const contentBudget = VIDEO_BACKEND_INJECTION_MAX_CHARS
    - unicodeLength(SPOKEN_PREFIX)
    - unicodeLength(SPOKEN_SUFFIX);
  return `${SPOKEN_PREFIX}${truncateUnicode(plainText, contentBudget)}${SPOKEN_SUFFIX}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw makeAbortedError();
}

function subtitleError(clip: Partial<ClipState>): Error | null {
  if (clip.subtitleFetchState === "loading") return new Error("当前视频字幕仍在加载，请稍后重试。");
  if (clip.subtitleFetchState === "error") return new Error("当前视频字幕加载失败，请先重试字幕加载。");
  return new Error("当前视频没有可用字幕，无法执行后台视频任务。");
}

function sliceSubtitleItems(
  items: ReadingSubtitleItem[],
  timeRange: VideoBackendTaskOptions["timeRange"]
): ReadingSubtitleItem[] {
  if (!timeRange) return items;
  const start = timeRange.startSec ?? 0;
  const end = timeRange.endSec ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(start) || start < 0 || Number.isNaN(end) || end <= start) {
    throw new Error("字幕时间范围无效：startSec 必须是非负有限数，endSec 必须大于 startSec。");
  }
  return items.filter((item) => {
    const itemEnd = item.to > item.from ? item.to : item.from + 2;
    return item.from <= end && itemEnd >= start;
  });
}

function overviewMarkdown(analysis: OverviewAnalysis): string {
  const sections = ["# 全片概览", analysis.summary.trim()];
  if (analysis.chapters.length > 0) {
    sections.push("## 分章节详细笔记");
    for (const chapter of analysis.chapters) {
      const time = formatClock(chapter.from, { hours: "auto" });
      sections.push(`### [${time}] ${chapter.title}\n${chapter.summary.trim()}`.trim());
    }
  }
  if (analysis.quotes.length > 0) {
    sections.push("## 关键原话");
    for (const quote of analysis.quotes) {
      const time = formatClock(quote.from, { hours: "auto" });
      sections.push(`- [${time}] ${quote.content.trim()}`);
    }
  }
  return sections.filter(Boolean).join("\n\n");
}

function overviewSpokenCore(analysis: OverviewAnalysis): string {
  const keyPoints = analysis.chapters
    .filter((chapter) => chapter.title || chapter.summary)
    .slice(0, 3)
    .map((chapter, index) => `${index + 1}. ${[chapter.title, chapter.summary].filter(Boolean).join("：")}`);
  return [analysis.summary.trim(), ...keyPoints].filter(Boolean).join("\n");
}

function hasTimestampedNotes(text: string): boolean {
  return /(?:^|\n)\s*#{1,6}\s+/.test(text) && /(?:\d{1,2}:)?\d{1,2}:\d{2}/.test(text);
}

function shouldUseFullOverview(options: VideoBackendTaskOptions): boolean {
  if (options.timeRange || options.scope === "time_range" || options.scope === "query") return false;
  if (options.scope === "full") return true;
  return /总结|概览|归纳|摘要|summar/i.test(options.objective);
}

async function runTextModelTask(
  options: VideoBackendTaskOptions,
  clip: Partial<ClipState>,
  items: ReadingSubtitleItem[],
  deps: Required<Pick<VideoBackendTaskDeps, "resolveProvider" | "chatCompletion">>
): Promise<PreparedTask> {
  const provider = await deps.resolveProvider();
  throwIfAborted(options.signal);
  const subtitleText = buildSubtitlePrompt({
    body: items,
    chapters: options.timeRange ? [] : clip.chapters,
    videoDuration: clip.videoDuration
  });
  const contextText = (options.context || []).map((item) => item.trim()).filter(Boolean).join("\n");
  const rangeText = options.timeRange
    ? `只分析 ${options.timeRange.startSec ?? 0} 秒到 ${options.timeRange.endSec === undefined ? "视频结束" : `${options.timeRange.endSec} 秒`}的字幕。`
    : "分析范围为当前视频全片字幕。";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是视频内容分析助手。只能依据给定字幕和对话上下文回答，不得编造视频中没有的信息。",
        "用简体中文先给核心结论，再补必要细节；需要定位或列举细节时，用带真实时间戳的 Markdown 分章节笔记。",
        contextText ? `近期对话上下文摘录：\n${contextText}` : ""
      ].filter(Boolean).join("\n\n")
    },
    {
      role: "user",
      content: `任务目标：${options.objective.trim()}\n${rangeText}\n\n视频标题：${String(clip.title || "未知")}\n\n${subtitleText}`
    }
  ];

  let text = "";
  await deps.chatCompletion({
    provider,
    messages,
    stream: true,
    signal: options.signal,
    thinkingLevel: "off",
    fetchImpl: providerFetchViaOffscreen,
    onEvent: (event) => {
      if (event.type !== "token") return;
      text += event.data;
      options.onTextProgress?.(text);
    },
    onStreamReset: () => {
      text = "";
      options.onTextProgress?.(text);
    }
  });
  throwIfAborted(options.signal);
  const rawText = text.trim();
  if (!rawText) throw new Error("文本模型没有返回可用内容，请重试。");
  return {
    rawText,
    detailText: hasTimestampedNotes(rawText) ? rawText : "",
    spokenCore: rawText,
    source: "text-model"
  };
}

async function runFullOverviewTask(
  options: VideoBackendTaskOptions,
  clip: Partial<ClipState>,
  items: ReadingSubtitleItem[],
  deps: Required<Pick<VideoBackendTaskDeps, "resolveProvider" | "runOverviewAnalysis">>
): Promise<PreparedTask> {
  const provider = await deps.resolveProvider();
  throwIfAborted(options.signal);
  const analysis = await deps.runOverviewAnalysis({
    provider,
    context: {
      ...clip,
      subtitleBody: items,
      videoDescription: String(clip.description || "")
    },
    signal: options.signal,
    thinkingLevel: "off"
  });
  throwIfAborted(options.signal);
  const spokenCore = overviewSpokenCore(analysis);
  if (!spokenCore) throw new Error("概览没有生成可播报的核心内容，请重试。");
  return {
    rawText: analysis.summary,
    detailText: analysis.chapters.length || analysis.quotes.length ? overviewMarkdown(analysis) : "",
    spokenCore,
    source: "overview"
  };
}

export async function runVideoBackendTask(
  options: VideoBackendTaskOptions,
  overrides: VideoBackendTaskDeps = {}
): Promise<VideoBackendTaskResult | null> {
  const deps = {
    getClip: overrides.getClip ?? (() => state.clip),
    resolveProvider: overrides.resolveProvider ?? resolveActiveProvider,
    chatCompletion: overrides.chatCompletion ?? chatCompletion,
    runOverviewAnalysis: overrides.runOverviewAnalysis ?? (async (args) => {
      const analysis = await import("../ai/analysis.js");
      return analysis.runOverviewAnalysis(args);
    }) as RunOverviewAnalysisFn
  };

  try {
    if (!options.taskId.trim()) throw new Error("后台视频任务缺少 taskId。");
    if (!options.objective.trim()) throw new Error("后台视频任务缺少 objective。");
    throwIfAborted(options.signal);
    const clip = deps.getClip();
    const allItems = getReadingSubtitleItems(clip.subtitleBody || []);
    if (allItems.length === 0) throw subtitleError(clip);
    const items = sliceSubtitleItems(allItems, options.timeRange);
    if (items.length === 0) throw new Error("指定时间范围内没有可用字幕。");

    const prepared = shouldUseFullOverview(options)
      ? await runFullOverviewTask(options, clip, items, deps)
      : await runTextModelTask(options, clip, items, deps);
    throwIfAborted(options.signal);

    for (const factText of splitVideoBackendFacts(prepared.detailText)) {
      throwIfAborted(options.signal);
      options.onSilentProgress(factText);
    }
    const spokenBriefing = buildSpokenBriefing(prepared.spokenCore);
    throwIfAborted(options.signal);
    options.onSpokenResult(spokenBriefing);
    return {
      taskId: options.taskId,
      source: prepared.source,
      rawText: prepared.rawText,
      detailText: prepared.detailText,
      spokenBriefing
    };
  } catch (error) {
    if (options.signal.aborted || isAbortedMarkerError(error) || isAbortNamedError(error)) return null;
    const errText = getErrorMessage(error, "后台视频任务失败");
    options.onError?.(errText);
    return null;
  }
}

export class VideoBackendTaskManager {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: VideoBackendTaskDeps = {}) {}

  registerTask(taskId: string, controller = new AbortController()): AbortController {
    this.cancelTask(taskId);
    this.controllers.set(taskId, controller);
    return controller;
  }

  async runTask(options: VideoBackendTaskOptions): Promise<VideoBackendTaskResult | null> {
    const controller = this.registerTask(options.taskId);
    const abortFromCaller = () => controller.abort(options.signal.reason);
    if (options.signal.aborted) {
      abortFromCaller();
    } else {
      options.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      return await runVideoBackendTask({ ...options, signal: controller.signal }, this.deps);
    } finally {
      options.signal.removeEventListener("abort", abortFromCaller);
      if (this.controllers.get(options.taskId) === controller) {
        this.controllers.delete(options.taskId);
      }
    }
  }

  cancelTask(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    this.controllers.delete(taskId);
    controller.abort();
    return true;
  }

  cancelAllTasks(): void {
    const controllers = Array.from(this.controllers.values());
    this.controllers.clear();
    for (const controller of controllers) controller.abort();
  }
}

export const videoBackendTaskManager = new VideoBackendTaskManager();
