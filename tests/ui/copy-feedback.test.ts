// tests/ui/copy-feedback.test.ts
// 复制成功瞬态反馈控制器单元测试：
//   1. 成功触发时置换为对勾图标、添加 .is-copied 类、更新 aria-label 与 title 为「已复制」；
//   2. 2000ms（行业主流黄金时长）后平滑复原为原图标与文案；
//   3. 重入触发时重置倒计时，不提前复原；
//   4. 支持自定义文案与时长参数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flashCopySuccess, DEFAULT_COPY_FEEDBACK_MS } from "../../extension/ui/copy-feedback.js";
import { READING_CHECK_ICON, READING_COPY_ICON } from "../../extension/ui/reading-icons.js";

describe("复制成功反馈控制器 (flashCopySuccess)", () => {
  let button: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    button = document.createElement("button");
    button.type = "button";
    button.innerHTML = READING_COPY_ICON;
    button.setAttribute("aria-label", "复制回复");
    button.setAttribute("title", "复制回复");
    document.body.appendChild(button);
  });

  afterEach(() => {
    vi.useRealTimers();
    button.remove();
  });

  it("点击复制成功：即刻置换为对勾图标并添加 .is-copied 状态类", () => {
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制回复"
    });

    expect(button.innerHTML).toBe(READING_CHECK_ICON);
    expect(button.getAttribute("aria-label")).toBe("已复制");
    expect(button.getAttribute("title")).toBe("已复制");
    expect(button.classList.contains("is-copied")).toBe(true);
  });

  it("默认在 2000ms 后自动恢复原图标与无障碍标签", () => {
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制回复"
    });

    // 1999ms 时仍为已复制状态
    vi.advanceTimersByTime(DEFAULT_COPY_FEEDBACK_MS - 1);
    expect(button.innerHTML).toBe(READING_CHECK_ICON);
    expect(button.classList.contains("is-copied")).toBe(true);

    // 满 2000ms 触发复原
    vi.advanceTimersByTime(1);
    expect(button.innerHTML).toBe(READING_COPY_ICON);
    expect(button.getAttribute("aria-label")).toBe("复制回复");
    expect(button.getAttribute("title")).toBe("复制回复");
    expect(button.classList.contains("is-copied")).toBe(false);
  });

  it("倒计时期间重复点击：重置 2000ms 计时器，不发生过早还原", () => {
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制回复"
    });

    // 过去 1500ms 后再次触发复制
    vi.advanceTimersByTime(1500);
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制回复"
    });

    // 距离第一次触发已满 2000ms（但距离第二次仅 500ms），应维持对勾
    vi.advanceTimersByTime(600);
    expect(button.innerHTML).toBe(READING_CHECK_ICON);
    expect(button.classList.contains("is-copied")).toBe(true);

    // 距离第二次触发满 2000ms，完成复原
    vi.advanceTimersByTime(1400);
    expect(button.innerHTML).toBe(READING_COPY_ICON);
    expect(button.classList.contains("is-copied")).toBe(false);
  });

  it("支持自定义文案与停留时长", () => {
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制该金句",
      copiedLabel: "金句已复制",
      durationMs: 1200
    });

    expect(button.getAttribute("aria-label")).toBe("金句已复制");
    expect(button.getAttribute("title")).toBe("金句已复制");

    vi.advanceTimersByTime(1200);
    expect(button.innerHTML).toBe(READING_COPY_ICON);
    expect(button.getAttribute("aria-label")).toBe("复制该金句");
    expect(button.getAttribute("title")).toBe("复制该金句");
  });
});
