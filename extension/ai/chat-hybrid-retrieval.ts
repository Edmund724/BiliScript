import { formatClock, parseClock, parseTimestampSeconds, shouldUseHoursForRange } from "../shared/clock-text.js";
import { isAbortedMarkerError, isAbortNamedError, makeAbortedError } from "../shared/error-helpers.js";
import { findNearestTimedLineIndex, truncateWithEllipsis } from "../shared/text-primitives.js";
import { MATERIAL_BUDGET_CHARS } from "./budgeter.js";
import { chatCompletion } from "./completion.js";
import { parseLooseJson, stripModelReasoningAndFences } from "./json-repair.js";
import {
  computeLocalTextSimilarity,
  createL0Bm25Index,
  expandAndMergeHitWindows,
  findLineIndexByLineNumber,
  findNearestLineIndexBySeconds,
  matchChapterByTitle,
  normalizeL0SubtitleLines,
  parseL0SecondsValue,
  type L0Bm25Index
} from "./l0-bm25.js";
import { findL1ChapterForTime, serializeL1DirectoryPrompt } from "./l1-directory.js";
import {
  LONG_VIDEO_DURATION_THRESHOLD_SECONDS,
  type ChatRetrievalDegradeReason,
  type DirectAnswerRoutePlan,
  type HybridSingleHopRoutePlan,
  type InteractionAnchorKind,
  type InteractionAnchorPoint,
  type InteractionAnchorRoutePlan,
  type L0ContextWindow,
  type L0LexicalSearchResult,
  type L0SubtitleLine,
  type L1ChapterNode,
  type L1VideoIndexCacheRecord,
  type RetrievalTimeRange
} from "./long-video-hybrid-types.js";
import type { ChatMessage, ProviderRequest } from "./types.js";

export const DEFAULT_ROUTER_TIMEOUT_MS = 10_000;
export const ROUTER_MAX_TOKENS = 256;
export const MAX_ROUTED_CHAPTER_RANGES = 2;
export const MAX_ROUTED_TERMS = 6;
export const FAST_PATH_WINDOW_RADIUS_LINES = 8;
export const FAST_PATH_WINDOW_RADIUS_SECONDS = 30;
export const HYBRID_BM25_TOP_K = 6;
export const HYBRID_BM25_RADIUS_LINES = 4;
export const HYBRID_BM25_RADIUS_SECONDS = 15;
export const HYBRID_BM25_MAX_CHARS = 40_000;
export const ROUTED_RANGE_MAX_CHARS = 40_000;
export const STAGE_B_TOTAL_SUBTITLE_MAX_CHARS = 80_000;

const SIMPLE_GREETING_RE =
  /^(?:你好|您好|嗨|哈喽|早上好|中午好|晚上好|早安|晚安|谢谢|感谢|多谢|好的|好哒|行|收到|明白|了解|知道了|再见|拜拜|在吗|你是谁|你能做什么|帮我看看|hi+|hello+|hey+|thanks?|thank you|ok+|okay|bye)[!！。.~～？?、，,\s]*$/i;

const MACRO_SUMMARY_INTENT_RE =
  /(总结(?:一下)?(?:这期|整[期个部篇]|全片|视频)|全片(?:概要|大意|脉络|总结)|整体(?:内容|脉络|框架|结构)|一共(?:有)?几(?:个|部分|章)|全篇目录|视频大纲)/;

const EXPLICIT_CHAPTER_REF_RE = /第\s*[一二三四五六七八九十百\d]+\s*[章节部分节]/;

const PLAYBACK_DEICTIC_RE =
  /(当前|现在|此时|此刻|这里|这儿|这边|刚才|刚刚|方才|这一[段句幕节帧步块]|这段|这句|刚讲|刚说|看到这|听到这|播放到|进度|下面这段|前面一点)/;

const VISUAL_DEICTIC_RE =
  /(画面|截图|截帧|看下|看看|长什么样|板书|黑板|白板|PPT|幻灯片|图表|曲线|柱状图|折线图|表格|公式|代码|报错|界面|UI|演示|操作界面|步骤图|屏幕|图里|图中|写的什么|画的什么|显示什么|怎么写的|哪一行)/i;

export interface InteractionAnchorHint {
  kind: "explain-selection";
  from: number;
  lineContent?: string;
  selection?: string;
}

export interface LongVideoChatContextInput {
  title?: unknown;
  bvid?: unknown;
  cid?: unknown;
  videoDuration?: unknown;
  chapters?: unknown[];
  subtitleBody?: unknown[];
  l1Index?: L1VideoIndexCacheRecord | null;
  [key: string]: unknown;
}

export function isSimpleGreetingPrompt(prompt: unknown): boolean {
  const text = String(prompt ?? "").trim();
  if (!text || text.length > 28) {
    return false;
  }
  return SIMPLE_GREETING_RE.test(text);
}

export function doesPromptNeedVisualFrame(prompt: unknown): boolean {
  const text = String(prompt ?? "").trim();
  if (!text) {
    return false;
  }
  return VISUAL_DEICTIC_RE.test(text);
}

export function isLongVideoForHybridChat(
  l0Lines: readonly L0SubtitleLine[],
  context?: LongVideoChatContextInput | null
): boolean {
  if (l0Lines.length === 0) {
    return false;
  }
  const totalChars = l0Lines.reduce((sum, line) => sum + line.content.length, 0);
  if (totalChars > MATERIAL_BUDGET_CHARS) {
    return true;
  }
  const firstFrom = Math.max(0, l0Lines[0].from);
  const lastTo = Math.max(firstFrom, l0Lines[l0Lines.length - 1].to);
  const spanSeconds = Math.floor(lastTo - firstFrom);
  if (spanSeconds > LONG_VIDEO_DURATION_THRESHOLD_SECONDS) {
    return true;
  }
  const duration = Number(context?.videoDuration);
  return Number.isFinite(duration) && duration > LONG_VIDEO_DURATION_THRESHOLD_SECONDS;
}

