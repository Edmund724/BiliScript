import { extractBvid, extractPageIndexFromUrl, extractVideoId } from "../bilibili/video-id-shared.js";
import {
  YOUTUBE_UNIT_CID,
  decodeVideoStorageBvid,
  detectSiteFromUrl,
  extractYoutubeVideoId,
  normalizeSiteId,
  type SiteId
} from "../shared/site.js";
import type { AiContext } from "./types.js";
export type { AiContext };
import type { ChapterItem, HotComment, ImagePart } from "./types.js";
import type { ChatSessionMessage, OrdinaryConversation } from "../chat/conversation-types.js";
import {
  isLiveTextToolHistoryEntry,
  normalizeLiveTextToolHistoryEntry,
  type LiveTextToolHistoryEntry
} from "../live/live-text-tool-history.js";

export interface NormalizeConversationsOptions {
  maxCount?: number;
}

interface BuildContextKeyPayload {
  site?: unknown;
  bvid?: unknown;
  cid?: unknown;
  aid?: unknown;
  url?: unknown;
}

function resolveContextKeySite(payload: BuildContextKeyPayload): SiteId {
  const explicitSite = typeof payload.site === "string" ? payload.site.trim() : "";
  if (explicitSite) {
    return normalizeSiteId(explicitSite);
  }
  if (payload.url) {
    const fromUrl = detectSiteFromUrl(payload.url);
    if (fromUrl === "youtube") {
      return "youtube";
    }
  }
  if (String(payload.cid || "").trim() === YOUTUBE_UNIT_CID) {
    return "youtube";
  }
  return "bilibili";
}

export function buildContextKey(payload: BuildContextKeyPayload | null | undefined): string {
  if (!payload) {
    return "";
  }
  const site = resolveContextKeySite(payload);
  if (site === "youtube") {
    const rawBvid = decodeVideoStorageBvid(String(payload.bvid || "").trim());
    const videoId = rawBvid || extractYoutubeVideoId(payload.url);
    if (videoId) {
      return `video:youtube:${videoId}`;
    }
    const normalizedUrl = normalizeContextUrlForKey(payload.url);
    return normalizedUrl ? `url:${normalizedUrl}` : "";
  }
  const bvid = String(payload.bvid || "").trim();
  const cid = String(payload.cid || "").trim();
  const aid = String(payload.aid || "").trim();
  if (bvid || cid || aid) {
    return `video:${bvid}|${cid || aid}`;
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

function normalizeContextUrlForKey(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

export function normalizeImageParts(value: unknown): ImagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((item): item is ImagePart => {
    const part = item as { mime?: unknown; data?: unknown };
    return Boolean(part) && typeof part.mime === "string" && Boolean(part.mime) && typeof part.data === "string" && Boolean(part.data);
  });
  return parts.length ? parts : undefined;
}

export function retainLatestImage<T extends object>(messages: T[]): T[] {
  const fields = messages.map((message) => (message as { images?: unknown }).images);
  let keepIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (normalizeImageParts(fields[i])) {
      keepIndex = i;
      break;
    }
  }
  if (!fields.some((value) => value !== undefined)) {
    return messages;
  }
  return messages.map((message, index) => {
    const parts = normalizeImageParts(fields[index]);
    if (parts && index === keepIndex) {
      return { ...message, images: [parts[parts.length - 1]] };
    }
    if (fields[index] === undefined) {
      return message;
    }
    const next = { ...message } as T & { images?: unknown };
    delete next.images;
    return next as T;
  });
}

export function normalizeConversations(
  value: unknown,
  options: NormalizeConversationsOptions = {}
): Array<OrdinaryConversation | LiveTextToolHistoryEntry> {
  if (!Array.isArray(value)) {
    return [];
  }
  const sorted = value
    .map((item) => {
      if (isLiveTextToolHistoryEntry(item)) {
        return normalizeLiveTextToolHistoryEntry(item);
      }
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg: { role?: unknown; content?: unknown }) => msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") && typeof msg.content === "string")
            .map((msg: { id?: unknown; role?: unknown; content?: unknown; images?: unknown; contextKey?: unknown; tool_calls?: unknown; tool_call_id?: unknown; thinking?: unknown; stopped?: unknown }) => {
              const base: ChatSessionMessage = { role: String(msg.role), content: String(msg.content) };
              if (typeof msg.id === "string" && msg.id.trim()) {
                base.id = msg.id.trim();
              }
              const images = normalizeImageParts(msg.images);
              if (images) {
                base.images = images;
              }
              if (typeof msg.contextKey === "string" && msg.contextKey.trim()) {
                base.contextKey = msg.contextKey;
              }
              if (typeof msg.thinking === "string" && msg.thinking.trim()) {
                base.thinking = msg.thinking;
              }
              if (msg.stopped === true) {
                base.stopped = true;
              }
              const calls = msg.tool_calls;
              if (Array.isArray(calls) && calls.length) {
                return { ...base, tool_calls: calls };
              }
              const callId = msg.tool_call_id;
              if (typeof callId === "string" && callId) {
                return { ...base, tool_call_id: callId };
              }
              return base;
            })
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = buildAiContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      const normalized: OrdinaryConversation = {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isVideoContext: item?.isVideoContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        messages,
        ...(item?.transcriptMode === "full" || item?.transcriptMode === "hybrid"
          ? { transcriptMode: item.transcriptMode }
          : {}),
        ...(item?.summaryAnchor &&
        typeof item.summaryAnchor === "object" &&
        Number.isInteger(Number(item.summaryAnchor.coveredMessageCount)) &&
        Number(item.summaryAnchor.coveredMessageCount) > 0
          ? { summaryAnchor: { ...item.summaryAnchor } }
          : {})
      };
      return normalized;
    })
    .filter((item): item is OrdinaryConversation | LiveTextToolHistoryEntry => Boolean(item))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const maxCount = Math.floor(Number(options.maxCount ?? 0));
  if (Number.isFinite(maxCount) && maxCount > 0 && sorted.length > maxCount) {
    return sorted.slice(0, maxCount);
  }
  return sorted;
}

