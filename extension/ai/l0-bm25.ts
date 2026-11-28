import { parseClock } from "../shared/clock-text.js";
import { fnv1a32, getSharedZhWordSegmenter } from "../shared/text-primitives.js";
import { STOP_WORDS } from "./stop-words.js";
import type {
  L0ChunkHit,
  L0ContextWindow,
  L0LexicalHit,
  L0LexicalSearchQuery,
  L0LexicalSearchResult,
  L0SemanticChunk,
  L0SubtitleLine,
  RetrievalTimeRange
} from "./long-video-hybrid-types.js";
import type { L1ChapterNode } from "./long-video-hybrid-types.js";
import type { ChapterItem } from "./types.js";

const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;
const DEFAULT_TOP_K = 6;
const DEFAULT_WINDOW_RADIUS_LINES = 2;
const DEFAULT_MERGE_GAP_SECONDS = 1;

export const DEFAULT_SEMANTIC_CHUNK_TARGET_SECONDS = 25;
export const DEFAULT_SEMANTIC_CHUNK_OVERLAP_SECONDS = 5;
export const DEFAULT_SEMANTIC_CHUNK_MAX_CHARS = 600;
export const WORD_TOKEN_WEIGHT = 1.0;
export const CHAR_BIGRAM_WEIGHT = 0.45;
export const DEFAULT_QUERY_EXPANSION_WEIGHT = 0.35;
export const MAX_CACHED_BM25_VIDEOS = 3;

const CJK_RUN_RE = /[\u4e00-\u9fff]{2,}/g;
const BIGRAM_KEY_PREFIX = "bg:";

const ZH_EXTRA_STOP_WORDS: ReadonlySet<string> = new Set([
  "我们", "你们", "他们", "她们", "它们", "大家", "自己",
  "这里", "那里", "哪里", "这样", "那样", "这么", "那么",
  "一种", "一个", "一些", "首先", "其次", "另外", "如果"
]);

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
  windowRadiusLines?: number;
  windowRadiusSeconds?: number;
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

function normalizeForSimilarity(text: unknown): string {
  return String(text ?? "").toLowerCase().replace(STRIP_FOR_SIM_RE, "");
}

export function matchChapterByTitle(prompt: unknown, chapters: readonly unknown[]): ChapterItem[] {
  try {
    const needle = normalizeForSimilarity(prompt);
    if (!needle || !Array.isArray(chapters)) return [];
    const hits: ChapterItem[] = [];
    for (const chapter of chapters) {
      if (!chapter || typeof chapter !== "object") continue;
      const title = normalizeForSimilarity((chapter as ChapterItem).title);
      if (!title) continue;
      if (needle.includes(title)) hits.push(chapter as ChapterItem);
    }
    return hits;
  } catch {
    return [];
  }
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

export interface DualGranularityToken {
  key: string;
  term: string;
  weight: number;
  isBigram: boolean;
}

export function tokenizeDualGranularity(text: unknown): DualGranularityToken[] {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return [];
  }
  const out: DualGranularityToken[] = [];
  const words = tokenizeLexicalText(raw);
  for (const word of words) {
    out.push({
      key: word,
      term: word,
      weight: WORD_TOKEN_WEIGHT,
      isBigram: false
    });
  }
  CJK_RUN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CJK_RUN_RE.exec(raw)) !== null) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (isStopWord(bigram)) {
        continue;
      }
      out.push({
        key: `${BIGRAM_KEY_PREFIX}${bigram}`,
        term: bigram,
        weight: CHAR_BIGRAM_WEIGHT,
        isBigram: true
      });
    }
  }
  return out;
}

export interface SemanticChunkChapterInput {
  chapterIndex?: number;
  title?: unknown;
  from?: unknown;
  to?: unknown;
  coreThesis?: unknown;
  keyEntities?: readonly unknown[];
}

export interface BuildL0SemanticChunksOptions {
  targetSeconds?: number;
  overlapSeconds?: number;
  maxChars?: number;
}