function shouldUsePlaybackCursorAnchor(
  userPrompt: string,
  playbackCursorSeconds: unknown,
  chapters: readonly { title?: unknown; from?: unknown; to?: unknown }[]
): playbackCursorSeconds is number {
  if (typeof playbackCursorSeconds !== "number" || !Number.isFinite(playbackCursorSeconds) || playbackCursorSeconds < 0) {
    return false;
  }
  const prompt = String(userPrompt || "").trim();
  if (!prompt || isSimpleGreetingPrompt(prompt)) {
    return false;
  }
  if (MACRO_SUMMARY_INTENT_RE.test(prompt)) {
    return false;
  }
  if (EXPLICIT_CHAPTER_REF_RE.test(prompt) || matchChapterByTitle(prompt, [...chapters]).length > 0) {
    return false;
  }
  return PLAYBACK_DEICTIC_RE.test(prompt) || VISUAL_DEICTIC_RE.test(prompt);
}

export function detectInteractionAnchorPlan(input: {
  userPrompt: string;
  interactionAnchor?: InteractionAnchorHint | null;
  playbackCursorSeconds?: number;
  chapters?: readonly { title?: unknown; from?: unknown; to?: unknown }[];
  l1Chapters?: readonly L1ChapterNode[];
}): InteractionAnchorRoutePlan | null {
  const { userPrompt, interactionAnchor, playbackCursorSeconds, chapters = [], l1Chapters = [] } = input;

  if (interactionAnchor && interactionAnchor.kind === "explain-selection") {
    const from = Number(interactionAnchor.from);
    if (Number.isFinite(from) && from >= 0) {
      return {
        mode: "interaction-anchor",
        anchorKind: "explain-selection",
        reason: "划词解释交互锚点直通",
        anchors: [
          {
            from,
            ...(interactionAnchor.lineContent ? { lineContent: String(interactionAnchor.lineContent) } : {}),
            ...(interactionAnchor.selection ? { selection: String(interactionAnchor.selection) } : {})
          }
        ],
        windowRadiusLines: FAST_PATH_WINDOW_RADIUS_LINES,
        maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS,
        fallbackPolicy: "full-l0-bm25"
      };
    }
  }

  const timestamps = parseTimestampSeconds(userPrompt);
  if (timestamps.length > 0) {
    return {
      mode: "interaction-anchor",
      anchorKind: "timestamp",
      reason: "显式时间戳锚点直通",
      anchors: timestamps.slice(0, 4).map((from) => ({ from })),
      windowRadiusLines: FAST_PATH_WINDOW_RADIUS_LINES,
      maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS,
      fallbackPolicy: "full-l0-bm25"
    };
  }

  const chapterList = l1Chapters.length > 0 ? l1Chapters : chapters;
  if (shouldUsePlaybackCursorAnchor(userPrompt, playbackCursorSeconds, chapterList)) {
    return {
      mode: "interaction-anchor",
      anchorKind: "playback-cursor",
      reason: "当前播放进度锚点直通",
      anchors: [{ from: playbackCursorSeconds }],
      windowRadiusLines: FAST_PATH_WINDOW_RADIUS_LINES,
      maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS,
      fallbackPolicy: "full-l0-bm25"
    };
  }

  return null;
}

function findLineIndexForAnchor(
  lines: readonly L0SubtitleLine[],
  anchor: InteractionAnchorPoint
): number {
  if (lines.length === 0) {
    return -1;
  }
  if (typeof anchor.lineNumber === "number" && Number.isInteger(anchor.lineNumber) && anchor.lineNumber >= 0) {
    const byLineNumber = findLineIndexByLineNumber(lines, anchor.lineNumber);
    if (byLineNumber >= 0) {
      return byLineNumber;
    }
  }

  const targetSec = Math.max(0, Number(anchor.from) || 0);
  if (anchor.lineContent) {
    const lineContent = anchor.lineContent;
    const bestIdx = findNearestTimedLineIndex(lines, targetSec, {
      maxTimeDistanceSeconds: 20,
      scoreLine: (line, dist) => computeLocalTextSimilarity(lineContent, line.content) * 100 - dist * 0.5
    });
    if (bestIdx >= 0) {
      return bestIdx;
    }
  }

  return findNearestLineIndexBySeconds(lines, targetSec);
}

function formatChapterHeaderSummary(
  chapter: L1ChapterNode | { title?: unknown; from?: unknown; to?: unknown; coreThesis?: unknown; keyEntities?: readonly string[] },
  withHours: boolean
): string {
  const from = Math.max(0, Number(chapter.from) || 0);
  const to = Math.max(from, Number(chapter.to) || from);
  const title = String(chapter.title || "").trim() || "未命名章节";
  const range = `[${formatClock(from, { hours: withHours })}-${formatClock(to, { hours: withHours })}]`;
  const parts = [`- ${range} ${title}`];
  const coreThesis = String((chapter as L1ChapterNode).coreThesis || "").trim();
  if (coreThesis) {
    parts.push(`核心要点：${coreThesis}`);
  }
  const entities = (chapter as L1ChapterNode).keyEntities;
  if (Array.isArray(entities) && entities.length > 0) {
    parts.push(`关键词：${entities.slice(0, 5).join("、")}`);
  }
  return parts.join(" | ");
}

