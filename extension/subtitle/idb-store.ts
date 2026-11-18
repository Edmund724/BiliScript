// extension/subtitle/idb-store.ts
// 扩展源 IndexedDB 分层字幕仓库：
// - 主键：`${bvid}:${cid}`（视频分 P 唯一身份）
// - 单条分 P 记录内严格隔离三层轨道容器：
//   1) rawTracks：按归一化 trackKey 存储原生人工 CC / ai-* 原始轨 / asr 原始转写轨；
//   2) segmentedTracks：按 `${trackKey}:${segmentationSig}` 存储纯单语本地重断句轨；
//   3) translatedTracks：按 `${sourceTrackKey}->${targetLang}:${translationSig}` 增量合并存储 AI 译文轨；
// - 读命中刷新 lastUsed，写时执行「最大分 P 条目数（100）+ 累计估算体积（150 MB）」双上限 LRU 淘汰。

import type { SubtitleBodyItem } from "../ai/types.js";
import { isAsrVariantSourceKey } from "./source-key.js";

export const SUBTITLE_IDB_NAME = "biliscript-subtitle-store";
export const SUBTITLE_IDB_VERSION = 1;
export const SUBTITLE_IDB_STORE = "subtitle_pages";
export const SUBTITLE_IDB_LAST_USED_INDEX = "by_lastUsed";

export const DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES = 100;
export const DEFAULT_SUBTITLE_CACHE_MAX_BYTES = 150 * 1024 * 1024;

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

export interface PutRawTrackInput {
  bvid: string;
  cid: string;
  trackKey: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  items: readonly unknown[];
}

export interface PutSegmentedTrackInput {
  bvid: string;
  cid: string;
  trackKey: string;
  segmentationSig: string;
  items: readonly unknown[];
}

export interface UpsertTranslatedTrackInput {
  bvid: string;
  cid: string;
  sourceTrackKey: string;
  targetLang: string;
  translationSig: string;
  mode?: "boundary-v3" | "cc-json";
  items: readonly unknown[];
  replaceRange?: { from: number; to: number };
}

export interface DeleteTrackEntryInput {
  bvid: string;
  cid: string;
  tier: "rawTracks" | "segmentedTracks" | "translatedTracks";
  key: string;
}

export interface SubtitleStoreWriteResult {
  ok: boolean;
  evictedIds: string[];
  estimatedBytes?: number;
  error?: Error;
}

export interface SubtitleStoreWriteContext {
  op: "put-raw" | "put-segmented" | "upsert-translated";
  pageId: string;
  bvid: string;
  cid: string;
  trackKey: string;
}

export type SubtitleStoreWriteInterceptor = (
  ctx: SubtitleStoreWriteContext
) => Promise<void> | void;

export interface SubtitleIdbStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
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
  clearAll(): Promise<void>;
  setWriteInterceptorForTests(interceptor: SubtitleStoreWriteInterceptor | null): void;
}

const textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

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

/**
 * 过滤并深拷贝字幕条目（用于 rawTracks / segmentedTracks）。
 * 仅保留带有限数值时间戳与非空文本的条目。
 */
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
      item.words = candidate.words.map((w) => ({ ...(w as Record<string, unknown>) }));
    }
    result.push(item);
  }
  return result;
}

/**
 * 清洗译文条目：严格剔除空白译文或无效时间戳（绝不落空译文记录）。
 */
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

/**
 * 增量合并已落盘/已缓冲译文与新到达的流式译文：
 * - 若指定 replaceRange，先移除落在该时间区间内的旧译文再写入新块结果；
 * - 对相同时间轴键（from:to）以新译文覆盖旧译文，并保持按 from 升序排列。
 */
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

export function estimateSubtitleRecordBytes(record: SubtitlePageRecord): number {
  const json = JSON.stringify({
    ...record,
    estimatedBytes: 0
  });
  if (textEncoder) {
    return textEncoder.encode(json).byteLength;
  }
  return json.length * 2;
}