interface NormalizedChunkChapter {
  chapterIndex: number;
  title: string;
  from: number;
  to: number;
  coreThesis: string;
  keyEntities: string[];
  contextPrefix: string;
}

function normalizeChunkChapters(
  chapters: readonly SemanticChunkChapterInput[] | undefined
): NormalizedChunkChapter[] {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return [];
  }
  const normalized: NormalizedChunkChapter[] = [];
  for (let i = 0; i < chapters.length; i += 1) {
    const raw = chapters[i];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const from = Number(raw.from);
    if (!Number.isFinite(from) || from < 0) {
      continue;
    }
    const toRaw = Number(raw.to);
    const to = Number.isFinite(toRaw) && toRaw >= from ? toRaw : from;
    const title = String(raw.title ?? "").trim();
    const coreThesis = String(raw.coreThesis ?? "").trim();
    const keyEntities = Array.isArray(raw.keyEntities)
      ? raw.keyEntities.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
      : [];
    const prefixParts = [title, coreThesis, keyEntities.join(" ")].filter(Boolean);
    normalized.push({
      chapterIndex: typeof raw.chapterIndex === "number" && Number.isInteger(raw.chapterIndex) ? raw.chapterIndex : i,
      title,
      from,
      to,
      coreThesis,
      keyEntities,
      contextPrefix: prefixParts.join(" ")
    });
  }
  normalized.sort((a, b) => a.from - b.from || a.chapterIndex - b.chapterIndex);
  return normalized;
}

function findOwnerChapterForSeconds(
  chapters: readonly NormalizedChunkChapter[],
  seconds: number
): NormalizedChunkChapter | undefined {
  if (chapters.length === 0) {
    return undefined;
  }
  let owner: NormalizedChunkChapter | undefined;
  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i];
    const isLast = i === chapters.length - 1;
    if (seconds >= ch.from && (isLast ? seconds <= Math.max(ch.to, ch.from) : seconds < ch.to)) {
      return ch;
    }
    if (ch.from <= seconds) {
      owner = ch;
    }
  }
  return owner ?? chapters[0];
}

export function buildL0SemanticChunks(
  lines: readonly L0SubtitleLine[],
  chaptersOrBuckets?: readonly SemanticChunkChapterInput[],
  options: BuildL0SemanticChunksOptions = {}
): L0SemanticChunk[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }
  const targetSeconds =
    Number(options.targetSeconds) > 0
      ? Number(options.targetSeconds)
      : DEFAULT_SEMANTIC_CHUNK_TARGET_SECONDS;
  const rawOverlap = Number(options.overlapSeconds ?? DEFAULT_SEMANTIC_CHUNK_OVERLAP_SECONDS);
  const overlapSeconds = Number.isFinite(rawOverlap) && rawOverlap >= 0 ? Math.min(rawOverlap, targetSeconds * 0.8) : DEFAULT_SEMANTIC_CHUNK_OVERLAP_SECONDS;
  const maxChars =
    Number(options.maxChars) > 0
      ? Math.floor(Number(options.maxChars))
      : DEFAULT_SEMANTIC_CHUNK_MAX_CHARS;

  const chapters = normalizeChunkChapters(chaptersOrBuckets);
  const chunks: L0SemanticChunk[] = [];
  let startIdx = 0;

  while (startIdx < lines.length) {
    const windowStartSec = lines[startIdx].from;
    let endIdx = startIdx;
    let chars = lines[startIdx].content.length;

    while (endIdx + 1 < lines.length) {
      const nextLine = lines[endIdx + 1];
      const nextSpan = Math.max(nextLine.to, nextLine.from) - windowStartSec;
      const nextChars = chars + nextLine.content.length;
      if (nextSpan <= targetSeconds && nextChars <= maxChars) {
        endIdx += 1;
        chars = nextChars;
      } else {
        break;
      }
    }

    const chunkLines = lines.slice(startIdx, endIdx + 1);
    const first = chunkLines[0];
    const last = chunkLines[chunkLines.length - 1];
    const fromSeconds = first.from;
    const toSeconds = Math.max(first.from, last.to);
    const midpoint = (fromSeconds + toSeconds) / 2;
    const owner = findOwnerChapterForSeconds(chapters, midpoint);

    chunks.push({
      chunkIndex: chunks.length,
      startLineIdx: startIdx,
      endLineIdx: endIdx,
      startLineNumber: first.lineNumber,
      endLineNumber: last.lineNumber,
      fromSeconds,
      toSeconds,
      ...(owner !== undefined ? { chapterIndex: owner.chapterIndex } : {}),
      contextPrefix: owner?.contextPrefix ?? "",
      bodyText: chunkLines.map((item) => item.content).join(" "),
      lines: chunkLines
    });

    if (endIdx >= lines.length - 1) {
      break;
    }

    const windowSpan = toSeconds - windowStartSec;
    if (windowSpan > overlapSeconds) {
      const overlapCutoff = toSeconds - overlapSeconds;
      let nextStart = endIdx + 1;
      for (let idx = startIdx + 1; idx <= endIdx; idx += 1) {
        if (lines[idx].from >= overlapCutoff) {
          nextStart = idx;
          break;
        }
      }
      startIdx = Math.max(startIdx + 1, nextStart);
    } else {
      const lineSpan = endIdx - startIdx + 1;
      const step = Math.max(1, Math.ceil(lineSpan * 0.8));
      startIdx = Math.min(endIdx + 1, startIdx + step);
    }
  }

  return chunks;
}

