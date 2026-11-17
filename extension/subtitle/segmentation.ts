// extension/subtitle/segmentation.ts
// 纯函数智能断句与粗粒度字幕展平模块（参考 fishjar/kiss-translator 的
// youtubeSubtitleProcessing.js 与 sentenceBreaker.js）：
//   - expandCoarseEvents：秒/毫秒双向转换、重叠时间钳制、粗粒度中/西文块加权线性展平；
//   - mergeSubtitlesByRule：模式 A（规则智能合并 + 无标点超长句停顿词二次重切）；
//   - breakSubtitlesByStats：模式 B（MAD + Z-Score 统计分布断句）；
//   - shouldSegmentTrack / segmentSubtitles：按轨道类型与设置策略智能分派。

import { isNonSpeechSegment, isNoSpaceLanguage, joinSubtitleText } from "./text-classification.js";

export type SubtitleSegmentationStrategy = "auto" | "rule" | "stats" | "off";

export interface AtomicSubtitleEvent {
  text: string;
  startMs: number;
  endMs: number;
  isNonSpeech?: boolean;
}

export interface CoarseWordTimestamp {
  word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
  startMs?: unknown;
  endMs?: unknown;
}

export interface CoarseSubtitleInput {
  from?: unknown;
  to?: unknown;
  content?: unknown;
  words?: CoarseWordTimestamp[];
}

export interface SubtitleOutputItem {
  from: number;
  to: number;
  content: string;
}

export interface MergeRuleOptions {
  pauseTimeoutMs?: number;
  maxWords?: number;
  maxCjkChars?: number;
  maxDurationMs?: number;
  longSentenceThreshold?: number;
  usePause?: boolean;
  lang?: string;
}

export interface StatsBreakOptions {
  maxDurationMs?: number;
  scoreThreshold?: number;
  minWords?: number;
  minCjkChars?: number;
  minDurationMs?: number;
  lang?: string;
}

export interface SegmentTrackDecisionInput {
  strategy: SubtitleSegmentationStrategy;
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  items: readonly CoarseSubtitleInput[];
}

export interface SegmentSubtitlesOptions {
  strategy?: SubtitleSegmentationStrategy;
  selectedSubtitleId?: string;
  selectedSubtitleLang?: string;
  trackLan?: string;
  lang?: string;
  ruleOptions?: MergeRuleOptions;
  statsOptions?: StatsBreakOptions;
}

// 句末标点与句中逗号/停顿标点（允许末尾紧跟闭合引号/括号）
const SENTENCE_END_RE = /[。！？.!?…]["'”’」』）\])]*$/u;
const COMMA_END_RE = /[,，、]["'”’」』）\])]*$/u;
const STATS_CLAUSE_END_RE = /[，、；：,;]["'”’」』）\])]*$/u;
const CJK_INTERNAL_SPLIT_PUNCT_RE = /([，、；：,]+)/u;

// 英文口语停顿词集合（二次重切兜底）
export const EN_PAUSE_WORDS: ReadonlySet<string> = new Set([
  "actually",
  "also",
  "although",
  "and",
  "anyway",
  "as",
  "basically",
  "because",
  "but",
  "eventually",
  "frankly",
  "honestly",
  "hopefully",
  "however",
  "if",
  "instead",
  "it's",
  "just",
  "let's",
  "like",
  "literally",
  "maybe",
  "meanwhile",
  "nevertheless",
  "nonetheless",
  "now",
  "okay",
  "or",
  "otherwise",
  "perhaps",
  "personally",
  "probably",
  "right",
  "since",
  "so",
  "suddenly",
  "that's",
  "then",
  "there's",
  "therefore",
  "though",
  "thus",
  "unless",
  "until",
  "well",
  "while"
]);

// 中文口语停顿/转折前导词集合（按长度降序排列以保证最长前缀优先匹配）
export const ZH_PAUSE_WORDS: readonly string[] = [
  "换句话说",
  "也就是说",
  "实际上",
  "接下来",
  "比如说",
  "但是",
  "不过",
  "所以",
  "因此",
  "其实",
  "另外",
  "而且",
  "甚至",
  "相反",
  "同时",
  "那么",
  "比如",
  "因为",
  "如果",
  "虽然",
  "尽管"
];

const ZH_PAUSE_BOUNDARY_RE = new RegExp(`(${ZH_PAUSE_WORDS.join("|")})`, "gu");

const DEFAULT_PAUSE_TIMEOUT_MS = 1000;
const DEFAULT_MAX_WORDS = 15;
const DEFAULT_MAX_CJK_CHARS = 30;
const DEFAULT_RULE_MAX_DURATION_MS = 10000;
const DEFAULT_EN_LONG_SENTENCE_THRESHOLD = 100;
const DEFAULT_CJK_LONG_SENTENCE_THRESHOLD = 42;

const DEFAULT_STATS_MAX_DURATION_MS = 7000;
const DEFAULT_STATS_SCORE_THRESHOLD = 1.2;
const DEFAULT_STATS_MIN_WORDS = 4;
const DEFAULT_STATS_MIN_CJK_CHARS = 6;
const DEFAULT_STATS_MIN_DURATION_MS = 500;

const CJK_MAX_ATOMIC_CHARS = 8;
const CJK_TARGET_ATOMIC_CHARS = 6;

const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

function secToMs(sec: unknown): number {
  const n = Number(sec ?? 0);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.round(n * 1000);
}

function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.round(ms) / 1000;
}

function countWesternWords(text: string): number {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return 0;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let count = 0;
  for (const token of tokens) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      count += 1;
    }
  }
  return count;
}

