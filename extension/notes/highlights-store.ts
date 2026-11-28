import {
  decodeVideoStorageBvid,
  detectSiteFromUrl,
  encodeVideoStorageBvid,
  extractYoutubeVideoId,
  isEncodedYoutubeStorageBvid,
  normalizeSiteId,
  type SiteId
} from "../shared/site.js";
import {
  clearSharedMemoryNoteHighlightsForTests,
  type NoteHighlightBucketRecord,
  type SubtitleIdbStore
} from "../subtitle/idb-store.js";
import {
  registerSubtitleStoreResetHookForTests,
  resolveActiveSubtitleStore
} from "../subtitle/store-client.js";

export type NoteHighlightSource = "subtitle" | "overview";

export interface NoteHighlightItem {
  id: string;
  text: string;
  from: number | null;
  source: NoteHighlightSource;
  subtitleIndex?: number;
  createdAt: number;
}

export interface AddNoteHighlightInput {
  text: string;
  from: number | null;
  source: NoteHighlightSource;
  subtitleIndex?: number;
}

export const NOTE_HIGHLIGHTS_STORAGE_KEY = "biliscript_note_highlights_v1";
export const NOTE_HIGHLIGHTS_MIGRATED_META_KEY = "note_highlights_migrated_v1";
const MAX_HIGHLIGHTS_PER_VIDEO = 200;

let migratedStores = new WeakSet<SubtitleIdbStore>();
let inflightMigrations = new WeakMap<SubtitleIdbStore, Promise<void>>();

registerSubtitleStoreResetHookForTests(() => {
  migratedStores = new WeakSet<SubtitleIdbStore>();
  inflightMigrations = new WeakMap<SubtitleIdbStore, Promise<void>>();
});

function hasLocalStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);
}

export function resolveHighlightVideoKey(
  bvid?: unknown,
  url?: unknown,
  site?: SiteId | unknown
): string {
  const cleanBvid = String(bvid || "").trim();
  const rawUrl = String(url || "").trim();
  const ytIdFromUrl = rawUrl ? extractYoutubeVideoId(rawUrl) : "";
  const hasExplicitSite = site !== undefined && site !== null && String(site).trim() !== "";
  const effectiveSite: SiteId = hasExplicitSite
    ? normalizeSiteId(site)
    : isEncodedYoutubeStorageBvid(cleanBvid) ||
        Boolean(ytIdFromUrl) ||
        (Boolean(rawUrl) && detectSiteFromUrl(rawUrl) === "youtube")
      ? "youtube"
      : "bilibili";

  if (effectiveSite === "youtube") {
    const targetId = cleanBvid || ytIdFromUrl;
    return targetId ? encodeVideoStorageBvid("youtube", targetId) : "";
  }
  if (cleanBvid) {
    return cleanBvid;
  }
  if (!rawUrl) {
    return "";
  }
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function normalizeHighlightItem(raw: unknown): NoteHighlightItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const text = String(item.text || "").trim();
  const id = String(item.id || "").trim();
  if (!text || !id) return null;
  const fromNum = item.from === null || item.from === undefined ? null : Number(item.from);
  const from = fromNum !== null && Number.isFinite(fromNum) && fromNum >= 0 ? fromNum : null;
  const source: NoteHighlightSource = item.source === "overview" ? "overview" : "subtitle";
  const subtitleIndexNum =
    item.subtitleIndex === undefined || item.subtitleIndex === null ? undefined : Number(item.subtitleIndex);
  const subtitleIndex =
    subtitleIndexNum !== undefined && Number.isInteger(subtitleIndexNum) && subtitleIndexNum >= 0
      ? subtitleIndexNum
      : undefined;
  const createdAtNum = Number(item.createdAt);
  const createdAt = Number.isFinite(createdAtNum) && createdAtNum > 0 ? createdAtNum : Date.now();
  return {
    id,
    text,
    from,
    source,
    ...(subtitleIndex !== undefined ? { subtitleIndex } : {}),
    createdAt
  };
}

function inferBucketMeta(videoKey: string): { site: SiteId; bvid: string } {
  if (isEncodedYoutubeStorageBvid(videoKey)) {
    return { site: "youtube", bvid: decodeVideoStorageBvid(videoKey) };
  }
  return { site: "bilibili", bvid: videoKey.startsWith("http") ? "" : videoKey };
}

