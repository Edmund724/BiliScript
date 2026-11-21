import { formatClock, shouldUseHoursForRange } from "../shared/clock-text.js";
import { findNearestTimedLineIndex, truncateWithEllipsis } from "../shared/text-primitives.js";
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { estimateCompactPromptTokens, normalizeL0SubtitleLines, tokenizeLexicalText } from "./l0-bm25.js";
export { estimateCompactPromptTokens };
import type { AnalysisChapter, AnalysisQuote, OverviewAnalysis } from "./analysis-validate.js";
import type { OutlineChapter } from "../shared/chapter-outline.js";
import type {
  L0SubtitleLine,
  L1ChapterNode,
  L1QuoteRef,
  L1VideoIndexCacheRecord
} from "./long-video-hybrid-types.js";

export const L1_INDEX_CACHE_PREFIX = "biliscript_lvs_l1_index_";
export const L1_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_L1_MEMORY_MAX_ENTRIES = 16;
export const DEFAULT_L1_PROMPT_MAX_TOKENS = 1200;
export const DEFAULT_L1_PROMPT_MAX_CHARS = 1200;

export interface L1ChapterInput {
  from?: unknown;
  to?: unknown;
  seconds?: unknown;
  title?: unknown;
  summary?: unknown;
  coreThesis?: unknown;
  keyEntities?: ReadonlyArray<unknown>;
  quoteLineNumbers?: ReadonlyArray<unknown>;
  missingSummary?: unknown;
}

export interface L1QuoteInput {
  from?: unknown;
  content?: unknown;
  quote?: unknown;
  lineNumber?: unknown;
}

export interface BuildL1VideoIndexInput {
  bvid: string;
  cid: string;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  subtitleLang?: unknown;
  subtitleSignature: string;
  videoDuration?: number;
  globalSummary?: string;
  lines?: ReadonlyArray<{ from?: unknown; to?: unknown; content?: unknown; lineNumber?: unknown }>;
  chapters?: ReadonlyArray<L1ChapterInput | OutlineChapter | AnalysisChapter>;
  quotes?: ReadonlyArray<L1QuoteInput | AnalysisQuote>;
  overviewAnalysis?: OverviewAnalysis | null;
  now?: number;
}

function resolveChapterFromSeconds(raw: L1ChapterInput | OutlineChapter | AnalysisChapter): number | null {
  const candidate =
    (raw as { from?: unknown }).from !== undefined
      ? Number((raw as { from?: unknown }).from)
      : Number((raw as { seconds?: unknown }).seconds);
  if (!Number.isFinite(candidate) || candidate < 0) {
    return null;
  }
  return Math.floor(candidate);
}

function resolveEndSeconds(
  lines: readonly L0SubtitleLine[],
  videoDuration: unknown,
  chapters: ReadonlyArray<{ from: number; to?: number }>
): number {
  const dur = Number(videoDuration);
  const lastLineTo = lines.length > 0 ? Math.max(0, Math.ceil(lines[lines.length - 1].to)) : 0;
  const lastChapterTo = chapters.reduce((max, ch) => Math.max(max, Number(ch.to) || 0, ch.from), 0);
  return Math.max(Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 0, lastLineTo, lastChapterTo);
}

function extractFallbackEntities(title: string, coreThesis: string, maxEntities = 5): string[] {
  const tokens = [...tokenizeLexicalText(title), ...tokenizeLexicalText(coreThesis)];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length < 2 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
    if (unique.length >= maxEntities) {
      break;
    }
  }
  return unique;
}

function findLineNumberRangeForChapter(
  lines: readonly L0SubtitleLine[],
  from: number,
  to: number,
  isLastChapter: boolean
): { startLineNumber?: number; endLineNumber?: number } {
  if (lines.length === 0) {
    return {};
  }
  let startLineNumber: number | undefined;
  let endLineNumber: number | undefined;
  for (const line of lines) {
    const inRange = isLastChapter ? line.from >= from && line.from <= to : line.from >= from && line.from < to;
    if (inRange) {
      if (startLineNumber === undefined) {
        startLineNumber = line.lineNumber;
      }
      endLineNumber = line.lineNumber;
    }
  }
  return startLineNumber !== undefined && endLineNumber !== undefined ? { startLineNumber, endLineNumber } : {};
}