function countCompactChars(text: string): number {
  return String(text ?? "").replace(/\s+/g, "").length;
}

function normalizeEnglishTokenForPause(token: string): string {
  return String(token ?? "")
    .trim()
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^[^a-z']+|[^a-z']+$/g, "");
}

function isPauseWord(text: string, isCjk: boolean): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return false;
  }
  if (isCjk) {
    return ZH_PAUSE_WORDS.some((word) => trimmed.startsWith(word));
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  return EN_PAUSE_WORDS.has(normalizeEnglishTokenForPause(firstToken));
}

function computeEffectiveEndMs(
  startMs: number,
  rawEndMs: number,
  nextStartMs: number | null
): number {
  const safeEnd = Math.max(startMs, rawEndMs);
  if (nextStartMs !== null && safeEnd > nextStartMs && nextStartMs > startMs) {
    return Math.min(safeEnd, nextStartMs);
  }
  return safeEnd;
}

function distributeTimeWindow(
  pieces: readonly string[],
  startMs: number,
  endMs: number
): AtomicSubtitleEvent[] {
  const cleaned = pieces.map((piece) => piece.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return [];
  }
  if (cleaned.length === 1) {
    const text = cleaned[0];
    return [
      {
        text,
        startMs,
        endMs: Math.max(startMs, endMs),
        ...(isNonSpeechSegment(text) ? { isNonSpeech: true } : {})
      }
    ];
  }

  const safeEnd = Math.max(startMs, endMs);
  const totalDuration = safeEnd - startMs;
  const weights = cleaned.map((piece) => Math.max(1, piece.length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const out: AtomicSubtitleEvent[] = [];
  let cursorStart = startMs;
  let accumulatedWeight = 0;

  for (let i = 0; i < cleaned.length; i += 1) {
    accumulatedWeight += weights[i];
    const cursorEnd =
      i === cleaned.length - 1
        ? safeEnd
        : Math.max(cursorStart, startMs + Math.round((totalDuration * accumulatedWeight) / totalWeight));
    const piece = cleaned[i];
    out.push({
      text: piece,
      startMs: cursorStart,
      endMs: cursorEnd,
      ...(isNonSpeechSegment(piece) ? { isNonSpeech: true } : {})
    });
    cursorStart = cursorEnd;
  }

  return out;
}

function segmentCjkWords(text: string): string[] {
  if (!wordSegmenter) {
    return Array.from(text);
  }
  const words: string[] = [];
  for (const seg of wordSegmenter.segment(text)) {
    if (seg.segment) {
      words.push(seg.segment);
    }
  }
  return words.length > 0 ? words : Array.from(text);
}

function splitLongCjkPiece(piece: string): string[] {
  if (piece.length <= CJK_MAX_ATOMIC_CHARS) {
    return [piece];
  }

  // 若以中文停顿词开头，保留停顿词在首片头部，并拆成不超过目标长度的词组片段
  const words = segmentCjkWords(piece);
  const out: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > CJK_MAX_ATOMIC_CHARS) {
      if (current) {
        out.push(current);
        current = "";
      }
      const chars = Array.from(word);
      for (let i = 0; i < chars.length; i += CJK_TARGET_ATOMIC_CHARS) {
        out.push(chars.slice(i, i + CJK_TARGET_ATOMIC_CHARS).join(""));
      }
      continue;
    }

    if (current && current.length + word.length > CJK_TARGET_ATOMIC_CHARS) {
      out.push(current);
      current = word;
    } else {
      current += word;
    }
  }

  if (current) {
    out.push(current);
  }

  return out;
}

