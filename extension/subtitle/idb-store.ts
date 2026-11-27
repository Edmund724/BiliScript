import type { SubtitleBodyItem, SubtitleWord } from "../shared/video-dto.js";
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
export const SUBTITLE_IDB_VERSION = 3;

export const SUBTITLE_IDB_STORE = "subtitle_pages";
export const SUBTITLE_IDB_LAST_USED_INDEX = "by_lastUsed";
export const SUBTITLE_IDB_BVID_INDEX = "by_bvid";

export const AI_ARTIFACTS_IDB_STORE = "ai_artifacts";
export const AI_ARTIFACTS_INDEX_FAMILY_BVID = "by_family_bvid";
export const AI_ARTIFACTS_INDEX_FAMILY_LAST_USED = "by_family_lastUsedAt";
export const AI_ARTIFACTS_INDEX_BVID = "by_bvid";
export const AI_ARTIFACTS_INDEX_LAST_USED = "by_lastUsedAt";

export const CHAT_IMAGES_IDB_STORE = "chat_images";
export const CHAT_IMAGES_INDEX_CONVERSATION_ID = "by_conversationId";
export const CHAT_IMAGES_INDEX_BVID = "by_bvid";
export const CHAT_IMAGES_INDEX_LAST_USED = "by_lastUsedAt";

export const CONVERSATIONS_IDB_STORE = "conversations";
export const CONVERSATIONS_INDEX_UPDATED_AT = "by_updatedAt";

export const DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES = 100;
export const DEFAULT_SUBTITLE_CACHE_MAX_BYTES = 150 * 1024 * 1024;
export const DEFAULT_CHAT_IMAGES_MAX_BYTES = 80 * 1024 * 1024;

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

export function inferStorageSite(
  bvid: unknown,
  cid?: unknown,
  site?: unknown
): SiteId {
  if (site !== undefined && site !== null && String(site).trim() !== "") {
    return normalizeSiteId(site);
  }
  const cleanCid = String(cid ?? "").trim();
  const cleanBvid = String(bvid ?? "").trim();
  if (cleanCid === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(cleanBvid)) {
    return "youtube";
  }
  return "bilibili";
}

export function resolveVideoStorageIdentity(
  bvid: unknown,
  cid?: unknown,
  site?: unknown
): VideoStorageKey {
  const cleanBvid = String(bvid ?? "").trim();
  const cleanCid = String(cid ?? "").trim();
  return resolveVideoStorageKey(inferStorageSite(cleanBvid, cleanCid, site), cleanBvid, cleanCid);
}

export function parseAiArtifactKey(
  key: unknown
): { family: AiArtifactFamily; bvid: string; cid: string } | null {
  const raw = String(key ?? "");
  if (!raw) {
    return null;
  }
  const family = AI_ARTIFACT_FAMILIES_BY_LENGTH.find((prefix) => raw.startsWith(prefix));
  if (!family) {
    return null;
  }
  const rest = raw.slice(family.length);
  if (!rest) {
    return null;
  }
  const firstSep = rest.indexOf("_");
  if (firstSep === -1) {
    return {
      family,
      bvid: rest,
      cid: isEncodedYoutubeStorageBvid(rest) ? YOUTUBE_UNIT_CID : ""
    };
  }
  const bvid = rest.slice(0, firstSep);
  if (!bvid) {
    return null;
  }
  const secondSep = rest.indexOf("_", firstSep + 1);
  const cid = secondSep === -1 ? rest.slice(firstSep + 1) : rest.slice(firstSep + 1, secondSep);
  return {
    family,
    bvid,
    cid: cid || (isEncodedYoutubeStorageBvid(bvid) ? YOUTUBE_UNIT_CID : "")
  };
}

export type SubtitleTrackStorageKind = "manual-cc" | "bili-ai" | "youtube-auto" | "asr";

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

export interface ChatImageRecord {
  id: string;
  conversationId: string;
  bvid: string;
  mime: string;
  data: string;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface PutChatImageInput {
  id: string;
  conversationId: string;
  bvid?: string;
  cid?: string;
  site?: SiteId;
  mime: string;
  data: string;
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

export type SubtitleStoreWriteInterceptor = (
  ctx: SubtitleStoreWriteContext
) => Promise<void> | void;

export interface VideoCacheUsage {
  totalBytes: number;
  subtitleBytes: number;
  artifactBytes: number;
  subtitlePageCount: number;
  artifactCount: number;
  maxBytes: number;
}

export interface VideoCacheLimitUpdateResult {
  evictedPageIds: string[];
  evictedArtifactKeys: string[];
  usage: VideoCacheUsage;
}

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

export interface SubtitleIdbStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
  maxEntries?: number;
  maxBytes?: number;
  maxChatImageBytes?: number;
  aiArtifactKeepVideos?: Partial<Record<AiArtifactFamily, number>>;
  now?: () => number;
  useSharedMemoryBacking?: boolean;
}

export interface SubtitleIdbStore {
  getPageRecord(bvid: string, cid: string, site?: SiteId): Promise<SubtitlePageRecord | null>;
  listPageRecords(): Promise<SubtitlePageRecord[]>;
  getRawTrack(bvid: string, cid: string, trackKey: string, site?: SiteId): Promise<SubtitleBodyItem[] | null>;
  putRawTrack(input: PutRawTrackInput): Promise<SubtitleStoreWriteResult>;
  getSegmentedTrack(
    bvid: string,
    cid: string,
    trackKey: string,
    segmentationSig: string,
    site?: SiteId
  ): Promise<SubtitleBodyItem[] | null>;
  putSegmentedTrack(input: PutSegmentedTrackInput): Promise<SubtitleStoreWriteResult>;
  getTranslatedTrack(
    bvid: string,
    cid: string,
    sourceTrackKey: string,
    targetLang: string,
    translationSig?: string,
    site?: SiteId
  ): Promise<SubtitleBodyItem[] | null>;
  upsertTranslatedTrack(input: UpsertTranslatedTrackInput): Promise<SubtitleStoreWriteResult>;
  deleteTrackEntry(input: DeleteTrackEntryInput): Promise<boolean>;
  pruneAsrVariants(args: { bvid: string; cid: string; keepTrackKey?: string; site?: SiteId }): Promise<string[]>;
  clearTranslatedTracksForPage(args: {
    bvid: string;
    cid: string;
    sourceTrackKey?: string;
    site?: SiteId;
  }): Promise<string[]>;

  getAiArtifact<TPayload = unknown>(key: string): Promise<AiArtifactRecord<TPayload> | null>;
  getAiArtifactsMany<TPayload = unknown>(
    keys: string[]
  ): Promise<Array<AiArtifactRecord<TPayload> | null>>;
  putAiArtifact<TPayload = unknown>(input: PutAiArtifactInput<TPayload>): Promise<AiArtifactWriteResult>;
  deleteAiArtifact(key: string): Promise<boolean>;
  listAiArtifactsByFamilyBvid(
    family: AiArtifactFamily,
    bvid: string,
    keyPrefix?: string,
    site?: SiteId
  ): Promise<AiArtifactRecord[]>;
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
  listConversations(): Promise<PersistedConversationRecord[]>;
  countConversations(): Promise<number>;
  putConversation(record: PersistedConversationRecord): Promise<void>;
  putConversationsMany(records: PersistedConversationRecord[]): Promise<void>;
  deleteConversations(ids: string[]): Promise<string[]>;
  clearAllConversations(): Promise<string[]>;
  pruneConversationsToLimit(maxCount: number): Promise<PruneConversationsResult>;

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
  if (!resolved.bvid || !resolved.cid) {
    return "";
  }
  return `${resolved.bvid}:${resolved.cid}`;
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
  if (!Array.isArray(items)) {
    return [];
  }
  const result: SubtitleBodyItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const candidate = raw as { from?: unknown; to?: unknown; content?: unknown; words?: unknown };
    const content = String(candidate.content ?? "").trim();
    if (!content) {
      continue;
    }
    const from = Number(candidate.from) || 0;
    const to = Number(candidate.to) || from;
    const item: SubtitleBodyItem = {
      from: Number.isFinite(from) ? from : 0,
      to: Number.isFinite(to) ? to : 0,
      content
    };
    if (Array.isArray(candidate.words) && candidate.words.length > 0) {
      const sanitizedWords: SubtitleWord[] = [];
      for (const rawWord of candidate.words) {
        if (!rawWord || typeof rawWord !== "object") {
          continue;
        }
        const w = rawWord as {
          word?: unknown;
          text?: unknown;
          start?: unknown;
          end?: unknown;
          startMs?: unknown;
          endMs?: unknown;
        };
        const out: SubtitleWord = {};
        if (typeof w.word === "string") out.word = w.word;
        if (typeof w.text === "string") out.text = w.text;
        if (typeof w.start === "number" && Number.isFinite(w.start)) out.start = w.start;
        if (typeof w.end === "number" && Number.isFinite(w.end)) out.end = w.end;
        if (typeof w.startMs === "number" && Number.isFinite(w.startMs)) out.startMs = w.startMs;
        if (typeof w.endMs === "number" && Number.isFinite(w.endMs)) out.endMs = w.endMs;
        sanitizedWords.push(out);
      }
      if (sanitizedWords.length > 0) {
        item.words = sanitizedWords;
      }
    }
    result.push(item);
  }
  return result;
}

