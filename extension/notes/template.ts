import { formatClock } from "../shared/clock-text.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import { formatLocalDate } from "../shared/utils.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import {
  buildSubtitleSectionLines,
  shouldShowHoursInNote,
  type NoteRenderMeta,
  type NoteRenderSettings,
  type SecondaryLineResolver,
  type SubtitleBodyItemLike
} from "./section-lines.js";
import { DEFAULT_NOTE_TEMPLATE } from "./template-defaults.js";
import type { NoteHighlightItem } from "./highlights-store.js";

export { DEFAULT_NOTE_TEMPLATE } from "./template-defaults.js";

export interface NoteTemplateChapterLike {
  title?: unknown;
  from?: unknown;
  to?: unknown;
  summary?: unknown;
}

export interface NoteTemplateQuoteLike {
  content?: unknown;
  from?: unknown;
}

export interface NoteTemplateVariables {
  title: string;
  bvid: string;
  author: string;
  url: string;
  date: string;
  summary: string;
  chapters: string;
  quotes: string;
  notes: string;
  subtitles: string;
}

export type NoteTemplateVariableKey = keyof NoteTemplateVariables;

export interface BuildNoteTemplateVariablesInput {
  meta: NoteRenderMeta & {
    title?: unknown;
    bvid?: unknown;
    author?: unknown;
    url?: unknown;
    uploadDate?: unknown;
  };
  body?: readonly SubtitleBodyItemLike[] | null;
  settings?: NoteRenderSettings;
  secondaryFor?: SecondaryLineResolver;
  overview?: {
    summary?: unknown;
    chapters?: unknown;
    quotes?: unknown;
  } | null;
  highlights?: readonly NoteHighlightItem[];
}

function formatChaptersMarkdown(
  overviewChapters: NoteTemplateChapterLike[] | undefined,
  nativeChapters: unknown[] | undefined,
  withHours: boolean
): string {
  const hours = withHours ? "always" : "never";
  const aiItems = Array.isArray(overviewChapters)
    ? overviewChapters.filter((item) => item && String(item.title || "").trim())
    : [];
  if (aiItems.length > 0) {
    return aiItems
      .map((item) => {
        const from = Number(item.from) || 0;
        const stamp = formatClock(from, { hours });
        const title = String(item.title || "").trim();
        const summary = String(item.summary || "").trim();
        return summary ? `- \`${stamp}\` **${title}**：${summary}` : `- \`${stamp}\` **${title}**`;
      })
      .join("\n");
  }

  const nativeItems = normalizeChapters(nativeChapters);
  if (nativeItems.length === 0) {
    return "";
  }
  return nativeItems
    .map((item) => `- \`${formatClock(item.from, { hours })}\` ${item.title}`)
    .join("\n");
}

function formatQuotesMarkdown(
  quotes: NoteTemplateQuoteLike[] | undefined,
  withHours: boolean
): string {
  const list = Array.isArray(quotes)
    ? quotes.filter((item) => item && String(item.content || "").trim())
    : [];
  if (list.length === 0) {
    return "";
  }
  const hours = withHours ? "always" : "never";
  return list
    .map((item) => {
      const from = Number(item.from) || 0;
      const content = String(item.content || "").trim();
      return `> \`${formatClock(from, { hours })}\` ${content}`;
    })
    .join("\n\n");
}

