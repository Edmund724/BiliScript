// extension/search/search-opt-out.ts
// 「关 pill」撤回判据与撤回钩子（spec §6.7 / §10 第 40 行）：撤回是搜索域知识
//（缓存里存着 query 哈希与结果，撤回后本地继续留着说不通），判据纯函数与清缓存
// 钩子都住本域，core 的 save-settings 处理器工厂只消费钩子。
//
// 撤回入口分工（两入口不合拢，各留触发点）：
//   1. 主入口（关 pill，webSearchEnabled true→false）：save-settings 消息处理内经
//      isSearchOptOut 判定、onSearchOptOut 钩子清缓存（本模块）；
//   2. 次入口（删除搜索平台记录撤回）：search/search-provider-deletion.ts 事务内串联。

import { clearSearchCache } from "./search-cache.js";
import { logWarn } from "../shared/logging.js";

// 撤回判据：只有 webSearchEnabled **从 true 变 false** 才是「关 pill」的撤回——
// content 侧整份 state.settings 落盘时 pill 恒 false，按 payload === false 判会把
// 与撤回无关的保存误判成撤回。payload 不带该键、false→false、true→true 都不是。
// prevEnabled 取**保存前**的快照值（判定用保存前的值，失效顺序维持既有形态）。
export function isSearchOptOut(prevEnabled: boolean, payload: unknown): boolean {
  const value = (payload as { webSearchEnabled?: unknown } | null | undefined)?.webSearchEnabled;
  return value === false && prevEnabled === true;
}

export interface SearchOptOutHookDeps {
  clearCache?: () => Promise<void>;
  logWarn?: (message: string, error?: unknown) => void;
}

// 撤回钩子：清空整张查询缓存；清空失败静默（logWarn 同既有形态），不因缓存清理
// 失败阻断设置保存的回包。依赖缺省取本域实现，组合根可一行装配注入。
export function createSearchOptOutHook({
  clearCache,
  logWarn: warn
}: SearchOptOutHookDeps = {}): () => Promise<void> {
  return async function onSearchOptOut(): Promise<void> {
    try {
      await (clearCache ?? clearSearchCache)();
    } catch (error) {
      (warn ?? logWarn)("[BILISCRIPT] search cache clear on opt-out failed", error);
    }
  };
}