export function sanitizeTranslatedItems(items: readonly unknown[]): SubtitleBodyItem[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const result: SubtitleBodyItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const candidate = raw as { from?: unknown; to?: unknown; content?: unknown };
    const from = Number(candidate.from);
    const to = Number(candidate.to);
    const content = String(candidate.content ?? "").trim();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !content) {
      continue;
    }
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
  if (cleanIncoming.length === 0 && !replaceRange) {
    return sanitizeTranslatedItems(existing);
  }
  const base = sanitizeTranslatedItems(existing).filter((item) => {
    if (!replaceRange) {
      return true;
    }
    return item.from < replaceRange.from || item.from >= replaceRange.to;
  });

  const bySpan = new Map<string, SubtitleBodyItem>();
  for (const item of base) {
    bySpan.set(`${item.from.toFixed(3)}:${item.to.toFixed(3)}`, item);
  }
  for (const item of cleanIncoming) {
    bySpan.set(`${item.from.toFixed(3)}:${item.to.toFixed(3)}`, item);
  }
  return Array.from(bySpan.values()).sort((a, b) => a.from - b.from || a.to - b.to);
}

function estimateJsonBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  if (textEncoder) {
    return textEncoder.encode(json).byteLength;
  }
  return json.length * 2;
}

function estimateRecordBytes(record: object): number {
  return estimateJsonBytes({ ...record, estimatedBytes: 0 });
}

export const estimateSubtitleRecordBytes = (record: SubtitlePageRecord): number => estimateRecordBytes(record);
export const estimateAiArtifactRecordBytes = (record: AiArtifactRecord): number => estimateRecordBytes(record);
export const estimateChatImageRecordBytes = (record: ChatImageRecord): number => estimateRecordBytes(record);

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecordEmpty(record: SubtitlePageRecord): boolean {
  return (
    Object.keys(record.rawTracks).length === 0 &&
    Object.keys(record.segmentedTracks).length === 0 &&
    Object.keys(record.translatedTracks).length === 0
  );
}

function createEmptyPageRecord(bvid: string, cid: string, ts: number): SubtitlePageRecord {
  const id = buildSubtitlePageId(bvid, cid);
  const record: SubtitlePageRecord = {
    id,
    bvid: String(bvid).trim(),
    cid: String(cid).trim(),
    rawTracks: {},
    segmentedTracks: {},
    translatedTracks: {},
    estimatedBytes: 0,
    createdAt: ts,
    updatedAt: ts,
    lastUsed: ts
  };
  record.estimatedBytes = estimateSubtitleRecordBytes(record);
  return record;
}

function normalizePageRecord(raw: unknown): SubtitlePageRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<SubtitlePageRecord>;
  const id = String(
    candidate.id || buildSubtitlePageId(String(candidate.bvid || ""), String(candidate.cid || ""))
  ).trim();
  const bvid = String(candidate.bvid || "").trim();
  const cid = String(candidate.cid || "").trim();
  if (!id || !bvid || !cid) {
    return null;
  }
  const record: SubtitlePageRecord = {
    id,
    bvid,
    cid,
    rawTracks:
      candidate.rawTracks && typeof candidate.rawTracks === "object" && !Array.isArray(candidate.rawTracks)
        ? candidate.rawTracks
        : {},
    segmentedTracks:
      candidate.segmentedTracks &&
      typeof candidate.segmentedTracks === "object" &&
      !Array.isArray(candidate.segmentedTracks)
        ? candidate.segmentedTracks
        : {},
    translatedTracks:
      candidate.translatedTracks &&
      typeof candidate.translatedTracks === "object" &&
      !Array.isArray(candidate.translatedTracks)
        ? candidate.translatedTracks
        : {},
    estimatedBytes: Number(candidate.estimatedBytes) || 0,
    createdAt: Number(candidate.createdAt) || 0,
    updatedAt: Number(candidate.updatedAt) || 0,
    lastUsed: Number(candidate.lastUsed) || 0
  };
  if (record.estimatedBytes <= 0) {
    record.estimatedBytes = estimateSubtitleRecordBytes(record);
  }
  return record;
}

function normalizeAiArtifactRecord(raw: unknown): AiArtifactRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<AiArtifactRecord>;
  const key = String(candidate.key || "").trim();
  if (!key || candidate.payload === undefined || candidate.payload === null) {
    return null;
  }
  const parsed = parseAiArtifactKey(key);
  const family = isAiArtifactFamily(candidate.family) ? candidate.family : parsed?.family;
  const bvid = String(candidate.bvid ?? parsed?.bvid ?? "").trim();
  const cid = String(candidate.cid ?? parsed?.cid ?? "").trim();
  if (!family || !bvid) {
    return null;
  }
  const createdAt = Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : createdAt;
  const lastUsedAt = Number.isFinite(Number(candidate.lastUsedAt)) ? Number(candidate.lastUsedAt) : updatedAt;
  const record: AiArtifactRecord = {
    key,
    family,
    bvid,
    cid,
    payload: candidate.payload,
    estimatedBytes: Number(candidate.estimatedBytes) || 0,
    createdAt,
    updatedAt,
    lastUsedAt
  };
  if (record.estimatedBytes <= 0) {
    record.estimatedBytes = estimateAiArtifactRecordBytes(record);
  }
  return record;
}

function normalizeChatImageRecord(raw: unknown): ChatImageRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<ChatImageRecord>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const conversationId = typeof candidate.conversationId === "string" ? candidate.conversationId.trim() : "";
  const mime = typeof candidate.mime === "string" ? candidate.mime.trim() : "";
  const data = typeof candidate.data === "string" ? candidate.data : "";
  if (!id || !conversationId || !mime || !data) {
    return null;
  }
  const bvid = typeof candidate.bvid === "string" ? candidate.bvid.trim() : "";
  const createdAt = Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : 0;
  const updatedAt = Number.isFinite(Number(candidate.updatedAt)) ? Number(candidate.updatedAt) : createdAt;
  const lastUsedAt = Number.isFinite(Number(candidate.lastUsedAt)) ? Number(candidate.lastUsedAt) : updatedAt;
  const record: ChatImageRecord = {
    id,
    conversationId,
    bvid,
    mime,
    data,
    estimatedBytes: Number(candidate.estimatedBytes) || 0,
    createdAt,
    updatedAt,
    lastUsedAt
  };
  if (record.estimatedBytes <= 0) {
    record.estimatedBytes = estimateChatImageRecordBytes(record);
  }
  return record;
}

interface RawChatImageRef {
  id: string;
  conversationId: string;
  estimatedBytes: number;
  createdAt: number;
  lastUsedAt: number;
}

function extractRawChatImageRef(raw: unknown): RawChatImageRef | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<ChatImageRecord>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return null;
  }
  const conversationId = typeof candidate.conversationId === "string" ? candidate.conversationId.trim() : "";
  const estimatedBytes = Number(candidate.estimatedBytes) || 0;
  const createdAt = Number.isFinite(Number(candidate.createdAt)) ? Number(candidate.createdAt) : 0;
  const lastUsedAt = Number.isFinite(Number(candidate.lastUsedAt)) ? Number(candidate.lastUsedAt) : createdAt;
  return { id, conversationId, estimatedBytes, createdAt, lastUsedAt };
}

interface StorageBackend {
  getAllPages(): Promise<SubtitlePageRecord[]>;
  getPage(id: string): Promise<SubtitlePageRecord | null>;
  getPagesByBvid(bvid: string): Promise<SubtitlePageRecord[]>;
  putPage(record: SubtitlePageRecord): Promise<void>;
  deletePages(ids: string[]): Promise<void>;

  getArtifact(key: string): Promise<AiArtifactRecord | null>;
  getArtifactsMany(keys: string[]): Promise<Array<AiArtifactRecord | null>>;
  putArtifact(record: AiArtifactRecord): Promise<void>;
  putArtifactsMany(records: AiArtifactRecord[]): Promise<void>;
  deleteArtifacts(keys: string[]): Promise<void>;
  getArtifactsByFamily(family: AiArtifactFamily): Promise<AiArtifactRecord[]>;
  getArtifactsByFamilyBvid(family: AiArtifactFamily, bvid: string): Promise<AiArtifactRecord[]>;
  getArtifactsByBvid(bvid: string): Promise<AiArtifactRecord[]>;
  getAllArtifacts(): Promise<AiArtifactRecord[]>;

  getChatImage(id: string): Promise<ChatImageRecord | null>;
  getChatImagesMany(ids: string[]): Promise<Array<ChatImageRecord | null>>;
  putChatImage(record: ChatImageRecord): Promise<void>;
  putChatImagesMany(records: ChatImageRecord[]): Promise<void>;
  deleteChatImages(ids: string[]): Promise<void>;
  getChatImagesByConversationId(conversationId: string): Promise<ChatImageRecord[]>;
  getRawChatImageIdsByConversationId(conversationId: string): Promise<string[]>;
  getAllChatImages(): Promise<ChatImageRecord[]>;
  getAllRawChatImageRefs(): Promise<RawChatImageRef[]>;
  clearChatImages(): Promise<void>;

