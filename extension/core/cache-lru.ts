// 「缓存 LRU 淘汰」模块：为 chrome.storage.local 上的缓存族键提供统一的
// 「最近写入视频」索引与淘汰机制（一次机制覆盖全部注册族）：
//   - biliscript_lvs_l1_index_ / biliscript_lvs_analysis_final_：L1 章节目录索引 / 整份概览产物（每族保留最近 100 个视频，与 IndexedDB 字幕仓库对齐）；
//   - biliscript_lvs_summary_ / biliscript_lvs_analysis_：分段小结 / 概览分段产物（每族保留最近 20 个视频）；
//   - biliscript_subtitle_cache_ / biliscript_lvs_raw_：旧版遗留字幕与原始字幕段缓存键（每族保留最近 3 个视频以便平滑清理）。
// 设计决策（与产品确认）：
//   - 按族配置保留最近写入的 keep 个视频（按 bvid，默认见 FAMILY_KEEP_VIDEOS，未登记族回落 3），
//     LRU 以 lastWriteTimestamp 排序，无字节上限；
//   - 索引按「族 + bvid + 缓存键」分键落盘（11 票，消并发覆盖竞态）：每个缓存键对应
//     一条索引键 biliscript_cache_lru_index:{family}:{bvid}:{cacheKey}（值 { ts }），写入是
//     各自键上的原子 set——map-reduce 并发 3 段写同一 bvid 时互相不再覆盖（旧实现
//     整键读-改-写 biliscript_cache_lru_index，并发写丢 keys，段缓存不可枚举导致重复请求）。
//     chrome.storage 没有原子追加，「单键一索引项」是唯一无竞态布局；
//   - 另有汇总清单键 biliscript_cache_lru_index：{ [family]: { [bvid]: ts } }，仅供
//     writeWithEviction 的「各族 ≤ keep」短路检查与淘汰排名参考（读-改-写仍可能丢
//     并发新增，但只影响「是否提前触发淘汰」，不丢索引键面；prune 以分键索引为准
//     顺手重写清单自愈）。旧格式条目（数值 ts，或 { ts, keys } 对象）读端归一兼容，
//     无需迁移；
//   - 读端原语 readFamilyKeys(family, bvid, keyPrefix)：优先通过 chrome.storage.local.getKeys()
//     仅拉取键名数组做前缀过滤（不反序列化任何值）；仅在不支持 getKeys() 的旧运行环境
//     （Chrome 120–129）回退 get(null)。条目缺失（该 bvid 无分键索引）→ 返回 null + 一次性
//     logWarn（跨消费方共享标志），消费方走 getStorageItemsByPrefix / listStorageKeysByPrefix
//     前缀扫描自愈；存储读取本身留在消费方（segment-cache 拼段序 / subtitle 孤儿清理）；
//   - 淘汰候选键 = 分键索引并集 ∪ 族前缀数据扫描：支持 getKeys() 时仅拉取键名数组并定点
//     get(manifest + 目标族分键索引) 元数据，不反序列化数据值；旧环境回退单次 get(null)
//     快照过滤。数据键有、索引缺失的遗留 bvid 以清单 ts 排名、缺清单按最旧；解析不出
//     bvid 的畸形键按垃圾回收。索引指向已删键的幽灵条目随淘汰被垃圾回收
//     （storage.remove 对不存在键是 no-op）；
//   - 淘汰本身静默运行、不提示；仅当「淘汰后重试仍失败」时由调用方把 distinct
//     失败（CacheWriteError）上浮到各自的 UI 通道（content 状态栏 / offscreen port notice）。
// chrome.* 访问与既有测试模式一致：直接使用全局 chrome.storage.local，
// 测试经 tests/helpers/chrome-host.ts 的宿主注入内存实现（支持 getKeys 与 get(null)）。

import { logWarn } from "../shared/logging.js";

// LRU 汇总清单键（导出作测试 arrange/断言的单源，见 tests/helpers/chrome-host.ts）。
export const LRU_MANIFEST_STORAGE_KEY = "biliscript_cache_lru_index";
// 分键索引条目前缀：冒号不在任何数据键中出现（数据键只含 [A-Za-z0-9_] 及 source key
// 内的少量符号），前缀与清单键、数据键互不撞车。
const LRU_INDEX_ENTRY_PREFIX = "biliscript_cache_lru_index:";
/**
 * 分键索引键装配点（全仓唯一拼装处）：完整索引键 = 前缀 + family + bvid + cacheKey。
 * 读端前缀过滤与 prune 删除前缀传空 cacheKey 即得 `${prefix}${family}:${bvid}:`；
 * 测试宿主的 seedIndexEntry 亦经此构造，不再手写字面量。
 */
