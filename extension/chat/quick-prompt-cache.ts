import { normalizePromptList } from "./quick-prompts.js";

export const MAX_QUICK_PROMPT_CACHE_ENTRIES = 8;

const cache = new Map<string, string[]>();
const listeners = new Set<() => void>();

function normalizeKey(contextKey: unknown): string {
  return String(contextKey ?? "").trim();
}

export function readCachedQuickPrompts(contextKey: unknown): string[] | null {
  const key = normalizeKey(contextKey);
  if (!key) {
    return null;
  }
  const hit = cache.get(key);
  return hit ? hit.slice() : null;
}

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
    }
  }
}

export function subscribeQuickPromptsChange(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetQuickPromptCacheForTests(): void {
  cache.clear();
  listeners.clear();
}
