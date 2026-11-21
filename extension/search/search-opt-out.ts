import { clearSearchCache } from "./search-cache.js";
import { logWarn } from "../shared/logging.js";

export function isSearchOptOut(prevEnabled: boolean, payload: unknown): boolean {
  const value = (payload as { webSearchEnabled?: unknown } | null | undefined)?.webSearchEnabled;
  return value === false && prevEnabled === true;
}

export interface SearchOptOutHookDeps {
  clearCache?: () => Promise<void>;
  logWarn?: (message: string, error?: unknown) => void;
}

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