export function buildLruIndexEntryKey(family: string, bvid: string, cacheKey: string): string {
  return `${LRU_INDEX_ENTRY_PREFIX}${family}:${bvid}:${cacheKey}`;
}
// 参与统一淘汰的缓存族前缀（全仓唯一注册处，arch-slim-2/08 起 analysis 两族
// 收进注册、不再由 ai/analysis.ts 自行扩展名单）：
//   - biliscript_lvs_raw_* / biliscript_lvs_summary_*：旧版原始字幕段（保留注册以便淘汰清理）/ ai/segment-cache.ts 的分段小结；
//   - biliscript_subtitle_cache_*：旧版字幕缓存键（保留注册以便淘汰清理）；
//   - biliscript_lvs_analysis_* / biliscript_lvs_analysis_final_*：ai/analysis-orchestrate.ts 的概览分段 / 整份产物；
//   - biliscript_lvs_l1_index_*：ai/l1-chapter-index.ts 的 L1 章节目录索引。
// 前缀撞车归属：biliscript_lvs_analysis_final_ 以 biliscript_lvs_analysis_ 为父前缀，数据键按
// 「最长注册前缀」归属（final 键归 final 族自身）——段族的前缀扫描不再把 final 键
// 误纳为 bvid="final"（旧兜底路径的误归因随分键布局变成唯一路径后必修，见
// pruneToRecentVideos 的 familyOfCacheKey）；两族各按自己的索引条目与清单 ts 淘汰。
export const CACHE_FAMILIES = [
  "biliscript_lvs_raw_",
  "biliscript_lvs_summary_",
  "biliscript_subtitle_cache_",
  "biliscript_lvs_analysis_",
  "biliscript_lvs_analysis_final_",
  "biliscript_lvs_l1_index_"
];
// 未显式配置时的回落保留视频数。
const LRU_KEEP_VIDEOS = 3;

// 按缓存族体积与生命周期分档设定默认保留视频数：
// - L1 索引与整份概览产物单视频仅数 KB，与 IndexedDB 字幕仓库（100 分 P）保持 1:1 对齐；
// - 分段小结 / 概览分段保留 20 个视频；
// - 旧版遗留字幕与原始字幕段保持 3 个视频上限以自动收缩清理。
export const FAMILY_KEEP_VIDEOS: Record<string, number> = {
  biliscript_lvs_l1_index_: 100,
  biliscript_lvs_analysis_final_: 100,
  biliscript_lvs_summary_: 20,
  biliscript_lvs_analysis_: 20,
  biliscript_subtitle_cache_: 3,
  biliscript_lvs_raw_: 3
};

export function getKeepVideosForFamily(family: string, explicitKeep?: number): number {
  if (explicitKeep !== undefined) {
    const parsed = Math.floor(Number(explicitKeep));
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return FAMILY_KEEP_VIDEOS[family] ?? LRU_KEEP_VIDEOS;
}

// 注册族按前缀长度降序：撞前缀的键由最长前缀族认领（见上）。
const FAMILIES_BY_PREFIX_LENGTH = [...CACHE_FAMILIES].sort((a, b) => b.length - a.length);

// 数据键归属族：最长注册前缀命中；不属于任何注册族 → null。
function familyOfCacheKey(key: string): string | null {
  return FAMILIES_BY_PREFIX_LENGTH.find((family) => key.startsWith(family)) || null;
}

// 汇总清单：{ [family]: { [bvid]: ts } }。只是短路/排名用的启发式元数据，
// 不是键面的真相来源（真相是分键索引）。
type LruManifest = Record<string, Record<string, number>>;

export interface EvictionResult {
  ok: true;
}

export interface EvictionFailure {
  ok: false;
  error: CacheWriteError;
}

// 「淘汰后重试仍失败」的 distinct 错误：调用方据此判断是否向 UI 上浮（且仅上浮一次）。
export class CacheWriteError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CacheWriteError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// 从缓存键解析 bvid：键形如 `${family}${bvid}_${cid}_${sourceKey}[_${index}]`，
// bvid（BV 号）不含下划线，取 family 前缀后的第一段即可。
export function parseBvidFromCacheKey(key: unknown, familyPrefix = ""): string {
  let rest = String(key == null ? "" : key);
  if (familyPrefix && rest.startsWith(familyPrefix)) {
    rest = rest.slice(familyPrefix.length);
  }
  const cut = rest.indexOf("_");
  return cut === -1 ? rest : rest.slice(0, cut);
}

type StorageAreaWithGetKeys = chrome.storage.StorageArea & {
  getKeys?: () => Promise<string[]>;
};

function requireStorageLocal(): StorageAreaWithGetKeys {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local 不可用");
  }
  return globalThis.chrome.storage.local as StorageAreaWithGetKeys;
}