function renderWindowsMarkdown(
  windows: readonly L0ContextWindow[],
  anchorLineNumbers?: ReadonlySet<number>,
  videoDuration = 0
): string {
  if (windows.length === 0) {
    return "";
  }
  const maxEnd = Math.max(
    Number(videoDuration) || 0,
    windows[windows.length - 1]?.to || 0
  );
  const withHours = shouldUseHoursForRange(0, maxEnd);
  return windows
    .map((win) => {
      const rangeHeader = `### [${formatClock(win.from, { hours: withHours })}-${formatClock(win.to, { hours: withHours })}]`;
      const bodyLines = win.lines.map((line) => {
        const mark = anchorLineNumbers?.has(line.lineNumber) ? "→ " : "";
        return `${mark}[${formatClock(line.from, { hours: withHours })}] ${line.content}`;
      });
      return `${rangeHeader}\n${bodyLines.join("\n")}`;
    })
    .join("\n\n");
}

function clampWindowsToBudget(
  allLines: readonly L0SubtitleLine[],
  spans: ReadonlyArray<{ startIdx: number; endIdx: number; anchorLineNumber: number }>,
  maxInjectedChars: number
): { windows: L0ContextWindow[]; injectedChars: number; truncated: boolean } {
  const windows: L0ContextWindow[] = [];
  let injectedChars = 0;
  let truncated = false;

  for (const span of spans) {
    const slice = allLines.slice(span.startIdx, span.endIdx + 1);
    if (slice.length === 0) {
      continue;
    }
    const spanChars = slice.reduce((sum, item) => sum + item.content.length, 0);
    if (injectedChars + spanChars <= maxInjectedChars) {
      windows.push({
        anchorLineNumber: span.anchorLineNumber,
        startLineNumber: slice[0].lineNumber,
        endLineNumber: slice[slice.length - 1].lineNumber,
        from: slice[0].from,
        to: slice[slice.length - 1].to,
        lines: slice
      });
      injectedChars += spanChars;
      continue;
    }

    const keptLines: L0SubtitleLine[] = [];
    for (const line of slice) {
      if (injectedChars + line.content.length <= maxInjectedChars || windows.length === 0 && keptLines.length === 0) {
        keptLines.push(line);
        injectedChars += line.content.length;
      } else {
        truncated = true;
        break;
      }
    }
    if (keptLines.length > 0) {
      windows.push({
        anchorLineNumber: span.anchorLineNumber,
        startLineNumber: keptLines[0].lineNumber,
        endLineNumber: keptLines[keptLines.length - 1].lineNumber,
        from: keptLines[0].from,
        to: keptLines[keptLines.length - 1].to,
        lines: keptLines
      });
    }
    truncated = true;
    break;
  }

  return { windows, injectedChars, truncated };
}

export function mergeL0ContextWindows(
  allLines: readonly L0SubtitleLine[],
  windowGroups: ReadonlyArray<readonly L0ContextWindow[]>,
  options: { mergeGapSeconds?: number; maxInjectedChars?: number } = {}
): { windows: L0ContextWindow[]; injectedChars: number; truncated: boolean } {
  if (!Array.isArray(allLines) || allLines.length === 0) {
    return { windows: [], injectedChars: 0, truncated: false };
  }
  const mergeGapSeconds =
    options.mergeGapSeconds !== undefined && Number.isFinite(Number(options.mergeGapSeconds))
      ? Math.max(0, Number(options.mergeGapSeconds))
      : 1;
  const maxInjectedChars =
    options.maxInjectedChars !== undefined && Number(options.maxInjectedChars) > 0
      ? Math.floor(Number(options.maxInjectedChars))
      : STAGE_B_TOTAL_SUBTITLE_MAX_CHARS;

  const lineIndexByNumber = new Map<number, number>();
  for (let i = 0; i < allLines.length; i += 1) {
    lineIndexByNumber.set(allLines[i].lineNumber, i);
  }

  const rawSpans: Array<{ startIdx: number; endIdx: number; anchorLineNumber: number }> = [];
  for (const group of windowGroups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const win of group) {
      if (!win || !Array.isArray(win.lines) || win.lines.length === 0) {
        continue;
      }
      const startIdx = lineIndexByNumber.get(win.startLineNumber) ?? lineIndexByNumber.get(win.lines[0].lineNumber);
      const endIdx = lineIndexByNumber.get(win.endLineNumber) ?? lineIndexByNumber.get(win.lines[win.lines.length - 1].lineNumber);
      if (startIdx === undefined || endIdx === undefined || endIdx < startIdx) {
        continue;
      }
      rawSpans.push({
        startIdx,
        endIdx,
        anchorLineNumber: win.anchorLineNumber
      });
    }
  }

  if (rawSpans.length === 0) {
    return { windows: [], injectedChars: 0, truncated: false };
  }

  rawSpans.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
  const mergedSpans: Array<{ startIdx: number; endIdx: number; anchorLineNumber: number }> = [{ ...rawSpans[0] }];
  for (let i = 1; i < rawSpans.length; i += 1) {
    const next = rawSpans[i];
    const current = mergedSpans[mergedSpans.length - 1];
    const adjacentOrOverlap = next.startIdx <= current.endIdx + 1;
    const touchesByTime = allLines[next.startIdx].from <= allLines[current.endIdx].to + mergeGapSeconds;
    if (adjacentOrOverlap || touchesByTime) {
      current.endIdx = Math.max(current.endIdx, next.endIdx);
    } else {
      mergedSpans.push({ ...next });
    }
  }

  return clampWindowsToBudget(allLines, mergedSpans, maxInjectedChars);
}

