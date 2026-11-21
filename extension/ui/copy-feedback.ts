import { READING_CHECK_ICON } from "./reading-icons.js";

export const DEFAULT_COPY_FEEDBACK_MS = 2000;

const copyTimers = new WeakMap<HTMLElement, number>();

export interface CopyFeedbackOptions {
  originalSvg: string;
  originalLabel?: string;
  copiedLabel?: string;
  durationMs?: number;
}

export function flashCopySuccess(
  btn: HTMLElement,
  options: CopyFeedbackOptions
): void {
  const existingTimer = copyTimers.get(btn);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }

  const {
    originalSvg,
    originalLabel = btn.getAttribute("aria-label") || btn.getAttribute("title") || "复制",
    copiedLabel = "已复制",
    durationMs = DEFAULT_COPY_FEEDBACK_MS
  } = options;

  btn.innerHTML = READING_CHECK_ICON;
  btn.setAttribute("aria-label", copiedLabel);
  btn.setAttribute("title", copiedLabel);
  btn.classList.add("is-copied");

  const timer = window.setTimeout(() => {
    btn.innerHTML = originalSvg;
    btn.setAttribute("aria-label", originalLabel);
    btn.setAttribute("title", originalLabel);
    btn.classList.remove("is-copied");
    copyTimers.delete(btn);
  }, durationMs);

  copyTimers.set(btn, timer);
}

export function flashCopyFailure(
  btn: HTMLElement,
  options: { originalLabel?: string; failedLabel?: string; durationMs?: number } = {}
): void {
  const existingTimer = copyTimers.get(btn);
  if (existingTimer !== undefined) {
    window.clearTimeout(existingTimer);
  }

  const {
    originalLabel = btn.getAttribute("aria-label") || btn.getAttribute("title") || "复制",
    failedLabel = "复制失败",
    durationMs = DEFAULT_COPY_FEEDBACK_MS
  } = options;

  btn.setAttribute("aria-label", failedLabel);
  btn.setAttribute("title", failedLabel);
  btn.classList.add("is-copy-failed");

  const timer = window.setTimeout(() => {
    btn.setAttribute("aria-label", originalLabel);
    btn.setAttribute("title", originalLabel);
    btn.classList.remove("is-copy-failed");
    copyTimers.delete(btn);
  }, durationMs);

  copyTimers.set(btn, timer);
}
