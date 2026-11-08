// extension/bilibili/playback-rate.ts
// B 站播放器 3x / 4x 倍速按钮模块。
// 为播放器控制栏添加 3 倍速和 4 倍速按钮，点击切换 1x/3x 或 1x/4x，切换视频自动恢复 1x。
// 字体样式在挂载及全屏切换时同步原生倍速按钮。

import { getRuntimeVideoElement } from "./video-probe.js";
import {
  applyControlBarPlacement,
  observePlayerContainer,
  type PlayerContainerObserverHandle
} from "./player-control-mount.js";

const BTN_FLAG = "data-bilibili-3x";
const RATE_RESULT_CLASS = "bpx-player-ctrl-playbackrate-result";
const PLAYBACK_RATE_CONTAINER_SELECTOR =
  ".bpx-player-container, #bilibili-player, .bpx-player-control-wrap, .bpx-player-control-bottom-right";

let isRunning = false;
let lastVideoSrc = "";
let currentBoundVideo: HTMLVideoElement | null = null;
let videoSrcObserver: MutationObserver | null = null;
let containerObserverHandle: PlayerContainerObserverHandle | null = null;
let fullscreenTimer: ReturnType<typeof setTimeout> | null = null;
let rAFScheduled = false;

function getVideo(): HTMLVideoElement | null {
  const v = getRuntimeVideoElement();
  if (v && v.isConnected) {
    return v;
  }
  return document.querySelector<HTMLVideoElement>("video");
}

function getVisibleNativeTextEl(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    `.bpx-player-ctrl-playbackrate:not([${BTN_FLAG}]) .${RATE_RESULT_CLASS}`
  );
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return el;
    }
  }
  return candidates[0] || null;
}

function createBtn(rate: number): HTMLElement {
  const btn = document.createElement("div");
  btn.className = "bpx-player-ctrl-btn bpx-player-ctrl-playbackrate";
  btn.setAttribute(BTN_FLAG, String(rate));
  btn.title = `${rate}倍速（点击切换）`;

  const resultDiv = document.createElement("div");
  resultDiv.className = RATE_RESULT_CLASS;
  resultDiv.textContent = `${rate}x`;

  btn.appendChild(resultDiv);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const v = getVideo();
    if (!v) return;
    v.playbackRate = v.playbackRate === rate ? 1 : rate;
  });

  return btn;
}

function syncBtnStyle(): void {
  const nativeText = getVisibleNativeTextEl();
  if (!nativeText) return;

  const cs = window.getComputedStyle(nativeText);
  const nativeColor = cs.color;

  document.querySelectorAll<HTMLElement>(`[${BTN_FLAG}] .${RATE_RESULT_CLASS}`).forEach((el) => {
    el.style.fontSize = cs.fontSize;
    el.style.fontWeight = cs.fontWeight;
    el.style.fontFamily = cs.fontFamily;
    el.style.lineHeight = cs.lineHeight;
    el.style.letterSpacing = cs.letterSpacing;

    if (!el.dataset.nativeColor) {
      el.dataset.nativeColor = nativeColor;
    }

    const rate = Number(el.parentElement?.getAttribute(BTN_FLAG));
    const v = getVideo();
    if (!(v && v.playbackRate === rate)) {
      el.style.color = nativeColor;
    }
  });
}

function updateBtnState(): void {
  const v = getVideo();
  const currentRate = v ? v.playbackRate : 1;
  document.querySelectorAll<HTMLElement>(`[${BTN_FLAG}] .${RATE_RESULT_CLASS}`).forEach((el) => {
    const btnRate = Number(el.parentElement?.getAttribute(BTN_FLAG));
    const nextColor = currentRate === btnRate ? "#00aeec" : el.dataset.nativeColor || "";
    if (el.style.color !== nextColor) {
      el.style.color = nextColor;
    }
  });
}

function ensureButtons(): boolean {
  let mountedNew = false;
  const rateBtns = document.querySelectorAll<HTMLElement>(`.bpx-player-ctrl-playbackrate:not([${BTN_FLAG}])`);
  rateBtns.forEach((rateBtn) => {
    const parent = rateBtn.parentElement;
    if (!(parent instanceof HTMLElement)) return;

    const existing3x = parent.querySelector<HTMLElement>(`[${BTN_FLAG}="3"]`);
    const existing4x = parent.querySelector<HTMLElement>(`[${BTN_FLAG}="4"]`);

    const btn3 = existing3x ?? createBtn(3);
    const btn4 = existing4x ?? createBtn(4);
    if (!existing3x || !existing4x) {
      mountedNew = true;
    }

    if (applyControlBarPlacement(btn3, { kind: "before", parent, reference: rateBtn })) {
      mountedNew = true;
    }
    if (applyControlBarPlacement(btn4, { kind: "before", parent, reference: btn3 })) {
      mountedNew = true;
    }
  });
  return mountedNew;
}