export interface FastPathResolutionResult {
  plan: InteractionAnchorRoutePlan;
  windows: L0ContextWindow[];
  injectedChars: number;
  coreTimestamp: number;
  hybridRetrievalMarkdown: string;
}

export function buildFastPathContext(input: {
  allLines: readonly L0SubtitleLine[];
  plan: InteractionAnchorRoutePlan;
  l1Index?: L1VideoIndexCacheRecord | null;
  fallbackChapters?: readonly { title?: unknown; from?: unknown; to?: unknown }[];
  videoDuration?: number;
}): FastPathResolutionResult {
  const { allLines, plan, l1Index, fallbackChapters = [], videoDuration = 0 } = input;
  const resolvedAnchors = plan.anchors.map((anchor) => {
    const idx = findLineIndexForAnchor(allLines, anchor);
    const matchedLine = idx >= 0 ? allLines[idx] : undefined;
    return {
      anchor,
      lineNumber: matchedLine ? matchedLine.lineNumber : 0,
      from: matchedLine ? matchedLine.from : anchor.from
    };
  });

  const windows = expandAndMergeHitWindows(
    allLines,
    resolvedAnchors.map((item) => ({ lineNumber: item.lineNumber, score: 1 })),
    {
      windowRadiusLines: plan.windowRadiusLines || FAST_PATH_WINDOW_RADIUS_LINES,
      windowRadiusSeconds: FAST_PATH_WINDOW_RADIUS_SECONDS,
      mergeGapSeconds: 2
    }
  );
  const capped = mergeL0ContextWindows(allLines, [windows], {
    maxInjectedChars: plan.maxInjectedChars || STAGE_B_TOTAL_SUBTITLE_MAX_CHARS
  });

  const maxEnd = Math.max(
    Number(videoDuration) || 0,
    Number(l1Index?.videoDuration) || 0,
    allLines.length > 0 ? allLines[allLines.length - 1].to : 0
  );
  const withHours = shouldUseHoursForRange(0, maxEnd);
  const sections: string[] = [];

  if (l1Index?.globalSummary) {
    sections.push(`## 全片简介\n${l1Index.globalSummary}`);
  }

  const ownerChapterLines: string[] = [];
  const seenChapters = new Set<string>();
  const l1Chapters = l1Index?.chapters ?? [];
  for (const item of resolvedAnchors) {
    const owner =
      l1Chapters.length > 0
        ? findL1ChapterForTime(l1Chapters, item.anchor.from)
        : findFallbackChapterForTime(fallbackChapters, item.anchor.from);
    if (!owner) {
      continue;
    }
    const key = `${owner.from}:${owner.title}`;
    if (seenChapters.has(key)) {
      continue;
    }
    seenChapters.add(key);
    ownerChapterLines.push(formatChapterHeaderSummary(owner, withHours));
  }
  if (ownerChapterLines.length > 0) {
    sections.push(`## 锚点所属章节摘要\n${ownerChapterLines.join("\n")}`);
  }

  const anchorSet = new Set<number>(resolvedAnchors.map((a) => a.lineNumber));
  const renderedWindows = renderWindowsMarkdown(capped.windows, anchorSet, maxEnd);
  if (renderedWindows) {
    const anchorLabels = resolvedAnchors
      .map((a) => {
        const clock = formatClock(a.anchor.from, { hours: withHours });
        if (a.anchor.selection) {
          return `${clock}（划词：「${a.anchor.selection}」）`;
        }
        return clock;
      })
      .join("、");
    sections.push(`## 锚点附近原始字幕（焦点：${anchorLabels}，→ 标记锚点所在句）\n\n${renderedWindows}`);
  }

  return {
    plan,
    windows: capped.windows,
    injectedChars: capped.injectedChars,
    coreTimestamp: plan.anchors[0]?.from ?? resolvedAnchors[0]?.from ?? 0,
    hybridRetrievalMarkdown: sections.join("\n\n")
  };
}

function findFallbackChapterForTime(
  chapters: readonly { title?: unknown; from?: unknown; to?: unknown }[],
  seconds: number
): { title: string; from: number; to: number } | null {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return null;
  }
  const normalized = chapters
    .map((ch) => ({
      title: String(ch?.title ?? "").trim(),
      from: Number(ch?.from),
      to: Number(ch?.to)
    }))
    .filter((ch) => ch.title && Number.isFinite(ch.from) && ch.from >= 0)
    .sort((a, b) => a.from - b.from);
  if (normalized.length === 0) {
    return null;
  }
  let owner = normalized[0];
  for (const ch of normalized) {
    if (ch.from <= seconds) {
      owner = ch;
    } else {
      break;
    }
  }
  return {
    title: owner.title,
    from: owner.from,
    to: Number.isFinite(owner.to) && owner.to > owner.from ? owner.to : owner.from
  };
}

