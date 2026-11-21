import { state, clipState } from "../core/state.js";
import { formatLocalDate } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { fetchHotComments } from "../bilibili/gateway.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";
import { normalizeChapters } from "./chapters.js";
import { createSecondaryLineResolver } from "./alignment.js";
import {
  buildMarkdown,
  buildSrt,
  buildTxt
} from "../notes/render.js";
import type { State } from "../core/state.js";

export interface ReadingSubtitleItem {
  index: number;
  from: number;
  to: number;
  content: string;
}

interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

interface ChapterItemLike {
  from?: unknown;
  to?: unknown;
  title?: string;
}

export function readVideoTitle(): string {
  const h1 = document.querySelector("h1.video-title");
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }

  const metaTitle = document.querySelector('meta[property="og:title"]');
  if (metaTitle?.getAttribute("content")) {
    return metaTitle.getAttribute("content")!.trim();
  }

  return document.title.replace(/_哔哩哔哩_bilibili/i, "").trim();
}

export function readVideoAuthor(): string {
  const owner = document.querySelector(".up-name");
  if (owner?.textContent?.trim()) {
    return owner.textContent.trim();
  }

  const author = document.querySelector('meta[name="author"]');
  return author?.getAttribute("content")?.trim() || "";
}

export function readUploadDate(): string {
  const publishNode = document.querySelector('meta[itemprop="uploadDate"]');
  if (publishNode?.getAttribute("content")) {
    return publishNode.getAttribute("content")!.trim();
  }

  const dateText = document.querySelector(".pubdate-ip-text")?.textContent?.trim();
  if (dateText) {
    return dateText;
  }

  return formatLocalDate();
}

export function readVideoDescription(): string {
  const descNode = document.querySelector(
    ".desc-info-text, .video-desc .desc-info-text, .video-info-detail .text, .basic-desc-info"
  );
  return descNode?.textContent?.trim() || "";
}

const readingSubtitleItemsCache = new WeakMap<object, ReadingSubtitleItem[]>();

export function getReadingSubtitleItems(body: SubtitleBodyItemLike[] = state.clip.subtitleBody): ReadingSubtitleItem[] {
  if (Array.isArray(body)) {
    const cached = readingSubtitleItemsCache.get(body);
    if (cached) {
      return cached;
    }
    const items = buildReadingSubtitleItems(body);
    readingSubtitleItemsCache.set(body, items);
    return items;
  }
  return buildReadingSubtitleItems([]);
}

function buildReadingSubtitleItems(body: SubtitleBodyItemLike[]): ReadingSubtitleItem[] {
  return body
    .map((item, index) => ({
      index,
      from: Number(item?.from || 0) || 0,
      to: Number(item?.to || 0) || 0,
      content: String(item?.content || "").trim()
    }))
    .filter((item) => item.content);
}

export function getReadingSubtitlePlaceholderText(): string {
  if (state.clip.subtitleFetchState === "loading") {
    return "正在加载字幕...";
  }
  if (state.clip.subtitleFetchState === "error") {
    return "字幕加载失败，请刷新重试。";
  }
  if (state.clip.subtitleFetchState === "empty" && clipState.noSubtitleReason) {
    const notice = getAsrFailureNotice(clipState.noSubtitleReason);
    const text = [notice.cause, notice.remedyText].filter(Boolean).join(" ");
    if (text) {
      return text;
    }
  }
  return "当前视频无字幕。";
}

const ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT = 8;

function subtitleActiveRange(item: SubtitleBodyItemLike): { from: number; to: number } {
  const from = Number(item?.from || 0) || 0;
  const rawTo = Number(item?.to || 0) || 0;
  return { from, to: rawTo > from ? rawTo : from + 2 };
}

export function findActiveSubtitleIndexInItems(
  items: readonly SubtitleBodyItemLike[],
  currentTime: number
): number {
  if (!Array.isArray(items) || items.length === 0 || !Number.isFinite(currentTime)) {
    return -1;
  }
  let lo = 0;
  let hi = items.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((Number(items[mid]?.from || 0) || 0) <= currentTime) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) {
    return -1;
  }
  for (let i = candidate, scanned = 0; i >= 0 && scanned <= ACTIVE_SUBTITLE_BACKWARD_SCAN_LIMIT; i -= 1, scanned += 1) {
    const { from, to } = subtitleActiveRange(items[i]);
    if (currentTime >= from && currentTime < to) {
      return i;
    }
  }
  return -1;
}

export function findActiveSubtitleIndex(currentTime: number): number {
  const items = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  return findActiveSubtitleIndexInItems(items, currentTime);
}

