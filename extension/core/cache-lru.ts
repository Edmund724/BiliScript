// 「缓存 LRU 淘汰」模块：为 chrome.storage.local 上的缓存族键提供统一的
// 「最近写入视频」索引与淘汰机制（一次机制覆盖全部注册族）：
//   - boc_lvs_raw_* / boc_lvs_summary_*：ai/segment-cache.js 的原始字幕段 / 分段小结；
//   - boc_subtitle_cache_*：subtitle/cache.js 的整篇字幕正文（值 { body, timestamp }）。
// 设计决策（与产品确认）：
//   - 每族只保留最近写入的 keep（默认 3）个视频（按 bvid），LRU 以 lastWriteTimestamp
//     排序，无字节上限；
//   - 索引按「族 + bvid + 缓存键」分键落盘（11 票，消并发覆盖竞态）：每个缓存键对应
//     一条索引键 boc_cache_lru_index:{family}:{bvid}:{cacheKey}（值 { ts }），写入是
//     各自键上的原子 set——map-reduce 并发 3 段写同一 bvid 时互相不再覆盖（旧实现
//     整键读-改-写 boc_cache_lru_index，并发写丢 keys，段缓存不可枚举导致重复请求）。
//     chrome.storage 没有原子追加，「单键一索引项」是唯一无竞态布局；
//   - 另有汇总清单键 boc_cache_lru_index：{ [family]: { [bvid]: ts } }，仅供
//     writeWithEviction 的「各族 ≤ keep」短路检查与淘汰排名参考（读-改-写仍可能丢
//     并发新增，但只影响「是否提前触发淘汰」，不丢索引键面；prune 以分键索引为准
//     顺手重写清单自愈）。旧格式条目（数值 ts，或 { ts, keys } 对象）读端归一兼容，
//     无需迁移；
//   - 读端原语 readFamilyKeys(family, bvid, keyPrefix)：chrome.storage 无前缀查询，
//     按 bvid 枚举 = get(null) 全量扫描过滤（索引分键后淘汰/读取走同一扫描，prune 本身
//     低频：仅新视频写入越界或写失败重试时触发）。条目缺失（该 bvid 无分键索引）→
//     返回 null + 一次性 logWarn（跨消费方共享标志），消费方回退 get(null) 前缀扫描
//     自愈；存储读取本身留在消费方（segment-cache 拼段序 / subtitle 孤儿清理）；
//   - 淘汰候选键 = 分键索引并集 ∪ 族前缀数据扫描（同一 get(null) 快照里过滤，零额外
//     往返；数据键有、索引缺失的遗留 bvid 以清单 ts 排名、缺清单按最旧）；解析不出
//     bvid 的畸形键按垃圾回收。索引指向已删键的幽灵条目随淘汰被垃圾回收
//     （storage.remove 对不存在键是 no-op）；
//   - 淘汰本身静默运行、不提示；仅当「淘汰后重试仍失败」时由调用方把 distinct
//     失败（CacheWriteError）上浮到各自的 UI 通道（content 状态栏 / offscreen port notice）。
// chrome.* 访问与既有测试模式一致：直接使用全局 chrome.storage.local，
// 测试以 vi.stubGlobal("chrome", …) 注入内存实现（需支持 get(null) 全量枚举）。

import { logWarn } from "../shared/logging.js";