function formatHighlightsMarkdown(
  highlights: readonly NoteHighlightItem[] | undefined,
  withHours: boolean
): string {
  if (!Array.isArray(highlights) || highlights.length === 0) {
    return "";
  }
  const hours = withHours ? "always" : "never";
  return highlights
    .map((item) => {
      const text = String(item?.text || "").trim();
      if (!text) {
        return "";
      }
      if (item.from !== null && Number.isFinite(item.from)) {
        return `- \`${formatClock(item.from, { hours })}\` ${text}`;
      }
      return `- ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildNoteTemplateVariables(
  input: BuildNoteTemplateVariablesInput
): NoteTemplateVariables {
  const meta = input.meta || {};
  const body = Array.isArray(input.body) ? input.body : [];
  const withHours = shouldShowHoursInNote(meta, body);

  const title = String(meta.title || "").trim() || String(meta.bvid || "").trim() || "未命名视频";
  const bvid = String(meta.bvid || "").trim();
  const author = String(meta.author || "").trim();
  const url = String(meta.url || "").trim();
  const date = String(meta.uploadDate || "").trim() || formatLocalDate();

  const overviewSummary = String(input.overview?.summary || "").trim();
  const description = String(meta.description || "").trim();
  const summary = overviewSummary || description;

  const chapters = formatChaptersMarkdown(
    Array.isArray(input.overview?.chapters) ? (input.overview.chapters as NoteTemplateChapterLike[]) : undefined,
    meta.chapters,
    withHours
  );
  const quotes = formatQuotesMarkdown(
    Array.isArray(input.overview?.quotes) ? (input.overview.quotes as NoteTemplateQuoteLike[]) : undefined,
    withHours
  );
  const notes = formatHighlightsMarkdown(input.highlights, withHours);

  const subtitleLines =
    body.length > 0
      ? buildSubtitleSectionLines(
          body,
          meta.chapters || [],
          input.settings || { includeTimestampInBody: true },
          withHours,
          input.secondaryFor
        )
      : [];
  const subtitles = subtitleLines.join("\n");

  return {
    title,
    bvid,
    author,
    url,
    date,
    summary,
    chapters,
    quotes,
    notes,
    subtitles
  };
}

export function renderNoteTemplate(
  template: string | null | undefined,
  variables: NoteTemplateVariables | Partial<Record<string, string>>
): string {
  const source = String(template || "").trim() || DEFAULT_NOTE_TEMPLATE;
  const table = variables as Record<string, string | undefined>;
  const lookup = (key: string): string => {
    const val = table[key];
    return typeof val === "string" ? val : "";
  };

  const afterIf = source.replace(
    /\{\{#if\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, inner: string) => {
      return lookup(key).trim() ? inner.replace(/^\r?\n/, "").replace(/\r?\n$/, "") : "";
    }
  );

  const replaced = afterIf.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    lookup(key)
  );

  return replaced
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface BuildObsidianUriInput {
  vault?: string;
  folder?: string;
  fileName: string;
  content: string;
  maxUriLength?: number;
}

export interface ObsidianUriResult {
  uri: string;
  usedClipboardFallback: boolean;
}

export const DEFAULT_OBSIDIAN_MAX_URI_LENGTH = 6000;

function normalizeObsidianFolder(folder?: string): string {
  return String(folder || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function buildObsidianUri(input: BuildObsidianUriInput): ObsidianUriResult {
  const vault = String(input.vault || "").trim();
  const folder = normalizeObsidianFolder(input.folder);
  const safeBaseName = sanitizeFileName(input.fileName || "BiliScript-Note").replace(/\.md$/i, "") || "BiliScript-Note";
  const maxUriLength = input.maxUriLength ?? DEFAULT_OBSIDIAN_MAX_URI_LENGTH;

  const baseParams: string[] = [];
  if (vault) {
    baseParams.push(`vault=${encodeURIComponent(vault)}`);
  }
  if (folder) {
    baseParams.push(`file=${encodeURIComponent(`${folder}/${safeBaseName}`)}`);
  } else {
    baseParams.push(`name=${encodeURIComponent(safeBaseName)}`);
  }

  const contentParam = `content=${encodeURIComponent(String(input.content || ""))}`;
  const directUri = `obsidian://new?${[...baseParams, contentParam].join("&")}`;
  if (directUri.length <= maxUriLength) {
    return { uri: directUri, usedClipboardFallback: false };
  }

  const clipboardUri = `obsidian://new?${[...baseParams, "clipboard=true"].join("&")}`;
  return { uri: clipboardUri, usedClipboardFallback: true };
}