  getConversation(id: string): Promise<PersistedConversationRecord | null>;
  getAllConversations(): Promise<PersistedConversationRecord[]>;
  countConversations(): Promise<number>;
  putConversation(record: PersistedConversationRecord): Promise<void>;
  putConversationsMany(records: PersistedConversationRecord[]): Promise<void>;
  deleteConversations(ids: string[]): Promise<void>;
  clearConversations(): Promise<void>;

  clearAll(): Promise<void>;
}

interface SharedMemoryBacking {
  pages: Map<string, SubtitlePageRecord>;
  artifacts: Map<string, AiArtifactRecord>;
  chatImages: Map<string, ChatImageRecord>;
  conversations: Map<string, PersistedConversationRecord>;
}

type SubtitleIdbMemoryGlobal = typeof globalThis & {
  [DEFAULT_MEMORY_BACKING_SYMBOL]?: SharedMemoryBacking;
};

function getSharedMemoryBacking(): SharedMemoryBacking {
  const globals = globalThis as SubtitleIdbMemoryGlobal;
  let backing = globals[DEFAULT_MEMORY_BACKING_SYMBOL];
  if (!backing) {
    backing = {
      pages: new Map<string, SubtitlePageRecord>(),
      artifacts: new Map<string, AiArtifactRecord>(),
      chatImages: new Map<string, ChatImageRecord>(),
      conversations: new Map<string, PersistedConversationRecord>()
    };
    globals[DEFAULT_MEMORY_BACKING_SYMBOL] = backing;
  } else {
    if (!backing.chatImages) {
      backing.chatImages = new Map<string, ChatImageRecord>();
    }
    if (!backing.conversations) {
      backing.conversations = new Map<string, PersistedConversationRecord>();
    }
  }
  return backing;
}

function normalizePersistedConversationRecord(raw: unknown): PersistedConversationRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<PersistedConversationRecord>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return null;
  }
  const updatedAt = Number.isFinite(Number(candidate.updatedAt))
    ? Number(candidate.updatedAt)
    : Number.isFinite(Number(candidate.createdAt))
      ? Number(candidate.createdAt)
      : 0;
  return {
    ...(cloneValue(raw) as Record<string, unknown>),
    id,
    updatedAt
  };
}

function normalizePersistedConversationList(rawAll: unknown): PersistedConversationRecord[] {
  const list: PersistedConversationRecord[] = [];
  for (const raw of Array.isArray(rawAll) ? rawAll : []) {
    const normalized = normalizePersistedConversationRecord(raw);
    if (normalized) {
      list.push(normalized);
    }
  }
  list.sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    const bCreated = Number(b.createdAt) || 0;
    const aCreated = Number(a.createdAt) || 0;
    if (bCreated !== aCreated) return bCreated - aCreated;
    return a.id.localeCompare(b.id);
  });
  return list;
}

function createMemoryBackend(shared = false): StorageBackend {
  const b: SharedMemoryBacking = shared
    ? getSharedMemoryBacking()
    : { pages: new Map(), artifacts: new Map(), chatImages: new Map(), conversations: new Map() };
  const mapGet = <T>(m: Map<string, T>, k: string): T | null => {
    const hit = m.get(k);
    return hit ? cloneValue(hit) : null;
  };
  const mapFilter = <T>(m: Map<string, T>, fn: (v: T) => boolean): T[] => {
    const out: T[] = [];
    for (const v of m.values()) if (fn(v)) out.push(cloneValue(v));
    return out;
  };
  const mapDelete = <T>(m: Map<string, T>, keys: readonly string[]): void => {
    for (const k of keys) m.delete(k);
  };
  const mapPutMany = <T>(m: Map<string, T>, items: readonly T[], keyOf: (v: T) => string): void => {
    for (const v of items) m.set(keyOf(v), cloneValue(v));
  };

  return {
    getAllPages: async () => Array.from(b.pages.values(), cloneValue),
    getPage: async (id) => mapGet(b.pages, id),
    getPagesByBvid: async (bvid) => mapFilter(b.pages, (r) => r.bvid === bvid),
    putPage: async (r) => { b.pages.set(r.id, cloneValue(r)); },
    deletePages: async (ids) => mapDelete(b.pages, ids),

    getArtifact: async (key) => mapGet(b.artifacts, key),
    getArtifactsMany: async (keys) => keys.map((k) => mapGet(b.artifacts, k)),
    putArtifact: async (r) => { b.artifacts.set(r.key, cloneValue(r)); },
    putArtifactsMany: async (rs) => mapPutMany(b.artifacts, rs, (r) => r.key),
    deleteArtifacts: async (keys) => mapDelete(b.artifacts, keys),
    getArtifactsByFamily: async (family) => mapFilter(b.artifacts, (r) => r.family === family),
    getArtifactsByFamilyBvid: async (family, bvid) => mapFilter(b.artifacts, (r) => r.family === family && r.bvid === bvid),
    getArtifactsByBvid: async (bvid) => mapFilter(b.artifacts, (r) => r.bvid === bvid),
    getAllArtifacts: async () => Array.from(b.artifacts.values(), cloneValue),

    getChatImage: async (id) => {
      const hit = b.chatImages.get(id);
      return hit ? normalizeChatImageRecord(cloneValue(hit)) : null;
    },
    getChatImagesMany: async (ids) =>
      ids.map((id) => {
        const hit = b.chatImages.get(id);
        return hit ? normalizeChatImageRecord(cloneValue(hit)) : null;
      }),
    putChatImage: async (r) => { b.chatImages.set(r.id, cloneValue(r)); },
    putChatImagesMany: async (rs) => mapPutMany(b.chatImages, rs, (r) => r.id),
    deleteChatImages: async (ids) => mapDelete(b.chatImages, ids),
    getChatImagesByConversationId: async (cid) =>
      normalizeChatImageList(mapFilter(b.chatImages, (r) => r.conversationId === cid)),
    getRawChatImageIdsByConversationId: async (cid) =>
      Array.from(b.chatImages.values()).filter((r) => r.conversationId === cid && r.id).map((r) => r.id),
    getAllChatImages: async () => normalizeChatImageList(Array.from(b.chatImages.values(), cloneValue)),
    getAllRawChatImageRefs: async () =>
      Array.from(b.chatImages.values()).map(extractRawChatImageRef).filter((r): r is RawChatImageRef => Boolean(r)),
    clearChatImages: async () => { b.chatImages.clear(); },

    getConversation: async (id) => {
      const hit = b.conversations.get(id);
      return hit ? normalizePersistedConversationRecord(cloneValue(hit)) : null;
    },
    getAllConversations: async () => normalizePersistedConversationList(Array.from(b.conversations.values())),
    countConversations: async () => b.conversations.size,
    putConversation: async (r) => { b.conversations.set(r.id, cloneValue(r)); },
    putConversationsMany: async (rs) => mapPutMany(b.conversations, rs, (r) => r.id),
    deleteConversations: async (ids) => mapDelete(b.conversations, ids),
    clearConversations: async () => { b.conversations.clear(); },

    clearAll: async () => {
      b.pages.clear();
      b.artifacts.clear();
      b.chatImages.clear();
      b.conversations.clear();
    }
  };
}

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransactionToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function mapDefined<T>(rawAll: unknown, normalize: (raw: unknown) => T | null): T[] {
  const list: T[] = [];
  for (const raw of Array.isArray(rawAll) ? rawAll : []) {
    const normalized = normalize(raw);
    if (normalized) list.push(normalized);
  }
  return list;
}

const normalizePageList = (rawAll: unknown): SubtitlePageRecord[] => mapDefined(rawAll, normalizePageRecord);
const normalizeArtifactList = (rawAll: unknown): AiArtifactRecord[] => mapDefined(rawAll, normalizeAiArtifactRecord);
const normalizeChatImageList = (rawAll: unknown): ChatImageRecord[] => mapDefined(rawAll, normalizeChatImageRecord);

