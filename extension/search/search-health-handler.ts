// 引擎健康度记账 SW 端消息 handler（arch-review-2026-09/08）：执行侧（offscreen /
// content）无 chrome.storage，记账经 `search-health` 消息族落到 SW 叶
// ./search-health.js 单源（脏载荷静默 no-op、写失败静默、SW 侧盖时间戳）。
// 落盘后 **inline 失效**健康度快照（recordSearchAttemptWithInvalidate 在本工厂内
// 组合）：写后读（紧随其后的 resolve-search-provider）立刻消费新冷却图。
// 来源守卫：本族**不得**进来源名单（协议层 OFFSCREEN_ONLY_MESSAGE_TYPES，注册表
// 逐条 sender 标签派生）——本族发送者含 content（reader/explain-card.ts 与
// offscreen 工具循环共用 search-chain.ts 的缺省记账）。
// handler 工厂形态照 ai/segment-cache-handler.ts 先例（withOkResponse 收口异步错误回包）。

import { invalidatingWrite } from "../core/settings-snapshot.js";
import { withOkResponse } from "../core/provider-handlers.js";
import { SEARCH_HEALTH_KEY, recordSearchAttempt } from "./search-health.js";
import type { SearchHealthMessage, SearchHealthResponse } from "../shared/messaging-protocol.js";

// 回包形参按本条消息收型（健康度响应形状），返回 void——search-health 登记为 async，
// 回包时机归注册表 reply、入口 resolveReplyKeepOpen 兑现。
export function createSearchHealthHandler(): (
  message: SearchHealthMessage,
  sender: unknown,
  sendResponse: (response: SearchHealthResponse) => void
) => void {
  // 引擎健康度记账叶：单键快照位，落盘后立即失效（紧随其后的 resolve 消费新冷却图）。
  const recordSearchAttemptWithInvalidate = invalidatingWrite(recordSearchAttempt, [SEARCH_HEALTH_KEY]);

  return function handleSearchHealth(
    message: SearchHealthMessage,
    _sender: unknown,
    sendResponse: (response: SearchHealthResponse) => void
  ): void {
    withOkResponse(
      (async () => {
        if (message.op !== "record") {
          throw new Error("不支持的搜索健康度操作：" + String((message as { op?: unknown }).op));
        }
        await recordSearchAttemptWithInvalidate(message.presetId, message.ok, message.latencyMs);
        return { ok: true };
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
  };
}