// LRU 汇总清单键（模块私有；测试以字面量直读写做 arrange/断言）。
const LRU_MANIFEST_KEY = "boc_cache_lru_index";
// 分键索引条目前缀：完整索引键为 `${LRU_INDEX_ENTRY_PREFIX}${family}:${bvid}:${cacheKey}`。
// 冒号不在任何数据键中出现（数据键只含 [A-Za-z0-9_] 及 source key 内的少量符号），
// 前缀与清单键、数据键互不撞车。
const LRU_INDEX_ENTRY_PREFIX = "boc_cache_lru_index:";
// 参与统一淘汰的缓存族前缀（全仓唯一注册处，arch-slim-2/08 起 analysis 两族
// 收进注册、不再由 ai/analysis.ts 自行扩展名单）：
//   - boc_lvs_raw_* / boc_lvs_summary_*：ai/segment-cache.ts 的原始字幕段 / 分段小结；
//   - boc_subtitle_cache_*：subtitle/cache.ts 的整篇字幕正文（值 { body, timestamp }）；
//   - boc_lvs_analysis_* / boc_lvs_analysis_final_*：ai/analysis.ts 的概览分段 / 整份产物。
// 前缀撞车归属：boc_lvs_analysis_final_ 以 boc_lvs_analysis_ 为父前缀，数据键按
// 「最长注册前缀」归属（final 键归 final 族自身）——段族的前缀扫描不再把 final 键
// 误纳为 bvid="final"（旧兜底路径的误归因随分键布局变成唯一路径后必修，见
// pruneToRecentVideos 的 familyOfCacheKey）；两族各按自己的索引条目与清单 ts 淘汰。
export const CACHE_FAMILIES = [
  "boc_lvs_raw_",
  "boc_lvs_summary_",
  "boc_subtitle_cache_",
  "boc_lvs_analysis_",
  "boc_lvs_analysis_final_"
];
// 每族保留的最近视频数（模块私有；evictLruByCount 的 keep 缺省值）。
const LRU_KEEP_VIDEOS = 3;

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

function requireStorageLocal(): chrome.storage.StorageArea {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local 不可用");
  }
  return globalThis.chrome.storage.local;
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
    const result = await requireStorageLocal().get(LRU_MANIFEST_KEY);
    return normalizeManifest(result?.[LRU_MANIFEST_KEY]);
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
 * 定点批量读取（存储读取本身留在消费方，读后处理各异）。chrome.storage 无前缀查询，
 * 枚举 = get(null) 全量扫描过滤（见模块头注释）。该 bvid 无任何分键索引条目 →
 * 返回 null + 一次性 logWarn（跨消费方共享标志），消费方回退 get(null) 前缀扫描
 * 自愈；索引读失败按缺失同路回退（索引是启发式元数据，允许丢）。
 */