export function resolveConversationStorageKey(rawKey: unknown, contextRef: AiContext, contextUrl = ""): string {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

export function buildAiContextRef(context: unknown): AiContext {
  const value = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const url = String(value.url || "").trim();
  const rawSite = typeof value.site === "string" && value.site.trim() ? value.site : detectSiteFromUrl(url);
  const site = normalizeSiteId(rawSite);
  const rawBvidInput = String(value.bvid || "").trim();
  const decodedBvid = site === "youtube" ? decodeVideoStorageBvid(rawBvidInput) : rawBvidInput;
  const bvid = String(decodedBvid || extractVideoId(url) || "").trim();
  const rawCid = String(value.cid || "").trim();
  const cid = site === "youtube" ? (rawCid || YOUTUBE_UNIT_CID) : rawCid;
  return {
    site,
    title: String(value.title || "").trim(),
    url,
    author: String(value.author || "").trim(),
    uploadDate: String(value.uploadDate || "").trim(),
    bvid,
    cid,
    aid: site === "youtube" ? "" : String(value.aid || "").trim(),
    pageIndex: site === "youtube" ? 1 : (Number(value.pageIndex) > 0 ? Number(value.pageIndex) : 1),
    pageCount: Number(value.pageCount) > 0 ? Number(value.pageCount) : 0,
    pageTitle: site === "youtube" ? "" : String(value.pageTitle || "").trim(),
    subtitleLang: String(value.subtitleLang || "").trim(),
    selectedSubtitleId: String(value.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(value.selectedSubtitleUrl || "").trim(),
    chapters: Array.isArray(value.chapters) ? (value.chapters as ChapterItem[]) : undefined,
    isVideoContext: value.isVideoContext !== false
  };
}

export function buildContextPlaceholder(ref: unknown): AiContext | null {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    ...buildAiContextRef(ref),
    hotComments: []
  };
}

export function buildConversationTitle(context: AiContext | null | undefined): string {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  const baseTitle = extractConversationBaseTitle(rawTitle);
  return appendConversationPageSuffix(baseTitle, context || {});
}

export function normalizeConversationTitle(
  title: unknown,
  contextTitle = "",
  contextRef: AiContext | null = null,
  contextUrl = ""
): string {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return appendConversationPageSuffix(baseTitle || "历史对话", contextRef || { url: contextUrl });
}

function extractConversationBaseTitle(title: unknown): string {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const normalizedRaw = raw.replace(/-P\d+$/i, "").trim();
  const parts = normalizedRaw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || normalizedRaw;
}

export function buildConversationTitleDisplay(title: unknown, maxChars = 22): { main: string; suffix: string } {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return {
      main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
      suffix: ""
    };
  }

  const suffix = String(match[2] || "").trim();
  const baseTitle = String(match[1] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  const availableChars = Math.max(maxChars - reservedChars, 8);
  return {
    main: baseTitle.length > availableChars ? `${baseTitle.slice(0, availableChars)}...` : baseTitle,
    suffix
  };
}

function appendConversationPageSuffix(title: string, context: AiContext | { url?: string }): string {
  const baseTitle = String(title || "").trim() || "历史对话";
  const existingSuffixMatch = baseTitle.match(/-P\d+$/i);
  const cleanTitle = existingSuffixMatch ? baseTitle.replace(/-P\d+$/i, "").trim() : baseTitle;
  const pageSuffix = extractConversationPageSuffix(context);
  return pageSuffix ? `${cleanTitle}${pageSuffix}` : cleanTitle;
}

function extractConversationPageSuffix(
  context: AiContext | { site?: unknown; url?: string; pageIndex?: unknown; page?: unknown }
): string {
  const site = normalizeSiteId((context as { site?: unknown })?.site ?? detectSiteFromUrl(context?.url));
  if (site === "youtube") {
    return "";
  }
  const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromUrl(context?.url || "");
  return pageIndex > 1 ? `-P${pageIndex}` : "";
}

export function generateConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatConversationTimestamp(value: unknown): string {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function doesConversationMatchCurrentContext(
  conversation: { kind?: unknown; contextKey?: unknown; contextRef?: unknown; contextUrl?: unknown } | null | undefined,
  currentRef: AiContext | null | undefined,
  targetContextKey = ""
): boolean {
  if (!conversation || isLiveTextToolHistoryEntry(conversation)) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    buildAiContextRef(conversation.contextRef),
    String(conversation.contextUrl || "")
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || buildAiContextRef(conversation.contextRef).url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

export function doesTabMatchContextUrl(tabUrl: unknown, targetUrl: unknown): boolean {
  const current = extractVideoIdentity(tabUrl);
  const target = extractVideoIdentity(targetUrl);
  if (!current.bvid || !target.bvid) {
    return String(tabUrl || "").trim() === String(targetUrl || "").trim();
  }
  return current.site === target.site && current.bvid === target.bvid && current.page === target.page;
}

function extractVideoIdentity(url: unknown): { site: SiteId; bvid: string; page: number } {
  const text = String(url || "").trim();
  const site = detectSiteFromUrl(text);
  if (site === "youtube") {
    return {
      site: "youtube",
      bvid: extractYoutubeVideoId(text),
      page: 1
    };
  }
  const bvid = extractBvid(text);
  let page = 1;
  try {
    page = Number(new URL(text).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      page = 1;
    }
  } catch {
    page = 1;
  }
  return {
    site: "bilibili",
    bvid: String(bvid || "").trim(),
    page
  };
}
