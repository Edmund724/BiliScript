// extension/ui/copy-feedback.ts
// 复制成功瞬态反馈控制器：
// 按钮点击复制成功后，把图标置换为对勾并设置 .is-copied 状态类与已复制无障碍文案，
// 2000ms（行业主流基准时长）后平滑复原为原图标与文案。
// 内部使用 WeakMap 维护各按钮的定时器，重入触发时重置倒计时，天然无内存泄露。

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

// 复制/导出失败的就地反馈：保留原图标，仅以 .is-copy-failed 着危险色并换无障碍文案，
// 与成功态共用同一计时器表，两态互相覆盖时只剩最后一次的复原倒计时。
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