export interface CreateL0ContextualBm25IndexOptions {
  k1?: number;
  b?: number;
  chapters?: readonly SemanticChunkChapterInput[];
  chunkOptions?: BuildL0SemanticChunksOptions;
}

export interface L0ContextualBm25SearchOptions {
  query?: string;
  terms?: readonly string[];
  expansionText?: string;
  expansionTerms?: readonly string[];
  expansionWeight?: number;
  timeRanges?: readonly RetrievalTimeRange[];
  topK?: number;
}

export interface L0ContextualBm25SearchResult {
  hits: readonly L0ChunkHit[];
  totalChunksScanned: number;
  meanScore: number;
  stdDevScore: number;
  primaryCoreTerms: readonly string[];
}

export interface L0ContextualBm25Index {
  readonly lineCount: number;
  readonly chunkCount: number;
  readonly avgDocLength: number;
  readonly vocabularySize: number;
  getLines(): readonly L0SubtitleLine[];
  getChunks(): readonly L0SemanticChunk[];
  search(queryOrOptions: string | L0ContextualBm25SearchOptions): L0ContextualBm25SearchResult;
}

function chunkMatchesTimeRanges(
  chunk: L0SemanticChunk,
  ranges: readonly RetrievalTimeRange[] | undefined
): boolean {
  if (!ranges || ranges.length === 0) {
    return true;
  }
  return ranges.some((range) => {
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return false;
    }
    return chunk.toSeconds >= from && chunk.fromSeconds <= to;
  });
}

