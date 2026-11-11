import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInterpretSubtitleOverlay } from "../../extension/live/interpret-subtitle-overlay.js";
import type { LiveInterpretTargetLang } from "../../extension/live/interpret-subtitle-preferences.js";

let playerHost: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  playerHost = document.createElement("div");
  playerHost.className = "bpx-player-container";
  document.body.appendChild(playerHost);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function createOverlay(
  displayMode: "auto" | "translation" | "bilingual" = "auto",
  targetLang: LiveInterpretTargetLang = "zh"
) {
  return createInterpretSubtitleOverlay({
    getPlayerHost: () => playerHost,
    getTargetLang: () => targetLang,
    getDisplayMode: () => displayMode
  });
}

describe("同声传译字幕浮层", () => {
  it("原文与译文快照即时覆盖，原文在上译文在下", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("Hello", "你");

    const root = overlay.getElement()!;
    const original = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(root.hidden).toBe(false);
    expect(playerHost.contains(root)).toBe(true);
    expect(original.textContent).toBe("Hello");
    expect(translation.textContent).toBe("你");
    expect(original.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    overlay.setSubtitle("Hello world", "你好，世界");
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-original")).toHaveLength(1);
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-translation")).toHaveLength(1);
    expect(original.textContent).toBe("Hello world");
    expect(translation.textContent).toBe("你好，世界");
    overlay.dispose();
  });

  it("不同显示模式下的显隐行为（仅译文 / 双语 / 自动）", () => {
    const overlayTranslationOnly = createOverlay("translation", "zh");
    overlayTranslationOnly.setSubtitle("Hello", "你好");
    const root1 = overlayTranslationOnly.getElement()!;
    const original1 = root1.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation1 = root1.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(original1.hidden).toBe(true);
    expect(translation1.hidden).toBe(false);
    expect(translation1.textContent).toBe("你好");
    overlayTranslationOnly.dispose();

    const overlayBilingual = createOverlay("bilingual", "zh");
    overlayBilingual.setSubtitle("Hello", "你好");
    const root2 = overlayBilingual.getElement()!;
    const original2 = root2.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation2 = root2.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(original2.hidden).toBe(false);
    expect(translation2.hidden).toBe(false);
    overlayBilingual.dispose();
  });

  it("clear 立即清空当前字幕浮层并隐藏", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("旧原文", "旧译文");
    const root = overlay.getElement()!;
    expect(root.hidden).toBe(false);

    overlay.clear();
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");

    overlay.setSubtitle("新原文", "新译文");
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("新原文新译文");
    overlay.dispose();
  });

  it("clearForSeek 立即清空当前字幕浮层", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("seek 前原文", "seek 前译文");
    const root = overlay.getElement()!;

    overlay.clearForSeek();
    expect(root.hidden).toBe(true);

    overlay.setSubtitle("seek 后原文", "seek 后译文");
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("seek 后原文seek 后译文");
    overlay.dispose();
  });

  it("轻量状态提示独立显示，支持自动定时隐藏", () => {
    vi.useFakeTimers();
    const overlay = createOverlay();
    overlay.showNotice("处理中...", 1000);

    let notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("处理中...");
    expect(notice?.getAttribute("role")).toBe("status");

    vi.advanceTimersByTime(1000);
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();

    overlay.showNotice("实时翻译已关闭", 0);
    notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("实时翻译已关闭");
    overlay.dispose();
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();
  });

  it("dispose 清理 DOM 节点与状态", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("原文", "译文");
    expect(playerHost.querySelector(".biliscript-interpret-subtitle-overlay")).not.toBeNull();

    overlay.dispose();
    expect(playerHost.querySelector(".biliscript-interpret-subtitle-overlay")).toBeNull();
    expect(overlay.getElement()).toBeNull();
  });
});
