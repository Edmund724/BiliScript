// 阅读面板核心 chunk 的交互前低开销预热：
// 在首按钮（播放器 AI 键 / 工具栏文摘键）挂载完成后，通过悬停（pointerenter）、
// 聚焦（focus）或页面空闲时段（requestIdleCallback + setTimeout 兜底）注入
// <link rel="modulepreload"> 预取面板核心入口，避免首次点击打开面板时产生读取延迟。

import { isSupportedVideoPage } from "../bilibili/video-id-shared.js";

export const PANEL_PRELOAD_MODULE_PATHS = [
  "entry/chunks/ui-renderer.mjs",
  "entry/chunks/shell.mjs",
  "entry/chunks/reader.mjs",
  "entry/chunks/presentation.mjs"
] as const;

const PANEL_PRELOAD_IDLE_TIMEOUT_MS = 2500;
const PANEL_PRELOAD_FALLBACK_DELAY_MS = 1500;

const boundButtons = new WeakSet<HTMLElement>();
let pendingIdleCallbackId: number | null = null;
let pendingIdleTimerId: number | null = null;

function resolveExtensionModuleUrl(modulePath: string): string | null {
  try {
    const getUrl = typeof chrome !== "undefined" ? chrome.runtime?.getURL : undefined;
    if (typeof getUrl !== "function") {
      return null;
    }
    const url = getUrl.call(chrome.runtime, modulePath);
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function hasPreloadLink(href: string): boolean {
  const head = typeof document !== "undefined" ? document.head : null;
  if (!head) {
    return false;
  }
  for (const child of Array.from(head.children)) {
    if (
      child.tagName === "LINK" &&
      child.getAttribute("rel") === "modulepreload" &&
      (child.getAttribute("href") === href || (child as HTMLLinkElement).href === href)
    ) {
      return true;
    }
  }
  return false;
}

function areAllPanelChunksPreloaded(): boolean {
  for (const modulePath of PANEL_PRELOAD_MODULE_PATHS) {
    const url = resolveExtensionModuleUrl(modulePath);
    if (!url || !hasPreloadLink(url)) {
      return false;
    }
  }
  return true;
}

function cancelScheduledPanelPreload(): void {
  if (pendingIdleCallbackId !== null) {
    if (typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(pendingIdleCallbackId);
    }
    pendingIdleCallbackId = null;
  }
  if (pendingIdleTimerId !== null) {
    if (typeof window !== "undefined") {
      window.clearTimeout(pendingIdleTimerId);
    }
    pendingIdleTimerId = null;
  }
}

export function preloadReaderPanelChunks(): void {
  if (!isSupportedVideoPage()) {
    return;
  }
  const head = typeof document !== "undefined" ? document.head : null;
  if (!head) {
    return;
  }
  cancelScheduledPanelPreload();

  for (const modulePath of PANEL_PRELOAD_MODULE_PATHS) {
    const url = resolveExtensionModuleUrl(modulePath);
    if (!url || hasPreloadLink(url)) {
      continue;
    }
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = url;
    link.onerror = () => {
      link.remove();
    };
    head.appendChild(link);
  }
}

export function bindPanelPreloadOnButton(button: HTMLElement): void {
  if (boundButtons.has(button)) {
    return;
  }
  boundButtons.add(button);
  const trigger = () => {
    preloadReaderPanelChunks();
  };
  button.addEventListener("pointerenter", trigger, { once: true, passive: true });
  button.addEventListener("focus", trigger, { once: true, passive: true });
}

export function schedulePanelPreloadOnIdle(): void {
  if (!isSupportedVideoPage()) {
    return;
  }
  if (pendingIdleCallbackId !== null || pendingIdleTimerId !== null) {
    return;
  }
  if (areAllPanelChunksPreloaded()) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  if (typeof window.requestIdleCallback === "function") {
    pendingIdleCallbackId = window.requestIdleCallback(
      () => {
        pendingIdleCallbackId = null;
        preloadReaderPanelChunks();
      },
      { timeout: PANEL_PRELOAD_IDLE_TIMEOUT_MS }
    );
    return;
  }
  pendingIdleTimerId = window.setTimeout(() => {
    pendingIdleTimerId = null;
    preloadReaderPanelChunks();
  }, PANEL_PRELOAD_FALLBACK_DELAY_MS);
}
