// extension/core/settings-snapshot.ts
// SW 设置快照：四个热路径读 handler（resolve-ai-provider /
// resolve-search-provider / get-asr-runtime-config / get-settings，外加同链的
// player-ai-quick-action）读设置/平台存储的唯一读路径（sw-settings-snapshot
// 票，架构评审候选 3 落地）。此前这四个 handler 每条聊天消息全量直读
// storage（resolve-ai-provider 内 aiProviderKeys 还重复读两次，≥6 次读 +
// 25 步归一化）。本模块缓存两族读取产物：
//   - settings 全量：getMergedSettings 的 normalizeSettings 产物；
//   - 三 providerStore（ai/asr/search）：normalize + hasSavedKey 装配产物 +
//     明文 Key 映射（keys 只活在 SW，回包仍只带 hasSavedKey 占位）；
//   - searchProviderOrder 原始值（sync；2026-10-01 增补，spec §12.3 / §12.5 第 9 行）：
//     归一在读取时对当前记录集合做（normalizeSearchProviderOrder 单源在
//     search/search-order.ts）；
//   - 引擎健康度图（local 单键 biliscript_search_health；2026-10-01 增补，spec §12.4
//     第 6 条 / §12.5 第 9 行）：链解析期产冷却图，读失败按空图。
// 命中时热路径 storage 读降为 0。设置 UI 的 list/get CRUD 读（*-providers-list /
// get-*-provider-key）不在快照范围：低频且要与写后响应负载严格同帧，维持直读
// provider-store。
//
// 失效双通道（缺一不可）：
//   - inline：SW 内写消息 handler 落盘 await 完成后调 invalidate(存储键)——
//     chrome.storage.onChanged 不在写入方上下文触发，inline 失效是「写后读」
//     语义成立的唯一保证（测试桩同理：vi.fn 不触发 onChanged）；
//   - onChanged 兜底：本模块经 shared/watch-storage-keys 订阅真实
//     chrome.storage.onChanged，覆盖其它扩展上下文与跨设备 sync 变更，
//     按键域（storage 键 → settings / 某 family 快照）失效。
//
// 写侧收口：键 → 缓存域 / 存储区的唯一真源是 SNAPSHOT_STORAGE_KEYS（下表）——
// invalidate 的判据与 onChanged 订阅面都从它派生，加一个缓存键只动这一张表；
// 落盘两个入口都在本模块：
//   - invalidatingWrite：包住调用方给的落盘动作（saveSettings / 族 store CRUD /
//     记账叶），落盘 + 按键面失效一次做完，写点不再手写 invalidate 调用、也不用
//     知道本次写入影响哪个域；
//   - writeSnapshotKeys（架构评审候选 7）：裸 storage 写（安装/更新迁移、自动激活
//     的链首与 flag、删除记录时的顺序剔除），调用方只交「哪些键的新值」，区由同一
//     张表反查——区不再是写点的入参，「写错区 = onChanged 按区过滤静默丢弃」在这条
//     seam 上不可表达。
//
// 写路径纪律：快照只服务读路径。provider-store 的 load-modify-write 与
// saveSettings 继续直读/直写存储，不经快照；加 write-through 必须先解决
// 并发写交错丢 Key（spec Q3）。两个写入口都不写快照缓存（条目仍只由读路径建立），
// 落盘语义也不搬到本模块：invalidatingWrite 只组合调用方给的落盘动作，
// writeSnapshotKeys 只按键面分区裸写。
//
// 守叶子纪律：本模块拖入的 store/归一化模块本就在 SW 静态图里
// （background 直 import 三 store 与 settings-store），不新增静态边。
// 缓存条目按引用返回：handler 回包经消息序列化天然隔离，调用方不得原地
// 改写快照产物。

import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { getMergedSettings } from "./settings-store.js";
import type { ProviderBase, ProviderKeys } from "./provider-store.js";
import { aiProviderStore, AI_PROVIDERS_STORAGE, AI_PROVIDER_KEYS_STORAGE, type AiProvider } from "./ai-provider-store.js";
import { asrProviderStore, ASR_PROVIDERS_STORAGE, ASR_PROVIDER_KEYS_STORAGE, type AsrProvider } from "../asr/asr-provider-store.js";
import { searchProviderStore, SEARCH_PROVIDER_ORDER_STORAGE, SEARCH_PROVIDERS_STORAGE, SEARCH_PROVIDER_KEYS_STORAGE } from "../search/search-provider-store.js";
import type { SearchProvider } from "../search/search-provider-normalize.js";
import { normalizeSearchProviderOrder } from "../search/search-order.js";
import { SEARCH_HEALTH_KEY, readSearchHealth, type SearchHealthMap } from "../search/search-health.js";
import { withTimeout } from "../shared/error-helpers.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";

