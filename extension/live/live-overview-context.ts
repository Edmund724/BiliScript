import { formatClock } from "../shared/clock-text.js";
import {
  MOSS_LIVE_OVERVIEW_PHASES,
  type MossLiveOverviewChapter,
  type MossLiveOverviewContext,
  type MossLiveOverviewPhase,
  type MossLiveOverviewQuote
} from "./moss-live-protocol.js";

export interface LiveOverviewAnalysisSource {
  summary?: unknown;
  chapters?: unknown;
  quotes?: unknown;
  failedRanges?: unknown;
  summaryFailed?: unknown;
}

export interface LiveOverviewSource {
  phase: string;
  analysis: LiveOverviewAnalysisSource | null;
  errorText?: string;
}

export interface LiveOverviewSubtitleState {
  fetchState?: string;
}

function normalizePhase(value: unknown): MossLiveOverviewPhase {
  return MOSS_LIVE_OVERVIEW_PHASES.includes(value as MossLiveOverviewPhase)
    ? (value as MossLiveOverviewPhase)
    : "idle";
}

function finiteSeconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function projectOverviewChapters(value: unknown): MossLiveOverviewChapter[] {
  if (!Array.isArray(value)) return [];
  const chapters: MossLiveOverviewChapter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const from = finiteSeconds(entry.from);
    const title = safeText(entry.title);
    if (from === null || !title) continue;
    const to = finiteSeconds(entry.to);
    chapters.push({
      from,
      to: to !== null && to >= from ? to : from,
      time: formatClock(from, { hours: "auto" }),
      title,
      summary: safeText(entry.summary)
    });
  }
  return chapters;
}

export function projectOverviewQuotes(value: unknown): MossLiveOverviewQuote[] {
  if (!Array.isArray(value)) return [];
  const quotes: MossLiveOverviewQuote[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const from = finiteSeconds(entry.from);
    const content = safeText(entry.content);
    if (from === null || !content) continue;
    quotes.push({ from, time: formatClock(from, { hours: "auto" }), content });
  }
  return quotes;
}

function projectFailedRanges(value: unknown): Array<{ from: number; to: number }> {
  if (!Array.isArray(value)) return [];
  const ranges: Array<{ from: number; to: number }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const from = finiteSeconds(entry.from);
    const to = finiteSeconds(entry.to);
    if (from === null || to === null) continue;
    ranges.push({ from, to });
  }
  return ranges;
}

function notReadyStatusText(
  subtitleState: LiveOverviewSubtitleState,
  { awaitingGeneration }: { awaitingGeneration: boolean }
): string {
  const fetchState = String(subtitleState.fetchState || "");
  if (fetchState === "loading") {
    return "字幕仍在加载，全片概览尚未生成；请等字幕就绪后再尝试。";
  }
  if (fetchState === "error") {
    return "字幕加载失败，暂时无法生成全片概览；请先重试字幕加载。";
  }
  if (fetchState === "empty") {
    return "当前视频没有可用字幕，暂时无法生成全片概览；请等待字幕就绪或重试字幕加载后再问。";
  }
  return awaitingGeneration
    ? "全片概览尚未生成；可以等待自动生成，或在概览页签生成后重试。"
    : "全片概览尚未生成；可以在概览页签生成后重试。";
}

function partialStatusText(failedRanges: Array<{ from: number; to: number }>, summaryFailed: boolean): string {
  const notes: string[] = [];
  if (failedRanges.length > 0) {
    notes.push(`覆盖不完整：${failedRanges.length} 段字幕生成失败，缺少对应区间的章节与金句`);
  }
  if (summaryFailed) {
    notes.push("全片简介生成失败，概览覆盖不完整；只有章节与金句可用");
  }
  if (notes.length === 0) {
    notes.push("覆盖不完整");
  }
  return `${notes.join("；")}；不得当作完整全片总结。`;
}

export function projectLiveOverview(
  source: LiveOverviewSource | null | undefined,
  subtitleState: LiveOverviewSubtitleState = {}
): MossLiveOverviewContext | null {
  if (!source) return null;

  const phase = normalizePhase(source.phase);
  const analysis =
    phase === "ready" || phase === "partial" ? source.analysis : null;
  const summary = analysis ? safeText(analysis.summary) : "";
  const chapters = analysis ? projectOverviewChapters(analysis.chapters) : [];
  const quotes = analysis ? projectOverviewQuotes(analysis.quotes) : [];
  const failedRanges = analysis ? projectFailedRanges(analysis.failedRanges) : [];
  const summaryFailed = analysis?.summaryFailed === true;
  const hasProduct = Boolean(summary) || chapters.length > 0 || quotes.length > 0;

  let coverage: MossLiveOverviewContext["coverage"] = "none";
  if (phase === "ready" && hasProduct) {
    coverage = "complete";
  } else if (phase === "partial" && hasProduct) {
    coverage = "partial";
  }

  let statusText = "";
  if (phase === "partial") {
    statusText = partialStatusText(failedRanges, summaryFailed);
  } else if (phase === "error") {
    const detail = safeText(source.errorText);
    statusText = `全片概览生成失败${detail ? `：${detail}` : ""}；可以在概览页签重试，或稍后再问。`;
  } else if (phase === "cancelled") {
    statusText = "全片概览生成已取消，尚未完成；可以稍后重试。";
  } else if (phase === "generating") {
    statusText = "全片概览正在生成，尚未完成；完成后会自动更新，未完成前不得编造全片内容。";
  } else if (!hasProduct) {
    statusText = notReadyStatusText(subtitleState, { awaitingGeneration: phase === "idle" });
  }

  return {
    phase,
    coverage,
    summary: coverage === "none" ? "" : summary,
    chapters: coverage === "none" ? [] : chapters,
    quotes: coverage === "none" ? [] : quotes,
    ...(failedRanges.length > 0 ? { failedRanges } : {}),
    ...(summaryFailed ? { summaryFailed } : {}),
    statusText
  };
}
