import {
  updateConversationHistory,
  type StoredConversation
} from "../chat/conversation-storage.js";
import type { StorageArea } from "../chat/conversation-store.js";
import { upsertLiveTextToolHistoryEntry } from "./live-text-tool-history.js";
import type { LiveTextToolRecord } from "./live-text-tool-records.js";

export async function persistLiveTextToolRecord(
  record: LiveTextToolRecord,
  storage?: StorageArea
): Promise<void> {
  const target = storage || (typeof chrome !== "undefined" ? chrome.storage?.local as StorageArea : undefined);
  if (!target || (record.status !== "completed" && record.status !== "failed") || !record.video) return;
  await updateConversationHistory(target, (current) =>
    upsertLiveTextToolHistoryEntry(current, record) as StoredConversation[]
  );
}