function splitCjkTextIntoFragments(text: string): string[] {
  const spaceGroups = text.split(/\s+/).filter(Boolean);
  const punctClauses: string[] = [];

  // 第一步：按内部停顿标点切分，标点粘连在前一小句尾部
  for (const group of spaceGroups) {
    const parts = group.split(CJK_INTERNAL_SPLIT_PUNCT_RE).filter(Boolean);
    for (const part of parts) {
      if (/^[，、；：,]+$/u.test(part) && punctClauses.length > 0) {
        punctClauses[punctClauses.length - 1] += part;
      } else {
        punctClauses.push(part);
      }
    }
  }

  // 第二步：按中文高频口语停顿/转折词边界切分，使连接词位于新片段起点
  const pauseSplit: string[] = [];
  for (const clause of punctClauses) {
    const matches = [...clause.matchAll(ZH_PAUSE_BOUNDARY_RE)];
    if (matches.length === 0) {
      pauseSplit.push(clause);
      continue;
    }
    let lastIndex = 0;
    for (const match of matches) {
      const idx = match.index ?? 0;
      if (idx > lastIndex) {
        const before = clause.slice(lastIndex, idx);
        if (before) {
          pauseSplit.push(before);
        }
        lastIndex = idx;
      }
    }
    const tail = clause.slice(lastIndex);
    if (tail) {
      pauseSplit.push(tail);
    }
  }

  // 第三步：超长无标点碎片继续按自然语素拆成 <= 6～8 字小粒度事件
  const fragments: string[] = [];
  for (const piece of pauseSplit) {
    fragments.push(...splitLongCjkPiece(piece));
  }

  return fragments.filter(Boolean);
}

function hasInternalPauseConjunction(text: string): boolean {
  for (const word of ZH_PAUSE_WORDS) {
    const idx = text.indexOf(word);
    if (idx > 0 || (idx === 0 && text.length > word.length + 2)) {
      return true;
    }
  }
  return false;
}

function resolveWordTimestamps(
  words: CoarseWordTimestamp[],
  parentStartMs: number,
  parentEndMs: number
): AtomicSubtitleEvent[] {
  const out: AtomicSubtitleEvent[] = [];
  for (const item of words) {
    const wordText = String(item?.word ?? item?.text ?? "").trim();
    if (!wordText) {
      continue;
    }
    const rawStartMs = Number.isFinite(Number(item?.startMs))
      ? Math.round(Number(item.startMs))
      : secToMs(item?.start);
    const rawEndMs = Number.isFinite(Number(item?.endMs))
      ? Math.round(Number(item.endMs))
      : secToMs(item?.end);

    if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
      continue;
    }

    const startMs = Math.max(parentStartMs, Math.min(parentEndMs, rawStartMs));
    const endMs = Math.max(startMs, Math.min(parentEndMs, rawEndMs));
    out.push({
      text: wordText,
      startMs,
      endMs,
      ...(isNonSpeechSegment(wordText) ? { isNonSpeech: true } : {})
    });
  }
  return out;
}

