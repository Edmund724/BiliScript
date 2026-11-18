// extension/subtitle/favorite-words.ts
// 本地生词本持久化（chrome.storage.local 独立键 biliscript_favorite_words_v1）、
// 去重排序（上限 5000 条）与 CSV / Anki TSV 导出。

import { formatClock } from "../shared/clock-text.js";

export const FAVORITE_WORDS_STORAGE_KEY = "biliscript_favorite_words_v1";
export const MAX_FAVORITE_WORDS = 5000;

export interface FavoriteWordRecord {
  id: string;
  word: string;
  phonetic: string;
  defs: string[];
  contextMeaning: string;
  bvid: string;
  videoTitle: string;
  sentence: string;
  translation: string;
  from: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaveFavoriteWordInput {
  word: string;
  phonetic?: string;
  defs?: string[];
  contextMeaning?: string;
  bvid?: string;
  videoTitle?: string;
  sentence?: string;
  translation?: string;
  from?: number;
  now?: number;
}

export interface FavoriteWordsStorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const memoryFallbackStore = new Map<string, unknown>();

const defaultStorageAdapter: FavoriteWordsStorageAdapter = {
  async get(key: string): Promise<unknown> {
    if (typeof chrome !== "undefined" && chrome.storage?.local?.get) {
      const data = await chrome.storage.local.get(key);
      return data?.[key];
    }
    return memoryFallbackStore.get(key);
  },
  async set(key: string, value: unknown): Promise<void> {
    if (typeof chrome !== "undefined" && chrome.storage?.local?.set) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    memoryFallbackStore.set(key, value);
  }
};

type FavoriteWordsListener = (records: FavoriteWordRecord[]) => void;
const listeners = new Set<FavoriteWordsListener>();

export function subscribeFavoriteWordsChange(listener: FavoriteWordsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitFavoriteWordsChange(records: FavoriteWordRecord[]): void {
  for (const listener of listeners) {
    try {
      listener(records);
    } catch {
      // 监听异常不阻断存储主路径
    }
  }
}

export function normalizeFavoriteWordId(word: unknown): string {
  return String(word ?? "").trim().toLowerCase();
}

function sanitizeDefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function normalizeRecord(raw: unknown): FavoriteWordRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const word = String(obj.word ?? "").trim();
  const id = normalizeFavoriteWordId(obj.id || word);
  if (!id || !word) {
    return null;
  }
  const fromRaw = Number(obj.from ?? 0);
  const createdAtRaw = Number(obj.createdAt ?? 0);
  const updatedAtRaw = Number(obj.updatedAt ?? createdAtRaw);
  return {
    id,
    word,
    phonetic: String(obj.phonetic ?? "").trim(),
    defs: sanitizeDefs(obj.defs),
    contextMeaning: String(obj.contextMeaning ?? "").trim(),
    bvid: String(obj.bvid ?? "").trim(),
    videoTitle: String(obj.videoTitle ?? "").trim(),
    sentence: String(obj.sentence ?? "").trim(),
    translation: String(obj.translation ?? "").trim(),
    from: Number.isFinite(fromRaw) && fromRaw >= 0 ? fromRaw : 0,
    createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : Date.now(),
    updatedAt: Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now()
  };
}

export async function loadFavoriteWords(
  storage: FavoriteWordsStorageAdapter = defaultStorageAdapter
): Promise<FavoriteWordRecord[]> {
  const raw = await storage.get(FAVORITE_WORDS_STORAGE_KEY).catch(() => null);
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const list: FavoriteWordRecord[] = [];
  for (const item of raw) {
    const normalized = normalizeRecord(item);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    list.push(normalized);
    if (list.length >= MAX_FAVORITE_WORDS) {
      break;
    }
  }
  return list;
}

export async function saveFavoriteWord(
  input: SaveFavoriteWordInput,
  storage: FavoriteWordsStorageAdapter = defaultStorageAdapter
): Promise<{ saved: FavoriteWordRecord; list: FavoriteWordRecord[]; updated: boolean }> {
  const word = String(input.word ?? "").trim();
  const id = normalizeFavoriteWordId(word);
  if (!id) {
    throw new Error("生词不能为空");
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const existing = await loadFavoriteWords(storage);
  const prev = existing.find((item) => item.id === id) ?? null;

  const saved: FavoriteWordRecord = {
    id,
    word,
    phonetic: String(input.phonetic ?? prev?.phonetic ?? "").trim(),
    defs: input.defs !== undefined ? sanitizeDefs(input.defs) : (prev?.defs ?? []),
    contextMeaning: String(input.contextMeaning ?? prev?.contextMeaning ?? "").trim(),
    bvid: String(input.bvid ?? prev?.bvid ?? "").trim(),
    videoTitle: String(input.videoTitle ?? prev?.videoTitle ?? "").trim(),
    sentence: String(input.sentence ?? prev?.sentence ?? "").trim(),
    translation: String(input.translation ?? prev?.translation ?? "").trim(),
    from: Number.isFinite(Number(input.from)) ? Math.max(0, Number(input.from)) : (prev?.from ?? 0),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now
  };

  const next = [saved, ...existing.filter((item) => item.id !== id)].slice(0, MAX_FAVORITE_WORDS);
  await storage.set(FAVORITE_WORDS_STORAGE_KEY, next);
  emitFavoriteWordsChange(next);
  return { saved, list: next, updated: Boolean(prev) };
}

export async function removeFavoriteWord(
  wordOrId: string,
  storage: FavoriteWordsStorageAdapter = defaultStorageAdapter
): Promise<FavoriteWordRecord[]> {
  const targetId = normalizeFavoriteWordId(wordOrId);
  if (!targetId) {
    return loadFavoriteWords(storage);
  }
  const existing = await loadFavoriteWords(storage);
  const next = existing.filter((item) => item.id !== targetId);
  if (next.length !== existing.length) {
    await storage.set(FAVORITE_WORDS_STORAGE_KEY, next);
    emitFavoriteWordsChange(next);
  }
  return next;
}

export async function clearFavoriteWords(
  storage: FavoriteWordsStorageAdapter = defaultStorageAdapter
): Promise<void> {
  await storage.set(FAVORITE_WORDS_STORAGE_KEY, []);
  emitFavoriteWordsChange([]);
}

export async function isFavoriteWord(
  word: string,
  storage: FavoriteWordsStorageAdapter = defaultStorageAdapter
): Promise<boolean> {
  const targetId = normalizeFavoriteWordId(word);
  if (!targetId) {
    return false;
  }
  const existing = await loadFavoriteWords(storage);
  return existing.some((item) => item.id === targetId);
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function formatSavedTime(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return "";
  }
}

export function buildFavoriteWordsCsv(records: readonly FavoriteWordRecord[]): string {
  const header = [
    "Word",
    "Phonetic",
    "Definitions",
    "ContextMeaning",
    "Sentence",
    "Translation",
    "VideoTitle",
    "BVID",
    "Timestamp",
    "SavedAt"
  ].join(",");

  const rows = (records || []).map((item) =>
    [
      item.word,
      item.phonetic,
      item.defs.join("; "),
      item.contextMeaning,
      item.sentence,
      item.translation,
      item.videoTitle,
      item.bvid,
      formatClock(item.from, { hours: "auto" }),
      formatSavedTime(item.updatedAt || item.createdAt)
    ]
      .map(escapeCsvCell)
      .join(",")
  );

  return `\uFEFF${[header, ...rows].join("\r\n")}`;
}

function sanitizeTsvCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function buildFavoriteWordsAnkiTsv(records: readonly FavoriteWordRecord[]): string {
  const lines = ["#separator:tab", "#html:false"];
  for (const item of records || []) {
    const meaningParts = [
      item.phonetic,
      item.defs.join("; "),
      item.contextMeaning ? `语境：${item.contextMeaning}` : ""
    ].filter(Boolean);
    const contextParts = [
      item.sentence,
      item.translation
    ].filter(Boolean);
    const sourceLabel = [
      item.videoTitle || item.bvid,
      formatClock(item.from, { hours: "auto" })
    ]
      .filter(Boolean)
      .join(" @ ");
    lines.push(
      [
        sanitizeTsvCell(item.word),
        sanitizeTsvCell(meaningParts.join(" | ")),
        sanitizeTsvCell(contextParts.join(" / ")),
        sanitizeTsvCell(sourceLabel)
      ].join("\t")
    );
  }
  return lines.join("\n");
}
