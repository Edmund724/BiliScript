import { normalizeSubtitleItems } from "../subtitle/signature.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  GIVEN_CHAPTERS_SYSTEM_PROMPT,
  OUTLINE_QUOTES_SYSTEM_PROMPT
} from "./analysis-prompts.js";
import { MAX_ANALYSIS_CHAPTERS, type AnalysisChapter, type OverviewAnalysis } from "./analysis-validate.js";
import type { ChapterSource, ChapterSourceKind, OutlineChapter } from "../shared/chapter-outline.js";

const MAX_OUTLINE_CHAPTERS_WITH_SUMMARIES = 9;

export interface ChapterPlanPromptVars {
  title: unknown;
  ownerName: unknown;
  videoDescription: unknown;
  chapterOutline: OutlineChapter[];
  titlesOnly: boolean;
}

export interface ChapterPlanBudgetChapter {
  from?: unknown;
  title?: unknown;
}

export interface ChapterPlan {
  kind: ChapterSourceKind;
  titlesOnly: boolean;
  hasGivenChapters: boolean;
  givenChapters: OutlineChapter[];
  systemPrompt: string;
  promptVars: ChapterPlanPromptVars;
  budgetChapters: ChapterPlanBudgetChapter[];
  graft(modelChapters: AnalysisChapter[]): AnalysisChapter[];
}

export function resolveChapterPlan({
  chapterSource,
  context,
  body
}: {
  chapterSource: ChapterSource;
  context?: Record<string, unknown> | null;
  body?: unknown[];
}): ChapterPlan {
  const ctx = context || {};
  const bodyItems = Array.isArray(body) ? body : [];
  const endSeconds = resolveEndSeconds(ctx, bodyItems);
  const givenChapters = chapterSource.chapters.filter((chapter) => chapter.seconds <= endSeconds);
  const hasGivenChapters = givenChapters.length > 0;
  const titlesOnly =
    chapterSource.kind === "outline" && givenChapters.length > MAX_OUTLINE_CHAPTERS_WITH_SUMMARIES;
  const systemPrompt = !hasGivenChapters
    ? ANALYSIS_SYSTEM_PROMPT
    : titlesOnly
      ? OUTLINE_QUOTES_SYSTEM_PROMPT
      : GIVEN_CHAPTERS_SYSTEM_PROMPT;

  const promptVars: ChapterPlanPromptVars = {
    title: ctx.title,
    ownerName: ctx.author,
    videoDescription: ctx.videoDescription,
    chapterOutline: givenChapters,
    titlesOnly
  };
  const budgetChapters: ChapterPlanBudgetChapter[] =
    chapterSource.kind === "manuscript"
      ? chapterSource.signatureChapters.map((chapter) => {
          const item = chapter as { from?: unknown; title?: unknown };
          return { from: item?.from, title: item?.title };
        })
      : [];

  return {
    kind: chapterSource.kind,
    titlesOnly,
    hasGivenChapters,
    givenChapters,
    systemPrompt,
    promptVars,
    budgetChapters,
    graft: (modelChapters: AnalysisChapter[]): AnalysisChapter[] =>
      hasGivenChapters ? applyGivenChapters(givenChapters, modelChapters, endSeconds, titlesOnly) : modelChapters
  };
}

function applyGivenChapters(
  given: OutlineChapter[],
  modelChapters: AnalysisChapter[],
  endSeconds: number,
  titlesOnly = false
): AnalysisChapter[] {
  const remaining = (Array.isArray(modelChapters) ? modelChapters : []).slice();
  const out: AnalysisChapter[] = [];
  for (let i = 0; i < given.length; i += 1) {
    const from = Math.floor(Number(given[i]?.seconds) || 0);
    const nextFrom = i + 1 < given.length ? Math.floor(Number(given[i + 1]?.seconds) || 0) : null;
    const explicitTo = Math.floor(Number(given[i]?.to));
    const to =
      Number.isFinite(explicitTo) && explicitTo > from
        ? explicitTo
        : nextFrom !== null && nextFrom > from
          ? nextFrom
          : Math.max(from, Math.floor(Number(endSeconds) || 0));
    const summary = titlesOnly ? "" : takeNearestSummary(remaining, from);
    out.push({
      from,
      to,
      title: String(given[i]?.title ?? "").trim().slice(0, 300),
      summary,
      ...(!titlesOnly && !summary ? { missingSummary: true } : {})
    });
  }
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

export function flagMissingChapterSummaries(analysis: OverviewAnalysis): OverviewAnalysis {
  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : []).map((chapter) =>
    String(chapter?.summary ?? "").trim() ? chapter : { ...chapter, missingSummary: true }
  );
  return { ...analysis, chapters };
}

function takeNearestSummary(remaining: AnalysisChapter[], from: number): string {
  if (!remaining.length) {
    return "";
  }
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < remaining.length; i += 1) {
    const distance = Math.abs(Number(remaining[i]?.from) - from);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex < 0 ? "" : String(remaining.splice(bestIndex, 1)[0]?.summary ?? "");
}

function resolveEndSeconds(ctx: Record<string, unknown>, body: unknown[]): number {
  const items = normalizeSubtitleItems(body);
  const last = items.length ? items[items.length - 1] : null;
  const lastSeconds = last ? Math.max(0, Math.floor(Number(last?.to) || Number(last?.from) || 0)) : 0;
  return Math.max(Math.floor(Number(ctx.videoDuration) || 0), lastSeconds);
}