const IDB_STORE_SCHEMAS: ReadonlyArray<readonly [string, string, ReadonlyArray<readonly [string, string | string[]]>]> = [
  [SUBTITLE_IDB_STORE, "id", [[SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed"], [SUBTITLE_IDB_BVID_INDEX, "bvid"]]],
  [AI_ARTIFACTS_IDB_STORE, "key", [[AI_ARTIFACTS_INDEX_FAMILY_BVID, ["family", "bvid"]], [AI_ARTIFACTS_INDEX_FAMILY_LAST_USED, ["family", "lastUsedAt"]], [AI_ARTIFACTS_INDEX_BVID, "bvid"], [AI_ARTIFACTS_INDEX_LAST_USED, "lastUsedAt"]]],
  [CHAT_IMAGES_IDB_STORE, "id", [[CHAT_IMAGES_INDEX_CONVERSATION_ID, "conversationId"], [CHAT_IMAGES_INDEX_BVID, "bvid"], [CHAT_IMAGES_INDEX_LAST_USED, "lastUsedAt"]]],
  [CONVERSATIONS_IDB_STORE, "id", [[CONVERSATIONS_INDEX_UPDATED_AT, "updatedAt"]]]
];

function createIdbBackend(idbFactory: IDBFactory, dbName: string): StorageBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idbFactory.open(dbName, SUBTITLE_IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = req.transaction!;
        for (const [name, keyPath, indexes] of IDB_STORE_SCHEMAS) {
          const store = db.objectStoreNames.contains(name)
            ? tx.objectStore(name)
            : db.createObjectStore(name, { keyPath });
          for (const [idxName, idxPath] of indexes) {
            if (!store.indexNames.contains(idxName)) store.createIndex(idxName, idxPath, { unique: false });
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("Failed to open IndexedDB"));
      };
    });
    return dbPromise;
  }

  async function withRead<T>(
    storeName: string,
    fallback: T,
    run: (store: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    const db = await openDb();
    if (!db.objectStoreNames.contains(storeName)) return fallback;
    const tx = db.transaction(storeName, "readonly");
    const result = await run(tx.objectStore(storeName));
    await idbTransactionToPromise(tx);
    return result;
  }

  async function withWrite(
    storeName: string,
    run: (store: IDBObjectStore) => void,
    optional = false
  ): Promise<void> {
    const db = await openDb();
    if (optional && !db.objectStoreNames.contains(storeName)) return;
    const tx = db.transaction(storeName, "readwrite");
    run(tx.objectStore(storeName));
    await idbTransactionToPromise(tx);
  }

  async function getAllByIndex(
    storeName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange,
    predicate: (item: unknown) => boolean
  ): Promise<unknown[]> {
    return withRead<unknown[]>(storeName, [], async (store) =>
      typeof store.index === "function" && store.indexNames.contains(indexName)
        ? ((await idbRequestToPromise(store.index(indexName).getAll(query))) as unknown[])
        : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(predicate)
    );
  }

  function putOne(storeName: string, record: unknown): Promise<void> {
    return withWrite(storeName, (store) => {
      store.put(cloneValue(record));
    });
  }

  function putMany(storeName: string, records: readonly unknown[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    return withWrite(storeName, (store) => {
      for (const record of records) store.put(cloneValue(record));
    });
  }

  function deleteKeys(storeName: string, keys: readonly string[], optional = false): Promise<void> {
    if (keys.length === 0) return Promise.resolve();
    return withWrite(
      storeName,
      (store) => {
        for (const key of keys) store.delete(key);
      },
      optional
    );
  }

  return {
    async getAllPages() {
      return normalizePageList(await withRead(SUBTITLE_IDB_STORE, [], (s) => idbRequestToPromise(s.getAll())));
    },
    async getPage(id) {
      return normalizePageRecord(await withRead(SUBTITLE_IDB_STORE, null, (s) => idbRequestToPromise(s.get(id))));
    },
    async getPagesByBvid(bvid) {
      return normalizePageList(
        await getAllByIndex(
          SUBTITLE_IDB_STORE,
          SUBTITLE_IDB_BVID_INDEX,
          bvid,
          (item) => (item as { bvid?: unknown } | null)?.bvid === bvid
        )
      );
    },
    putPage: (record) => putOne(SUBTITLE_IDB_STORE, record),
    deletePages: (ids) => deleteKeys(SUBTITLE_IDB_STORE, ids),

    async getArtifact(key) {
      return normalizeAiArtifactRecord(
        await withRead(AI_ARTIFACTS_IDB_STORE, null, (s) => idbRequestToPromise(s.get(key)))
      );
    },
    async getArtifactsMany(keys) {
      if (keys.length === 0) return [];
      const rawResults = await withRead<unknown[]>(AI_ARTIFACTS_IDB_STORE, [], (s) =>
        Promise.all(keys.map((k) => idbRequestToPromise(s.get(k))))
      );
      return rawResults.map((raw) => normalizeAiArtifactRecord(raw));
    },
    putArtifact: (record) => putOne(AI_ARTIFACTS_IDB_STORE, record),
    putArtifactsMany: (records) => putMany(AI_ARTIFACTS_IDB_STORE, records),
    deleteArtifacts: (keys) => deleteKeys(AI_ARTIFACTS_IDB_STORE, keys),
    async getArtifactsByFamily(family) {
      const rawAll = await withRead<unknown[]>(AI_ARTIFACTS_IDB_STORE, [], async (store) =>
        typeof store.index === "function" &&
        store.indexNames.contains(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED) &&
        typeof IDBKeyRange !== "undefined" &&
        typeof IDBKeyRange.bound === "function"
          ? ((await idbRequestToPromise(
              store
                .index(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED)
                .getAll(IDBKeyRange.bound([family, Number.NEGATIVE_INFINITY], [family, Number.POSITIVE_INFINITY]))
            )) as unknown[])
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { family?: unknown } | null)?.family === family
            )
      );
      return normalizeArtifactList(rawAll);
    },
    async getArtifactsByFamilyBvid(family, bvid) {
      return normalizeArtifactList(
        await getAllByIndex(
          AI_ARTIFACTS_IDB_STORE,
          AI_ARTIFACTS_INDEX_FAMILY_BVID,
          [family, bvid],
          (item) =>
            (item as { family?: unknown } | null)?.family === family &&
            (item as { bvid?: unknown } | null)?.bvid === bvid
        )
      );
    },
    async getArtifactsByBvid(bvid) {
      return normalizeArtifactList(
        await getAllByIndex(
          AI_ARTIFACTS_IDB_STORE,
          AI_ARTIFACTS_INDEX_BVID,
          bvid,
          (item) => (item as { bvid?: unknown } | null)?.bvid === bvid
        )
      );
    },
    async getAllArtifacts() {
      return normalizeArtifactList(await withRead(AI_ARTIFACTS_IDB_STORE, [], (s) => idbRequestToPromise(s.getAll())));
    },

    async getChatImage(id) {
      return normalizeChatImageRecord(
        await withRead(CHAT_IMAGES_IDB_STORE, null, (s) => idbRequestToPromise(s.get(id)))
      );
    },
    async getChatImagesMany(ids) {
      if (ids.length === 0) return [];
      const rawResults = await withRead<unknown[]>(CHAT_IMAGES_IDB_STORE, [], (s) =>
        Promise.all(ids.map((id) => idbRequestToPromise(s.get(id))))
      );
      return rawResults.map((raw) => normalizeChatImageRecord(raw));
    },
    putChatImage: (record) => putOne(CHAT_IMAGES_IDB_STORE, record),
    putChatImagesMany: (records) => putMany(CHAT_IMAGES_IDB_STORE, records),
    deleteChatImages: (ids) => deleteKeys(CHAT_IMAGES_IDB_STORE, ids),
    async getChatImagesByConversationId(conversationId) {
      return normalizeChatImageList(
        await getAllByIndex(
          CHAT_IMAGES_IDB_STORE,
          CHAT_IMAGES_INDEX_CONVERSATION_ID,
          conversationId,
          (item) => (item as { conversationId?: unknown } | null)?.conversationId === conversationId
        )
      );
    },
    async getRawChatImageIdsByConversationId(conversationId) {
      const rawAll = await getAllByIndex(
        CHAT_IMAGES_IDB_STORE,
        CHAT_IMAGES_INDEX_CONVERSATION_ID,
        conversationId,
        (item) => (item as { conversationId?: unknown } | null)?.conversationId === conversationId
      );
      return rawAll.map(extractRawChatImageRef).filter((ref): ref is RawChatImageRef => Boolean(ref?.id)).map((r) => r.id);
    },
    async getAllChatImages() {
      return normalizeChatImageList(await withRead(CHAT_IMAGES_IDB_STORE, [], (s) => idbRequestToPromise(s.getAll())));
    },
    async getAllRawChatImageRefs() {
      const rawAll = await withRead<unknown[]>(CHAT_IMAGES_IDB_STORE, [], (s) => idbRequestToPromise(s.getAll()));
      return rawAll.map(extractRawChatImageRef).filter((ref): ref is RawChatImageRef => Boolean(ref));
    },
    clearChatImages: () => withWrite(CHAT_IMAGES_IDB_STORE, (s) => s.clear(), true),

    async getConversation(id) {
      return normalizePersistedConversationRecord(
        await withRead(CONVERSATIONS_IDB_STORE, null, (s) => idbRequestToPromise(s.get(id)))
      );
    },
    async getAllConversations() {
      return normalizePersistedConversationList(
        await withRead(CONVERSATIONS_IDB_STORE, [], (s) => idbRequestToPromise(s.getAll()))
      );
    },
    async countConversations() {
      return Number(await withRead(CONVERSATIONS_IDB_STORE, 0, (s) => idbRequestToPromise(s.count()))) || 0;
    },
    putConversation: (record) => putOne(CONVERSATIONS_IDB_STORE, record),
    putConversationsMany: (records) => putMany(CONVERSATIONS_IDB_STORE, records),
    deleteConversations: (ids) => deleteKeys(CONVERSATIONS_IDB_STORE, ids, true),
    clearConversations: () => withWrite(CONVERSATIONS_IDB_STORE, (s) => s.clear(), true),

    async clearAll() {
      const db = await openDb();
      const storesToClear = [
        SUBTITLE_IDB_STORE,
        AI_ARTIFACTS_IDB_STORE,
        CHAT_IMAGES_IDB_STORE,
        CONVERSATIONS_IDB_STORE
      ].filter((name) => db.objectStoreNames.contains(name));
      if (storesToClear.length === 0) return;
      const tx = db.transaction(storesToClear, "readwrite");
      for (const storeName of storesToClear) tx.objectStore(storeName).clear();
      await idbTransactionToPromise(tx);
    }
  };
}

