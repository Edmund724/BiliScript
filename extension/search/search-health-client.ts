import type { SearchHealthMessage } from "../shared/messaging-protocol.js";

export function recordSearchAttempt(presetId: string, ok: boolean, latencyMs: number): void {
  try {
    const pending = chrome.runtime.sendMessage({
      type: "search-health",
      op: "record",
      presetId,
      ok,
      latencyMs
    } satisfies SearchHealthMessage) as Promise<unknown> | undefined;
    void pending?.catch(() => {});
  } catch {
  }
}
