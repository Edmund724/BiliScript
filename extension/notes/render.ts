import { type Settings } from "../core/defaults.js";
import { formatTimestamp } from "../shared/string-utils.js";
import { formatClock, shouldUseHours } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import { buildSubtitleSectionLines, shouldShowHoursInNote, type SecondaryLineResolver } from "./section-lines.js";
import { type State } from "../core/state.js";

interface NoteRenderMeta {
  description?: unknown;
  videoDuration?: unknown;
  chapters?: unknown[];
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

function buildChapterLines(chapters: unknown[] | null | undefined, withHours = false): string[] {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatClock(item.from, { hours: withHours });
    return `- \`${fromText}\` ${item.title}`;
  });
}

export function buildMarkdown(meta: NoteRenderMeta | State, body: unknown[] | null | undefined, settings: Settings, secondaryFor?: SecondaryLineResolver): string {
  const m = meta as NoteRenderMeta;
  const compactWithHours = shouldShowHoursInNote(m, body);
  const chapterLines = buildChapterLines(m.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    m.chapters || [],
    settings,
    compactWithHours,
    secondaryFor
  );

  const intro = String(m.description || "").trim();

  const lines: string[] = [];
  if (intro) {
    lines.push("## 简介", "", intro, "");
  }

  if (chapterLines.length > 0) {
    lines.push("## 章节", "", ...chapterLines, "");
  }

  lines.push("## 字幕", "", ...subtitleSectionLines);

  return lines.join("\n");
}

export function buildSrt(
  body: SubtitleBodyItemLike[] | null | undefined,
  secondaryFor?: SecondaryLineResolver,
  settings?: NoteRenderSettings
): string {
  const translationFirst = settings?.bilingualDisplayOrder === "translation-first";
  return (body || [])
    .map((item, index) => {
      const from = formatTimestamp(item.from as number, true);
      const to = formatTimestamp(item.to as number, true);
      const text = String(item.content || "").trim();
      const secondary = secondaryFor ? String(secondaryFor(item) || "").trim() : "";
      const cueBody = secondary
        ? translationFirst
          ? `${secondary}\n${text}`
          : `${text}\n${secondary}`
        : text;
      return `${index + 1}\n${from} --> ${to}\n${cueBody}`;
    })
    .join("\n\n");
}

export type VttExportMode = "bilingual" | "secondary-only";

export interface BuildVttOptions {
  mode?: VttExportMode;
}

export function buildVtt(
  body: SubtitleBodyItemLike[] | null | undefined,
  secondaryFor?: SecondaryLineResolver,
  settings?: NoteRenderSettings,
  options?: BuildVttOptions
): string {
  const translationFirst = settings?.bilingualDisplayOrder === "translation-first";
  const secondaryOnly = options?.mode === "secondary-only";
  const cues: string[] = [];

  for (const item of body || []) {
    const text = String(item?.content || "").trim();
    const secondary = secondaryFor ? String(secondaryFor(item) || "").trim() : "";

    let cueBody = "";
    if (secondaryOnly) {
      if (!secondary) {
        continue;
      }
      cueBody = secondary;
    } else if (text && secondary) {
      cueBody = translationFirst ? `${secondary}\n${text}` : `${text}\n${secondary}`;
    } else {
      cueBody = text || secondary;
    }

    if (!cueBody) {
      continue;
    }
    const from = formatTimestamp(item?.from as number, false);
    const to = formatTimestamp(item?.to as number, false);
    cues.push(`${from} --> ${to}\n${cueBody}`);
  }

  if (cues.length === 0) {
    return "";
  }
  return `WEBVTT\n\n${cues.join("\n\n")}`;
}

export function buildTxt(body: SubtitleBodyItemLike[] | null | undefined, settings?: NoteRenderSettings, secondaryFor?: SecondaryLineResolver): string {
  const withHours = shouldShowHoursInSubtitle(body);
  const translationFirst = settings?.bilingualDisplayOrder === "translation-first";
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      const secondary = secondaryFor ? String(secondaryFor(item) || "").trim() : "";
      const topText = secondary && translationFirst ? secondary : text;
      const bottomText = secondary && translationFirst ? text : secondary;
      const firstLine = settings?.includeTimestampInBody
        ? `${formatClock(item.from as number, { hours: withHours })} ${topText}`
        : topText;
      return secondary ? `${firstLine}\n  ${bottomText}` : firstLine;
    })
    .filter(Boolean)
    .join("\n");
}

function shouldShowHoursInSubtitle(body: SubtitleBodyItemLike[] | null | undefined): boolean {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return shouldUseHours(maxTo);
}