export type ProviderFamily = "ai" | "asr" | "search";

interface ProviderFamilyMap {
  ai: AiProvider;
  asr: AsrProvider;
  search: SearchProvider;
}

// 一族快照：归一化 + hasSavedKey 装配产物 + 明文 Key 映射（SW 内专用）。
export interface ProviderStoreSnapshot<T extends ProviderBase = ProviderBase> {
  providers: Array<T & { hasSavedKey: boolean }>;
  keys: ProviderKeys;
}

// 族键对表（唯一真源，键字面量来自各族 store 模块的导出常量）：list → sync 区、
// keys → local 区——分区不是自由选择，与 provider-store 存储布局不变式一致
// （列表进 sync、明文 Key 只进 local），写进错区会被 shared/watch-storage-keys
// 的区过滤静默丢弃。
interface ProviderFamilyKeyPair {
  list: string;
  keys: string;
}

const PROVIDER_FAMILY_KEY_PAIRS: Record<ProviderFamily, ProviderFamilyKeyPair> = {
  ai: { list: AI_PROVIDERS_STORAGE, keys: AI_PROVIDER_KEYS_STORAGE },
  asr: { list: ASR_PROVIDERS_STORAGE, keys: ASR_PROVIDER_KEYS_STORAGE },
  search: { list: SEARCH_PROVIDERS_STORAGE, keys: SEARCH_PROVIDER_KEYS_STORAGE }
};

// 族 → storage 键面（写入口失效与 onChanged 订阅共用；从键对表派生，顺序恒为
// [list, keys]——background 的族写入口吃这个形状）。
function keyFace({ list, keys }: ProviderFamilyKeyPair): readonly string[] {
  return [list, keys];
}

export const PROVIDER_FAMILY_STORAGE_KEYS: Record<ProviderFamily, readonly string[]> = {
  ai: keyFace(PROVIDER_FAMILY_KEY_PAIRS.ai),
  asr: keyFace(PROVIDER_FAMILY_KEY_PAIRS.asr),
  search: keyFace(PROVIDER_FAMILY_KEY_PAIRS.search)
};

const PROVIDER_FAMILIES = Object.keys(PROVIDER_FAMILY_STORAGE_KEYS) as ProviderFamily[];

// settings 域的 storage 键面 = DEFAULT_SETTINGS 声明的键集（saveSettings
// 白名单与安装/更新迁移的落盘键集都是它的子集）。
const SETTINGS_DOMAIN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));

// ===== 键 → 缓存域的唯一真源 =====
// 一个 storage 键恰好归属一个快照域。这张表同时喂两条判据：
//   - invalidate(storageKeys)：键命中哪个域就清哪个缓存；
//   - onChanged 订阅面（文件末）：按 area 投影成 sync / local 两份订阅清单。
// 键字面量全部来自既有单源（DEFAULT_SETTINGS 键面 + 各族 store 模块导出的
// *_PROVIDERS_STORAGE / *_PROVIDER_KEYS_STORAGE + 搜索顺序与健康度叶的常量），
// 加一个缓存键只动这张表——此前「invalidate 判据」与「onChanged 订阅面」是两套
// 并行手抄逻辑，加键要同时改四处、漏改只表现为脏读。
// area 也不是自由选择：键写在哪个 storage 区由该键的既有写入方决定（列表与设置
// 进 sync、明文 Key 与运行态进 local）；声明错区的事件会被 shared/watch-storage-keys
// 的区过滤静默丢弃（测试逐键逐区钉住）。
export type SnapshotDomain = ProviderFamily | "settings" | "searchOrder" | "searchHealth";

export interface SnapshotStorageKey {
  key: string;
  area: "sync" | "local";
  domain: SnapshotDomain;
}

export const SNAPSHOT_STORAGE_KEYS: readonly SnapshotStorageKey[] = Object.freeze([
  ...[...SETTINGS_DOMAIN_KEYS].map(
    (key): SnapshotStorageKey => ({ key, area: "sync", domain: "settings" })
  ),
  ...PROVIDER_FAMILIES.flatMap(
    (family): SnapshotStorageKey[] => [
      { key: PROVIDER_FAMILY_KEY_PAIRS[family].list, area: "sync", domain: family },
      { key: PROVIDER_FAMILY_KEY_PAIRS[family].keys, area: "local", domain: family }
    ]
  ),
  { key: SEARCH_PROVIDER_ORDER_STORAGE, area: "sync", domain: "searchOrder" },
  { key: SEARCH_HEALTH_KEY, area: "local", domain: "searchHealth" }
]);

