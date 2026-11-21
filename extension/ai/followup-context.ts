import { formatSegmentHeading } from "./subtitle-prompt.js";
import { segmentCacheProxy } from "./segment-cache-proxy.js";
import type { BudgetPlan, BudgetPlanSegment } from "./types.js";

export const RECENT_TURNS_DEFAULT = 6;

export const SEGMENT_SUMMARIES_MAX_CHARS = 40000;

const COMPRESSED_SUMMARY_MAX_CHARS = 60000;
const TRUNCATION_MARKER = "\n…（压缩摘要过长，已截断尾部）";

function normalizeMaxChars(maxChars: unknown): number {
  const n = Number(maxChars);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function truncateTail(text: unknown, maxChars: unknown): string {
  const value = String(text ?? "");
  const max = normalizeMaxChars(maxChars);
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) return value.slice(0, max);
  return value.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

interface FinalNoteInput {
  note?: unknown;
  segmentSummaries?: unknown[];
}

export function hasFinalNote({ note, segmentSummaries }: FinalNoteInput = {}): boolean {
  const noteText = String(note || "").trim();
  const hasSummaries = Array.isArray(segmentSummaries) && segmentSummaries.length > 0;
  return noteText.length > 0 && hasSummaries;
}

export function trimRecentTurns(history: unknown, turns: unknown = RECENT_TURNS_DEFAULT): unknown[] {
  const list = Array.isArray(history) ? history : [];
  const safeTurns = Math.max(1, Math.floor(Number(turns) || RECENT_TURNS_DEFAULT));
  return list.slice(-(safeTurns * 2));
}

interface CompressedSummaryInput {
  segmentSummaries?: unknown[];
  note?: unknown;
  maxChars?: number | unknown;
}

export function buildCompressedSummary({
  segmentSummaries = [],
  note = "",
  maxChars = COMPRESSED_SUMMARY_MAX_CHARS
}: CompressedSummaryInput = {}): string {
  const summaries = Array.isArray(segmentSummaries) ? segmentSummaries : [];
  const noteText = note == null ? "" : String(note);

  let summariesSection = "";
  if (summaries.length > 0) {
    const lines = summaries.map((summary, i) => `${formatSegmentHeading(i)}\n${summary == null ? "" : String(summary)}`);
    summariesSection = "## 分段小结\n\n" + truncateTail(lines.join("\n\n"), SEGMENT_SUMMARIES_MAX_CHARS);
  }

  const sections: string[] = [];
  if (summariesSection.length > 0) sections.push(summariesSection);
  if (noteText.length > 0) sections.push("## 成稿笔记\n\n" + noteText);

  return truncateTail(sections.join("\n\n"), maxChars);
}

interface LoadSegmentSummariesInput {
  context?: Record<string, unknown>;
  plan?: { segments?: BudgetPlanSegment[] } | null;
  loadSummaries?: (input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string> }) => Promise<(string | null)[]>;
}

function keepSummary(summary: unknown): summary is string {
  return typeof summary === "string" && summary.trim().length > 0;
}

export async function loadSegmentSummaries({
  context = {},
  plan = null,
  loadSummaries = (input) => segmentCacheProxy.loadSummaries(input)
}: LoadSegmentSummariesInput = {}): Promise<string[]> {
  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  const indexes = segments
    .map((segment) => segment?.index)
    .filter((index) => index !== undefined && index !== null);
  const summaries = await loadSummaries({ context, segmentIndexes: indexes });
  return (Array.isArray(summaries) ? summaries : []).filter(keepSummary);
}

export function lastAssistantContent(history: unknown = []): string {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i] as { role?: unknown; content?: unknown };
    if (message && message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

interface ResolveFollowupContextInput {
  context?: Record<string, unknown>;
  plan?: BudgetPlan | null;
  history?: unknown[];
  loadSummaries?: typeof loadSegmentSummaries;
  loadStoredSummaries?: (input: { context?: Record<string, unknown>; budgetScale?: unknown }) => Promise<string[]>;
}

export async function resolveFollowupContext({
  context = {},
  plan = null,
  history = [],
  loadSummaries = loadSegmentSummaries,
  loadStoredSummaries = (input) => segmentCacheProxy.loadStoredSummaries(input)
}: ResolveFollowupContextInput = {}): Promise<Record<string, unknown> | null> {
  if (plan?.mode !== "map-reduce") {
    return null;
  }
  if (!Array.isArray(history) || history.length === 0) {
    return null;
  }

  const note = lastAssistantContent(history);
  if (!note) {
    return null;
  }

  const inMemorySegments = Array.isArray(plan?.segments) ? plan.segments : [];
  const usingDefaultSummaryLoader = loadSummaries === loadSegmentSummaries;
  const segmentSummaries =
    inMemorySegments.length > 0 || !usingDefaultSummaryLoader
      ? await loadSummaries({ context, plan: { ...plan, segments: inMemorySegments } })
      : (await loadStoredSummaries({ context })).filter(keepSummary);
  if (!hasFinalNote({ note, segmentSummaries })) {
    return null;
  }

  const compressedSummaryMarkdown = buildCompressedSummary({ segmentSummaries, note });
  return { ...context, compressedSummaryMarkdown, subtitleBody: [] };
}
