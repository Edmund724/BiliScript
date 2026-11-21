import { logWarn } from "../shared/logging.js";

export const INTERPRET_SUBTITLE_POSITION_RATIO_KEY = "interpretSubtitlePositionRatio";
export const INTERPRET_POSITION_RATIO_MIN = 0.04;
export const INTERPRET_POSITION_RATIO_MAX = 0.85;

export function clampInterpretPositionRatio(
  value: unknown,
  fallback: number | null = null
): number | null {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(
    INTERPRET_POSITION_RATIO_MAX,
    Math.max(INTERPRET_POSITION_RATIO_MIN, parsed)
  );
}

function storageLocal(): chrome.storage.StorageArea | undefined {
  try {
    return globalThis.chrome?.storage?.local;
  } catch {
    return undefined;
  }
}

export async function loadInterpretPositionRatio(): Promise<number | null> {
  const area = storageLocal();
  if (!area) {
    return null;
  }
  try {
    const stored = (await area.get(INTERPRET_SUBTITLE_POSITION_RATIO_KEY)) as
      | Record<string, unknown>
      | undefined;
    return clampInterpretPositionRatio(stored?.[INTERPRET_SUBTITLE_POSITION_RATIO_KEY], null);
  } catch (error) {
    logWarn("[BILISCRIPT] interpret position ratio load failed", error);
    return null;
  }
}

export function saveInterpretPositionRatio(ratio: number): void {
  const clamped = clampInterpretPositionRatio(ratio, null);
  if (clamped === null) {
    return;
  }
  const area = storageLocal();
  if (!area) {
    return;
  }
  try {
    void Promise.resolve(
      area.set({ [INTERPRET_SUBTITLE_POSITION_RATIO_KEY]: clamped })
    ).catch((error) => {
      logWarn("[BILISCRIPT] interpret position ratio save failed", error);
    });
  } catch (error) {
    logWarn("[BILISCRIPT] interpret position ratio save failed", error);
  }
}
