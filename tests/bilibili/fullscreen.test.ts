import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isPlayerFullscreen, observeFullscreenChanges } from "../../extension/bilibili/fullscreen.js";

describe("bilibili/fullscreen 全屏状态判定与监听", () => {
  let playerContainer: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("无全屏时返回 false", () => {
    expect(isPlayerFullscreen(playerContainer)).toBe(false);
  });

  it("原生浏览器全屏检测通过", () => {
    Object.defineProperty(document, "fullscreenElement", {
      value: playerContainer,
      configurable: true
    });
    expect(isPlayerFullscreen(playerContainer)).toBe(true);
    Object.defineProperty(document, "fullscreenElement", {
      value: null,
      configurable: true
    });
  });

  it("B 站网页全屏 data-screen 属性检测", () => {
    playerContainer.setAttribute("data-screen", "web");
    expect(isPlayerFullscreen(playerContainer)).toBe(true);

    playerContainer.setAttribute("data-screen", "full");
    expect(isPlayerFullscreen(playerContainer)).toBe(true);

    playerContainer.removeAttribute("data-screen");
    expect(isPlayerFullscreen(playerContainer)).toBe(false);
  });

  it("B 站网页全屏 class 属性检测", () => {
    playerContainer.classList.add("bpx-state-web-fullscreen");
    expect(isPlayerFullscreen(playerContainer)).toBe(true);

    playerContainer.classList.remove("bpx-state-web-fullscreen");
    expect(isPlayerFullscreen(playerContainer)).toBe(false);
  });

  it("body 级网页全屏 class 检测", () => {
    document.body.classList.add("player-mode-webfullscreen");
    expect(isPlayerFullscreen()).toBe(true);

    document.body.classList.remove("player-mode-webfullscreen");
    expect(isPlayerFullscreen()).toBe(false);
  });

  it("observeFullscreenChanges 监听全屏切换并在回调触发", async () => {
    const callback = vi.fn();
    const unobserve = observeFullscreenChanges(callback, playerContainer);

    playerContainer.setAttribute("data-screen", "web");
    // 等待 MutationObserver 回调
    await Promise.resolve();

    expect(callback).toHaveBeenCalledWith(true);

    unobserve();
  });
});
