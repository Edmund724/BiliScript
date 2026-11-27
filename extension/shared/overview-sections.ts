import type { ChapterSource, OutlineChapter } from "./chapter-outline.js";
import type { AnalysisChapter } from "../ai/analysis-validate.js";

export interface OverviewAiSections {
  summary: boolean;
  chapters: boolean;
  quotes: boolean;
}

export interface OverviewGenerationConfig {
  autoGenerate: boolean;
  sections: OverviewAiSections;
}

export const DEFAULT_OVERVIEW_AI_SECTIONS: Readonly<OverviewAiSections> = Object.freeze({
  summary: true,
  chapters: true,
  quotes: true
});

export const DEFAULT_OVERVIEW_GENERATION_CONFIG: Readonly<OverviewGenerationConfig> = Object.freeze({
  autoGenerate: true,
  sections: DEFAULT_OVERVIEW_AI_SECTIONS
});

export function normalizeOverviewAiSections(
  input?: Partial<OverviewAiSections> | null
): OverviewAiSections {
  return {
    summary: input?.summary !== false,
    chapters: input?.chapters !== false,
    quotes: input?.quotes !== false
  };
}

export function resolveOverviewConfigFromSettings(
  settings?: Record<string, unknown> | null
): OverviewGenerationConfig {
  return {
    autoGenerate: settings?.autoGenerateOverview !== false,
    sections: {
      summary: settings?.overviewAiSummary !== false,
      chapters: settings?.overviewAiChapters !== false,
      quotes: settings?.overviewAiQuotes !== false
    }
  };
}

export function hasAnyOverviewAiSection(sections: OverviewAiSections): boolean {
  return sections.summary || sections.chapters || sections.quotes;
}

export function isFullOverviewAiSections(sections: OverviewAiSections): boolean {
  return sections.summary && sections.chapters && sections.quotes;
}

export function overviewSectionsCacheSuffix(sections: OverviewAiSections): string {
  if (isFullOverviewAiSections(sections)) {
    return "";
  }
  return `_s${sections.summary ? 1 : 0}c${sections.chapters ? 1 : 0}q${sections.quotes ? 1 : 0}`;
}

export function buildLocalOutlineChapters(
  chapterSource: ChapterSource,
  videoDuration: unknown,
  body?: ReadonlyArray<{ from?: unknown; to?: unknown }>
): AnalysisChapter[] {
  const given: OutlineChapter[] = Array.isArray(chapterSource?.chapters) ? chapterSource.chapters : [];
  if (given.length === 0) {
    return [];
  }
  const durationNum = Math.floor(Number(videoDuration) || 0);
  const lastBodyTo =
    Array.isArray(body) && body.length > 0
      ? Math.floor(Number(body[body.length - 1]?.to ?? body[body.length - 1]?.from) || 0)
      : 0;
  const endSeconds = Math.max(durationNum, lastBodyTo, 0);
  const validGiven = endSeconds > 0 ? given.filter((item) => item.seconds <= endSeconds) : given;
  const out: AnalysisChapter[] = [];
  for (let i = 0; i < validGiven.length; i += 1) {
    const item = validGiven[i];
    const from = Math.max(0, Math.floor(Number(item?.seconds) || 0));
    const nextFrom = i + 1 < validGiven.length ? Math.floor(Number(validGiven[i + 1]?.seconds) || 0) : null;
    const explicitTo = Math.floor(Number(item?.to));
    const to =
      Number.isFinite(explicitTo) && explicitTo > from
        ? explicitTo
        : nextFrom !== null && nextFrom > from
          ? nextFrom
          : Math.max(from, endSeconds);
    const title = String(item?.title ?? "").trim().slice(0, 300);
    if (!title) {
      continue;
    }
    out.push({ from, to, title, summary: "" });
  }
  return out;
}