const L1_ROUTER_SYSTEM_PROMPT = [
  "你是长视频问答的章节路由器。阅读下方 L1 章节目录和用户问题，仅输出一个 JSON 对象（禁止输出思考过程、Markdown 解释或多余文字）。",
  "规则：",
  "1. 若问题属于宏观概览、全局主题或无需查看具体字幕细节即可基于目录回答，输出：",
  '   {"mode":"direct-answer","ranges":[],"terms":[]}',
  "2. 若问题需要具体细节、数据、例子或某段内容，从目录中挑选最多 1~2 个最相关的章节时间区间，并给出 0~5 个补充检索词，输出：",
  '   {"mode":"expand","ranges":[{"from":"MM:SS","to":"MM:SS"}],"terms":["关键词1","关键词2"]}',
  "3. 时间戳沿用目录里的格式；不确定时优先选最相关的 1~2 个章节。"
].join("\n");

function buildRecentTurnHint(history: readonly ChatMessage[]): string {
  if (!Array.isArray(history) || history.length === 0) {
    return "";
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg?.role === "user" && typeof msg.content === "string" && msg.content.trim()) {
      return truncateWithEllipsis(msg.content, 140, { singleLine: true });
    }
  }
  return "";
}

export function buildL1RouterMessages(input: {
  l1DirectoryPrompt: string;
  userPrompt: string;
  history?: readonly ChatMessage[];
}): ChatMessage[] {
  const recentHint = buildRecentTurnHint(input.history ?? []);
  const userLines = [`L1 章节目录：\n${input.l1DirectoryPrompt}`];
  if (recentHint) {
    userLines.push(`上一轮用户问题参考：${recentHint}`);
  }
  userLines.push(`当前用户问题：${input.userPrompt}`);
  return [
    { role: "system", content: L1_ROUTER_SYSTEM_PROMPT },
    { role: "user", content: userLines.join("\n\n") }
  ];
}

function resolveRangeFromRouterItem(
  rawItem: unknown,
  l1Index: L1VideoIndexCacheRecord
): RetrievalTimeRange | null {
  const chapters = l1Index.chapters;
  const maxDuration = Math.max(
    l1Index.videoDuration || 0,
    chapters.length > 0 ? chapters[chapters.length - 1].to : 0
  );

  if (typeof rawItem === "number" && Number.isInteger(rawItem)) {
    const ch = chapters.find((c) => c.chapterIndex === rawItem) ?? chapters[rawItem];
    if (ch) {
      return { from: ch.from, to: ch.to, chapterIndex: ch.chapterIndex, title: ch.title };
    }
    return null;
  }

  if (typeof rawItem === "string") {
    const rangeMatch = rawItem.trim().match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~～到]\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (rangeMatch) {
      const from = parseClock(rangeMatch[1]);
      const to = parseClock(rangeMatch[2]);
      if (from !== null && to !== null && to > from) {
        return { from, to };
      }
    }
    const chByTitle = chapters.find((c) => c.title.includes(rawItem.trim()) || rawItem.trim().includes(c.title));
    if (chByTitle) {
      return { from: chByTitle.from, to: chByTitle.to, chapterIndex: chByTitle.chapterIndex, title: chByTitle.title };
    }
    return null;
  }

  if (!rawItem || typeof rawItem !== "object") {
    return null;
  }

  const obj = rawItem as Record<string, unknown>;
  const idxCandidate = obj.chapterIndex ?? obj.index ?? obj.chapter;
  if (typeof idxCandidate === "number" && Number.isInteger(idxCandidate)) {
    const ch = chapters.find((c) => c.chapterIndex === idxCandidate) ?? chapters[idxCandidate];
    if (ch) {
      return { from: ch.from, to: ch.to, chapterIndex: ch.chapterIndex, title: ch.title };
    }
  }

  const from =
    parseL0SecondsValue(obj.from ?? obj.start ?? obj.startTime ?? obj.fromSeconds ?? obj.startSeconds);
  const to =
    parseL0SecondsValue(obj.to ?? obj.end ?? obj.endTime ?? obj.toSeconds ?? obj.endSeconds);
  if (from !== null) {
    const owner = findL1ChapterForTime(chapters, from);
    const resolvedTo =
      to !== null && to > from
        ? to
        : owner && owner.to > from
          ? owner.to
          : Math.min(maxDuration > from ? maxDuration : from + 180, from + 180);
    return {
      from,
      to: resolvedTo,
      ...(owner ? { chapterIndex: owner.chapterIndex, title: owner.title } : {})
    };
  }

  const title = String(obj.title ?? "").trim();
  if (title) {
    const matched = chapters.find((c) => c.title.includes(title) || title.includes(c.title));
    if (matched) {
      return { from: matched.from, to: matched.to, chapterIndex: matched.chapterIndex, title: matched.title };
    }
  }

  return null;
}

function parseRouterTerms(rawTerms: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(rawTerms)) {
    list = rawTerms;
  } else if (typeof rawTerms === "string") {
    list = rawTerms.split(/[,，、;；/|]+/);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const clean = String(item ?? "").trim();
    if (!clean || clean.length > 40 || seen.has(clean.toLowerCase())) {
      continue;
    }
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= MAX_ROUTED_TERMS) {
      break;
    }
  }
  return out;
}

export type ParsedL1RouteResult =
  | { ok: true; plan: DirectAnswerRoutePlan }
  | { ok: true; plan: HybridSingleHopRoutePlan }
  | { ok: false; reason: "router-invalid-output" };

