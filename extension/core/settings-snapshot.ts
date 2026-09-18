// extension/core/settings-snapshot.ts
// SW 设置快照：四个热路径读 handler（resolve-ai-provider /
// resolve-search-provider / get-asr-runtime-config / get-settings，外加同链的
// player-ai-quick-action）读设置/平台存储的唯一读路径（sw-settings-snapshot
// 票，架构评审候选 3 落地）。此前这四个 handler 每条聊天消息全量直读
// storage（resolve-ai-provider 内 aiProviderKeys 还重复读两次，≥6 次读 +
// 25 步归一化）。本模块缓存两族读取产物：
//   - settings 全量：getMergedSettings 的 normalizeSettings 产物；
//   - 三 providerStore（ai/asr/search）：normalize + hasSavedKey 装配产物 +
//     明文 Key 映射（keys 只活在 SW，回包仍只带 hasSavedKey 占位）。
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
// 写路径纪律：快照只服务读路径。provider-store 的 load-modify-write 与
// saveSettings 继续直读/直写存储，不经快照；加 write-through 必须先解决
// 并发写交错丢 Key（spec Q3）。
//
// 守叶子纪律：本模块拖入的 store/归一化模块本就在 SW 静态图里
// （background 直 import 三 store 与 settings-store），不新增静态边。
// 缓存条目按引用返回：handler 回包经消息序列化天然隔离，调用方不得原地
// 改写快照产物。

import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { getMergedSettings } from "./settings-store.js";
import type { ProviderBase, ProviderKeys } from "./provider-store.js";
import { aiProviderStore, type AiProvider } from "./ai-provider-store.js";
import { asrProviderStore, type AsrProvider } from "../asr/asr-provider-store.js";
import { searchProviderStore } from "../search/search-provider-store.js";
import type { SearchProvider } from "../search/search-provider-normalize.js";
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

// 族 → storage 键面（失效映射与 onChanged 订阅键面共用；列表进 sync、
// Key 明文进 local，与 provider-store 存储布局不变式一致）。
export const PROVIDER_FAMILY_STORAGE_KEYS: Record<ProviderFamily, readonly string[]> = {
  ai: ["aiProviders", "aiProviderKeys"],
  asr: ["asrProviders", "asrProviderKeys"],
  search: ["searchProviders", "searchProviderKeys"]
};

const PROVIDER_FAMILIES = Object.keys(PROVIDER_FAMILY_STORAGE_KEYS) as ProviderFamily[];

// settings 域的 storage 键面 = DEFAULT_SETTINGS 声明的键集（saveSettings
// 白名单与安装/更新迁移的落盘键集都是它的子集）。
const SETTINGS_DOMAIN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_SETTINGS));

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

// 按 storage 键失效：命中 settings 键面清 settings 快照；命中某族 list/keys
// 键清该族快照（一族共享一个缓存条目）。未知键忽略——写 handler 直接传
// payload 键全集，白名单外的键自然落空。
export function invalidate(storageKeys: readonly string[]): void {
  let settingsDirty = false;
  const dirtyFamilies = new Set<ProviderFamily>();
  for (const key of storageKeys) {
    if (SETTINGS_DOMAIN_KEYS.has(key)) {
      settingsDirty = true;
    }
    for (const family of PROVIDER_FAMILIES) {
      if (PROVIDER_FAMILY_STORAGE_KEYS[family].includes(key)) {
        dirtyFamilies.add(family);
      }
    }
  }
  if (settingsDirty) {
    settingsCache = null;
  }
  for (const family of dirtyFamilies) {
    familyCaches[family] = null;
  }
}

// onChanged 兜底：订阅键面 = settings 键面 ∪ 三族 list（sync）∪ 三族 keys
// （local）；命中即按键域失效。写入方上下文不触发本事件，跨设备 sync 与
// 其它扩展上下文（content 直写等）的变更经此通道进快照。
watchStorageKeys(
  (changes) => {
    invalidate(Object.keys(changes));
  },
  {
    sync: [...SETTINGS_DOMAIN_KEYS, "aiProviders", "asrProviders", "searchProviders"],
    local: ["aiProviderKeys", "asrProviderKeys", "searchProviderKeys"]
  }
);