const SNAPSHOT_DOMAIN_BY_KEY: ReadonlyMap<string, SnapshotDomain> = new Map(
  SNAPSHOT_STORAGE_KEYS.map(({ key, domain }) => [key, domain] as const)
);

// 键 → 存储区的反查面（writeSnapshotKeys 的落区判据）：同表派生，区声明写错一处
// 即两处一起错不了——写点不再自己报区。
const SNAPSHOT_AREA_BY_KEY: ReadonlyMap<string, "sync" | "local"> = new Map(
  SNAPSHOT_STORAGE_KEYS.map(({ key, area }) => [key, area] as const)
);

interface FamilyStoreReader {
  loadProviders: () => Promise<Array<ProviderBase & { hasSavedKey: boolean }>>;
  loadKeys: () => Promise<ProviderKeys>;
}

const FAMILY_STORES: Record<ProviderFamily, FamilyStoreReader> = {
  ai: aiProviderStore,
  asr: asrProviderStore,
  search: searchProviderStore
};

let settingsCache: Promise<Settings> | null = null;
const familyCaches: Record<ProviderFamily, Promise<ProviderStoreSnapshot> | null> = {
  ai: null,
  asr: null,
  search: null
};
// searchProviderOrder 的**原始值**读缓存（spec §12.3 / §12.5 第 9 行）：归一在每次
// 调用时对「当前记录集合」做（记录集合由 search 族快照缓存保证零读）——归一判据依赖
// 当前记录，缓存归一结果会在记录增删后失真。失效只订阅该键本身（§12.3 跨上下文）。
let searchOrderCache: Promise<unknown> | null = null;
// 引擎健康度快照位（spec §12.4 第 6 条 / §12.5 第 9 行）：local 单键，读失败 / 超时按
// 空图（= 无引擎冷却，不拦任何链）；写入方在 SW 内（search-health 消息 handler），故
// 失效靠落盘后的 inline invalidate（onChanged 不在写入方触发）。
let searchHealthCache: Promise<SearchHealthMap> | null = null;

export function getSettings(): Promise<Settings> {
  // getMergedSettings 内部已吞错（超时回落默认值），永不 reject，直接缓存。
  settingsCache ??= getMergedSettings();
  return settingsCache;
}

export function getProviderStore<F extends ProviderFamily>(
  family: F
): Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>> {
  const cached = familyCaches[family];
  if (cached) return cached as Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>>;
  const store = FAMILY_STORES[family];
  const read = Promise.all([store.loadProviders(), store.loadKeys()]).then(
    ([providers, keys]) => ({ providers, keys })
  );
  read.catch(() => {
    if (familyCaches[family] === read) familyCaches[family] = null;
  });
  familyCaches[family] = read;
  return read as Promise<ProviderStoreSnapshot<ProviderFamilyMap[F]>>;
}

// 用户拖拽的搜索顺序快照位（spec §12.3 / §12.5 第 9 行）：sync 键缺席 = 无自定义
// 顺序；值为记录 id 数组，按**当前搜索记录集合**归一（脏值整体作废 → []）；读失败 /
// 超时按 [] ——顺序是偏好不是数据，任何失败都不得阻塞链解析。
export async function getSearchProviderOrder(): Promise<string[]> {
  try {
    searchOrderCache ??= withTimeout(
      chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]),
      5000,
      new Error("storage timeout")
    ).catch(() => undefined);
    const stored = (await searchOrderCache) as Record<string, unknown> | undefined;
    const { providers } = await getProviderStore("search");
    return normalizeSearchProviderOrder(
      stored?.[SEARCH_PROVIDER_ORDER_STORAGE],
      providers.map((provider) => provider.id)
    );
  } catch {
    return [];
  }
}

// 引擎健康度快照位（spec §12.4 第 6 条 / §12.5 第 9 行）：链解析期读一次交
// cooldownUntilByPresetId 产冷却图；读失败 / 超时按空图（不拦任何链）。返回值按引用
// 缓存——调用方不得原地改写（handler 回包经序列化天然隔离）。
export async function getSearchHealth(): Promise<SearchHealthMap> {
  try {
    searchHealthCache ??= withTimeout(
      readSearchHealth(),
      5000,
      new Error("storage timeout")
    ).catch(() => ({}));
    return await searchHealthCache;
  } catch {
    return {};
  }
}

// 按键失效：键 → 域查 SNAPSHOT_DOMAIN_BY_KEY，命中即清该域缓存；未知键落空——
// 写点传 payload 键全集（save-settings 的白名单外键）与直落形态派生出的运行态键
// 都自然忽略，不必先过滤。
export function invalidate(storageKeys: readonly string[]): void {
  for (const key of storageKeys) {
    const domain = SNAPSHOT_DOMAIN_BY_KEY.get(key);
    if (domain === "settings") {
      settingsCache = null;
    } else if (domain === "searchOrder") {
      searchOrderCache = null;
    } else if (domain === "searchHealth") {
      searchHealthCache = null;
    } else if (domain) {
      familyCaches[domain] = null;
    }
  }
}

