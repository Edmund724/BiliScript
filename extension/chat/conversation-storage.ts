import { normalizeConversations } from "../ai/conversation.js";
import { setSavedConversations } from "./chat-state.js";
import type { StorageArea } from "./conversation-store.js";

export type StoredConversation = ReturnType<typeof normalizeConversations>[number];
export const HISTORY_STORAGE_KEY = "biliscript_ai_conversations_v1";

const queues = new WeakMap<StorageArea, Promise<unknown>>();

function enqueue<T>(storage: StorageArea, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(storage) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(storage, next);
  return next.finally(() => {
    if (queues.get(storage) === next) queues.delete(storage);
  });
}

export function readConversationHistory(storage: StorageArea): Promise<StoredConversation[]> {
  return enqueue(storage, async () => {
    const data = await storage.get([HISTORY_STORAGE_KEY]).catch(() => ({} as Record<string, unknown>));
    const conversations = normalizeConversations(data?.[HISTORY_STORAGE_KEY]);
    setSavedConversations(conversations);
    return conversations;
  });
}

export function updateConversationHistory(
  storage: StorageArea,
  update: (current: StoredConversation[]) => StoredConversation[]
): Promise<StoredConversation[]> {
  return enqueue(storage, async () => {
    const data = await storage.get([HISTORY_STORAGE_KEY]);
    const current = normalizeConversations(data?.[HISTORY_STORAGE_KEY]);
    const next = normalizeConversations(update(current));
    await storage.set({ [HISTORY_STORAGE_KEY]: next });
    setSavedConversations(next);
    return next;
  });
}