// 统一枚举 chrome.storage.local 全部键名：优先走 StorageArea.getKeys()（Chrome 130+ / Firefox 137+）
// 避免反序列化大体积 value；仅在不支持 getKeys() 的旧运行环境（Chrome 120–129）回退 get(null)
// 并返回本次快照供调用方复用，避免二次读取。
async function listAllStorageKeys(
  storage: StorageAreaWithGetKeys
): Promise<{ keys: string[]; snapshot: Record<string, unknown> | null }> {
  if (typeof storage.getKeys === "function") {
    const rawKeys = await storage.getKeys();
    const keys = Array.isArray(rawKeys)
      ? rawKeys.filter((key): key is string => typeof key === "string")
      : [];
    return { keys, snapshot: null };
  }
  const snapshot = (await storage.get(null)) || {};
  return { keys: Object.keys(snapshot), snapshot };
}

/**
 * 按前缀枚举 chrome.storage.local 中存在的键名：优先走 getKeys() 过滤，
 * 仅在极老运行环境不支持 getKeys() 时回退 get(null)。
 */
export async function listStorageKeysByPrefix(keyPrefix = ""): Promise<string[]> {
  const storage = requireStorageLocal();
  const { keys } = await listAllStorageKeys(storage);
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
}

/**
 * 按前缀读取 chrome.storage.local 键值对：优先走 getKeys() 筛出匹配键名后再定点
 * storage.get(matchedKeys)；无匹配时直接返回 {} 不发 get；旧环境回退 get(null)
 * 时直接从同次快照切片，零额外往返。
 */
export async function getStorageItemsByPrefix(keyPrefix = ""): Promise<Record<string, unknown>> {
  const storage = requireStorageLocal();
  const { keys, snapshot } = await listAllStorageKeys(storage);
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  const matchedKeys = prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  if (matchedKeys.length === 0) {
    return {};
  }
  if (snapshot !== null) {
    const out: Record<string, unknown> = {};
    for (const key of matchedKeys) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        out[key] = snapshot[key];
      }
    }
    return out;
  }
  return (await storage.get(matchedKeys)) || {};
}

// 归一清单/索引条目的时间戳：数值、{ ts }、旧格式 { ts, keys } 均可取 ts；
// 取不出有限数值 → null（调用方忽略该条目）。
function normalizeEntryTs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const ts = Number((value as { ts?: unknown }).ts);
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return null;
}

// 读汇总清单：缺失 / 损坏 / 读失败 → {}（清单只是淘汰启发式元数据，允许丢）。
// 旧格式值（数值 ts、{ ts, keys } 对象）逐条归一兼容，混合清单也照计。
async function readManifest(): Promise<LruManifest> {
  try {
    const result = await requireStorageLocal().get(LRU_MANIFEST_STORAGE_KEY);
    return normalizeManifest(result?.[LRU_MANIFEST_STORAGE_KEY]);
  } catch {
    return {};
  }
}

