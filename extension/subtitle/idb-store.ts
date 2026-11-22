import type { SubtitleBodyItem, SubtitleWord } from "../shared/video-dto.js";
import { isAsrVariantSourceKey } from "./source-key.js";

export const SUBTITLE_IDB_NAME = "biliscript-subtitle-store";
export const SUBTITLE_IDB_VERSION = 2;

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
    return { family, bvid: rest, cid: "" };
  }
  const bvid = rest.slice(0, firstSep);
  if (!bvid) {
    return null;
  }
  const secondSep = rest.indexOf("_", firstSep + 1);
  const cid = secondSep === -1 ? rest.slice(firstSep + 1) : rest.slice(firstSep + 1, secondSep);
  return { family, bvid, cid };
}

export type SubtitleTrackStorageKind = "manual-cc" | "bili-ai" | "asr";

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
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: readonly SubtitleBodyItem[];
}

export interface PutSegmentedTrackInput {
  bvid: string;
  cid: string;
  trackKey: string;
  segmentationSig: string;
  items: readonly SubtitleBodyItem[];
}

export interface UpsertTranslatedTrackInput {
  bvid: string;
  cid: string;
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
  tier: "rawTracks" | "segmentedTracks" | "translatedTracks";
  key: string;
}

export interface PutAiArtifactInput<TPayload = unknown> {
  key: string;
  family?: AiArtifactFamily;
  bvid?: string;
  cid?: string;
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
  getPageRecord(bvid: string, cid: string): Promise<SubtitlePageRecord | null>;
  listPageRecords(): Promise<SubtitlePageRecord[]>;
  getRawTrack(bvid: string, cid: string, trackKey: string): Promise<SubtitleBodyItem[] | null>;
  putRawTrack(input: PutRawTrackInput): Promise<SubtitleStoreWriteResult>;
  getSegmentedTrack(
    bvid: string,
    cid: string,
    trackKey: string,
    segmentationSig: string
  ): Promise<SubtitleBodyItem[] | null>;
  putSegmentedTrack(input: PutSegmentedTrackInput): Promise<SubtitleStoreWriteResult>;
  getTranslatedTrack(
    bvid: string,
    cid: string,
    sourceTrackKey: string,
    targetLang: string,
    translationSig?: string
  ): Promise<SubtitleBodyItem[] | null>;
  upsertTranslatedTrack(input: UpsertTranslatedTrackInput): Promise<SubtitleStoreWriteResult>;
  deleteTrackEntry(input: DeleteTrackEntryInput): Promise<boolean>;
  pruneAsrVariants(args: { bvid: string; cid: string; keepTrackKey?: string }): Promise<string[]>;
  clearTranslatedTracksForPage(args: {
    bvid: string;
    cid: string;
    sourceTrackKey?: string;
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
    keyPrefix?: string
  ): Promise<AiArtifactRecord[]>;
  listAiArtifactsByBvid(bvid: string): Promise<AiArtifactRecord[]>;
  listAllAiArtifacts(): Promise<AiArtifactRecord[]>;
  clearVideo(bvid: string, cid?: string): Promise<ClearVideoResult>;

  getChatImage(id: string): Promise<ChatImageRecord | null>;
  getChatImagesMany(ids: string[]): Promise<Array<ChatImageRecord | null>>;
  putChatImage(input: PutChatImageInput): Promise<ChatImageWriteResult>;
  deleteChatImages(ids: string[]): Promise<string[]>;
  deleteChatImagesByConversationIds(conversationIds: string[]): Promise<string[]>;
  pruneChatImages(input: PruneChatImagesInput): Promise<string[]>;
  clearAllChatImages(): Promise<string[]>;
  listChatImagesByConversationId(conversationId: string): Promise<ChatImageRecord[]>;
  listAllChatImages(): Promise<ChatImageRecord[]>;

  clearAll(): Promise<void>;
  setWriteInterceptorForTests(interceptor: SubtitleStoreWriteInterceptor | null): void;
}

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
declare const DEFAULT_MEMORY_BACKING_KEY: unique symbol;
const DEFAULT_MEMORY_BACKING_SYMBOL: typeof DEFAULT_MEMORY_BACKING_KEY = Symbol.for(
  "biliscript.defaultSubtitleIdbMemoryBacking"
) as typeof DEFAULT_MEMORY_BACKING_KEY;

export function buildSubtitlePageId(bvid: string, cid: string): string {
  const cleanBvid = String(bvid || "").trim();
  const cleanCid = String(cid || "").trim();
  if (!cleanBvid || !cleanCid) {
    return "";
  }
  return `${cleanBvid}:${cleanCid}`;
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

export function estimateSubtitleRecordBytes(record: SubtitlePageRecord): number {
  return estimateJsonBytes({
    ...record,
    estimatedBytes: 0
  });
}

export function estimateAiArtifactRecordBytes(record: AiArtifactRecord): number {
  return estimateJsonBytes({
    ...record,
    estimatedBytes: 0
  });
}

export function estimateChatImageRecordBytes(record: ChatImageRecord): number {
  return estimateJsonBytes({
    ...record,
    estimatedBytes: 0
  });
}

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

  clearAll(): Promise<void>;
}

interface SharedMemoryBacking {
  pages: Map<string, SubtitlePageRecord>;
  artifacts: Map<string, AiArtifactRecord>;
  chatImages: Map<string, ChatImageRecord>;
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
      chatImages: new Map<string, ChatImageRecord>()
    };
    globals[DEFAULT_MEMORY_BACKING_SYMBOL] = backing;
  } else if (!backing.chatImages) {
    backing.chatImages = new Map<string, ChatImageRecord>();
  }
  return backing;
}