function findNearestL0LineNumber(lines: readonly L0SubtitleLine[], targetFrom: number, quoteContent: string): number {
  if (lines.length === 0) {
    return -1;
  }
  const quoteTokens = new Set(tokenizeLexicalText(quoteContent));
  const bestIdx = findNearestTimedLineIndex(lines, targetFrom, {
    scoreLine: (line, distance) => {
      let overlap = 0;
      if (quoteTokens.size > 0 && distance <= 30) {
        for (const token of tokenizeLexicalText(line.content)) {
          if (quoteTokens.has(token)) {
            overlap += 1;
          }
        }
      }
      return overlap * 10 - distance;
    }
  });
  return bestIdx >= 0 ? lines[bestIdx].lineNumber : -1;
}

function findOwnerChapterIndex(chapters: readonly L1ChapterNode[], seconds: number): number | undefined {
  let owner: number | undefined;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].from <= seconds) {
      owner = chapters[i].chapterIndex;
    } else {
      break;
    }
  }
  return owner;
}

export function findL1ChapterForTime(
  chapters: readonly L1ChapterNode[] | null | undefined,
  seconds: number
): L1ChapterNode | null {
  if (!Array.isArray(chapters) || chapters.length === 0 || !Number.isFinite(seconds)) {
    return null;
  }
  const target = Math.max(0, seconds);
  for (let i = 0; i < chapters.length; i += 1) {
    const ch = chapters[i];
    const isLast = i === chapters.length - 1;
    if (target >= ch.from && (isLast ? target <= Math.max(ch.to, ch.from) : target < ch.to)) {
      return ch;
    }
  }
  let candidate: L1ChapterNode | null = null;
  for (const ch of chapters) {
    if (ch.from <= target) {
      candidate = ch;
    } else {
      break;
    }
  }
  return candidate;
}

export function buildL1VideoIndex(input: BuildL1VideoIndexInput): L1VideoIndexCacheRecord {
  const now = Number.isFinite(Number(input.now)) ? Math.floor(Number(input.now)) : Date.now();
  const lines = normalizeL0SubtitleLines(input.lines);
  const overview = input.overviewAnalysis ?? null;

  const rawChapters = input.chapters ?? overview?.chapters ?? [];
  const rawQuotes = input.quotes ?? overview?.quotes ?? [];
  const globalSummary = String(input.globalSummary ?? overview?.summary ?? "").trim();

  const parsedChapters: Array<{
    from: number;
    explicitTo?: number;
    title: string;
    coreThesis: string;
    keyEntities: string[];
    quoteLineNumbers: number[];
    missingSummary?: boolean;
  }> = [];
  const seenFrom = new Set<number>();

  for (const raw of rawChapters) {
    const from = resolveChapterFromSeconds(raw);
    const title = String((raw as { title?: unknown })?.title ?? "").trim();
    if (from === null || !title || seenFrom.has(from)) {
      continue;
    }
    seenFrom.add(from);
    const rawTo = Number((raw as { to?: unknown })?.to);
    const explicitTo = Number.isFinite(rawTo) && rawTo > from ? Math.floor(rawTo) : undefined;
    const coreThesis = String(
      (raw as L1ChapterInput).coreThesis ?? (raw as AnalysisChapter).summary ?? ""
    ).trim();
    const explicitEntities = Array.isArray((raw as L1ChapterInput).keyEntities)
      ? (raw as L1ChapterInput).keyEntities!
          .map((item) => String(item ?? "").trim())
          .filter(Boolean)
      : [];
    const keyEntities =
      explicitEntities.length > 0 ? [...new Set(explicitEntities)] : extractFallbackEntities(title, coreThesis);
    const explicitQuoteLines = Array.isArray((raw as L1ChapterInput).quoteLineNumbers)
      ? (raw as L1ChapterInput).quoteLineNumbers!
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    const missingSummary = (raw as AnalysisChapter).missingSummary === true ? true : undefined;

    parsedChapters.push({
      from,
      explicitTo,
      title,
      coreThesis,
      keyEntities,
      quoteLineNumbers: [...new Set(explicitQuoteLines)],
      missingSummary
    });
  }

  parsedChapters.sort((a, b) => a.from - b.from);
  const endSeconds = resolveEndSeconds(lines, input.videoDuration, parsedChapters);

  const chapters: L1ChapterNode[] = parsedChapters.map((item, idx) => {
    const nextFrom = idx + 1 < parsedChapters.length ? parsedChapters[idx + 1].from : null;
    const to =
      item.explicitTo !== undefined
        ? item.explicitTo
        : nextFrom !== null && nextFrom > item.from
          ? nextFrom
          : Math.max(item.from, endSeconds);
    const lineRange = findLineNumberRangeForChapter(lines, item.from, to, idx === parsedChapters.length - 1);
    return {
      chapterIndex: idx,
      title: item.title,
      from: item.from,
      to,
      coreThesis: item.coreThesis,
      keyEntities: item.keyEntities,
      quoteLineNumbers: item.quoteLineNumbers,
      ...lineRange,
      ...(item.missingSummary ? { missingSummary: true } : {})
    };
  });

  const quotes: L1QuoteRef[] = [];
  const chapterQuoteSets = chapters.map((ch) => new Set<number>(ch.quoteLineNumbers));

  for (const rawQuote of rawQuotes) {
    const fromNum = Number(rawQuote?.from);
    const content = String((rawQuote as L1QuoteInput).content ?? (rawQuote as L1QuoteInput).quote ?? "").trim();
    if (!Number.isFinite(fromNum) || fromNum < 0 || !content) {
      continue;
    }
    const from = Math.floor(fromNum);
    const explicitLine = Number((rawQuote as L1QuoteInput).lineNumber);
    const lineNumber =
      Number.isInteger(explicitLine) && explicitLine >= 0
        ? explicitLine
        : findNearestL0LineNumber(lines, from, content);
    const chapterIndex = findOwnerChapterIndex(chapters, from);
    if (chapterIndex !== undefined && lineNumber >= 0) {
      chapterQuoteSets[chapterIndex]?.add(lineNumber);
    }
    quotes.push({
      from,
      content,
      lineNumber,
      ...(chapterIndex !== undefined ? { chapterIndex } : {})
    });
  }

  quotes.sort((a, b) => a.from - b.from || a.lineNumber - b.lineNumber);

  const finalizedChapters: L1ChapterNode[] = chapters.map((ch, idx) => ({
    ...ch,
    quoteLineNumbers: [...chapterQuoteSets[idx]].sort((a, b) => a - b)
  }));

  return {
    schemaVersion: L1_INDEX_SCHEMA_VERSION,
    bvid: String(input.bvid || "").trim(),
    cid: String(input.cid || "").trim(),
    sourceKey: buildSubtitleSourceKey(input.subtitleId, input.subtitleUrl, input.subtitleLang),
    subtitleSignature: String(input.subtitleSignature || "").trim(),
    videoDuration: endSeconds,
    lineCount: lines.length,
    globalSummary,
    chapters: finalizedChapters,
    quotes,
    createdAt: now,
    updatedAt: now
  };
}

