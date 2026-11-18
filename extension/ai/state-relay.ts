// extension/ai/state-relay.ts
// 长视频「滑动状态卡接力 + 10～15 分钟平滑窗口切分 + L0 金句逐字回填 + 容错解析」核心算法模块（ADR-0027）。
// 约束：纯 TypeScript 算法模块，零 chrome/DOM/storage 依赖，零第三方依赖。

import { formatClock, parseClock } from "../shared/clock-text.js";
import { truncateWithEllipsis } from "../shared/text-primitives.js";
import { joinSubtitleText } from "../subtitle/text-classification.js";
import { MATERIAL_BUDGET_CHARS, SEGMENT_INPUT_CHARS } from "./budgeter.js";
import { parseLooseJson, stripModelReasoningAndFences } from "./json-repair.js";
import { estimateCompactPromptTokens, normalizeL0SubtitleLines, tokenizeLexicalText } from "./l0-bm25.js";
import { MAX_ANALYSIS_CHAPTERS, type AnalysisChapter, type AnalysisQuote } from "./analysis-validate.js";
import type { ChapterPlan } from "./chapter-plan.js";
import type {
  L0SubtitleLine,
  L1ChapterNode,
  L1QuoteRef,
  RelayActiveTopic,
  StateRelayCard
} from "./long-video-hybrid-types.js";

/** 时长分流阈值：字幕覆盖跨度超过 30 分钟（1800s）即进入状态卡接力分段。 */
export const OVERVIEW_RELAY_DURATION_THRESHOLD_SECONDS = 1800;
/** 字符分流阈值：与 ADR-0001 / ADR-0027 素材预算 200k 字符保持同源。 */
export const OVERVIEW_RELAY_CHARS_THRESHOLD = MATERIAL_BUDGET_CHARS;
/** 5 分钟（300s）语音转写分片对齐基准。 */
export const ASR_ALIGN_UNIT_SECONDS = 300;
/** 标准接力窗口目标时长：15 分钟（3 × 300s）。 */
export const RELAY_WINDOW_TARGET_SECONDS = 900;
/** 最小接力窗口时长：10 分钟（2 × 300s），避免尾部碎窗。 */
export const RELAY_WINDOW_MIN_SECONDS = 600;
/** 单窗最大字符上限（防止超高语速字幕撑爆单次请求窗口）。 */
export const RELAY_WINDOW_MAX_CHARS = SEGMENT_INPUT_CHARS;

const RELAY_OVERLAP_MAX_LINES = 4;
const RELAY_OVERLAP_MAX_CHARS = 400;
const QUOTE_OFFSET_RADIUS = 5;
const QUOTE_MAX_SPAN_LINES = 8;
const MAX_RELAY_QUOTES = 50;

const STATE_CARD_SUMMARY_MAX_CHARS = 80;
const STATE_CARD_MAX_THREADS = 3;
const STATE_CARD_MAX_ENTITIES = 6;
const STATE_CARD_MAX_RECENT_CHAPTERS = 3;
const STATE_CARD_PROMPT_MAX_CHARS = 220;
const STATE_CARD_PROMPT_MAX_TOKENS = 160;

export interface StateRelayWindow {
  /** 0-based 窗口序号 */
  windowIndex: number;
  /** 本窗口负责的起始时间戳（秒） */
  fromSeconds: number;
  /** 本窗口负责的结束时间戳（秒） */
  toSeconds: number;
  /** 本窗口起始 L0 行号（含） */
  startLineNumber: number;
  /** 本窗口结束 L0 行号（含） */
  endLineNumber: number;
  /** 本窗口总字符数 */
  chars: number;
  /** 本窗口负责开章挑句的 L0 原始字幕行 */
  lines: readonly L0SubtitleLine[];
  /** 上一窗口末尾的极短前情只读字幕行 */
  overlapLines: readonly L0SubtitleLine[];
}

export interface OverviewRelayDecision {
  shouldRelay: boolean;
  totalChars: number;
  subtitleSpanSeconds: number;
  windows: readonly StateRelayWindow[];
}

export interface BuildRelayWindowsOptions {
  targetWindowSeconds?: number;
  minWindowSeconds?: number;
  alignUnitSeconds?: number;
  maxWindowChars?: number;
  budgetChapters?: ReadonlyArray<{ from?: unknown; title?: unknown }>;
}

export interface DecideOverviewRelayOptions extends BuildRelayWindowsOptions {
  durationThresholdSeconds?: number;
  charsThreshold?: number;
}

export interface RawRelayStepData {
  nextStateCard: StateRelayCard;
  chapters: L1ChapterNode[];
  quotes: L1QuoteRef[];
  windowSummary: string;
  usedFallbackParser?: boolean;
}

export interface MergedRelayResult {
  chapters: AnalysisChapter[];
  quotes: AnalysisQuote[];
  l1Chapters: L1ChapterNode[];
  l1Quotes: L1QuoteRef[];
  finalStateCard: StateRelayCard | null;
}

function clampText(value: unknown, maxLen: number): string {
  return truncateWithEllipsis(value, maxLen, { singleLine: true });
}

