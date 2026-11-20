// extension/notes/highlights-store.ts
// 按视频维度持久化用户划词「高亮存笔记」条目（落 chrome.storage.local，不占 sync 配额）。

export type NoteHighlightSource = "subtitle" | "overview";

export interface NoteHighlightItem {
  id: string;
  text: string;
  /** 条目关联的视频秒数；概览全片简介等无时间戳来源为 null */
  from: number | null;
  source: NoteHighlightSource;
  /** 字幕句在当前字幕体中的下标（用于字幕列表原位高亮标示） */
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
const MAX_VIDEO_BUCKETS = 120;
const MAX_HIGHLIGHTS_PER_VIDEO = 200;

interface VideoHighlightBucket {
  updatedAt: number;
  items: NoteHighlightItem[];
}

type HighlightStoreMap = Record<string, VideoHighlightBucket>;

// 无 chrome.storage.local 的测试或受限环境降级到进程内内存表
let memoryFallbackStore: HighlightStoreMap = {};

function hasLocalStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);
}

export function resolveHighlightVideoKey(bvid?: unknown, url?: unknown): string {
  const cleanBvid = String(bvid || "").trim();
  if (cleanBvid) {
    return cleanBvid;
  }
  const rawUrl = String(url || "").trim();
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
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const text = String(item.text || "").trim();
  const id = String(item.id || "").trim();
  if (!text || !id) {
    return null;
  }
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

function normalizeStoreMap(raw: unknown): HighlightStoreMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: HighlightStoreMap = {};
  for (const [key, bucket] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !bucket || typeof bucket !== "object") {
      continue;
    }
    const record = bucket as Record<string, unknown>;
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const items = rawItems
      .map(normalizeHighlightItem)
      .filter((entry): entry is NoteHighlightItem => entry !== null)
      .slice(-MAX_HIGHLIGHTS_PER_VIDEO);
    if (items.length === 0) {
      continue;
    }
    const updatedAt = Number(record.updatedAt) || items[items.length - 1].createdAt;
    result[key] = { updatedAt, items };
  }
  return result;
}

function pruneStoreMap(store: HighlightStoreMap): HighlightStoreMap {
  const entries = Object.entries(store);
  if (entries.length <= MAX_VIDEO_BUCKETS) {
    return store;
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_VIDEO_BUCKETS));
}

async function readStoreMap(): Promise<HighlightStoreMap> {
  if (!hasLocalStorage()) {
    return normalizeStoreMap(memoryFallbackStore);
  }
  try {
    const data = await chrome.storage.local.get(NOTE_HIGHLIGHTS_STORAGE_KEY);
    return normalizeStoreMap(data?.[NOTE_HIGHLIGHTS_STORAGE_KEY]);
  } catch {
    return {};
  }
}

async function writeStoreMap(store: HighlightStoreMap): Promise<void> {
  const pruned = pruneStoreMap(store);
  if (!hasLocalStorage()) {
    memoryFallbackStore = pruned;
    return;
  }
  await chrome.storage.local.set({ [NOTE_HIGHLIGHTS_STORAGE_KEY]: pruned });
}

function createHighlightId(): string {
  return `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSameHighlight(existing: NoteHighlightItem, candidate: AddNoteHighlightInput): boolean {
  if (existing.text !== candidate.text.trim()) {
    return false;
  }
  if (existing.source !== candidate.source) {
    return false;
  }
  if (existing.from === null && candidate.from === null) {
    return true;
  }
  if (existing.from !== null && candidate.from !== null) {
    return Math.abs(existing.from - candidate.from) < 0.5;
  }
  return false;
}

export async function loadVideoHighlights(videoKey: string): Promise<NoteHighlightItem[]> {
  const key = String(videoKey || "").trim();
  if (!key) {
    return [];
  }
  const store = await readStoreMap();
  return store[key]?.items ? store[key].items.map((item) => ({ ...item })) : [];
}

export async function addVideoHighlight(
  videoKey: string,
  input: AddNoteHighlightInput
): Promise<{ item: NoteHighlightItem | null; added: boolean; items: NoteHighlightItem[] }> {
  const key = String(videoKey || "").trim();
  const text = String(input.text || "").trim();
  if (!key || !text) {
    return { item: null, added: false, items: [] };
  }
  const store = await readStoreMap();
  const current = store[key]?.items ?? [];
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
  store[key] = { updatedAt: now, items: nextItems };
  await writeStoreMap(store);
  return { item: created, added: true, items: nextItems.map((item) => ({ ...item })) };
}

export async function removeVideoHighlight(
  videoKey: string,
  highlightId: string
): Promise<{ removed: boolean; items: NoteHighlightItem[] }> {
  const key = String(videoKey || "").trim();
  const targetId = String(highlightId || "").trim();
  if (!key || !targetId) {
    return { removed: false, items: [] };
  }
  const store = await readStoreMap();
  const current = store[key]?.items ?? [];
  const nextItems = current.filter((item) => item.id !== targetId);
  if (nextItems.length === current.length) {
    return { removed: false, items: current.map((item) => ({ ...item })) };
  }
  if (nextItems.length === 0) {
    delete store[key];
  } else {
    store[key] = { updatedAt: Date.now(), items: nextItems };
  }
  await writeStoreMap(store);
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
  const store = await readStoreMap();
  const current = store[key]?.items ?? [];
  const nextItems = current.filter(
    (item) => !(item.source === "subtitle" && item.subtitleIndex === subtitleIndex)
  );
  const removedCount = current.length - nextItems.length;
  if (removedCount === 0) {
    return { removedCount: 0, items: current.map((item) => ({ ...item })) };
  }
  if (nextItems.length === 0) {
    delete store[key];
  } else {
    store[key] = { updatedAt: Date.now(), items: nextItems };
  }
  await writeStoreMap(store);
  return { removedCount, items: nextItems.map((item) => ({ ...item })) };
}

export function resetHighlightMemoryStoreForTests(): void {
  memoryFallbackStore = {};
}
