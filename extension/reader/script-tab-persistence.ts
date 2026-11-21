import { logWarn } from "../shared/logging.js";
import type { ReaderScriptTab } from "./state.js";

export const READER_ACTIVE_TAB_KEY = "readerActiveScriptTab";

const READER_SCRIPT_TABS: readonly ReaderScriptTab[] = ["subtitle", "overview", "chat"];

export function isReaderScriptTab(value: unknown): value is ReaderScriptTab {
  return READER_SCRIPT_TABS.indexOf(value as ReaderScriptTab) !== -1;
}

export function normalizeReaderScriptTab(value: unknown): ReaderScriptTab {
  return isReaderScriptTab(value) ? value : "subtitle";
}

function storageLocal(): chrome.storage.StorageArea | undefined {
  try {
    return globalThis.chrome?.storage?.local;
  } catch {
    return undefined;
  }
}

export async function loadReaderScriptTab(): Promise<ReaderScriptTab> {
  const area = storageLocal();
  if (!area) {
    return "subtitle";
  }
  try {
    const stored = (await area.get(READER_ACTIVE_TAB_KEY)) as Record<string, unknown> | undefined;
    return normalizeReaderScriptTab(stored?.[READER_ACTIVE_TAB_KEY]);
  } catch (error) {
    logWarn("[BILISCRIPT] reader active tab load failed", error);
    return "subtitle";
  }
}

export function saveReaderScriptTab(tab: ReaderScriptTab): void {
  const area = storageLocal();
  if (!area) {
    return;
  }
  try {
    void Promise.resolve(area.set({ [READER_ACTIVE_TAB_KEY]: tab })).catch((error) => {
      logWarn("[BILISCRIPT] reader active tab save failed", error);
    });
  } catch (error) {
    logWarn("[BILISCRIPT] reader active tab save failed", error);
  }
}