function buildWeightedQueryTerms(
  queryOrOptions: string | L0ContextualBm25SearchOptions
): {
  queryWeights: Map<string, { weight: number; term: string; isBigram: boolean }>;
  primaryCoreTerms: string[];
} {
  const queryWeights = new Map<string, { weight: number; term: string; isBigram: boolean }>();
  const primaryCoreSet = new Set<string>();

  const addTokens = (text: unknown, multiplier: number, isPrimary: boolean) => {
    for (const tok of tokenizeDualGranularity(text)) {
      const effectiveWeight = tok.weight * multiplier;
      if (effectiveWeight <= 0) {
        continue;
      }
      if (isPrimary && !tok.isBigram) {
        primaryCoreSet.add(tok.term);
      }
      const existing = queryWeights.get(tok.key);
      if (!existing || effectiveWeight > existing.weight) {
        queryWeights.set(tok.key, {
          weight: effectiveWeight,
          term: tok.term,
          isBigram: tok.isBigram
        });
      }
    }
  };

  if (typeof queryOrOptions === "string") {
    addTokens(queryOrOptions, 1.0, true);
  } else {
    if (typeof queryOrOptions.query === "string" && queryOrOptions.query.trim()) {
      addTokens(queryOrOptions.query, 1.0, true);
    }
    if (Array.isArray(queryOrOptions.terms)) {
      for (const term of queryOrOptions.terms) {
        addTokens(term, 1.0, true);
      }
    }
    const rawExpansionWeight = Number(queryOrOptions.expansionWeight ?? DEFAULT_QUERY_EXPANSION_WEIGHT);
    const expansionWeight =
      Number.isFinite(rawExpansionWeight) && rawExpansionWeight > 0
        ? rawExpansionWeight
        : DEFAULT_QUERY_EXPANSION_WEIGHT;
    if (typeof queryOrOptions.expansionText === "string" && queryOrOptions.expansionText.trim()) {
      addTokens(queryOrOptions.expansionText, expansionWeight, false);
    }
    if (Array.isArray(queryOrOptions.expansionTerms)) {
      for (const term of queryOrOptions.expansionTerms) {
        addTokens(term, expansionWeight, false);
      }
    }
  }

  return {
    queryWeights,
    primaryCoreTerms: [...primaryCoreSet]
  };
}

