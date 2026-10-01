// extension/search/search-health-client.ts
// 引擎健康度记账发送方 proxy（spec §12.4 第 7 条 / §12.5 第 4 行、票 15 §4）：
// 链执行侧（offscreen 工具循环 / content 选区解释卡）无 `chrome.storage`，记账经
// **新消息族 `search-health`**（op `record`，SW 侧盖时间戳并落
// `search/search-health.ts` 单源）交给 SW。形态照 `search-cache-client` 的
// 「fire-and-forget + 失败静默」：不返回结果、不上 notice、不抛——记账绝不影响
// 搜索与回答。
import type { SearchHealthMessage } from "../shared/messaging-protocol.js";

/**
 * 记一次引擎尝试（fire-and-forget）：发送即返回；无接收方 / SW 冷启动竞态 /
 * 回包失败一律静默（回包内容不消费，故不设软超时——不阻塞调用方）。
 */
export function recordSearchAttempt(presetId: string, ok: boolean, latencyMs: number): void {
  try {
    const pending = chrome.runtime.sendMessage({
      type: "search-health",
      op: "record",
      presetId,
      ok,
      latencyMs
    } satisfies SearchHealthMessage) as Promise<unknown> | undefined;
    // 无接收方时 sendMessage 的 Promise 会 reject：吞掉，不进 unhandled rejection。
    void pending?.catch(() => {});
  } catch {
    // 失败静默
  }
}