export function findActiveChapterIndex(currentTime: number): number {
  const chapters = normalizeChapters(state.clip.chapters || []);
  for (let index = 0; index < chapters.length; index += 1) {
    const item = chapters[index];
    const from = Number(item?.from || 0) || 0;
    const next = chapters[index + 1];
    const explicitTo = Number(item?.to || 0) || 0;
    const fallbackTo = next && Number(next.from) > from ? Number(next.from) : explicitTo;
    const to = fallbackTo > from ? fallbackTo : Number.POSITIVE_INFINITY;
    if (currentTime >= from && currentTime < to) {
      return index;
    }
  }
  return -1;
}

export function invalidateDerived(): void {
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
}

export function rebuildDerivedContent(): void {
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  if (!body.length) {
    invalidateDerived();
    return;
  }
  const secondaryFor = createSecondaryLineResolver();
  clipState.setMarkdown(buildMarkdown(state as State, body, state.settings, secondaryFor));
  clipState.setSrt(buildSrt(body, secondaryFor, state.settings));
  clipState.setTxt(buildTxt(body, state.settings, secondaryFor));
}

interface DerivedContentCacheEntry {
  body: unknown;
  secondaryBody: unknown;
  settings: unknown;
  chapters: unknown;
  hotComments: unknown;
  href: string;
  created: string;
  bvid: string;
  aid: string;
  cid: string;
  title: string;
  author: string;
  uploadDate: string;
  description: string;
  selectedSubtitleLang: string;
  videoDuration: number;
}

const DERIVED_SCALAR_FIELDS = [
  "bvid",
  "aid",
  "cid",
  "title",
  "author",
  "uploadDate",
  "description",
  "selectedSubtitleLang",
  "videoDuration"
] as const;

let derivedContentCache: DerivedContentCacheEntry | null = null;

function currentHref(): string {
  return typeof location !== "undefined" ? location.href : "";
}

function captureDerivedContentInputs(): DerivedContentCacheEntry {
  const clip = state.clip;
  const entry = {} as Record<(typeof DERIVED_SCALAR_FIELDS)[number], string | number>;
  for (const key of DERIVED_SCALAR_FIELDS) {
    entry[key] = clip[key] as string | number;
  }
  return {
    body: clip.subtitleBody,
    secondaryBody: clip.secondarySubtitle.body,
    settings: state.settings,
    chapters: clip.chapters,
    hotComments: clip.hotComments,
    href: currentHref(),
    created: formatLocalDate(),
    ...(entry as Omit<DerivedContentCacheEntry, "body" | "secondaryBody" | "settings" | "chapters" | "hotComments" | "href" | "created">)
  };
}

function isDerivedContentCacheValid(): boolean {
  const cached = derivedContentCache;
  if (!cached) {
    return false;
  }
  const clip = state.clip;
  if (Array.isArray(clip.subtitleBody) && clip.subtitleBody.length > 0 && (!clip.markdown || !clip.srt || !clip.txt)) {
    return false;
  }
  if (
    cached.body !== clip.subtitleBody ||
    cached.secondaryBody !== clip.secondarySubtitle.body ||
    cached.settings !== state.settings ||
    cached.chapters !== clip.chapters ||
    cached.hotComments !== clip.hotComments ||
    cached.href !== currentHref() ||
    cached.created !== formatLocalDate()
  ) {
    return false;
  }
  return DERIVED_SCALAR_FIELDS.every((key) => cached[key] === clip[key]);
}

export function ensureDerivedContent(): void {
  if (isDerivedContentCacheValid()) {
    return;
  }
  rebuildDerivedContent();
  derivedContentCache = captureDerivedContentInputs();
}

export async function refreshHotComments({ refreshComments = false } = {}): Promise<void> {
  const shouldFetchComments =
    refreshComments || !Array.isArray(state.clip.hotComments) || state.clip.hotComments.length === 0;
  if (shouldFetchComments) {
    try {
      clipState.setHotComments(await fetchHotComments(20));
      clipState.setHotCommentsNotice("");
      notifyReaderPresenter({ kind: "rerender" });
    } catch (error) {
      clipState.setHotComments([]);
      logWarn("[BILISCRIPT] failed to fetch hot comments", error);
      clipState.setHotCommentsNotice(
        `热评没拿到（${getErrorMessage(error)}）：本次概览没有评论目录。`
      );
      notifyReaderPresenter({ kind: "rerender" });
    }
  }
}

export async function refreshDerivedContent({ refreshComments = false } = {}): Promise<void> {
  await refreshHotComments({ refreshComments });
  ensureDerivedContent();
}
