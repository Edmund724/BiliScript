import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { withTimeout } from "../shared/error-helpers.js";

export async function getSettings(timeoutMs = 5000): Promise<Settings> {
  try {
    const response = await withTimeout(
      sendRuntimeMessage({ type: "get-settings" }),
      timeoutMs,
      new Error("getSettings timeout")
    );
    if (!response?.ok) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  } catch (error) {
    console.warn("[BILISCRIPT] getSettings fallback to defaults", (error as Error | undefined)?.message);
    return { ...DEFAULT_SETTINGS };
  }
}
