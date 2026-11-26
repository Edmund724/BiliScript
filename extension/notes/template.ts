import { extractBvid, extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";
import { formatClock, parseClock } from "../shared/clock-text.js";
import {
  decodeVideoStorageBvid,
  detectSiteFromUrl,
  extractYoutubeVideoId,
  isEncodedYoutubeStorageBvid,
  normalizeSiteId,
  type SiteId
} from "../shared/site.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import { formatLocalDate } from "../shared/utils.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import { scanMarkdownBodyLines } from "./markdown-scan.js";
import {
  buildSubtitleSectionLines,
  shouldShowHoursInNote,
  type NoteRenderMeta,
  type NoteRenderSettings,
  type SecondaryLineResolver,
  type SubtitleBodyItemLike
} from "./section-lines.js";
import {
  getDefaultNoteTemplate,
  isDefaultNoteTemplate
} from "./template-defaults.js";
import type { NoteHighlightItem } from "./highlights-store.js";

export {
  DEFAULT_NOTE_TEMPLATE,
  DEFAULT_YOUTUBE_NOTE_TEMPLATE,
  LEGACY_DEFAULT_NOTE_TEMPLATE,
  getDefaultNoteTemplate,
  isDefaultNoteTemplate
} from "./template-defaults.js";

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
  videoId: string;
  site: SiteId;
  author: string;
  url: string;
  date: string;
  summary: string;
  ai_note: string;
  chapters: string;
  quotes: string;
  notes: string;
  subtitles: string;
}

export type NoteTemplateVariableKey = keyof NoteTemplateVariables;

export interface BuildNoteTemplateVariablesInput {
  meta: NoteRenderMeta & {
    site?: SiteId | unknown;
    title?: unknown;
    bvid?: unknown;
    videoId?: unknown;
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
  aiNote?: unknown;
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

  const rawIdInput = String(meta.videoId || meta.bvid || "").trim();
  const url = String(meta.url || "").trim();
  const hasExplicitSite = meta.site !== undefined && meta.site !== null && String(meta.site).trim() !== "";
  const site: SiteId = hasExplicitSite
    ? normalizeSiteId(meta.site)
    : isEncodedYoutubeStorageBvid(rawIdInput) || (Boolean(url) && detectSiteFromUrl(url) === "youtube")
      ? "youtube"
      : "bilibili";
  const decodedId = decodeVideoStorageBvid(rawIdInput);
  const externalId = decodedId || (site === "youtube" ? extractYoutubeVideoId(url) : "");
  const title = String(meta.title || "").trim() || externalId || "未命名视频";
  const bvid = externalId;
  const videoId = externalId;
  const author = String(meta.author || "").trim();
  const date = String(meta.uploadDate || "").trim() || formatLocalDate();

  const ai_note = String(input.aiNote ?? "").replace(/\r\n?/g, "\n").trim();
  const overviewSummary = String(input.overview?.summary || "").trim();
  const description = String(meta.description || "").trim();
  const summary = overviewSummary || (ai_note ? "" : description);

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
    videoId,
    site,
    author,
    url,
    date,
    summary,
    ai_note,
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
  const trimmed = String(template || "").replace(/\r\n?/g, "\n").trim();
  const site = normalizeSiteId((variables as Partial<NoteTemplateVariables>).site);
  const source = isDefaultNoteTemplate(trimmed) ? getDefaultNoteTemplate(site) : trimmed;
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

export interface NoteTimestampLinkContext {
  site: SiteId | unknown;
  pageUrl: string;
  bvid?: string;
  videoId?: string;
}

const YOUTUBE_RAW_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_BVID_RE = /^BV[0-9A-Za-z]+$/;
const CLOCK_TOKEN_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const LINE_PREFIX_CLOCK_CODE_RE =
  /^(\s*(?:(?:[-*+]|\d+\.)\s+|>\s+)*)`(\d{1,2}:\d{2}(?::\d{2})?)`(?=\s|$)/;

export function buildNoteTimestampDeepLink(
  seconds: number,
  context: NoteTimestampLinkContext
): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const sec = Math.max(0, Math.floor(seconds));
  const pageUrl = String(context.pageUrl || "").trim();
  const hasExplicitSite =
    context.site !== undefined && context.site !== null && String(context.site).trim() !== "";
  const site: SiteId = hasExplicitSite ? normalizeSiteId(context.site) : detectSiteFromUrl(pageUrl);

  if (site === "youtube") {
    const candidate = decodeVideoStorageBvid(String(context.videoId || context.bvid || "").trim());
    const rawId = YOUTUBE_RAW_ID_RE.test(candidate) ? candidate : extractYoutubeVideoId(pageUrl);
    if (!rawId) {
      return "";
    }
    return `https://www.youtube.com/watch?v=${rawId}&t=${sec}s`;
  }

  const candidate = decodeVideoStorageBvid(String(context.bvid || context.videoId || "").trim());
  const bvid = BILIBILI_BVID_RE.test(candidate) ? candidate : extractBvid(pageUrl);
  if (!bvid) {
    return "";
  }
  const pageIndex = extractPageIndexFromUrl(pageUrl);
  if (pageIndex > 1) {
    return `https://www.bilibili.com/video/${bvid}/?p=${pageIndex}&t=${sec}`;
  }
  return `https://www.bilibili.com/video/${bvid}/?t=${sec}`;
}

function findMatchingDelimiter(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string
): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
      continue;
    }
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findClosingBackticks(text: string, startIndex: number, tickCount: number): number {
  let i = startIndex;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd < text.length && text[runEnd] === "`") {
      runEnd += 1;
    }
    if (runEnd - i === tickCount) {
      return runEnd;
    }
    i = runEnd;
  }
  return -1;
}