/**
 * 将 `{ from, to, content }`（秒级）无损转换为毫秒级 `AtomicSubtitleEvent[]`，
 * 并执行相邻项有效结束时间钳制（`effectiveEndMs = Math.min(endMs, nextItem.startMs)`）。
 */
export function toAtomicSubtitleEvents(items: readonly CoarseSubtitleInput[]): AtomicSubtitleEvent[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const out: AtomicSubtitleEvent[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const text = String(item?.content ?? "").trim();
    if (!text) {
      continue;
    }
    const startMs = secToMs(item?.from);
    const rawEndMs = secToMs(item?.to);
    const nextStartMs = i + 1 < items.length ? secToMs(items[i + 1]?.from) : null;
    const endMs = computeEffectiveEndMs(startMs, rawEndMs, nextStartMs);
    out.push({
      text,
      startMs,
      endMs,
      ...(isNonSpeechSegment(text) ? { isNonSpeech: true } : {})
    });
  }
  return out;
}

/**
 * 将毫秒级 `AtomicSubtitleEvent[]` 无损转换回 `{ from, to, content }`（秒级）。
 */
export function fromAtomicSubtitleEvents(events: readonly AtomicSubtitleEvent[]): SubtitleOutputItem[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  const out: SubtitleOutputItem[] = [];
  for (const ev of events) {
    const content = String(ev?.text ?? "").trim();
    if (!content) {
      continue;
    }
    const startMs = Math.max(0, Math.round(Number(ev.startMs) || 0));
    const endMs = Math.max(startMs, Math.round(Number(ev.endMs) || 0));
    out.push({
      from: msToSec(startMs),
      to: msToSec(endMs),
      content
    });
  }
  return out;
}

/**
 * 统一细粒度事件中间结构转换与粗粒度块加权线性展平：
 *   - 钳制重叠结束时间；
 *   - 优先保留已有的词级 `words` 时间戳；
 *   - 对粗粒度西文（词数 > 3）或粗粒度中日韩文（字符数 > 6 且含内部分隔/停顿连词，或超长无标点长串）
 *     按字符长度权重线性切分为连续原子事件。
 */
export function expandCoarseEvents(
  items: readonly CoarseSubtitleInput[],
  lang?: string
): AtomicSubtitleEvent[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const out: AtomicSubtitleEvent[] = [];
  const langIsNoSpace = isNoSpaceLanguage(lang);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const text = String(item?.content ?? "").trim();
    if (!text) {
      continue;
    }
    const startMs = secToMs(item?.from);
    const rawEndMs = secToMs(item?.to);
    const nextStartMs = i + 1 < items.length ? secToMs(items[i + 1]?.from) : null;
    const effectiveEndMs = computeEffectiveEndMs(startMs, rawEndMs, nextStartMs);

    if (isNonSpeechSegment(text)) {
      out.push({
        text,
        startMs,
        endMs: effectiveEndMs,
        isNonSpeech: true
      });
      continue;
    }

    if (Array.isArray(item?.words) && item.words.length > 0) {
      const wordEvents = resolveWordTimestamps(item.words, startMs, effectiveEndMs);
      if (wordEvents.length > 0) {
        out.push(...wordEvents);
        continue;
      }
    }

    const isCjk = langIsNoSpace || isNoSpaceLanguage(text);
    if (!isCjk) {
      const tokens = text.split(/\s+/).filter(Boolean);
      if (tokens.length > 3) {
        out.push(...distributeTimeWindow(tokens, startMs, effectiveEndMs));
        continue;
      }
      out.push({ text, startMs, endMs: effectiveEndMs });
      continue;
    }

    const compactLen = countCompactChars(text);
    const hasInternalSeparator = /[，、；：,\s]/u.test(text.slice(0, -1));
    const isCoarseCjk =
      (compactLen > 6 && (hasInternalSeparator || hasInternalPauseConjunction(text))) ||
      compactLen > DEFAULT_MAX_CJK_CHARS;

    if (isCoarseCjk) {
      const fragments = splitCjkTextIntoFragments(text);
      if (fragments.length > 1) {
        out.push(...distributeTimeWindow(fragments, startMs, effectiveEndMs));
        continue;
      }
    }

    out.push({ text, startMs, endMs: effectiveEndMs });
  }

  return out;
}