function normalizeLegacyBuckets(raw: unknown): NoteHighlightBucketRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const records: NoteHighlightBucketRecord[] = [];
  for (const [videoKey, bucket] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(videoKey || "").trim();
    if (!key || !bucket || typeof bucket !== "object") continue;
    const rec = bucket as Record<string, unknown>;
    const rawItems = Array.isArray(rec.items) ? rec.items : [];
    const items = rawItems
      .map(normalizeHighlightItem)
      .filter((entry): entry is NoteHighlightItem => entry !== null)
      .slice(-MAX_HIGHLIGHTS_PER_VIDEO);
    if (items.length === 0) continue;
    const updatedAt = Number(rec.updatedAt) || items[items.length - 1].createdAt;
    const meta = inferBucketMeta(key);
    records.push({
      videoKey: key,
      site: meta.site,
      bvid: meta.bvid,
      updatedAt,
      items
    });
  }
  return records;
}

async function ensureLegacyHighlightsMigrated(store: SubtitleIdbStore): Promise<void> {
  if (migratedStores.has(store)) return;
  if (!hasLocalStorage()) {
    migratedStores.add(store);
    return;
  }
  const inflight = inflightMigrations.get(store);
  if (inflight) {
    await inflight;
    return;
  }
  const task = (async () => {
    const marker = await store.getStoreMeta<{ done?: boolean }>(NOTE_HIGHLIGHTS_MIGRATED_META_KEY).catch(() => null);
    if (marker && marker.done === true) {
      migratedStores.add(store);
      return;
    }
    let legacyRecords: NoteHighlightBucketRecord[] = [];
    let hasLegacyKey = false;
    if (hasLocalStorage()) {
      try {
        const data = await chrome.storage.local.get(NOTE_HIGHLIGHTS_STORAGE_KEY);
        if (data && Object.prototype.hasOwnProperty.call(data, NOTE_HIGHLIGHTS_STORAGE_KEY)) {
          hasLegacyKey = true;
          legacyRecords = normalizeLegacyBuckets(data[NOTE_HIGHLIGHTS_STORAGE_KEY]);
        }
      } catch {
      }
    }
    const mergedRecords: NoteHighlightBucketRecord[] = [];
    for (const legacy of legacyRecords) {
      const existing = await store.getNoteHighlights(legacy.videoKey).catch(() => null);
      if (existing && existing.items.length > 0) {
        const seen = new Set(existing.items.map((item) => item.id));
        const mergedItems = [
          ...legacy.items.filter((item) => !seen.has(item.id)),
          ...existing.items
        ].slice(-MAX_HIGHLIGHTS_PER_VIDEO);
        mergedRecords.push({
          ...existing,
          updatedAt: Math.max(existing.updatedAt, legacy.updatedAt),
          items: mergedItems
        });
      } else {
        mergedRecords.push(legacy);
      }
    }
    await store.putNoteHighlightsMany(mergedRecords, NOTE_HIGHLIGHTS_MIGRATED_META_KEY, {
      done: true,
      migratedAt: Date.now()
    });
    if (hasLegacyKey && hasLocalStorage()) {
      await chrome.storage.local.remove(NOTE_HIGHLIGHTS_STORAGE_KEY).catch(() => {});
    }
    migratedStores.add(store);
  })();
  inflightMigrations.set(store, task);
  try {
    await task;
  } finally {
    if (inflightMigrations.get(store) === task) {
      inflightMigrations.delete(store);
    }
  }
}