function createMemoryBackend(shared = false): StorageBackend {
  const backing: SharedMemoryBacking = shared
    ? getSharedMemoryBacking()
    : {
        pages: new Map<string, SubtitlePageRecord>(),
        artifacts: new Map<string, AiArtifactRecord>(),
        chatImages: new Map<string, ChatImageRecord>()
      };

  return {
    async getAllPages() {
      return Array.from(backing.pages.values()).map(cloneValue);
    },
    async getPage(id) {
      const hit = backing.pages.get(id);
      return hit ? cloneValue(hit) : null;
    },
    async getPagesByBvid(bvid) {
      const out: SubtitlePageRecord[] = [];
      for (const rec of backing.pages.values()) {
        if (rec.bvid === bvid) {
          out.push(cloneValue(rec));
        }
      }
      return out;
    },
    async putPage(record) {
      backing.pages.set(record.id, cloneValue(record));
    },
    async deletePages(ids) {
      for (const id of ids) {
        backing.pages.delete(id);
      }
    },

    async getArtifact(key) {
      const hit = backing.artifacts.get(key);
      return hit ? cloneValue(hit) : null;
    },
    async getArtifactsMany(keys) {
      return keys.map((key) => {
        const hit = backing.artifacts.get(key);
        return hit ? cloneValue(hit) : null;
      });
    },
    async putArtifact(record) {
      backing.artifacts.set(record.key, cloneValue(record));
    },
    async putArtifactsMany(records) {
      for (const record of records) {
        backing.artifacts.set(record.key, cloneValue(record));
      }
    },
    async deleteArtifacts(keys) {
      for (const key of keys) {
        backing.artifacts.delete(key);
      }
    },
    async getArtifactsByFamily(family) {
      const out: AiArtifactRecord[] = [];
      for (const rec of backing.artifacts.values()) {
        if (rec.family === family) {
          out.push(cloneValue(rec));
        }
      }
      return out;
    },
    async getArtifactsByFamilyBvid(family, bvid) {
      const out: AiArtifactRecord[] = [];
      for (const rec of backing.artifacts.values()) {
        if (rec.family === family && rec.bvid === bvid) {
          out.push(cloneValue(rec));
        }
      }
      return out;
    },
    async getArtifactsByBvid(bvid) {
      const out: AiArtifactRecord[] = [];
      for (const rec of backing.artifacts.values()) {
        if (rec.bvid === bvid) {
          out.push(cloneValue(rec));
        }
      }
      return out;
    },
    async getAllArtifacts() {
      return Array.from(backing.artifacts.values()).map(cloneValue);
    },

    async getChatImage(id) {
      const hit = backing.chatImages.get(id);
      return hit ? normalizeChatImageRecord(cloneValue(hit)) : null;
    },
    async getChatImagesMany(ids) {
      return ids.map((id) => {
        const hit = backing.chatImages.get(id);
        return hit ? normalizeChatImageRecord(cloneValue(hit)) : null;
      });
    },
    async putChatImage(record) {
      backing.chatImages.set(record.id, cloneValue(record));
    },
    async putChatImagesMany(records) {
      for (const record of records) {
        backing.chatImages.set(record.id, cloneValue(record));
      }
    },
    async deleteChatImages(ids) {
      for (const id of ids) {
        backing.chatImages.delete(id);
      }
    },
    async getChatImagesByConversationId(conversationId) {
      const out: ChatImageRecord[] = [];
      for (const rec of backing.chatImages.values()) {
        if (rec.conversationId === conversationId) {
          const normalized = normalizeChatImageRecord(cloneValue(rec));
          if (normalized) {
            out.push(normalized);
          }
        }
      }
      return out;
    },
    async getRawChatImageIdsByConversationId(conversationId) {
      const ids: string[] = [];
      for (const rec of backing.chatImages.values()) {
        if (rec.conversationId === conversationId && rec.id) {
          ids.push(rec.id);
        }
      }
      return ids;
    },
    async getAllChatImages() {
      const out: ChatImageRecord[] = [];
      for (const rec of backing.chatImages.values()) {
        const normalized = normalizeChatImageRecord(cloneValue(rec));
        if (normalized) {
          out.push(normalized);
        }
      }
      return out;
    },
    async getAllRawChatImageRefs() {
      const out: RawChatImageRef[] = [];
      for (const rec of backing.chatImages.values()) {
        const ref = extractRawChatImageRef(rec);
        if (ref) {
          out.push(ref);
        }
      }
      return out;
    },
    async clearChatImages() {
      backing.chatImages.clear();
    },

    async clearAll() {
      backing.pages.clear();
      backing.artifacts.clear();
      backing.chatImages.clear();
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

function normalizePageList(rawAll: unknown): SubtitlePageRecord[] {
  const list: SubtitlePageRecord[] = [];
  for (const raw of Array.isArray(rawAll) ? rawAll : []) {
    const normalized = normalizePageRecord(raw);
    if (normalized) {
      list.push(normalized);
    }
  }
  return list;
}

function normalizeArtifactList(rawAll: unknown): AiArtifactRecord[] {
  const list: AiArtifactRecord[] = [];
  for (const raw of Array.isArray(rawAll) ? rawAll : []) {
    const normalized = normalizeAiArtifactRecord(raw);
    if (normalized) {
      list.push(normalized);
    }
  }
  return list;
}

function normalizeChatImageList(rawAll: unknown): ChatImageRecord[] {
  const list: ChatImageRecord[] = [];
  for (const raw of Array.isArray(rawAll) ? rawAll : []) {
    const normalized = normalizeChatImageRecord(raw);
    if (normalized) {
      list.push(normalized);
    }
  }
  return list;
}

function createIdbBackend(idbFactory: IDBFactory, dbName: string): StorageBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idbFactory.open(dbName, SUBTITLE_IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const upgradeTx = req.transaction!;

        const subtitleStore = db.objectStoreNames.contains(SUBTITLE_IDB_STORE)
          ? upgradeTx.objectStore(SUBTITLE_IDB_STORE)
          : db.createObjectStore(SUBTITLE_IDB_STORE, { keyPath: "id" });
        if (!subtitleStore.indexNames.contains(SUBTITLE_IDB_LAST_USED_INDEX)) {
          subtitleStore.createIndex(SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed", { unique: false });
        }
        if (!subtitleStore.indexNames.contains(SUBTITLE_IDB_BVID_INDEX)) {
          subtitleStore.createIndex(SUBTITLE_IDB_BVID_INDEX, "bvid", { unique: false });
        }

        const aiStore = db.objectStoreNames.contains(AI_ARTIFACTS_IDB_STORE)
          ? upgradeTx.objectStore(AI_ARTIFACTS_IDB_STORE)
          : db.createObjectStore(AI_ARTIFACTS_IDB_STORE, { keyPath: "key" });
        if (!aiStore.indexNames.contains(AI_ARTIFACTS_INDEX_FAMILY_BVID)) {
          aiStore.createIndex(AI_ARTIFACTS_INDEX_FAMILY_BVID, ["family", "bvid"], { unique: false });
        }
        if (!aiStore.indexNames.contains(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED)) {
          aiStore.createIndex(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED, ["family", "lastUsedAt"], { unique: false });
        }
        if (!aiStore.indexNames.contains(AI_ARTIFACTS_INDEX_BVID)) {
          aiStore.createIndex(AI_ARTIFACTS_INDEX_BVID, "bvid", { unique: false });
        }
        if (!aiStore.indexNames.contains(AI_ARTIFACTS_INDEX_LAST_USED)) {
          aiStore.createIndex(AI_ARTIFACTS_INDEX_LAST_USED, "lastUsedAt", { unique: false });
        }

        const chatImagesStore = db.objectStoreNames.contains(CHAT_IMAGES_IDB_STORE)
          ? upgradeTx.objectStore(CHAT_IMAGES_IDB_STORE)
          : db.createObjectStore(CHAT_IMAGES_IDB_STORE, { keyPath: "id" });
        if (!chatImagesStore.indexNames.contains(CHAT_IMAGES_INDEX_CONVERSATION_ID)) {
          chatImagesStore.createIndex(CHAT_IMAGES_INDEX_CONVERSATION_ID, "conversationId", { unique: false });
        }
        if (!chatImagesStore.indexNames.contains(CHAT_IMAGES_INDEX_BVID)) {
          chatImagesStore.createIndex(CHAT_IMAGES_INDEX_BVID, "bvid", { unique: false });
        }
        if (!chatImagesStore.indexNames.contains(CHAT_IMAGES_INDEX_LAST_USED)) {
          chatImagesStore.createIndex(CHAT_IMAGES_INDEX_LAST_USED, "lastUsedAt", { unique: false });
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

  return {
    async getAllPages() {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readonly");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const rawAll = await idbRequestToPromise(store.getAll());
      await idbTransactionToPromise(tx);
      return normalizePageList(rawAll);
    },
    async getPage(id) {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readonly");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const raw = await idbRequestToPromise(store.get(id));
      await idbTransactionToPromise(tx);
      return normalizePageRecord(raw);
    },
    async getPagesByBvid(bvid) {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readonly");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const rawAll =
        typeof store.index === "function" && store.indexNames.contains(SUBTITLE_IDB_BVID_INDEX)
          ? await idbRequestToPromise(store.index(SUBTITLE_IDB_BVID_INDEX).getAll(bvid))
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { bvid?: unknown } | null)?.bvid === bvid
            );
      await idbTransactionToPromise(tx);
      return normalizePageList(rawAll);
    },
    async putPage(record) {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readwrite");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      store.put(cloneValue(record));
      await idbTransactionToPromise(tx);
    },
    async deletePages(ids) {
      if (ids.length === 0) {
        return;
      }
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readwrite");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      for (const id of ids) {
        store.delete(id);
      }
      await idbTransactionToPromise(tx);
    },

    async getArtifact(key) {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const raw = await idbRequestToPromise(store.get(key));
      await idbTransactionToPromise(tx);
      return normalizeAiArtifactRecord(raw);
    },
    async getArtifactsMany(keys) {
      if (keys.length === 0) {
        return [];
      }
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const rawResults = await Promise.all(keys.map((key) => idbRequestToPromise(store.get(key))));
      await idbTransactionToPromise(tx);
      return rawResults.map((raw) => normalizeAiArtifactRecord(raw));
    },
    async putArtifact(record) {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readwrite");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      store.put(cloneValue(record));
      await idbTransactionToPromise(tx);
    },
    async putArtifactsMany(records) {
      if (records.length === 0) {
        return;
      }
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readwrite");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      for (const record of records) {
        store.put(cloneValue(record));
      }
      await idbTransactionToPromise(tx);
    },
    async deleteArtifacts(keys) {
      if (keys.length === 0) {
        return;
      }
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readwrite");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      for (const key of keys) {
        store.delete(key);
      }
      await idbTransactionToPromise(tx);
    },
    async getArtifactsByFamily(family) {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const rawAll =
        typeof store.index === "function" &&
        store.indexNames.contains(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED) &&
        typeof IDBKeyRange !== "undefined" &&
        typeof IDBKeyRange.bound === "function"
          ? await idbRequestToPromise(
              store
                .index(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED)
                .getAll(IDBKeyRange.bound([family, Number.NEGATIVE_INFINITY], [family, Number.POSITIVE_INFINITY]))
            )
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { family?: unknown } | null)?.family === family
            );
      await idbTransactionToPromise(tx);
      return normalizeArtifactList(rawAll);
    },
    async getArtifactsByFamilyBvid(family, bvid) {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const rawAll =
        typeof store.index === "function" && store.indexNames.contains(AI_ARTIFACTS_INDEX_FAMILY_BVID)
          ? await idbRequestToPromise(store.index(AI_ARTIFACTS_INDEX_FAMILY_BVID).getAll([family, bvid]))
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) =>
                (item as { family?: unknown } | null)?.family === family &&
                (item as { bvid?: unknown } | null)?.bvid === bvid
            );
      await idbTransactionToPromise(tx);
      return normalizeArtifactList(rawAll);
    },
    async getArtifactsByBvid(bvid) {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const rawAll =
        typeof store.index === "function" && store.indexNames.contains(AI_ARTIFACTS_INDEX_BVID)
          ? await idbRequestToPromise(store.index(AI_ARTIFACTS_INDEX_BVID).getAll(bvid))
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { bvid?: unknown } | null)?.bvid === bvid
            );
      await idbTransactionToPromise(tx);
      return normalizeArtifactList(rawAll);
    },
    async getAllArtifacts() {
      const db = await openDb();
      const tx = db.transaction(AI_ARTIFACTS_IDB_STORE, "readonly");
      const store = tx.objectStore(AI_ARTIFACTS_IDB_STORE);
      const rawAll = await idbRequestToPromise(store.getAll());
      await idbTransactionToPromise(tx);
      return normalizeArtifactList(rawAll);
    },

    async getChatImage(id) {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const raw = await idbRequestToPromise(store.get(id));
      await idbTransactionToPromise(tx);
      return normalizeChatImageRecord(raw);
    },
    async getChatImagesMany(ids) {
      if (ids.length === 0) {
        return [];
      }
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const rawResults = await Promise.all(ids.map((id) => idbRequestToPromise(store.get(id))));
      await idbTransactionToPromise(tx);
      return rawResults.map((raw) => normalizeChatImageRecord(raw));
    },
    async putChatImage(record) {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readwrite");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      store.put(cloneValue(record));
      await idbTransactionToPromise(tx);
    },
    async putChatImagesMany(records) {
      if (records.length === 0) {
        return;
      }
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readwrite");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      for (const record of records) {
        store.put(cloneValue(record));
      }
      await idbTransactionToPromise(tx);
    },
    async deleteChatImages(ids) {
      if (ids.length === 0) {
        return;
      }
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readwrite");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      for (const id of ids) {
        store.delete(id);
      }
      await idbTransactionToPromise(tx);
    },
    async getChatImagesByConversationId(conversationId) {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const rawAll =
        typeof store.index === "function" && store.indexNames.contains(CHAT_IMAGES_INDEX_CONVERSATION_ID)
          ? await idbRequestToPromise(store.index(CHAT_IMAGES_INDEX_CONVERSATION_ID).getAll(conversationId))
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { conversationId?: unknown } | null)?.conversationId === conversationId
            );
      await idbTransactionToPromise(tx);
      return normalizeChatImageList(rawAll);
    },
    async getRawChatImageIdsByConversationId(conversationId) {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const rawAll =
        typeof store.index === "function" && store.indexNames.contains(CHAT_IMAGES_INDEX_CONVERSATION_ID)
          ? await idbRequestToPromise(store.index(CHAT_IMAGES_INDEX_CONVERSATION_ID).getAll(conversationId))
          : ((await idbRequestToPromise(store.getAll())) as unknown[]).filter(
              (item) => (item as { conversationId?: unknown } | null)?.conversationId === conversationId
            );
      await idbTransactionToPromise(tx);
      const ids: string[] = [];
      for (const raw of Array.isArray(rawAll) ? rawAll : []) {
        const ref = extractRawChatImageRef(raw);
        if (ref?.id) {
          ids.push(ref.id);
        }
      }
      return ids;
    },
    async getAllChatImages() {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const rawAll = await idbRequestToPromise(store.getAll());
      await idbTransactionToPromise(tx);
      return normalizeChatImageList(rawAll);
    },
    async getAllRawChatImageRefs() {
      const db = await openDb();
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readonly");
      const store = tx.objectStore(CHAT_IMAGES_IDB_STORE);
      const rawAll = await idbRequestToPromise(store.getAll());
      await idbTransactionToPromise(tx);
      const refs: RawChatImageRef[] = [];
      for (const raw of Array.isArray(rawAll) ? rawAll : []) {
        const ref = extractRawChatImageRef(raw);
        if (ref) {
          refs.push(ref);
        }
      }
      return refs;
    },
    async clearChatImages() {
      const db = await openDb();
      if (!db.objectStoreNames.contains(CHAT_IMAGES_IDB_STORE)) {
        return;
      }
      const tx = db.transaction(CHAT_IMAGES_IDB_STORE, "readwrite");
      tx.objectStore(CHAT_IMAGES_IDB_STORE).clear();
      await idbTransactionToPromise(tx);
    },

    async clearAll() {
      const db = await openDb();
      const storesToClear = [SUBTITLE_IDB_STORE, AI_ARTIFACTS_IDB_STORE, CHAT_IMAGES_IDB_STORE].filter((name) =>
        db.objectStoreNames.contains(name)
      );
      if (storesToClear.length === 0) {
        return;
      }
      const tx = db.transaction(storesToClear, "readwrite");
      for (const storeName of storesToClear) {
        tx.objectStore(storeName).clear();
      }
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
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_SUBTITLE_CACHE_MAX_BYTES));
  const maxChatImageBytes = Math.max(
    1,
    Math.floor(options.maxChatImageBytes ?? DEFAULT_CHAT_IMAGES_MAX_BYTES)
  );
  const now = options.now ?? (() => Date.now());
  const backend = selectBackend(options);
  const keepVideosMap: Record<AiArtifactFamily, number> = {
    ...AI_ARTIFACT_FAMILY_KEEP_VIDEOS,
    ...(options.aiArtifactKeepVideos ?? {})
  };
  let writeInterceptor: SubtitleStoreWriteInterceptor | null = null;
  let opQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = opQueue.then(task, task);
    opQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function evictSubtitlePagesIfNeeded(
    protectedId: string
  ): Promise<{ evictedIds: string[]; evictedArtifactKeys: string[] }> {
    const all = await backend.getAllPages();
    let totalCount = all.length;
    let totalBytes = all.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    if (totalCount <= maxEntries && totalBytes <= maxBytes) {
      return { evictedIds: [], evictedArtifactKeys: [] };
    }

    const candidates = all
      .filter((item) => item.id !== protectedId)
      .sort((a, b) => {
        if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      });

    const evictedRecords: SubtitlePageRecord[] = [];
    for (const candidate of candidates) {
      if (totalCount <= maxEntries && totalBytes <= maxBytes) {
        break;
      }
      evictedRecords.push(candidate);
      totalCount -= 1;
      totalBytes -= Number(candidate.estimatedBytes) || 0;
    }

    const evictedIds = evictedRecords.map((item) => item.id);
    if (evictedIds.length === 0) {
      return { evictedIds: [], evictedArtifactKeys: [] };
    }

    await backend.deletePages(evictedIds);

    const evictedBvids = new Set(evictedRecords.map((item) => item.bvid).filter(Boolean));
    const evictedArtifactKeys: string[] = [];
    for (const evictedBvid of evictedBvids) {
      const remainingPages = await backend.getPagesByBvid(evictedBvid);
      if (remainingPages.length > 0) {
        continue;
      }
      const artifacts = await backend.getArtifactsByBvid(evictedBvid);
      if (artifacts.length > 0) {
        const keys = artifacts.map((art) => art.key);
        await backend.deleteArtifacts(keys);
        evictedArtifactKeys.push(...keys);
      }
    }

    return { evictedIds, evictedArtifactKeys };
  }

  async function evictAiArtifactsForFamily(
    family: AiArtifactFamily,
    protectedBvid: string
  ): Promise<string[]> {
    const keepVideos = Math.max(1, Math.floor(Number(keepVideosMap[family]) || AI_ARTIFACT_FAMILY_KEEP_VIDEOS[family]));
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
        if (existing.estimatedBytes > maxBytes) {
          return {
            ok: false,
            evictedIds: [],
            error: new Error(
              `Subtitle page ${pageId} (${existing.estimatedBytes} B) exceeds maxBytes (${maxBytes} B)`
            )
          };
        }
        await backend.putPage(existing);
        const { evictedIds, evictedArtifactKeys } = await evictSubtitlePagesIfNeeded(existing.id);
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
    async getPageRecord(bvid, cid) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
        if (!pageId) {
          return null;
        }
        return backend.getPage(pageId);
      });
    },

    async listPageRecords() {
      return enqueue(() => backend.getAllPages());
    },

    async getRawTrack(bvid, cid, trackKey) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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

    async putRawTrack({ bvid, cid, trackKey, lang, kind, items }) {
      const cleanTrackKey = String(trackKey || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || sanitized.length === 0) {
        return { ok: true, evictedIds: [] };
      }
      return writePageMutation(
        { op: "put-raw", pageId: buildSubtitlePageId(bvid, cid), bvid, cid, trackKey: cleanTrackKey },
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

    async getSegmentedTrack(bvid, cid, trackKey, segmentationSig) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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

    async putSegmentedTrack({ bvid, cid, trackKey, segmentationSig, items }) {
      const cleanTrackKey = String(trackKey || "").trim();
      const cleanSig = String(segmentationSig || "").trim();
      const sanitized = sanitizeMonolingualItems(items);
      if (!cleanTrackKey || !cleanSig || sanitized.length === 0) {
        return { ok: true, evictedIds: [] };
      }
      const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
      return writePageMutation(
        { op: "put-segmented", pageId: buildSubtitlePageId(bvid, cid), bvid, cid, trackKey: mapKey },
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

    async getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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
      sourceTrackKey,
      targetLang,
      translationSig,
      mode,
      items,
      replaceRange
    }) {
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
          pageId: buildSubtitlePageId(bvid, cid),
          bvid,
          cid,
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

    async deleteTrackEntry({ bvid, cid, tier, key }) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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

    async pruneAsrVariants({ bvid, cid, keepTrackKey = "" }) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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

    async clearTranslatedTracksForPage({ bvid, cid, sourceTrackKey }) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
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
        const bvid = String(input?.bvid ?? parsed?.bvid ?? "").trim();
        const cid = String(input?.cid ?? parsed?.cid ?? "").trim();
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
          const createdAt =
            Number.isFinite(Number(input.createdAt)) && Number(input.createdAt) > 0
              ? Number(input.createdAt)
              : existing?.createdAt && existing.createdAt > 0
                ? existing.createdAt
                : ts;
          const updatedAt =
            Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0
              ? Number(input.updatedAt)
              : ts;
          const lastUsedAt =
            Number.isFinite(Number(input.lastUsedAt)) && Number(input.lastUsedAt) > 0
              ? Number(input.lastUsedAt)
              : ts;
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
          await backend.putArtifact(record);
          const evictedKeys = await evictAiArtifactsForFamily(family, bvid);
          return {
            ok: true,
            evictedKeys,
            estimatedBytes: record.estimatedBytes
          };
        } catch (err) {
          return {
            ok: false,
            evictedKeys: [],
            error: err instanceof Error ? err : new Error(String(err))
          };
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
      keyPrefix = ""
    ): Promise<AiArtifactRecord[]> {
      return enqueue(async () => {
        const cleanBvid = String(bvid || "").trim();
        if (!isAiArtifactFamily(family) || !cleanBvid) {
          return [];
        }
        const prefix = String(keyPrefix || "");
        const records = await backend.getArtifactsByFamilyBvid(family, cleanBvid);
        const matched = prefix ? records.filter((rec) => rec.key.startsWith(prefix)) : records;
        if (matched.length > 0) {
          await touchArtifactsLastUsed(matched);
        }
        return matched.map(cloneValue);
      });
    },

    async listAiArtifactsByBvid(bvid: string): Promise<AiArtifactRecord[]> {
      return enqueue(async () => {
        const cleanBvid = String(bvid || "").trim();
        if (!cleanBvid) {
          return [];
        }
        return backend.getArtifactsByBvid(cleanBvid);
      });
    },

    async listAllAiArtifacts(): Promise<AiArtifactRecord[]> {
      return enqueue(() => backend.getAllArtifacts());
    },

    async clearVideo(bvid: string, cid?: string): Promise<ClearVideoResult> {
      return enqueue(async () => {
        const cleanBvid = String(bvid || "").trim();
        const cleanCid = cid !== undefined && cid !== null ? String(cid).trim() : "";
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
        const cleanBvid = String(input?.bvid ?? "").trim();
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
          const createdAt =
            Number.isFinite(Number(input.createdAt)) && Number(input.createdAt) > 0
              ? Number(input.createdAt)
              : existing?.createdAt && existing.createdAt > 0
                ? existing.createdAt
                : ts;
          const updatedAt =
            Number.isFinite(Number(input.updatedAt)) && Number(input.updatedAt) > 0
              ? Number(input.updatedAt)
              : ts;
          const lastUsedAt =
            Number.isFinite(Number(input.lastUsedAt)) && Number(input.lastUsedAt) > 0
              ? Number(input.lastUsedAt)
              : ts;
          const record: ChatImageRecord = {
            id: cleanId,
            conversationId: cleanConvId,
            bvid: cleanBvid,
            mime: cleanMime,
            data: cleanData,
            estimatedBytes: 0,
            createdAt,
            updatedAt,
            lastUsedAt
          };
          record.estimatedBytes = estimateChatImageRecordBytes(record);
          if (record.estimatedBytes > maxChatImageBytes) {
            return {
              ok: false,
              evictedIds: [],
              error: new Error(
                `Chat image ${cleanId} (${record.estimatedBytes} B) exceeds maxChatImageBytes (${maxChatImageBytes} B)`
              )
            };
          }
          await backend.putChatImage(record);
          const evictedIds = await evictChatImagesIfNeeded(cleanId);
          return {
            ok: true,
            evictedIds,
            estimatedBytes: record.estimatedBytes
          };
        } catch (err) {
          return {
            ok: false,
            evictedIds: [],
            error: err instanceof Error ? err : new Error(String(err))
          };
        }
      });
    },

    async deleteChatImages(ids: string[]): Promise<string[]> {
      return enqueue(async () => {
        const uniqueIds = Array.from(
          new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean))
        );
        if (uniqueIds.length === 0) {
          return [];
        }
        await backend.deleteChatImages(uniqueIds);
        return uniqueIds;
      });
    },

    async deleteChatImagesByConversationIds(conversationIds: string[]): Promise<string[]> {
      return enqueue(async () => {
        const uniqueConvIds = Array.from(
          new Set(
            (Array.isArray(conversationIds) ? conversationIds : [])
              .map((id) => String(id || "").trim())
              .filter(Boolean)
          )
        );
        if (uniqueConvIds.length === 0) {
          return [];
        }
        const idsToDelete = new Set<string>();
        for (const convId of uniqueConvIds) {
          const matchedIds = await backend.getRawChatImageIdsByConversationId(convId);
          for (const id of matchedIds) {
            idsToDelete.add(id);
          }
        }
        const removedIds = Array.from(idsToDelete);
        if (removedIds.length > 0) {
          await backend.deleteChatImages(removedIds);
        }
        return removedIds;
      });
    },

    async pruneChatImages(input: PruneChatImagesInput): Promise<string[]> {
      return enqueue(async () => {
        const validConvIds = new Set(
          (Array.isArray(input?.validConversationIds) ? input.validConversationIds : [])
            .map((id) => String(id || "").trim())
            .filter(Boolean)
        );
        const hasKeepIds = Array.isArray(input?.keepImageIds);
        const keepIds = hasKeepIds
          ? new Set(
              (input.keepImageIds ?? [])
                .map((id) => String(id || "").trim())
                .filter(Boolean)
            )
          : null;

        const allRefs = await backend.getAllRawChatImageRefs();
        const orphanIds: string[] = [];
        for (const ref of allRefs) {
          const convInvalid = !ref.conversationId || !validConvIds.has(ref.conversationId);
          const refInvalid = keepIds !== null && !keepIds.has(ref.id);
          if (convInvalid || refInvalid) {
            orphanIds.push(ref.id);
          }
        }
        if (orphanIds.length > 0) {
          await backend.deleteChatImages(orphanIds);
        }
        return orphanIds;
      });
    },

    async clearAllChatImages(): Promise<string[]> {
      return enqueue(async () => {
        const allRefs = await backend.getAllRawChatImageRefs();
        const removedIds = allRefs.map((ref) => ref.id);
        await backend.clearChatImages();
        return removedIds;
      });
    },

    async listChatImagesByConversationId(conversationId: string): Promise<ChatImageRecord[]> {
      return enqueue(async () => {
        const cleanConvId = String(conversationId || "").trim();
        if (!cleanConvId) {
          return [];
        }
        return backend.getChatImagesByConversationId(cleanConvId);
      });
    },

    async listAllChatImages(): Promise<ChatImageRecord[]> {
      return enqueue(() => backend.getAllChatImages());
    },

    async clearAll() {
      writeInterceptor = null;
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