function extractChapterStarts(chapters?: ReadonlyArray<{ from?: unknown }>): number[] {
  if (!Array.isArray(chapters)) {
    return [];
  }
  const starts: number[] = [];
  for (const ch of chapters) {
    const from = Number(ch?.from);
    if (Number.isFinite(from) && from >= 0) {
      starts.push(Math.floor(from));
    }
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

/**
 * 为当前窗口计算与 5 分钟（300s）转写分片边界平滑对齐的目标结束时间（落在 10～15 分钟区间内）。
 */
function chooseWindowTargetEnd(
  windowStartSec: number,
  totalEndSec: number,
  targetSec: number,
  minSec: number,
  alignUnit: number,
  chapterStarts: readonly number[]
): number {
  const remaining = totalEndSec - windowStartSec;
  if (remaining <= targetSec) {
    return totalEndSec;
  }

  let plannedEnd: number;
  if (remaining <= targetSec + minSec) {
    // 剩余 15~25 分钟时均分到 5 分钟网格，避免尾部出现几分钟的碎窗
    const rawMid = windowStartSec + remaining / 2;
    const snapped = Math.round(rawMid / alignUnit) * alignUnit;
    plannedEnd = Math.min(windowStartSec + targetSec, Math.max(windowStartSec + minSec, snapped));
  } else {
    const rawTarget = windowStartSec + targetSec;
    const snapped = Math.floor(rawTarget / alignUnit) * alignUnit;
    plannedEnd = snapped >= windowStartSec + minSec ? snapped : rawTarget;
  }

  // 若官方章节边界恰好在目标结束时间 ±120s 内且满足最小窗口要求，优先对齐官方章节
  for (const start of chapterStarts) {
    if (
      start >= windowStartSec + minSec &&
      start <= windowStartSec + targetSec &&
      Math.abs(start - plannedEnd) <= 120
    ) {
      return start;
    }
  }

  return plannedEnd;
}

/**
 * 按 10～15 分钟窗口切分 L0 字幕（对齐 5 分钟语音转写边界，并受单窗字符上限约束）。
 */
export function buildRelayWindows(
  lines: readonly L0SubtitleLine[],
  options: BuildRelayWindowsOptions = {}
): StateRelayWindow[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }

  const targetSec = Math.max(60, Number(options.targetWindowSeconds) || RELAY_WINDOW_TARGET_SECONDS);
  const minSec = Math.min(targetSec, Math.max(60, Number(options.minWindowSeconds) || RELAY_WINDOW_MIN_SECONDS));
  const alignUnit = Math.max(60, Number(options.alignUnitSeconds) || ASR_ALIGN_UNIT_SECONDS);
  const maxChars = Math.max(1000, Number(options.maxWindowChars) || RELAY_WINDOW_MAX_CHARS);
  const chapterStarts = extractChapterStarts(options.budgetChapters);

  const totalEndSec = Math.max(0, Math.ceil(lines[lines.length - 1].to));
  const windows: StateRelayWindow[] = [];

  let cursor = 0;
  while (cursor < lines.length) {
    const windowStartSec = Math.max(0, Math.floor(lines[cursor].from));
    const targetEndSec = chooseWindowTargetEnd(
      windowStartSec,
      totalEndSec,
      targetSec,
      minSec,
      alignUnit,
      chapterStarts
    );

    const chunk: L0SubtitleLine[] = [];
    let chunkChars = 0;
    let prevFrom: number | null = null;

    while (cursor < lines.length) {
      const line = lines[cursor];
      const lineChars = line.content.length;

      // 字符上限保护：密集语音场景下绝不撑爆单窗上下文
      if (chunk.length > 0 && chunkChars + lineChars > maxChars) {
        break;
      }

      // 若已达到最小窗口跨度且进入新章节或跨越目标 5 分钟对齐切点，则收窗
      if (chunk.length > 0) {
        const crossedTarget = line.from >= targetEndSec && (line.from - windowStartSec >= minSec || targetEndSec < totalEndSec);
        const crossedChapter =
          prevFrom !== null &&
          line.from - windowStartSec >= minSec &&
          chapterStarts.some((s) => prevFrom! < s && line.from >= s && Math.abs(s - targetEndSec) <= 120);
        if (crossedTarget || crossedChapter) {
          break;
        }
      }

      chunk.push(line);
      chunkChars += lineChars;
      prevFrom = line.from;
      cursor += 1;
    }

    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const prevWindow = windows.length > 0 ? windows[windows.length - 1] : null;
    const overlapLines = prevWindow ? pickOverlapLines(prevWindow.lines) : [];

    windows.push({
      windowIndex: windows.length,
      fromSeconds: Math.max(0, Math.floor(first.from)),
      toSeconds: Math.max(Math.floor(first.from), Math.ceil(last.to)),
      startLineNumber: first.lineNumber,
      endLineNumber: last.lineNumber,
      chars: chunkChars,
      lines: chunk,
      overlapLines
    });
  }

  return windows;
}

function pickOverlapLines(prevLines: readonly L0SubtitleLine[]): L0SubtitleLine[] {
  if (!prevLines.length) {
    return [];
  }
  const picked: L0SubtitleLine[] = [];
  let chars = 0;
  for (let i = prevLines.length - 1; i >= 0; i -= 1) {
    const item = prevLines[i];
    if (picked.length >= RELAY_OVERLAP_MAX_LINES) {
      break;
    }
    if (picked.length > 0 && chars + item.content.length > RELAY_OVERLAP_MAX_CHARS) {
      break;
    }
    picked.unshift(item);
    chars += item.content.length;
  }
  return picked;
}

/**
 * 概览分流判据：字幕覆盖跨度 > 30 分钟（1800s）或总字符 > 200,000 时启用状态卡接力分段，
 * 其余常规短视频走单次直通流程。
 */
export function decideOverviewRelaySplit(
  rawLines: readonly L0SubtitleLine[] | ReadonlyArray<{ from?: unknown; to?: unknown; content?: unknown }>,
  options: DecideOverviewRelayOptions = {}
): OverviewRelayDecision {
  const lines = normalizeL0SubtitleLines(rawLines);
  const totalChars = lines.reduce((sum, line) => sum + line.content.length, 0);
  const firstFrom = lines.length > 0 ? Math.max(0, lines[0].from) : 0;
  const lastTo = lines.length > 0 ? Math.max(firstFrom, lines[lines.length - 1].to) : 0;
  const subtitleSpanSeconds = Math.max(0, Math.floor(lastTo - firstFrom));

  const durationThreshold = Number(options.durationThresholdSeconds) || OVERVIEW_RELAY_DURATION_THRESHOLD_SECONDS;
  const charsThreshold = Number(options.charsThreshold) || OVERVIEW_RELAY_CHARS_THRESHOLD;
  const shouldRelay =
    lines.length > 0 && (subtitleSpanSeconds > durationThreshold || totalChars > charsThreshold);

  return {
    shouldRelay,
    totalChars,
    subtitleSpanSeconds,
    windows: shouldRelay ? buildRelayWindows(lines, options) : []
  };
}

/**
 * 渲染带明确 L0 行号与时间戳的字幕文本：`#12 [2:30] 字幕正文`。
 */
export function renderL0LinesWithNumbers(lines: readonly L0SubtitleLine[]): string {
  if (!Array.isArray(lines) || lines.length === 0) {
    return "";
  }
  return lines
    .map((line) => `#${line.lineNumber} [${formatClock(line.from)}] ${line.content}`)
    .join("\n");
}

function formatStateCardLines(
  card: StateRelayCard,
  opts: {
    summaryMax: number;
    maxThreads: number;
    threadMax: number;
    maxEntities: number;
    entityMax: number;
    includeTopic: boolean;
    includeRecent: boolean;
    includeCount: boolean;
  }
): string {
  const lines: string[] = [
    `前序状态卡（至 ${formatClock(card.coveredUntilSeconds)} / #${card.coveredUntilLineNumber}）：`
  ];
  if (card.rollingSummary) {
    lines.push(`主线：${clampText(card.rollingSummary, opts.summaryMax)}`);
  }
  if (opts.includeTopic && card.activeTopic?.title) {
    lines.push(`延续：${clampText(card.activeTopic.title, 18)}`);
  }
  if (opts.maxThreads > 0 && card.openThreads.length > 0) {
    lines.push(
      `悬念：${card.openThreads.slice(0, opts.maxThreads).map((t) => clampText(t, opts.threadMax)).join("；")}`
    );
  }
  if (opts.maxEntities > 0 && card.confirmedEntities.length > 0) {
    lines.push(
      `术语：${card.confirmedEntities.slice(0, opts.maxEntities).map((e) => clampText(e, opts.entityMax)).join("/")}`
    );
  }
  if (opts.includeRecent && card.recentChapterTitles.length > 0) {
    lines.push(
      `近章：${card.recentChapterTitles.slice(-2).map((t) => clampText(t, 16)).join("→")}`
    );
  }
  if (opts.includeCount) {
    lines.push(`金句数：${Math.max(0, card.collectedQuoteCount)}`);
  }
  return lines.join("\n");
}

/**
 * 将前序状态卡序列化为紧凑（约 100 Token）的上下文提示块，分级裁剪确保跨多段绝不膨胀。
 */
export function serializeStateRelayCard(card: StateRelayCard | null | undefined): string {
  if (!card) {
    return "";
  }
  const tiers = [
    { summaryMax: 72, maxThreads: 3, threadMax: 22, maxEntities: 6, entityMax: 16, includeTopic: true, includeRecent: true, includeCount: true },
    { summaryMax: 64, maxThreads: 2, threadMax: 18, maxEntities: 5, entityMax: 14, includeTopic: true, includeRecent: false, includeCount: false },
    { summaryMax: 52, maxThreads: 2, threadMax: 14, maxEntities: 4, entityMax: 12, includeTopic: false, includeRecent: false, includeCount: false },
    { summaryMax: 40, maxThreads: 1, threadMax: 12, maxEntities: 3, entityMax: 10, includeTopic: false, includeRecent: false, includeCount: false }
  ];
  for (const tier of tiers) {
    const candidate = formatStateCardLines(card, tier);
    if (
      candidate.length <= STATE_CARD_PROMPT_MAX_CHARS &&
      estimateCompactPromptTokens(candidate) <= STATE_CARD_PROMPT_MAX_TOKENS
    ) {
      return candidate;
    }
  }
  return formatStateCardLines(card, tiers[tiers.length - 1]).slice(0, STATE_CARD_PROMPT_MAX_CHARS);
}

// ============================================================
// 文本清理与容错字段解析（适配 ModelScope 免费接口与小参数模型）
// ============================================================

function parseLineNumberToken(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const m = value.trim().match(/^(?:#?L?|line\s*)(\d+)$/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 0) {
        return n;
      }
    }
  }
  return null;
}