function createHighlightId(): string {
  return `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSameHighlight(existing: NoteHighlightItem, candidate: AddNoteHighlightInput): boolean {
  if (existing.text !== candidate.text.trim()) return false;
  if (existing.source !== candidate.source) return false;
  if (existing.from === null && candidate.from === null) return true;
  if (existing.from !== null && candidate.from !== null) return Math.abs(existing.from - candidate.from) < 0.5;
  return false;
}

function normalizeBucketItems(bucket: NoteHighlightBucketRecord | null): NoteHighlightItem[] {
  if (!bucket || !Array.isArray(bucket.items)) return [];
  return bucket.items
    .map(normalizeHighlightItem)
    .filter((entry): entry is NoteHighlightItem => entry !== null);
}

export async function loadVideoHighlights(videoKey: string): Promise<NoteHighlightItem[]> {
  const key = String(videoKey || "").trim();
  if (!key) return [];
  const store = resolveActiveSubtitleStore();
  await ensureLegacyHighlightsMigrated(store);
  const bucket = await store.getNoteHighlights(key);
  return normalizeBucketItems(bucket).map((item) => ({ ...item }));
}

export async function addVideoHighlight(
  videoKey: string,
  input: AddNoteHighlightInput
): Promise<{ item: NoteHighlightItem | null; added: boolean; items: NoteHighlightItem[] }> {
  const key = String(videoKey || "").trim();
  const text = String(input.text || "").trim();
  if (!key || !text) return { item: null, added: false, items: [] };
  const store = resolveActiveSubtitleStore();
  await ensureLegacyHighlightsMigrated(store);
  const current = normalizeBucketItems(await store.getNoteHighlights(key));
  const normalizedInput: AddNoteHighlightInput = {
    text,
    from: input.from !== null && Number.isFinite(input.from) && input.from >= 0 ? input.from : null,
    source: input.source === "overview" ? "overview" : "subtitle",
    subtitleIndex:
      input.subtitleIndex !== undefined && Number.isInteger(input.subtitleIndex) && input.subtitleIndex >= 0
        ? input.subtitleIndex
        : undefined
  };

  const duplicate = current.find((entry) => isSameHighlight(entry, normalizedInput));
  if (duplicate) {
    return { item: { ...duplicate }, added: false, items: current.map((item) => ({ ...item })) };
  }

  const now = Date.now();
  const created: NoteHighlightItem = {
    id: createHighlightId(),
    text: normalizedInput.text,
    from: normalizedInput.from,
    source: normalizedInput.source,
    ...(normalizedInput.subtitleIndex !== undefined ? { subtitleIndex: normalizedInput.subtitleIndex } : {}),
    createdAt: now
  };
  const nextItems = [...current, created].slice(-MAX_HIGHLIGHTS_PER_VIDEO);
  const meta = inferBucketMeta(key);
  await store.putNoteHighlights({
    videoKey: key,
    site: meta.site,
    bvid: meta.bvid,
    updatedAt: now,
    items: nextItems
  });
  return { item: created, added: true, items: nextItems.map((item) => ({ ...item })) };
}

export async function removeVideoHighlight(
  videoKey: string,
  highlightId: string
): Promise<{ removed: boolean; items: NoteHighlightItem[] }> {
  const key = String(videoKey || "").trim();
  const targetId = String(highlightId || "").trim();
  if (!key || !targetId) return { removed: false, items: [] };
  const store = resolveActiveSubtitleStore();
  await ensureLegacyHighlightsMigrated(store);
  const current = normalizeBucketItems(await store.getNoteHighlights(key));
  const nextItems = current.filter((item) => item.id !== targetId);
  if (nextItems.length === current.length) {
    return { removed: false, items: current.map((item) => ({ ...item })) };
  }
  if (nextItems.length === 0) {
    await store.deleteNoteHighlights(key);
  } else {
    const meta = inferBucketMeta(key);
    await store.putNoteHighlights({
      videoKey: key,
      site: meta.site,
      bvid: meta.bvid,
      updatedAt: Date.now(),
      items: nextItems
    });
  }
  return { removed: true, items: nextItems.map((item) => ({ ...item })) };
}

export async function removeSubtitleIndexHighlights(
  videoKey: string,
  subtitleIndex: number
): Promise<{ removedCount: number; items: NoteHighlightItem[] }> {
  const key = String(videoKey || "").trim();
  if (!key || !Number.isInteger(subtitleIndex) || subtitleIndex < 0) {
    return { removedCount: 0, items: [] };
  }
  const store = resolveActiveSubtitleStore();
  await ensureLegacyHighlightsMigrated(store);
  const current = normalizeBucketItems(await store.getNoteHighlights(key));
  const nextItems = current.filter(
    (item) => !(item.source === "subtitle" && item.subtitleIndex === subtitleIndex)
  );
  const removedCount = current.length - nextItems.length;
  if (removedCount === 0) {
    return { removedCount: 0, items: current.map((item) => ({ ...item })) };
  }
  if (nextItems.length === 0) {
    await store.deleteNoteHighlights(key);
  } else {
    const meta = inferBucketMeta(key);
    await store.putNoteHighlights({
      videoKey: key,
      site: meta.site,
      bvid: meta.bvid,
      updatedAt: Date.now(),
      items: nextItems
    });
  }
  return { removedCount, items: nextItems.map((item) => ({ ...item })) };
}

export function resetHighlightMemoryStoreForTests(): void {
  migratedStores = new WeakSet<SubtitleIdbStore>();
  inflightMigrations = new WeakMap<SubtitleIdbStore, Promise<void>>();
  clearSharedMemoryNoteHighlightsForTests();
}