function isWebPageOriginContext(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const protocol = String(window.location?.protocol || "").toLowerCase();
  return protocol === "http:" || protocol === "https:";
}

function selectBackend(options: SubtitleIdbStoreOptions): StorageBackend {
  if (options.indexedDB !== undefined) {
    if (options.indexedDB && typeof options.indexedDB.open === "function") {
      return createIdbBackend(options.indexedDB, options.dbName || SUBTITLE_IDB_NAME);
    }
    return createMemoryBackend(options.useSharedMemoryBacking === true);
  }
  if (isWebPageOriginContext()) {
    return createMemoryBackend(options.useSharedMemoryBacking === true);
  }
  const idb =
    typeof globalThis !== "undefined"
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null
      : null;
  if (idb && typeof idb.open === "function") {
    return createIdbBackend(idb, options.dbName || SUBTITLE_IDB_NAME);
  }
  return createMemoryBackend(options.useSharedMemoryBacking === true);
}

export function createSubtitleIdbStore(options: SubtitleIdbStoreOptions = {}): SubtitleIdbStore {
  const hasExplicitMaxEntries = options.maxEntries !== undefined;
  const maxEntries = hasExplicitMaxEntries
    ? Math.max(1, Math.floor(options.maxEntries!))
    : Number.POSITIVE_INFINITY;
  const initialMaxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_SUBTITLE_CACHE_MAX_BYTES));
  let currentMaxBytes = initialMaxBytes;
  const maxChatImageBytes = Math.max(
    1,
    Math.floor(options.maxChatImageBytes ?? DEFAULT_CHAT_IMAGES_MAX_BYTES)
  );
  const now = options.now ?? (() => Date.now());
  const backend = selectBackend(options);
  const explicitKeepVideosMap: Partial<Record<AiArtifactFamily, number>> | null = options.aiArtifactKeepVideos
    ? { ...options.aiArtifactKeepVideos }
    : null;
  let writeInterceptor: SubtitleStoreWriteInterceptor | null = null;
  let opQueue: Promise<unknown> = Promise.resolve();

  const cleanIdList = (ids: unknown): string[] =>
    Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean)));
  const posTs = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const toErr = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = opQueue.then(task, task);
    opQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function computeVideoCacheUsage(): Promise<VideoCacheUsage> {
    const [allPages, allArtifacts] = await Promise.all([
      backend.getAllPages(),
      backend.getAllArtifacts()
    ]);
    const subtitleBytes = allPages.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    const artifactBytes = allArtifacts.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    return {
      totalBytes: subtitleBytes + artifactBytes,
      subtitleBytes,
      artifactBytes,
      subtitlePageCount: allPages.length,
      artifactCount: allArtifacts.length,
      maxBytes: currentMaxBytes
    };
  }

  async function evictVideoCacheIfNeeded(
    protectedTarget: { pageId?: string; artifactKey?: string } = {}
  ): Promise<{ evictedIds: string[]; evictedArtifactKeys: string[] }> {
    const [allPages, allArtifacts] = await Promise.all([
      backend.getAllPages(),
      backend.getAllArtifacts()
    ]);
    let remainingPageCount = allPages.length;
    let totalBytes =
      allPages.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0) +
      allArtifacts.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);

    if (totalBytes <= currentMaxBytes && remainingPageCount <= maxEntries) {
      return { evictedIds: [], evictedArtifactKeys: [] };
    }

    const pagesPerBvid = new Map<string, number>();
    const artifactsByBvid = new Map<string, AiArtifactRecord[]>();
    const candidates: Array<{ isPage: boolean; id: string; bvid: string; bytes: number; lastUsed: number; createdAt: number }> = [];
    for (const p of allPages) {
      if (p.bvid) pagesPerBvid.set(p.bvid, (pagesPerBvid.get(p.bvid) ?? 0) + 1);
      if (p.id !== protectedTarget.pageId) {
        candidates.push({ isPage: true, id: p.id, bvid: p.bvid, bytes: Number(p.estimatedBytes) || 0, lastUsed: p.lastUsed, createdAt: p.createdAt });
      }
    }
    for (const a of allArtifacts) {
      if (a.bvid) {
        const list = artifactsByBvid.get(a.bvid);
        if (list) list.push(a);
        else artifactsByBvid.set(a.bvid, [a]);
      }
      if (a.key !== protectedTarget.artifactKey) {
        candidates.push({ isPage: false, id: a.key, bvid: a.bvid, bytes: Number(a.estimatedBytes) || 0, lastUsed: a.lastUsedAt, createdAt: a.createdAt });
      }
    }

    candidates.sort((a, b) => a.lastUsed - b.lastUsed || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const deletedPageIds = new Set<string>();
    const deletedArtifactKeys = new Set<string>();
    const evictPage = (c: (typeof candidates)[number]): void => {
      if (deletedPageIds.has(c.id)) return;
      deletedPageIds.add(c.id);
      remainingPageCount -= 1;
      totalBytes -= c.bytes;
      if (!c.bvid) return;
      const left = (pagesPerBvid.get(c.bvid) ?? 0) - 1;
      pagesPerBvid.set(c.bvid, Math.max(0, left));
      if (left > 0) return;
      for (const art of artifactsByBvid.get(c.bvid) ?? []) {
        if (art.key === protectedTarget.artifactKey || deletedArtifactKeys.has(art.key)) continue;
        deletedArtifactKeys.add(art.key);
        totalBytes -= Number(art.estimatedBytes) || 0;
      }
    };

    for (const c of candidates) {
      if (totalBytes <= currentMaxBytes) break;
      if (c.isPage) evictPage(c);
      else if (!deletedArtifactKeys.has(c.id)) {
        deletedArtifactKeys.add(c.id);
        totalBytes -= c.bytes;
      }
    }
    for (const c of candidates) {
      if (remainingPageCount <= maxEntries) break;
      if (c.isPage) evictPage(c);
    }

    const evictedIds = Array.from(deletedPageIds);
    const evictedArtifactKeys = Array.from(deletedArtifactKeys);
    if (evictedIds.length > 0) await backend.deletePages(evictedIds);
    if (evictedArtifactKeys.length > 0) await backend.deleteArtifacts(evictedArtifactKeys);
    return { evictedIds, evictedArtifactKeys };
  }

  async function evictAiArtifactsForFamily(
    family: AiArtifactFamily,
    protectedBvid: string
  ): Promise<string[]> {
    const rawLimit = explicitKeepVideosMap?.[family];
    if (rawLimit === undefined) {
      return [];
    }
    const keepVideos = Math.max(1, Math.floor(Number(rawLimit) || AI_ARTIFACT_FAMILY_KEEP_VIDEOS[family]));
    const all = await backend.getArtifactsByFamily(family);
    const byBvid = new Map<string, { maxLastUsedAt: number; maxCreatedAt: number; keys: string[] }>();
    for (const item of all) {
      let bucket = byBvid.get(item.bvid);
      if (!bucket) {
        bucket = { maxLastUsedAt: item.lastUsedAt, maxCreatedAt: item.createdAt, keys: [] };
        byBvid.set(item.bvid, bucket);
      }
      bucket.maxLastUsedAt = Math.max(bucket.maxLastUsedAt, item.lastUsedAt);
      bucket.maxCreatedAt = Math.max(bucket.maxCreatedAt, item.createdAt);
      bucket.keys.push(item.key);
    }
    if (byBvid.size <= keepVideos) {
      return [];
    }

    const candidates = Array.from(byBvid.entries())
      .filter(([bvid]) => bvid !== protectedBvid)
      .sort((a, b) => {
        if (a[1].maxLastUsedAt !== b[1].maxLastUsedAt) {
          return a[1].maxLastUsedAt - b[1].maxLastUsedAt;
        }
        if (a[1].maxCreatedAt !== b[1].maxCreatedAt) {
          return a[1].maxCreatedAt - b[1].maxCreatedAt;
        }
        return a[0].localeCompare(b[0]);
      });

    let remainingVideoCount = byBvid.size;
    const evictedKeys: string[] = [];
    for (const [, bucket] of candidates) {
      if (remainingVideoCount <= keepVideos) {
        break;
      }
      evictedKeys.push(...bucket.keys);
      remainingVideoCount -= 1;
    }

    if (evictedKeys.length > 0) {
      await backend.deleteArtifacts(evictedKeys);
    }
    return evictedKeys;
  }

  async function evictChatImagesIfNeeded(protectedId: string): Promise<string[]> {
    const allRefs = await backend.getAllRawChatImageRefs();
    let totalBytes = allRefs.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    if (totalBytes <= maxChatImageBytes) {
      return [];
    }

    const candidates = allRefs
      .filter((item) => item.id !== protectedId)
      .sort((a, b) => {
        if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      });

    const evictedIds: string[] = [];
    for (const candidate of candidates) {
      if (totalBytes <= maxChatImageBytes) {
        break;
      }
      evictedIds.push(candidate.id);
      totalBytes -= Number(candidate.estimatedBytes) || 0;
    }

    if (evictedIds.length > 0) {
      await backend.deleteChatImages(evictedIds);
    }
    return evictedIds;
  }

  async function touchChatImagesLastUsed(records: ChatImageRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    try {
      const ts = now();
      const updated = records.map((record) => ({ ...record, lastUsedAt: ts }));
      await backend.putChatImagesMany(updated);
    } catch {
    }
  }

  async function writePageMutation(
    ctx: SubtitleStoreWriteContext,
    mutate: (record: SubtitlePageRecord, ts: number) => boolean
  ): Promise<SubtitleStoreWriteResult> {
    return enqueue(async () => {
      const pageId = buildSubtitlePageId(ctx.bvid, ctx.cid);
      if (!pageId) {
        return {
          ok: false,
          evictedIds: [],
          error: new Error("Invalid bvid or cid for subtitle store write")
        };
      }
      try {
        if (writeInterceptor) {
          await writeInterceptor({ ...ctx, pageId });
        }
        const ts = now();
        const existing = (await backend.getPage(pageId)) ?? createEmptyPageRecord(ctx.bvid, ctx.cid, ts);
        const changed = mutate(existing, ts);
        if (!changed) {
          return { ok: true, evictedIds: [], estimatedBytes: existing.estimatedBytes };
        }
        existing.updatedAt = ts;
        existing.lastUsed = ts;
        existing.estimatedBytes = estimateSubtitleRecordBytes(existing);
        if (existing.estimatedBytes > currentMaxBytes) {
          return {
            ok: false,
            evictedIds: [],
            error: new Error(
              `Subtitle page ${pageId} (${existing.estimatedBytes} B) exceeds maxBytes (${currentMaxBytes} B)`
            )
          };
        }
        await backend.putPage(existing);
        const { evictedIds, evictedArtifactKeys } = await evictVideoCacheIfNeeded({
          pageId: existing.id
        });
        return {
          ok: true,
          evictedIds,
          ...(evictedArtifactKeys.length > 0 ? { evictedArtifactKeys } : {}),
          estimatedBytes: existing.estimatedBytes
        };
      } catch (err) {
        return {
          ok: false,
          evictedIds: [],
          error: err instanceof Error ? err : new Error(String(err))
        };
      }
    });
  }

  async function touchPageLastUsed(record: SubtitlePageRecord): Promise<void> {
    record.lastUsed = now();
    await backend.putPage(record);
  }

  async function touchArtifactsLastUsed(records: AiArtifactRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const ts = now();
    const updated = records.map((record) => ({ ...record, lastUsedAt: ts }));
    await backend.putArtifactsMany(updated);
  }

  return {
    async getPageRecord(bvid, cid, site) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) {
          return null;
        }
        return backend.getPage(pageId);
      });
    },

    async listPageRecords() {
      return enqueue(() => backend.getAllPages());
    },

    async getRawTrack(bvid, cid, trackKey, site) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const key = String(trackKey || "").trim();
        if (!pageId || !key) {
          return null;
        }
        const record = await backend.getPage(pageId);
        const track = record?.rawTracks[key];
        if (!record || !track || !Array.isArray(track.items) || track.items.length === 0) {
          return null;
        }
        await touchPageLastUsed(record);
        return track.items.map((item) => ({ ...item }));
      });
    },

    async putRawTrack({ bvid, cid, site, trackKey, lang, kind, items }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanTrackKey = String(trackKey || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || sanitized.length === 0) {
        return { ok: true, evictedIds: [] };
      }
      return writePageMutation(
        {
          op: "put-raw",
          pageId: buildSubtitlePageId(resolved.bvid, resolved.cid),
          bvid: resolved.bvid,
          cid: resolved.cid,
          trackKey: cleanTrackKey
        },
        (record, ts) => {
          record.rawTracks[cleanTrackKey] = {
            trackKey: cleanTrackKey,
            ...(lang ? { lang } : {}),
            ...(kind ? { kind } : {}),
            items: sanitized,
            updatedAt: ts
          };
          return true;
        }
      );
    },

    async getSegmentedTrack(bvid, cid, trackKey, segmentationSig, site) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanTrackKey = String(trackKey || "").trim();
        const cleanSig = String(segmentationSig || "").trim();
        if (!pageId || !cleanTrackKey || !cleanSig) {
          return null;
        }
        const record = await backend.getPage(pageId);
        const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
        const entry = record?.segmentedTracks[mapKey];
        if (!record || !entry || !Array.isArray(entry.items) || entry.items.length === 0) {
          return null;
        }
        await touchPageLastUsed(record);
        return entry.items.map((item) => ({ ...item }));
      });
    },

    async putSegmentedTrack({ bvid, cid, site, trackKey, segmentationSig, items }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanTrackKey = String(trackKey || "").trim();
      const cleanSig = String(segmentationSig || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || !cleanSig || sanitized.length === 0) {
        return { ok: true, evictedIds: [] };
      }
      const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
      return writePageMutation(
        {
          op: "put-segmented",
          pageId: buildSubtitlePageId(resolved.bvid, resolved.cid),
          bvid: resolved.bvid,
          cid: resolved.cid,
          trackKey: mapKey
        },
        (record, ts) => {
          record.segmentedTracks[mapKey] = {
            key: mapKey,
            trackKey: cleanTrackKey,
            segmentationSig: cleanSig,
            items: sanitized,
            updatedAt: ts
          };
          return true;
        }
      );
    },

    async getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig, site) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanSource = String(sourceTrackKey || "").trim();
        const cleanLang = String(targetLang || "").trim();
        if (!pageId || !cleanSource || !cleanLang) {
          return null;
        }
        const record = await backend.getPage(pageId);
        if (!record) {
          return null;
        }
        let hit: TranslatedSubtitleTrackRecord | undefined;
        if (translationSig) {
          hit = record.translatedTracks[buildTranslatedTrackMapKey(cleanSource, cleanLang, translationSig)];
          if (!hit) {
            const hasExplicitSigForPair = Object.values(record.translatedTracks).some(
              (entry) =>
                entry.sourceTrackKey === cleanSource &&
                entry.targetLang === cleanLang &&
                entry.translationSig !== "legacy"
            );
            if (!hasExplicitSigForPair) {
              hit = record.translatedTracks[buildTranslatedTrackMapKey(cleanSource, cleanLang, "legacy")];
            }
          }
        } else {
          const candidates = Object.values(record.translatedTracks).filter(
            (entry) => entry.sourceTrackKey === cleanSource && entry.targetLang === cleanLang
          );
          candidates.sort((a, b) => {
            if (b.updatedAt !== a.updatedAt) {
              return b.updatedAt - a.updatedAt;
            }
            const aLegacy = a.translationSig === "legacy" ? 1 : 0;
            const bLegacy = b.translationSig === "legacy" ? 1 : 0;
            if (aLegacy !== bLegacy) {
              return aLegacy - bLegacy;
            }
            return b.items.length - a.items.length;
          });
          hit = candidates[0];
        }
        if (!hit || !Array.isArray(hit.items) || hit.items.length === 0) {
          return null;
        }
        await touchPageLastUsed(record);
        return hit.items.map((item) => ({ ...item }));
      });
    },

    async upsertTranslatedTrack({
      bvid,
      cid,
      site,
      sourceTrackKey,
      targetLang,
      translationSig,
      mode,
      items,
      replaceRange
    }) {
      const resolved = resolveVideoStorageIdentity(bvid, cid, site);
      const cleanSource = String(sourceTrackKey || "").trim();
      const cleanLang = String(targetLang || "").trim();
      const cleanSig = String(translationSig || "").trim() || "legacy";
      const sanitizedIncoming = sanitizeTranslatedItems(items);
      if (!cleanSource || !cleanLang) {
        return { ok: true, evictedIds: [] };
      }
      if (sanitizedIncoming.length === 0 && !replaceRange) {
        return { ok: true, evictedIds: [] };
      }
      const mapKey = buildTranslatedTrackMapKey(cleanSource, cleanLang, cleanSig);
      return writePageMutation(
        {
          op: "upsert-translated",
          pageId: buildSubtitlePageId(resolved.bvid, resolved.cid),
          bvid: resolved.bvid,
          cid: resolved.cid,
          trackKey: mapKey
        },
        (record, ts) => {
          const existingItems = record.translatedTracks[mapKey]?.items ?? [];
          const merged = mergeTranslatedItems(existingItems, sanitizedIncoming, replaceRange);
          if (merged.length === 0) {
            if (record.translatedTracks[mapKey]) {
              delete record.translatedTracks[mapKey];
              return true;
            }
            return false;
          }
          record.translatedTracks[mapKey] = {
            key: mapKey,
            sourceTrackKey: cleanSource,
            targetLang: cleanLang,
            translationSig: cleanSig,
            ...(mode ? { mode } : {}),
            items: merged,
            updatedAt: ts
          };
          return true;
        }
      );
    },

    async deleteTrackEntry({ bvid, cid, site, tier, key }) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        const cleanKey = String(key || "").trim();
        if (!pageId || !cleanKey) {
          return false;
        }
        const record = await backend.getPage(pageId);
        if (!record) {
          return false;
        }
        let deleted = false;
        if (tier === "rawTracks" && record.rawTracks[cleanKey]) {
          delete record.rawTracks[cleanKey];
          deleted = true;
        } else if (tier === "segmentedTracks") {
          if (record.segmentedTracks[cleanKey]) {
            delete record.segmentedTracks[cleanKey];
            deleted = true;
          } else {
            for (const mapKey of Object.keys(record.segmentedTracks)) {
              if (record.segmentedTracks[mapKey]?.trackKey === cleanKey) {
                delete record.segmentedTracks[mapKey];
                deleted = true;
              }
            }
          }
        } else if (tier === "translatedTracks" && record.translatedTracks[cleanKey]) {
          delete record.translatedTracks[cleanKey];
          deleted = true;
        }
        if (!deleted) {
          return false;
        }
        if (isRecordEmpty(record)) {
          await backend.deletePages([record.id]);
        } else {
          record.updatedAt = now();
          record.estimatedBytes = estimateSubtitleRecordBytes(record);
          await backend.putPage(record);
        }
        return true;
      });
    },

    async pruneAsrVariants({ bvid, cid, keepTrackKey = "", site }) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) {
          return [];
        }
        const record = await backend.getPage(pageId);
        if (!record) {
          return [];
        }
        const removed: string[] = [];
        for (const trackKey of Object.keys(record.rawTracks)) {
          if (isAsrVariantSourceKey(trackKey) && trackKey !== keepTrackKey) {
            delete record.rawTracks[trackKey];
            removed.push(trackKey);
          }
        }
        for (const mapKey of Object.keys(record.segmentedTracks)) {
          const seg = record.segmentedTracks[mapKey];
          if (seg && isAsrVariantSourceKey(seg.trackKey) && seg.trackKey !== keepTrackKey) {
            delete record.segmentedTracks[mapKey];
          }
        }
        if (removed.length > 0) {
          if (isRecordEmpty(record)) {
            await backend.deletePages([record.id]);
          } else {
            record.updatedAt = now();
            record.estimatedBytes = estimateSubtitleRecordBytes(record);
            await backend.putPage(record);
          }
        }
        return removed;
      });
    },

    async clearTranslatedTracksForPage({ bvid, cid, sourceTrackKey, site }) {
      return enqueue(async () => {
        const resolved = resolveVideoStorageIdentity(bvid, cid, site);
        const pageId = buildSubtitlePageId(resolved.bvid, resolved.cid);
        if (!pageId) {
          return [];
        }
        const record = await backend.getPage(pageId);
        if (!record) {
          return [];
        }
        const removed: string[] = [];
        for (const mapKey of Object.keys(record.translatedTracks)) {
          const entry = record.translatedTracks[mapKey];
          if (!sourceTrackKey || entry?.sourceTrackKey === sourceTrackKey) {
            delete record.translatedTracks[mapKey];
            removed.push(mapKey);
          }
        }
        if (removed.length > 0) {
          if (isRecordEmpty(record)) {
            await backend.deletePages([record.id]);
          } else {
            record.updatedAt = now();
            record.estimatedBytes = estimateSubtitleRecordBytes(record);
            await backend.putPage(record);
          }
        }
        return removed;
      });
    },

    async getAiArtifact<TPayload = unknown>(key: string): Promise<AiArtifactRecord<TPayload> | null> {
      return enqueue(async () => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) {
          return null;
        }
        const record = await backend.getArtifact(cleanKey);
        if (!record) {
          return null;
        }
        await touchArtifactsLastUsed([record]);
        return cloneValue(record) as AiArtifactRecord<TPayload>;
      });
    },

    async getAiArtifactsMany<TPayload = unknown>(
      keys: string[]
    ): Promise<Array<AiArtifactRecord<TPayload> | null>> {
      return enqueue(async () => {
        const cleanKeys = (Array.isArray(keys) ? keys : []).map((k) => String(k || "").trim());
        if (cleanKeys.length === 0) {
          return [];
        }
        const hits = await backend.getArtifactsMany(cleanKeys);
        const nonNull = hits.filter((rec): rec is AiArtifactRecord => rec !== null);
        if (nonNull.length > 0) {
          await touchArtifactsLastUsed(nonNull);
        }
        return hits.map((rec) => (rec ? (cloneValue(rec) as AiArtifactRecord<TPayload>) : null));
      });
    },

    async putAiArtifact<TPayload = unknown>(
      input: PutAiArtifactInput<TPayload>
    ): Promise<AiArtifactWriteResult> {
      return enqueue(async () => {
        const cleanKey = String(input?.key || "").trim();
        const parsed = parseAiArtifactKey(cleanKey);
        const family = isAiArtifactFamily(input?.family) ? input.family : parsed?.family;
        const rawBvid = String(input?.bvid ?? parsed?.bvid ?? "").trim();
        const rawCid = String(input?.cid ?? parsed?.cid ?? "").trim();
        const resolved = resolveVideoStorageIdentity(rawBvid, rawCid, input?.site);
        const bvid = resolved.bvid;
        const cid = resolved.cid;
        if (!cleanKey || !family || !bvid || input?.payload === undefined || input?.payload === null) {
          return {
            ok: false,
            evictedKeys: [],
            error: new Error("Invalid ai_artifact key, family, bvid or payload")
          };
        }
        try {
          if (writeInterceptor) {
            await writeInterceptor({
              op: "put-ai-artifact",
              pageId: buildSubtitlePageId(bvid, cid),
              bvid,
              cid,
              trackKey: cleanKey,
              family,
              key: cleanKey
            });
          }
          const ts = now();
          const existing = await backend.getArtifact(cleanKey);
          const createdAt = posTs(input.createdAt, posTs(existing?.createdAt, ts));
          const updatedAt = posTs(input.updatedAt, ts);
          const lastUsedAt = posTs(input.lastUsedAt, ts);
          const record: AiArtifactRecord<TPayload> = {
            key: cleanKey,
            family,
            bvid,
            cid,
            payload: cloneValue(input.payload),
            estimatedBytes: 0,
            createdAt,
            updatedAt,
            lastUsedAt
          };
          record.estimatedBytes = estimateAiArtifactRecordBytes(record);
          if (record.estimatedBytes > currentMaxBytes) {
            return { ok: false, evictedKeys: [], error: new Error(`AI artifact ${cleanKey} (${record.estimatedBytes} B) exceeds maxBytes (${currentMaxBytes} B)`) };
          }
          await backend.putArtifact(record);
          const familyEvictedKeys = await evictAiArtifactsForFamily(family, bvid);
          const { evictedArtifactKeys } = await evictVideoCacheIfNeeded({ artifactKey: cleanKey });
          return { ok: true, evictedKeys: Array.from(new Set([...familyEvictedKeys, ...evictedArtifactKeys])), estimatedBytes: record.estimatedBytes };
        } catch (err) {
          return { ok: false, evictedKeys: [], error: toErr(err) };
        }
      });
    },

    async deleteAiArtifact(key: string): Promise<boolean> {
      return enqueue(async () => {
        const cleanKey = String(key || "").trim();
        if (!cleanKey) {
          return false;
        }
        const existing = await backend.getArtifact(cleanKey);
        if (!existing) {
          return false;
        }
        await backend.deleteArtifacts([cleanKey]);
        return true;
      });
    },

    async listAiArtifactsByFamilyBvid(
      family: AiArtifactFamily,
      bvid: string,
      keyPrefix = "",
      site?: SiteId
    ): Promise<AiArtifactRecord[]> {
      return enqueue(async () => {
        const prefix = String(keyPrefix || "");
        const parsedPrefix = prefix ? parseAiArtifactKey(prefix) : null;
        const effectiveSite =
          site !== undefined
            ? site
            : parsedPrefix?.cid === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(parsedPrefix?.bvid)
              ? "youtube"
              : undefined;
        const cleanBvid = resolveVideoStorageIdentity(bvid, undefined, effectiveSite).bvid;
        if (!isAiArtifactFamily(family) || !cleanBvid) {
          return [];
        }
        const records = await backend.getArtifactsByFamilyBvid(family, cleanBvid);
        const matched = prefix ? records.filter((rec) => rec.key.startsWith(prefix)) : records;
        if (matched.length > 0) {
          await touchArtifactsLastUsed(matched);
        }
        return matched.map(cloneValue);
      });
    },

    async listAiArtifactsByBvid(bvid: string, site?: SiteId): Promise<AiArtifactRecord[]> {
      return enqueue(async () => {
        const cleanBvid = resolveVideoStorageIdentity(bvid, undefined, site).bvid;
        if (!cleanBvid) {
          return [];
        }
        return backend.getArtifactsByBvid(cleanBvid);
      });
    },

    async listAllAiArtifacts(): Promise<AiArtifactRecord[]> {
      return enqueue(() => backend.getAllArtifacts());
    },

    async clearVideo(bvid: string, cid?: string, site?: SiteId): Promise<ClearVideoResult> {
      return enqueue(async () => {
        const hasCid = cid !== undefined && cid !== null && String(cid).trim() !== "";
        const resolved = resolveVideoStorageIdentity(bvid, hasCid ? cid : "", site);
        const cleanBvid = resolved.bvid;
        const cleanCid = hasCid ? resolved.cid : "";
        if (!cleanBvid) {
          return { removedPageIds: [], removedArtifactKeys: [] };
        }

        const removedPageIds: string[] = [];
        const removedArtifactKeys: string[] = [];

        if (cleanCid) {
          const pageId = buildSubtitlePageId(cleanBvid, cleanCid);
          if (pageId) {
            const page = await backend.getPage(pageId);
            if (page) {
              await backend.deletePages([pageId]);
              removedPageIds.push(pageId);
            }
          }
          const artifacts = await backend.getArtifactsByBvid(cleanBvid);
          const matchingKeys = artifacts
            .filter((art) => art.cid === cleanCid)
            .map((art) => art.key);
          if (matchingKeys.length > 0) {
            await backend.deleteArtifacts(matchingKeys);
            removedArtifactKeys.push(...matchingKeys);
          }
        } else {
          const pages = await backend.getPagesByBvid(cleanBvid);
          if (pages.length > 0) {
            const pageIds = pages.map((page) => page.id);
            await backend.deletePages(pageIds);
            removedPageIds.push(...pageIds);
          }
          const artifacts = await backend.getArtifactsByBvid(cleanBvid);
          if (artifacts.length > 0) {
            const keys = artifacts.map((art) => art.key);
            await backend.deleteArtifacts(keys);
            removedArtifactKeys.push(...keys);
          }
        }

        return { removedPageIds, removedArtifactKeys };
      });
    },

    async getChatImage(id: string): Promise<ChatImageRecord | null> {
      return enqueue(async () => {
        const cleanId = String(id || "").trim();
        if (!cleanId) {
          return null;
        }
        const record = await backend.getChatImage(cleanId);
        if (!record) {
          return null;
        }
        await touchChatImagesLastUsed([record]);
        return cloneValue(record);
      });
    },

    async getChatImagesMany(ids: string[]): Promise<Array<ChatImageRecord | null>> {
      return enqueue(async () => {
        const cleanIds = (Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim());
        if (cleanIds.length === 0) {
          return [];
        }
        const hits = await backend.getChatImagesMany(cleanIds);
        const nonNull = hits.filter((rec): rec is ChatImageRecord => rec !== null);
        if (nonNull.length > 0) {
          await touchChatImagesLastUsed(nonNull);
        }
        return hits.map((rec) => (rec ? cloneValue(rec) : null));
      });
    },

    async putChatImage(input: PutChatImageInput): Promise<ChatImageWriteResult> {
      return enqueue(async () => {
        const cleanId = String(input?.id || "").trim();
        const cleanConvId = String(input?.conversationId || "").trim();
        const rawBvid = String(input?.bvid ?? "").trim();
        const cleanBvid = rawBvid
          ? resolveVideoStorageIdentity(rawBvid, input?.cid, input?.site).bvid
          : "";
        const cleanMime = typeof input?.mime === "string" ? input.mime.trim() : "";
        const cleanData = typeof input?.data === "string" ? input.data : "";
        if (!cleanId || !cleanConvId || !cleanMime || !cleanData) {
          return {
            ok: false,
            evictedIds: [],
            error: new Error("Invalid chat_image id, conversationId, mime or data")
          };
        }
        try {
          if (writeInterceptor) {
            await writeInterceptor({
              op: "put-chat-image",
              pageId: "",
              bvid: cleanBvid,
              cid: "",
              trackKey: cleanId,
              key: cleanId,
              conversationId: cleanConvId
            });
          }
          const ts = now();
          const existing = await backend.getChatImage(cleanId);
          const record: ChatImageRecord = {
            id: cleanId,
            conversationId: cleanConvId,
            bvid: cleanBvid,
            mime: cleanMime,
            data: cleanData,
            estimatedBytes: 0,
            createdAt: posTs(input.createdAt, posTs(existing?.createdAt, ts)),
            updatedAt: posTs(input.updatedAt, ts),
            lastUsedAt: posTs(input.lastUsedAt, ts)
          };
          record.estimatedBytes = estimateChatImageRecordBytes(record);
          if (record.estimatedBytes > maxChatImageBytes) {
            return { ok: false, evictedIds: [], error: new Error(`Chat image ${cleanId} (${record.estimatedBytes} B) exceeds maxChatImageBytes (${maxChatImageBytes} B)`) };
          }
          await backend.putChatImage(record);
          return { ok: true, evictedIds: await evictChatImagesIfNeeded(cleanId), estimatedBytes: record.estimatedBytes };
        } catch (err) {
          return { ok: false, evictedIds: [], error: toErr(err) };
        }
      });
    },

    deleteChatImages: (ids) =>
      enqueue(async () => {
        const uniqueIds = cleanIdList(ids);
        if (uniqueIds.length > 0) await backend.deleteChatImages(uniqueIds);
        return uniqueIds;
      }),

    deleteChatImagesByConversationIds: (conversationIds) =>
      enqueue(async () => {
        const uniqueConvIds = cleanIdList(conversationIds);
        if (uniqueConvIds.length === 0) return [];
        const idsToDelete = new Set<string>();
        for (const convId of uniqueConvIds) {
          for (const id of await backend.getRawChatImageIdsByConversationId(convId)) idsToDelete.add(id);
        }
        const removedIds = Array.from(idsToDelete);
        if (removedIds.length > 0) await backend.deleteChatImages(removedIds);
        return removedIds;
      }),

    pruneChatImages: (input) =>
      enqueue(async () => {
        const validConvIds = new Set(cleanIdList(input?.validConversationIds));
        const keepIds = Array.isArray(input?.keepImageIds) ? new Set(cleanIdList(input.keepImageIds)) : null;
        const orphanIds = (await backend.getAllRawChatImageRefs())
          .filter((ref) => !ref.conversationId || !validConvIds.has(ref.conversationId) || (keepIds !== null && !keepIds.has(ref.id)))
          .map((ref) => ref.id);
        if (orphanIds.length > 0) await backend.deleteChatImages(orphanIds);
        return orphanIds;
      }),

    clearAllChatImages: () =>
      enqueue(async () => {
        const removedIds = (await backend.getAllRawChatImageRefs()).map((ref) => ref.id);
        await backend.clearChatImages();
        return removedIds;
      }),

    listChatImagesByConversationId: (conversationId) =>
      enqueue(async () => {
        const cleanConvId = String(conversationId || "").trim();
        return cleanConvId ? backend.getChatImagesByConversationId(cleanConvId) : [];
      }),

    listAllChatImages: () => enqueue(() => backend.getAllChatImages()),
    getVideoCacheUsage: () => enqueue(() => computeVideoCacheUsage()),

    syncVideoCacheMaxBytes(maxBytes) {
      const n = Math.floor(Number(maxBytes));
      if (Number.isFinite(n) && n > 0) currentMaxBytes = n;
    },
    setVideoCacheMaxBytes: (maxBytes) =>
      enqueue(async () => {
        const n = Math.floor(Number(maxBytes));
        if (Number.isFinite(n) && n > 0) currentMaxBytes = n;
        const { evictedIds, evictedArtifactKeys } = await evictVideoCacheIfNeeded();
        return { evictedPageIds: evictedIds, evictedArtifactKeys, usage: await computeVideoCacheUsage() };
      }),
    getConversation: (id) =>
      enqueue(async () => {
        const cleanId = String(id || "").trim();
        return cleanId ? backend.getConversation(cleanId) : null;
      }),
    listConversations: () => enqueue(() => backend.getAllConversations()),
    countConversations: () => enqueue(() => backend.countConversations()),
    putConversation: (record) =>
      enqueue(async () => {
        const normalized = normalizePersistedConversationRecord(record);
        if (normalized) await backend.putConversation(normalized);
      }),
    putConversationsMany: (records) =>
      enqueue(async () => {
        const normalized = normalizePersistedConversationList(records);
        if (normalized.length > 0) await backend.putConversationsMany(normalized);
      }),
    deleteConversations: (ids) =>
      enqueue(async () => {
        const cleanIds = cleanIdList(ids);
        if (cleanIds.length > 0) await backend.deleteConversations(cleanIds);
        return cleanIds;
      }),
    clearAllConversations: () =>
      enqueue(async () => {
        const removedIds = (await backend.getAllConversations()).map((item) => item.id);
        await backend.clearConversations();
        return removedIds;
      }),
    pruneConversationsToLimit: (maxCount) =>
      enqueue(async () => {
        const limit = Math.floor(Number(maxCount));
        const all = await backend.getAllConversations();
        if (!Number.isFinite(limit) || limit <= 0 || all.length <= limit) {
          return { removedIds: [], keptCount: all.length };
        }
        const removedIds = all.slice(limit).map((item) => item.id);
        await backend.deleteConversations(removedIds);
        const imageIds = new Set<string>();
        for (const convId of removedIds) {
          for (const imgId of await backend.getRawChatImageIdsByConversationId(convId)) imageIds.add(imgId);
        }
        if (imageIds.size > 0) await backend.deleteChatImages(Array.from(imageIds));
        return { removedIds, keptCount: all.length - removedIds.length };
      }),

    async clearAll() {
      writeInterceptor = null;
      currentMaxBytes = initialMaxBytes;
      return enqueue(async () => {
        await backend.clearAll();
      });
    },

    setWriteInterceptorForTests(interceptor) {
      writeInterceptor = interceptor;
    }
  };
}

export const defaultSubtitleIdbStore = createSubtitleIdbStore({ useSharedMemoryBacking: true });
