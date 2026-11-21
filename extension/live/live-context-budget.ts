import { formatClock } from "../shared/clock-text.js";
import type {
  MossLiveOverviewChapter,
  MossLiveOverviewContext,
  MossLiveRoomContext,
  MossLiveSessionContext,
  MossLiveVideoContext
} from "./moss-live-protocol.js";

export const LIVE_CONTEXT_COMPACT_MAX_CHARS = 1500;
export const LIVE_CONTEXT_HARD_MAX_CHARS = 3000;
export const LIVE_CONTEXT_TIER_B_MAX_CHAPTERS = 40;
export const LIVE_CONTEXT_TIER_B_SUMMARY_MAX_CHARS = 500;
export const LIVE_CONTEXT_TIER_C_SUMMARY_MAX_CHARS = 320;
export const LIVE_CONTEXT_TIER_C_MAX_ANCHORS = 20;
export const LIVE_CONTEXT_CHARS_PER_TOKEN = 1;

export type LiveContextBudgetTier = "none" | "live-room" | "A" | "B" | "C";

export interface LiveContextBudgetOptions {
  clientDelegation?: boolean;
}

export interface LiveContextBudgetResult {
  tier: LiveContextBudgetTier;
  text: string;
  charCount: number;
  estimatedTokens: number;
  totalChapters: number;
  includedChapters: number;
}

export interface NormalizedBudgetChapter {
  from: number;
  to: number;
  title: string;
  summary: string;
}

const RAW_SUBTITLE_SECTION_RE =
  /(?:^|\n)##[ \t]*(?:相关原始字幕段|字幕)(?=[ \t]*(?:\n|$))[\s\S]*?(?=\n##[ \t]+|$)/g;
const RAW_SEGMENT_LINE_RE =
  /^\s*\[(?:\d+:)?\d+:\d{2}\s*[-–—]\s*(?:\d+:)?\d+:\d{2}\]\s+/;
const RAW_BULLET_LINE_RE =
  /^\s*(?:-\s*)?`(?:\d+:)?\d+:\d{2}`\s+/;
const FINAL_NOTE_SECTION_RE =
  /(?:^|\n)##[ \t]*成稿笔记[ \t]*(?:\n|$)([\s\S]*?)(?=\n##[ \t]+|$)/;
const SEGMENT_SUMMARIES_HEADING_RE =
  /(?:^|\n)##[ \t]*分段小结(?=[ \t]*(?:\n|$))/g;
const SEGMENT_ITEM_HEADING_RE =
  /(?:^|\n)###[ \t]*片段[ \t]*\d+(?=[ \t]*(?:\n|$))/g;

const TIER_C_PRESETS = [
  {
    anchors: LIVE_CONTEXT_TIER_C_MAX_ANCHORS,
    summaryChars: LIVE_CONTEXT_TIER_C_SUMMARY_MAX_CHARS,
    titleChars: 48,
    failedMax: 3,
    statusChars: 200
  },
  { anchors: 14, summaryChars: 240, titleChars: 40, failedMax: 3, statusChars: 160 },
  { anchors: 10, summaryChars: 180, titleChars: 32, failedMax: 2, statusChars: 140 },
  { anchors: 6, summaryChars: 120, titleChars: 28, failedMax: 1, statusChars: 120 },
  { anchors: 4, summaryChars: 80, titleChars: 24, failedMax: 1, statusChars: 100 }
] as const;

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeSingleLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function finiteNonNegativeSeconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / LIVE_CONTEXT_CHARS_PER_TOKEN);
}

export function truncateUtf16Safe(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (limit === 0 || !text) return "";
  if (text.length <= limit) return text;
  if (limit === 1) return "…";
  let end = limit - 1;
  const prev = text.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    end -= 1;
  }
  const prefix = text.slice(0, end).trimEnd();
  return prefix ? `${prefix}…` : "…";
}

