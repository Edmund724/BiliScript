// extension/bilibili/fullscreen.ts
// B 站播放器全屏状态判定（浏览器全屏与网页全屏）

import {
  BILI_HOST_SELECTORS,
  PLAYER_WEB_FULLSCREEN_SELECTOR,
  PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR,
  findVideoPlayerContainer
} from "./host-selectors.js";

function getFullscreenElement(): Element | null {
  if (typeof document === "undefined") {
    return null;
  }
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

export function getFullscreenHost(): HTMLElement | null {
  const fullscreenElement = getFullscreenElement();
  return fullscreenElement instanceof HTMLElement ? fullscreenElement : null;
}

export function isPlayerFullscreen(targetHost?: Element | null): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  // 1. 浏览器原生全屏判定
  const fsEl = getFullscreenElement();
  if (fsEl) {
    if (!targetHost) {
      return true;
    }
    return targetHost.contains(fsEl) || fsEl.contains(targetHost);
  }

  // 2. B 站网页全屏判定（bpx-player / 容器 data-screen 或 class 属性）
  const bpx =
    targetHost?.querySelector(BILI_HOST_SELECTORS.playerBpxContainer) ||
    document.querySelector(BILI_HOST_SELECTORS.playerBpxContainer);
  const host = targetHost || bpx || findVideoPlayerContainer();

  const checkElem = (el: Element | null): boolean => {
    if (!el) return false;
    const dataScreen = el.getAttribute("data-screen");
    if (dataScreen === "web" || dataScreen === "full" || dataScreen === "fullscreen") {
      return true;
    }
    return (
      el.classList.contains("bpx-state-web-fullscreen") ||
      el.classList.contains("bpx-state-fullscreen")
    );
  };

  if (checkElem(bpx) || checkElem(host)) {
    return true;
  }

  // 3. body 级网页全屏标记
  if (
    document.body?.classList.contains("player-mode-webfullscreen") ||
    document.body?.classList.contains("player-full-win")
  ) {
    return true;
  }

  return false;
}

export async function exitPlayerFullscreenIfNeeded(): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  const doc = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  if (getFullscreenElement()) {
    const exitPromise = doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.();
    await Promise.resolve(exitPromise).catch(() => {});
  }

  const isWebFullscreen = Boolean(
    document.querySelector(PLAYER_WEB_FULLSCREEN_SELECTOR) ||
      document.body?.classList.contains("player-mode-webfullscreen") ||
      document.body?.classList.contains("player-full-win")
  );
  if (!isWebFullscreen) {
    return;
  }

  const webBtn = document.querySelector<HTMLElement>(PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR);
  if (!webBtn) {
    return;
  }
  webBtn.click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