function normalizeManifest(raw: unknown): LruManifest {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const manifest: LruManifest = {};
  for (const [family, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const bvids: Record<string, number> = {};
    for (const [bvid, value] of Object.entries(entry as Record<string, unknown>)) {
      const ts = normalizeEntryTs(value);
      if (ts !== null) {
        bvids[bvid] = ts;
      }
    }
    manifest[family] = bvids;
  }
  return manifest;
}

// 在清单快照上合并「本次写入」：短路检查以此判断本次写入是否可能造成越界
// （stored 清单读于写入之前，快照里还没有本次 bvid）。跨族合并写（段缓存写聚合）
// 传入多组 { family, bvid, ts }，一次覆盖全部写入族。
function mergeManifestWrites(manifest: LruManifest, writes: Array<{ family: string; bvid: string; ts: number }>): LruManifest {
  const next: LruManifest = { ...manifest };
  for (const { family, bvid, ts } of writes) {
    next[family] = {
      ...(next[family] || {}),
      [bvid]: ts
    };
  }
  return next;
}

// 索引退化回退的一次性告警标志（模块级，跨消费方共享）：回退路径可能被每次追问
// / 每次转写触发，只 logWarn 一次防刷屏，便于发现索引退化。
let indexFallbackWarned = false;

/**
 * 读端原语：按分键索引取该族该 bvid 的缓存键清单（keyPrefix 可选过滤），供消费方
 * 定点批量读取（存储读取本身留在消费方，读后处理各异）。优先经 getKeys() 仅拉取
 * 键名过滤，仅旧环境回退 get(null)。该 bvid 无任何分键索引条目 → 返回 null + 一次性
 * logWarn（跨消费方共享标志），消费方走前缀扫描自愈；索引读失败按缺失同路回退
 * （索引是启发式元数据，允许丢）。
 */
export async function readFamilyKeys(family: string, bvid: string, keyPrefix = ""): Promise<string[] | null> {
  let keys: string[];
  try {
    const entryPrefix = buildLruIndexEntryKey(family, bvid, "");
    const matchedIndexKeys = await listStorageKeysByPrefix(entryPrefix);
    keys = matchedIndexKeys
      .map((storageKey) => storageKey.slice(entryPrefix.length))
      .sort();
  } catch {
    keys = [];
  }
  if (keys.length === 0) {
    if (!indexFallbackWarned) {
      indexFallbackWarned = true;
      logWarn(`[BILISCRIPT] cache-lru index missing for family=${family} bvid=${bvid}, fallback to full storage scan`);
    }
    return null;
  }
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  return keys.filter((key) => !prefix || key.startsWith(prefix));
}

// 记录一次写入（纯原子写，无读-改-写竞态）：
//   1. 分键索引：本次每个缓存键各写一条 `${prefix}${family}:${bvid}:${cacheKey}` → { ts }，
//      并发写互不覆盖（11 票核心）；
//   2. 汇总清单：在调用方给的快照上合并本 bvid 后整键覆盖——并发新增可能互相覆盖，
//      仅影响短路/排名启发，不丢键面，prune 会顺手重写清单自愈。
// 跨族合并写（段缓存写聚合）：多族索引条目与 manifest 打包进同一次 set
// （同一次 set 携带多键不违反 11 票不变式，与单键一索引项的布局一致）。
// 失败上抛，由 writeWithEviction / writeBundleWithEviction 统一处理。
async function recordCacheWrites(
  writes: Array<{ family: string; bvid: string; cacheKeys: string[] }>,
  timestamp = Date.now(),
  manifestSnapshot: LruManifest = {}
): Promise<void> {
  const storage = requireStorageLocal();
  const items: Record<string, unknown> = {};
  const manifestWrites: Array<{ family: string; bvid: string; ts: number }> = [];
  for (const write of Array.isArray(writes) ? writes : []) {
    const entries: Record<string, { ts: number }> = {};
    for (const key of new Set(Array.isArray(write.cacheKeys) ? write.cacheKeys : [])) {
      if (key) {
        entries[buildLruIndexEntryKey(write.family, write.bvid, key)] = { ts: timestamp };
      }
    }
    Object.assign(items, entries);
    if (write.family && write.bvid) {
      manifestWrites.push({ family: write.family, bvid: write.bvid, ts: timestamp });
    }
  }
  if (manifestWrites.length > 0) {
    items[LRU_MANIFEST_STORAGE_KEY] = mergeManifestWrites(manifestSnapshot, manifestWrites);
  }
  await storage.set(items);
}

// 从分键索引存储键解析 { family, bvid, cacheKey }；冒号可能出现在 cacheKey
// （source key 含 URL）里，bvid 段取第二个冒号前、cacheKey 取其余全部。
function parseIndexEntryKey(
  storageKey: string
): { family: string; bvid: string; cacheKey: string } | null {
  const rest = storageKey.slice(LRU_INDEX_ENTRY_PREFIX.length);
  const familyEnd = rest.indexOf(":");
  if (familyEnd <= 0) {
    return null;
  }
  const bvidEnd = rest.indexOf(":", familyEnd + 1);
  if (bvidEnd <= familyEnd + 1) {
    return null;
  }
  return {
    family: rest.slice(0, familyEnd),
    bvid: rest.slice(familyEnd + 1, bvidEnd),
    cacheKey: rest.slice(bvidEnd + 1)
  };
}

/**
 * 淘汰到每族最近 keep 个视频：支持 getKeys() 时仅拉取键名数组并定点读取汇总清单
 * 与目标族分键索引元数据（不反序列化数据值）；旧环境回退单次 get(null) 快照。
 * 候选 = 分键索引并集 ∪ 族前缀数据键（「索引有、storage 无」的幽灵键照常流入淘汰清单，
 * 「storage 有、索引缺失」的遗留 bvid 按清单 ts 排名、缺清单视为最旧），bvid 不在最近
 * keep 名内的整键删除（数据键 + 该 bvid 的分键索引条目一并移除），并把被清理族的重写
 * 回清单（自愈）。返回 { [family]: string[] }（清理出的数据键，可能含已不存在的键）；
 * 淘汰本身静默：任何失败吞掉并返回 {}。
 */
export async function pruneToRecentVideos(
  families: string[] = CACHE_FAMILIES,
  keep?: number
): Promise<Record<string, string[]>> {
  try {
    const storage = requireStorageLocal();
    const familyList = (Array.isArray(families) ? families : []).filter(
      (f): f is string => typeof f === "string" && Boolean(f)
    );
    if (familyList.length === 0) {
      return {};
    }

    const familySet = new Set(familyList);
    const { keys: allKeys, snapshot } = await listAllStorageKeys(storage);

    let metaValues: Record<string, unknown>;
    if (snapshot !== null) {
      metaValues = snapshot;
    } else {
      const metaKeys: string[] = [];
      for (const storageKey of allKeys) {
        if (storageKey === LRU_MANIFEST_STORAGE_KEY) {
          metaKeys.push(storageKey);
          continue;
        }
        if (storageKey.startsWith(LRU_INDEX_ENTRY_PREFIX)) {
          const parsed = parseIndexEntryKey(storageKey);
          if (parsed && familySet.has(parsed.family)) {
            metaKeys.push(storageKey);
          }
        }
      }
      metaValues = metaKeys.length > 0 ? (await storage.get(metaKeys)) || {} : {};
    }

    const manifest = normalizeManifest(metaValues?.[LRU_MANIFEST_STORAGE_KEY]);

    // 分键索引按 族 → bvid → { ts(取最大), keys } 归并。
    const indexed = new Map<string, Map<string, { ts: number; keys: Set<string> }>>();
    for (const storageKey of allKeys) {
      if (!storageKey.startsWith(LRU_INDEX_ENTRY_PREFIX)) {
        continue;
      }
      const parsed = parseIndexEntryKey(storageKey);
      if (!parsed || !familySet.has(parsed.family)) {
        continue;
      }
      const ts = normalizeEntryTs(metaValues[storageKey]);
      if (ts === null) {
        continue;
      }
      let familyMap = indexed.get(parsed.family);
      if (!familyMap) {
        familyMap = new Map();
        indexed.set(parsed.family, familyMap);
      }
      let entry = familyMap.get(parsed.bvid);
      if (!entry) {
        entry = { ts, keys: new Set() };
        familyMap.set(parsed.bvid, entry);
      }
      entry.ts = Math.max(entry.ts, ts);
      entry.keys.add(parsed.cacheKey);
    }

    const keysToRemove: string[] = [];
    const removed: Record<string, string[]> = {};
    // 被清理族的重写清单（ survivors = 保留 bvid → 排名 ts ）。
    const manifestRewrite: Record<string, Record<string, number>> = {};
    for (const family of familyList) {
      const familyIndexed = indexed.get(family);
      const familyManifest = manifest[family] || {};
      // 族内 bvid → 排名 ts：分键索引优先，清单兜底，都没有（纯遗留数据键）→ 0 最旧。
      const timestamps = new Map<string, number>();
      if (familyIndexed) {
        for (const [bvid, entry] of familyIndexed) {
          timestamps.set(bvid, Math.max(entry.ts, familyManifest[bvid] ?? 0));
        }
      }
      // 候选键：分键索引并集 ∪ 族前缀数据键（同次键名枚举内过滤，覆盖「索引丢过键 /
      // 索引缺失」的遗留面，不读取数据值）。
      const candidateKeys = new Set<string>();
      if (familyIndexed) {
        for (const entry of familyIndexed.values()) {
          for (const key of entry.keys) {
            candidateKeys.add(key);
          }
        }
      }
      for (const key of allKeys) {
        // 最长前缀归属：撞前缀键（biliscript_lvs_analysis_final_*）只归自己的族，
        // 不被父前缀族的扫描误纳（否则 bvid 被解析成 "final" 而整族误淘汰）。
        if (!key.startsWith(family) || familyOfCacheKey(key) !== family) {
          continue;
        }
        candidateKeys.add(key);
        const bvid = parseBvidFromCacheKey(key, family);
        if (bvid && !timestamps.has(bvid)) {
          timestamps.set(bvid, familyManifest[bvid] ?? 0);
        }
      }
      // 「注册但从未写入」的族（无索引、无清单、无数据键）：跳过。
      if (candidateKeys.size === 0 && Object.keys(familyManifest).length === 0) {
        continue;
      }

      const familyKeep = getKeepVideosForFamily(family, keep);
      const ranked = [...timestamps.entries()].sort((a, b) => b[1] - a[1]);
      const keepSet = new Set(ranked.slice(0, familyKeep).map(([bvid]) => bvid));
      const familyRemoved = [...candidateKeys].filter((key) => {
        const bvid = parseBvidFromCacheKey(key, family);
        // 解析不出 bvid 的畸形键按垃圾一并回收。
        return !bvid || !keepSet.has(bvid);
      });
      manifestRewrite[family] = Object.fromEntries(ranked.filter(([bvid]) => keepSet.has(bvid)));
      if (familyRemoved.length === 0) {
        continue;
      }
      removed[family] = familyRemoved;
      keysToRemove.push(...familyRemoved);
      // 被淘汰 bvid 的分键索引条目一并移除。
      for (const [bvid] of ranked) {
        if (keepSet.has(bvid)) {
          continue;
        }
        const entryPrefix = buildLruIndexEntryKey(family, bvid, "");
        for (const storageKey of allKeys) {
          if (storageKey.startsWith(entryPrefix)) {
            keysToRemove.push(storageKey);
          }
        }
      }
    }

    if (keysToRemove.length > 0) {
      await storage.remove(keysToRemove);
      // 清单重写（仅被清理族；未参与淘汰的族原样保留）：被淘汰 bvid 条目移除，
      // survivors 以排名 ts 落盘。失败不影响已删除的数据键（下次 prune 会再收）。
      try {
        await storage.set({ [LRU_MANIFEST_STORAGE_KEY]: { ...manifest, ...manifestRewrite } });
      } catch {
        // 清单重写失败静默（启发式元数据，允许丢）。
      }
    }
    return removed;
  } catch {
    return {};
  }
}

// prune 短路检查：各族清单条目的 bvid 数都 ≤ 对应族 keep → true。清单只是启发式——
// 并发新增互相覆盖只会少计（多留旧视频），不会多计；少计方向由 prune 的真枚举兜底。
function familiesWithinKeep(manifest: LruManifest, families: string[], keep?: number): boolean {
  const familyList = (Array.isArray(families) ? families : []).filter(
    (f): f is string => typeof f === "string" && Boolean(f)
  );
  return familyList.every(
    (family) => Object.keys(manifest[family] || {}).length <= getKeepVideosForFamily(family, keep)
  );
}

interface WriteWithEvictionOptions {
  family?: string;
  bvid?: string;
  write?: () => Promise<void>;
  keys?: string[];
  keep?: number;
  pruneFamilies?: string[];
}

// 跨族合并写的一次写入计划：每族登记 bvid 与本次写入的缓存键（分键索引条目来源）。
export interface CacheWriteBundleEntry {
  family: string;
  bvid: string;
  cacheKeys: string[];
}

/**
 * 跨族合并写（段缓存写聚合 ticket）：一次写入横跨多族时，分键索引与汇总清单
 * 合成一次 set（recordCacheWrites 打包），数据写由调用方闭包完成（可含多次
 * storage.set）；淘汰短路检查覆盖 entries 涉及的全部族。失败处理与
 * writeWithEviction 同口径：先淘汰（静默）再重试一次，仍失败返回
 * { ok:false, error: CacheWriteError }。从不抛出。
 */
export async function writeBundleWithEviction(
  entries: CacheWriteBundleEntry[],
  write: () => Promise<void>,
  { keep, pruneFamilies = CACHE_FAMILIES }: { keep?: number; pruneFamilies?: string[] } = {}
): Promise<EvictionResult | EvictionFailure> {
  const bundle = (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is CacheWriteBundleEntry =>
      Boolean(entry) && typeof entry.family === "string" && typeof entry.bvid === "string"
  );
  if (bundle.length === 0) {
    return { ok: false, error: new CacheWriteError("writeBundleWithEviction：entries 不能为空") };
  }
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeBundleWithEviction：write 必须是函数") };
  }

  const timestamp = Date.now();
  // 每次 attempt 现读清单快照：重试路径拿到的是淘汰后的新清单。
  const attempt = async () => {
    const manifestSnapshot = await readManifest();
    await recordCacheWrites(bundle, timestamp, manifestSnapshot);
    await write();
    return manifestSnapshot;
  };

  let manifestSnapshot: LruManifest;
  try {
    manifestSnapshot = await attempt();
  } catch (firstError) {
    // 写入失败：先淘汰（失败静默）再重试一次；当前 bvid 刚记录过时间戳，
    // 在族内排名最新，不会被本次淘汰误删。
    await pruneToRecentVideos(pruneFamilies, keep);
    try {
      manifestSnapshot = await attempt();
    } catch (retryError) {
      return {
        ok: false,
        error: new CacheWriteError(
          `缓存写入失败（已淘汰旧视频后重试仍失败）：${(retryError as Error | undefined)?.message || retryError}`,
          retryError
        )
      };
    }
  }

  // 维持 LRU 不变量：每次成功写入后收缩到每族最近 keep 个视频。清单快照（合并
  // 本次写入的全部族/bvid）各族 bvid 数都 ≤ keep 时本次写入不可能造成越界，
  // 跳过完整 prune。
  const manifestWrites = bundle
    .filter((entry) => entry.family && entry.bvid)
    .map((entry) => ({ family: entry.family, bvid: entry.bvid, ts: timestamp }));
  if (!familiesWithinKeep(mergeManifestWrites(manifestSnapshot, manifestWrites), pruneFamilies, keep)) {
    await pruneToRecentVideos(pruneFamilies, keep);
  }
  return { ok: true };
}