export function createL0ContextualBm25Index(
  lines: readonly L0SubtitleLine[],
  options: CreateL0ContextualBm25IndexOptions = {}
): L0ContextualBm25Index {
  const k1 = Number.isFinite(Number(options.k1)) && Number(options.k1) >= 0 ? Number(options.k1) : DEFAULT_BM25_K1;
  const b = Number.isFinite(Number(options.b)) && Number(options.b) >= 0 && Number(options.b) <= 1 ? Number(options.b) : DEFAULT_BM25_B;
  const chunks = buildL0SemanticChunks(lines, options.chapters, options.chunkOptions);
  const docCount = chunks.length;
  const docLengths = new Array<number>(docCount).fill(0);
  const chunkWordSets: Array<Set<string>> = new Array(docCount);
  const invertedIndex = new Map<string, Posting[]>();

  let totalDocLength = 0;
  for (let docIdx = 0; docIdx < docCount; docIdx += 1) {
    const chunk = chunks[docIdx];
    const fullText = chunk.contextPrefix ? `${chunk.contextPrefix}\n${chunk.bodyText}` : chunk.bodyText;
    const tokens = tokenizeDualGranularity(fullText);
    const wordSet = new Set<string>();
    chunkWordSets[docIdx] = wordSet;

    if (tokens.length === 0) {
      continue;
    }

    let docLen = 0;
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      docLen += token.weight;
      if (!token.isBigram) {
        wordSet.add(token.term);
      }
      termFreq.set(token.key, (termFreq.get(token.key) ?? 0) + token.weight);
    }
    docLengths[docIdx] = docLen;
    totalDocLength += docLen;

    for (const [termKey, tf] of termFreq.entries()) {
      let postings = invertedIndex.get(termKey);
      if (!postings) {
        postings = [];
        invertedIndex.set(termKey, postings);
      }
      postings.push({ docIdx, tf });
    }
  }

  const avgDocLength = docCount > 0 && totalDocLength > 0 ? totalDocLength / docCount : 1;
  const idfMap = new Map<string, number>();
  for (const [termKey, postings] of invertedIndex.entries()) {
    const df = postings.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    idfMap.set(termKey, idf);
  }

  return {
    lineCount: lines.length,
    chunkCount: docCount,
    avgDocLength: docCount > 0 ? totalDocLength / docCount : 0,
    vocabularySize: invertedIndex.size,

    getLines(): readonly L0SubtitleLine[] {
      return lines;
    },

    getChunks(): readonly L0SemanticChunk[] {
      return chunks;
    },

    search(queryOrOptions: string | L0ContextualBm25SearchOptions): L0ContextualBm25SearchResult {
      const opts: L0ContextualBm25SearchOptions =
        typeof queryOrOptions === "string" ? { query: queryOrOptions } : (queryOrOptions || {});
      const { queryWeights, primaryCoreTerms } = buildWeightedQueryTerms(queryOrOptions);

      if (docCount === 0 || queryWeights.size === 0) {
        return {
          hits: [],
          totalChunksScanned: 0,
          meanScore: 0,
          stdDevScore: 0,
          primaryCoreTerms
        };
      }

      const timeRanges = Array.isArray(opts.timeRanges) && opts.timeRanges.length > 0 ? opts.timeRanges : undefined;
      const topK = Math.max(1, Math.floor(Number(opts.topK ?? DEFAULT_TOP_K) || DEFAULT_TOP_K));

      const scores = new Map<number, number>();
      const matchedMap = new Map<number, Set<string>>();

      for (const [termKey, meta] of queryWeights.entries()) {
        const postings = invertedIndex.get(termKey);
        if (!postings) {
          continue;
        }
        const idf = idfMap.get(termKey) ?? 0;
        for (const { docIdx, tf } of postings) {
          if (timeRanges && !chunkMatchesTimeRanges(chunks[docIdx], timeRanges)) {
            continue;
          }
          const dl = docLengths[docIdx];
          const norm = 1 - b + b * (dl / avgDocLength);
          const denom = tf + k1 * norm;
          const termScore = denom > 0 ? meta.weight * idf * ((tf * (k1 + 1)) / denom) : 0;
          if (termScore <= 0) {
            continue;
          }
          scores.set(docIdx, (scores.get(docIdx) ?? 0) + termScore);
          let matched = matchedMap.get(docIdx);
          if (!matched) {
            matched = new Set<string>();
            matchedMap.set(docIdx, matched);
          }
          matched.add(meta.term);
        }
      }

      const totalChunksScanned = timeRanges
        ? chunks.reduce((acc, chunk) => acc + (chunkMatchesTimeRanges(chunk, timeRanges) ? 1 : 0), 0)
        : docCount;

      if (scores.size === 0 || totalChunksScanned === 0) {
        return {
          hits: [],
          totalChunksScanned,
          meanScore: 0,
          stdDevScore: 0,
          primaryCoreTerms
        };
      }

      let sumScores = 0;
      for (const score of scores.values()) {
        sumScores += score;
      }
      const meanScore = sumScores / totalChunksScanned;
      let sumSq = 0;
      for (const score of scores.values()) {
        const diff = score - meanScore;
        sumSq += diff * diff;
      }
      const zeroCount = Math.max(0, totalChunksScanned - scores.size);
      sumSq += zeroCount * meanScore * meanScore;
      const stdDevScore = Math.sqrt(sumSq / totalChunksScanned);

      const hits: L0ChunkHit[] = [...scores.entries()]
        .map(([docIdx, score]) => {
          const wordSet = chunkWordSets[docIdx];
          let matchedCore = 0;
          if (primaryCoreTerms.length > 0 && wordSet) {
            for (const coreTerm of primaryCoreTerms) {
              if (wordSet.has(coreTerm)) {
                matchedCore += 1;
              }
            }
          }
          const coreTermCoverage = primaryCoreTerms.length > 0 ? matchedCore / primaryCoreTerms.length : 0;
          const chunk = chunks[docIdx];
          return {
            chunk,
            score,
            matchedTerms: [...(matchedMap.get(docIdx) ?? [])],
            coreTermCoverage,
            ...(chunk.chapterIndex !== undefined ? { chapterIndex: chunk.chapterIndex } : {})
          };
        })
        .sort((a, bHit) => bHit.score - a.score || a.chunk.chunkIndex - bHit.chunk.chunkIndex)
        .slice(0, topK);

      return {
        hits,
        totalChunksScanned,
        meanScore,
        stdDevScore,
        primaryCoreTerms
      };
    }
  };
}

interface CachedContextualBm25Entry {
  cacheKey: string;
  subtitleKey: string;
  lines: readonly L0SubtitleLine[];
  index: L0ContextualBm25Index;
}