function cleanStaleButtons(): void {
  const parentMap = new Map<HTMLElement, HTMLElement[]>();

  document.querySelectorAll<HTMLElement>(`[${BTN_FLAG}]`).forEach((btn) => {
    const parent = btn.parentElement;
    if (!parent) {
      btn.remove();
      return;
    }

    const hasNative = Boolean(parent.querySelector(`.bpx-player-ctrl-playbackrate:not([${BTN_FLAG}])`));
    if (!hasNative) {
      btn.remove();
      return;
    }

    if (!parentMap.has(parent)) {
      parentMap.set(parent, []);
    }
    parentMap.get(parent)?.push(btn);
  });

  parentMap.forEach((btns) => {
    const seenRates = new Set<string>();
    btns.forEach((btn) => {
      const rate = btn.getAttribute(BTN_FLAG);
      if (rate && seenRates.has(rate)) {
        btn.remove();
      } else if (rate) {
        seenRates.add(rate);
      }
    });
  });
}

function checkVideoChange(): void {
  const v = getVideo();
  if (!v) return;
  const src = v.src || v.currentSrc;
  if (src && src !== lastVideoSrc) {
    lastVideoSrc = src;
    if (v.playbackRate !== 1) {
      v.playbackRate = 1;
    }
  }
  updateBtnState();
}

function handleRateChange(): void {
  updateBtnState();
}

function handleLoadedMetadata(): void {
  checkVideoChange();
}

function unbindCurrentVideo(): void {
  videoSrcObserver?.disconnect();
  videoSrcObserver = null;
  if (currentBoundVideo) {
    currentBoundVideo.removeEventListener("ratechange", handleRateChange);
    currentBoundVideo.removeEventListener("loadedmetadata", handleLoadedMetadata);
    currentBoundVideo.removeEventListener("emptied", handleLoadedMetadata);
    currentBoundVideo = null;
  }
}

function bindVideoEvents(): void {
  const v = getVideo();
  if (v === currentBoundVideo) return;

  unbindCurrentVideo();
  currentBoundVideo = v;
  if (!v) return;

  v.addEventListener("ratechange", handleRateChange);
  v.addEventListener("loadedmetadata", handleLoadedMetadata);
  v.addEventListener("emptied", handleLoadedMetadata);

  videoSrcObserver = new MutationObserver(() => {
    checkVideoChange();
  });
  videoSrcObserver.observe(v, {
    attributes: true,
    attributeFilter: ["src"]
  });
}

function syncPlaybackRateControls(forceStyleSync = false): void {
  if (!isRunning) return;
  const mountedNew = ensureButtons();
  cleanStaleButtons();
  bindVideoEvents();
  checkVideoChange();
  if (forceStyleSync || mountedNew) {
    syncBtnStyle();
  }
}

function scheduleSync(): void {
  if (rAFScheduled || !isRunning) return;
  rAFScheduled = true;
  requestAnimationFrame(() => {
    rAFScheduled = false;
    syncPlaybackRateControls(false);
  });
}

function handleFullscreenChange(): void {
  if (fullscreenTimer) {
    clearTimeout(fullscreenTimer);
  }
  fullscreenTimer = setTimeout(() => {
    fullscreenTimer = null;
    if (isRunning) {
      syncPlaybackRateControls(true);
    }
  }, 300);
}

export function startPlaybackRateButtons(): void {
  if (isRunning) return;
  isRunning = true;

  syncPlaybackRateControls(true);

  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

  containerObserverHandle = observePlayerContainer({
    containerSelector: PLAYBACK_RATE_CONTAINER_SELECTOR,
    onMutations: () => {
      scheduleSync();
    }
  });
}

export function stopPlaybackRateButtons(): void {
  if (!isRunning) return;
  isRunning = false;

  if (fullscreenTimer) {
    clearTimeout(fullscreenTimer);
    fullscreenTimer = null;
  }

  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);

  containerObserverHandle?.disconnect();
  containerObserverHandle = null;

  unbindCurrentVideo();
  lastVideoSrc = "";

  document.querySelectorAll(`[${BTN_FLAG}]`).forEach((el) => {
    el.remove();
  });
}
