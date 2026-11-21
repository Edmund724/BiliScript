export interface AnalysisChapter {
  from: number;
  to: number;
  title: string;
  summary: string;
  missingSummary?: boolean;
}

export interface AnalysisQuote {
  from: number;
  content: string;
}

interface AnalysisFailureRange {
  from: number;
  to: number;
}

export interface OverviewAnalysis {
  summary: string;
  chapters: AnalysisChapter[];
  quotes: AnalysisQuote[];
  failedRanges?: AnalysisFailureRange[];
  summaryFailed?: boolean;
}

export const MAX_ANALYSIS_CHAPTERS = 100;
const MAX_ANALYSIS_QUOTES = 50;
const MAX_OVERVIEW_SUMMARY_CHARS = 2000;
const MAX_CHAPTER_SUMMARY_CHARS = 600;

export function validateAnalysis(analysis: unknown, maxSeconds: unknown, minSeconds: unknown = 0): OverviewAnalysis {
  const max = Number(maxSeconds);
  const safeMax = Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
  const min = Number(minSeconds);
  const safeMin = Number.isFinite(min) && min > 0 ? min : 0;

  const safeString = (value: unknown, maxLength: number): string =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";

  const safeSeconds = (value: unknown): number | null => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < safeMin || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const source = analysis && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {};

  const chapters = (Array.isArray(source.chapters) ? source.chapters : [])
    .slice(0, MAX_ANALYSIS_CHAPTERS)
    .map((raw) => {
      const item = raw as { title?: unknown; summary?: unknown; timestampSeconds?: unknown };
      const from = safeSeconds(item?.timestampSeconds);
      const title = safeString(item?.title, 300);
      if (from === null || !title) return null;
      return { from, title, summary: safeString(item?.summary, MAX_CHAPTER_SUMMARY_CHARS) };
    })
    .filter((item): item is { from: number; title: string; summary: string } => item !== null)
    .sort((a, b) => a.from - b.from)
    .map((item, index, list) => ({
      from: item.from,
      to: index < list.length - 1 ? list[index + 1].from : safeMax,
      title: item.title,
      summary: item.summary
    }));

  const quotes = (Array.isArray(source.keyQuotes) ? source.keyQuotes : [])
    .slice(0, MAX_ANALYSIS_QUOTES)
    .map((raw) => {
      const item = raw as { quote?: unknown; timestampSeconds?: unknown };
      const from = safeSeconds(item?.timestampSeconds);
      const content = safeString(item?.quote, 3000);
      if (from === null || !content) return null;
      return { from, content };
    })
    .filter((item): item is AnalysisQuote => item !== null)
    .sort((a, b) => a.from - b.from);

  return {
    summary: safeString(source.summary, MAX_OVERVIEW_SUMMARY_CHARS),
    chapters,
    quotes
  };
}

export function mergeAnalyses(parts: unknown): OverviewAnalysis {
  const chapters: AnalysisChapter[] = [];
  const quotes: AnalysisQuote[] = [];
  const seenChapterFrom = new Set<number>();
  const seenQuoteText = new Set<string>();

  for (const rawPart of Array.isArray(parts) ? parts : []) {
    const part = (rawPart && typeof rawPart === "object" ? rawPart : {}) as Partial<OverviewAnalysis>;
    for (const rawChapter of Array.isArray(part.chapters) ? part.chapters : []) {
      const from = Number(rawChapter?.from);
      if (!Number.isFinite(from) || seenChapterFrom.has(from)) continue;
      seenChapterFrom.add(from);
      chapters.push({
        from: Math.floor(from),
        to: Number(rawChapter?.to) || Math.floor(from),
        title: String(rawChapter?.title ?? "").trim(),
        summary: String(rawChapter?.summary ?? "")
      });
    }
    for (const rawQuote of Array.isArray(part.quotes) ? part.quotes : []) {
      const from = Number(rawQuote?.from);
      const content = String(rawQuote?.content ?? "").trim();
      if (!Number.isFinite(from) || !content || seenQuoteText.has(content)) continue;
      seenQuoteText.add(content);
      quotes.push({ from: Math.floor(from), content });
    }
  }

  chapters.sort((a, b) => a.from - b.from);
  quotes.sort((a, b) => a.from - b.from);

  return {
    summary: "",
    chapters: chapters.slice(0, MAX_ANALYSIS_CHAPTERS),
    quotes: quotes.slice(0, MAX_ANALYSIS_QUOTES)
  };
}

export function groupQuotesIntoChapters(
  chapters: AnalysisChapter[],
  quotes: AnalysisQuote[]
): { grouped: Array<{ chapter: AnalysisChapter; quotes: AnalysisQuote[] }>; orphans: AnalysisQuote[] } {
  const chapterList = (Array.isArray(chapters) ? chapters : []).filter((chapter) =>
    Number.isFinite(Number(chapter?.from))
  );
  const quoteList = (Array.isArray(quotes) ? quotes : []).filter((quote) => Number.isFinite(Number(quote?.from)));

  const grouped = chapterList.map((chapter) => ({ chapter, quotes: [] as AnalysisQuote[] }));
  const orphans: AnalysisQuote[] = [];

  for (const quote of quoteList) {
    const seconds = Number(quote.from);
    let owner = -1;
    for (let i = 0; i < chapterList.length; i += 1) {
      if (Number(chapterList[i].from) <= seconds) owner = i;
      else break;
    }
    if (owner >= 0) grouped[owner].quotes.push(quote);
    else orphans.push(quote);
  }

  return { grouped, orphans };
}
