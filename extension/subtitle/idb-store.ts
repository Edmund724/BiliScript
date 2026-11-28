import type { SubtitleBodyItem, SubtitleWord } from "../shared/video-dto.js";
import { base64ToBytes, bytesToBase64 } from "../shared/bytes.js";
import {
  YOUTUBE_UNIT_CID,
  isEncodedYoutubeStorageBvid,
  normalizeSiteId,
  resolveVideoStorageKey,
  type SiteId,
  type VideoStorageKey
} from "../shared/site.js";
import { isAsrVariantSourceKey } from "./source-key.js";

export const SUBTITLE_IDB_NAME = "biliscript-subtitle-store";
export const SUBTITLE_IDB_VERSION = 4;

export const SUBTITLE_IDB_STORE = "subtitle_pages";
export const SUBTITLE_IDB_LAST_USED_INDEX = "by_lastUsed";
export const SUBTITLE_IDB_BVID_INDEX = "by_bvid";

export const SUBTITLE_TRACKS_IDB_STORE = "subtitle_tracks";
export const SUBTITLE_TRACKS_INDEX_PAGE_ID = "by_pageId";

export const AI_ARTIFACTS_IDB_STORE = "ai_artifacts";
export const AI_ARTIFACTS_INDEX_FAMILY_BVID = "by_family_bvid";
export const AI_ARTIFACTS_INDEX_BVID = "by_bvid";
export const AI_ARTIFACTS_INDEX_LAST_USED = "by_lastUsedAt";

export const CHAT_IMAGES_IDB_STORE = "chat_images";
export const CHAT_IMAGES_INDEX_CONVERSATION_ID = "by_conversationId";
export const CHAT_IMAGES_INDEX_BVID = "by_bvid";

export const CONVERSATION_META_IDB_STORE = "conversation_meta";
export const CONVERSATION_META_INDEX_UPDATED_AT = "by_updatedAt";
export const CONVERSATION_META_INDEX_CONTEXT_KEY = "by_contextKey";
export const CONVERSATION_MESSAGES_IDB_STORE = "conversation_messages";

export const NOTE_HIGHLIGHTS_IDB_STORE = "note_highlights";
export const NOTE_HIGHLIGHTS_INDEX_UPDATED_AT = "by_updatedAt";

export const STORE_META_IDB_STORE = "store_meta";
export const VIDEO_CACHE_LEDGER_META_KEY = "video_cache_ledger";
export const LEGACY_LOCAL_MIGRATION_DONE_META_KEY = "biliscript_idb_v2_migration_done";

const LEGACY_CONVERSATIONS_IDB_STORE = "conversations";
const LEGACY_AI_ARTIFACTS_INDEX_FAMILY_LAST_USED = "by_family_lastUsedAt";
const LEGACY_CHAT_IMAGES_INDEX_LAST_USED = "by_lastUsedAt";

export const DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES = 100;
export const DEFAULT_SUBTITLE_CACHE_MAX_BYTES = 150 * 1024 * 1024;

export const AI_ARTIFACT_FAMILIES = [
  "biliscript_lvs_l1_index_",
  "biliscript_lvs_analysis_final_",
  "biliscript_lvs_analysis_",
  "biliscript_lvs_summary_"
] as const;

export type AiArtifactFamily = (typeof AI_ARTIFACT_FAMILIES)[number];

export const AI_ARTIFACT_FAMILY_KEEP_VIDEOS: Record<AiArtifactFamily, number> = {
  biliscript_lvs_l1_index_: 100,
  biliscript_lvs_analysis_final_: 100,
  biliscript_lvs_analysis_: 20,
  biliscript_lvs_summary_: 20
};

const AI_ARTIFACT_FAMILIES_BY_LENGTH: readonly AiArtifactFamily[] = [...AI_ARTIFACT_FAMILIES].sort(
  (a, b) => b.length - a.length
);

export function isAiArtifactFamily(value: unknown): value is AiArtifactFamily {
  return typeof value === "string" && (AI_ARTIFACT_FAMILIES as readonly string[]).includes(value);
}

export function inferStorageSite(bvid: unknown, cid?: unknown, site?: unknown): SiteId {
  if (site !== undefined && site !== null && String(site).trim() !== "") return normalizeSiteId(site);
  const cleanCid = String(cid ?? "").trim();
  const cleanBvid = String(bvid ?? "").trim();
  if (cleanCid === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(cleanBvid)) return "youtube";
  return "bilibili";
}

export function resolveVideoStorageIdentity(bvid: unknown, cid?: unknown, site?: unknown): VideoStorageKey {
  const cleanBvid = String(bvid ?? "").trim();
  const cleanCid = String(cid ?? "").trim();
  return resolveVideoStorageKey(inferStorageSite(cleanBvid, cleanCid, site), cleanBvid, cleanCid);
}

export function parseAiArtifactKey(
  key: unknown
): { family: AiArtifactFamily; bvid: string; cid: string } | null {
  const raw = String(key ?? "");
  if (!raw) return null;
  const family = AI_ARTIFACT_FAMILIES_BY_LENGTH.find((prefix) => raw.startsWith(prefix));
  if (!family) return null;
  const rest = raw.slice(family.length);
  if (!rest) return null;
  const firstSep = rest.indexOf("_");
  if (firstSep === -1) {
    return { family, bvid: rest, cid: isEncodedYoutubeStorageBvid(rest) ? YOUTUBE_UNIT_CID : "" };
  }
  const bvid = rest.slice(0, firstSep);
  if (!bvid) return null;
  const secondSep = rest.indexOf("_", firstSep + 1);
  const cid = secondSep === -1 ? rest.slice(firstSep + 1) : rest.slice(firstSep + 1, secondSep);
  return { family, bvid, cid: cid || (isEncodedYoutubeStorageBvid(bvid) ? YOUTUBE_UNIT_CID : "") };
}

export type SubtitleTrackStorageKind = "manual-cc" | "bili-ai" | "youtube-auto" | "asr";
export type SubtitleTrackTier = "raw" | "segmented" | "translated";

export interface RawSubtitleTrackRecord {
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: SubtitleBodyItem[];
  updatedAt: number;
}

export interface SegmentedSubtitleTrackRecord {
  key: string;
  trackKey: string;
  segmentationSig: string;
  items: SubtitleBodyItem[];
  updatedAt: number;
}

export interface TranslatedSubtitleTrackRecord {
  key: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: SubtitleBodyItem[];
  updatedAt: number;
}

export interface SubtitleTrackRow {
  trackId: string;
  pageId: string;
  tier: SubtitleTrackTier;
  key: string;
  data: RawSubtitleTrackRecord | SegmentedSubtitleTrackRecord | TranslatedSubtitleTrackRecord;
  estimatedBytes: number;
  updatedAt: number;
}

export interface SubtitlePageHeaderRecord {
  id: string;
  bvid: string;
  cid: string;
  trackIndex: Record<string, number>;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
  lastUsed: number;
}

export interface SubtitlePageRecord {
  id: string;
  bvid: string;
  cid: string;
  rawTracks: Record<string, RawSubtitleTrackRecord>;
  segmentedTracks: Record<string, SegmentedSubtitleTrackRecord>;
  translatedTracks: Record<string, TranslatedSubtitleTrackRecord>;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
  lastUsed: number;
}

export interface AiArtifactRecord<TPayload = unknown> {
  key: string;
  family: AiArtifactFamily;
  bvid: string;
  cid: string;
  payload: TPayload;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface StoredChatImageRecord {
  id: string;
  conversationId: string;
  bvid: string;
  mime: string;
  blob: Blob;
  byteLength: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatImageRecord {
  id: string;
  conversationId: string;
  bvid: string;
  mime: string;
  data: string;
  blob?: Blob;
  byteLength: number;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface PutChatImageInput {
  id: string;
  conversationId: string;
  bvid?: string;
  cid?: string;
  site?: SiteId;
  mime: string;
  data?: string;
  dataUrl?: string;
  blob?: Blob;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
}

export interface ChatImageWriteResult {
  ok: boolean;
  evictedIds: string[];
  estimatedBytes?: number;
  error?: Error;
}

export interface PruneChatImagesInput {
  validConversationIds: readonly string[];
  keepImageIds?: readonly string[];
}

export interface PutRawTrackInput {
  bvid: string;
  cid: string;
  site?: SiteId;
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: readonly SubtitleBodyItem[];
}

export interface PutSegmentedTrackInput {
  bvid: string;
  cid: string;
  site?: SiteId;
  trackKey: string;
  segmentationSig: string;
  items: readonly SubtitleBodyItem[];
}

export interface UpsertTranslatedTrackInput {
  bvid: string;
  cid: string;
  site?: SiteId;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: readonly SubtitleBodyItem[];
  replaceRange?: { from: number; to: number };
}

export interface DeleteTrackEntryInput {
  bvid: string;
  cid: string;
  site?: SiteId;
  tier: "rawTracks" | "segmentedTracks" | "translatedTracks";
  key: string;
}

export interface PutAiArtifactInput<TPayload = unknown> {
  key: string;
  family?: AiArtifactFamily;
  bvid?: string;
  cid?: string;
  site?: SiteId;
  payload: TPayload;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
}

export interface SubtitleStoreWriteResult {
  ok: boolean;
  evictedIds: string[];
  evictedArtifactKeys?: string[];
  estimatedBytes?: number;
  error?: Error;
}

export interface AiArtifactWriteResult {
  ok: boolean;
  evictedKeys: string[];
  estimatedBytes?: number;
  error?: Error;
}

export interface ClearVideoResult {
  removedPageIds: string[];
  removedArtifactKeys: string[];
}

export interface SubtitleStoreWriteContext {
  op: "put-raw" | "put-segmented" | "upsert-translated" | "put-ai-artifact" | "put-chat-image";
  pageId: string;
  bvid: string;
  cid: string;
  trackKey: string;
  family?: AiArtifactFamily;
  key?: string;
  conversationId?: string;
}

export type SubtitleStoreWriteInterceptor = (ctx: SubtitleStoreWriteContext) => Promise<void> | void;

export interface VideoCacheUsage {
  totalBytes: number;
  subtitleBytes: number;
  artifactBytes: number;
  subtitlePageCount: number;
  artifactCount: number;
  maxBytes: number;
}

export interface VideoCacheLedgerRecord {
  key: typeof VIDEO_CACHE_LEDGER_META_KEY;
  totalBytes: number;
  subtitleBytes: number;
  artifactBytes: number;
  pageCount: number;
  artifactCount: number;
  updatedAt: number;
}

export interface VideoCacheLimitUpdateResult {
  evictedPageIds: string[];
  evictedArtifactKeys: string[];
  usage: VideoCacheUsage;
}

export interface ConversationMetaRecord {
  id: string;
  kind: "chat" | "live-text-tool";
  contextKey: string;
  site?: SiteId;
  bvid?: string;
  cid?: string;
  aid?: string;
  title: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  contextRef: unknown;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  recordCount: number;
  hasImages: boolean;
  transcriptMode?: "full" | "hybrid";
  [key: string]: unknown;
}

export type ConversationMessagesRecord =
  | { id: string; kind: "chat"; messages: unknown[]; summaryAnchor?: unknown; updatedAt: number }
  | { id: string; kind: "live-text-tool"; records: unknown[]; updatedAt: number };

export interface PersistedConversationRecord {
  id: string;
  updatedAt: number;
  createdAt?: number;
  [key: string]: unknown;
}

export interface PruneConversationsResult {
  removedIds: string[];
  keptCount: number;
}

export interface NoteHighlightRecordItem {
  id: string;
  text: string;
  from: number | null;
  source: "subtitle" | "overview";
  subtitleIndex?: number;
  createdAt: number;
}

export interface NoteHighlightBucketRecord {
  videoKey: string;
  site: SiteId;
  bvid: string;
  updatedAt: number;
  items: NoteHighlightRecordItem[];
}

export interface StoreMetaRecord<T = unknown> {
  key: string;
  value?: T;
  [k: string]: unknown;
}

export interface SubtitleIdbStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
  maxEntries?: number;
  maxBytes?: number;
  aiArtifactKeepVideos?: Partial<Record<AiArtifactFamily, number>>;
  now?: () => number;
  useSharedMemoryBacking?: boolean;
}

export interface SubtitleIdbStore {
  getPageRecord(bvid: string, cid: string, site?: SiteId): Promise<SubtitlePageRecord | null>;
  listPageRecords(): Promise<SubtitlePageRecord[]>;
  getRawTrack(bvid: string, cid: string, trackKey: string, site?: SiteId): Promise<SubtitleBodyItem[] | null>;
  putRawTrack(input: PutRawTrackInput): Promise<SubtitleStoreWriteResult>;
  getSegmentedTrack(bvid: string, cid: string, trackKey: string, segmentationSig: string, site?: SiteId): Promise<SubtitleBodyItem[] | null>;
  putSegmentedTrack(input: PutSegmentedTrackInput): Promise<SubtitleStoreWriteResult>;
  getTranslatedTrack(bvid: string, cid: string, sourceTrackKey: string, targetLang: string, translationSig?: string, site?: SiteId): Promise<SubtitleBodyItem[] | null>;
  upsertTranslatedTrack(input: UpsertTranslatedTrackInput): Promise<SubtitleStoreWriteResult>;
  deleteTrackEntry(input: DeleteTrackEntryInput): Promise<boolean>;
  pruneAsrVariants(args: { bvid: string; cid: string; keepTrackKey?: string; site?: SiteId }): Promise<string[]>;
  clearTranslatedTracksForPage(args: { bvid: string; cid: string; sourceTrackKey?: string; site?: SiteId }): Promise<string[]>;

  getAiArtifact<TPayload = unknown>(key: string): Promise<AiArtifactRecord<TPayload> | null>;
  readAiArtifactPayloadRaw<TPayload = unknown>(key: string): Promise<TPayload | null>;
  getAiArtifactsMany<TPayload = unknown>(keys: string[]): Promise<Array<AiArtifactRecord<TPayload> | null>>;
  putAiArtifact<TPayload = unknown>(input: PutAiArtifactInput<TPayload>): Promise<AiArtifactWriteResult>;
  deleteAiArtifact(key: string): Promise<boolean>;
  listAiArtifactsByFamilyBvid(family: AiArtifactFamily, bvid: string, keyPrefix?: string, site?: SiteId): Promise<AiArtifactRecord[]>;
  listAiArtifactsByBvid(bvid: string, site?: SiteId): Promise<AiArtifactRecord[]>;
  listAllAiArtifacts(): Promise<AiArtifactRecord[]>;
  clearVideo(bvid: string, cid?: string, site?: SiteId): Promise<ClearVideoResult>;

  getChatImage(id: string): Promise<ChatImageRecord | null>;
  getChatImagesMany(ids: string[]): Promise<Array<ChatImageRecord | null>>;
  putChatImage(input: PutChatImageInput): Promise<ChatImageWriteResult>;
  deleteChatImages(ids: string[]): Promise<string[]>;
  deleteChatImagesByConversationIds(conversationIds: string[]): Promise<string[]>;
  pruneChatImages(input: PruneChatImagesInput): Promise<string[]>;
  clearAllChatImages(): Promise<string[]>;
  listChatImagesByConversationId(conversationId: string): Promise<ChatImageRecord[]>;
  listAllChatImages(): Promise<ChatImageRecord[]>;

  getVideoCacheUsage(): Promise<VideoCacheUsage>;
  syncVideoCacheMaxBytes(maxBytes: number): void;
  setVideoCacheMaxBytes(maxBytes: number): Promise<VideoCacheLimitUpdateResult>;

  getConversation(id: string): Promise<PersistedConversationRecord | null>;
  listConversationMetas(): Promise<ConversationMetaRecord[]>;
  listConversations(): Promise<PersistedConversationRecord[]>;
  countConversations(): Promise<number>;
  putConversation(record: PersistedConversationRecord): Promise<void>;
  putConversationsMany(records: PersistedConversationRecord[]): Promise<void>;
  deleteConversations(ids: string[]): Promise<string[]>;
  clearAllConversations(): Promise<string[]>;
  pruneConversationsToLimit(maxCount: number): Promise<PruneConversationsResult>;

  getNoteHighlights(videoKey: string): Promise<NoteHighlightBucketRecord | null>;
  putNoteHighlights(record: NoteHighlightBucketRecord): Promise<void>;
  putNoteHighlightsMany(records: readonly NoteHighlightBucketRecord[], markMetaKey?: string, markMetaValue?: unknown): Promise<void>;
  deleteNoteHighlights(videoKey: string): Promise<boolean>;
  listNoteHighlights(): Promise<NoteHighlightBucketRecord[]>;

  getStoreMeta<T = unknown>(key: string): Promise<T | null>;
  putStoreMeta<T = unknown>(key: string, value: T): Promise<void>;
  deleteStoreMeta(key: string): Promise<void>;

  clearAll(): Promise<void>;
  setWriteInterceptorForTests(interceptor: SubtitleStoreWriteInterceptor | null): void;
}

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
declare const DEFAULT_MEMORY_BACKING_KEY: unique symbol;
const DEFAULT_MEMORY_BACKING_SYMBOL: typeof DEFAULT_MEMORY_BACKING_KEY = Symbol.for(
  "biliscript.defaultSubtitleIdbMemoryBacking"
) as typeof DEFAULT_MEMORY_BACKING_KEY;

export function buildSubtitlePageId(bvid: string, cid: string, site?: SiteId): string {
  const resolved = resolveVideoStorageIdentity(bvid, cid, site);
  return resolved.bvid && resolved.cid ? `${resolved.bvid}:${resolved.cid}` : "";
}

export function buildSubtitleTrackId(pageId: string, tier: SubtitleTrackTier, trackKey: string): string {
  return `${pageId}::${tier}::${trackKey}`;
}

export function buildSegmentedTrackMapKey(trackKey: string, segmentationSig: string): string {
  return `${String(trackKey || "").trim()}:${String(segmentationSig || "").trim()}`;
}

export function buildTranslatedTrackMapKey(
  sourceTrackKey: string,
  targetLang: string,
  translationSig: string
): string {
  return `${String(sourceTrackKey || "").trim()}->${String(targetLang || "").trim()}:${String(translationSig || "").trim()}`;
}

export function sanitizeMonolingualItems(items: readonly unknown[]): SubtitleBodyItem[] {
  if (!Array.isArray(items)) return [];
  const result: SubtitleBodyItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { from?: unknown; to?: unknown; content?: unknown; words?: unknown };
    const content = String(c.content ?? "").trim();
    if (!content) continue;
    const from = Number(c.from) || 0;
    const to = Number(c.to) || from;
    const item: SubtitleBodyItem = {
      from: Number.isFinite(from) ? from : 0,
      to: Number.isFinite(to) ? to : 0,
      content
    };
    if (Array.isArray(c.words) && c.words.length > 0) {
      const words: SubtitleWord[] = [];
      for (const rw of c.words) {
        if (!rw || typeof rw !== "object") continue;
        const w = rw as Record<string, unknown>;
        const out: SubtitleWord = {};
        if (typeof w.word === "string") out.word = w.word;
        if (typeof w.text === "string") out.text = w.text;
        if (typeof w.start === "number" && Number.isFinite(w.start)) out.start = w.start;
        if (typeof w.end === "number" && Number.isFinite(w.end)) out.end = w.end;
        if (typeof w.startMs === "number" && Number.isFinite(w.startMs)) out.startMs = w.startMs;
        if (typeof w.endMs === "number" && Number.isFinite(w.endMs)) out.endMs = w.endMs;
        words.push(out);
      }
      if (words.length > 0) item.words = words;
    }
    result.push(item);
  }
  return result;
}

export function sanitizeTranslatedItems(items: readonly unknown[]): SubtitleBodyItem[] {
  if (!Array.isArray(items)) return [];
  const result: SubtitleBodyItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { from?: unknown; to?: unknown; content?: unknown };
    const from = Number(c.from);
    const to = Number(c.to);
    const content = String(c.content ?? "").trim();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !content) continue;
    result.push({ from, to, content });
  }
  return result.sort((a, b) => a.from - b.from || a.to - b.to);
}

