import { type Settings } from "../core/defaults.js";
import { formatTimestamp } from "../shared/string-utils.js";
import { formatClock, shouldUseHours } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import {
  buildSubtitleSectionLines,
  shouldShowHoursInNote,
  type NoteRenderMeta,
  type NoteRenderSettings,
  type SecondaryLineResolver,
  type SubtitleBodyItemLike
} from "./section-lines.js";

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

export function buildMarkdown(
  meta: NoteRenderMeta,
  body: readonly SubtitleBodyItemLike[] | null | undefined,
  settings: Settings,
  secondaryFor?: SecondaryLineResolver
): string {
  const compactWithHours = shouldShowHoursInNote(meta, body);
  const chapterLines = buildChapterLines(meta.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    meta.chapters || [],
    settings,
    compactWithHours,
    secondaryFor
  );

  const intro = String(meta.description || "").trim();

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
  body: readonly SubtitleBodyItemLike[] | null | undefined,
  secondaryFor?: SecondaryLineResolver,
  settings?: NoteRenderSettings
): string {
  const translationFirst = settings?.bilingualDisplayOrder === "translation-first";
  return (body || [])
    .map((item, index) => {
      const from = formatTimestamp(item.from, true);
      const to = formatTimestamp(item.to, true);
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
  body: readonly SubtitleBodyItemLike[] | null | undefined,
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
    const from = formatTimestamp(item?.from, false);
    const to = formatTimestamp(item?.to, false);
    cues.push(`${from} --> ${to}\n${cueBody}`);
  }

  if (cues.length === 0) {
    return "";
  }
  return `WEBVTT\n\n${cues.join("\n\n")}`;
}

export function buildTxt(body: readonly SubtitleBodyItemLike[] | null | undefined, settings?: NoteRenderSettings, secondaryFor?: SecondaryLineResolver): string {
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
        ? `${formatClock(item.from, { hours: withHours })} ${topText}`
        : topText;
      return secondary ? `${firstLine}\n  ${bottomText}` : firstLine;
    })
    .filter(Boolean)
    .join("\n");
}

function shouldShowHoursInSubtitle(body: readonly SubtitleBodyItemLike[] | null | undefined): boolean {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return shouldUseHours(maxTo);
}