export function parseL1RouterOutput(
  rawText: unknown,
  l1Index: L1VideoIndexCacheRecord
): ParsedL1RouteResult {
  const cleaned = stripModelReasoningAndFences(rawText);
  if (!cleaned) {
    return { ok: false, reason: "router-invalid-output" };
  }

  let parsed: unknown;
  try {
    parsed = parseLooseJson(cleaned);
  } catch {
    return { ok: false, reason: "router-invalid-output" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "router-invalid-output" };
  }

  const obj = parsed as Record<string, unknown>;
  const modeToken = String(obj.mode ?? obj.action ?? obj.decision ?? obj.type ?? "").trim().toLowerCase();
  const explicitNoExpand = obj.needsExpand === false || obj.expand === false;

  const rawRangesList =
    obj.ranges ?? obj.chapterRanges ?? obj.timeRanges ?? obj.chapters ?? obj.sections ?? obj.intervals;
  const ranges: RetrievalTimeRange[] = [];
  if (Array.isArray(rawRangesList)) {
    for (const item of rawRangesList) {
      const resolved = resolveRangeFromRouterItem(item, l1Index);
      if (resolved && resolved.to > resolved.from) {
        ranges.push(resolved);
        if (ranges.length >= MAX_ROUTED_CHAPTER_RANGES) {
          break;
        }
      }
    }
  }

  const terms = parseRouterTerms(obj.terms ?? obj.keywords ?? obj.lexicalTerms ?? obj.queries ?? obj.entities);

  const isDirectMode =
    modeToken === "direct-answer" ||
    modeToken === "direct" ||
    modeToken === "macro" ||
    modeToken === "overview" ||
    modeToken === "no-expand" ||
    modeToken === "skip" ||
    explicitNoExpand;

  if (isDirectMode && ranges.length === 0) {
    return {
      ok: true,
      plan: {
        mode: "direct-answer",
        reason: "L1 目录路由判定宏观/直答问题无需展开 L0",
        includeL1Outline: true,
        includeGlobalSummary: true,
        includeCompressedSummary: true
      }
    };
  }

  if (ranges.length > 0 || terms.length > 0) {
    return {
      ok: true,
      plan: {
        mode: "hybrid-single-hop",
        reason: "L1 目录路由选定展开章节与补充检索词",
        chapterRanges: ranges,
        lexicalTerms: terms,
        maxHits: HYBRID_BM25_TOP_K,
        windowRadiusLines: HYBRID_BM25_RADIUS_LINES,
        maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS,
        fallbackPolicy: "full-l0-bm25"
      }
    };
  }

  if (modeToken === "expand") {
    return { ok: false, reason: "router-invalid-output" };
  }

  return { ok: false, reason: "router-invalid-output" };
}

function extractLinesWindowForRange(
  allLines: readonly L0SubtitleLine[],
  range: RetrievalTimeRange,
  maxChars: number
): L0ContextWindow | null {
  const inRange: L0SubtitleLine[] = [];
  let chars = 0;
  for (const line of allLines) {
    if (line.to >= range.from && line.from <= range.to) {
      if (chars + line.content.length <= maxChars || inRange.length === 0) {
        inRange.push(line);
        chars += line.content.length;
      } else {
        break;
      }
    }
  }
  if (inRange.length === 0) {
    return null;
  }
  return {
    anchorLineNumber: inRange[0].lineNumber,
    startLineNumber: inRange[0].lineNumber,
    endLineNumber: inRange[inRange.length - 1].lineNumber,
    from: inRange[0].from,
    to: inRange[inRange.length - 1].to,
    lines: inRange
  };
}

function collectRoutedRangeWindows(input: {
  allLines: readonly L0SubtitleLine[];
  bm25Index: L0Bm25Index;
  l1Index: L1VideoIndexCacheRecord;
  plan: HybridSingleHopRoutePlan;
  userPrompt: string;
}): { windows: L0ContextWindow[]; topHitTimestamp?: number } {
  const { allLines, bm25Index, l1Index, plan, userPrompt } = input;
  const ranges = plan.chapterRanges;
  if (ranges.length === 0) {
    if (plan.lexicalTerms.length === 0) {
      return { windows: [] };
    }
    const termSearch = bm25Index.search({
      query: userPrompt,
      terms: plan.lexicalTerms,
      topK: HYBRID_BM25_TOP_K,
      windowRadiusLines: HYBRID_BM25_RADIUS_LINES,
      windowRadiusSeconds: HYBRID_BM25_RADIUS_SECONDS,
      maxInjectedChars: ROUTED_RANGE_MAX_CHARS
    });
    return {
      windows: [...(termSearch.windows ?? [])],
      topHitTimestamp: termSearch.hits[0]?.line.from
    };
  }

  let rangeTotalChars = 0;
  for (const line of allLines) {
    if (ranges.some((r) => line.to >= r.from && line.from <= r.to)) {
      rangeTotalChars += line.content.length;
    }
  }

  if (rangeTotalChars > 0 && rangeTotalChars <= ROUTED_RANGE_MAX_CHARS) {
    const directWindows: L0ContextWindow[] = [];
    for (const r of ranges) {
      const win = extractLinesWindowForRange(allLines, r, ROUTED_RANGE_MAX_CHARS);
      if (win) {
        directWindows.push(win);
      }
    }
    const scoped = bm25Index.search({
      query: userPrompt,
      terms: plan.lexicalTerms,
      timeRanges: ranges,
      topK: 3,
      windowRadiusLines: 0
    });
    return {
      windows: directWindows,
      topHitTimestamp: scoped.hits[0]?.line.from ?? directWindows[0]?.from
    };
  }

  const chapterEntities: string[] = [];
  for (const r of ranges) {
    const ch =
      r.chapterIndex !== undefined
        ? l1Index.chapters.find((c) => c.chapterIndex === r.chapterIndex)
        : findL1ChapterForTime(l1Index.chapters, r.from);
    if (ch?.keyEntities?.length) {
      chapterEntities.push(...ch.keyEntities.slice(0, 4));
    }
  }

  const scopedSearch = bm25Index.search({
    query: userPrompt,
    terms: [...plan.lexicalTerms, ...chapterEntities],
    timeRanges: ranges,
    topK: HYBRID_BM25_TOP_K,
    windowRadiusLines: HYBRID_BM25_RADIUS_LINES,
    windowRadiusSeconds: HYBRID_BM25_RADIUS_SECONDS,
    maxInjectedChars: ROUTED_RANGE_MAX_CHARS
  });

  if (scopedSearch.windows && scopedSearch.windows.length > 0) {
    return {
      windows: [...scopedSearch.windows],
      topHitTimestamp: scopedSearch.hits[0]?.line.from
    };
  }

  const perRangeCap = Math.max(2000, Math.floor(ROUTED_RANGE_MAX_CHARS / ranges.length));
  const fallbackWindows: L0ContextWindow[] = [];
  for (const r of ranges) {
    const win = extractLinesWindowForRange(allLines, r, perRangeCap);
    if (win) {
      fallbackWindows.push(win);
    }
  }
  return {
    windows: fallbackWindows,
    topHitTimestamp: fallbackWindows[0]?.from
  };
}

