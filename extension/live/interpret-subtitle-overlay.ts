import { ensureInterpretSubtitleStyles } from "../shared/style-injector.js";
import { resolveInterpretSubtitleLines } from "./interpret-subtitle-lines.js";
import type {
  InterpretSubtitleDisplayMode,
  LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";

ensureInterpretSubtitleStyles();

export interface InterpretSubtitleOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getTargetLang: () => LiveInterpretTargetLang;
  getDisplayMode: () => InterpretSubtitleDisplayMode;
}

export interface InterpretSubtitleOverlay {
  clear(): void;
  clearForSeek(): void;
  showNotice(message: string, autoHideMs?: number): void;
  setSubtitle(original: string, translation: string): void;
  getElement(): HTMLElement | null;
  dispose(): void;
}

export function createInterpretSubtitleOverlay(
  deps: InterpretSubtitleOverlayDeps
): InterpretSubtitleOverlay {
  let rootEl: HTMLElement | null = null;
  let originalEl: HTMLElement | null = null;
  let translationEl: HTMLElement | null = null;
  let noticeEl: HTMLElement | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function getMountHost(): HTMLElement | null {
    const fullscreenElement =
      document.fullscreenElement ||
      (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    if (fullscreenElement instanceof HTMLElement) return fullscreenElement;
    return deps.getPlayerHost();
  }

  function ensureMounted(): HTMLElement | null {
    const host = getMountHost();
    if (!host) return null;
    if (rootEl?.isConnected) {
      if (rootEl.parentElement !== host) host.appendChild(rootEl);
      return rootEl;
    }

    const root = document.createElement("div");
    root.id = "biliscript-interpret-subtitle-overlay";
    root.className = "biliscript-interpret-subtitle-overlay";
    root.setAttribute("data-biliscript-extension-node", "interpret-subtitle-overlay");
    root.setAttribute("aria-live", "off");
    root.hidden = true;

    originalEl = document.createElement("div");
    originalEl.className = "biliscript-interpret-subtitle-original";
    translationEl = document.createElement("div");
    translationEl.className = "biliscript-interpret-subtitle-translation";
    root.append(originalEl, translationEl);
    host.appendChild(root);
    rootEl = root;
    return root;
  }

  function clearCurrent(): void {
    if (originalEl) originalEl.textContent = "";
    if (translationEl) translationEl.textContent = "";
    if (rootEl) rootEl.hidden = true;
  }

  function clear(): void {
    clearCurrent();
  }

  function clearForSeek(): void {
    clearCurrent();
  }

  function showNotice(message: string, autoHideMs = 6000): void {
    const host = getMountHost();
    if (!host) return;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!noticeEl) {
      noticeEl = document.createElement("div");
      noticeEl.className = "biliscript-interpret-notice";
      noticeEl.setAttribute("data-biliscript-extension-node", "interpret-notice");
      noticeEl.setAttribute("role", "status");
    }
    if (noticeEl.parentElement !== host) host.appendChild(noticeEl);
    noticeEl.textContent = message;
    if (autoHideMs > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        noticeEl?.remove();
        noticeEl = null;
      }, autoHideMs);
    }
  }

  function setSubtitle(original: string, translation: string): void {
    const root = ensureMounted();
    if (!root || !originalEl || !translationEl) return;
    const lines = resolveInterpretSubtitleLines(original, deps.getTargetLang(), deps.getDisplayMode());
    const showOriginal = lines.showOriginal && Boolean(original.trim());
    const showTranslation = lines.showTranslation && Boolean(translation.trim());

    originalEl.textContent = original;
    translationEl.textContent = translation;
    originalEl.hidden = !showOriginal;
    translationEl.hidden = !showTranslation;
    root.hidden = !showOriginal && !showTranslation;
  }

  function dispose(): void {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeEl?.remove();
    noticeEl = null;
    rootEl?.remove();
    rootEl = null;
    originalEl = null;
    translationEl = null;
  }

  return { clear, clearForSeek, showNotice, setSubtitle, getElement: () => rootEl, dispose };
}