// ===== 写入口：落盘 + 失效一次做完（写侧唯一入口）=====
// 把调用方给的落盘动作（saveSettings / 某族 store 的 CRUD / 记账叶 / 裸
// chrome.storage.set）包成「落盘 await 完成 → 立即按键域失效」的写函数：
//   - 失效时机与手写 invalidate 逐字一致，落盘 resolve 之后同步失效（onChanged
//     不在写入方上下文触发，inline 失效是写后读语义的唯一保证）；落盘 reject 时
//     原样抛出不失效——没落地就没有需要作废的读缓存。
//   - storageKeys 给常量（族键面直接吃 PROVIDER_FAMILY_STORAGE_KEYS、单键快照
//     位给该键）或给按入参派生的函数（裸 storage.set 形态用 Object.keys(changes)
//     派生）：派生形态让写点不必手抄 storage 键名，「抄错键 = 静默脏读」不再可能。
//   - 本入口自身不碰 storage、不写快照缓存：落盘语义仍归各族存储单源（白名单、
//     归一化、Key 合并都在那一侧），快照仍只读（无 write-through）。
export function invalidatingWrite<TArgs extends unknown[], TResult>(
  write: (...args: TArgs) => Promise<TResult>,
  storageKeys: readonly string[] | ((...args: TArgs) => readonly string[])
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    const result = await write(...args);
    invalidate(typeof storageKeys === "function" ? storageKeys(...args) : storageKeys);
    return result;
  };
}

// ===== 裸落盘入口：区由本模块的键面表决定（调用方不再报区）=====
// 安装/更新迁移、自动激活的链首与 flag、删除记录时的顺序剔除都是一次裸 storage 写：
// 调用方只交「哪些键的新值」，落哪个区由 SNAPSHOT_AREA_BY_KEY 反查——此前四个写点
// 各自硬写 "sync"，区写错只表现为 onChanged 按区过滤静默丢弃的脏快照；区现在不是
// 写点的入参，写错不可表达。settings 的白名单过滤仍归 settings-store（save-settings
// 走 invalidatingWrite 与它组合），本入口不做业务归一。
// 逐区落盘 + 逐区失效：某区落盘 await 完成后立即按该区键面失效（onChanged 不在写入
// 方上下文触发，inline 失效是写后读语义的唯一保证）；某区落盘失败时只有该区不失效
// （没落地就没有要作废的读缓存，已落盘的区照常失效），错误原样抛出不吞。
// 未知键抛错：键面外的键没有可推导的区，猜一个区就是新的脏快照源（表即键面全集）。
export async function writeSnapshotKeys(changes: Record<string, unknown>): Promise<void> {
  const syncChanges: Record<string, unknown> = {};
  const localChanges: Record<string, unknown> = {};
  // 先整体分区再落盘：未知键在产生任何副作用之前抛错（不半落半停）。
  for (const [key, value] of Object.entries(changes)) {
    const area = SNAPSHOT_AREA_BY_KEY.get(key);
    if (!area) {
      throw new Error(`未知的设置快照键：${key}（键面见 SNAPSHOT_STORAGE_KEYS）`);
    }
    (area === "sync" ? syncChanges : localChanges)[key] = value;
  }
  const syncKeys = Object.keys(syncChanges);
  if (syncKeys.length > 0) {
    await chrome.storage.sync.set(syncChanges);
    invalidate(syncKeys);
  }
  const localKeys = Object.keys(localChanges);
  if (localKeys.length > 0) {
    await chrome.storage.local.set(localChanges);
    invalidate(localKeys);
  }
}

// onChanged 兜底：订阅键面 = SNAPSHOT_STORAGE_KEYS 的区投影（sync 键进 sync 面、
// local 键进 local 面），命中即按键域失效；写入方上下文不触发本事件，跨设备 sync
// 与其它扩展上下文（content 直写等）的变更经此通道进快照。订阅面不再手抄第二份
// 键清单——派生自上面同一张表，与 invalidate 的判据不会分叉。
watchStorageKeys(
  (changes) => {
    invalidate(Object.keys(changes));
  },
  {
    sync: SNAPSHOT_STORAGE_KEYS.filter((entry) => entry.area === "sync").map((entry) => entry.key),
    local: SNAPSHOT_STORAGE_KEYS.filter((entry) => entry.area === "local").map((entry) => entry.key)
  }
);