export function sanitizeLiveSummaryMarkdown(markdown: string): string {
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";
  const withoutSections = normalized.replace(RAW_SUBTITLE_SECTION_RE, "");
  const keptLines = withoutSections
    .split("\n")
    .filter((line) => !RAW_SEGMENT_LINE_RE.test(line) && !RAW_BULLET_LINE_RE.test(line));
  return keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractCoreSummaryLead(markdown: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  const sanitized = sanitizeLiveSummaryMarkdown(markdown);
  if (!sanitized || limit === 0) return "";

  const finalMatch = FINAL_NOTE_SECTION_RE.exec(sanitized);
  const rawBody = finalMatch && finalMatch[1].trim()
    ? finalMatch[1]
    : sanitized
        .replace(SEGMENT_SUMMARIES_HEADING_RE, "")
        .replace(SEGMENT_ITEM_HEADING_RE, "");

  const compacted = rawBody
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (!compacted) return "";
  if (compacted.length <= limit) return compacted;

  if (limit >= 4) {
    const searchWindow = compacted.slice(0, limit - 1);
    const minCut = Math.floor(limit * 0.5);
    let cutPos = -1;
    for (let i = searchWindow.length - 1; i >= minCut; i--) {
      const ch = searchWindow[i];
      if (ch === "。" || ch === "！" || ch === "？" || ch === "；" || ch === "\n") {
        cutPos = i;
        break;
      }
    }
    if (cutPos >= minCut) {
      const ch = compacted[cutPos];
      const prefix = ch === "\n" || ch === "；"
        ? compacted.slice(0, cutPos).trimEnd()
        : compacted.slice(0, cutPos + 1).trimEnd();
      if (prefix && prefix.length + 1 <= limit) {
        return `${prefix}…`;
      }
    }
  }

  return truncateUtf16Safe(compacted, limit);
}

function normalizeBudgetChapters(
  chapters: ReadonlyArray<{ title?: unknown; from?: unknown; to?: unknown; summary?: unknown }> | null | undefined
): NormalizedBudgetChapter[] {
  if (!Array.isArray(chapters)) return [];
  const valid: NormalizedBudgetChapter[] = [];
  for (const item of chapters) {
    if (!item || typeof item !== "object") continue;
    const from = finiteNonNegativeSeconds(item.from);
    const title = safeSingleLine(item.title);
    if (from === null || !title) continue;
    const rawTo = finiteNonNegativeSeconds(item.to);
    valid.push({
      from,
      to: rawTo !== null && rawTo >= from ? rawTo : from,
      title,
      summary: safeText(item.summary)
    });
  }
  valid.sort((a, b) => a.from - b.from);

  const unique: NormalizedBudgetChapter[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of valid) {
    const key = `${item.from}|${item.title.toLowerCase()}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      if (!unique[existingIndex].summary && item.summary) {
        unique[existingIndex] = { ...unique[existingIndex], summary: item.summary };
      }
      continue;
    }
    indexByKey.set(key, unique.length);
    unique.push(item);
  }
  return unique;
}

export function mergeChapterSkeletonIntervals(
  chapters: ReadonlyArray<NormalizedBudgetChapter>,
  maxAnchors: number,
  titleMaxChars: number
): string[] {
  const count = chapters.length;
  const cap = Math.max(0, Math.floor(Number(maxAnchors) || 0));
  if (count === 0 || cap === 0) return [];
  if (count <= cap) {
    return chapters.map(
      (chapter) => `${formatClock(chapter.from, { hours: "auto" })} ${truncateUtf16Safe(chapter.title, titleMaxChars)}`
    );
  }
  if (cap === 1) {
    const first = chapters[0];
    return [`${formatClock(first.from, { hours: "auto" })} ${truncateUtf16Safe(first.title, titleMaxChars)}`];
  }

  const firstAnchor = chapters[0];
  const lastAnchor = chapters[count - 1];
  const lines: string[] = [
    `${formatClock(firstAnchor.from, { hours: "auto" })} ${truncateUtf16Safe(firstAnchor.title, titleMaxChars)}`
  ];

  const middleTotal = count - 2;
  const middleBuckets = cap - 2;
  if (middleBuckets > 0 && middleTotal > 0) {
    for (let i = 0; i < middleBuckets; i++) {
      const startIdx = 1 + Math.floor((i * middleTotal) / middleBuckets);
      const endIdx = 1 + Math.floor(((i + 1) * middleTotal) / middleBuckets);
      const bucketCount = endIdx - startIdx;
      if (bucketCount <= 0) continue;
      const bucketFirst = chapters[startIdx];
      const bucketLast = chapters[endIdx - 1];
      const safeTitle = truncateUtf16Safe(bucketFirst.title, titleMaxChars);
      if (bucketCount === 1) {
        lines.push(`${formatClock(bucketFirst.from, { hours: "auto" })} ${safeTitle}`);
        continue;
      }
      const nextChapter = endIdx < count ? chapters[endIdx] : null;
      const endSec = bucketLast.to > bucketLast.from
        ? bucketLast.to
        : nextChapter && nextChapter.from > bucketFirst.from
          ? nextChapter.from
          : bucketLast.from;
      if (endSec > bucketFirst.from) {
        lines.push(
          `${formatClock(bucketFirst.from, { hours: "auto" })}–${formatClock(endSec, { hours: "auto" })} ${safeTitle}（含${bucketCount}章）`
        );
      } else {
        lines.push(
          `${formatClock(bucketFirst.from, { hours: "auto" })} ${safeTitle}（含${bucketCount}章）`
        );
      }
    }
  }

  lines.push(
    `${formatClock(lastAnchor.from, { hours: "auto" })} ${truncateUtf16Safe(lastAnchor.title, titleMaxChars)}`
  );
  return lines;
}

function noOverviewLine(clientDelegation: boolean): string {
  return clientDelegation
    ? "全片概览：当前没有可用的本地概览；需要全片总结或脉络时发起后台委派，不得编造全片内容。"
    : "全片概览：当前没有可用的全片概览；遇到全片总结类问题时如实说明无法总结，不得编造全片内容。";
}

function formatFailedRanges(
  failedRanges: ReadonlyArray<{ from: number; to: number }> | undefined,
  maxItems?: number
): string {
  if (!Array.isArray(failedRanges) || failedRanges.length === 0) return "";
  const valid: Array<{ from: number; to: number }> = [];
  for (const range of failedRanges) {
    const from = finiteNonNegativeSeconds(range?.from);
    const to = finiteNonNegativeSeconds(range?.to);
    if (from === null || to === null) continue;
    valid.push({ from, to: Math.max(from, to) });
  }
  if (valid.length === 0) return "";
  const limit = maxItems !== undefined ? Math.max(1, maxItems) : valid.length;
  const shown = valid.slice(0, limit).map(
    (range) => `${formatClock(range.from, { hours: "auto" })}–${formatClock(range.to, { hours: "auto" })}`
  );
  const suffix = valid.length > limit ? `等共${valid.length}段` : "";
  return `未覆盖区间：${shown.join("、")}${suffix}`;
}

function buildMetaLines(context: MossLiveVideoContext): string[] {
  const bvid = safeSingleLine(context.bvid);
  const cid = safeSingleLine(context.cid);
  const title = truncateUtf16Safe(safeSingleLine(context.title) || bvid, 120);
  const pageTitle = truncateUtf16Safe(safeSingleLine(context.pageTitle), 80);
  const pageIndex = Number(context.pageIndex) > 0 ? Math.floor(Number(context.pageIndex)) : 1;
  const pageCount = Number(context.pageCount) > 0 ? Math.floor(Number(context.pageCount)) : 0;
  const part = `P${pageIndex}${pageTitle ? ` ${pageTitle}` : ""}`;
  return [
    `当前视频：${title}`,
    `BV：${bvid}`,
    `CID：${cid}`,
    `当前分P：${part}${pageCount ? ` / 共${pageCount}P` : ""}`
  ];
}

function buildTierAOverviewLines(
  overview: MossLiveOverviewContext | null | undefined,
  overviewChapters: ReadonlyArray<NormalizedBudgetChapter>,
  clientDelegation: boolean
): string[] {
  if (!overview) {
    return [noOverviewLine(clientDelegation)];
  }
  const lines = [`全片概览状态：${overview.phase}（覆盖：${overview.coverage}）`];
  const statusText = safeText(overview.statusText);
  if (statusText) {
    lines.push(statusText);
  }
  if (overview.coverage !== "none") {
    const summary = safeText(overview.summary);
    if (summary) {
      lines.push(`全片简介：${summary}`);
    }
    if (overviewChapters.length > 0) {
      lines.push("章节脉络（引用时保留以下时刻文本）：");
      for (const chapter of overviewChapters) {
        lines.push(
          `- ${formatClock(chapter.from, { hours: "auto" })} ${chapter.title}${chapter.summary ? `：${chapter.summary}` : ""}`
        );
      }
    }
    const quotes = Array.isArray(overview.quotes)
      ? overview.quotes
          .map((quote) => ({
            from: finiteNonNegativeSeconds(quote?.from),
            content: safeSingleLine(quote?.content)
          }))
          .filter((quote): quote is { from: number; content: string } => quote.from !== null && Boolean(quote.content))
      : [];
    if (quotes.length > 0) {
      lines.push("金句（引用时保留以下时刻文本）：");
      for (const quote of quotes) {
        lines.push(`- ${formatClock(quote.from, { hours: "auto" })} ${quote.content}`);
      }
    }
  }
  const failedText = formatFailedRanges(overview.failedRanges);
  if (failedText) {
    lines.push(failedText);
  }
  return lines;
}

function buildCompactStatusLines(
  overview: MossLiveOverviewContext | null | undefined,
  clientDelegation: boolean,
  statusChars: number,
  failedMax: number
): string[] {
  if (!overview) {
    return [noOverviewLine(clientDelegation)];
  }
  const lines = [`全片概览状态：${overview.phase}（覆盖：${overview.coverage}）`];
  const statusText = safeSingleLine(overview.statusText);
  if (statusText) {
    lines.push(truncateUtf16Safe(statusText, statusChars));
  }
  const failedText = formatFailedRanges(overview.failedRanges, failedMax);
  if (failedText) {
    lines.push(failedText);
  }
  return lines;
}

function buildCoreLeadLines(
  overview: MossLiveOverviewContext | null | undefined,
  sanitizedCompressed: string,
  leadBudget: number
): string[] {
  const rawOverviewSummary = overview && overview.coverage !== "none"
    ? safeText(overview.summary)
    : "";
  if (!rawOverviewSummary && !sanitizedCompressed) {
    return [];
  }

  let overviewLead = "";
  let compressedLead = "";
  if (rawOverviewSummary && sanitizedCompressed) {
    const candidateOverview = extractCoreSummaryLead(rawOverviewSummary, leadBudget);
    const candidateCompressed = extractCoreSummaryLead(sanitizedCompressed, leadBudget);
    if (candidateOverview.length + candidateCompressed.length <= leadBudget) {
      overviewLead = candidateOverview;
      compressedLead = candidateCompressed;
    } else {
      const half = Math.floor(leadBudget / 2);
      const overviewBudget = candidateCompressed.length < half
        ? leadBudget - candidateCompressed.length
        : half;
      overviewLead = extractCoreSummaryLead(rawOverviewSummary, overviewBudget);
      compressedLead = extractCoreSummaryLead(
        sanitizedCompressed,
        Math.max(0, leadBudget - overviewLead.length)
      );
    }
  } else if (rawOverviewSummary) {
    overviewLead = extractCoreSummaryLead(rawOverviewSummary, leadBudget);
  } else {
    compressedLead = extractCoreSummaryLead(sanitizedCompressed, leadBudget);
  }

  const lines: string[] = [];
  if (overviewLead) lines.push(`全片简介：${overviewLead}`);
  if (compressedLead) lines.push(`压缩摘要导读：${compressedLead}`);
  return lines;
}

function formatBudgetResult(
  tier: LiveContextBudgetTier,
  text: string,
  totalChapters: number,
  includedChapters: number
): LiveContextBudgetResult {
  return {
    tier,
    text,
    charCount: text.length,
    estimatedTokens: estimateTokens(text),
    totalChapters,
    includedChapters
  };
}

function isLiveRoom(context: MossLiveSessionContext): context is MossLiveRoomContext {
  return "kind" in context && context.kind === "live-room";
}

export function assembleLiveContextBudget(
  context: MossLiveSessionContext | null | undefined,
  options: LiveContextBudgetOptions = {}
): LiveContextBudgetResult {
  if (!context) {
    return formatBudgetResult("none", "", 0, 0);
  }

  if (isLiveRoom(context)) {
    const lines = [`当前直播间：${context.title || context.roomId}`];
    if (context.anchorName) {
      lines.push(`主播：${context.anchorName}`);
    }
    return formatBudgetResult("live-room", lines.join("\n"), 0, 0);
  }

  const clientDelegation = options.clientDelegation === true;
  const overview = context.overview;
  const normalizedContextChapters = normalizeBudgetChapters(context.chapters);
  const normalizedOverviewChapters: ReadonlyArray<NormalizedBudgetChapter> =
    overview && overview.coverage !== "none"
      ? normalizeBudgetChapters(overview.chapters as ReadonlyArray<MossLiveOverviewChapter>)
      : [];
  const effectiveChapters = normalizedOverviewChapters.length > 0
    ? normalizedOverviewChapters
    : normalizedContextChapters;
  const totalChapters = effectiveChapters.length;
  const sanitizedCompressed = context.compressedSummaryMarkdown
    ? sanitizeLiveSummaryMarkdown(context.compressedSummaryMarkdown)
    : "";
  const metaLines = buildMetaLines(context);

  if (
    totalChapters <= LIVE_CONTEXT_TIER_B_MAX_CHAPTERS &&
    normalizedContextChapters.length <= LIVE_CONTEXT_TIER_B_MAX_CHAPTERS
  ) {
    const tierAChapterText = normalizedContextChapters.length > 0
      ? normalizedContextChapters
          .map((chapter) => `${formatClock(chapter.from, { hours: "auto" })} ${chapter.title}`)
          .join("；")
      : "无章节信息";
    const tierALines = [
      ...metaLines,
      `章节：${tierAChapterText}`,
      ...buildTierAOverviewLines(overview, normalizedOverviewChapters, clientDelegation)
    ];
    if (sanitizedCompressed) {
      tierALines.push(`压缩摘要：\n${sanitizedCompressed}`);
    }
    const tierAText = tierALines.join("\n");
    if (tierAText.length <= LIVE_CONTEXT_COMPACT_MAX_CHARS) {
      return formatBudgetResult("A", tierAText, totalChapters, totalChapters);
    }
  }

  if (totalChapters <= LIVE_CONTEXT_TIER_B_MAX_CHAPTERS) {
    const tierBLines = [
      ...metaLines,
      ...buildCompactStatusLines(overview, clientDelegation, 240, 6),
      ...buildCoreLeadLines(overview, sanitizedCompressed, LIVE_CONTEXT_TIER_B_SUMMARY_MAX_CHARS)
    ];
    if (totalChapters === 0) {
      tierBLines.push("章节：无章节信息");
    } else {
      tierBLines.push(`章节骨架（共${totalChapters}章，引用时保留以下时刻文本）：`);
      for (const chapter of effectiveChapters) {
        tierBLines.push(
          `- ${formatClock(chapter.from, { hours: "auto" })} ${truncateUtf16Safe(chapter.title, 80)}`
        );
      }
    }
    const tierBText = tierBLines.join("\n");
    if (tierBText.length <= LIVE_CONTEXT_HARD_MAX_CHARS) {
      return formatBudgetResult("B", tierBText, totalChapters, totalChapters);
    }
  }

  let fallbackText = "";
  let fallbackIncluded = 0;
  for (const preset of TIER_C_PRESETS) {
    const tierCLines = [
      ...metaLines,
      ...buildCompactStatusLines(overview, clientDelegation, preset.statusChars, preset.failedMax),
      ...buildCoreLeadLines(overview, sanitizedCompressed, preset.summaryChars)
    ];
    let includedChapters = 0;
    if (totalChapters === 0) {
      tierCLines.push("章节：无章节信息");
    } else {
      const merged = mergeChapterSkeletonIntervals(effectiveChapters, preset.anchors, preset.titleChars);
      includedChapters = merged.length;
      const header = totalChapters <= preset.anchors
        ? `章节骨架（共${totalChapters}章，引用时保留以下时刻文本）：`
        : `章节骨架（共${totalChapters}章，已合并为${merged.length}个顶层区间，引用时保留以下时刻文本）：`;
      tierCLines.push(header);
      for (const entry of merged) {
        tierCLines.push(`- ${entry}`);
      }
    }
    const candidateText = tierCLines.join("\n");
    fallbackText = candidateText;
    fallbackIncluded = includedChapters;
    if (candidateText.length <= LIVE_CONTEXT_HARD_MAX_CHARS) {
      return formatBudgetResult("C", candidateText, totalChapters, includedChapters);
    }
  }

  const clamped = truncateUtf16Safe(fallbackText, LIVE_CONTEXT_HARD_MAX_CHARS);
  return formatBudgetResult("C", clamped, totalChapters, fallbackIncluded);
}
