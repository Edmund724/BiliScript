import { formatClock, shouldUseHoursForRange } from "../shared/clock-text.js";
import { buildSubtitleSectionLines, shouldShowHoursInNote } from "../notes/section-lines.js";
import type { ChapterItem, SubtitleBodyItem } from "./types.js";

export function formatSegmentHeading(index: number): string {
  return `### 片段 ${index + 1}`;
}

export function formatSegmentItem(item: unknown): string {
  const content = String(item && (item as { content?: unknown }).content != null ? (item as { content?: unknown }).content : "").trim();
  const from = Number(item && (item as { from?: unknown }).from) || 0;
  const to = Number(item && (item as { to?: unknown }).to) || from;
  const withHours = shouldUseHoursForRange(from, to);
  return `[${formatClock(from, { hours: withHours })}-${formatClock(to, { hours: withHours })}] ${content}`;
}

interface AiConversationMeta {
  chapters?: ChapterItem[] | unknown[];
  videoDuration?: number | unknown;
}

interface AiConversationSettings {
  includeTimestampInBody?: boolean;
}

export function buildAiConversationMarkdown(
  meta: AiConversationMeta,
  body: unknown[],
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
      const stamp = includeTimestampInBody ? `\`${formatClock(from, { hours: withHours })}\` ` : "";
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
  body?: unknown[];
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