export type HybridChatMode = "interaction-anchor" | "direct-answer" | "hybrid-single-hop" | "degraded-bm25";

export interface ResolveLongVideoHybridContextInput {
  context: LongVideoChatContextInput;
  userPrompt: string;
  history?: readonly ChatMessage[];
  l1Index?: L1VideoIndexCacheRecord | null;
  compressedSummaryMarkdown?: string;
  interactionAnchor?: InteractionAnchorHint | null;
  playbackCursorSeconds?: number;
  provider?: ProviderRequest;
  signal?: AbortSignal | null;
  routeChatCompletion?: typeof chatCompletion;
  routerTimeoutMs?: number;
}

export interface LongVideoHybridResolution {
  mode: HybridChatMode;
  anchorKind?: InteractionAnchorKind;
  hybridRetrievalMarkdown: string;
  windows: readonly L0ContextWindow[];
  injectedChars: number;
  degraded: boolean;
  degradeReason?: ChatRetrievalDegradeReason | "router-timeout" | "router-rate-limited" | "router-error" | "router-invalid-output";
  coreTimestamp?: number;
}

function classifyRouterErrorReason(error: unknown): "router-timeout" | "router-rate-limited" | "router-error" {
  const status = (error as { status?: unknown } | null)?.status;
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  if (status === 429 || /\b429\b|rate[- ]?limit|too many requests|限流|频控/i.test(msg)) {
    return "router-rate-limited";
  }
  if (isAbortNamedError(error) || /timeout|timed out|超时/i.test(msg)) {
    return "router-timeout";
  }
  return "router-error";
}

function buildHybridMarkdown(input: {
  l1DirectoryPrompt: string;
  compressedSummaryMarkdown: string;
  windows: readonly L0ContextWindow[];
  videoDuration: number;
  noteText?: string;
}): string {
  const sections: string[] = [];
  if (input.l1DirectoryPrompt) {
    sections.push(`## 视频 L1 章节目录\n${input.l1DirectoryPrompt}`);
  }
  if (input.compressedSummaryMarkdown) {
    const maxCompressed = input.windows.length > 0 ? 18_000 : 40_000;
    const summaryBlock =
      input.compressedSummaryMarkdown.length > maxCompressed
        ? `${input.compressedSummaryMarkdown.slice(0, maxCompressed)}\n…（摘要已按预算截断）`
        : input.compressedSummaryMarkdown;
    sections.push(`## 已有整理摘要\n${summaryBlock}`);
  }
  const renderedWindows = renderWindowsMarkdown(input.windows, undefined, input.videoDuration);
  if (renderedWindows) {
    sections.push(`## 召回的原始字幕片段（按时间顺序去重合并）\n\n${renderedWindows}`);
  } else if (input.noteText) {
    sections.push(input.noteText);
  }
  return sections.join("\n\n");
}

