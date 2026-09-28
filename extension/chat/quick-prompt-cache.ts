// extension/chat/quick-prompt-cache.ts
// 初始快捷问题的内存缓存：键 = 上下文键（buildContextKey 的 `video:bvid|cid`），
// 值 = 本视频生成出的三条问题。
//
// 为什么需要它：生成是异步预热（字幕就绪即起跑），而建议区渲染是同步的
//（reader/chat-lists.ts 的 renderSuggestions）——缓存是这两者之间唯一的状态，
// 也是「同一视频只花一次请求」的去重依据（切走再切回、字幕就绪通知与抓取落定
// 对账重复触发，都命中这里）。
//
// 双实例纪律：本文件含模块级可变状态（Map + 订阅集），读写双方全部在懒加载区
// reader 域内——写方 reader/quick-prompts.ts（lifecycle 触发），读方
// reader/chat-lists.ts（对话 tab 渲染），轮 B 构建把两者共用的本模块提升为同一
// 个共享 chunk，单实例成立；常驻侧不碰本文件任何状态。
//
// 生命周期：只在内存（阅读会话级）。不落 chrome.storage 是刻意的——预热成本是
// 每个视频一次小请求，跨页面加载重算一次可以接受；落盘要引入键位、容量与失效
// 策略，收益不抵复杂度。

import { normalizePromptList } from "./quick-prompts.js";

// 缓存条目上限（FIFO 淘汰）：一个阅读会话里来回切的视频数量级个位数，
// 8 条足够覆盖，超出即淘汰最早的键（避免长时间刷站无限增长）。
export const MAX_QUICK_PROMPT_CACHE_ENTRIES = 8;

const cache = new Map<string, string[]>();
const listeners = new Set<() => void>();

function normalizeKey(contextKey: unknown): string {
  return String(contextKey ?? "").trim();
}

// 读：未命中返回 null（调用方据此回落固定三条 / 触发预热），命中的是副本
//（渲染层改写不会污染缓存）。
export function readCachedQuickPrompts(contextKey: unknown): string[] | null {
  const key = normalizeKey(contextKey);
  if (!key) {
    return null;
  }
  const hit = cache.get(key);
  return hit ? hit.slice() : null;
}

// 写：空键 / 空表不落缓存；内容未变不重写也不通知。写入即通知订阅者（对话 tab
// 据此把兜底的三条换成生成结果）。
export function writeCachedQuickPrompts(contextKey: unknown, prompts: unknown): void {
  const key = normalizeKey(contextKey);
  const list = normalizePromptList(prompts);
  if (!key || !list.length) {
    return;
  }
  const previous = cache.get(key);
  if (previous && previous.join("\u0000") === list.join("\u0000")) {
    return;
  }
  // 先删后插：重写的键排到队尾，FIFO 淘汰的是最久未更新的条目。
  cache.delete(key);
  cache.set(key, list);
  while (cache.size > MAX_QUICK_PROMPT_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 订阅者异常不打断写入方（缓存已落，渲染失败由各自模块的既有兜底处理）
    }
  }
}

// 订阅缓存变化（对话 tab 用来重渲建议区）。返回解绑函数，重复解绑幂等。
export function subscribeQuickPromptsChange(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 测试注入口：清空缓存与订阅（单纪元内复用的 beforeEach 用）。生产代码不得调用。
export function resetQuickPromptCacheForTests(): void {
  cache.clear();
  listeners.clear();
}