export async function readFamilyKeys(family: string, bvid: string, keyPrefix = ""): Promise<string[] | null> {
  let keys: string[];
  try {
    const all = await requireStorageLocal().get(null);
    const entryPrefix = `${LRU_INDEX_ENTRY_PREFIX}${family}:${bvid}:`;
    keys = Object.keys(all || {})
      .filter((storageKey) => storageKey.startsWith(entryPrefix))
      .map((storageKey) => storageKey.slice(entryPrefix.length))
      .sort();
  } catch {
    keys = [];
  }
  if (keys.length === 0) {
    if (!indexFallbackWarned) {
      indexFallbackWarned = true;
      logWarn(`[BOC] cache-lru index missing for family=${family} bvid=${bvid}, fallback to full storage scan`);
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
        entries[`${LRU_INDEX_ENTRY_PREFIX}${write.family}:${write.bvid}:${key}`] = { ts: timestamp };
      }
    }
    Object.assign(items, entries);
    if (write.family && write.bvid) {
      manifestWrites.push({ family: write.family, bvid: write.bvid, ts: timestamp });
    }
  }
  if (manifestWrites.length > 0) {
    items[LRU_MANIFEST_KEY] = mergeManifestWrites(manifestSnapshot, manifestWrites);
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
 * 淘汰到每族最近 keep 个视频：单次 get(null) 快照内取候选（分键索引并集 ∪ 族前缀
 * 数据键——「索引有、storage 无」的幽灵键照常流入淘汰清单，「storage 有、索引缺失」
 * 的遗留 bvid 按清单 ts 排名、缺清单视为最旧），bvid 不在最近 keep 名内的整键删除
 * （数据键 + 该 bvid 的分键索引条目一并移除），并把被清理族的重写回清单（自愈）。
 * 返回 { [family]: string[] }（清理出的数据键，可能含已不存在的键）；淘汰本身静默：
 * 任何失败吞掉并返回 {}。
 */
export async function pruneToRecentVideos(
  families: string[] = CACHE_FAMILIES,
  keep: number = LRU_KEEP_VIDEOS
): Promise<Record<string, string[]>> {
  try {
    const storage = requireStorageLocal();
    const safeKeep = Math.max(1, Math.floor(Number(keep)) || LRU_KEEP_VIDEOS);
    const familyList = (Array.isArray(families) ? families : []).filter(
      (f): f is string => typeof f === "string" && Boolean(f)
    );
    if (familyList.length === 0) {
      return {};
    }

    const all = await storage.get(null);
    const manifest = normalizeManifest(all?.[LRU_MANIFEST_KEY]);

    // 分键索引按 族 → bvid → { ts(取最大), keys } 归并。
    const indexed = new Map<string, Map<string, { ts: number; keys: Set<string> }>>();
    for (const storageKey of Object.keys(all || {})) {
      if (!storageKey.startsWith(LRU_INDEX_ENTRY_PREFIX)) {
        continue;
      }
      const parsed = parseIndexEntryKey(storageKey);
      const ts = normalizeEntryTs((all as Record<string, unknown>)[storageKey]);
      if (!parsed || ts === null) {
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
      // 候选键：分键索引并集 ∪ 族前缀数据键（同一份快照过滤，覆盖「索引丢过键 /
      // 索引缺失」的遗留面，zero 额外往返）。
      const candidateKeys = new Set<string>();
      if (familyIndexed) {
        for (const entry of familyIndexed.values()) {
          for (const key of entry.keys) {
            candidateKeys.add(key);
          }
        }
      }
      for (const key of Object.keys(all || {})) {
        // 最长前缀归属：撞前缀键（boc_lvs_analysis_final_*）只归自己的族，
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

      const ranked = [...timestamps.entries()].sort((a, b) => b[1] - a[1]);
      const keepSet = new Set(ranked.slice(0, safeKeep).map(([bvid]) => bvid));
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
        const entryPrefix = `${LRU_INDEX_ENTRY_PREFIX}${family}:${bvid}:`;
        for (const storageKey of Object.keys(all || {})) {
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
        await storage.set({ [LRU_MANIFEST_KEY]: { ...manifest, ...manifestRewrite } });
      } catch {
        // 清单重写失败静默（启发式元数据，允许丢）。
      }
    }
    return removed;
  } catch {
    return {};
  }
}

// prune 短路检查：各族清单条目的 bvid 数都 ≤ keep → true。清单只是启发式——
// 并发新增互相覆盖只会少计（多留旧视频），不会多计；少计方向由 prune 的真枚举兜底。
function familiesWithinKeep(manifest: LruManifest, families: string[], keep: number): boolean {
  const safeKeep = Math.max(1, Math.floor(Number(keep)) || LRU_KEEP_VIDEOS);
  const familyList = (Array.isArray(families) ? families : []).filter(
    (f): f is string => typeof f === "string" && Boolean(f)
  );
  return familyList.every((family) => Object.keys(manifest[family] || {}).length <= safeKeep);
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
  { keep = LRU_KEEP_VIDEOS, pruneFamilies = CACHE_FAMILIES }: { keep?: number; pruneFamilies?: string[] } = {}
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
  keep = LRU_KEEP_VIDEOS,
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
// 消费实例：ai/segment-cache.ts（boc_lvs_summary_ / boc_lvs_raw_ 两族）与
// ai/analysis.ts（boc_lvs_analysis_final_ / boc_lvs_analysis_ 两族）。
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
  /** 字幕轨 source key 推导（注入 subtitle/cache.ts 的 buildSubtitleSourceKey）。 */
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
