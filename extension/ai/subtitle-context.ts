// extension/ai/subtitle-context.ts
// 字幕翻译语境提取、简介清洗、概览摘要复用、跨块前情提要与按需术语过滤。
//
// 职责：
// 1. 从已加载的视频元数据（VideoMeta / clipState）提取主标题、多 P 拼接标题、UP 主与清洗截断后的简介；
// 2. 零额外 API 开销复用概览标签页已生成的内存快照或本地缓存摘要；
// 3. 维护紧邻上一分块末尾最多 2 条只读双语前情对照；
// 4. 对用户自定义术语表做大小写不敏感匹配过滤，仅注入当前分块命中的术语及严格输出约束。

import { state } from "../core/state.js";
import { getReaderOverviewSource } from "../reader/live-overview-source.js";
import { resolveChapterSource } from "../shared/chapter-outline.js";
import { buildSubtitleSignature } from "../subtitle/cache.js";
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import {
  parseSubtitleGlossary,
  resolveSubtitleTranslateGlossary,
  type SubtitleGlossaryEntry,
  type SubtitleGlossaryInput
} from "./subtitle-translate-config.js";
import type { SubtitleBodyItem } from "./types.js";

export type { SubtitleGlossaryEntry, SubtitleGlossaryInput };
export { parseSubtitleGlossary, resolveSubtitleTranslateGlossary };

export const SUBTITLE_CONTEXT_DESCRIPTION_MAX_CHARS = 400;
export const SUBTITLE_CONTEXT_SUMMARY_MAX_CHARS = 600;
export const SUBTITLE_CONTEXT_PREVIOUS_LINES_MAX = 2;

const ANALYSIS_FINAL_PREFIX = "biliscript_lvs_analysis_final_";

export interface SubtitlePreviousLine {
  original: string;
  translation: string;
}

export interface SubtitleTranslatePromptContext {
  title?: string;
  partTitle?: string;
  pageCount?: number;
  ownerName?: string;
  description?: string;
  summary?: string;
  glossary?: SubtitleGlossaryInput;
  previousLines?: readonly SubtitlePreviousLine[];
}

export interface VideoStaticContextInput {
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

/**
 * UTF-16 代理对安全截断，保证返回值长度不超过 maxChars。
 */
export function truncateTextSafe(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (limit === 0 || !text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  if (limit === 1) {
    return "…";
  }
  let end = limit - 1;
  const prev = text.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    end -= 1;
  }
  const prefix = text.slice(0, end).trimEnd();
  return prefix ? `${prefix}…` : "…";
}

/**
 * 组合视频主标题与分 P 标题：仅多 P 视频（或显式传入且未标记单 P 的分 P 标题）且与主标题不同时拼接。
 */
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

const URL_WITH_LABEL_PATTERN =
  /(?:(?:项目|课程|视频|相关|参考|原文)?(?:源码|地址|链接|网址|资料|仓库|官网|传送门)\s*[:：]?\s*)?(?:https?:\/\/|www\.|b23\.tv\/)[^\s<>\]\)）"']+/gi;
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

/**
 * 清洗视频简介中的 URL 与无关抽奖/引流文案，并安全截断至指定字符上限（默认 400）。
 */
