import { formatClock, shouldUseHoursForRange } from "../shared/clock-text.js";
import {
  buildSubtitleSectionLines,
  shouldShowHoursInNote,
  type NoteRenderMeta,
  type SubtitleBodyItemLike
} from "../notes/section-lines.js";
import type { ChapterItem } from "./types.js";

export function formatSegmentHeading(index: number): string {
  return `### 片段 ${index + 1}`;
}

export function formatSegmentItem(item: SubtitleBodyItemLike | null | undefined): string {
  const content = String(item && item.content != null ? item.content : "").trim();
  const from = Number(item?.from) || 0;
  const to = Number(item?.to) || from;
  const hours = shouldUseHoursForRange(from, to) ? "always" : "never";
  return `[${formatClock(from, { hours })}-${formatClock(to, { hours })}] ${content}`;
}

interface AiConversationMeta extends NoteRenderMeta {
  chapters?: ChapterItem[] | unknown[];
  videoDuration?: number | unknown;
}

interface AiConversationSettings {
  includeTimestampInBody?: boolean;
}

export function buildAiConversationMarkdown(
  meta: AiConversationMeta,
  body: readonly SubtitleBodyItemLike[],
  settings: AiConversationSettings
): string {
  const includeTimestampInBody = settings?.includeTimestampInBody !== false;
  const withHours = shouldShowHoursInNote(meta, body);
  const lines: string[] = [];
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  if (chapters.length) {
    lines.push("## 章节", "");
    chapters.forEach((item: unknown) => {
      const from = Number((item as { from?: unknown }).from) || 0;
      const title = String((item as { title?: unknown }).title || "");
      const stamp = includeTimestampInBody ? `\`${formatClock(from, { hours: withHours ? "always" : "never" })}\` ` : "";
      lines.push(`- ${stamp}${title}`);
    });
    lines.push("");
  }
  const subtitleLines = buildSubtitleSectionLines(body, chapters, { includeTimestampInBody }, withHours);
  if (subtitleLines.length > 0) {
    lines.push("## 字幕", "", ...subtitleLines);
  }
  return lines.join("\n");
}

interface BuildSubtitlePromptInput {
  body?: readonly SubtitleBodyItemLike[];
  chapters?: unknown[];
  videoDuration?: number | unknown;
  includeTimestampInBody?: boolean | unknown;
}

export function buildSubtitlePrompt({
  body,
  chapters,
  videoDuration,
  includeTimestampInBody
}: BuildSubtitlePromptInput = {}): string {
  const items = Array.isArray(body) ? body : [];
  if (items.length === 0) {
    return "";
  }
  return buildAiConversationMarkdown(
    { chapters, videoDuration },
    items,
    { includeTimestampInBody: includeTimestampInBody !== false }
  );
}