/**
 * 带 LRU 淘汰的写入：记录索引（原子分键写，无并发竞态）→ 写入 → 每次成功写入后
 * 维持「每族仅保留最近 keep 个视频」的不变量（先读清单短路：快照合并本次 bvid 后
 * 各族条目数都 ≤ keep 时跳过完整 prune；清单少计只导致多留，prune 真枚举兜底）；
 * 写入失败时先淘汰（静默）再重试一次，仍失败返回
 * { ok:false, error: CacheWriteError }（distinct 失败，由调用方决定是否上浮 UI）。
 * 从不抛出；返回 { ok:true } 或 { ok:false, error }。
 * （单族特例，实现收进 writeBundleWithEviction 单路径。）
 */
export async function writeWithEviction({
  family = "",
  bvid = "",
  write,
  keys = [],
  keep,
  pruneFamilies = CACHE_FAMILIES
}: WriteWithEvictionOptions = {}): Promise<EvictionResult | EvictionFailure> {
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeWithEviction：write 必须是函数") };
  }
  return writeBundleWithEviction([{ family, bvid, cacheKeys: keys }], write, { keep, pruneFamilies });
}

// ============================================================
// 缓存族工厂（arch-slim-2/08）：chrome.storage.local 上「族键拼装 + 静默读 +
// { payload, timestamp } 落盘 + writeWithEviction 统一 LRU 淘汰写」的口径单源。
// 消费实例：ai/segment-cache.ts（biliscript_lvs_summary_）、
// ai/l1-chapter-index.ts（biliscript_lvs_l1_index_）与
// ai/analysis-orchestrate.ts（biliscript_lvs_analysis_final_ / biliscript_lvs_analysis_）。
// 本叶保持零 import：source key 推导（buildSubtitleSourceKey，属 subtitle 域）
// 与失败日志（logError，拖 core/state）都经 options 注入，不反向依赖。
// （readFamilyKeys 的回退告警经 shared/logging 的 logWarn——同为不拖 state/
// chrome 的纯叶子，随 arch-slim-4/09 告警随原语单源收进本叶。）
// ============================================================