function cloneRecord(record: SubtitlePageRecord): SubtitlePageRecord {
  if (typeof structuredClone === "function") {
    return structuredClone(record);
  }
  return JSON.parse(JSON.stringify(record)) as SubtitlePageRecord;
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
  const id = String(candidate.id || buildSubtitlePageId(String(candidate.bvid || ""), String(candidate.cid || ""))).trim();
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

interface StorageBackend {
  getAll(): Promise<SubtitlePageRecord[]>;
  get(id: string): Promise<SubtitlePageRecord | null>;
  put(record: SubtitlePageRecord): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

function createMemoryBackend(): StorageBackend {
  const map = new Map<string, SubtitlePageRecord>();
  return {
    async getAll() {
      return Array.from(map.values()).map(cloneRecord);
    },
    async get(id) {
      const hit = map.get(id);
      return hit ? cloneRecord(hit) : null;
    },
    async put(record) {
      map.set(record.id, cloneRecord(record));
    },
    async deleteMany(ids) {
      for (const id of ids) {
        map.delete(id);
      }
    },
    async clear() {
      map.clear();
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
        const store = db.objectStoreNames.contains(SUBTITLE_IDB_STORE)
          ? req.transaction!.objectStore(SUBTITLE_IDB_STORE)
          : db.createObjectStore(SUBTITLE_IDB_STORE, { keyPath: "id" });
        if (!store.indexNames.contains(SUBTITLE_IDB_LAST_USED_INDEX)) {
          store.createIndex(SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed", { unique: false });
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
    async getAll() {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readonly");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const rawAll = await idbRequestToPromise(store.getAll());
      await idbTransactionToPromise(tx);
      const list: SubtitlePageRecord[] = [];
      for (const raw of Array.isArray(rawAll) ? rawAll : []) {
        const normalized = normalizePageRecord(raw);
        if (normalized) {
          list.push(normalized);
        }
      }
      return list;
    },
    async get(id) {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readonly");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      const raw = await idbRequestToPromise(store.get(id));
      await idbTransactionToPromise(tx);
      return normalizePageRecord(raw);
    },
    async put(record) {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readwrite");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      store.put(cloneRecord(record));
      await idbTransactionToPromise(tx);
    },
    async deleteMany(ids) {
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
    async clear() {
      const db = await openDb();
      const tx = db.transaction(SUBTITLE_IDB_STORE, "readwrite");
      const store = tx.objectStore(SUBTITLE_IDB_STORE);
      store.clear();
      await idbTransactionToPromise(tx);
    }
  };
}

function selectBackend(options: SubtitleIdbStoreOptions): StorageBackend {
  const idb =
    options.indexedDB !== undefined
      ? options.indexedDB
      : typeof globalThis !== "undefined"
        ? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null
        : null;
  if (idb && typeof idb.open === "function") {
    return createIdbBackend(idb, options.dbName || SUBTITLE_IDB_NAME);
  }
  return createMemoryBackend();
}

export function createSubtitleIdbStore(options: SubtitleIdbStoreOptions = {}): SubtitleIdbStore {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_SUBTITLE_CACHE_MAX_BYTES));
  const now = options.now ?? (() => Date.now());
  const backend = selectBackend(options);
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

  async function evictIfNeeded(protectedId: string): Promise<string[]> {
    const all = await backend.getAll();
    let totalCount = all.length;
    let totalBytes = all.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    if (totalCount <= maxEntries && totalBytes <= maxBytes) {
      return [];
    }

    const candidates = all
      .filter((item) => item.id !== protectedId)
      .sort((a, b) => {
        if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id.localeCompare(b.id);
      });

    const evictedIds: string[] = [];
    for (const candidate of candidates) {
      if (totalCount <= maxEntries && totalBytes <= maxBytes) {
        break;
      }
      evictedIds.push(candidate.id);
      totalCount -= 1;
      totalBytes -= Number(candidate.estimatedBytes) || 0;
    }

    if (evictedIds.length > 0) {
      await backend.deleteMany(evictedIds);
    }
    return evictedIds;
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
        const existing = (await backend.get(pageId)) ?? createEmptyPageRecord(ctx.bvid, ctx.cid, ts);
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
        await backend.put(existing);
        const evictedIds = await evictIfNeeded(existing.id);
        return { ok: true, evictedIds, estimatedBytes: existing.estimatedBytes };
      } catch (err) {
        return {
          ok: false,
          evictedIds: [],
          error: err instanceof Error ? err : new Error(String(err))
        };
      }
    });
  }

  async function touchLastUsed(record: SubtitlePageRecord): Promise<void> {
    record.lastUsed = now();
    await backend.put(record);
  }

  return {
    async getPageRecord(bvid, cid) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
        if (!pageId) {
          return null;
        }
        return backend.get(pageId);
      });
    },

    async listPageRecords() {
      return enqueue(() => backend.getAll());
    },

    async getRawTrack(bvid, cid, trackKey) {
      return enqueue(async () => {
        const pageId = buildSubtitlePageId(bvid, cid);
        const key = String(trackKey || "").trim();
        if (!pageId || !key) {
          return null;
        }
        const record = await backend.get(pageId);
        const track = record?.rawTracks[key];
        if (!record || !track || !Array.isArray(track.items) || track.items.length === 0) {
          return null;
        }
        await touchLastUsed(record);
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
        const record = await backend.get(pageId);
        const mapKey = buildSegmentedTrackMapKey(cleanTrackKey, cleanSig);
        const entry = record?.segmentedTracks[mapKey];
        if (!record || !entry || !Array.isArray(entry.items) || entry.items.length === 0) {
          return null;
        }
        await touchLastUsed(record);
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
        const record = await backend.get(pageId);
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
        await touchLastUsed(record);
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
      // 严禁创建空译文记录
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
        const record = await backend.get(pageId);
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
          await backend.deleteMany([record.id]);
        } else {
          record.updatedAt = now();
          record.estimatedBytes = estimateSubtitleRecordBytes(record);
          await backend.put(record);
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
        const record = await backend.get(pageId);
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
            await backend.deleteMany([record.id]);
          } else {
            record.updatedAt = now();
            record.estimatedBytes = estimateSubtitleRecordBytes(record);
            await backend.put(record);
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
        const record = await backend.get(pageId);
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
            await backend.deleteMany([record.id]);
          } else {
            record.updatedAt = now();
            record.estimatedBytes = estimateSubtitleRecordBytes(record);
            await backend.put(record);
          }
        }
        return removed;
      });
    },

    async clearAll() {
      writeInterceptor = null;
      return enqueue(async () => {
        await backend.clear();
      });
    },

    setWriteInterceptorForTests(interceptor) {
      writeInterceptor = interceptor;
    }
  };
}

export const defaultSubtitleIdbStore = createSubtitleIdbStore();