export function mergeTranslatedItems(
  existing: readonly SubtitleBodyItem[],
  incoming: readonly unknown[],
  replaceRange?: { from: number; to: number }
): SubtitleBodyItem[] {
  const cleanIncoming = sanitizeTranslatedItems(incoming);
  if (cleanIncoming.length === 0 && !replaceRange) return sanitizeTranslatedItems(existing);
  const base = sanitizeTranslatedItems(existing).filter((item) =>
    replaceRange ? item.from < replaceRange.from || item.from >= replaceRange.to : true
  );
  const bySpan = new Map<string, SubtitleBodyItem>();
  for (const item of base) bySpan.set(`${item.from.toFixed(3)}:${item.to.toFixed(3)}`, item);
  for (const item of cleanIncoming) bySpan.set(`${item.from.toFixed(3)}:${item.to.toFixed(3)}`, item);
  return Array.from(bySpan.values()).sort((a, b) => a.from - b.from || a.to - b.to);
}

function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  const tag = Object.prototype.toString.call(value);
  return (tag === "[object Blob]" || tag === "[object File]") && typeof (value as Blob).size === "number";
}

function estimateJsonBytes(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (isBlobLike(value)) return value.size;
  const json = JSON.stringify(value) ?? "";
  return textEncoder ? textEncoder.encode(json).byteLength : json.length * 2;
}

const estimateRecordBytes = (record: object): number => estimateJsonBytes({ ...record, estimatedBytes: 0 });
export const estimateSubtitleRecordBytes = (record: SubtitlePageRecord): number => estimateRecordBytes(record);
export const estimateAiArtifactRecordBytes = (record: AiArtifactRecord): number => {
  const { payload, ...meta } = record;
  return estimateRecordBytes(meta) + estimateJsonBytes(payload);
};
export const estimateChatImageRecordBytes = (record: { blob?: Blob; byteLength?: number; data?: string }): number => {
  if (record.blob && typeof record.blob.size === "number") return record.blob.size;
  if (typeof record.byteLength === "number" && record.byteLength > 0) return record.byteLength;
  return typeof record.data === "string" ? Math.ceil((record.data.length * 3) / 4) : 0;
};

function estimatePageHeaderBytes(header: SubtitlePageHeaderRecord): number {
  let trackTotal = 0;
  for (const bytes of Object.values(header.trackIndex)) trackTotal += Number(bytes) || 0;
  const { trackIndex: _idx, ...slim } = header;
  return estimateRecordBytes(slim) + trackTotal;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (isBlobLike(value)) return value;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const Ctor = view.constructor as new (buf: ArrayBufferLike) => T;
    return new Ctor(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v);
  return out as T;
}

export function chatImageDataUrlToParts(input: string, fallbackMime = ""): { mime: string; data: string } {
  const trimmed = String(input || "").trim();
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    if (comma !== -1) {
      const mime = trimmed.slice(5, comma).split(";")[0].trim() || fallbackMime;
      return { mime, data: trimmed.slice(comma + 1) };
    }
  }
  return { mime: fallbackMime, data: trimmed };
}

export function chatImageToDataUrl(mime: string, base64Data: string): string {
  return `data:${mime};base64,${base64Data}`;
}

export function base64ToChatImageBlob(dataOrDataUrl: string, mime: string): Blob {
  const parts = chatImageDataUrlToParts(dataOrDataUrl, mime);
  const resolvedMime = parts.mime || mime || "application/octet-stream";
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(parts.data);
  } catch {
    bytes = textEncoder ? textEncoder.encode(parts.data) : new Uint8Array(0);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: resolvedMime });
}

export async function chatImageBlobToBase64(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === "function") {
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  if (typeof FileReader !== "undefined") {
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read Blob"));
      reader.readAsArrayBuffer(blob);
    });
    return bytesToBase64(new Uint8Array(buf));
  }
  return "";
}

function createEmptyLedger(ts: number): VideoCacheLedgerRecord {
  return {
    key: VIDEO_CACHE_LEDGER_META_KEY,
    totalBytes: 0,
    subtitleBytes: 0,
    artifactBytes: 0,
    pageCount: 0,
    artifactCount: 0,
    updatedAt: ts
  };
}

function normalizeLedger(raw: unknown, ts: number): VideoCacheLedgerRecord {
  if (!raw || typeof raw !== "object") return createEmptyLedger(ts);
  const o = raw as Partial<VideoCacheLedgerRecord>;
  const subtitleBytes = Math.max(0, Number(o.subtitleBytes) || 0);
  const artifactBytes = Math.max(0, Number(o.artifactBytes) || 0);
  return {
    key: VIDEO_CACHE_LEDGER_META_KEY,
    totalBytes: Math.max(0, Number(o.totalBytes) || subtitleBytes + artifactBytes),
    subtitleBytes,
    artifactBytes,
    pageCount: Math.max(0, Number(o.pageCount) || 0),
    artifactCount: Math.max(0, Number(o.artifactCount) || 0),
    updatedAt: Number(o.updatedAt) || ts
  };
}

function applyLedgerDelta(
  ledger: VideoCacheLedgerRecord,
  delta: { subtitleBytes?: number; artifactBytes?: number; pageCount?: number; artifactCount?: number },
  ts: number
): VideoCacheLedgerRecord {
  const subtitleBytes = Math.max(0, ledger.subtitleBytes + (delta.subtitleBytes ?? 0));
  const artifactBytes = Math.max(0, ledger.artifactBytes + (delta.artifactBytes ?? 0));
  return {
    key: VIDEO_CACHE_LEDGER_META_KEY,
    totalBytes: subtitleBytes + artifactBytes,
    subtitleBytes,
    artifactBytes,
    pageCount: Math.max(0, ledger.pageCount + (delta.pageCount ?? 0)),
    artifactCount: Math.max(0, ledger.artifactCount + (delta.artifactCount ?? 0)),
    updatedAt: ts
  };
}

function normalizePageHeader(raw: unknown): SubtitlePageHeaderRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<SubtitlePageHeaderRecord>;
  const bvid = String(c.bvid || "").trim();
  const cid = String(c.cid || "").trim();
  const id = String(c.id || buildSubtitlePageId(bvid, cid)).trim();
  if (!id || !bvid || !cid) return null;
  const trackIndex: Record<string, number> = {};
  if (c.trackIndex && typeof c.trackIndex === "object" && !Array.isArray(c.trackIndex)) {
    for (const [k, v] of Object.entries(c.trackIndex)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 0) trackIndex[k] = n;
    }
  }
  const header: SubtitlePageHeaderRecord = {
    id,
    bvid,
    cid,
    trackIndex,
    estimatedBytes: Math.max(0, Number(c.estimatedBytes) || 0),
    createdAt: Number(c.createdAt) || 0,
    updatedAt: Number(c.updatedAt) || 0,
    lastUsed: Number(c.lastUsed) || 0
  };
  if (header.estimatedBytes <= 0) header.estimatedBytes = estimatePageHeaderBytes(header);
  return header;
}