export async function resolveLongVideoHybridContext(
  input: ResolveLongVideoHybridContextInput
): Promise<LongVideoHybridResolution> {
  const {
    context,
    userPrompt,
    history = [],
    l1Index = context.l1Index ?? null,
    compressedSummaryMarkdown = "",
    interactionAnchor = null,
    playbackCursorSeconds,
    provider,
    signal = null,
    routeChatCompletion = chatCompletion,
    routerTimeoutMs = DEFAULT_ROUTER_TIMEOUT_MS
  } = input;

  const l0Lines = normalizeL0SubtitleLines(context.subtitleBody as Array<{ from?: unknown; to?: unknown; content?: unknown }>);
  const videoDuration = Math.max(
    Number(context.videoDuration) || 0,
    Number(l1Index?.videoDuration) || 0,
    l0Lines.length > 0 ? Math.ceil(l0Lines[l0Lines.length - 1].to) : 0
  );

  const fastPathPlan = detectInteractionAnchorPlan({
    userPrompt,
    interactionAnchor,
    playbackCursorSeconds,
    chapters: Array.isArray(context.chapters) ? (context.chapters as Array<{ title?: unknown; from?: unknown; to?: unknown }>) : [],
    l1Chapters: l1Index?.chapters
  });
  if (fastPathPlan) {
    const fast = buildFastPathContext({
      allLines: l0Lines,
      plan: fastPathPlan,
      l1Index,
      fallbackChapters: Array.isArray(context.chapters) ? (context.chapters as Array<{ title?: unknown; from?: unknown; to?: unknown }>) : [],
      videoDuration
    });
    return {
      mode: "interaction-anchor",
      anchorKind: fastPathPlan.anchorKind,
      hybridRetrievalMarkdown: fast.hybridRetrievalMarkdown,
      windows: fast.windows,
      injectedChars: fast.injectedChars,
      degraded: false,
      coreTimestamp: fast.coreTimestamp
    };
  }

  const l1DirectoryPrompt = l1Index ? serializeL1DirectoryPrompt(l1Index) : "";

  if (isSimpleGreetingPrompt(userPrompt)) {
    return {
      mode: "direct-answer",
      hybridRetrievalMarkdown: buildHybridMarkdown({
        l1DirectoryPrompt,
        compressedSummaryMarkdown,
        windows: [],
        videoDuration
      }),
      windows: [],
      injectedChars: 0,
      degraded: false
    };
  }

  const bm25Index = createL0Bm25Index(l0Lines, { chapters: l1Index?.chapters });
  const bm25Result: L0LexicalSearchResult = bm25Index.search({
    query: userPrompt,
    topK: HYBRID_BM25_TOP_K,
    windowRadiusLines: HYBRID_BM25_RADIUS_LINES,
    windowRadiusSeconds: HYBRID_BM25_RADIUS_SECONDS,
    maxInjectedChars: HYBRID_BM25_MAX_CHARS
  });
  const bm25Windows = bm25Result.windows ?? [];

  if (!l1Index || !l1DirectoryPrompt || !provider?.baseUrl || !provider?.model) {
    const degradedMerged = mergeL0ContextWindows(l0Lines, [bm25Windows], {
      maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS
    });
    return {
      mode: "degraded-bm25",
      hybridRetrievalMarkdown: buildHybridMarkdown({
        l1DirectoryPrompt,
        compressedSummaryMarkdown,
        windows: degradedMerged.windows,
        videoDuration
      }),
      windows: degradedMerged.windows,
      injectedChars: degradedMerged.injectedChars,
      degraded: true,
      degradeReason: "l1-index-missing",
      coreTimestamp: bm25Result.hits[0]?.line.from
    };
  }

  const routerController = new AbortController();
  let timedOut = false;
  const onParentAbort = () => routerController.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timerId = setTimeout(() => {
    timedOut = true;
    routerController.abort();
  }, Math.max(500, routerTimeoutMs));

  let parsedRoute: ParsedL1RouteResult | null = null;
  let routeErrorReason: "router-timeout" | "router-rate-limited" | "router-error" | "router-invalid-output" | undefined;

  try {
    const routerMessages = buildL1RouterMessages({
      l1DirectoryPrompt,
      userPrompt,
      history
    });
    const rawRouterText = await routeChatCompletion({
      provider,
      messages: routerMessages,
      stream: false,
      thinkingLevel: "off",
      maxTokens: ROUTER_MAX_TOKENS,
      temperature: 0,
      retries: 0,
      signal: routerController.signal
    });
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    const result = parseL1RouterOutput(rawRouterText, l1Index);
    if (result.ok) {
      parsedRoute = result;
    } else {
      routeErrorReason = result.reason;
    }
  } catch (error) {
    if (signal?.aborted || (!timedOut && (isAbortedMarkerError(error) || isAbortNamedError(error)))) {
      throw makeAbortedError();
    }
    routeErrorReason = timedOut ? "router-timeout" : classifyRouterErrorReason(error);
  } finally {
    clearTimeout(timerId);
    signal?.removeEventListener("abort", onParentAbort);
  }

  if (!parsedRoute) {
    const degradedMerged = mergeL0ContextWindows(l0Lines, [bm25Windows], {
      maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS
    });
    return {
      mode: "degraded-bm25",
      hybridRetrievalMarkdown: buildHybridMarkdown({
        l1DirectoryPrompt,
        compressedSummaryMarkdown,
        windows: degradedMerged.windows,
        videoDuration
      }),
      windows: degradedMerged.windows,
      injectedChars: degradedMerged.injectedChars,
      degraded: true,
      degradeReason: routeErrorReason ?? "router-error",
      coreTimestamp: bm25Result.hits[0]?.line.from
    };
  }

  if (parsedRoute.plan.mode === "direct-answer") {
    return {
      mode: "direct-answer",
      hybridRetrievalMarkdown: buildHybridMarkdown({
        l1DirectoryPrompt,
        compressedSummaryMarkdown,
        windows: [],
        videoDuration
      }),
      windows: [],
      injectedChars: 0,
      degraded: false
    };
  }

  const routed = collectRoutedRangeWindows({
    allLines: l0Lines,
    bm25Index,
    l1Index,
    plan: parsedRoute.plan,
    userPrompt
  });
  const merged = mergeL0ContextWindows(l0Lines, [routed.windows, bm25Windows], {
    maxInjectedChars: STAGE_B_TOTAL_SUBTITLE_MAX_CHARS
  });
  const coreTimestamp = routed.topHitTimestamp ?? bm25Result.hits[0]?.line.from ?? merged.windows[0]?.from;

  return {
    mode: "hybrid-single-hop",
    hybridRetrievalMarkdown: buildHybridMarkdown({
      l1DirectoryPrompt,
      compressedSummaryMarkdown,
      windows: merged.windows,
      videoDuration
    }),
    windows: merged.windows,
    injectedChars: merged.injectedChars,
    degraded: false,
    coreTimestamp
  };
}