function joinEventBuffer(events: readonly AtomicSubtitleEvent[], lang?: string): string {
  let acc = "";
  for (const ev of events) {
    acc = joinSubtitleText(acc, ev.text, lang);
  }
  return acc;
}

function measureBuffer(events: readonly AtomicSubtitleEvent[], lang?: string): {
  joinedText: string;
  isCjk: boolean;
  wordCount: number;
  cjkChars: number;
} {
  const joinedText = joinEventBuffer(events, lang);
  const isCjk = isNoSpaceLanguage(lang) || isNoSpaceLanguage(joinedText);
  return {
    joinedText,
    isCjk,
    wordCount: isCjk ? 0 : countWesternWords(joinedText),
    cjkChars: isCjk ? countCompactChars(joinedText) : 0
  };
}

function mergeSubtitlesByRuleInternal(
  events: readonly AtomicSubtitleEvent[],
  options: MergeRuleOptions,
  allowSecondaryResplit: boolean
): AtomicSubtitleEvent[] {
  const pauseTimeoutMs = options.pauseTimeoutMs ?? DEFAULT_PAUSE_TIMEOUT_MS;
  const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
  const maxCjkChars = options.maxCjkChars ?? DEFAULT_MAX_CJK_CHARS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_RULE_MAX_DURATION_MS;
  const usePause = options.usePause === true;
  const lang = options.lang;

  const result: AtomicSubtitleEvent[] = [];
  let buffer: AtomicSubtitleEvent[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    const { joinedText, isCjk } = measureBuffer(buffer, lang);
    const threshold =
      options.longSentenceThreshold ??
      (isCjk ? DEFAULT_CJK_LONG_SENTENCE_THRESHOLD : DEFAULT_EN_LONG_SENTENCE_THRESHOLD);

    if (allowSecondaryResplit && !usePause && joinedText.length > threshold && buffer.length > 1) {
      const resplit = mergeSubtitlesByRuleInternal(
        buffer,
        { ...options, usePause: true },
        false
      );
      result.push(...resplit);
      buffer = [];
      return;
    }

    result.push({
      text: joinedText,
      startMs: buffer[0].startMs,
      endMs: buffer[buffer.length - 1].endMs
    });
    buffer = [];
  };

  for (const rawEv of events) {
    const text = String(rawEv?.text ?? "").trim();
    if (!text) {
      continue;
    }
    const ev: AtomicSubtitleEvent = {
      text,
      startMs: Math.max(0, Math.round(Number(rawEv.startMs) || 0)),
      endMs: Math.max(0, Math.round(Number(rawEv.endMs) || 0)),
      ...(rawEv.isNonSpeech || isNonSpeechSegment(text) ? { isNonSpeech: true } : {})
    };
    if (ev.endMs < ev.startMs) {
      ev.endMs = ev.startMs;
    }

    if (ev.isNonSpeech) {
      flushBuffer();
      result.push(ev);
      continue;
    }

    if (buffer.length > 0) {
      const prev = buffer[buffer.length - 1];
      const gapMs = ev.startMs - prev.endMs;
      const durationMs = ev.endMs - buffer[0].startMs;
      const { isCjk, wordCount, cjkChars } = measureBuffer(buffer, lang);
      const reachedLimit = isCjk ? cjkChars >= maxCjkChars : wordCount >= maxWords;

      const shouldFlush =
        SENTENCE_END_RE.test(prev.text) ||
        gapMs > pauseTimeoutMs ||
        durationMs > maxDurationMs ||
        (COMMA_END_RE.test(prev.text) && reachedLimit) ||
        (usePause && (reachedLimit || (buffer.length >= 2 && isPauseWord(ev.text, isCjk))));

      if (shouldFlush) {
        flushBuffer();
      }
    }

    buffer.push(ev);
  }

  flushBuffer();
  return result;
}

/**
 * 模式 A：规则智能合并 + 无标点超长句停顿词二次重切兜底。
 */
