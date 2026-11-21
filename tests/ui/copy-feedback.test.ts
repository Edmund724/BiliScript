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

    vi.advanceTimersByTime(DEFAULT_COPY_FEEDBACK_MS - 1);
    expect(button.innerHTML).toBe(READING_CHECK_ICON);
    expect(button.classList.contains("is-copied")).toBe(true);

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

    vi.advanceTimersByTime(1500);
    flashCopySuccess(button, {
      originalSvg: READING_COPY_ICON,
      originalLabel: "复制回复"
    });

    vi.advanceTimersByTime(600);
    expect(button.innerHTML).toBe(READING_CHECK_ICON);
    expect(button.classList.contains("is-copied")).toBe(true);

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