export type CacheSaveResult = EvictionResult | EvictionFailure;

export interface CacheFamilyOptions<TValue> {
  /** 族键前缀（必须已进 CACHE_FAMILIES 注册，参与统一 LRU 淘汰）。 */
  prefix: string;
  /** 落盘 payload 字段名；值形状 { [payloadField]: value, timestamp }。 */
  payloadField: string;
  /** 字幕轨 source key 推导（注入 subtitle/source-key.ts 的 buildSubtitleSourceKey）。 */
  toSourceKey: (subtitleId: unknown, subtitleUrl: unknown, lang: unknown) => string;
  /** 读端形状校验（损坏返回 null）；缺省只做 nullish 归一（值原样透传）。 */
  validate?: (value: unknown) => boolean;
  /** 淘汰后重试仍失败时的日志钩子（注入 shared/logging 的 logError 与各族固定文案）。 */
  logFailure?: (info: { key: string; error: unknown }) => void;
}

export interface CacheFamilyKeyFields {
  bvid?: unknown;
  cid?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  lang?: unknown;
}

export interface CacheFamily<TValue> {
  readonly prefix: string;
  /**
   * 族键拼装：prefix + bvid + cid + sourceKey + tail。键形与各族历史键逐字节
   * 一致（缓存零迁移）；段序号/预算代/签名等 tail 段的拼装约定由调用方传入。
   */
  key(fields: CacheFamilyKeyFields, tail: unknown): string;
  /** 读：未命中 / 读失败 / 形状损坏 → null（静默，淘汰索引元数据同理可丢）。 */
  load(key: string): Promise<TValue | null>;
  /** 批量读（08 票）：一次 storage.get 取 N 键，与 keys 按序对齐（未命中/损坏/失败 → null）。 */
  loadMany(keys: string[]): Promise<(TValue | null)[]>;
  /** 写：经 writeWithEviction（写失败先淘汰再重试一次），最终失败走 logFailure、不抛。 */
  save(key: string, value: TValue): Promise<CacheSaveResult>;
}