function linkifyInlineMarkdownLine(line: string, context: NoteTimestampLinkContext): string {
  let prefixOut = "";
  let cursorStart = 0;

  const prefixMatch = line.match(LINE_PREFIX_CLOCK_CODE_RE);
  if (prefixMatch) {
    const clock = prefixMatch[2];
    const seconds = parseClock(clock);
    if (seconds !== null) {
      const deepLink = buildNoteTimestampDeepLink(seconds, context);
      if (deepLink) {
        prefixOut = `${prefixMatch[1]}[${clock}](${deepLink})`;
        cursorStart = prefixMatch[0].length;
      }
    }
  }

  let out = prefixOut;
  let i = cursorStart;
  const len = line.length;

  while (i < len) {
    const ch = line[i];

    if (ch === "`") {
      let tickEnd = i;
      while (tickEnd < len && line[tickEnd] === "`") {
        tickEnd += 1;
      }
      const tickCount = tickEnd - i;
      const closeEnd = findClosingBackticks(line, tickEnd, tickCount);
      if (closeEnd !== -1) {
        out += line.slice(i, closeEnd);
        i = closeEnd;
        continue;
      }
      out += line.slice(i, tickEnd);
      i = tickEnd;
      continue;
    }

    if (ch === "!" && line[i + 1] === "[") {
      const closeBracket = findMatchingDelimiter(line, i + 1, "[", "]");
      if (closeBracket !== -1 && line[closeBracket + 1] === "(") {
        const closeParen = findMatchingDelimiter(line, closeBracket + 1, "(", ")");
        if (closeParen !== -1) {
          out += line.slice(i, closeParen + 1);
          i = closeParen + 1;
          continue;
        }
      }
      out += "![";
      i += 2;
      continue;
    }

    if (ch === "[") {
      const closeBracket = findMatchingDelimiter(line, i, "[", "]");
      if (closeBracket !== -1) {
        const nextChar = line[closeBracket + 1];
        if (nextChar === "(") {
          const closeParen = findMatchingDelimiter(line, closeBracket + 1, "(", ")");
          if (closeParen !== -1) {
            out += line.slice(i, closeParen + 1);
            i = closeParen + 1;
            continue;
          }
        }
        if (nextChar === "[") {
          const closeRef = findMatchingDelimiter(line, closeBracket + 1, "[", "]");
          if (closeRef !== -1) {
            out += line.slice(i, closeRef + 1);
            i = closeRef + 1;
            continue;
          }
        }
        const inner = line.slice(i + 1, closeBracket);
        if (CLOCK_TOKEN_RE.test(inner)) {
          const seconds = parseClock(inner);
          if (seconds !== null) {
            const deepLink = buildNoteTimestampDeepLink(seconds, context);
            if (deepLink) {
              out += `[${inner}](${deepLink})`;
              i = closeBracket + 1;
              continue;
            }
          }
        }
      }
      out += "[";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function linkifyNoteTimestamps(
  markdown: string,
  context: NoteTimestampLinkContext
): string {
  const source = String(markdown ?? "");
  if (!source || !buildNoteTimestampDeepLink(0, context)) {
    return source;
  }

  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
  scanMarkdownBodyLines(lines, (line, _index, inBody) => {
    output.push(inBody ? linkifyInlineMarkdownLine(line, context) : line);
  });

  return output.join(lineBreak);
}
