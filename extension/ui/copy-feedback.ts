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