function parseLineRangeFromRaw(raw: Record<string, unknown>): { startLine: number; endLine: number } | null {
  const rangeArr = Array.isArray(raw.lineRange) ? raw.lineRange : Array.isArray(raw.lines) ? raw.lines : null;
  if (rangeArr && rangeArr.length >= 1) {
    const s = parseLineNumberToken(rangeArr[0]);
    const e = rangeArr.length >= 2 ? parseLineNumberToken(rangeArr[1]) : s;
    if (s !== null) {
      const end = e !== null && e >= s ? e : s;
      return { startLine: s, endLine: Math.min(end, s + QUOTE_MAX_SPAN_LINES - 1) };
    }
  }

  const rangeStr =
    typeof raw.lineRange === "string"
      ? raw.lineRange
      : typeof raw.lines === "string"
        ? raw.lines
        : null;
  if (rangeStr) {
    const m = rangeStr.trim().match(/(?:#?L?)(\d+)\s*[-~～到]\s*(?:#?L?)(\d+)/i);
    if (m) {
      const s = Number(m[1]);
      const e = Number(m[2]);
      if (Number.isInteger(s) && Number.isInteger(e) && s >= 0) {
        const startLine = Math.min(s, e);
        const endLine = Math.min(Math.max(s, e), startLine + QUOTE_MAX_SPAN_LINES - 1);
        return { startLine, endLine };
      }
    }
    const single = parseLineNumberToken(rangeStr);
    if (single !== null) {
      return { startLine: single, endLine: single };
    }
  }

  const startCandidate =
    parseLineNumberToken(raw.startLine) ??
    parseLineNumberToken(raw.startLineNumber) ??
    parseLineNumberToken(raw.fromLine) ??
    parseLineNumberToken(raw.lineNumber) ??
    parseLineNumberToken(raw.line);
  if (startCandidate === null) {
    return null;
  }
  const endCandidate =
    parseLineNumberToken(raw.endLine) ??
    parseLineNumberToken(raw.endLineNumber) ??
    parseLineNumberToken(raw.toLine) ??
    startCandidate;
  const startLine = Math.min(startCandidate, endCandidate);
  const endLine = Math.min(Math.max(startCandidate, endCandidate), startLine + QUOTE_MAX_SPAN_LINES - 1);
  return { startLine, endLine };
}

function parseSecondsField(raw: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n) && n >= 0) {
          return Math.floor(n);
        }
      }
      const parsedClock = parseClock(trimmed);
      if (parsedClock !== null) {
        return parsedClock;
      }
    }
  }
  return null;
}

