// extension/ai/l0-bm25.ts
// L0 词法基础原语与本地轻量 BM25 词法检索引擎（ADR-0027）：
// - 使用浏览器原生 Intl.Segmenter（granularity: "word"）切分中英混合与数字词元；
// - 内置精简常见中英文停用词过滤（中文停用词复用 ./stop-words.ts 单源）；
// - 局部文本相似度（bigram Dice + 词元重合）与 L0 行号/时间戳二分定位、秒级时间戳容错解析；
// - 纯 TypeScript 内存级 Okapi BM25 倒排索引，支持时间区间过滤与 Top-K 召回；
// - 命中行前后扩窗（支持 N 句或 M 秒窗口）与重叠/相邻时间片段去重合并。
// 零外部依赖、零 chrome/DOM/storage 依赖。

import { parseClock } from "../shared/clock-text.js";
import { getSharedZhWordSegmenter } from "../shared/text-primitives.js";
import { STOP_WORDS } from "./stop-words.js";
import type {
  L0ContextWindow,
  L0LexicalHit,
  L0LexicalSearchQuery,
  L0LexicalSearchResult,
  L0SubtitleLine,
  RetrievalTimeRange
} from "./long-video-hybrid-types.js";
import type { L1ChapterNode } from "./long-video-hybrid-types.js";

const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_TOP_K = 6;
const DEFAULT_WINDOW_RADIUS_LINES = 2;
const DEFAULT_MERGE_GAP_SECONDS = 1;

// 补充多字中文高频功能词/代词（单字/基础停用词复用 ./stop-words.ts）
const ZH_EXTRA_STOP_WORDS: ReadonlySet<string> = new Set([
  "我们", "你们", "他们", "她们", "它们", "大家", "自己",
  "这里", "那里", "哪里", "这样", "那样", "这么", "那么",
  "一种", "一个", "一些", "首先", "其次", "另外", "如果"
]);

// 精简常见英文停用词（中文停用词复用 ./stop-words.ts）
const EN_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "for", "from", "had",
  "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "may", "me", "might",
  "more", "most", "my", "no", "not", "of", "on", "or", "our", "out", "over",
  "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "under", "up", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "why", "will", "with", "would", "you", "your",
  "it's", "that's", "there's", "what's", "don't", "doesn't", "didn't",
  "can't", "won't", "i'm", "you're", "we're", "they're"
]);

const ZH_STOP_WORDS: ReadonlySet<string> = new Set([...STOP_WORDS, ...ZH_EXTRA_STOP_WORDS]);
const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isStopWord(token: string): boolean {
  return ZH_STOP_WORDS.has(token) || EN_STOP_WORDS.has(token);
}

/**
 * 使用浏览器原生 `Intl.Segmenter({ granularity: "word" })` 切分中英混合及数字词元，
 * 统一转小写并过滤标点、空白与常见中英文停用词。
 */
export function tokenizeLexicalText(text: unknown): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return [];
  }

  const wordSegmenter = getSharedZhWordSegmenter();
  const tokens: string[] = [];
  if (wordSegmenter) {
    for (const seg of wordSegmenter.segment(raw)) {
      if (!seg.isWordLike) {
        continue;
      }
      const normalized = seg.segment.trim().toLowerCase();
      if (!normalized || !HAS_WORD_CHAR_RE.test(normalized) || isStopWord(normalized)) {
        continue;
      }
      tokens.push(normalized);
    }
    return tokens;
  }

  // 非标准环境兜底切分：按连续 ASCII 字母数字串或单字切分
  const fallbackMatches = raw.toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)*|\p{L}|\p{N}/gu);
  if (!fallbackMatches) {
    return [];
  }
  for (const part of fallbackMatches) {
    if (!part || isStopWord(part)) {
      continue;
    }
    tokens.push(part);
  }
  return tokens;
}

/** 将字幕体输入归一化为按 `from` 升序、具备 0-based `lineNumber` 的 `L0SubtitleLine[]`。 */
export function normalizeL0SubtitleLines(
  items: ReadonlyArray<{ from?: unknown; to?: unknown; content?: unknown; lineNumber?: unknown }> | null | undefined
): L0SubtitleLine[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const normalized: L0SubtitleLine[] = [];
  for (const item of items) {
    const content = String(item?.content ?? "").trim();
    if (!content) {
      continue;
    }
    const fromRaw = Number(item?.from);
    const toRaw = Number(item?.to);
    const from = Number.isFinite(fromRaw) && fromRaw >= 0 ? fromRaw : 0;
    const to = Number.isFinite(toRaw) && toRaw >= from ? toRaw : from;
    normalized.push({
      lineNumber: normalized.length,
      from,
      to,
      content
    });
  }
  normalized.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 0; i < normalized.length; i += 1) {
    normalized[i].lineNumber = i;
  }
  return normalized;
}

