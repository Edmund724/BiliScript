import { formatClock, shouldUseHours } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import type { State } from "../core/state.js";

interface NoteRenderMeta {
  title?: unknown;
  aid?: unknown;
  bvid?: unknown;
  cid?: unknown;
  author?: unknown;
  uploadDate?: unknown;
  selectedSubtitleLang?: unknown;
  description?: unknown;
  videoDuration?: unknown;
  chapters?: unknown[];
  hotComments?: unknown[];
}

interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

interface NoteRenderSettings {
  includeTimestampInBody?: boolean;
  bilingualDisplayOrder?: "original-first" | "translation-first";
}

export type SecondaryLineResolver = (item: SubtitleBodyItemLike) => string | null;

export function buildSubtitleSectionLines(body: unknown[] | null | undefined, chapters: unknown[] | null | undefined, settings: NoteRenderSettings, withHours: boolean, secondaryFor?: SecondaryLineResolver): string[] {
  const items = (body || []) as SubtitleBodyItemLike[];
  const subtitleItems = items
    .map((item, index) => ({
      ...item,
      _index: index,
      text: String(item?.content || "").trim()
    }))
    .filter((item) => item.text);
  if (subtitleItems.length === 0) {
    return ["（暂无字幕）"];
  }

  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours, secondaryFor));
  }

  const lines: string[] = [];
  const usedIndexes = new Set<number>();
  let subtitleCursor = 0;

  chapterItems.forEach((chapter, idx) => {
    const start = Number(chapter.from || 0) || 0;
    const next = chapterItems[idx + 1];
    const chapterTo = Number(chapter.to || 0) || 0;
    let end = Infinity;
    if (next && Number(next.from) > start) {
      end = Number(next.from);
    } else if (chapterTo > start) {
      end = chapterTo;
    }

    while (subtitleCursor < subtitleItems.length) {
      const from = Number(subtitleItems[subtitleCursor].from || 0) || 0;
      if (from + 0.001 >= start) {
        break;
      }
      subtitleCursor++;
    }

    const sectionItems: Array<SubtitleBodyItemLike & { _index: number; text: string }> = [];
    while (subtitleCursor < subtitleItems.length) {
      const from = Number(subtitleItems[subtitleCursor].from || 0) || 0;
      const inEnd = end === Infinity ? true : from < end;
      if (!inEnd) {
        break;
      }
      sectionItems.push(subtitleItems[subtitleCursor]);
      usedIndexes.add(subtitleItems[subtitleCursor]._index);
      subtitleCursor++;
    }

    if (sectionItems.length === 0) {
      return;
    }

    const chapterStamp = settings.includeTimestampInBody
      ? ` \`${formatClock(start, { hours: withHours })}\``
      : "";
    lines.push(`### ${chapter.title}${chapterStamp}`, "");
    sectionItems.forEach((item) => {
      lines.push(formatSubtitleLine(item, settings, withHours, secondaryFor));
    });
    lines.push("");
  });

  const remaining = subtitleItems.filter((item) => !usedIndexes.has(item._index));
  if (remaining.length > 0) {
    lines.push("### 其他片段", "");
    remaining.forEach((item) => {
      lines.push(formatSubtitleLine(item, settings, withHours, secondaryFor));
    });
    lines.push("");
  }

  if (lines.length === 0) {
    return subtitleItems.map((item) => formatSubtitleLine(item, settings, withHours, secondaryFor));
  }

  while (lines.length > 0 && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines;
}

function formatSubtitleLine(item: SubtitleBodyItemLike, settings: NoteRenderSettings, withHours: boolean, secondaryFor?: SecondaryLineResolver): string {
  const text = String(item?.content || "").trim();
  if (!text) {
    return "";
  }
  const secondary = secondaryFor ? String(secondaryFor(item) || "").trim() : "";
  const translationFirst = Boolean(secondary && settings.bilingualDisplayOrder === "translation-first");
  const topText = translationFirst ? secondary : text;
  const bottomText = translationFirst ? text : secondary;
  const firstLine = settings.includeTimestampInBody
    ? `\`${formatClock(item.from as number, { hours: withHours })}\` ${topText}`
    : topText;
  return secondary ? `${firstLine}\n  ${bottomText}` : firstLine;
}

export function shouldShowHoursInNote(meta: NoteRenderMeta | State | null | undefined, body: unknown[] | null | undefined): boolean {
  const m = (meta || {}) as NoteRenderMeta;
  const items = (body || []) as SubtitleBodyItemLike[];
  const subtitleMaxTo = items.reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  const chapterMaxTo = normalizeChapters(m?.chapters || []).reduce((max, item) => {
    const from = Number(item?.from || 0) || 0;
    const to = Number(item?.to || 0) || 0;
    return Math.max(max, from, to);
  }, 0);
  const duration = Number(m?.videoDuration || 0) || 0;
  return shouldUseHours(Math.max(subtitleMaxTo, chapterMaxTo, duration));
}