function parseStringArray(value: unknown, maxItems: number, maxItemLen: number): string[] {
  let rawList: unknown[] = [];
  if (Array.isArray(value)) {
    rawList = value;
  } else if (typeof value === "string") {
    rawList = value.split(/[,，、;；/|]+/);
  } else if (value && typeof value === "object") {
    rawList = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      v && String(v).trim() && String(v).trim() !== k ? `${k}(${String(v).trim()})` : k
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    const clean = clampText(item, maxItemLen);
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

// ============================================================
// L0 本地相似度打分与金句逐字回填
// ============================================================

const STRIP_FOR_SIM_RE = /[\s\p{P}\p{S}]+/gu;

function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(STRIP_FOR_SIM_RE, "");
}

function extractBigrams(norm: string): Set<string> {
  const grams = new Set<string>();
  if (norm.length <= 1) {
    if (norm) grams.add(norm);
    return grams;
  }
  for (let i = 0; i < norm.length - 1; i += 1) {
    grams.add(norm.slice(i, i + 2));
  }
  return grams;
}

/**
 * 计算模型提示片段与候选 L0 字幕行的局部相似度（0..1），用于行号轻微偏移时的容错对齐。
 */
export function computeLocalTextSimilarity(hint: string, candidate: string): number {
  const normHint = normalizeForSimilarity(hint);
  const normCand = normalizeForSimilarity(candidate);
  if (!normHint || !normCand) {
    return 0;
  }
  if (normCand.includes(normHint) || normHint.includes(normCand)) {
    const minLen = Math.min(normHint.length, normCand.length);
    const maxLen = Math.max(normHint.length, normCand.length);
    return 0.55 + 0.45 * (minLen / maxLen);
  }

  const hintBigrams = extractBigrams(normHint);
  const candBigrams = extractBigrams(normCand);
  let bigramInter = 0;
  for (const g of hintBigrams) {
    if (candBigrams.has(g)) {
      bigramInter += 1;
    }
  }
  const dice = (2 * bigramInter) / (hintBigrams.size + candBigrams.size);

  const hintTokens = new Set(tokenizeLexicalText(hint));
  const candTokens = new Set(tokenizeLexicalText(candidate));
  let tokenOverlap = 0;
  if (hintTokens.size > 0 && candTokens.size > 0) {
    let tokenInter = 0;
    for (const t of hintTokens) {
      if (candTokens.has(t)) {
        tokenInter += 1;
      }
    }
    tokenOverlap = tokenInter / Math.min(hintTokens.size, candTokens.size);
  }

  return Math.max(dice, dice * 0.6 + tokenOverlap * 0.4);
}

function joinL0RangeContent(slice: readonly L0SubtitleLine[]): string {
  let acc = "";
  for (const line of slice) {
    acc = joinSubtitleText(acc, line.content);
  }
  return acc.trim();
}

function findLineIndexByNumber(allLines: readonly L0SubtitleLine[], lineNumber: number): number {
  if (
    lineNumber >= 0 &&
    lineNumber < allLines.length &&
    allLines[lineNumber]?.lineNumber === lineNumber
  ) {
    return lineNumber;
  }
  let lo = 0;
  let hi = allLines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const current = allLines[mid].lineNumber;
    if (current === lineNumber) {
      return mid;
    }
    if (current < lineNumber) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/**
 * 根据模型输出的行号区间或时间戳，直接从 L0 原始字幕回填逐字原话；
 * 若模型输出行号存在轻微偏移，结合 hint 文本在邻近行范围内做相似度容错对齐。
 */
export function backfillQuoteFromL0(
  allLines: readonly L0SubtitleLine[],
  rawQuote: unknown,
  bounds?: { minLineNumber?: number; maxLineNumber?: number; minSeconds?: number; maxSeconds?: number }
): L1QuoteRef | null {
  if (!Array.isArray(allLines) || allLines.length === 0 || !rawQuote || typeof rawQuote !== "object") {
    return null;
  }
  const raw = rawQuote as Record<string, unknown>;
  const hintText = clampText(raw.hint ?? raw.quote ?? raw.content ?? raw.text ?? "", 300);
  const timestampSec = parseSecondsField(raw, ["timestampSeconds", "from", "startSeconds", "timestamp"]);
  const range = parseLineRangeFromRaw(raw);

  const minIdx =
    bounds?.minLineNumber !== undefined
      ? Math.max(0, findLineIndexByNumber(allLines, bounds.minLineNumber))
      : 0;
  const maxIdx =
    bounds?.maxLineNumber !== undefined
      ? Math.min(allLines.length - 1, Math.max(minIdx, findLineIndexByNumber(allLines, bounds.maxLineNumber)))
      : allLines.length - 1;

  // 1. 显式行号区间主路径 + 轻微偏移容错对齐
  if (range) {
    const sIdx = findLineIndexByNumber(allLines, range.startLine);
    const eIdx = findLineIndexByNumber(allLines, range.endLine);
    if (sIdx >= 0 && eIdx >= sIdx) {
      // 防止越界选中前情只读行
      if (bounds?.minLineNumber !== undefined && allLines[sIdx].lineNumber < bounds.minLineNumber) {
        return null;
      }
      if (bounds?.maxLineNumber !== undefined && allLines[sIdx].lineNumber > bounds.maxLineNumber) {
        return null;
      }
      const clampedEndIdx = Math.min(eIdx, maxIdx);
      let chosenStart = sIdx;
      let chosenEnd = clampedEndIdx;

      if (hintText) {
        const spanLen = chosenEnd - chosenStart + 1;
        const baseScore = computeLocalTextSimilarity(
          hintText,
          joinL0RangeContent(allLines.slice(chosenStart, chosenEnd + 1))
        );
        if (baseScore < 0.45) {
          let bestScore = baseScore;
          const searchLo = Math.max(minIdx, sIdx - QUOTE_OFFSET_RADIUS);
          const searchHi = Math.min(maxIdx, sIdx + QUOTE_OFFSET_RADIUS);
          for (let candStart = searchLo; candStart <= searchHi; candStart += 1) {
            for (const candSpan of spanLen > 1 ? [spanLen, 1] : [1, 2]) {
              const candEnd = Math.min(maxIdx, candStart + candSpan - 1);
              const score = computeLocalTextSimilarity(
                hintText,
                joinL0RangeContent(allLines.slice(candStart, candEnd + 1))
              );
              if (score > bestScore + 0.15 && score >= 0.35) {
                bestScore = score;
                chosenStart = candStart;
                chosenEnd = candEnd;
              }
            }
          }
        }
      }

      const matchedSlice = allLines.slice(chosenStart, chosenEnd + 1);
      const verbatim = joinL0RangeContent(matchedSlice);
      if (!verbatim) {
        return null;
      }
      return {
        from: Math.floor(matchedSlice[0].from),
        content: verbatim,
        lineNumber: matchedSlice[0].lineNumber
      };
    }
  }

  // 2. 无行号（或行号越界）时按时间戳 + 局部相似度回退对齐到 L0
  if (timestampSec === null && !hintText) {
    return null;
  }
  if (timestampSec !== null && bounds?.minSeconds !== undefined && timestampSec < bounds.minSeconds) {
    return null;
  }
  if (timestampSec !== null && bounds?.maxSeconds !== undefined && timestampSec > bounds.maxSeconds) {
    return null;
  }

  let bestStart = -1;
  let bestEnd = -1;
  let bestRank = Number.NEGATIVE_INFINITY;

  for (let i = minIdx; i <= maxIdx; i += 1) {
    const line = allLines[i];
    const timeDist = timestampSec !== null ? Math.abs(line.from - timestampSec) : 0;
    if (timestampSec !== null && timeDist > 45) {
      continue;
    }
    if (!hintText) {
      const rank = -timeDist;
      if (rank > bestRank) {
        bestRank = rank;
        bestStart = i;
        bestEnd = i;
      }
      continue;
    }
    for (const span of [1, 2, 3]) {
      const end = Math.min(maxIdx, i + span - 1);
      const text = joinL0RangeContent(allLines.slice(i, end + 1));
      const sim = computeLocalTextSimilarity(hintText, text);
      // 相似度优先，时间近度辅助消歧
      const rank = sim * 100 - timeDist * 0.2 - (span - 1) * 2;
      if (rank > bestRank) {
        bestRank = rank;
        bestStart = i;
        bestEnd = end;
      }
      if (end === i) break;
    }
  }

  // 若 45 秒内无候选但有 hintText，放宽到当前窗口全范围检索
  if (bestStart < 0 && hintText) {
    for (let i = minIdx; i <= maxIdx; i += 1) {
      const sim = computeLocalTextSimilarity(hintText, allLines[i].content);
      if (sim >= 0.35 && sim > bestRank) {
        bestRank = sim;
        bestStart = i;
        bestEnd = i;
      }
    }
  }

  if (bestStart < 0) {
    return null;
  }
  const slice = allLines.slice(bestStart, bestEnd + 1);
  const verbatim = joinL0RangeContent(slice);
  if (!verbatim) {
    return null;
  }
  return {
    from: Math.floor(slice[0].from),
    content: verbatim,
    lineNumber: slice[0].lineNumber
  };
}

// ============================================================
// 状态卡解析与防膨胀归一化
// ============================================================

function resolveCardInput(rawSource: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    rawSource.nextStateCard,
    rawSource.stateCard,
    rawSource.state,
    rawSource.relayCard
  ];
  for (const cand of candidates) {
    if (cand && typeof cand === "object" && !Array.isArray(cand)) {
      return cand as Record<string, unknown>;
    }
  }
  return null;
}

function mergeUniqueBounded(
  prev: readonly string[],
  next: readonly string[],
  maxItems: number,
  maxLen: number
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  // 新产出优先保留（或后入覆盖尾部），保持最新关键信息在窗口内
  for (const item of [...next, ...prev]) {
    const clean = clampText(item, maxLen);
    if (!clean || seen.has(clean)) {
      continue;
    }
    seen.add(clean);
    merged.push(clean);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
}

function normalizeActiveTopic(
  rawTopic: unknown,
  windowFromSeconds: number,
  windowToSeconds: number
): RelayActiveTopic | undefined {
  if (!rawTopic) {
    return undefined;
  }
  if (typeof rawTopic === "string") {
    const title = clampText(rawTopic, 24);
    return title ? { title, from: windowFromSeconds } : undefined;
  }
  if (typeof rawTopic === "object") {
    const obj = rawTopic as Record<string, unknown>;
    const title = clampText(obj.title ?? obj.topic ?? "", 24);
    if (!title) {
      return undefined;
    }
    const from =
      parseSecondsField(obj, ["from", "timestampSeconds", "timestamp"]) ?? windowFromSeconds;
    const thesisDraft = clampText(obj.thesisDraft ?? obj.summary ?? obj.thesis ?? "", 40);
    return {
      title,
      from: Math.max(0, Math.min(from, windowToSeconds)),
      ...(thesisDraft ? { thesisDraft } : {})
    };
  }
  return undefined;
}

function buildNextStateCard(
  rawCard: Record<string, unknown> | null,
  previousCard: StateRelayCard | null,
  window: StateRelayWindow,
  windowChapters: readonly L1ChapterNode[],
  windowQuotes: readonly L1QuoteRef[],
  fallbackSummary: string
): StateRelayCard {
  const prevEntities = previousCard?.confirmedEntities ?? [];
  const prevThreads = previousCard?.openThreads ?? [];
  const prevTitles = previousCard?.recentChapterTitles ?? [];

  const rollingSummary = clampText(
    rawCard?.rollingSummary ??
      rawCard?.coreThesis ??
      rawCard?.mainline ??
      rawCard?.summary ??
      fallbackSummary ??
      previousCard?.rollingSummary ??
      "",
    STATE_CARD_SUMMARY_MAX_CHARS
  );

  const rawEntities = parseStringArray(
    rawCard?.confirmedEntities ?? rawCard?.entities ?? rawCard?.terms ?? rawCard?.terminology,
    STATE_CARD_MAX_ENTITIES,
    20
  );
  const chapterEntities = windowChapters.flatMap((c) => c.keyEntities);
  const confirmedEntities = mergeUniqueBounded(
    prevEntities,
    [...rawEntities, ...chapterEntities],
    STATE_CARD_MAX_ENTITIES,
    20
  );

  const openThreads = rawCard
    ? parseStringArray(
        rawCard.openThreads ?? rawCard.suspense ?? rawCard.unresolved,
        STATE_CARD_MAX_THREADS,
        32
      )
    : [...prevThreads];

  const recentChapterTitles = [
    ...prevTitles,
    ...windowChapters.map((c) => clampText(c.title, 24)).filter(Boolean)
  ].slice(-STATE_CARD_MAX_RECENT_CHAPTERS);

  const activeTopic = rawCard
    ? normalizeActiveTopic(rawCard.activeTopic, window.fromSeconds, window.toSeconds)
    : undefined;

  return {
    windowIndex: window.windowIndex,
    coveredUntilSeconds: window.toSeconds,
    coveredUntilLineNumber: window.endLineNumber,
    rollingSummary,
    ...(activeTopic ? { activeTopic } : {}),
    confirmedEntities,
    openThreads,
    recentChapterTitles,
    collectedQuoteCount: (previousCard?.collectedQuoteCount ?? 0) + windowQuotes.length
  };
}

/**
 * 单窗调用彻底失败时的状态卡接力兜底：保留前序论点、术语与未闭合悬念，只推进时间与行号游标。
 */
export function advanceFallbackStateCard(
  previousCard: StateRelayCard | null,
  window: StateRelayWindow
): StateRelayCard {
  return {
    windowIndex: window.windowIndex,
    coveredUntilSeconds: window.toSeconds,
    coveredUntilLineNumber: window.endLineNumber,
    rollingSummary: previousCard?.rollingSummary ?? "",
    ...(previousCard?.activeTopic ? { activeTopic: previousCard.activeTopic } : {}),
    confirmedEntities: previousCard?.confirmedEntities ?? [],
    openThreads: previousCard?.openThreads ?? [],
    recentChapterTitles: previousCard?.recentChapterTitles ?? [],
    collectedQuoteCount: previousCard?.collectedQuoteCount ?? 0
  };
}

// ============================================================
// 纯文本 / 畸形输出启发式兜底解析
// ============================================================

function fallbackParseRelayText(
  cleanedText: string,
  allLines: readonly L0SubtitleLine[],
  window: StateRelayWindow
): {
  summary: string;
  chapters: Array<{ title: string; timestampSeconds: number; summary: string }>;
  quotes: Array<{ lineNumber?: number; timestampSeconds?: number; quote: string }>;
} {
  const chapters: Array<{ title: string; timestampSeconds: number; summary: string }> = [];
  const quotes: Array<{ lineNumber?: number; timestampSeconds?: number; quote: string }> = [];
  const textLines = cleanedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of textLines) {
    const chapMatch = line.match(
      /^(?:[-*•]\s*)?(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?)\s+(.+)$/
    );
    if (chapMatch) {
      const sec = parseClock(chapMatch[1]);
      const rest = chapMatch[2].trim();
      if (sec !== null && sec >= window.fromSeconds && sec <= window.toSeconds && rest) {
        const sepIdx = rest.search(/[：:|—]/);
        const title = sepIdx > 0 ? rest.slice(0, sepIdx).trim() : rest.slice(0, 40);
        const summary = sepIdx > 0 ? rest.slice(sepIdx + 1).trim() : "";
        chapters.push({ title, timestampSeconds: sec, summary });
        continue;
      }
    }

    const quoteMatch = line.match(/(?:#?L)(\d+)\s*[：:「"']?([^」"']+)/i);
    if (quoteMatch) {
      const ln = Number(quoteMatch[1]);
      if (Number.isInteger(ln) && ln >= window.startLineNumber && ln <= window.endLineNumber) {
        quotes.push({ lineNumber: ln, quote: quoteMatch[2].trim() });
      }
    }
  }

  const proseFallback = textLines.find((l) => !l.startsWith("{") && !l.startsWith("}") && l.length >= 8) ?? "";
  return {
    summary: clampText(proseFallback, STATE_CARD_SUMMARY_MAX_CHARS),
    chapters,
    quotes
  };
}

export interface ParseStateRelayOutputContext {
  allLines: readonly L0SubtitleLine[];
  window: StateRelayWindow;
  previousStateCard: StateRelayCard | null;
  hasGivenChapters?: boolean;
  titlesOnly?: boolean;
}

/**
 * 容错解析单窗口的模型结构化输出，完成：
 * 1. `<think>` 剥除、围栏提取、截断 JSON 修复；
 * 2. 章节字段别名兼容与时间戳/行号归位；
 * 3. L0 原始字幕金句逐字回填（带轻微偏移相似度容错）；
 * 4. 更新并裁剪下一段滑动状态卡（保持 ~100 Token 有界）；
 * 5. 完全非 JSON 时触发文本启发式兜底，绝不因格式偏差中断生成。
 */
export function parseStateRelayOutput(
  rawText: unknown,
  ctx: ParseStateRelayOutputContext
): RawRelayStepData {
  const cleaned = stripModelReasoningAndFences(rawText);
  let source: Record<string, unknown> | null = null;
  let usedFallbackParser = false;

  if (cleaned) {
    try {
      const parsed = parseLooseJson(cleaned);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      source = null;
    }
  }

  if (!source) {
    usedFallbackParser = true;
    const heuristic = fallbackParseRelayText(cleaned, ctx.allLines, ctx.window);
    source = {
      summary: heuristic.summary,
      chapters: heuristic.chapters,
      keyQuotes: heuristic.quotes
    };
  }

  const minSec = ctx.hasGivenChapters ? 0 : ctx.window.fromSeconds;
  const maxSec = ctx.window.toSeconds;

  const rawChaptersList = Array.isArray(source.chapters)
    ? source.chapters
    : Array.isArray(source.sections)
      ? source.sections
      : Array.isArray(source.nodes)
        ? source.nodes
        : [];

  const parsedChapters: L1ChapterNode[] = [];
  if (!ctx.titlesOnly) {
    const rawItems: Array<{
      from: number;
      explicitTo?: number;
      title: string;
      coreThesis: string;
      keyEntities: string[];
      startLineNumber?: number;
      endLineNumber?: number;
    }> = [];

    for (const item of rawChaptersList.slice(0, MAX_ANALYSIS_CHAPTERS)) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const ch = item as Record<string, unknown>;
      const title = clampText(ch.title ?? ch.name ?? "", 300);
      if (!title) {
        continue;
      }
      let from = parseSecondsField(ch, ["timestampSeconds", "from", "startSeconds", "startTime", "timestamp"]);
      const lineRef = parseLineNumberToken(ch.startLine ?? ch.startLineNumber ?? ch.lineNumber ?? ch.line);
      if (from === null && lineRef !== null) {
        const idx = findLineIndexByNumber(ctx.allLines, lineRef);
        if (idx >= 0) {
          from = Math.floor(ctx.allLines[idx].from);
        }
      }
      if (from === null || from < minSec || from > maxSec) {
        continue;
      }

      const explicitTo = parseSecondsField(ch, ["to", "endSeconds", "endTimestampSeconds", "endTime"]);
      const coreThesis = clampText(ch.summary ?? ch.coreThesis ?? ch.thesis ?? ch.description ?? "", 600);
      const keyEntities = parseStringArray(
        ch.keyEntities ?? ch.entities ?? ch.keywords ?? ch.terms,
        6,
        24
      );
      const startLineNumber = lineRef ?? undefined;
      const endLineRef = parseLineNumberToken(ch.endLine ?? ch.endLineNumber);

      rawItems.push({
        from,
        explicitTo: explicitTo !== null && explicitTo > from ? explicitTo : undefined,
        title,
        coreThesis,
        keyEntities,
        startLineNumber,
        endLineNumber: endLineRef ?? undefined
      });
    }

    rawItems.sort((a, b) => a.from - b.from);
    for (let i = 0; i < rawItems.length; i += 1) {
      const curr = rawItems[i];
      const nextFrom = i + 1 < rawItems.length ? rawItems[i + 1].from : maxSec;
      const to = curr.explicitTo !== undefined ? curr.explicitTo : Math.max(curr.from, nextFrom);
      parsedChapters.push({
        chapterIndex: i,
        title: curr.title,
        from: curr.from,
        to,
        coreThesis: curr.coreThesis,
        keyEntities: curr.keyEntities,
        quoteLineNumbers: [],
        ...(curr.startLineNumber !== undefined ? { startLineNumber: curr.startLineNumber } : {}),
        ...(curr.endLineNumber !== undefined ? { endLineNumber: curr.endLineNumber } : {})
      });
    }
  }

  const rawQuotesList = Array.isArray(source.keyQuotes)
    ? source.keyQuotes
    : Array.isArray(source.quotes)
      ? source.quotes
      : Array.isArray(source.highlights)
        ? source.highlights
        : [];

  const quotes: L1QuoteRef[] = [];
  const seenQuoteKeys = new Set<string>();
  for (const rawQuote of rawQuotesList.slice(0, MAX_RELAY_QUOTES)) {
    const backfilled = backfillQuoteFromL0(ctx.allLines, rawQuote, {
      minLineNumber: ctx.window.startLineNumber,
      maxLineNumber: ctx.window.endLineNumber,
      minSeconds: ctx.window.fromSeconds,
      maxSeconds: ctx.window.toSeconds
    });
    if (!backfilled) {
      continue;
    }
    const dedupKey = `${backfilled.lineNumber}:${backfilled.content}`;
    if (seenQuoteKeys.has(dedupKey)) {
      continue;
    }
    seenQuoteKeys.add(dedupKey);
    quotes.push(backfilled);
  }
  quotes.sort((a, b) => a.from - b.from || a.lineNumber - b.lineNumber);

  // 将金句行号回绑到本段内章节节点
  for (const quote of quotes) {
    let ownerIdx = -1;
    for (let i = 0; i < parsedChapters.length; i += 1) {
      if (parsedChapters[i].from <= quote.from) {
        ownerIdx = i;
      } else {
        break;
      }
    }
    if (ownerIdx >= 0) {
      quote.chapterIndex = ownerIdx;
      parsedChapters[ownerIdx] = {
        ...parsedChapters[ownerIdx],
        quoteLineNumbers: [...parsedChapters[ownerIdx].quoteLineNumbers, quote.lineNumber]
      };
    }
  }

  const rawCard = resolveCardInput(source);
  const fallbackWindowSummary = clampText(
    source.summary ??
      source.windowSummary ??
      parsedChapters.map((c) => `${c.title}${c.coreThesis ? `：${c.coreThesis}` : ""}`).join("；"),
    STATE_CARD_SUMMARY_MAX_CHARS
  );

  const nextStateCard = buildNextStateCard(
    rawCard,
    ctx.previousStateCard,
    ctx.window,
    parsedChapters,
    quotes,
    fallbackWindowSummary
  );

  return {
    nextStateCard,
    chapters: parsedChapters,
    quotes,
    windowSummary: fallbackWindowSummary,
    ...(usedFallbackParser ? { usedFallbackParser: true } : {})
  };
}

/**
 * 合并各接力窗口的章节节点与 L0 回填金句，应用分章计划（graft）并生成最终兼容 UI 的
 * AnalysisChapter[] / AnalysisQuote[] 与完整的 L1ChapterNode[] / L1QuoteRef[]。
 */
export function mergeRelayOutcomes(
  steps: readonly RawRelayStepData[],
  chapterPlan: Pick<ChapterPlan, "graft" | "hasGivenChapters" | "titlesOnly">,
  allLines: readonly L0SubtitleLine[],
  endSeconds: number
): MergedRelayResult {
  const rawChapters: L1ChapterNode[] = [];
  const seenChapterFrom = new Set<number>();
  const rawQuotes: L1QuoteRef[] = [];
  const seenQuoteKey = new Set<string>();
  let finalStateCard: StateRelayCard | null = null;

  for (const step of steps) {
    if (!step) continue;
    finalStateCard = step.nextStateCard;
    for (const ch of step.chapters) {
      if (seenChapterFrom.has(ch.from)) {
        continue;
      }
      seenChapterFrom.add(ch.from);
      rawChapters.push(ch);
    }
    for (const q of step.quotes) {
      const key = `${q.lineNumber}:${q.content}`;
      if (seenQuoteKey.has(key)) {
        continue;
      }
      seenQuoteKey.add(key);
      rawQuotes.push(q);
    }
  }

  rawChapters.sort((a, b) => a.from - b.from);
  const clampedRawChapters = rawChapters.slice(0, MAX_ANALYSIS_CHAPTERS);

  const analysisChaptersInput: AnalysisChapter[] = clampedRawChapters.map((ch, idx) => ({
    from: ch.from,
    to: idx + 1 < clampedRawChapters.length ? clampedRawChapters[idx + 1].from : Math.max(ch.from, endSeconds),
    title: ch.title,
    summary: ch.coreThesis
  }));

  const graftedChapters = chapterPlan.graft(analysisChaptersInput);
  const entitiesByFrom = new Map<number, readonly string[]>();
  for (const ch of clampedRawChapters) {
    if (ch.keyEntities.length > 0) {
      entitiesByFrom.set(ch.from, ch.keyEntities);
    }
  }

  const sortedQuotes = rawQuotes
    .slice()
    .sort((a, b) => a.from - b.from || a.lineNumber - b.lineNumber)
    .slice(0, MAX_RELAY_QUOTES);

  const l1Chapters: L1ChapterNode[] = graftedChapters.map((ch, idx) => {
    const nextFrom = idx + 1 < graftedChapters.length ? graftedChapters[idx + 1].from : null;
    const to = Math.max(ch.from, ch.to || (nextFrom ?? endSeconds));
    const matchedEntities = findNearestEntities(ch.from, clampedRawChapters, entitiesByFrom);
    let startLineNumber: number | undefined;
    let endLineNumber: number | undefined;
    const isLast = idx === graftedChapters.length - 1;
    for (const line of allLines) {
      const inRange = isLast ? line.from >= ch.from && line.from <= to : line.from >= ch.from && line.from < to;
      if (inRange) {
        if (startLineNumber === undefined) startLineNumber = line.lineNumber;
        endLineNumber = line.lineNumber;
      }
    }
    return {
      chapterIndex: idx,
      title: ch.title,
      from: ch.from,
      to,
      coreThesis: ch.summary,
      keyEntities: matchedEntities,
      quoteLineNumbers: [],
      ...(startLineNumber !== undefined && endLineNumber !== undefined ? { startLineNumber, endLineNumber } : {}),
      ...(ch.missingSummary ? { missingSummary: true } : {})
    };
  });

  const chapterQuoteSets = l1Chapters.map(() => new Set<number>());
  const l1Quotes: L1QuoteRef[] = sortedQuotes.map((q) => {
    let ownerIdx: number | undefined;
    for (let i = 0; i < l1Chapters.length; i += 1) {
      if (l1Chapters[i].from <= q.from) {
        ownerIdx = i;
      } else {
        break;
      }
    }
    if (ownerIdx !== undefined && q.lineNumber >= 0) {
      chapterQuoteSets[ownerIdx].add(q.lineNumber);
    }
    return {
      from: q.from,
      content: q.content,
      lineNumber: q.lineNumber,
      ...(ownerIdx !== undefined ? { chapterIndex: ownerIdx } : {})
    };
  });

  const finalizedL1Chapters = l1Chapters.map((ch, idx) => ({
    ...ch,
    quoteLineNumbers: [...chapterQuoteSets[idx]].sort((a, b) => a - b)
  }));

  const uiQuotes: AnalysisQuote[] = l1Quotes.map((q) => ({
    from: q.from,
    content: q.content
  }));

  return {
    chapters: graftedChapters,
    quotes: uiQuotes,
    l1Chapters: finalizedL1Chapters,
    l1Quotes,
    finalStateCard
  };
}

function findNearestEntities(
  from: number,
  rawChapters: readonly L1ChapterNode[],
  entitiesByFrom: ReadonlyMap<number, readonly string[]>
): string[] {
  const exact = entitiesByFrom.get(from);
  if (exact) {
    return [...exact];
  }
  let bestEntities: readonly string[] = [];
  let bestDist = 45;
  for (const ch of rawChapters) {
    const dist = Math.abs(ch.from - from);
    if (dist <= bestDist && ch.keyEntities.length > 0) {
      bestDist = dist;
      bestEntities = ch.keyEntities;
    }
  }
  return [...bestEntities];
}

/**
 * 容错解析收尾全片简介响应：支持 JSON `{ summary }`、markdown 围栏、`<think>` 剥除，
 * 以及小模型未按 JSON 输出时的纯文本直取兜底。
 */
export function parseRelayFinalSummary(rawText: unknown): string {
  const cleaned = stripModelReasoningAndFences(rawText);
  if (!cleaned) {
    return "";
  }
  try {
    const parsed = parseLooseJson(cleaned);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const summary = clampText(obj.summary ?? obj.globalSummary ?? obj.overview ?? "", 2000);
      if (summary) {
        return summary;
      }
    }
  } catch {
    // 非 JSON 纯文本输出时直接兜底抽取自然段
  }
  const plain = cleaned
    .replace(/^```[\w]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/^[#*>\-\s]+/, "")
    .trim();
  if (!plain || (plain.startsWith("{") && plain.endsWith("}"))) {
    return "";
  }
  return clampText(plain, 2000);
}