export function mergeSubtitlesByRule(
  events: readonly AtomicSubtitleEvent[],
  options: MergeRuleOptions = {}
): AtomicSubtitleEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  return mergeSubtitlesByRuleInternal(events, options, true);
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 模式 B：MAD + Z-Score 统计分布断句（参考 kiss-translator sentenceBreaker.js）。
 */
export function breakSubtitlesByStats(
  events: readonly AtomicSubtitleEvent[],
  options: StatsBreakOptions = {}
): AtomicSubtitleEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const maxDurationMs = options.maxDurationMs ?? DEFAULT_STATS_MAX_DURATION_MS;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_STATS_SCORE_THRESHOLD;
  const minWords = options.minWords ?? DEFAULT_STATS_MIN_WORDS;
  const minCjkChars = options.minCjkChars ?? DEFAULT_STATS_MIN_CJK_CHARS;
  const minDurationMs = options.minDurationMs ?? DEFAULT_STATS_MIN_DURATION_MS;
  const lang = options.lang;

  const normalized: AtomicSubtitleEvent[] = [];
  for (const rawEv of events) {
    const text = String(rawEv?.text ?? "").trim();
    if (!text) {
      continue;
    }
    const startMs = Math.max(0, Math.round(Number(rawEv.startMs) || 0));
    const endMs = Math.max(startMs, Math.round(Number(rawEv.endMs) || 0));
    normalized.push({
      text,
      startMs,
      endMs,
      ...(rawEv.isNonSpeech || isNonSpeechSegment(text) ? { isNonSpeech: true } : {})
    });
  }

  if (normalized.length === 0) {
    return [];
  }

  // 计算相邻语音事件正向停顿间隔的中位数与 MAD
  const positiveGaps: number[] = [];
  for (let i = 1; i < normalized.length; i += 1) {
    const prev = normalized[i - 1];
    const curr = normalized[i];
    if (prev.isNonSpeech || curr.isNonSpeech) {
      continue;
    }
    const gap = curr.startMs - prev.endMs;
    if (gap > 0) {
      positiveGaps.push(gap);
    }
  }

  const median = computeMedian(positiveGaps);
  const mad = computeMedian(positiveGaps.map((gap) => Math.abs(gap - median)));
  const scale = mad > 0 ? 1.4826 * mad : Math.max(100, median * 0.5);

  const result: AtomicSubtitleEvent[] = [];
  let buffer: AtomicSubtitleEvent[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) {
      return;
    }
    result.push({
      text: joinEventBuffer(buffer, lang),
      startMs: buffer[0].startMs,
      endMs: buffer[buffer.length - 1].endMs
    });
    buffer = [];
  };

  for (const curr of normalized) {
    if (curr.isNonSpeech) {
      flushBuffer();
      result.push(curr);
      continue;
    }

    if (buffer.length > 0) {
      const prev = buffer[buffer.length - 1];
      const totalDurationWithCurr = curr.endMs - buffer[0].startMs;

      if (totalDurationWithCurr > maxDurationMs) {
        flushBuffer();
      } else {
        const gapMs = curr.startMs - prev.endMs;
        const pauseScore =
          gapMs > 0 && positiveGaps.length > 0
            ? Math.max(0, (gapMs - median) / scale)
            : 0;

        let punctScore = 0;
        if (SENTENCE_END_RE.test(prev.text)) {
          punctScore = 2.5;
        } else if (STATS_CLAUSE_END_RE.test(prev.text)) {
          punctScore = 1.0;
        }

        const { isCjk, wordCount, cjkChars } = measureBuffer(buffer, lang);
        const hintScore = isCjk
          ? (isPauseWord(curr.text, true) ? 0.5 : 0)
          : (/^[A-Z]/u.test(curr.text) ? 0.5 : 0);

        const totalScore = pauseScore + punctScore + hintScore;
        const bufferDurationMs = prev.endMs - buffer[0].startMs;
        const meetsMinLength =
          bufferDurationMs >= minDurationMs &&
          (isCjk ? cjkChars >= minCjkChars : wordCount >= minWords);

        if (totalScore >= scoreThreshold && meetsMinLength) {
          flushBuffer();
        }
      }
    }

    buffer.push(curr);
  }

  flushBuffer();
  return result;
}