export function cleanVideoDescription(
  rawDescription: unknown,
  maxChars = SUBTITLE_CONTEXT_DESCRIPTION_MAX_CHARS
): string {
  const normalized = String(rawDescription ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const keptLines: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    let line = rawLine.replace(URL_WITH_LABEL_PATTERN, " ");
    for (const pattern of INLINE_LOTTERY_PATTERNS) {
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

/**
 * 从视频元数据 / clipState 中提取静态语境（零额外 API 调用）。
 */
export function extractVideoStaticContext(
  input: VideoStaticContextInput | null | undefined
): VideoStaticContext {
  if (!input) {
    return { title: "", ownerName: "", description: "" };
  }
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
  const description = cleanVideoDescription(input.description);
  return { title, ownerName, description };
}

/**
 * 将「概览」产物（全文摘要 + 章节概要）压缩为适合注入翻译上下文的简本。
 */
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

/**
 * 读取当前视频已生成的概览摘要缓存（优先内存快照，次选 chrome.storage.local 整份概览缓存），零额外 LLM 请求。
 */
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

  // 内存快照：仅当身份与当前 clip 对齐时直接复用，避免跨片串用。
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

  const body = Array.isArray(input.subtitleBody) ? input.subtitleBody : [];
  if (!bvid || !cid || body.length === 0 || !globalThis.chrome?.storage?.local) {
    return "";
  }

  try {
    const chapterSource = resolveChapterSource(
      input.description,
      input.hotComments,
      input.chapters
    );
    const signature = buildSubtitleSignature({
      lang: input.selectedSubtitleLang,
      subtitleId: input.selectedSubtitleId,
      subtitleUrl: input.selectedSubtitleUrl,
      body,
      chapters: chapterSource.signatureChapters,
      chapterOutline: chapterSource.chapters
    });
    const sourceKey = buildSubtitleSourceKey(
      input.selectedSubtitleId,
      input.selectedSubtitleUrl,
      input.selectedSubtitleLang
    );
    const finalKey = `${ANALYSIS_FINAL_PREFIX}${bvid}_${cid}_${sourceKey}_${signature}`;
    const stored = await chrome.storage.local.get(finalKey);
    const record = stored?.[finalKey] as { analysis?: OverviewSummarySourceInput } | undefined;
    return formatOverviewSummaryBrief(record?.analysis);
  } catch {
    return "";
  }
}

/**
 * 归一化前情对照条数（仅保留原文与译文均非空的最后 N 条）。
 */
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

/**
 * 从已完成翻译的原文/译文条目中提取末尾最多 2 条双语对照。
 */
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

/**
 * 从按时间片累加的原文与译文集合中，按时间点提取紧邻当前分块之前末尾最多 2 条双语对照。
 */
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlossaryMatcher(source: string): RegExp {
  const escapedParts = source
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part));
  const body = escapedParts.join("\\s+");
  const hasWordStart = /^[A-Za-z0-9_]/.test(source);
  const hasWordEnd = /[A-Za-z0-9_]$/.test(source);
  const allowPluralS = hasWordEnd && source.length >= 3 && /[A-Za-rt-z]$/.test(source);
  const prefix = hasWordStart ? "(?<![A-Za-z0-9_])" : "";
  const suffix = hasWordEnd ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${prefix}${body}${allowPluralS ? "s?" : ""}${suffix}`, "i");
}

/**
 * 按当前分块原文（大小写不敏感）过滤实际出现过的术语条目，避免全量词表浪费 Token。
 */
export function filterGlossaryForText(
  glossary: SubtitleGlossaryInput | null | undefined,
  text: string
): SubtitleGlossaryEntry[] {
  const entries = parseSubtitleGlossary(glossary);
  const targetText = String(text ?? "");
  if (entries.length === 0 || !targetText.trim()) {
    return [];
  }

  return entries.filter((entry) => compileGlossaryMatcher(entry.source).test(targetText));
}

/**
 * 将术语条目列表格式化为 Prompt 文本（支持指定译文与强制保留原词）。
 */
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

/**
 * 构造注入 System Prompt 的 `# Context` 与 `# Glossary` 段落。
 * 若传入 `options.chunkText`，则仅注入在该分块原文中命中的术语；未传时保留传入的全部术语条目。
 */
export function buildSubtitleContextPromptBlock(
  context?: SubtitleTranslatePromptContext | null,
  options?: { chunkText?: string }
): string {
  if (!context) {
    return "";
  }

  const contextLines: string[] = [];
  const title = formatMultiPartTitle(
    context.title,
    context.partTitle,
    context.pageCount
  );
  const ownerName = normalizeSingleLine(context.ownerName);
  const description = cleanVideoDescription(context.description);
  const summary = String(context.summary ?? "").trim();
  const previousLines = normalizePreviousLines(context.previousLines);

  if (title) {
    contextLines.push(`视频标题：${title}`);
  }
  if (ownerName) {
    contextLines.push(`UP 主：${ownerName}`);
  }
  if (description) {
    contextLines.push(`视频简介：${description}`);
  }
  if (summary) {
    contextLines.push(`内容摘要：${summary}`);
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

/**
 * 基于全局上下文与当前分块原文构造单次分块请求使用的裁剪版上下文（按需过滤术语 + 注入跨块前情）。
 */
export function buildChunkSubtitleContext(
  baseContext: SubtitleTranslatePromptContext | undefined,
  chunkText: string,
  previousLines?: readonly SubtitlePreviousLine[]
): SubtitleTranslatePromptContext | undefined {
  const effectivePrevious =
    previousLines !== undefined ? normalizePreviousLines(previousLines) : normalizePreviousLines(baseContext?.previousLines);
  const filteredGlossary = filterGlossaryForText(baseContext?.glossary, chunkText);

  const hasBaseStatic = Boolean(
    baseContext &&
      (normalizeSingleLine(baseContext.title) ||
        normalizeSingleLine(baseContext.partTitle) ||
        normalizeSingleLine(baseContext.ownerName) ||
        cleanVideoDescription(baseContext.description) ||
        String(baseContext.summary ?? "").trim())
  );

  if (!hasBaseStatic && filteredGlossary.length === 0 && effectivePrevious.length === 0) {
    return undefined;
  }

  return {
    ...(baseContext?.title ? { title: baseContext.title } : {}),
    ...(baseContext?.partTitle ? { partTitle: baseContext.partTitle } : {}),
    ...(baseContext?.pageCount !== undefined ? { pageCount: baseContext.pageCount } : {}),
    ...(baseContext?.ownerName ? { ownerName: baseContext.ownerName } : {}),
    ...(baseContext?.description ? { description: baseContext.description } : {}),
    ...(baseContext?.summary ? { summary: baseContext.summary } : {}),
    ...(filteredGlossary.length > 0 ? { glossary: filteredGlossary } : {}),
    ...(effectivePrevious.length > 0 ? { previousLines: effectivePrevious } : {})
  };
}

export interface ResolveRuntimeSubtitleContextInput extends SubtitleTranslatePromptContext {
  context?: SubtitleTranslatePromptContext;
}

/**
 * 解析当前视频字幕翻译上下文：
 * 显式传入字段优先；缺省字段自动从 state.clip、概览缓存与 state.settings.subtitleTranslateGlossary 补充。
 */
export async function resolveRuntimeSubtitleContext(
  input: ResolveRuntimeSubtitleContextInput = {}
): Promise<SubtitleTranslatePromptContext | undefined> {
  const base = input.context;
  const clipStatic = extractVideoStaticContext(state.clip);

  const explicitTitle = input.title ?? base?.title;
  const explicitPartTitle = input.partTitle ?? base?.partTitle;
  const explicitPageCount = input.pageCount ?? base?.pageCount;
  const explicitOwner = input.ownerName ?? base?.ownerName;
  const explicitDescription = input.description ?? base?.description;
  const explicitSummary = input.summary ?? base?.summary;
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
      ? cleanVideoDescription(explicitDescription)
      : clipStatic.description;
  const summary =
    explicitSummary !== undefined
      ? String(explicitSummary ?? "").trim()
      : await readCachedOverviewSummary(state.clip);
  const glossary =
    explicitGlossary !== undefined
      ? explicitGlossary
      : resolveSubtitleTranslateGlossary(state.settings);
  const previousLines = normalizePreviousLines(explicitPreviousLines);

  const hasGlossary = parseSubtitleGlossary(glossary).length > 0;
  if (
    !title &&
    !ownerName &&
    !description &&
    !summary &&
    !hasGlossary &&
    previousLines.length === 0
  ) {
    return undefined;
  }

  return {
    ...(title ? { title } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(description ? { description } : {}),
    ...(summary ? { summary } : {}),
    ...(hasGlossary ? { glossary } : {}),
    ...(previousLines.length > 0 ? { previousLines } : {})
  };
}
