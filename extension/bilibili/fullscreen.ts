// extension/bilibili/fullscreen.ts
// B 站播放器全屏状态判定（浏览器全屏与网页全屏）与变化监听

export function isPlayerFullscreen(targetHost?: Element | null): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  // 1. 浏览器原生全屏判定
  const fsEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
  if (fsEl) {
    if (!targetHost) {
      return true;
    }
    return targetHost.contains(fsEl) || fsEl.contains(targetHost);
  }

  // 2. B 站网页全屏判定（bpx-player / 容器 data-screen 或 class 属性）
  const host =
    targetHost ||
    document.querySelector(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap");

  if (host instanceof Element) {
    const dataScreen = host.getAttribute("data-screen");
    if (dataScreen === "web" || dataScreen === "full" || dataScreen === "fullscreen") {
      return true;
    }
    if (
      host.classList.contains("bpx-state-web-fullscreen") ||
      host.classList.contains("bpx-state-fullscreen")
    ) {
      return true;
    }
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

export function observeFullscreenChanges(
  callback: (isFullscreen: boolean) => void,
  targetHost?: Element | null
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  let lastState = isPlayerFullscreen(targetHost);

  const check = () => {
    const nextState = isPlayerFullscreen(targetHost);
    if (nextState !== lastState) {
      lastState = nextState;
      callback(nextState);
    }
  };

  const onDocFsChange = () => check();
  document.addEventListener("fullscreenchange", onDocFsChange);
  document.addEventListener("webkitfullscreenchange", onDocFsChange);
  window.addEventListener("resize", check, { passive: true });

  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => check());
    const host =
      targetHost ||
      document.querySelector(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap");
    if (host instanceof Element) {
      observer.observe(host, {
        attributes: true,
        attributeFilter: ["class", "data-screen"]
      });
    }
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }
  }

  return () => {
    document.removeEventListener("fullscreenchange", onDocFsChange);
    document.removeEventListener("webkitfullscreenchange", onDocFsChange);
    window.removeEventListener("resize", check);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  };
}
