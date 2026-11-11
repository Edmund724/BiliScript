import { ensureInterpretSubtitleStyles } from "../shared/style-injector.js";
import type { MossInterpretTranscriptEvent } from "./moss-interpret-protocol.js";
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
  handleTranscript(event: MossInterpretTranscriptEvent): void;
  clear(): void;
  clearForSeek(): void;
  showNotice(message: string, autoHideMs?: number): void;
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
  let sourceTurn = "";
  let sourceText = "";
  const outputs = new Map<string, string>();
  const retiredTurns = new Set<string>();
  let fadeDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelFade(): void {
    if (fadeDelayTimer !== null) clearTimeout(fadeDelayTimer);
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeDelayTimer = null;
    fadeTimer = null;
    rootEl?.classList.remove("is-fading");
  }

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

  function render(turn: string): void {
    if (turn !== sourceTurn) return;
    cancelFade();
    const root = ensureMounted();
    if (!root || !originalEl || !translationEl) return;
    const translationText = [...outputs.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([, text]) => text)
      .join("");
    const lines = resolveInterpretSubtitleLines(sourceText, deps.getTargetLang(), deps.getDisplayMode());
    const showOriginal = lines.showOriginal && Boolean(sourceText);
    const showTranslation = lines.showTranslation && Boolean(translationText);

    originalEl.textContent = sourceText;
    translationEl.textContent = translationText;
    originalEl.hidden = !showOriginal;
    translationEl.hidden = !showTranslation;
    root.hidden = !showOriginal && !showTranslation;
  }

  function clearCurrent(): void {
    sourceTurn = "";
    sourceText = "";
    outputs.clear();
    if (originalEl) originalEl.textContent = "";
    if (translationEl) translationEl.textContent = "";
    if (rootEl) rootEl.hidden = true;
  }

  function clear(): void {
    cancelFade();
    if (sourceTurn) retiredTurns.add(sourceTurn);
    clearCurrent();
  }

  function clearForSeek(): void {
    cancelFade();
    clearCurrent();
  }

  function scheduleFade(): void {
    cancelFade();
    fadeDelayTimer = setTimeout(() => {
      fadeDelayTimer = null;
      rootEl?.classList.add("is-fading");
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        clear();
      }, 300);
    }, 3000);
  }

  function handleTranscript(event: MossInterpretTranscriptEvent): void {
    switch (event.kind) {
      case "input.updated":
      case "input.done":
        if (retiredTurns.has(event.turn)) break;
        if (event.turn !== sourceTurn) {
          if (sourceTurn) retiredTurns.add(sourceTurn);
          sourceTurn = event.turn;
          outputs.clear();
        }
        sourceText = event.text;
        render(event.turn);
        break;
      case "output.updated":
      case "output.done":
        if (retiredTurns.has(event.sourceTurn)) break;
        if (!sourceTurn) sourceTurn = event.sourceTurn;
        if (event.sourceTurn !== sourceTurn) return;
        outputs.set(event.runId, event.text);
        render(event.sourceTurn);
        break;
      case "response.ended":
        if (event.sourceTurn !== sourceTurn) break;
        if (event.status === "completed") {
          scheduleFade();
          break;
        }
        if (event.runId) {
          outputs.delete(event.runId);
        } else {
          outputs.clear();
        }
        if (outputs.size === 0) sourceText = "";
        render(event.sourceTurn);
        break;
    }
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

  function dispose(): void {
    cancelFade();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeEl?.remove();
    noticeEl = null;
    rootEl?.remove();
    rootEl = null;
    originalEl = null;
    translationEl = null;
  }

  return { handleTranscript, clear, clearForSeek, showNotice, getElement: () => rootEl, dispose };
}