export interface ExpandAndMergeOptions {
  /** 向前后扩展的字幕行数半径（N 句，默认 2） */
  windowRadiusLines?: number;
  /** 向前后扩展的时间窗口半径（M 秒，可选；传入时取行扩展与秒扩展的并集） */
  windowRadiusSeconds?: number;
  /** 相邻窗口允许合并的最大时间间隔（秒，默认 0，即首尾相接或行号相邻即合并） */
  mergeGapSeconds?: number;
}

export interface HitAnchorInput {
  lineNumber: number;
  score?: number;
}

interface RawExpandedSpan {
  startIdx: number;
  endIdx: number;
  anchorLineNumber: number;
  bestScore: number;
}

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
 * 计算模型提示片段与候选 L0 字幕行的局部相似度（0..1），用于行号轻微偏移与锚点容错对齐。
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

/**
 * 解析非负秒级时间戳：支持数字、纯数字字符串（向下取整）或 `M:SS` / `H:MM:SS` 时刻文本；
 * 非法或负值返回 `null`。
 */
export function parseL0SecondsValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }
    const clock = parseClock(trimmed);
    if (clock !== null) {
      return clock;
    }
  }
  return null;
}

/**
 * 按 0-based `lineNumber` 在按行号升序排列的 `L0SubtitleLine[]` 中定位数组下标；未命中返回 `-1`。
 */
export function findLineIndexByLineNumber(lines: readonly L0SubtitleLine[], lineNumber: number): number {
  if (!Array.isArray(lines) || lines.length === 0 || typeof lineNumber !== "number" || !Number.isFinite(lineNumber)) {
    return -1;
  }
  if (
    Number.isInteger(lineNumber) &&
    lineNumber >= 0 &&
    lineNumber < lines.length &&
    lines[lineNumber]?.lineNumber === lineNumber
  ) {
    return lineNumber;
  }
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const current = lines[mid].lineNumber;
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
 * 二分定位覆盖 `targetSeconds` 或起始时间距离最近的 L0 字幕行下标；空列表或非法时间戳返回 `-1`。
 */
export function findNearestLineIndexBySeconds(
  lines: readonly L0SubtitleLine[],
  targetSeconds: number
): number {
  if (!Array.isArray(lines) || lines.length === 0 || !Number.isFinite(targetSeconds)) {
    return -1;
  }
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].to < targetSeconds) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0) {
    const prev = lines[lo - 1];
    const curr = lines[lo];
    if (targetSeconds >= prev.from && targetSeconds <= prev.to) {
      return lo - 1;
    }
    if (Math.abs(prev.from - targetSeconds) < Math.abs(curr.from - targetSeconds)) {
      return lo - 1;
    }
  }
  return lo;
}

function expandSpanForAnchor(
  lines: readonly L0SubtitleLine[],
  anchorIdx: number,
  windowRadiusLines: number,
  windowRadiusSeconds: number
): { startIdx: number; endIdx: number } {
  let startIdx = Math.max(0, anchorIdx - windowRadiusLines);
  let endIdx = Math.min(lines.length - 1, anchorIdx + windowRadiusLines);

  if (windowRadiusSeconds > 0) {
    const anchor = lines[anchorIdx];
    const minFrom = Math.max(0, anchor.from - windowRadiusSeconds);
    const maxTo = Math.max(anchor.to, anchor.from) + windowRadiusSeconds;
    while (startIdx > 0 && lines[startIdx - 1].to > minFrom) {
      startIdx -= 1;
    }
    while (endIdx + 1 < lines.length && lines[endIdx + 1].from < maxTo) {
      endIdx += 1;
    }
  }

  return { startIdx, endIdx };
}

/**
 * 命中行前后扩窗与时间戳去重合并：
 * 支持按命中行向前后扩展 N 句（`windowRadiusLines`）或 M 秒（`windowRadiusSeconds`），
 * 并将重叠或相邻的区间合并为按序连续、无重复行的 `L0ContextWindow[]`。
 */
