import { state } from "../core/state.js";
import { getReaderOverviewSource } from "../reader/live-overview-source.js";
import { detectSiteFromUrl, normalizeSiteId, YOUTUBE_UNIT_CID, type SiteId } from "../shared/site.js";
import {
  filterGlossaryForText,
  parseSubtitleGlossary,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput
} from "../shared/subtitle-glossary.js";
import { truncateWithEllipsis } from "../shared/text-primitives.js";
import {
  findL1ChapterForTime,
  readCachedClipL1Index,
  readCachedClipOverviewArtifacts
} from "./l1-chapter-index.js";
import type { L1ChapterNode, L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import { resolveSubtitleTranslateGlossary } from "./subtitle-translate-config.js";
import type { SubtitleBodyItem } from "./types.js";

export type { SubtitleGlossaryEntry, SubtitleGlossaryInput };
export { filterGlossaryForText, parseSubtitleGlossary, resolveSubtitleTranslateGlossary };

export const SUBTITLE_CONTEXT_DESCRIPTION_MAX_CHARS = 400;
export const SUBTITLE_CONTEXT_SUMMARY_MAX_CHARS = 600;
export const SUBTITLE_CONTEXT_CHAPTER_MAX_CHARS = 240;
export const SUBTITLE_CONTEXT_REFERENCE_ENTITIES_MAX = 12;
export const SUBTITLE_CONTEXT_PREVIOUS_LINES_MAX = 2;

export interface SubtitlePreviousLine {
  original: string;
  translation: string;
}

export interface SubtitleTranslatePromptContext {
  site?: SiteId;
  title?: string;
  partTitle?: string;
  pageCount?: number;
  ownerName?: string;
  description?: string;
  summary?: string;
  chapterContext?: string;
  referenceEntities?: readonly string[];
  glossary?: SubtitleGlossaryInput;
  previousLines?: readonly SubtitlePreviousLine[];
}

export interface VideoStaticContextInput {
  site?: SiteId;
  cid?: unknown;
  url?: unknown;
  title?: unknown;
  partTitle?: unknown;
  pageTitle?: unknown;
  pageCount?: unknown;
  pages?: ReadonlyArray<unknown>;
  ownerName?: unknown;
  author?: unknown;
  description?: unknown;
}

export interface VideoStaticContext {
  title: string;
  ownerName: string;
  description: string;
}

export interface OverviewSummarySourceInput {
  summary?: unknown;
  chapters?: ReadonlyArray<{
    title?: unknown;
    summary?: unknown;
  }> | unknown;
}

export interface ReadCachedOverviewSummaryInput {
  site?: SiteId;
  bvid?: unknown;
  cid?: unknown;
  description?: unknown;
  hotComments?: unknown;
  chapters?: unknown;
  selectedSubtitleId?: unknown;
  selectedSubtitleUrl?: unknown;
  selectedSubtitleLang?: unknown;
  subtitleBody?: unknown;
  overviewAnalysis?: OverviewSummarySourceInput | null;
}

function normalizeSingleLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function truncateTextSafe(text: string, maxChars: number): string {
  return truncateWithEllipsis(text, maxChars);
}

export function formatMultiPartTitle(
  rawTitle: unknown,
  rawPartTitle?: unknown,
  rawPageCount?: unknown
): string {
  const title = normalizeSingleLine(rawTitle);
  const partTitle = normalizeSingleLine(rawPartTitle);
  const hasExplicitPageCount =
    rawPageCount !== undefined && rawPageCount !== null && rawPageCount !== "";
  const pageCount = hasExplicitPageCount ? Number(rawPageCount) : undefined;
  const isMultiPart =
    pageCount !== undefined && Number.isFinite(pageCount)
      ? pageCount > 1
      : Boolean(partTitle);

  if (isMultiPart && partTitle && partTitle !== title) {
    return title ? `${title} - ${partTitle}` : partTitle;
  }
  return title;
}

const BILIBILI_URL_WITH_LABEL_PATTERN =
  /(?:(?:项目|课程|视频|相关|参考|原文)?(?:源码|地址|链接|网址|资料|仓库|官网|传送门)\s*[:：]?\s*)?(?:https?:\/\/|www\.|b23\.tv\/)[^\s<>\]\)）"']+/gi;
