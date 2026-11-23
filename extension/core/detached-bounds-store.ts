import { DEFAULT_SETTINGS } from "./defaults.js";
import { withTimeout } from "../shared/error-helpers.js";

export const DETACHED_WINDOW_BOUNDS_KEY = "biliscript_detached_window_bounds_v1";
export const MIN_DETACHED_WINDOW_WIDTH = 360;
export const MIN_DETACHED_WINDOW_HEIGHT = 420;
export const DEFAULT_DETACHED_WINDOW_HEIGHT = 760;

export interface DetachedWindowBounds {
  width: number;
  height: number;
}

export interface InitialDetachedWindowBoundsInput {
  saved?: DetachedWindowBounds | null;
  customPanelWidthEnabled?: boolean;
  customPanelWidth?: number;
  availHeight?: number;
}

export function clampDetachedWindowBounds(
  bounds: Partial<DetachedWindowBounds> | null | undefined
): DetachedWindowBounds {
  const rawWidth = bounds?.width;
  const rawHeight = bounds?.height;
  const width =
    typeof rawWidth === "number" && Number.isFinite(rawWidth)
      ? Math.max(MIN_DETACHED_WINDOW_WIDTH, Math.round(rawWidth))
      : MIN_DETACHED_WINDOW_WIDTH;
  const height =
    typeof rawHeight === "number" && Number.isFinite(rawHeight)
      ? Math.max(MIN_DETACHED_WINDOW_HEIGHT, Math.round(rawHeight))
      : MIN_DETACHED_WINDOW_HEIGHT;
  return { width, height };
}

export function parseDetachedWindowBounds(raw: unknown): DetachedWindowBounds | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as { width?: unknown; height?: unknown };
  if (
    typeof candidate.width !== "number" ||
    !Number.isFinite(candidate.width) ||
    candidate.width <= 0 ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.height) ||
    candidate.height <= 0
  ) {
    return null;
  }
  return clampDetachedWindowBounds({ width: candidate.width, height: candidate.height });
}

export function resolveInitialDetachedWindowBounds(
  input: InitialDetachedWindowBoundsInput = {}
): DetachedWindowBounds {
  const saved = parseDetachedWindowBounds(input.saved);
  if (saved) {
    return saved;
  }
  const rawWidth =
    input.customPanelWidthEnabled === true &&
    typeof input.customPanelWidth === "number" &&
    Number.isFinite(input.customPanelWidth) &&
    input.customPanelWidth > 0
      ? input.customPanelWidth
      : DEFAULT_SETTINGS.customPanelWidth;
  const rawHeight =
    typeof input.availHeight === "number" &&
    Number.isFinite(input.availHeight) &&
    input.availHeight > 0
      ? Math.min(DEFAULT_DETACHED_WINDOW_HEIGHT, Math.round(input.availHeight * 0.8))
      : DEFAULT_DETACHED_WINDOW_HEIGHT;
  return clampDetachedWindowBounds({ width: rawWidth, height: rawHeight });
}

export async function loadDetachedWindowBounds(timeoutMs = 5000): Promise<DetachedWindowBounds | null> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.get) {
      return null;
    }
    const stored = await withTimeout(
      chrome.storage.local.get([DETACHED_WINDOW_BOUNDS_KEY]),
      timeoutMs,
      new Error("storage timeout")
    );
    if (!stored || typeof stored !== "object") {
      return null;
    }
    return parseDetachedWindowBounds(
      (stored as Record<string, unknown>)[DETACHED_WINDOW_BOUNDS_KEY]
    );
  } catch {
    return null;
  }
}

export async function saveDetachedWindowBounds(
  bounds: DetachedWindowBounds
): Promise<DetachedWindowBounds> {
  const clamped = clampDetachedWindowBounds(bounds);
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local?.set) {
      await chrome.storage.local.set({ [DETACHED_WINDOW_BOUNDS_KEY]: clamped });
    }
  } catch {
  }
  return clamped;
}

export async function resetDetachedWindowBounds(): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local?.remove) {
      return;
    }
    await chrome.storage.local.remove(DETACHED_WINDOW_BOUNDS_KEY);
  } catch {
  }
}