export function createCacheFamily<TValue>(options: CacheFamilyOptions<TValue>): CacheFamily<TValue> {
  const { prefix, payloadField, toSourceKey, validate, logFailure } = options;
  // 单键/批量读共用的取值归一（payload 字段提取 + 形状校验），读口径只此一处。
  function readPayload(all: Record<string, unknown>, key: string): TValue | null {
    const value = (all[key] as Record<string, unknown> | undefined)?.[payloadField];
    if (value == null) {
      return null;
    }
    if (validate && !validate(value)) {
      return null;
    }
    return value as TValue;
  }
  return {
    prefix,
    key(fields, tail) {
      const sourceKey = toSourceKey(fields.subtitleId, fields.subtitleUrl, fields.lang);
      return `${prefix}${fields.bvid}_${fields.cid}_${sourceKey}_${String(tail)}`;
    },
    async load(key) {
      try {
        return readPayload(await requireStorageLocal().get(key), key);
      } catch {
        return null;
      }
    },
    async loadMany(keys) {
      const list = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && Boolean(key));
      if (list.length === 0) {
        return [];
      }
      try {
        const all = await requireStorageLocal().get(list);
        return list.map((key) => readPayload(all, key));
      } catch {
        return list.map(() => null);
      }
    },
    async save(key, value) {
      const result = await writeWithEviction({
        family: prefix,
        bvid: parseBvidFromCacheKey(key, prefix),
        keys: [key], // 本次写入的缓存键，落一条分键索引条目供枚举/淘汰
        write: () =>
          requireStorageLocal().set({
            [key]: {
              [payloadField]: value,
              timestamp: Date.now()
            }
          })
      });
      if (!result.ok) {
        logFailure?.({ key, error: result.error?.message || result.error });
      }
      return result;
    }
  };
}