function assemblePageRecord(header: SubtitlePageHeaderRecord, tracks: readonly SubtitleTrackRow[]): SubtitlePageRecord {
  const rawTracks: Record<string, RawSubtitleTrackRecord> = {};
  const segmentedTracks: Record<string, SegmentedSubtitleTrackRecord> = {};
  const translatedTracks: Record<string, TranslatedSubtitleTrackRecord> = {};
  for (const row of tracks) {
    if (row.tier === "raw") rawTracks[row.key] = row.data as RawSubtitleTrackRecord;
    else if (row.tier === "segmented") segmentedTracks[row.key] = row.data as SegmentedSubtitleTrackRecord;
    else if (row.tier === "translated") translatedTracks[row.key] = row.data as TranslatedSubtitleTrackRecord;
  }
  return {
    id: header.id,
    bvid: header.bvid,
    cid: header.cid,
    rawTracks,
    segmentedTracks,
    translatedTracks,
    estimatedBytes: header.estimatedBytes,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    lastUsed: header.lastUsed
  };
}

function normalizeAiArtifactRecord(raw: unknown): AiArtifactRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<AiArtifactRecord>;
  const key = String(c.key || "").trim();
  if (!key || c.payload === undefined || c.payload === null) return null;
  const parsed = parseAiArtifactKey(key);
  const family = isAiArtifactFamily(c.family) ? c.family : parsed?.family;
  const bvid = String(c.bvid ?? parsed?.bvid ?? "").trim();
  const cid = String(c.cid ?? parsed?.cid ?? "").trim();
  if (!family || !bvid) return null;
  const createdAt = Number.isFinite(Number(c.createdAt)) ? Number(c.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : createdAt;
  const lastUsedAt = Number.isFinite(Number(c.lastUsedAt)) ? Number(c.lastUsedAt) : updatedAt;
  const record: AiArtifactRecord = {
    key,
    family,
    bvid,
    cid,
    payload: c.payload,
    estimatedBytes: Number(c.estimatedBytes) || 0,
    createdAt,
    updatedAt,
    lastUsedAt
  };
  if (record.estimatedBytes <= 0) record.estimatedBytes = estimateAiArtifactRecordBytes(record);
  return record;
}

function normalizeStoredChatImage(raw: unknown): StoredChatImageRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<StoredChatImageRecord> & { data?: unknown; dataUrl?: unknown };
  const id = typeof c.id === "string" ? c.id.trim() : "";
  const conversationId = typeof c.conversationId === "string" ? c.conversationId.trim() : "";
  const mime = typeof c.mime === "string" ? c.mime.trim() : "";
  if (!id || !conversationId || !mime) return null;
  let blob: Blob | null = null;
  if (isBlobLike(c.blob) && c.blob.size > 0) blob = c.blob;
  else if (typeof c.data === "string" && c.data) blob = base64ToChatImageBlob(c.data, mime);
  else if (typeof c.dataUrl === "string" && c.dataUrl) blob = base64ToChatImageBlob(c.dataUrl, mime);
  if (!blob || blob.size === 0) return null;
  const createdAt = Number.isFinite(Number(c.createdAt)) ? Number(c.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : createdAt;
  return {
    id,
    conversationId,
    bvid: typeof c.bvid === "string" ? c.bvid.trim() : "",
    mime,
    blob,
    byteLength: blob.size,
    createdAt,
    updatedAt
  };
}

async function hydrateChatImageRecord(stored: StoredChatImageRecord | null): Promise<ChatImageRecord | null> {
  if (!stored) return null;
  const data = await chatImageBlobToBase64(stored.blob);
  if (!data) return null;
  return {
    id: stored.id,
    conversationId: stored.conversationId,
    bvid: stored.bvid,
    mime: stored.mime,
    data,
    blob: stored.blob,
    byteLength: stored.byteLength,
    estimatedBytes: stored.byteLength,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  };
}

function splitConversationRecord(
  raw: unknown
): { meta: ConversationMetaRecord; body: ConversationMessagesRecord } | null {
  if (!raw || typeof raw !== "object") return null;
  const src = cloneValue(raw) as Record<string, unknown>;
  const id = typeof src.id === "string" ? src.id.trim() : "";
  if (!id) return null;
  const createdAt = Number.isFinite(Number(src.createdAt)) ? Number(src.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : createdAt;
  const isLive = src.kind === "live-text-tool";
  const ref = src.contextRef && typeof src.contextRef === "object" ? (src.contextRef as Record<string, unknown>) : null;
  const rawMessages = Array.isArray(src.messages) ? src.messages : [];
  const rawRecords = Array.isArray(src.records) ? src.records : [];
  const hasImages =
    !isLive &&
    rawMessages.some(
      (msg) =>
        Boolean(msg) &&
        typeof msg === "object" &&
        Array.isArray((msg as { images?: unknown }).images) &&
        (msg as { images: unknown[] }).images.length > 0
    );

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k !== "messages" && k !== "records" && k !== "summaryAnchor") rest[k] = v;
  }

  const pickStr = (a: unknown, b: unknown): string | undefined =>
    typeof a === "string" ? a : typeof b === "string" ? b : undefined;
  const bvid = pickStr(src.bvid, ref?.bvid);
  const cid = pickStr(src.cid, ref?.cid);
  const aid = pickStr(src.aid, ref?.aid);

  const meta: ConversationMetaRecord = {
    ...rest,
    id,
    kind: isLive ? "live-text-tool" : "chat",
    contextKey: typeof src.contextKey === "string" ? src.contextKey : "",
    ...(src.site !== undefined || ref?.site !== undefined ? { site: normalizeSiteId(src.site ?? ref?.site) } : {}),
    ...(bvid !== undefined ? { bvid } : {}),
    ...(cid !== undefined ? { cid } : {}),
    ...(aid !== undefined ? { aid } : {}),
    title: typeof src.title === "string" ? src.title : "",
    contextTitle: typeof src.contextTitle === "string" ? src.contextTitle : "",
    contextUrl: typeof src.contextUrl === "string" ? src.contextUrl : "",
    isVideoContext: src.isVideoContext !== false,
    contextRef: src.contextRef ?? null,
    createdAt,
    updatedAt,
    messageCount: isLive ? 0 : rawMessages.length,
    recordCount: isLive ? rawRecords.length : 0,
    hasImages,
    ...(src.transcriptMode === "full" || src.transcriptMode === "hybrid" ? { transcriptMode: src.transcriptMode } : {})
  };

  const body: ConversationMessagesRecord = isLive
    ? { id, kind: "live-text-tool", records: rawRecords, updatedAt }
    : {
        id,
        kind: "chat",
        messages: rawMessages,
        ...(src.summaryAnchor !== undefined ? { summaryAnchor: src.summaryAnchor } : {}),
        updatedAt
      };
  return { meta, body };
}

function assembleConversationRecord(
  meta: ConversationMetaRecord,
  body: ConversationMessagesRecord | null
): PersistedConversationRecord {
  if (meta.kind === "live-text-tool" || body?.kind === "live-text-tool") {
    return {
      ...cloneValue(meta),
      kind: "live-text-tool",
      messages: [],
      records: body && body.kind === "live-text-tool" ? cloneValue(body.records) : []
    };
  }
  const out: PersistedConversationRecord = {
    ...cloneValue(meta),
    messages: body && body.kind === "chat" ? cloneValue(body.messages) : []
  };
  if (body && body.kind === "chat" && body.summaryAnchor !== undefined) {
    out.summaryAnchor = cloneValue(body.summaryAnchor);
  }
  return out;
}

function sortByUpdatedDesc<T extends { id: string; updatedAt: number; createdAt?: number }>(list: T[]): T[] {
  return list.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) ||
      a.id.localeCompare(b.id)
  );
}

function compareEvictOrder(
  a: { lastUsed: number; createdAt: number; id: string },
  b: { lastUsed: number; createdAt: number; id: string }
): number {
  return a.lastUsed - b.lastUsed || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function normalizeNoteHighlightBucket(raw: unknown): NoteHighlightBucketRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<NoteHighlightBucketRecord>;
  const videoKey = typeof c.videoKey === "string" ? c.videoKey.trim() : "";
  if (!videoKey) return null;
  return {
    videoKey,
    site: normalizeSiteId(c.site ?? (isEncodedYoutubeStorageBvid(videoKey) ? "youtube" : "bilibili")),
    bvid: typeof c.bvid === "string" ? c.bvid.trim() : "",
    updatedAt: Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : 0,
    items: Array.isArray(c.items) ? cloneValue(c.items) : []
  };
}

interface MemStoreState {
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, string | string[]>;
}

interface MemDbState {
  version: number;
  stores: Map<string, MemStoreState>;
}

type SubtitleIdbMemoryGlobal = typeof globalThis & {
  [DEFAULT_MEMORY_BACKING_SYMBOL]?: Map<string, MemDbState>;
};

function getSharedMemoryDbs(): Map<string, MemDbState> {
  const globals = globalThis as SubtitleIdbMemoryGlobal;
  let dbs = globals[DEFAULT_MEMORY_BACKING_SYMBOL];
  if (!dbs) {
    dbs = new Map();
    globals[DEFAULT_MEMORY_BACKING_SYMBOL] = dbs;
  }
  return dbs;
}

export function clearSharedMemoryNoteHighlightsForTests(): void {
  const dbs = (globalThis as SubtitleIdbMemoryGlobal)[DEFAULT_MEMORY_BACKING_SYMBOL];
  if (!dbs) return;
  for (const db of dbs.values()) {
    db.stores.get(NOTE_HIGHLIGHTS_IDB_STORE)?.records.clear();
    db.stores.get(STORE_META_IDB_STORE)?.records.delete("note_highlights_migrated_v1");
  }
}

export function clearSharedMemoryDbsForTests(): void {
  const dbs = (globalThis as SubtitleIdbMemoryGlobal)[DEFAULT_MEMORY_BACKING_SYMBOL];
  if (!dbs) return;
  for (const db of dbs.values()) {
    for (const st of db.stores.values()) st.records.clear();
    const meta = db.stores.get(STORE_META_IDB_STORE);
    if (meta) meta.records.set(VIDEO_CACHE_LEDGER_META_KEY, createEmptyLedger(Date.now()) as unknown as Record<string, unknown>);
  }
}