let contextualBm25Cache: Map<string, CachedContextualBm25Entry> | null = null;

function getContextualBm25Cache(): Map<string, CachedContextualBm25Entry> {
  if (!contextualBm25Cache) {
    contextualBm25Cache = new Map();
  }
  return contextualBm25Cache;
}

export function computeL0SubtitleCacheKey(
  rawLines: ReadonlyArray<{ from?: unknown; to?: unknown; content?: unknown }> | null | undefined,
  meta?: { signature?: unknown; bvid?: unknown; cid?: unknown }
): string {
  const sig = String(meta?.signature ?? "").trim();
  const bvid = String(meta?.bvid ?? "").trim();
  const cid = String(meta?.cid ?? "").trim();
  const count = Array.isArray(rawLines) ? rawLines.length : 0;
  let hash = fnv1a32(`${bvid}|${cid}|${sig}|${count}`);
  if (Array.isArray(rawLines) && count > 0) {
    for (let i = 0; i < count; i += 1) {
      const item = rawLines[i];
      const content = String(item?.content ?? "").trim();
      if (!content) {
        continue;
      }
      hash = fnv1a32(`${Number(item?.from) || 0}:${Number(item?.to) || 0}:${content}`, hash);
    }
  }
  return `${bvid}|${cid}|${sig}|${count}:${hash.toString(16)}`;
}

export function computeDirectoryFingerprint(
  chapters: readonly SemanticChunkChapterInput[] | undefined
): string {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return "empty";
  }
  let hash = fnv1a32(String(chapters.length));
  for (const ch of chapters) {
    const title = String(ch?.title ?? "").trim();
    const thesis = String(ch?.coreThesis ?? "").trim();
    const entities = Array.isArray(ch?.keyEntities) ? ch.keyEntities.map((e: unknown) => String(e ?? "").trim()).join(",") : "";
    hash = fnv1a32(`${Number(ch?.from) || 0}:${Number(ch?.to) || 0}:${title}|${thesis}|${entities}`, hash);
  }
  return `${chapters.length}:${hash.toString(16)}`;
}

export function findCachedL0SubtitleLines(subtitleKey: string): readonly L0SubtitleLine[] | null {
  if (!subtitleKey || !contextualBm25Cache || contextualBm25Cache.size === 0) {
    return null;
  }
  for (const entry of contextualBm25Cache.values()) {
    if (entry.subtitleKey === subtitleKey) {
      return entry.lines;
    }
  }
  return null;
}

export interface GetOrCreateL0ContextualBm25IndexInput extends CreateL0ContextualBm25IndexOptions {
  subtitleKey: string;
  directoryFingerprint?: string;
  lines: readonly L0SubtitleLine[];
}

export function getOrCreateL0ContextualBm25Index(
  input: GetOrCreateL0ContextualBm25IndexInput
): L0ContextualBm25Index {
  const dirFp = input.directoryFingerprint ?? computeDirectoryFingerprint(input.chapters);
  const cacheKey = `${input.subtitleKey}::${dirFp}`;
  const cache = getContextualBm25Cache();
  const hit = cache.get(cacheKey);
  if (hit) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.index;
  }

  const index = createL0ContextualBm25Index(input.lines, {
    k1: input.k1,
    b: input.b,
    chapters: input.chapters,
    chunkOptions: input.chunkOptions
  });

  cache.set(cacheKey, {
    cacheKey,
    subtitleKey: input.subtitleKey,
    lines: input.lines,
    index
  });

  while (cache.size > MAX_CACHED_BM25_VIDEOS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }

  return index;
}

export function clearL0Bm25Cache(): void {
  contextualBm25Cache?.clear();
}

export function getL0Bm25CacheStats(): { size: number; keys: string[] } {
  if (!contextualBm25Cache) {
    return { size: 0, keys: [] };
  }
  return {
    size: contextualBm25Cache.size,
    keys: [...contextualBm25Cache.keys()]
  };
}