/**
 * 评估非 AI/ASR 轨道的标点密度是否正常：
 *   - 极短样本（< 10 条且总字符数 < 150）默认视作正常，避免误伤精简测试集或极短视频；
 *   - 正常规模字幕若 >= 15% 条目含标点或总标点密度 >= 1%，视为标点正常（不强行重断人工 CC 轨）。
 */
export function hasNormalPunctuationDensity(items: readonly CoarseSubtitleInput[]): boolean {
  if (!Array.isArray(items) || items.length === 0) {
    return true;
  }
  let cueCount = 0;
  let punctuatedCues = 0;
  let totalChars = 0;
  let punctCount = 0;

  for (const item of items) {
    const text = String(item?.content ?? "").trim();
    if (!text || isNonSpeechSegment(text)) {
      continue;
    }
    cueCount += 1;
    totalChars += text.length;
    const matches = text.match(/[。！？.!?…，、；：,;]/gu);
    if (matches && matches.length > 0) {
      punctuatedCues += 1;
      punctCount += matches.length;
    }
  }

  if (cueCount === 0) {
    return true;
  }
  if (cueCount < 10 && totalChars < 150) {
    return true;
  }
  return punctuatedCues / cueCount >= 0.15 || (totalChars > 0 && punctCount / totalChars >= 0.01);
}

/**
 * 根据设置策略与轨道身份判定是否执行本地断句。
 */
export function shouldSegmentTrack({
  strategy,
  selectedSubtitleId = "",
  selectedSubtitleLang = "",
  trackLan = "",
  items
}: SegmentTrackDecisionInput): boolean {
  if (strategy === "off" || !Array.isArray(items) || items.length === 0) {
    return false;
  }
  if (strategy === "rule" || strategy === "stats") {
    return true;
  }

  // auto 模式：B 站 AI 字幕轨（lan 以 ai- 开头）及 ASR 伪轨自动执行断句
  const idLower = String(selectedSubtitleId || "").trim().toLowerCase();
  const langLower = String(selectedSubtitleLang || "").trim().toLowerCase();
  const lanLower = String(trackLan || "").trim().toLowerCase();

  const isAiTrack = lanLower.startsWith("ai-") || langLower.startsWith("ai-");
  const isAsrTrack = idLower === "asr" || lanLower.startsWith("asr-") || langLower.startsWith("asr-");

  if (isAiTrack || isAsrTrack) {
    return true;
  }

  // 原生人工 CC 轨：标点密度正常时保持原样；缺失标点的粗长/碎片轨才兜底重断
  return !hasNormalPunctuationDensity(items);
}

/**
 * 字幕预处理断句主入口：策略判定 → 粗粒度展平 → 模式 A/B 断句 → 转换回 `{ from, to, content }[]`。
 */
export function segmentSubtitles(
  items: readonly CoarseSubtitleInput[],
  options: SegmentSubtitlesOptions = {}
): SubtitleOutputItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const strategy = options.strategy ?? "auto";
  const effectiveLang = options.lang ?? options.trackLan ?? options.selectedSubtitleLang;

  if (
    !shouldSegmentTrack({
      strategy,
      selectedSubtitleId: options.selectedSubtitleId,
      selectedSubtitleLang: options.selectedSubtitleLang,
      trackLan: options.trackLan,
      items
    })
  ) {
    return items.map((item) => ({
      from: Number(item?.from ?? 0) || 0,
      to: Number(item?.to ?? 0) || 0,
      content: String(item?.content ?? "")
    }));
  }

  const atomicEvents = expandCoarseEvents(items, effectiveLang);
  const segmentedEvents =
    strategy === "stats"
      ? breakSubtitlesByStats(atomicEvents, { ...options.statsOptions, lang: effectiveLang })
      : mergeSubtitlesByRule(atomicEvents, { ...options.ruleOptions, lang: effectiveLang });

  return fromAtomicSubtitleEvents(segmentedEvents);
}
