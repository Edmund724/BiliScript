import type { NormalizedSearchResult } from "./adapters/types.js";

export const SEARCH_CACHE_KEY = "biliscript_search_cache";
export const SEARCH_CACHE_TTL_MS = 300000;
export const SEARCH_CACHE_MAX_ENTRIES = 50;

export interface SearchCacheEntry {
  results: NormalizedSearchResult[];
  platform: string;
  ts: number;
}

export interface SearchCacheEntryView {
  results: NormalizedSearchResult[];
  platform: string;
}

type SearchCacheMap = Record<string, SearchCacheEntry>;

const HASH_LANES = [
  { seed: 0x811c9dc5, prime: 0x01000193 },
  { seed: 0x9e3779b9, prime: 0x85ebca6b }
] as const;

export function normalizeSearchCacheQuery(query: unknown): string {
  return String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hash32(input: string, seed: number, prime: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash ^ input.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, prime) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function searchCacheKey(query: unknown): string {
  const normalized = normalizeSearchCacheQuery(query);
  return HASH_LANES.map(({ seed, prime }) => hash32(normalized, seed, prime)).join("");
}

function isCacheEntry(value: unknown): value is SearchCacheEntry {
  const entry = value as SearchCacheEntry | null | undefined;
  return (
    !!entry &&
    typeof entry === "object" &&
    Array.isArray(entry.results) &&
    typeof entry.platform === "string" &&
    Number.isFinite(entry.ts)
  );
}

function readCacheMap(raw: unknown): SearchCacheMap {
  const map: SearchCacheMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isCacheEntry(value)) map[key] = value;
  }
  return map;
}

function normalizeCacheMap(map: SearchCacheMap, now: number): SearchCacheMap {
  const alive = Object.entries(map)
    .filter(([, entry]) => now - entry.ts < SEARCH_CACHE_TTL_MS)
    .sort((left, right) => left[1].ts - right[1].ts);
  return Object.fromEntries(alive.slice(Math.max(0, alive.length - SEARCH_CACHE_MAX_ENTRIES)));
}

export async function getSearchCacheEntry(query: unknown): Promise<SearchCacheEntry | null> {
  const key = searchCacheKey(query);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = (await chrome.storage.local.get(SEARCH_CACHE_KEY)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entry = readCacheMap(raw?.[SEARCH_CACHE_KEY])[key];
  if (!entry) return null;
  return Date.now() - entry.ts < SEARCH_CACHE_TTL_MS ? entry : null;
}

export async function putSearchCacheEntry(
  query: unknown,
  value: SearchCacheEntryView
): Promise<void> {
  const key = searchCacheKey(query);
  const now = Date.now();
  try {
    const raw = (await chrome.storage.local.get(SEARCH_CACHE_KEY)) as Record<string, unknown>;
    const map = readCacheMap(raw?.[SEARCH_CACHE_KEY]);
    map[key] = {
      results: Array.isArray(value?.results) ? value.results : [],
      platform: String(value?.platform ?? ""),
      ts: now
    };
    await chrome.storage.local.set({ [SEARCH_CACHE_KEY]: normalizeCacheMap(map, now) });
  } catch {
  }
}

export async function clearSearchCache(): Promise<void> {
  try {
    await chrome.storage.local.remove(SEARCH_CACHE_KEY);
  } catch {
  }
}
