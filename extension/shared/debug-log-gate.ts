import { registerDebugGate } from "./logging.js";
import { watchStorageKeys } from "./watch-storage-keys.js";

export function registerDebugLogGate(): void {
  if (typeof chrome === "undefined" || !chrome.storage?.sync?.get || !chrome.storage?.onChanged?.addListener) {
    return;
  }
  let enabled = false;
  registerDebugGate(() => enabled);
  const loadInitialDebugGate = async () => {
    try {
      const data = await chrome.storage.sync.get("enableDebugLogs");
      enabled = Boolean((data as { enableDebugLogs?: unknown })?.enableDebugLogs);
    } catch {
    }
  };
  void loadInitialDebugGate();
  watchStorageKeys((changes) => {
    enabled = Boolean(changes.enableDebugLogs.newValue);
  }, { sync: ["enableDebugLogs"] });
}