export function expandAndMergeHitWindows(
  lines: readonly L0SubtitleLine[],
  anchors: readonly (number | HitAnchorInput)[],
  options: ExpandAndMergeOptions = {}
): L0ContextWindow[] {
  if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(anchors) || anchors.length === 0) {
    return [];
  }

  const radiusLines = Math.max(0, Math.floor(Number(options.windowRadiusLines ?? DEFAULT_WINDOW_RADIUS_LINES) || 0));
  const rawSeconds = Number(options.windowRadiusSeconds ?? 0);
  const radiusSeconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  const rawGap = Number(options.mergeGapSeconds ?? DEFAULT_MERGE_GAP_SECONDS);
  const mergeGapSeconds = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : DEFAULT_MERGE_GAP_SECONDS;

  const spans: RawExpandedSpan[] = [];
  for (const rawAnchor of anchors) {
    const lineNumber = typeof rawAnchor === "number" ? rawAnchor : rawAnchor.lineNumber;
    const score = typeof rawAnchor === "number" ? 0 : Number(rawAnchor.score) || 0;
    const idx = findLineIndexByLineNumber(lines, lineNumber);
    if (idx < 0) {
      continue;
    }
    const { startIdx, endIdx } = expandSpanForAnchor(lines, idx, radiusLines, radiusSeconds);
    spans.push({
      startIdx,
      endIdx,
      anchorLineNumber: lines[idx].lineNumber,
      bestScore: score
    });
  }

  if (spans.length === 0) {
    return [];
  }

  spans.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);

  const merged: RawExpandedSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i += 1) {
    const next = spans[i];
    const current = merged[merged.length - 1];
    // 重叠行直接合并；紧邻行或时间间隔不超过 mergeGapSeconds 的相邻片段合并（避免跨长静音误并）
    const overlapsByLine = next.startIdx <= current.endIdx;
    const touchesByTime = lines[next.startIdx].from <= lines[current.endIdx].to + mergeGapSeconds;

    if (overlapsByLine || touchesByTime) {
      current.endIdx = Math.max(current.endIdx, next.endIdx);
      if (next.bestScore > current.bestScore) {
        current.bestScore = next.bestScore;
        current.anchorLineNumber = next.anchorLineNumber;
      }
    } else {
      merged.push({ ...next });
    }
  }

  return merged.map((span) => {
    const windowLines = lines.slice(span.startIdx, span.endIdx + 1);
    const first = windowLines[0];
    const last = windowLines[windowLines.length - 1];
    return {
      anchorLineNumber: span.anchorLineNumber,
      startLineNumber: first.lineNumber,
      endLineNumber: last.lineNumber,
      from: first.from,
      to: last.to,
      lines: windowLines
    };
  });
}

export interface CreateL0Bm25IndexOptions {
  k1?: number;
  b?: number;
  chapters?: readonly Pick<L1ChapterNode, "chapterIndex" | "from" | "to">[];
}

export interface L0Bm25SearchOptions extends L0LexicalSearchQuery {
  mergeGapSeconds?: number;
}

export interface L0Bm25Index {
  readonly lineCount: number;
  readonly avgDocLength: number;
  readonly vocabularySize: number;
  getLines(): readonly L0SubtitleLine[];
  search(queryOrOptions: string | L0Bm25SearchOptions): L0LexicalSearchResult;
}

interface Posting {
  docIdx: number;
  tf: number;
}

function matchesTimeRanges(line: L0SubtitleLine, ranges: readonly RetrievalTimeRange[] | undefined): boolean {
  if (!ranges || ranges.length === 0) {
    return true;
  }
  return ranges.some((range) => {
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return false;
    }
    return line.to >= from && line.from <= to;
  });
}

function findChapterIndexForLine(
  line: L0SubtitleLine,
  chapters: readonly Pick<L1ChapterNode, "chapterIndex" | "from" | "to">[] | undefined
): number | undefined {
  if (!chapters || chapters.length === 0) {
    return undefined;
  }
  let owner: number | undefined;
  for (const chapter of chapters) {
    if (line.from >= chapter.from && (chapter.to <= chapter.from || line.from < chapter.to)) {
      return chapter.chapterIndex;
    }
    if (chapter.from <= line.from) {
      owner = chapter.chapterIndex;
    }
  }
  return owner;
}

function extractQueryTerms(queryOrOptions: string | L0Bm25SearchOptions): string[] {
  const rawTerms: string[] = [];
  if (typeof queryOrOptions === "string") {
    rawTerms.push(...tokenizeLexicalText(queryOrOptions));
  } else {
    if (typeof queryOrOptions.query === "string" && queryOrOptions.query.trim()) {
      rawTerms.push(...tokenizeLexicalText(queryOrOptions.query));
    }
    if (Array.isArray(queryOrOptions.terms)) {
      for (const term of queryOrOptions.terms) {
        rawTerms.push(...tokenizeLexicalText(term));
      }
    }
  }
  return [...new Set(rawTerms)];
}

