import { invalidatingWrite } from "../core/settings-snapshot.js";
import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import { SEARCH_HEALTH_KEY, recordSearchAttempt } from "./search-health.js";
import type { SearchHealthMessage, SearchHealthResponse } from "../shared/messaging-protocol.js";

export function createSearchHealthHandler(): (
  message: SearchHealthMessage,
  sender: unknown,
  sendResponse: (response: SearchHealthResponse) => void
) => void {
  const recordSearchAttemptWithInvalidate = invalidatingWrite(recordSearchAttempt, [SEARCH_HEALTH_KEY]);

  return defineStorageMessageFamily<SearchHealthMessage, SearchHealthResponse>({
    type: "search-health",
    unknownOpText: "不支持的搜索健康度操作：",
    ops: {
      record: async (message) => {
        await recordSearchAttemptWithInvalidate(message.presetId, message.ok, message.latencyMs);
        return { ok: true };
      }
    }
  });
}
