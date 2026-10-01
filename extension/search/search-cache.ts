// extension/search/search-cache.ts
// 查询缓存 SW 叶（spec §5 / §3 落点表第 9 行）：宿主是 SW（chrome.storage.local
// 单键 `biliscript_search_cache` 放整张映射 `{ [queryHash]: { results, platform, ts } }`；
// offscreen 无 chrome.storage，两个消费方（offscreen 工具循环 / content 选区解释卡）
// 都经 `search-cache` 消息族读写，SW 侧本叶是唯一写入口与归一单源）。
// 键 = 归一 query 的 64 位哈希（两个不同盐的 32 位 lane 拼十六进制），只含
// [0-9a-f]、不落查询明文、不含引擎 / 条数 / 链位次（跨引擎复用）；命中不做明文校验。
// 有界性 = 内存内过期清理（TTL 300s 常量）+ 上限 50 条按 ts 淘汰最旧；读写各一次
// get / set，无分键索引、无清单、无 LRU 索引键。
// 容错口径（缓存绝不影响回答）：读失败按未命中、写失败静默 no-op，都不抛。
// 失败不入缓存：只有链成功返回（含空结果集）才由调用方写（本叶不判成败）。
import type { NormalizedSearchResult } from "./adapters/types.js";

export const SEARCH_CACHE_KEY = "biliscript_search_cache";
// 固定 300s 常量（spec §5「TTL 与配置」）：内部防限流机制，不新增设置键。
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

// 两个不同盐的 32 位 lane：同一输入的两位 lane 取值不同，拼成 64 位键。
const HASH_LANES = [
  { seed: 0x811c9dc5, prime: 0x01000193 },
  { seed: 0x9e3779b9, prime: 0x85ebca6b }
] as const;

// 归一 = trim + 内部连续空白折叠为单个空格 + toLowerCase（调用方不拼键）。
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

// 键名：两个 32 位 lane 拼十六进制 = 16 位 [0-9a-f]（不落查询明文）。
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

// 防御读取：整张映射非对象 / 单条形状不对一律丢弃（脏值按未命中）。
function readCacheMap(raw: unknown): SearchCacheMap {
  const map: SearchCacheMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isCacheEntry(value)) map[key] = value;
  }
  return map;
}

// 内存内过期清理 + 上限 50 条按 ts 淘汰最旧（返回新映射，不改入参）。
function normalizeCacheMap(map: SearchCacheMap, now: number): SearchCacheMap {
  const alive = Object.entries(map)
    .filter(([, entry]) => now - entry.ts < SEARCH_CACHE_TTL_MS)
    .sort((left, right) => left[1].ts - right[1].ts);
  return Object.fromEntries(alive.slice(Math.max(0, alive.length - SEARCH_CACHE_MAX_ENTRIES)));
}

/**
 * 读一条未过期缓存（单次 storage.get）。读失败按未命中返回 null（不抛）。
 */
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

/**
 * 写一条缓存（单次 get + 单次 set）：先清过期、再按 ts 淘汰到上限。
 * 写失败静默 no-op（不抛）——缓存绝不影响回答。
 */
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
    // 写失败静默
  }
}

/**
 * 清空整张查询缓存（spec §6.7 撤回）：批次③在 SW 的两个既有入口
 * （save-settings 收到显式 webSearchEnabled === false、search-providers-delete）
 * 接线，本批只导出、不给消息族加 clear op。清空失败静默。
 */
export async function clearSearchCache(): Promise<void> {
  try {
    await chrome.storage.local.remove(SEARCH_CACHE_KEY);
  } catch {
    // 清空失败静默
  }
}
