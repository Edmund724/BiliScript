import type { BudgetPlan, BudgetPlanSegment, ChapterItem, SubtitleBodyItem } from "./types.js";

export const CHAR_PER_TOKEN = 1.0;
export const MATERIAL_BUDGET_CHARS = 200000;
export const SEGMENT_INPUT_CHARS = 50000;
export const SEGMENT_SUMMARY_CHARS = 10000;
export const REDUCE_GROUP_INPUT_CHARS = 100000;
export const FINAL_OUTPUT_CHARS = 16000;
export const REDUCE_TRIGGER_CHARS = 500000;

interface BudgeterInputItem {
  from: number;
  to: number;
  content: string;
  chars: number;
}

interface RawSegment {
  from: number;
  to: number;
  chars: number;
  items: SubtitleBodyItem[];
}

interface BuildBudgetPlanOptions {
  segmentInputChars?: number | string;
  reduceGroupInputChars?: number | string;
}

function segmentsPerReduceGroup(reduceGroupInputChars: number): number {
  return Math.floor(reduceGroupInputChars / SEGMENT_SUMMARY_CHARS);
}

function toSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function estimateTokens(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return text.length * CHAR_PER_TOKEN;
}

function estimateReduceCalls(segmentCount: number, reduceGroupInputChars: number): number {
  let calls = 0;
  let n = segmentCount;
  while (n > 1) {
    n = Math.ceil(n / segmentsPerReduceGroup(reduceGroupInputChars));
    calls += n;
  }
  return calls;
}

function splitByBudget(
  items: BudgeterInputItem[],
  chapterStarts: number[],
  segmentInputChars: number
): BudgetPlanSegment[] {
  const segments: RawSegment[] = [];
  let current: RawSegment | null = null;
  let prevFrom: number | null = null;

  for (const item of items) {
    const prevFromValue = prevFrom;
    const crossesIntoChapter =
      current !== null &&
      current.items.length > 0 &&
      prevFromValue !== null &&
      chapterStarts.some((start) => prevFromValue < start && item.from >= start);

    if (crossesIntoChapter && current) {
      segments.push(current);
      current = null;
    }

    if (!current) {
      current = { from: item.from, to: item.to, chars: 0, items: [] };
    }
    current.items.push({ from: item.from, to: item.to, content: item.content });
    current.chars += item.chars;
    current.to = item.to;
    prevFrom = item.from;

    if (current.chars >= segmentInputChars) {
      segments.push(current);
      current = null;
    }
  }

  if (current && current.items.length > 0) {
    segments.push(current);
  }

  return segments.map((seg, i) => ({
    index: i + 1,
    from: seg.from,
    to: seg.to,
    chars: seg.chars,
    items: seg.items
  }));
}

export function buildBudgetPlan(
  { body = [], chapters = [] }: { body?: unknown[]; chapters?: unknown[] } = {},
  options: BuildBudgetPlanOptions = {}
): BudgetPlan {
  const segmentInputChars =
    Number(options.segmentInputChars) > 0 ? Number(options.segmentInputChars) : SEGMENT_INPUT_CHARS;
  const reduceGroupInputChars =
    Number(options.reduceGroupInputChars) > 0
      ? Number(options.reduceGroupInputChars)
      : REDUCE_GROUP_INPUT_CHARS;
  const bodyItems = Array.isArray(body) ? body : [];
  const chapterItems = Array.isArray(chapters) ? chapters : [];

  const items: BudgeterInputItem[] = [];
  let totalChars = 0;
  for (const item of bodyItems) {
    const content = String(item && (item as { content?: unknown }).content != null
      ? (item as { content?: unknown }).content
      : "");
    const chars = content.trim().length;
    if (chars === 0) {
      continue;
    }
    items.push({
      from: toSeconds(item && (item as { from?: unknown }).from),
      to: toSeconds(item && (item as { to?: unknown }).to),
      content,
      chars
    });
    totalChars += chars;
  }

  const mode: BudgetPlan["mode"] = totalChars > MATERIAL_BUDGET_CHARS ? "map-reduce" : "single";

  let segments: BudgetPlanSegment[] = [];
  if (mode === "map-reduce") {
    const chapterStarts: number[] = [];
    for (const chapter of chapterItems) {
      const start = Number(chapter && (chapter as { from?: unknown }).from);
      if (Number.isFinite(start) && start >= 0) {
        chapterStarts.push(start);
      }
    }
    segments = splitByBudget(items, chapterStarts, segmentInputChars);
  }

  const needsReduce = totalChars > REDUCE_TRIGGER_CHARS;
  const estimatedCalls =
    mode === "single"
      ? 1
      : segments.length + 1 + (needsReduce ? estimateReduceCalls(segments.length, reduceGroupInputChars) : 0);

  return {
    totalChars,
    estimatedTokens: totalChars * CHAR_PER_TOKEN,
    mode,
    segments,
    estimatedCalls,
    needsReduce,
    reduceGroupInputChars
  };
}