export interface SerializeL1PromptOptions {
  maxTokens?: number;
  maxChars?: number;
}

function clampSingleLine(text: string, maxLen: number): string {
  return truncateWithEllipsis(text, maxLen, { singleLine: true });
}

function formatChapterRange(from: number, to: number, withHours: boolean): string {
  return `[${formatClock(from, { hours: withHours })}-${formatClock(Math.max(from, to), { hours: withHours })}]`;
}

function renderPromptLines(
  globalSummary: string,
  chapterLines: string[],
  summaryMaxLen: number
): string {
  const parts: string[] = [];
  if (globalSummary) {
    parts.push(`全片简介：${clampSingleLine(globalSummary, summaryMaxLen)}`);
  }
  if (chapterLines.length > 0) {
    parts.push(`章节目录：\n${chapterLines.join("\n")}`);
  }
  return parts.join("\n");
}

function fitsBudget(text: string, maxChars: number, maxTokens: number): boolean {
  return text.length <= maxChars && estimateCompactPromptTokens(text) <= maxTokens;
}

export function serializeL1DirectoryPrompt(
  index: Pick<L1VideoIndexCacheRecord, "globalSummary" | "chapters" | "videoDuration"> | null | undefined,
  options: SerializeL1PromptOptions = {}
): string {
  if (!index) {
    return "";
  }
  const maxTokens = Math.max(64, Math.floor(Number(options.maxTokens ?? DEFAULT_L1_PROMPT_MAX_TOKENS) || DEFAULT_L1_PROMPT_MAX_TOKENS));
  const maxChars = Math.max(64, Math.floor(Number(options.maxChars ?? DEFAULT_L1_PROMPT_MAX_CHARS) || DEFAULT_L1_PROMPT_MAX_CHARS));
  const chapters = Array.isArray(index.chapters) ? index.chapters : [];
  const globalSummary = String(index.globalSummary ?? "").trim();
  if (!globalSummary && chapters.length === 0) {
    return "";
  }

  const maxEnd = chapters.reduce((max, ch) => Math.max(max, ch.to, ch.from), Number(index.videoDuration) || 0);
  const withHours = shouldUseHoursForRange(0, maxEnd);

  const tier1 = renderPromptLines(
    globalSummary,
    chapters.map((ch) => {
      const range = formatChapterRange(ch.from, ch.to, withHours);
      const segments = [`${range} ${clampSingleLine(ch.title, 48)}`];
      if (ch.coreThesis) {
        segments.push(clampSingleLine(ch.coreThesis, 64));
      }
      if (ch.keyEntities.length > 0) {
        segments.push(`词:${ch.keyEntities.slice(0, 3).join("/")}`);
      }
      if (ch.quoteLineNumbers.length > 0) {
        segments.push(`句:#${ch.quoteLineNumbers.slice(0, 2).join(",#")}`);
      }
      return segments.join(" | ");
    }),
    180
  );
  if (fitsBudget(tier1, maxChars, maxTokens)) {
    return tier1;
  }

  const tier2 = renderPromptLines(
    globalSummary,
    chapters.map((ch) => {
      const range = formatChapterRange(ch.from, ch.to, withHours);
      const segments = [`${range} ${clampSingleLine(ch.title, 36)}`];
      if (ch.coreThesis) {
        segments.push(clampSingleLine(ch.coreThesis, 36));
      }
      if (ch.keyEntities.length > 0) {
        segments.push(`词:${ch.keyEntities.slice(0, 2).join("/")}`);
      }
      return segments.join(" | ");
    }),
    120
  );
  if (fitsBudget(tier2, maxChars, maxTokens)) {
    return tier2;
  }

  const tier3 = renderPromptLines(
    globalSummary,
    chapters.map((ch) => `${formatChapterRange(ch.from, ch.to, withHours)} ${clampSingleLine(ch.title, 32)}`),
    90
  );
  if (fitsBudget(tier3, maxChars, maxTokens)) {
    return tier3;
  }

  const summaryPrefix = globalSummary ? `全片简介：${clampSingleLine(globalSummary, 72)}\n` : "";
  const header = `${summaryPrefix}章节目录：\n`;
  const effectiveLimit = Math.min(maxChars, maxTokens);
  const availableBudget = Math.max(32, effectiveLimit - header.length);
  let targetBuckets = Math.max(1, Math.min(chapters.length, Math.floor(availableBudget / 32)));

  let candidate = "";
  while (targetBuckets >= 1) {
    const bucketSize = Math.ceil(chapters.length / targetBuckets);
    const bucketLines: string[] = [];
    for (let i = 0; i < chapters.length; i += bucketSize) {
      const slice = chapters.slice(i, i + bucketSize);
      const first = slice[0];
      const last = slice[slice.length - 1];
      const range = formatChapterRange(first.from, last.to, withHours);
      const titlePreview =
        slice.length === 1
          ? clampSingleLine(first.title, 26)
          : `${clampSingleLine(first.title, 14)}…(+${slice.length - 1}章)`;
      bucketLines.push(`${range} ${titlePreview}`);
    }
    candidate = `${header}${bucketLines.join("\n")}`;
    if (fitsBudget(candidate, maxChars, maxTokens) || targetBuckets === 1) {
      break;
    }
    targetBuckets = Math.max(1, Math.floor(targetBuckets * 0.75));
  }

  if (!fitsBudget(candidate, maxChars, maxTokens)) {
    return clampSingleLine(candidate, effectiveLimit);
  }
  return candidate;
}

export function isL1VideoIndexCacheRecord(value: unknown): value is L1VideoIndexCacheRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as Partial<L1VideoIndexCacheRecord>;
  return (
    typeof rec.schemaVersion === "number" &&
    rec.schemaVersion === L1_INDEX_SCHEMA_VERSION &&
    typeof rec.bvid === "string" &&
    typeof rec.cid === "string" &&
    typeof rec.sourceKey === "string" &&
    typeof rec.subtitleSignature === "string" &&
    typeof rec.globalSummary === "string" &&
    Array.isArray(rec.chapters) &&
    Array.isArray(rec.quotes)
  );
}

export function unwrapL1IndexEnvelope(raw: unknown): L1VideoIndexCacheRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = (raw as { index?: unknown }).index;
  return isL1VideoIndexCacheRecord(candidate) ? candidate : null;
}