function computeWindowChars(window: L0ContextWindow): number {
  let chars = 0;
  for (const line of window.lines) {
    chars += line.content.length;
  }
  return chars;
}

/**
 * 构建纯内存级 L0 BM25 倒排索引。
 * 兼容传入已归一化的 `L0SubtitleLine[]` 或原始 `{ from, to, content }[]`。
 */
export function createL0Bm25Index(
  rawLines: ReadonlyArray<{ from?: unknown; to?: unknown; content?: unknown; lineNumber?: unknown }> | null | undefined,
  options: CreateL0Bm25IndexOptions = {}
): L0Bm25Index {
  const k1 = Number.isFinite(Number(options.k1)) && Number(options.k1) >= 0 ? Number(options.k1) : DEFAULT_BM25_K1;
  const b = Number.isFinite(Number(options.b)) && Number(options.b) >= 0 && Number(options.b) <= 1 ? Number(options.b) : DEFAULT_BM25_B;
  const chapters = options.chapters;

  const lines = normalizeL0SubtitleLines(rawLines);
  const docCount = lines.length;
  const docLengths = new Array<number>(docCount).fill(0);
  const invertedIndex = new Map<string, Posting[]>();

  let totalDocLength = 0;
  for (let docIdx = 0; docIdx < docCount; docIdx += 1) {
    const tokens = tokenizeLexicalText(lines[docIdx].content);
    docLengths[docIdx] = tokens.length;
    totalDocLength += tokens.length;
    if (tokens.length === 0) {
      continue;
    }

    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    for (const [term, tf] of termFreq.entries()) {
      let postings = invertedIndex.get(term);
      if (!postings) {
        postings = [];
        invertedIndex.set(term, postings);
      }
      postings.push({ docIdx, tf });
    }
  }

  const avgDocLength = docCount > 0 && totalDocLength > 0 ? totalDocLength / docCount : 1;
  const idfMap = new Map<string, number>();
  for (const [term, postings] of invertedIndex.entries()) {
    const df = postings.length;
    // 非负 Okapi BM25 IDF（Lucene 风格加 1 平滑），保证高频词不产生负分
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    idfMap.set(term, idf);
  }

  return {
    lineCount: docCount,
    avgDocLength: docCount > 0 ? totalDocLength / docCount : 0,
    vocabularySize: invertedIndex.size,

    getLines(): readonly L0SubtitleLine[] {
      return lines;
    },

    search(queryOrOptions: string | L0Bm25SearchOptions): L0LexicalSearchResult {
      const opts: L0Bm25SearchOptions = typeof queryOrOptions === "string" ? { query: queryOrOptions } : (queryOrOptions || {});
      const queryTerms = extractQueryTerms(queryOrOptions);

      if (docCount === 0 || queryTerms.length === 0) {
        return {
          hits: [],
          windows: [],
          totalLinesScanned: 0,
          injectedChars: 0,
          truncated: false
        };
      }

      const timeRanges = Array.isArray(opts.timeRanges) && opts.timeRanges.length > 0 ? opts.timeRanges : undefined;
      const topK = Math.max(1, Math.floor(Number(opts.topK ?? DEFAULT_TOP_K) || DEFAULT_TOP_K));
      const windowRadiusLines =
        opts.windowRadiusLines !== undefined
          ? Math.max(0, Math.floor(Number(opts.windowRadiusLines) || 0))
          : DEFAULT_WINDOW_RADIUS_LINES;
      const windowRadiusSeconds =
        opts.windowRadiusSeconds !== undefined && Number(opts.windowRadiusSeconds) > 0
          ? Number(opts.windowRadiusSeconds)
          : 0;
      const maxInjectedChars =
        opts.maxInjectedChars !== undefined && Number(opts.maxInjectedChars) > 0
          ? Math.floor(Number(opts.maxInjectedChars))
          : Number.POSITIVE_INFINITY;

      // 计算命中文档的 BM25 分数
      const scores = new Map<number, number>();
      const matchedMap = new Map<number, string[]>();

      for (const term of queryTerms) {
        const postings = invertedIndex.get(term);
        if (!postings) {
          continue;
        }
        const idf = idfMap.get(term) ?? 0;
        for (const { docIdx, tf } of postings) {
          if (timeRanges && !matchesTimeRanges(lines[docIdx], timeRanges)) {
            continue;
          }
          const dl = docLengths[docIdx];
          const norm = 1 - b + b * (dl / avgDocLength);
          const denom = tf + k1 * norm;
          const termScore = denom > 0 ? idf * ((tf * (k1 + 1)) / denom) : 0;
          if (termScore <= 0) {
            continue;
          }
          scores.set(docIdx, (scores.get(docIdx) ?? 0) + termScore);
          let matched = matchedMap.get(docIdx);
          if (!matched) {
            matched = [];
            matchedMap.set(docIdx, matched);
          }
          matched.push(term);
        }
      }

      const totalLinesScanned = timeRanges
        ? lines.reduce((acc, line) => acc + (matchesTimeRanges(line, timeRanges) ? 1 : 0), 0)
        : docCount;

      if (scores.size === 0) {
        return {
          hits: [],
          windows: [],
          totalLinesScanned,
          injectedChars: 0,
          truncated: false
        };
      }

      const ranked = [...scores.entries()]
        .map(([docIdx, score]) => ({
          docIdx,
          line: lines[docIdx],
          score,
          matchedTerms: matchedMap.get(docIdx) ?? []
        }))
        .sort((a, bScore) => bScore.score - a.score || a.line.lineNumber - bScore.line.lineNumber)
        .slice(0, topK);

      // 若存在总字符预算限制，按排名顺序逐步纳入命中并执行扩窗合并，超出即停止
      let selectedRanked = ranked;
      let mergedWindows = expandAndMergeHitWindows(
        lines,
        selectedRanked.map((r) => ({ lineNumber: r.line.lineNumber, score: r.score })),
        {
          windowRadiusLines,
          windowRadiusSeconds,
          mergeGapSeconds: opts.mergeGapSeconds
        }
      );

      let truncated = false;
      if (Number.isFinite(maxInjectedChars)) {
        const accepted: typeof ranked = [];
        let acceptedWindows: L0ContextWindow[] = [];
        for (const item of ranked) {
          const candidateRanked = [...accepted, item];
          const candidateWindows = expandAndMergeHitWindows(
            lines,
            candidateRanked.map((r) => ({ lineNumber: r.line.lineNumber, score: r.score })),
            {
              windowRadiusLines,
              windowRadiusSeconds,
              mergeGapSeconds: opts.mergeGapSeconds
            }
          );
          const candidateChars = candidateWindows.reduce((sum, win) => sum + computeWindowChars(win), 0);
          if (candidateChars <= maxInjectedChars || accepted.length === 0) {
            accepted.push(item);
            acceptedWindows = candidateWindows;
            if (candidateChars > maxInjectedChars) {
              // 单条首命中也超过预算时按窗口行裁剪兜底
              const singleWin = candidateWindows[0];
              if (singleWin) {
                const keptLines: L0SubtitleLine[] = [];
                let accChars = 0;
                for (const winLine of singleWin.lines) {
                  if (accChars + winLine.content.length <= maxInjectedChars || keptLines.length === 0) {
                    keptLines.push(winLine);
                    accChars += winLine.content.length;
                  } else {
                    break;
                  }
                }
                singleWin.lines = keptLines;
                singleWin.startLineNumber = keptLines[0].lineNumber;
                singleWin.endLineNumber = keptLines[keptLines.length - 1].lineNumber;
                singleWin.from = keptLines[0].from;
                singleWin.to = keptLines[keptLines.length - 1].to;
              }
              truncated = true;
              break;
            }
          } else {
            truncated = true;
            break;
          }
        }
        selectedRanked = accepted;
        mergedWindows = acceptedWindows;
      }

      const injectedChars = mergedWindows.reduce((sum, win) => sum + computeWindowChars(win), 0);
      const hits: L0LexicalHit[] = selectedRanked.map((item) => {
        const ownerWindow =
          mergedWindows.find(
            (w) => item.line.lineNumber >= w.startLineNumber && item.line.lineNumber <= w.endLineNumber
          ) ?? {
            anchorLineNumber: item.line.lineNumber,
            startLineNumber: item.line.lineNumber,
            endLineNumber: item.line.lineNumber,
            from: item.line.from,
            to: item.line.to,
            lines: [item.line]
          };
        return {
          line: item.line,
          score: item.score,
          matchedTerms: item.matchedTerms,
          chapterIndex: findChapterIndexForLine(item.line, chapters),
          window: ownerWindow
        };
      });

      return {
        hits,
        windows: mergedWindows,
        totalLinesScanned,
        injectedChars,
        truncated
      };
    }
  };
}

/**
 * 轻量 Token 估算（零外部依赖）：
 * 中文/CJK 按约 1.2 字符/Token 上界保守估算（不低估中文消费），
 * ASCII/数字按约 3.5 字符/Token 估算。
 */
export function estimateCompactPromptTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let cjkCount = 0;
  let otherCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.ceil(cjkCount + otherCount / 3.5);
}
