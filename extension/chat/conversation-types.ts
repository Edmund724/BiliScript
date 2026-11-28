import type { AiContext, ImagePart } from "../ai/types.js";
import type { LiveTextToolHistoryEntry, LiveTextToolVideo } from "../live/live-text-tool-history.js";
import { normalizeSiteId, type SiteId } from "../shared/site.js";
import type { ConversationSummaryAnchor } from "../subtitle/idb-store.js";
import type { ChatTranscriptMode } from "./protocol.js";

export type { ConversationSummaryAnchor } from "../subtitle/idb-store.js";

export interface ChatSessionMessage {
  id?: string;
  role: string;
  content: string;
  images?: ImagePart[];
  contextKey?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  thinking?: string;
  stopped?: boolean;
}

export interface OrdinaryConversation {
  id: string;
  kind?: "chat";
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: AiContext | null;
  messages: ChatSessionMessage[];
  transcriptMode?: ChatTranscriptMode;
  summaryAnchor?: ConversationSummaryAnchor;
}

export interface ConversationSummaryBase {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  site?: SiteId;
  bvid?: string;
  cid?: string;
  aid?: string;
  messageCount: number;
  recordCount: number;
  hasImages: boolean;
  transcriptMode?: ChatTranscriptMode;
}

export interface ChatConversationSummaryItem extends ConversationSummaryBase {
  kind: "chat";
  contextRef: AiContext | null;
}

export interface LiveTextToolSummaryItem extends ConversationSummaryBase {
  kind: "live-text-tool";
  contextRef: LiveTextToolVideo;
}

export type ConversationSummaryItem = ChatConversationSummaryItem | LiveTextToolSummaryItem;

export type FullSavedConversation = OrdinaryConversation | LiveTextToolHistoryEntry;

export type ChatSessionSavedConversation = ConversationSummaryItem;

export type ConversationSummaryInput = ConversationSummaryItem | FullSavedConversation;

export function isLiveTextToolSummary(value: unknown): value is LiveTextToolSummaryItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { kind?: unknown }).kind === "live-text-tool"
  );
}

export function toConversationSummaryItem(raw: unknown): ConversationSummaryItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) {
    return null;
  }
  const isLive = obj.kind === "live-text-tool";
  const ref = obj.contextRef && typeof obj.contextRef === "object"
    ? (obj.contextRef as Record<string, unknown>)
    : null;
  const pickStr = (a: unknown, b: unknown): string | undefined =>
    typeof a === "string" && a.trim() ? a.trim() : typeof b === "string" && b.trim() ? b.trim() : undefined;

  const siteRaw = obj.site ?? ref?.site;
  const site = siteRaw !== undefined && siteRaw !== null && String(siteRaw).trim() !== ""
    ? normalizeSiteId(siteRaw)
    : undefined;
  const bvid = pickStr(obj.bvid, ref?.bvid);
  const cid = pickStr(obj.cid, ref?.cid);
  const aid = pickStr(obj.aid, ref?.aid);

  const createdAt = Number.isFinite(Number(obj.createdAt)) ? Number(obj.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : createdAt;

  const rawMessages = Array.isArray(obj.messages) ? obj.messages : null;
  const rawRecords = Array.isArray(obj.records) ? obj.records : null;

  const messageCount = isLive
    ? 0
    : typeof obj.messageCount === "number" && Number.isFinite(obj.messageCount)
      ? Math.max(0, Math.floor(obj.messageCount))
      : rawMessages
        ? rawMessages.length
        : 0;
  const recordCount = !isLive
    ? 0
    : typeof obj.recordCount === "number" && Number.isFinite(obj.recordCount)
      ? Math.max(0, Math.floor(obj.recordCount))
      : rawRecords
        ? rawRecords.length
        : 0;
  const hasImages = isLive
    ? false
    : typeof obj.hasImages === "boolean"
      ? obj.hasImages
      : rawMessages
        ? rawMessages.some(
            (msg) =>
              Boolean(msg) &&
              typeof msg === "object" &&
              Array.isArray((msg as { images?: unknown }).images) &&
              (msg as { images: unknown[] }).images.length > 0
          )
        : false;
  const transcriptMode: ChatTranscriptMode | undefined =
    !isLive && (obj.transcriptMode === "full" || obj.transcriptMode === "hybrid")
      ? obj.transcriptMode
      : undefined;

  const base: ConversationSummaryBase = {
    id,
    title: typeof obj.title === "string" ? obj.title : "",
    contextKey: typeof obj.contextKey === "string" ? obj.contextKey : "",
    contextTitle: typeof obj.contextTitle === "string" ? obj.contextTitle : "",
    contextUrl: typeof obj.contextUrl === "string" ? obj.contextUrl : "",
    isVideoContext: obj.isVideoContext !== false,
    createdAt,
    updatedAt,
    ...(site ? { site } : {}),
    ...(bvid ? { bvid } : {}),
    ...(cid ? { cid } : {}),
    ...(aid ? { aid } : {}),
    messageCount,
    recordCount,
    hasImages,
    ...(transcriptMode ? { transcriptMode } : {})
  };

  if (isLive) {
    const liveRef: LiveTextToolVideo = {
      bvid: String(ref?.bvid || bvid || "").trim(),
      cid: String(ref?.cid || cid || "").trim(),
      pageIndex: Number(ref?.pageIndex) > 0 ? Math.floor(Number(ref?.pageIndex)) : 1,
      ...(typeof ref?.pageTitle === "string" && ref.pageTitle.trim() ? { pageTitle: ref.pageTitle.trim() } : {}),
      title: String(ref?.title || base.contextTitle || base.title || "").trim(),
      url: String(ref?.url || base.contextUrl || "").trim()
    };
    return {
      ...base,
      kind: "live-text-tool",
      isVideoContext: true,
      contextRef: liveRef
    };
  }

  return {
    ...base,
    kind: "chat",
    contextRef: ref ? ({ ...ref } as AiContext) : null
  };
}