function cmpKeys(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : 1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const c = cmpKeys(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchKey(val: unknown, query: unknown): boolean {
  if (query === undefined || query === null) return true;
  if (typeof query === "object" && ("lower" in (query as object) || "upper" in (query as object))) {
    const r = query as { lower?: unknown; upper?: unknown; lowerOpen?: boolean; upperOpen?: boolean };
    if (r.lower !== undefined) {
      const c = cmpKeys(val, r.lower);
      if (r.lowerOpen ? c <= 0 : c < 0) return false;
    }
    if (r.upper !== undefined) {
      const c = cmpKeys(val, r.upper);
      if (r.upperOpen ? c >= 0 : c > 0) return false;
    }
    return true;
  }
  return cmpKeys(val, query) === 0;
}

function createMemoryIdbFactory(shared: boolean): IDBFactory {
  const databases = shared ? getSharedMemoryDbs() : new Map<string, MemDbState>();

  const makeStore = (st: MemStoreState, enq: (fn: () => void) => void): IDBObjectStore => {
    const reqOf = <T>(exec: () => T): IDBRequest<T> => {
      const r: Record<string, unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
      enq(() => {
        try {
          r.result = exec();
          (r.onsuccess as ((e: Event) => void) | null)?.({} as Event);
        } catch (err) {
          r.error = err;
          (r.onerror as ((e: Event) => void) | null)?.({} as Event);
        }
      });
      return r as unknown as IDBRequest<T>;
    };
    const keyOf = (rec: Record<string, unknown>, kp: string | string[]) =>
      Array.isArray(kp) ? kp.map((k) => rec[k]) : rec[kp];
    const cursorOf = (kp: string | string[], query: unknown, keyOnly: boolean) => {
      const r: Record<string, unknown> = { result: null, error: null, onsuccess: null, onerror: null };
      const list = Array.from(st.records.entries())
        .map(([pk, rec]) => ({ pk, ik: keyOf(rec, kp) }))
        .filter((e) => matchKey(e.ik, query))
        .sort((a, b) => cmpKeys(a.ik, b.ik) || cmpKeys(a.pk, b.pk));
      let i = 0;
      const step = () =>
        enq(() => {
          while (i < list.length && !st.records.has(list[i].pk)) i += 1;
          if (i >= list.length) {
            r.result = null;
            (r.onsuccess as ((e: Event) => void) | null)?.({} as Event);
            return;
          }
          const e = list[i++];
          const live = st.records.get(e.pk)!;
          r.result = {
            key: e.ik,
            primaryKey: e.pk,
            ...(keyOnly ? {} : { value: cloneValue(live) }),
            continue: step,
            update: (v: Record<string, unknown>) =>
              reqOf(() => {
                const pk = String(v[st.keyPath]);
                st.records.set(pk, cloneValue(v));
                return pk;
              }),
            delete: () => reqOf(() => { st.records.delete(e.pk); })
          };
          (r.onsuccess as ((e: Event) => void) | null)?.({} as Event);
        });
      step();
      return r as unknown as IDBRequest<IDBCursorWithValue | null>;
    };

    return {
      indexNames: { contains: (n: string) => st.indexes.has(n) },
      createIndex: (n: string, kp: string | string[]) => { st.indexes.set(n, kp); return {} as IDBIndex; },
      deleteIndex: (n: string) => { st.indexes.delete(n); },
      index: (n: string) => {
        const kp = st.indexes.get(n);
        if (!kp) throw new Error(`Missing index ${n}`);
        return {
          openCursor: (q?: unknown) => cursorOf(kp, q, false),
          openKeyCursor: (q?: unknown) => cursorOf(kp, q, true)
        } as unknown as IDBIndex;
      },
      get: (k: IDBValidKey) => reqOf(() => { const h = st.records.get(String(k)); return h === undefined ? undefined : cloneValue(h); }),
      count: () => reqOf(() => st.records.size),
      put: (v: Record<string, unknown>) => reqOf(() => { const pk = String(v[st.keyPath]); st.records.set(pk, cloneValue(v)); return pk; }),
      delete: (k: IDBValidKey) => reqOf(() => { st.records.delete(String(k)); }),
      clear: () => reqOf(() => { st.records.clear(); }),
      openCursor: (q?: unknown) => cursorOf(st.keyPath, q, false),
      openKeyCursor: (q?: unknown) => cursorOf(st.keyPath, q, true)
    } as unknown as IDBObjectStore;
  };

  const makeTx = (dbState: MemDbState, onDone?: () => void): IDBTransaction => {
    let pending = 0;
    let finished = false;
    let oncompleteCb: ((e: Event) => void) | null = null;
    const maybeComplete = () => {
      if (finished || pending !== 0) return;
      if (onDone) {
        queueMicrotask(() => {
          if (!finished && pending === 0) {
            finished = true;
            onDone();
            oncompleteCb?.({} as Event);
          }
        });
      } else if (oncompleteCb) {
        finished = true;
        oncompleteCb({} as Event);
      }
    };
    const enq = (fn: () => void) => {
      pending += 1;
      queueMicrotask(() => {
        try { fn(); } finally { pending -= 1; maybeComplete(); }
      });
    };
    const tx: Record<string, unknown> = {
      error: null,
      get oncomplete() { return oncompleteCb; },
      set oncomplete(fn: ((e: Event) => void) | null) {
        oncompleteCb = fn;
        if (fn && !finished && pending === 0) {
          finished = true;
          fn({} as Event);
        }
      },
      onerror: null,
      onabort: null,
      objectStore: (name: string) => {
        const st = dbState.stores.get(name);
        if (!st) throw new Error(`Missing object store ${name}`);
        return makeStore(st, enq);
      }
    };
    if (onDone) maybeComplete();
    return tx as unknown as IDBTransaction;
  };

  return {
    open(name: string, requestedVersion = 1) {
      let dbState = databases.get(name);
      const oldVersion = dbState?.version ?? 0;
      if (!dbState) {
        dbState = { version: 0, stores: new Map() };
        databases.set(name, dbState);
      }
      const req: Record<string, unknown> = { result: null, transaction: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      let upgradeTx: IDBTransaction | null = null;
      const dbApi = {
        objectStoreNames: { contains: (s: string) => dbState!.stores.has(s) },
        createObjectStore: (s: string, o?: { keyPath?: string }) => {
          const st: MemStoreState = { keyPath: o?.keyPath || "id", records: new Map(), indexes: new Map() };
          dbState!.stores.set(s, st);
          return upgradeTx ? upgradeTx.objectStore(s) : makeStore(st, (f) => queueMicrotask(f));
        },
        deleteObjectStore: (s: string) => { dbState!.stores.delete(s); },
        transaction: () => makeTx(dbState!),
        close() {},
        onversionchange: null,
        onclose: null
      } as unknown as IDBDatabase;
      req.result = dbApi;
      queueMicrotask(() => {
        if (requestedVersion > oldVersion) {
          dbState!.version = requestedVersion;
          upgradeTx = makeTx(dbState!, () => {
            upgradeTx = null;
            req.transaction = null;
            (req.onsuccess as ((e: Event) => void) | null)?.({} as Event);
          });
          req.transaction = upgradeTx;
          (req.onupgradeneeded as ((e: IDBVersionChangeEvent) => void) | null)?.({ oldVersion, newVersion: requestedVersion } as IDBVersionChangeEvent);
        } else {
          (req.onsuccess as ((e: Event) => void) | null)?.({} as Event);
        }
      });
      return req as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openTx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, relaxed = false): IDBTransaction {
  if (relaxed && mode === "readwrite") {
    try {
      return db.transaction(stores, mode, { durability: "relaxed" });
    } catch {
      return db.transaction(stores, mode);
    }
  }
  return db.transaction(stores, mode);
}

function walkCursor(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null | undefined,
  onEntry: (cursor: IDBCursorWithValue) => boolean | void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = query === undefined ? source.openCursor() : source.openCursor(query);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (onEntry(cursor) === false) { resolve(); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
}

function walkKeyCursor(
  source: IDBObjectStore | IDBIndex,
  query: IDBValidKey | IDBKeyRange | null | undefined,
  onKey: (primaryKey: IDBValidKey) => boolean | void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req =
      typeof source.openKeyCursor === "function"
        ? query === undefined ? source.openKeyCursor() : source.openKeyCursor(query)
        : query === undefined ? source.openCursor() : source.openCursor(query);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (onKey(cursor.primaryKey) === false) { resolve(); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB key cursor failed"));
  });
}

function createCursorStepper<T>(source: IDBObjectStore | IDBIndex) {
  const req = source.openCursor();
  let ready = false;
  let done = false;
  let current: IDBCursorWithValue | null = null;
  let failed: unknown = null;
  let waiter: { resolve: (v: T | null) => void; reject: (e: unknown) => void } | null = null;
  req.onsuccess = () => {
    current = req.result;
    ready = true;
    if (!current) done = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(current ? (current.value as T) : null);
    }
  };
  req.onerror = () => {
    failed = req.error ?? new Error("IndexedDB cursor failed");
    done = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(failed);
    }
  };
  return {
    peek(): Promise<T | null> {
      if (failed) return Promise.reject(failed);
      if (ready) return Promise.resolve(current ? (current.value as T) : null);
      return new Promise<T | null>((resolve, reject) => { waiter = { resolve, reject }; });
    },
    advance(): void {
      if (done || !current) return;
      ready = false;
      current.continue();
    }
  };
}

const IDB_STORE_SCHEMAS: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string | string[]]>]> = [
  [SUBTITLE_IDB_STORE, "id", [[SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed"], [SUBTITLE_IDB_BVID_INDEX, "bvid"]]],
  [SUBTITLE_TRACKS_IDB_STORE, "trackId", [[SUBTITLE_TRACKS_INDEX_PAGE_ID, "pageId"]]],
  [AI_ARTIFACTS_IDB_STORE, "key", [[AI_ARTIFACTS_INDEX_FAMILY_BVID, ["family", "bvid"]], [AI_ARTIFACTS_INDEX_BVID, "bvid"], [AI_ARTIFACTS_INDEX_LAST_USED, "lastUsedAt"]]],
  [CHAT_IMAGES_IDB_STORE, "id", [[CHAT_IMAGES_INDEX_CONVERSATION_ID, "conversationId"], [CHAT_IMAGES_INDEX_BVID, "bvid"]]],
  [CONVERSATION_META_IDB_STORE, "id", [[CONVERSATION_META_INDEX_UPDATED_AT, "updatedAt"], [CONVERSATION_META_INDEX_CONTEXT_KEY, "contextKey"]]],
  [CONVERSATION_MESSAGES_IDB_STORE, "id", []],
  [NOTE_HIGHLIGHTS_IDB_STORE, "videoKey", [[NOTE_HIGHLIGHTS_INDEX_UPDATED_AT, "updatedAt"]]],
  [STORE_META_IDB_STORE, "key", []]
];

function migrateToV4OnUpgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  const stores = new Map<string, IDBObjectStore>();
  for (const [name, keyPath, indexes] of IDB_STORE_SCHEMAS) {
    const store = db.objectStoreNames.contains(name)
      ? tx.objectStore(name)
      : db.createObjectStore(name, { keyPath });
    for (const [idxName, idxPath] of indexes) {
      if (!store.indexNames.contains(idxName)) store.createIndex(idxName, idxPath, { unique: false });
    }
    stores.set(name, store);
  }

  const aiStore = stores.get(AI_ARTIFACTS_IDB_STORE)!;
  if (aiStore.indexNames.contains(LEGACY_AI_ARTIFACTS_INDEX_FAMILY_LAST_USED) && typeof aiStore.deleteIndex === "function") {
    aiStore.deleteIndex(LEGACY_AI_ARTIFACTS_INDEX_FAMILY_LAST_USED);
  }
  const chatImgStore = stores.get(CHAT_IMAGES_IDB_STORE)!;
  if (chatImgStore.indexNames.contains(LEGACY_CHAT_IMAGES_INDEX_LAST_USED) && typeof chatImgStore.deleteIndex === "function") {
    chatImgStore.deleteIndex(LEGACY_CHAT_IMAGES_INDEX_LAST_USED);
  }

  const metaStore = stores.get(STORE_META_IDB_STORE)!;
  const nowTs = Date.now();
  if (oldVersion === 0) {
    metaStore.put(createEmptyLedger(nowTs));
    return;
  }

  let subtitleBytes = 0;
  let pageCount = 0;
  let artifactBytes = 0;
  let artifactCount = 0;
  let pendingScans = 2;
  const finishLedgerScan = (): void => {
    pendingScans -= 1;
    if (pendingScans === 0) {
      metaStore.put({
        key: VIDEO_CACHE_LEDGER_META_KEY,
        totalBytes: subtitleBytes + artifactBytes,
        subtitleBytes,
        artifactBytes,
        pageCount,
        artifactCount,
        updatedAt: nowTs
      });
    }
  };

  const pagesStore = stores.get(SUBTITLE_IDB_STORE)!;
  const tracksStore = stores.get(SUBTITLE_TRACKS_IDB_STORE)!;
  const pageReq = pagesStore.openCursor();
  pageReq.onsuccess = () => {
    const cursor = pageReq.result;
    if (!cursor) { finishLedgerScan(); return; }
    const raw = cursor.value as Record<string, unknown>;
    const bvid = String(raw?.bvid || "").trim();
    const cid = String(raw?.cid || "").trim();
    const pageId = String(raw?.id || buildSubtitlePageId(bvid, cid)).trim();
    if (pageId && bvid && cid) {
      const trackIndex: Record<string, number> = {};
      for (const [tier, mapVal] of [
        ["raw", raw.rawTracks],
        ["segmented", raw.segmentedTracks],
        ["translated", raw.translatedTracks]
      ] as const) {
        if (!mapVal || typeof mapVal !== "object" || Array.isArray(mapVal)) continue;
        for (const [k, trackVal] of Object.entries(mapVal as Record<string, unknown>)) {
          if (!k || !trackVal || typeof trackVal !== "object") continue;
          const trackId = buildSubtitleTrackId(pageId, tier, k);
          const row: SubtitleTrackRow = {
            trackId,
            pageId,
            tier,
            key: k,
            data: trackVal as SubtitleTrackRow["data"],
            estimatedBytes: 0,
            updatedAt: Number((trackVal as { updatedAt?: unknown }).updatedAt) || Number(raw.updatedAt) || nowTs
          };
          row.estimatedBytes = estimateRecordBytes(row);
          tracksStore.put(row);
          trackIndex[trackId] = row.estimatedBytes;
        }
      }
      const header: SubtitlePageHeaderRecord = {
        id: pageId,
        bvid,
        cid,
        trackIndex,
        estimatedBytes: 0,
        createdAt: Number(raw.createdAt) || nowTs,
        updatedAt: Number(raw.updatedAt) || nowTs,
        lastUsed: Number(raw.lastUsed) || nowTs
      };
      header.estimatedBytes =
        Object.keys(trackIndex).length > 0
          ? estimatePageHeaderBytes(header)
          : Math.max(Number(raw.estimatedBytes) || 0, estimatePageHeaderBytes(header));
      cursor.update(header);
      subtitleBytes += header.estimatedBytes;
      pageCount += 1;
    }
    cursor.continue();
  };
  pageReq.onerror = () => finishLedgerScan();

  const artReq = aiStore.openCursor();
  artReq.onsuccess = () => {
    const cursor = artReq.result;
    if (!cursor) { finishLedgerScan(); return; }
    const norm = normalizeAiArtifactRecord(cursor.value);
    if (norm) {
      artifactBytes += norm.estimatedBytes;
      artifactCount += 1;
    }
    cursor.continue();
  };
  artReq.onerror = () => finishLedgerScan();

  const imgReq = chatImgStore.openCursor();
  imgReq.onsuccess = () => {
    const cursor = imgReq.result;
    if (!cursor) return;
    const norm = normalizeStoredChatImage(cursor.value);
    if (norm) cursor.update(norm);
    cursor.continue();
  };

  if (db.objectStoreNames.contains(LEGACY_CONVERSATIONS_IDB_STORE)) {
    const convMetaStore = stores.get(CONVERSATION_META_IDB_STORE)!;
    const convMsgStore = stores.get(CONVERSATION_MESSAGES_IDB_STORE)!;
    const convReq = tx.objectStore(LEGACY_CONVERSATIONS_IDB_STORE).openCursor();
    convReq.onsuccess = () => {
      const cursor = convReq.result;
      if (!cursor) { db.deleteObjectStore(LEGACY_CONVERSATIONS_IDB_STORE); return; }
      const split = splitConversationRecord(cursor.value);
      if (split) {
        convMetaStore.put(split.meta);
        convMsgStore.put(split.body);
      }
      cursor.continue();
    };
  }
}

function isWebPageOriginContext(): boolean {
  if (typeof window === "undefined") return false;
  const protocol = String(window.location?.protocol || "").toLowerCase();
  return protocol === "http:" || protocol === "https:";
}

function resolveIdbFactory(options: SubtitleIdbStoreOptions): IDBFactory {
  if (options.indexedDB !== undefined) {
    if (options.indexedDB && typeof options.indexedDB.open === "function") return options.indexedDB;
    return createMemoryIdbFactory(options.useSharedMemoryBacking === true);
  }
  if (isWebPageOriginContext()) return createMemoryIdbFactory(options.useSharedMemoryBacking === true);
  const idb = typeof globalThis !== "undefined" ? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null : null;
  if (idb && typeof idb.open === "function") return idb;
  return createMemoryIdbFactory(options.useSharedMemoryBacking === true);
}

export function createSubtitleIdbStore(options: SubtitleIdbStoreOptions = {}): SubtitleIdbStore {
  const maxEntries = options.maxEntries !== undefined ? Math.max(1, Math.floor(options.maxEntries)) : Number.POSITIVE_INFINITY;
  const initialMaxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_SUBTITLE_CACHE_MAX_BYTES));
  let currentMaxBytes = initialMaxBytes;
  const now = options.now ?? (() => Date.now());
  const idbFactory = resolveIdbFactory(options);
  const dbName = options.dbName || SUBTITLE_IDB_NAME;
  const explicitKeepVideosMap: Partial<Record<AiArtifactFamily, number>> | null = options.aiArtifactKeepVideos
    ? { ...options.aiArtifactKeepVideos }
    : null;
  let writeInterceptor: SubtitleStoreWriteInterceptor | null = null;
  let opQueue: Promise<unknown> = Promise.resolve();
  let dbPromise: Promise<IDBDatabase> | null = null;

  const cleanIdList = (ids: unknown): string[] =>
    Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean)));
  const posTs = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const toErr = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = opQueue.then(task, task);
    opQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idbFactory.open(dbName, SUBTITLE_IDB_VERSION);
      req.onupgradeneeded = (ev) => {
        const oldVersion = Number(ev?.oldVersion) || 0;
        if (oldVersion < SUBTITLE_IDB_VERSION) migrateToV4OnUpgrade(req.result, req.transaction!, oldVersion);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("Failed to open IndexedDB"));
      };
    });
    return dbPromise;
  }

  async function withTx<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T>,
    relaxed = false
  ): Promise<T> {
    const db = await openDb();
    const tx = openTx(db, stores, mode, relaxed);
    const result = await run(tx);
    await idbTxDone(tx);
    return result;
  }

  async function collectCursor<T>(
    source: IDBObjectStore | IDBIndex,
    query: IDBValidKey | IDBKeyRange | null | undefined,
    map: (val: unknown) => T | null
  ): Promise<T[]> {
    const out: T[] = [];
    await walkCursor(source, query, (c) => {
      const item = map(c.value);
      if (item !== null) out.push(item);
    });
    return out;
  }

  async function deletePageTracksInTx(tracksStore: IDBObjectStore, pageId: string): Promise<void> {
    const keys: IDBValidKey[] = [];
    await walkKeyCursor(tracksStore.index(SUBTITLE_TRACKS_INDEX_PAGE_ID), pageId, (pk) => { keys.push(pk); });
    for (const pk of keys) tracksStore.delete(pk);
  }

  async function readLedgerInTx(metaStore: IDBObjectStore, ts: number): Promise<VideoCacheLedgerRecord> {
    return normalizeLedger(await idbReq(metaStore.get(VIDEO_CACHE_LEDGER_META_KEY)), ts);
  }

  async function deleteChatImagesForConvIdsInTx(imgStore: IDBObjectStore, convIds: readonly string[]): Promise<string[]> {
    const removed = new Set<string>();
    const idx = imgStore.index(CHAT_IMAGES_INDEX_CONVERSATION_ID);
    for (const convId of convIds) {
      await walkKeyCursor(idx, convId, (pk) => { removed.add(String(pk)); });
    }
    const list = Array.from(removed);
    for (const id of list) imgStore.delete(id);
    return list;
  }

  async function touchPageLastUsed(pageId: string): Promise<void> {
    await withTx(SUBTITLE_IDB_STORE, "readwrite", async (tx) => {
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const header = normalizePageHeader(await idbReq(store.get(pageId)));
      if (header) {
        header.lastUsed = now();
        store.put(header);
      }
    }, true);
  }

  async function touchArtifactsLastUsed(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const ts = now();
    await withTx(AI_ARTIFACTS_IDB_STORE, "readwrite", async (tx) => {
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      for (const k of keys) {
        const rec = normalizeAiArtifactRecord(await idbReq(store.get(k)));
        if (rec) {
          rec.lastUsedAt = ts;
          store.put(rec);
        }
      }
    }, true);
  }

  async function computeVideoCacheUsage(): Promise<VideoCacheUsage> {
    const ledger = await withTx(STORE_META_IDB_STORE, "readonly", (tx) =>
      readLedgerInTx(tx.objectStore(STORE_META_IDB_STORE), now())
    );
    return {
      totalBytes: ledger.totalBytes,
      subtitleBytes: ledger.subtitleBytes,
      artifactBytes: ledger.artifactBytes,
      subtitlePageCount: ledger.pageCount,
      artifactCount: ledger.artifactCount,
      maxBytes: currentMaxBytes
    };
  }

  async function evictVideoCacheByCursors(
    protectedTarget: { pageId?: string; artifactKey?: string },
    ts: number
  ): Promise<{ evictedIds: string[]; evictedArtifactKeys: string[] }> {
    return withTx(
      [SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE, AI_ARTIFACTS_IDB_STORE, STORE_META_IDB_STORE],
      "readwrite",
      async (tx) => {
        const pagesStore = tx.objectStore(SUBTITLE_IDB_STORE);
        const tracksStore = tx.objectStore(SUBTITLE_TRACKS_IDB_STORE);
        const artStore = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
        const metaStore = tx.objectStore(STORE_META_IDB_STORE);

        let ledger = await readLedgerInTx(metaStore, ts);
        const overBytes = ledger.totalBytes > currentMaxBytes;
        const overPages = ledger.pageCount > maxEntries;
        if (!overBytes && !overPages) return { evictedIds: [], evictedArtifactKeys: [] };

        const byteTarget = overBytes ? Math.floor(currentMaxBytes * 0.9) : currentMaxBytes;
        const deletedPages = new Set<string>();
        const deletedArts = new Set<string>();
        const pageCursor = createCursorStepper<SubtitlePageHeaderRecord>(pagesStore.index(SUBTITLE_IDB_LAST_USED_INDEX));
        const artCursor = createCursorStepper<AiArtifactRecord>(artStore.index(AI_ARTIFACTS_INDEX_LAST_USED));

        const evictPage = async (p: SubtitlePageHeaderRecord): Promise<void> => {
          if (deletedPages.has(p.id)) return;
          deletedPages.add(p.id);
          pagesStore.delete(p.id);
          await deletePageTracksInTx(tracksStore, p.id);
          ledger = applyLedgerDelta(ledger, { subtitleBytes: -p.estimatedBytes, pageCount: -1 }, ts);
          if (!p.bvid) return;
          let hasOtherPage = false;
          await walkKeyCursor(pagesStore.index(SUBTITLE_IDB_BVID_INDEX), p.bvid, (pk) => {
            if (!deletedPages.has(String(pk))) { hasOtherPage = true; return false; }
            return undefined;
          });
          if (hasOtherPage) return;
          const cascadeArts = await collectCursor(artStore.index(AI_ARTIFACTS_INDEX_BVID), p.bvid, (v) => {
            const rec = normalizeAiArtifactRecord(v);
            return rec && rec.key !== protectedTarget.artifactKey && !deletedArts.has(rec.key) ? rec : null;
          });
          for (const rec of cascadeArts) {
            artStore.delete(rec.key);
            deletedArts.add(rec.key);
            ledger = applyLedgerDelta(ledger, { artifactBytes: -rec.estimatedBytes, artifactCount: -1 }, ts);
          }
        };

        const peekPage = async (): Promise<SubtitlePageHeaderRecord | null> => {
          while (true) {
            const raw = await pageCursor.peek();
            if (!raw) return null;
            const p = normalizePageHeader(raw);
            if (!p || p.id === protectedTarget.pageId || deletedPages.has(p.id)) { pageCursor.advance(); continue; }
            return p;
          }
        };

        const peekArt = async (): Promise<AiArtifactRecord | null> => {
          while (true) {
            const raw = await artCursor.peek();
            if (!raw) return null;
            const a = normalizeAiArtifactRecord(raw);
            if (!a || a.key === protectedTarget.artifactKey || deletedArts.has(a.key)) { artCursor.advance(); continue; }
            return a;
          }
        };

        while (ledger.totalBytes > byteTarget) {
          const [p, a] = await Promise.all([peekPage(), peekArt()]);
          if (!p && !a) break;
          if (
            p !== null &&
            (a === null ||
              compareEvictOrder(
                { lastUsed: p.lastUsed, createdAt: p.createdAt, id: p.id },
                { lastUsed: a.lastUsedAt, createdAt: a.createdAt, id: a.key }
              ) <= 0)
          ) {
            pageCursor.advance();
            await evictPage(p);
          } else if (a) {
            artCursor.advance();
            artStore.delete(a.key);
            deletedArts.add(a.key);
            ledger = applyLedgerDelta(ledger, { artifactBytes: -a.estimatedBytes, artifactCount: -1 }, ts);
          }
        }

        while (ledger.pageCount > maxEntries) {
          const p = await peekPage();
          if (!p) break;
          pageCursor.advance();
          await evictPage(p);
        }

        if (deletedPages.size > 0 || deletedArts.size > 0) metaStore.put(ledger);
        return { evictedIds: Array.from(deletedPages), evictedArtifactKeys: Array.from(deletedArts) };
      },
      true
    );
  }

  async function writeSingleTrack(
    ctx: SubtitleStoreWriteContext,
    tier: SubtitleTrackTier,
    trackKey: string,
    buildNext: (existing: SubtitleTrackRow | null, ts: number) => SubtitleTrackRow | null
  ): Promise<SubtitleStoreWriteResult> {
    return enqueue(async () => {
      const pageId = buildSubtitlePageId(ctx.bvid, ctx.cid);
      if (!pageId) return { ok: false, evictedIds: [], error: new Error("Invalid bvid or cid for subtitle store write") };
      try {
        if (writeInterceptor) await writeInterceptor({ ...ctx, pageId });
        const ts = now();
        const trackId = buildSubtitleTrackId(pageId, tier, trackKey);
        const mutation = await withTx(
          [SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE, STORE_META_IDB_STORE],
          "readwrite",
          async (tx) => {
            const pagesStore = tx.objectStore(SUBTITLE_IDB_STORE);
            const tracksStore = tx.objectStore(SUBTITLE_TRACKS_IDB_STORE);
            const metaStore = tx.objectStore(STORE_META_IDB_STORE);
            const [rawHeader, rawTrack, prevLedger] = await Promise.all([
              idbReq(pagesStore.get(pageId)),
              idbReq(tracksStore.get(trackId)),
              readLedgerInTx(metaStore, ts)
            ]);
            const prevHeader = normalizePageHeader(rawHeader);
            const existed = Boolean(prevHeader);
            const prevPageBytes = prevHeader?.estimatedBytes ?? 0;
            const existingTrack = rawTrack ? (rawTrack as SubtitleTrackRow) : null;
            const nextTrack = buildNext(existingTrack, ts);
            const header: SubtitlePageHeaderRecord = prevHeader
              ? { ...prevHeader, trackIndex: { ...prevHeader.trackIndex } }
              : { id: pageId, bvid: ctx.bvid, cid: ctx.cid, trackIndex: {}, estimatedBytes: 0, createdAt: ts, updatedAt: ts, lastUsed: ts };

            if (!nextTrack) {
              if (!existingTrack) return { changed: false, estimatedBytes: prevPageBytes, needsEviction: false };
              tracksStore.delete(trackId);
              delete header.trackIndex[trackId];
              let estBytes = 0;
              if (Object.keys(header.trackIndex).length === 0) {
                pagesStore.delete(pageId);
                metaStore.put(applyLedgerDelta(prevLedger, { subtitleBytes: -prevPageBytes, pageCount: existed ? -1 : 0 }, ts));
              } else {
                header.updatedAt = ts;
                header.lastUsed = ts;
                header.estimatedBytes = estimatePageHeaderBytes(header);
                estBytes = header.estimatedBytes;
                pagesStore.put(header);
                metaStore.put(applyLedgerDelta(prevLedger, { subtitleBytes: estBytes - prevPageBytes }, ts));
              }
              return { changed: true, estimatedBytes: estBytes, needsEviction: false };
            }

            nextTrack.estimatedBytes = estimateRecordBytes(nextTrack);
            header.trackIndex[trackId] = nextTrack.estimatedBytes;
            header.updatedAt = ts;
            header.lastUsed = ts;
            header.estimatedBytes = estimatePageHeaderBytes(header);
            if (header.estimatedBytes > currentMaxBytes) {
              throw new Error(`Subtitle page ${pageId} (${header.estimatedBytes} B) exceeds maxBytes (${currentMaxBytes} B)`);
            }
            const nextLedger = applyLedgerDelta(
              prevLedger,
              { subtitleBytes: header.estimatedBytes - prevPageBytes, pageCount: existed ? 0 : 1 },
              ts
            );
            tracksStore.put(nextTrack);
            pagesStore.put(header);
            metaStore.put(nextLedger);
            return {
              changed: true,
              estimatedBytes: header.estimatedBytes,
              needsEviction: nextLedger.totalBytes > currentMaxBytes || nextLedger.pageCount > maxEntries
            };
          },
          true
        );
        if (!mutation.changed || !mutation.needsEviction) {
          return { ok: true, evictedIds: [], estimatedBytes: mutation.estimatedBytes };
        }
        const { evictedIds, evictedArtifactKeys } = await evictVideoCacheByCursors({ pageId }, ts);
        return {
          ok: true,
          evictedIds,
          ...(evictedArtifactKeys.length > 0 ? { evictedArtifactKeys } : {}),
          estimatedBytes: mutation.estimatedBytes
        };
      } catch (err) {
        return { ok: false, evictedIds: [], error: toErr(err) };
      }
    });
  }

  async function deleteTracksForPage(pageId: string, predicate: (row: SubtitleTrackRow) => boolean): Promise<string[]> {
    const ts = now();
    return withTx(
      [SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE, STORE_META_IDB_STORE],
      "readwrite",
      async (tx) => {
        const pagesStore = tx.objectStore(SUBTITLE_IDB_STORE);
        const tracksStore = tx.objectStore(SUBTITLE_TRACKS_IDB_STORE);
        const metaStore = tx.objectStore(STORE_META_IDB_STORE);
        const header = normalizePageHeader(await idbReq(pagesStore.get(pageId)));
        if (!header) return [];
        const prevBytes = header.estimatedBytes;
        const removedKeys: string[] = [];
        const toDelete: string[] = [];
        await walkCursor(tracksStore.index(SUBTITLE_TRACKS_INDEX_PAGE_ID), pageId, (c) => {
          const row = c.value as SubtitleTrackRow;
          if (predicate(row)) {
            toDelete.push(row.trackId);
            removedKeys.push(row.key);
          }
        });
        if (removedKeys.length === 0) return [];
        for (const tid of toDelete) {
          tracksStore.delete(tid);
          delete header.trackIndex[tid];
        }
        const ledger = await readLedgerInTx(metaStore, ts);
        if (Object.keys(header.trackIndex).length === 0) {
          pagesStore.delete(pageId);
          metaStore.put(applyLedgerDelta(ledger, { subtitleBytes: -prevBytes, pageCount: -1 }, ts));
        } else {
          header.updatedAt = ts;
          header.estimatedBytes = estimatePageHeaderBytes(header);
          pagesStore.put(header);
          metaStore.put(applyLedgerDelta(ledger, { subtitleBytes: header.estimatedBytes - prevBytes }, ts));
        }
        return removedKeys;
      },
      true
    );
  }

  async function evictFamilyArtifactsByKeepVideos(
    family: AiArtifactFamily,
    keepVideos: number,
    protectedBvid: string,
    ts: number
  ): Promise<string[]> {
    return withTx([AI_ARTIFACTS_IDB_STORE, STORE_META_IDB_STORE], "readwrite", async (tx) => {
      const artStore = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const metaStore = tx.objectStore(STORE_META_IDB_STORE);
      const byBvid = new Map<string, { maxLastUsedAt: number; maxCreatedAt: number; keys: string[]; bytes: number }>();
      const range =
        typeof IDBKeyRange !== "undefined" && typeof IDBKeyRange.bound === "function"
          ? IDBKeyRange.bound([family, ""], [family, "\uffff"])
          : null;
      await walkCursor(artStore.index(AI_ARTIFACTS_INDEX_FAMILY_BVID), range, (c) => {
        const rec = normalizeAiArtifactRecord(c.value);
        if (!rec || rec.family !== family) return;
        let bucket = byBvid.get(rec.bvid);
        if (!bucket) {
          bucket = { maxLastUsedAt: rec.lastUsedAt, maxCreatedAt: rec.createdAt, keys: [], bytes: 0 };
          byBvid.set(rec.bvid, bucket);
        }
        bucket.maxLastUsedAt = Math.max(bucket.maxLastUsedAt, rec.lastUsedAt);
        bucket.maxCreatedAt = Math.max(bucket.maxCreatedAt, rec.createdAt);
        bucket.keys.push(rec.key);
        bucket.bytes += rec.estimatedBytes;
      });
      if (byBvid.size <= keepVideos) return [];
      const candidates = Array.from(byBvid.entries())
        .filter(([bvid]) => bvid !== protectedBvid)
        .sort((a, b) =>
          a[1].maxLastUsedAt - b[1].maxLastUsedAt ||
          a[1].maxCreatedAt - b[1].maxCreatedAt ||
          a[0].localeCompare(b[0])
        );
      let remaining = byBvid.size;
      const evictedKeys: string[] = [];
      let freedBytes = 0;
      for (const [, bucket] of candidates) {
        if (remaining <= keepVideos) break;
        for (const k of bucket.keys) { artStore.delete(k); evictedKeys.push(k); }
        freedBytes += bucket.bytes;
        remaining -= 1;
      }
      if (evictedKeys.length > 0) {
        const prevLedger = await readLedgerInTx(metaStore, ts);
        metaStore.put(applyLedgerDelta(prevLedger, { artifactBytes: -freedBytes, artifactCount: -evictedKeys.length }, ts));
      }
      return evictedKeys;
    }, true);
  }

  return {
    getPageRecord: (bvid, cid, site) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) return null;
        return withTx([SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE], "readonly", async (tx) => {
          const header = normalizePageHeader(await idbReq(tx.objectStore(SUBTITLE_IDB_STORE).get(pageId)));
          if (!header) return null;
          const tracks = await collectCursor(
            tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).index(SUBTITLE_TRACKS_INDEX_PAGE_ID),
            pageId,
            (v) => (v as SubtitleTrackRow) || null
          );
          return assemblePageRecord(header, tracks);
        });
      }),

    listPageRecords: () =>
      enqueue(() =>
        withTx([SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE], "readonly", async (tx) => {
          const headers = await collectCursor(tx.objectStore(SUBTITLE_IDB_STORE), undefined, normalizePageHeader);
          const idx = tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).index(SUBTITLE_TRACKS_INDEX_PAGE_ID);
          const pages: SubtitlePageRecord[] = [];
          for (const h of headers) {
            const tracks = await collectCursor(idx, h.id, (v) => (v as SubtitleTrackRow) || null);
            pages.push(assemblePageRecord(h, tracks));
          }
          return pages;
        })
      ),

    getRawTrack: (bvid, cid, trackKey, site) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const key = String(trackKey || "").trim();
        if (!pageId || !key) return null;
        const row = await withTx(SUBTITLE_TRACKS_IDB_STORE, "readonly", (tx) =>
          idbReq(tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).get(buildSubtitleTrackId(pageId, "raw", key)))
        );
        const items = ((row as SubtitleTrackRow | undefined)?.data as RawSubtitleTrackRecord | undefined)?.items;
        if (!Array.isArray(items) || items.length === 0) return null;
        await touchPageLastUsed(pageId);
        return items.map((item) => ({ ...item }));
      }),

    async putRawTrack({ bvid, cid, site, trackKey, lang, kind, items }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanTrackKey = String(trackKey || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || sanitized.length === 0) return { ok: true, evictedIds: [] };
      const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
      return writeSingleTrack(
        { op: "put-raw", pageId, bvid: resolved.bvid, cid: resolved.cid, trackKey: cleanTrackKey },
        "raw",
        cleanTrackKey,
        (_existing, ts) => ({
          trackId: buildSubtitleTrackId(pageId, "raw", cleanTrackKey),
          pageId,
          tier: "raw",
          key: cleanTrackKey,
          data: { trackKey: cleanTrackKey, ...(lang ? { lang } : {}), ...(kind ? { kind } : {}), items: sanitized, updatedAt: ts },
          estimatedBytes: 0,
          updatedAt: ts
        })
      );
    },

    getSegmentedTrack: (bvid, cid, trackKey, segmentationSig, site) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanTrackKey = String(trackKey || "").trim();
        const cleanSig = String(segmentationSig || "").trim();
        if (!pageId || !cleanTrackKey || !cleanSig) return null;
        const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
        const row = await withTx(SUBTITLE_TRACKS_IDB_STORE, "readonly", (tx) =>
          idbReq(tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).get(buildSubtitleTrackId(pageId, "segmented", mapKey)))
        );
        const items = ((row as SubtitleTrackRow | undefined)?.data as SegmentedSubtitleTrackRecord | undefined)?.items;
        if (!Array.isArray(items) || items.length === 0) return null;
        await touchPageLastUsed(pageId);
        return items.map((item) => ({ ...item }));
      }),

    async putSegmentedTrack({ bvid, cid, site, trackKey, segmentationSig, items }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanTrackKey = String(trackKey || "").trim();
      const cleanSig = String(segmentationSig || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || !cleanSig || sanitized.length === 0) return { ok: true, evictedIds: [] };
      const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
      const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
      return writeSingleTrack(
        { op: "put-segmented", pageId, bvid: resolved.bvid, cid: resolved.cid, trackKey: mapKey },
        "segmented",
        mapKey,
        (_existing, ts) => ({
          trackId: buildSubtitleTrackId(pageId, "segmented", mapKey),
          pageId,
          tier: "segmented",
          key: mapKey,
          data: { key: mapKey, trackKey: cleanTrackKey, segmentationSig: cleanSig, items: sanitized, updatedAt: ts },
          estimatedBytes: 0,
          updatedAt: ts
        })
      );
    },

    getTranslatedTrack: (bvid, cid, sourceTrackKey, targetLang, translationSig, site) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanSource = String(sourceTrackKey || "").trim();
        const cleanLang = String(targetLang || "").trim();
        if (!pageId || !cleanSource || !cleanLang) return null;

        let hit: TranslatedSubtitleTrackRecord | undefined;
        if (translationSig) {
          const exactKey = buildTranslatedTrackMapKey(cleanSource, cleanLang, translationSig);
          const exactRow = (await withTx(SUBTITLE_TRACKS_IDB_STORE, "readonly", (tx) =>
            idbReq(tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).get(buildSubtitleTrackId(pageId, "translated", exactKey)))
          )) as SubtitleTrackRow | undefined;
          if (exactRow?.tier === "translated") {
            hit = exactRow.data as TranslatedSubtitleTrackRecord;
          } else {
            const entries = await withTx(SUBTITLE_TRACKS_IDB_STORE, "readonly", (tx) =>
              collectCursor(tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).index(SUBTITLE_TRACKS_INDEX_PAGE_ID), pageId, (v) => {
                const r = v as SubtitleTrackRow;
                return r?.tier === "translated" ? (r.data as TranslatedSubtitleTrackRecord) : null;
              })
            );
            const hasExplicit = entries.some(
              (e) => e.sourceTrackKey === cleanSource && e.targetLang === cleanLang && e.translationSig !== "legacy"
            );
            if (!hasExplicit) {
              const legacyKey = buildTranslatedTrackMapKey(cleanSource, cleanLang, "legacy");
              hit = entries.find((e) => e.key === legacyKey);
            }
          }
        } else {
          const candidates = await withTx(SUBTITLE_TRACKS_IDB_STORE, "readonly", (tx) =>
            collectCursor(tx.objectStore(SUBTITLE_TRACKS_IDB_STORE).index(SUBTITLE_TRACKS_INDEX_PAGE_ID), pageId, (v) => {
              const r = v as SubtitleTrackRow;
              if (r?.tier !== "translated") return null;
              const d = r.data as TranslatedSubtitleTrackRecord;
              return d.sourceTrackKey === cleanSource && d.targetLang === cleanLang ? d : null;
            })
          );
          candidates.sort(
            (a, b) =>
              b.updatedAt - a.updatedAt ||
              (a.translationSig === "legacy" ? 1 : 0) - (b.translationSig === "legacy" ? 1 : 0) ||
              b.items.length - a.items.length
          );
          hit = candidates[0];
        }
        if (!hit || !Array.isArray(hit.items) || hit.items.length === 0) return null;
        await touchPageLastUsed(pageId);
        return hit.items.map((item) => ({ ...item }));
      }),

    async upsertTranslatedTrack({ bvid, cid, site, sourceTrackKey, targetLang, translationSig, mode, items, replaceRange }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanSource = String(sourceTrackKey || "").trim();
      const cleanLang = String(targetLang || "").trim();
      const cleanSig = String(translationSig || "").trim() || "legacy";
      const sanitizedIncoming = sanitizeTranslatedItems(items);
      if (!cleanSource || !cleanLang || (sanitizedIncoming.length === 0 && !replaceRange)) return { ok: true, evictedIds: [] };
      const mapKey = buildTranslatedTrackMapKey(cleanSource, cleanLang, cleanSig);
      const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
      return writeSingleTrack(
        { op: "upsert-translated", pageId, bvid: resolved.bvid, cid: resolved.cid, trackKey: mapKey },
        "translated",
        mapKey,
        (existing, ts) => {
          const merged = mergeTranslatedItems(
            (existing?.data as TranslatedSubtitleTrackRecord | undefined)?.items ?? [],
            sanitizedIncoming,
            replaceRange
          );
          if (merged.length === 0) return null;
          return {
            trackId: buildSubtitleTrackId(pageId, "translated", mapKey),
            pageId,
            tier: "translated",
            key: mapKey,
            data: {
              key: mapKey,
              sourceTrackKey: cleanSource,
              targetLang: cleanLang,
              translationSig: cleanSig,
              ...(mode ? { mode } : {}),
              items: merged,
              updatedAt: ts
            },
            estimatedBytes: 0,
            updatedAt: ts
          };
        }
      );
    },

    deleteTrackEntry: ({ bvid, cid, site, tier, key }) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanKey = String(key || "").trim();
        if (!pageId || !cleanKey) return false;
        const removed = await deleteTracksForPage(pageId, (row) => {
          if (tier === "rawTracks") return row.tier === "raw" && row.key === cleanKey;
          if (tier === "translatedTracks") return row.tier === "translated" && row.key === cleanKey;
          return row.tier === "segmented" && (row.key === cleanKey || (row.data as SegmentedSubtitleTrackRecord).trackKey === cleanKey);
        });
        return removed.length > 0;
      }),

    pruneAsrVariants: ({ bvid, cid, keepTrackKey = "", site }) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) return [];
        const removedRaw: string[] = [];
        await deleteTracksForPage(pageId, (row) => {
          if (row.tier === "raw" && isAsrVariantSourceKey(row.key) && row.key !== keepTrackKey) {
            removedRaw.push(row.key);
            return true;
          }
          if (row.tier === "segmented") {
            const segTrackKey = (row.data as SegmentedSubtitleTrackRecord).trackKey;
            if (isAsrVariantSourceKey(segTrackKey) && segTrackKey !== keepTrackKey) return true;
          }
          return false;
        });
        return removedRaw;
      }),

    clearTranslatedTracksForPage: ({ bvid, cid, sourceTrackKey, site }) =>
      enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) return [];
        return deleteTracksForPage(
          pageId,
          (row) => row.tier === "translated" && (!sourceTrackKey || (row.data as TranslatedSubtitleTrackRecord).sourceTrackKey === sourceTrackKey)
        );
      }),

    getAiArtifact: <TPayload = unknown>(key: string) =>
      enqueue(async (): Promise<AiArtifactRecord<TPayload> | null> => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return null;
        const record = normalizeAiArtifactRecord(
          await withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) => idbReq(tx.objectStore(AI_ARTIFACTS_IDB_STORE).get(cleanKey)))
        );
        if (!record) return null;
        await touchArtifactsLastUsed([cleanKey]);
        return cloneValue(record) as AiArtifactRecord<TPayload>;
      }),

    readAiArtifactPayloadRaw: <TPayload = unknown>(key: string) =>
      enqueue(async (): Promise<TPayload | null> => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return null;
        const record = normalizeAiArtifactRecord(
          await withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) => idbReq(tx.objectStore(AI_ARTIFACTS_IDB_STORE).get(cleanKey)))
        );
        return record ? (record.payload as TPayload) : null;
      }),

    getAiArtifactsMany: <TPayload = unknown>(keys: string[]) =>
      enqueue(async (): Promise<Array<AiArtifactRecord<TPayload> | null>> => {
        const cleanKeys = (Array.isArray(keys) ? keys : []).map((k) => String(k || "").trim());
        if (cleanKeys.length === 0) return [];
        const raw = await withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) => {
          const s = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
          return Promise.all(cleanKeys.map((k) => idbReq(s.get(k))));
        });
        const hits = raw.map((item) => normalizeAiArtifactRecord(item));
        const hitKeys = hits.filter((rec): rec is AiArtifactRecord => rec !== null).map((r) => r.key);
        if (hitKeys.length > 0) await touchArtifactsLastUsed(hitKeys);
        return hits.map((rec) => (rec ? (cloneValue(rec) as AiArtifactRecord<TPayload>) : null));
      }),

    putAiArtifact: <TPayload = unknown>(input: PutAiArtifactInput<TPayload>) =>
      enqueue(async (): Promise<AiArtifactWriteResult> => {
        const cleanKey = String(input?.key || "").trim();
        const parsed = parseAiArtifactKey(cleanKey);
        const family = isAiArtifactFamily(input?.family) ? input.family : parsed?.family;
        const resolved = resolveVideoStorageIdentity(String(input?.bvid ?? parsed?.bvid ?? "").trim(), String(input?.cid ?? parsed?.cid ?? "").trim(), input?.site);
        const { bvid, cid } = resolved;
        if (!cleanKey || !family || !bvid || input?.payload === undefined || input?.payload === null) {
          return { ok: false, evictedKeys: [], error: new Error("Invalid ai_artifact key, family, bvid or payload") };
        }
        try {
          if (writeInterceptor) {
            await writeInterceptor({ op: "put-ai-artifact", pageId: buildSubtitlePageId(bvid, cid), bvid, cid, trackKey: cleanKey, family, key: cleanKey });
          }
          const ts = now();
          const writeRes = await withTx([AI_ARTIFACTS_IDB_STORE, STORE_META_IDB_STORE], "readwrite", async (tx) => {
            const artStore = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
            const metaStore = tx.objectStore(STORE_META_IDB_STORE);
            const [prevRaw, prevLedger] = await Promise.all([idbReq(artStore.get(cleanKey)), readLedgerInTx(metaStore, ts)]);
            const prev = normalizeAiArtifactRecord(prevRaw);
            const record: AiArtifactRecord<TPayload> = {
              key: cleanKey,
              family,
              bvid,
              cid,
              payload: cloneValue(input.payload),
              estimatedBytes: 0,
              createdAt: posTs(input.createdAt, posTs(prev?.createdAt, ts)),
              updatedAt: posTs(input.updatedAt, ts),
              lastUsedAt: posTs(input.lastUsedAt, ts)
            };
            record.estimatedBytes = estimateAiArtifactRecordBytes(record);
            if (record.estimatedBytes > currentMaxBytes) {
              throw new Error(`AI artifact ${cleanKey} (${record.estimatedBytes} B) exceeds maxBytes (${currentMaxBytes} B)`);
            }
            const nextLedger = applyLedgerDelta(
              prevLedger,
              { artifactBytes: record.estimatedBytes - (prev?.estimatedBytes ?? 0), artifactCount: prev ? 0 : 1 },
              ts
            );
            artStore.put(record);
            metaStore.put(nextLedger);
            return { estimatedBytes: record.estimatedBytes, needsEviction: nextLedger.totalBytes > currentMaxBytes };
          }, true);
          const rawLimit = explicitKeepVideosMap?.[family];
          const familyEvictedKeys =
            rawLimit !== undefined
              ? await evictFamilyArtifactsByKeepVideos(family, Math.max(1, Math.floor(Number(rawLimit) || AI_ARTIFACT_FAMILY_KEEP_VIDEOS[family])), bvid, ts)
              : [];
          const { evictedArtifactKeys } = writeRes.needsEviction
            ? await evictVideoCacheByCursors({ artifactKey: cleanKey }, ts)
            : { evictedArtifactKeys: [] };
          return {
            ok: true,
            evictedKeys: Array.from(new Set([...familyEvictedKeys, ...evictedArtifactKeys])),
            estimatedBytes: writeRes.estimatedBytes
          };
        } catch (err) {
          return { ok: false, evictedKeys: [], error: toErr(err) };
        }
      }),

    deleteAiArtifact: (key) =>
      enqueue(async () => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return false;
        const ts = now();
        return withTx([AI_ARTIFACTS_IDB_STORE, STORE_META_IDB_STORE], "readwrite", async (tx) => {
          const artStore = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
          const metaStore = tx.objectStore(STORE_META_IDB_STORE);
          const rec = normalizeAiArtifactRecord(await idbReq(artStore.get(cleanKey)));
          if (!rec) return false;
          artStore.delete(cleanKey);
          metaStore.put(applyLedgerDelta(await readLedgerInTx(metaStore, ts), { artifactBytes: -rec.estimatedBytes, artifactCount: -1 }, ts));
          return true;
        }, true);
      }),

    listAiArtifactsByFamilyBvid: (family, bvid, keyPrefix = "", site) =>
      enqueue(async () => {
        const prefix = String(keyPrefix || "");
        const parsedPrefix = prefix ? parseAiArtifactKey(prefix) : null;
        const effectiveSite =
          site !== undefined ? site : parsedPrefix?.cid === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(parsedPrefix?.bvid) ? "youtube" : undefined;
        const cleanBvid = resolveVideoStorageIdentity(bvid, undefined, effectiveSite).bvid;
        if (!isAiArtifactFamily(family) || !cleanBvid) return [];
        const records = await withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) =>
          collectCursor(tx.objectStore(AI_ARTIFACTS_IDB_STORE).index(AI_ARTIFACTS_INDEX_FAMILY_BVID), [family, cleanBvid], normalizeAiArtifactRecord)
        );
        const matched = prefix ? records.filter((rec) => rec.key.startsWith(prefix)) : records;
        if (matched.length > 0) await touchArtifactsLastUsed(matched.map((r) => r.key));
        return matched.map(cloneValue);
      }),

    listAiArtifactsByBvid: (bvid, site) =>
      enqueue(async () => {
        const cleanBvid = resolveVideoStorageIdentity(bvid, undefined, site).bvid;
        if (!cleanBvid) return [];
        return withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) =>
          collectCursor(tx.objectStore(AI_ARTIFACTS_IDB_STORE).index(AI_ARTIFACTS_INDEX_BVID), cleanBvid, normalizeAiArtifactRecord)
        );
      }),

    listAllAiArtifacts: () =>
      enqueue(() =>
        withTx(AI_ARTIFACTS_IDB_STORE, "readonly", (tx) =>
          collectCursor(tx.objectStore(AI_ARTIFACTS_IDB_STORE), undefined, normalizeAiArtifactRecord)
        )
      ),

    clearVideo: (bvid, cid, site) =>
      enqueue(async () => {
        const hasCid = cid !== undefined && cid !== null && String(cid).trim() !== "";
        const resolved = resolveVideoStorageIdentity(bvid, hasCid ? cid : "", site);
        if (!resolved.bvid) return { removedPageIds: [], removedArtifactKeys: [] };
        const cleanBvid = resolved.bvid;
        const cleanCid = hasCid ? resolved.cid : "";
        const ts = now();
        return withTx(
          [SUBTITLE_IDB_STORE, SUBTITLE_TRACKS_IDB_STORE, AI_ARTIFACTS_IDB_STORE, STORE_META_IDB_STORE],
          "readwrite",
          async (tx) => {
            const pagesStore = tx.objectStore(SUBTITLE_IDB_STORE);
            const tracksStore = tx.objectStore(SUBTITLE_TRACKS_IDB_STORE);
            const artStore = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
            const metaStore = tx.objectStore(STORE_META_IDB_STORE);
            const removedPageIds: string[] = [];
            const removedArtifactKeys: string[] = [];
            let freedSubBytes = 0;
            let freedArtBytes = 0;

            const headersToDelete = cleanCid
              ? [normalizePageHeader(await idbReq(pagesStore.get(buildSubtitlePageId(cleanBvid, cleanCid))))].filter((h): h is SubtitlePageHeaderRecord => Boolean(h))
              : await collectCursor(pagesStore.index(SUBTITLE_IDB_BVID_INDEX), cleanBvid, normalizePageHeader);
            for (const h of headersToDelete) {
              pagesStore.delete(h.id);
              await deletePageTracksInTx(tracksStore, h.id);
              removedPageIds.push(h.id);
              freedSubBytes += h.estimatedBytes;
            }
            const arts = await collectCursor(artStore.index(AI_ARTIFACTS_INDEX_BVID), cleanBvid, normalizeAiArtifactRecord);
            for (const rec of arts) {
              if (cleanCid && rec.cid !== cleanCid) continue;
              artStore.delete(rec.key);
              removedArtifactKeys.push(rec.key);
              freedArtBytes += rec.estimatedBytes;
            }
            if (removedPageIds.length > 0 || removedArtifactKeys.length > 0) {
              metaStore.put(
                applyLedgerDelta(
                  await readLedgerInTx(metaStore, ts),
                  {
                    subtitleBytes: -freedSubBytes,
                    artifactBytes: -freedArtBytes,
                    pageCount: -removedPageIds.length,
                    artifactCount: -removedArtifactKeys.length
                  },
                  ts
                )
              );
            }
            return { removedPageIds, removedArtifactKeys };
          },
          true
        );
      }),

    getChatImage: (id) =>
      enqueue(async () => {
        const cleanId = String(id || "").trim();
        if (!cleanId) return null;
        const stored = normalizeStoredChatImage(
          await withTx(CHAT_IMAGES_IDB_STORE, "readonly", (tx) => idbReq(tx.objectStore(CHAT_IMAGES_IDB_STORE).get(cleanId)))
        );
        return hydrateChatImageRecord(stored);
      }),

    getChatImagesMany: (ids) =>
      enqueue(async () => {
        const cleanIds = (Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim());
        if (cleanIds.length === 0) return [];
        const raw = await withTx(CHAT_IMAGES_IDB_STORE, "readonly", (tx) => {
          const s = tx.objectStore(CHAT_IMAGES_IDB_STORE);
          return Promise.all(cleanIds.map((id) => idbReq(s.get(id))));
        });
        return Promise.all(raw.map((item) => hydrateChatImageRecord(normalizeStoredChatImage(item))));
      }),

    putChatImage: (input) =>
      enqueue(async (): Promise<ChatImageWriteResult> => {
        const cleanId = String(input?.id || "").trim();
        const cleanConvId = String(input?.conversationId || "").trim();
        const rawBvid = String(input?.bvid ?? "").trim();
        const cleanBvid = rawBvid ? resolveVideoStorageIdentity(rawBvid, input?.cid, input?.site).bvid : "";
        let cleanMime = typeof input?.mime === "string" ? input.mime.trim() : "";
        let blob: Blob | null = null;
        if (isBlobLike(input?.blob) && input.blob.size > 0) {
          blob = input.blob;
          if (!cleanMime) cleanMime = blob.type || "application/octet-stream";
        } else {
          const rawStr = typeof input?.dataUrl === "string" && input.dataUrl ? input.dataUrl : typeof input?.data === "string" ? input.data : "";
          if (rawStr) {
            const parts = chatImageDataUrlToParts(rawStr, cleanMime);
            cleanMime = parts.mime || cleanMime;
            if (parts.data) blob = base64ToChatImageBlob(parts.data, cleanMime);
          }
        }
        if (!cleanId || !cleanConvId || !cleanMime || !blob || blob.size === 0) {
          return { ok: false, evictedIds: [], error: new Error("Invalid chat_image id, conversationId, mime or data") };
        }
        try {
          if (writeInterceptor) {
            await writeInterceptor({ op: "put-chat-image", pageId: "", bvid: cleanBvid, cid: "", trackKey: cleanId, key: cleanId, conversationId: cleanConvId });
          }
          const ts = now();
          await withTx(CHAT_IMAGES_IDB_STORE, "readwrite", async (tx) => {
            const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
            const existing = normalizeStoredChatImage(await idbReq(store.get(cleanId)));
            store.put({
              id: cleanId,
              conversationId: cleanConvId,
              bvid: cleanBvid,
              mime: cleanMime,
              blob,
              byteLength: blob.size,
              createdAt: posTs(input.createdAt, posTs(existing?.createdAt, ts)),
              updatedAt: posTs(input.updatedAt, ts)
            } satisfies StoredChatImageRecord);
          });
          return { ok: true, evictedIds: [], estimatedBytes: blob.size };
        } catch (err) {
          return { ok: false, evictedIds: [], error: toErr(err) };
        }
      }),

    deleteChatImages: (ids) =>
      enqueue(async () => {
        const uniqueIds = cleanIdList(ids);
        if (uniqueIds.length > 0) {
          await withTx(CHAT_IMAGES_IDB_STORE, "readwrite", async (tx) => {
            const s = tx.objectStore(CHAT_IMAGES_IDB_STORE);
            for (const id of uniqueIds) s.delete(id);
          });
        }
        return uniqueIds;
      }),

    deleteChatImagesByConversationIds: (conversationIds) =>
      enqueue(async () => {
        const uniqueConvIds = cleanIdList(conversationIds);
        if (uniqueConvIds.length === 0) return [];
        return withTx(CHAT_IMAGES_IDB_STORE, "readwrite", (tx) =>
          deleteChatImagesForConvIdsInTx(tx.objectStore(CHAT_IMAGES_IDB_STORE), uniqueConvIds)
        );
      }),

    pruneChatImages: (input) =>
      enqueue(() => {
        const validConvIds = new Set(cleanIdList(input?.validConversationIds));
        const keepIds = Array.isArray(input?.keepImageIds) ? new Set(cleanIdList(input.keepImageIds)) : null;
        return withTx(CHAT_IMAGES_IDB_STORE, "readwrite", async (tx) => {
          const removed: string[] = [];
          await walkCursor(tx.objectStore(CHAT_IMAGES_IDB_STORE), undefined, (c) => {
            const raw = c.value as { id?: unknown; conversationId?: unknown };
            const id = typeof raw?.id === "string" ? raw.id.trim() : "";
            const convId = typeof raw?.conversationId === "string" ? raw.conversationId.trim() : "";
            if (id && (!convId || !validConvIds.has(convId) || (keepIds !== null && !keepIds.has(id)))) {
              c.delete();
              removed.push(id);
            }
          });
          return removed;
        });
      }),

    clearAllChatImages: () =>
      enqueue(() =>
        withTx(CHAT_IMAGES_IDB_STORE, "readwrite", async (tx) => {
          const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
          const ids: string[] = [];
          await walkKeyCursor(store, undefined, (pk) => { ids.push(String(pk)); });
          store.clear();
          return ids;
        })
      ),

    listChatImagesByConversationId: (conversationId) =>
      enqueue(async () => {
        const cleanConvId = String(conversationId || "").trim();
        if (!cleanConvId) return [];
        const stored = await withTx(CHAT_IMAGES_IDB_STORE, "readonly", (tx) =>
          collectCursor(tx.objectStore(CHAT_IMAGES_IDB_STORE).index(CHAT_IMAGES_INDEX_CONVERSATION_ID), cleanConvId, normalizeStoredChatImage)
        );
        return (await Promise.all(stored.map(hydrateChatImageRecord))).filter((r): r is ChatImageRecord => r !== null);
      }),

    listAllChatImages: () =>
      enqueue(async () => {
        const stored = await withTx(CHAT_IMAGES_IDB_STORE, "readonly", (tx) =>
          collectCursor(tx.objectStore(CHAT_IMAGES_IDB_STORE), undefined, normalizeStoredChatImage)
        );
        return (await Promise.all(stored.map(hydrateChatImageRecord))).filter((r): r is ChatImageRecord => r !== null);
      }),

    getVideoCacheUsage: () => enqueue(() => computeVideoCacheUsage()),

    syncVideoCacheMaxBytes(maxBytes) {
      const n = Math.floor(Number(maxBytes));
      if (Number.isFinite(n) && n > 0) currentMaxBytes = n;
    },

    setVideoCacheMaxBytes: (maxBytes) =>
      enqueue(async () => {
        const n = Math.floor(Number(maxBytes));
        if (Number.isFinite(n) && n > 0) currentMaxBytes = n;
        const { evictedIds, evictedArtifactKeys } = await evictVideoCacheByCursors({}, now());
        return { evictedPageIds: evictedIds, evictedArtifactKeys, usage: await computeVideoCacheUsage() };
      }),

    getConversation: (id) =>
      enqueue(async () => {
        const cleanId = String(id || "").trim();
        if (!cleanId) return null;
        return withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE], "readonly", async (tx) => {
          const [metaRaw, bodyRaw] = await Promise.all([
            idbReq(tx.objectStore(CONVERSATION_META_IDB_STORE).get(cleanId)),
            idbReq(tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE).get(cleanId))
          ]);
          return metaRaw && typeof metaRaw === "object"
            ? assembleConversationRecord(metaRaw as ConversationMetaRecord, (bodyRaw as ConversationMessagesRecord | undefined) ?? null)
            : null;
        });
      }),

    listConversationMetas: () =>
      enqueue(() =>
        withTx(CONVERSATION_META_IDB_STORE, "readonly", async (tx) =>
          sortByUpdatedDesc(
            await collectCursor(tx.objectStore(CONVERSATION_META_IDB_STORE), undefined, (v) =>
              v && typeof v === "object" ? (v as ConversationMetaRecord) : null
            )
          )
        )
      ),

    listConversations: () =>
      enqueue(() =>
        withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE], "readonly", async (tx) => {
          const metas = sortByUpdatedDesc(
            await collectCursor(tx.objectStore(CONVERSATION_META_IDB_STORE), undefined, (v) =>
              v && typeof v === "object" ? (v as ConversationMetaRecord) : null
            )
          );
          const msgStore = tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE);
          const bodies = await Promise.all(metas.map((m) => idbReq(msgStore.get(m.id))));
          return metas.map((m, i) => assembleConversationRecord(m, (bodies[i] as ConversationMessagesRecord | undefined) ?? null));
        })
      ),

    countConversations: () =>
      enqueue(() =>
        withTx(CONVERSATION_META_IDB_STORE, "readonly", async (tx) =>
          Number(await idbReq(tx.objectStore(CONVERSATION_META_IDB_STORE).count())) || 0
        )
      ),

    putConversation: (record) =>
      enqueue(async () => {
        if (!record || typeof record !== "object") return;
        const split = splitConversationRecord(record);
        if (!split) return;
        await withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE], "readwrite", async (tx) => {
          tx.objectStore(CONVERSATION_META_IDB_STORE).put(split.meta);
          tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE).put(split.body);
        });
      }),

    putConversationsMany: (records) =>
      enqueue(async () => {
        if (!Array.isArray(records) || records.length === 0) return;
        await withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(CONVERSATION_META_IDB_STORE);
          const msgStore = tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE);
          for (const rec of records) {
            const split = splitConversationRecord(rec);
            if (!split) continue;
            metaStore.put(split.meta);
            msgStore.put(split.body);
          }
        });
      }),

    deleteConversations: (ids) =>
      enqueue(async () => {
        const cleanIds = cleanIdList(ids);
        if (cleanIds.length === 0) return [];
        await withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE, CHAT_IMAGES_IDB_STORE], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(CONVERSATION_META_IDB_STORE);
          const msgStore = tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE);
          for (const id of cleanIds) { metaStore.delete(id); msgStore.delete(id); }
          await deleteChatImagesForConvIdsInTx(tx.objectStore(CHAT_IMAGES_IDB_STORE), cleanIds);
        });
        return cleanIds;
      }),

    clearAllConversations: () =>
      enqueue(() =>
        withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE, CHAT_IMAGES_IDB_STORE], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(CONVERSATION_META_IDB_STORE);
          const removed: string[] = [];
          await walkKeyCursor(metaStore, undefined, (pk) => { removed.push(String(pk)); });
          metaStore.clear();
          tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE).clear();
          tx.objectStore(CHAT_IMAGES_IDB_STORE).clear();
          return removed;
        })
      ),

    pruneConversationsToLimit: (maxCount) =>
      enqueue(() => {
        const limit = Math.floor(Number(maxCount));
        return withTx([CONVERSATION_META_IDB_STORE, CONVERSATION_MESSAGES_IDB_STORE, CHAT_IMAGES_IDB_STORE], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(CONVERSATION_META_IDB_STORE);
          const metas = sortByUpdatedDesc(
            await collectCursor(metaStore, undefined, (v) => (v && typeof v === "object" ? (v as ConversationMetaRecord) : null))
          );
          if (!Number.isFinite(limit) || limit <= 0 || metas.length <= limit) return { removedIds: [], keptCount: metas.length };
          const removedIds = metas.slice(limit).map((m) => m.id);
          const msgStore = tx.objectStore(CONVERSATION_MESSAGES_IDB_STORE);
          for (const id of removedIds) { metaStore.delete(id); msgStore.delete(id); }
          await deleteChatImagesForConvIdsInTx(tx.objectStore(CHAT_IMAGES_IDB_STORE), removedIds);
          return { removedIds, keptCount: metas.length - removedIds.length };
        });
      }),

    getNoteHighlights: (videoKey) =>
      enqueue(async () => {
        const key = String(videoKey || "").trim();
        if (!key) return null;
        return normalizeNoteHighlightBucket(
          await withTx(NOTE_HIGHLIGHTS_IDB_STORE, "readonly", (tx) => idbReq(tx.objectStore(NOTE_HIGHLIGHTS_IDB_STORE).get(key)))
        );
      }),

    putNoteHighlights: (record) =>
      enqueue(async () => {
        const norm = normalizeNoteHighlightBucket(record);
        if (!norm) return;
        await withTx(NOTE_HIGHLIGHTS_IDB_STORE, "readwrite", async (tx) => {
          tx.objectStore(NOTE_HIGHLIGHTS_IDB_STORE).put(norm);
        });
      }),

    putNoteHighlightsMany: (records, markMetaKey, markMetaValue) =>
      enqueue(async () => {
        const list = (Array.isArray(records) ? records : [])
          .map(normalizeNoteHighlightBucket)
          .filter((r): r is NoteHighlightBucketRecord => r !== null);
        const stores = markMetaKey ? [NOTE_HIGHLIGHTS_IDB_STORE, STORE_META_IDB_STORE] : [NOTE_HIGHLIGHTS_IDB_STORE];
        await withTx(stores, "readwrite", async (tx) => {
          const s = tx.objectStore(NOTE_HIGHLIGHTS_IDB_STORE);
          for (const rec of list) s.put(rec);
          if (markMetaKey) tx.objectStore(STORE_META_IDB_STORE).put({ key: markMetaKey, value: cloneValue(markMetaValue ?? true) });
        });
      }),

    deleteNoteHighlights: (videoKey) =>
      enqueue(async () => {
        const key = String(videoKey || "").trim();
        if (!key) return false;
        return withTx(NOTE_HIGHLIGHTS_IDB_STORE, "readwrite", async (tx) => {
          const s = tx.objectStore(NOTE_HIGHLIGHTS_IDB_STORE);
          const existed = Boolean(await idbReq(s.get(key)));
          if (existed) s.delete(key);
          return existed;
        });
      }),

    listNoteHighlights: () =>
      enqueue(() =>
        withTx(NOTE_HIGHLIGHTS_IDB_STORE, "readonly", async (tx) =>
          (await collectCursor(tx.objectStore(NOTE_HIGHLIGHTS_IDB_STORE), undefined, normalizeNoteHighlightBucket)).sort(
            (a, b) => b.updatedAt - a.updatedAt
          )
        )
      ),

    getStoreMeta: <T = unknown>(key: string) =>
      enqueue(async (): Promise<T | null> => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return null;
        const raw = await withTx(STORE_META_IDB_STORE, "readonly", (tx) => idbReq(tx.objectStore(STORE_META_IDB_STORE).get(cleanKey)));
        if (!raw || typeof raw !== "object") return null;
        const obj = raw as StoreMetaRecord;
        return ("value" in obj ? cloneValue(obj.value) : cloneValue(obj)) as T;
      }),

    putStoreMeta: (key, value) =>
      enqueue(async () => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return;
        await withTx(STORE_META_IDB_STORE, "readwrite", async (tx) => {
          tx.objectStore(STORE_META_IDB_STORE).put({ key: cleanKey, value: cloneValue(value) });
        });
      }),

    deleteStoreMeta: (key) =>
      enqueue(async () => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) return;
        await withTx(STORE_META_IDB_STORE, "readwrite", async (tx) => {
          tx.objectStore(STORE_META_IDB_STORE).delete(cleanKey);
        });
      }),

    clearAll: () => {
      writeInterceptor = null;
      currentMaxBytes = initialMaxBytes;
      return enqueue(async () => {
        const db = await openDb();
        const storesToClear = IDB_STORE_SCHEMAS.map(([name]) => name).filter((name) => db.objectStoreNames.contains(name));
        if (storesToClear.length === 0) return;
        const tx = openTx(db, storesToClear, "readwrite");
        for (const s of storesToClear) tx.objectStore(s).clear();
        if (db.objectStoreNames.contains(STORE_META_IDB_STORE)) {
          tx.objectStore(STORE_META_IDB_STORE).put(createEmptyLedger(now()));
        }
        await idbTxDone(tx);
      });
    },

    setWriteInterceptorForTests(interceptor) {
      writeInterceptor = interceptor;
    }
  };
}

export const defaultSubtitleIdbStore = createSubtitleIdbStore({ useSharedMemoryBacking: true });

export async function readAiArtifactInBackground<T = unknown>(
  key: string,
  store: SubtitleIdbStore = defaultSubtitleIdbStore
): Promise<T | null> {
  return store.readAiArtifactPayloadRaw<T>(key);
}
