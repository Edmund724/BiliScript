// extension/bilibili/fullscreen.ts
// B 站播放器全屏状态判定（浏览器全屏与网页全屏）

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
  const bpx = targetHost?.querySelector(".bpx-player-container") || document.querySelector(".bpx-player-container");
  const host = targetHost || bpx || document.querySelector("#bilibili-player, .player-wrap, #playerWrap");

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