const GENERIC_URL_WITH_LABEL_PATTERN =
  /(?:(?:项目|课程|视频|相关|参考|原文)?(?:源码|地址|链接|网址|资料|仓库|官网|传送门)\s*[:：]?\s*)?(?:https?:\/\/|www\.)[^\s<>\]\)）"']+/gi;
const INLINE_LOTTERY_PATTERNS: readonly RegExp[] = [
  /(?:互动抽奖|转发抽奖|关注抽奖|评论区?抽奖|预约抽奖|动态抽奖|抽奖活动)[^。\n]*/gi,
  /(?:关注|点赞|投币|收藏|三连|一键三连)[^。\n]{0,20}(?:转发|抽奖|抽\s*[一二三四五六七八九十百千万\d]+\s*[位名个份])[^。\n]*/gi,
  /(?:抽\s*[一二三四五六七八九十百千万\d]+\s*[位名个份]|中奖名单|领奖方式|开奖(?:时间|日期))[^。\n]*/gi
];
const NOISE_LINE_PATTERN =
  /^(?:[-=_*~`·\s]{3,}|(?:商务合作|商业合作|恰饭联系|交流群|粉丝群|QQ群|VX|微信)[:：]?.*|(?:项目|课程|视频|相关|参考|原文)?(?:源码|地址|链接|网址|资料|仓库|官网|传送门)[:：]?)$/i;
const DANGLING_LABEL_PREFIX =
  /^(?:项目|课程|视频|相关|参考|原文)?(?:源码|地址|链接|网址|资料|仓库|官网|传送门)\s*[:：]\s*$/i;
const EMPTY_WRAPPER_PATTERN = /\(\s*\)|\[\s*\]|【\s*】|（\s*）/g;

export function cleanVideoDescription(rawDescription: unknown, maxChars?: number, site?: SiteId): string;
export function cleanVideoDescription(rawDescription: unknown, site?: SiteId, maxChars?: number): string;
export function cleanVideoDescription(
  rawDescription: unknown,
  siteOrMaxChars: SiteId | number = "bilibili",
  maybeMaxCharsOrSite: number | SiteId = SUBTITLE_CONTEXT_DESCRIPTION_MAX_CHARS
): string {
  const site: SiteId =
    typeof siteOrMaxChars === "number"
      ? normalizeSiteId(typeof maybeMaxCharsOrSite === "string" ? maybeMaxCharsOrSite : "bilibili")
      : normalizeSiteId(siteOrMaxChars);
  const maxChars: number =
    typeof siteOrMaxChars === "number"
      ? siteOrMaxChars
      : typeof maybeMaxCharsOrSite === "number"
        ? maybeMaxCharsOrSite
        : SUBTITLE_CONTEXT_DESCRIPTION_MAX_CHARS;

  const normalized = String(rawDescription ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const urlPattern = site === "youtube" ? GENERIC_URL_WITH_LABEL_PATTERN : BILIBILI_URL_WITH_LABEL_PATTERN;
  const lotteryPatterns = site === "youtube" ? [] : INLINE_LOTTERY_PATTERNS;

  const keptLines: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    let line = rawLine.replace(urlPattern, " ");
    for (const pattern of lotteryPatterns) {
      line = line.replace(pattern, " ");
    }
    line = line
      .replace(EMPTY_WRAPPER_PATTERN, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*([，,、；;])\s*$/g, "")
      .trim();

    if (!line || DANGLING_LABEL_PREFIX.test(line) || NOISE_LINE_PATTERN.test(line)) {
      continue;
    }
    keptLines.push(line);
  }

  const cleaned = keptLines.join("\n").trim();
  if (!cleaned) {
    return "";
  }
  return truncateTextSafe(cleaned, maxChars);
}

function resolveStaticContextSite(input: VideoStaticContextInput): SiteId {
  return normalizeSiteId(
    input.site ??
      (String(input.cid ?? "").trim() === YOUTUBE_UNIT_CID
        ? "youtube"
        : input.url
          ? detectSiteFromUrl(input.url)
          : undefined)
  );
}

export function extractVideoStaticContext(
  input: VideoStaticContextInput | null | undefined
): VideoStaticContext {
  if (!input) {
    return { title: "", ownerName: "", description: "" };
  }
  const site = resolveStaticContextSite(input);
  const pageCount =
    input.pageCount !== undefined && input.pageCount !== null && input.pageCount !== ""
      ? input.pageCount
      : Array.isArray(input.pages)
        ? input.pages.length
        : undefined;
  const title = formatMultiPartTitle(
    input.title,
    input.partTitle ?? input.pageTitle,
    pageCount
  );
  const ownerName = normalizeSingleLine(input.ownerName ?? input.author);
  const description = cleanVideoDescription(input.description, site);
  return { title, ownerName, description };
}

export function formatOverviewSummaryBrief(
  analysis: OverviewSummarySourceInput | null | undefined,
  maxChars = SUBTITLE_CONTEXT_SUMMARY_MAX_CHARS
): string {
  if (!analysis || typeof analysis !== "object") {
    return "";
  }
  const parts: string[] = [];
  const mainSummary = normalizeSingleLine(analysis.summary);
  if (mainSummary) {
    parts.push(mainSummary);
  }

  const chapters = Array.isArray(analysis.chapters) ? analysis.chapters : [];
  const chapterLines: string[] = [];
  for (const chapter of chapters.slice(0, 8)) {
    if (!chapter || typeof chapter !== "object") continue;
    const rec = chapter as { title?: unknown; summary?: unknown };
    const chTitle = normalizeSingleLine(rec.title);
    const chSummary = normalizeSingleLine(rec.summary);
    if (!chTitle && !chSummary) continue;
    chapterLines.push(
      `- ${[chTitle, chSummary].filter(Boolean).join("：")}`
    );
  }

  if (chapterLines.length > 0) {
    parts.push(chapterLines.join("\n"));
  }

  const combined = parts.join("\n").trim();
  return combined ? truncateTextSafe(combined, maxChars) : "";
}

function formatL1IndexSummaryBrief(
  index: L1VideoIndexCacheRecord | null | undefined,
  maxChars = SUBTITLE_CONTEXT_SUMMARY_MAX_CHARS
): string {
  if (!index) {
    return "";
  }
  return formatOverviewSummaryBrief(
    {
      summary: index.globalSummary,
      chapters: index.chapters.map((ch) => ({
        title: ch.title,
        summary: ch.coreThesis
      }))
    },
    maxChars
  );
}

async function readCachedStorageOverviewArtifacts(
  input: ReadCachedOverviewSummaryInput | null | undefined
): Promise<{ finalSummary: string; l1Index: L1VideoIndexCacheRecord | null }> {
  const { analysisFinal, l1Index } = await readCachedClipOverviewArtifacts(input);
  return {
    finalSummary: formatOverviewSummaryBrief(analysisFinal),
    l1Index
  };
}

export async function readCachedL1VideoIndex(
  input: ReadCachedOverviewSummaryInput | null = state.clip
): Promise<L1VideoIndexCacheRecord | null> {
  return readCachedClipL1Index(input);
}

export async function readCachedOverviewSummary(
  input: ReadCachedOverviewSummaryInput | null | undefined
): Promise<string> {
  if (!input) {
    return "";
  }

  if (input.overviewAnalysis) {
    const direct = formatOverviewSummaryBrief(input.overviewAnalysis);
    if (direct) {
      return direct;
    }
  }

  const bvid = String(input.bvid ?? "").trim();
  const cid = String(input.cid ?? "").trim();

  if (
    (!bvid || bvid === state.clip.bvid) &&
    (!cid || cid === state.clip.cid)
  ) {
    const liveSnapshot = getReaderOverviewSource();
    const liveBrief = formatOverviewSummaryBrief(liveSnapshot?.analysis);
    if (liveBrief) {
      return liveBrief;
    }
  }

  const { finalSummary, l1Index } = await readCachedStorageOverviewArtifacts(input);
  if (finalSummary) {
    return finalSummary;
  }
  return formatL1IndexSummaryBrief(l1Index);
}

export function normalizePreviousLines(
  lines: readonly SubtitlePreviousLine[] | null | undefined,
  maxLines = SUBTITLE_CONTEXT_PREVIOUS_LINES_MAX
): SubtitlePreviousLine[] {
  if (!Array.isArray(lines) || lines.length === 0 || maxLines <= 0) {
    return [];
  }
  const valid: SubtitlePreviousLine[] = [];
  for (const item of lines) {
    const original = normalizeSingleLine(item?.original);
    const translation = normalizeSingleLine(item?.translation);
    if (original && translation) {
      valid.push({ original, translation });
    }
  }
  return valid.slice(-maxLines);
}

export function extractPreviousBilingualLines(
  items: readonly SubtitleBodyItem[] | null | undefined,
  translations: readonly SubtitleBodyItem[] | null | undefined,
  maxLines = SUBTITLE_CONTEXT_PREVIOUS_LINES_MAX
): SubtitlePreviousLine[] {
  if (!Array.isArray(items) || !Array.isArray(translations) || maxLines <= 0) {
    return [];
  }
  const limit = Math.min(items.length, translations.length);
  const collected: SubtitlePreviousLine[] = [];
  for (let i = limit - 1; i >= 0 && collected.length < maxLines; i -= 1) {
    const original = normalizeSingleLine(items[i]?.content);
    const translation = normalizeSingleLine(translations[i]?.content);
    if (original && translation) {
      collected.push({ original, translation });
    }
  }
  return collected.reverse();
}

export function extractPreviousBilingualLinesBeforeTime(
  primaryItems: readonly SubtitleBodyItem[] | null | undefined,
  translatedItems: readonly SubtitleBodyItem[] | null | undefined,
  beforeSec: number,
  maxLines = SUBTITLE_CONTEXT_PREVIOUS_LINES_MAX
): SubtitlePreviousLine[] {
  if (
    !Array.isArray(primaryItems) ||
    !Array.isArray(translatedItems) ||
    primaryItems.length === 0 ||
    translatedItems.length === 0 ||
    maxLines <= 0
  ) {
    return [];
  }

  const priorTranslations = translatedItems
    .filter((item) => Number(item?.from) < beforeSec && normalizeSingleLine(item?.content).length > 0)
    .sort((a, b) => Number(a.from) - Number(b.from));
  if (priorTranslations.length === 0) {
    return [];
  }

  const priorOriginals = primaryItems
    .filter((item) => Number(item?.from) < beforeSec && normalizeSingleLine(item?.content).length > 0)
    .sort((a, b) => Number(a.from) - Number(b.from));
  if (priorOriginals.length === 0) {
    return [];
  }

  const collected: SubtitlePreviousLine[] = [];
  for (let i = priorTranslations.length - 1; i >= 0 && collected.length < maxLines; i -= 1) {
    const trans = priorTranslations[i];
    const tFrom = Number(trans.from);
    const tTo = Number(trans.to);
    const overlapped = priorOriginals.filter(
      (orig) => Number(orig.to) > tFrom - 0.05 && Number(orig.from) < tTo + 0.05
    );
    const original = overlapped.map((orig) => normalizeSingleLine(orig.content)).filter(Boolean).join(" ");
    const translation = normalizeSingleLine(trans.content);
    if (original && translation) {
      collected.push({ original, translation });
    }
  }
  return collected.reverse();
}

export interface SubtitleTimeItemHint {
  from?: unknown;
  to?: unknown;
  startMs?: unknown;
  endMs?: unknown;
}

export interface ResolveL1ChapterContextInput {
  l1Index?: L1VideoIndexCacheRecord | null;
  chunkFromSec?: number;
  chunkToSec?: number;
  items?: ReadonlyArray<SubtitleTimeItemHint>;
  glossary?: SubtitleGlossaryInput | null;
  maxEntities?: number;
}

export interface L1ChapterTranslateContext {
  chapterContext?: string;
  referenceEntities?: string[];
}

function normalizeReferenceEntities(
  entities: readonly unknown[] | null | undefined,
  glossary?: SubtitleGlossaryInput | null,
  maxEntities = SUBTITLE_CONTEXT_REFERENCE_ENTITIES_MAX
): string[] {
  if (!Array.isArray(entities) || entities.length === 0 || maxEntities <= 0) {
    return [];
  }
  const glossarySourcesLower = new Set(
    parseSubtitleGlossary(glossary).map((entry) => entry.source.toLowerCase())
  );
  const seenLower = new Set<string>();
  const result: string[] = [];

  for (const raw of entities) {
    const clean = normalizeSingleLine(raw);
    if (!clean) {
      continue;
    }
    const lower = clean.toLowerCase();
    if (glossarySourcesLower.has(lower) || seenLower.has(lower)) {
      continue;
    }
    seenLower.add(lower);
    result.push(clean);
    if (result.length >= maxEntities) {
      break;
    }
  }
  return result;
}

function resolveChunkTimeBounds(input: ResolveL1ChapterContextInput): {
  fromSec: number;
  toSec: number;
} | null {
  let itemMinFrom = Infinity;
  let itemMaxTo = -Infinity;
  if (Array.isArray(input.items)) {
    for (const item of input.items) {
      const hasSec = item?.from !== undefined && item?.from !== null;
      const from = hasSec
        ? Number(item.from)
        : item?.startMs !== undefined && item?.startMs !== null
          ? Number(item.startMs) / 1000
          : NaN;
      const rawTo = hasSec
        ? Number(item?.to)
        : item?.endMs !== undefined && item?.endMs !== null
          ? Number(item.endMs) / 1000
          : NaN;
      if (Number.isFinite(from) && from >= 0) {
        if (from < itemMinFrom) itemMinFrom = from;
        const effectiveEnd = Number.isFinite(rawTo) && rawTo >= from ? rawTo : from;
        if (effectiveEnd > itemMaxTo) itemMaxTo = effectiveEnd;
      }
    }
  }

  const hasExplicitFrom =
    input.chunkFromSec !== undefined &&
    input.chunkFromSec !== null &&
    Number.isFinite(Number(input.chunkFromSec));
  const hasExplicitTo =
    input.chunkToSec !== undefined &&
    input.chunkToSec !== null &&
    Number.isFinite(Number(input.chunkToSec));

  const fromSec = hasExplicitFrom
    ? Math.max(0, Number(input.chunkFromSec))
    : Number.isFinite(itemMinFrom)
      ? itemMinFrom
      : hasExplicitTo
        ? Math.max(0, Number(input.chunkToSec))
        : NaN;
  const toSec = hasExplicitTo
    ? Math.max(fromSec, Number(input.chunkToSec))
    : Number.isFinite(itemMaxTo)
      ? Math.max(fromSec, itemMaxTo)
      : fromSec;

  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
    return null;
  }
  return { fromSec, toSec };
}

function collectOverlappingL1Chapters(
  chapters: readonly L1ChapterNode[],
  fromSec: number,
  toSec: number
): L1ChapterNode[] {
  if (chapters.length === 0) {
    return [];
  }
  const probeEnd = toSec > fromSec ? Math.max(fromSec, toSec - 0.001) : fromSec;
  const startCh = findL1ChapterForTime(chapters, fromSec);
  const endCh = findL1ChapterForTime(chapters, probeEnd);
  if (!startCh && !endCh) {
    return [];
  }
  const startPos = startCh ? chapters.indexOf(startCh) : 0;
  const endPos = endCh ? chapters.indexOf(endCh) : startPos;
  if (startPos < 0 || endPos < 0 || endPos < startPos) {
    return startCh ? [startCh] : endCh ? [endCh] : [];
  }
  return chapters.slice(startPos, endPos + 1);
}

export function resolveL1ChapterTranslateContext(
  input: ResolveL1ChapterContextInput | null | undefined
): L1ChapterTranslateContext {
  const index = input?.l1Index;
  if (!index || !Array.isArray(index.chapters) || index.chapters.length === 0) {
    return {};
  }
  const bounds = resolveChunkTimeBounds(input);
  if (!bounds) {
    return {};
  }
  const activeChapters = collectOverlappingL1Chapters(index.chapters, bounds.fromSec, bounds.toSec);
  if (activeChapters.length === 0) {
    return {};
  }

  const chapterParts: string[] = [];
  const rawEntities: string[] = [];
  for (const ch of activeChapters) {
    const title = normalizeSingleLine(ch.title);
    const coreThesis = normalizeSingleLine(ch.coreThesis);
    const brief = [title, coreThesis].filter(Boolean).join("：");
    if (brief) {
      chapterParts.push(brief);
    }
    if (Array.isArray(ch.keyEntities)) {
      rawEntities.push(...ch.keyEntities);
    }
  }

  const chapterContext =
    chapterParts.length > 0
      ? truncateTextSafe(chapterParts.join("；"), SUBTITLE_CONTEXT_CHAPTER_MAX_CHARS)
      : undefined;
  const referenceEntities = normalizeReferenceEntities(
    rawEntities,
    input.glossary,
    input.maxEntities ?? SUBTITLE_CONTEXT_REFERENCE_ENTITIES_MAX
  );

  return {
    ...(chapterContext ? { chapterContext } : {}),
    ...(referenceEntities.length > 0 ? { referenceEntities } : {})
  };
}

export function formatGlossaryEntries(
  entries: readonly SubtitleGlossaryEntry[]
): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }
  return entries
    .map((entry) => {
      const src = String(entry?.source ?? "").trim();
      if (!src) return "";
      const tgt = String(entry?.target ?? "").trim();
      const note = String(entry?.note ?? "").trim();
      const targetPart = tgt ? tgt : `保留原词（${src}）`;
      return note ? `- ${src} -> ${targetPart} (${note})` : `- ${src} -> ${targetPart}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildSubtitleContextPromptBlock(
  context?: SubtitleTranslatePromptContext | null,
  options?: { chunkText?: string }
): string {
  if (!context) {
    return "";
  }

  const contextLines: string[] = [];
  const site = normalizeSiteId(context.site);
  const ownerLabel = site === "youtube" ? "频道作者" : "UP 主";
  const title = formatMultiPartTitle(
    context.title,
    context.partTitle,
    context.pageCount
  );
  const ownerName = normalizeSingleLine(context.ownerName);
  const description = cleanVideoDescription(context.description, site);
  const summary = String(context.summary ?? "").trim();
  const chapterContext = normalizeSingleLine(context.chapterContext);
  const referenceEntities = normalizeReferenceEntities(
    context.referenceEntities,
    context.glossary
  );
  const previousLines = normalizePreviousLines(context.previousLines);

  if (title) {
    contextLines.push(`视频标题：${title}`);
  }
  if (ownerName) {
    contextLines.push(`${ownerLabel}：${ownerName}`);
  }
  if (description) {
    contextLines.push(`视频简介：${description}`);
  }
  if (summary) {
    contextLines.push(`内容摘要：${summary}`);
  }
  if (chapterContext) {
    contextLines.push(`当前章节：${chapterContext}`);
  }
  if (referenceEntities.length > 0) {
    contextLines.push(
      `参考实体（已纠偏专有名词，仅作同音消歧与语境参考）：${referenceEntities.join("、")}`
    );
  }
  if (previousLines.length > 0) {
    contextLines.push(
      "Previous lines (for context only, do NOT re-translate):\n" +
        previousLines
          .map((line) => `- ${line.original} => ${line.translation}`)
          .join("\n")
    );
  }

  const glossaryEntries =
    options?.chunkText !== undefined
      ? filterGlossaryForText(context.glossary, options.chunkText)
      : parseSubtitleGlossary(context.glossary);
  const glossaryBody = formatGlossaryEntries(glossaryEntries);

  const sections: string[] = [];
  if (contextLines.length > 0) {
    sections.push(`# Context\n${contextLines.join("\n")}`);
  }
  if (glossaryBody) {
    sections.push(
      `# Glossary\n` +
        `严格遵守以下术语表（命中术语时必须输出指定译文；标注“保留原词”时保持原词不翻译；严禁擅自加括号附注原文）：\n` +
        glossaryBody
    );
  }

  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

export function buildChunkSubtitleContext(
  baseContext: SubtitleTranslatePromptContext | undefined,
  chunkText: string,
  previousLines?: readonly SubtitlePreviousLine[]
): SubtitleTranslatePromptContext | undefined {
  const site = normalizeSiteId(baseContext?.site);
  const effectivePrevious =
    previousLines !== undefined ? normalizePreviousLines(previousLines) : normalizePreviousLines(baseContext?.previousLines);
  const filteredGlossary = filterGlossaryForText(baseContext?.glossary, chunkText);
  const chapterContext = normalizeSingleLine(baseContext?.chapterContext);
  const referenceEntities = normalizeReferenceEntities(
    baseContext?.referenceEntities,
    baseContext?.glossary
  );

  const hasBaseStatic = Boolean(
    baseContext &&
      (normalizeSingleLine(baseContext.title) ||
        normalizeSingleLine(baseContext.partTitle) ||
        normalizeSingleLine(baseContext.ownerName) ||
        cleanVideoDescription(baseContext.description, site) ||
        String(baseContext.summary ?? "").trim() ||
        chapterContext ||
        referenceEntities.length > 0)
  );

  if (!hasBaseStatic && filteredGlossary.length === 0 && effectivePrevious.length === 0) {
    return undefined;
  }

  return {
    ...(baseContext?.site ? { site: baseContext.site } : {}),
    ...(baseContext?.title ? { title: baseContext.title } : {}),
    ...(baseContext?.partTitle ? { partTitle: baseContext.partTitle } : {}),
    ...(baseContext?.pageCount !== undefined ? { pageCount: baseContext.pageCount } : {}),
    ...(baseContext?.ownerName ? { ownerName: baseContext.ownerName } : {}),
    ...(baseContext?.description ? { description: baseContext.description } : {}),
    ...(baseContext?.summary ? { summary: baseContext.summary } : {}),
    ...(chapterContext ? { chapterContext } : {}),
    ...(referenceEntities.length > 0 ? { referenceEntities } : {}),
    ...(filteredGlossary.length > 0 ? { glossary: filteredGlossary } : {}),
    ...(effectivePrevious.length > 0 ? { previousLines: effectivePrevious } : {})
  };
}

export interface ResolveRuntimeSubtitleContextInput extends SubtitleTranslatePromptContext {
  context?: SubtitleTranslatePromptContext;
  l1Index?: L1VideoIndexCacheRecord | null;
  chunkFromSec?: number;
  chunkToSec?: number;
  items?: ReadonlyArray<SubtitleTimeItemHint>;
}

export async function resolveRuntimeSubtitleContext(
  input: ResolveRuntimeSubtitleContextInput = {}
): Promise<SubtitleTranslatePromptContext | undefined> {
  const base = input.context;
  const explicitSite = input.site ?? base?.site;
  const site = normalizeSiteId(explicitSite ?? state.clip.site);
  const clipStatic = extractVideoStaticContext(state.clip);

  const explicitTitle = input.title ?? base?.title;
  const explicitPartTitle = input.partTitle ?? base?.partTitle;
  const explicitPageCount = input.pageCount ?? base?.pageCount;
  const explicitOwner = input.ownerName ?? base?.ownerName;
  const explicitDescription = input.description ?? base?.description;
  const explicitSummary = input.summary ?? base?.summary;
  const explicitChapterContext = input.chapterContext ?? base?.chapterContext;
  const explicitReferenceEntities = input.referenceEntities ?? base?.referenceEntities;
  const explicitGlossary = input.glossary ?? base?.glossary;
  const explicitPreviousLines = input.previousLines ?? base?.previousLines;

  const title =
    explicitTitle !== undefined
      ? formatMultiPartTitle(explicitTitle, explicitPartTitle, explicitPageCount)
      : clipStatic.title;
  const ownerName =
    explicitOwner !== undefined ? normalizeSingleLine(explicitOwner) : clipStatic.ownerName;
  const description =
    explicitDescription !== undefined
      ? cleanVideoDescription(explicitDescription, site)
      : clipStatic.description;
  const glossary =
    explicitGlossary !== undefined
      ? explicitGlossary
      : resolveSubtitleTranslateGlossary(state.settings);

  const hasChunkTimeHint =
    input.chunkFromSec !== undefined ||
    input.chunkToSec !== undefined ||
    (Array.isArray(input.items) && input.items.length > 0);
  const needsL1ForChapter =
    (explicitChapterContext === undefined || explicitReferenceEntities === undefined) &&
    hasChunkTimeHint;

  let cachedArtifacts: { finalSummary: string; l1Index: L1VideoIndexCacheRecord | null } | null = null;
  const loadArtifacts = async () => {
    if (!cachedArtifacts) {
      cachedArtifacts = await readCachedStorageOverviewArtifacts(state.clip);
    }
    return cachedArtifacts;
  };

  let summary = "";
  if (explicitSummary !== undefined) {
    summary = String(explicitSummary ?? "").trim();
  } else {
    const liveSnapshot = getReaderOverviewSource();
    const liveBrief = formatOverviewSummaryBrief(liveSnapshot?.analysis);
    if (liveBrief) {
      summary = liveBrief;
    } else {
      const artifacts = await loadArtifacts();
      summary = artifacts.finalSummary || formatL1IndexSummaryBrief(artifacts.l1Index ?? input.l1Index);
    }
  }

  let effectiveL1Index: L1VideoIndexCacheRecord | null = input.l1Index ?? null;
  if (effectiveL1Index === null && input.l1Index === undefined && needsL1ForChapter) {
    const artifacts = await loadArtifacts();
    effectiveL1Index = artifacts.l1Index;
  }

  const l1ChapterCtx = needsL1ForChapter
    ? resolveL1ChapterTranslateContext({
        l1Index: effectiveL1Index,
        chunkFromSec: input.chunkFromSec,
        chunkToSec: input.chunkToSec,
        items: input.items,
        glossary
      })
    : {};

  const chapterContext =
    explicitChapterContext !== undefined
      ? normalizeSingleLine(explicitChapterContext)
      : l1ChapterCtx.chapterContext ?? "";
  const referenceEntities =
    explicitReferenceEntities !== undefined
      ? normalizeReferenceEntities(explicitReferenceEntities, glossary)
      : l1ChapterCtx.referenceEntities ?? [];
  const previousLines = normalizePreviousLines(explicitPreviousLines);

  const hasGlossary = parseSubtitleGlossary(glossary).length > 0;
  if (
    !title &&
    !ownerName &&
    !description &&
    !summary &&
    !chapterContext &&
    referenceEntities.length === 0 &&
    !hasGlossary &&
    previousLines.length === 0
  ) {
    return undefined;
  }

  return {
    ...(explicitSite !== undefined || site === "youtube" ? { site } : {}),
    ...(title ? { title } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(description ? { description } : {}),
    ...(summary ? { summary } : {}),
    ...(chapterContext ? { chapterContext } : {}),
    ...(referenceEntities.length > 0 ? { referenceEntities } : {}),
    ...(hasGlossary ? { glossary } : {}),
    ...(previousLines.length > 0 ? { previousLines } : {})
  };
}
