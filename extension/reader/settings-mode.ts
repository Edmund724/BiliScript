import { state } from "../core/state.js";
import { getReaderActiveScriptTab, ids } from "./state.js";
import { invalidateReaderSetupFlows } from "./setup-resume.js";
import { closeQuoteShareModal, isQuoteShareModalOpen } from "./quote-share-modal.js";
import { captureTriggerRect, computeRelativeOrigin } from "../ui/trigger-motion.js";

const TAB_BUTTON_IDS = {
  subtitle: ids.readingTabSubtitle,
  overview: ids.readingTabOverview,
  chat: ids.readingTabChat
} as const;

type SettingsBackInterceptor = () => boolean;
type SettingsCloseListener = () => void;

let settingsReturnFocus: HTMLElement | null = null;
let settingsBackInterceptor: SettingsBackInterceptor | null = null;
let settingsCloseListener: SettingsCloseListener | null = null;

export function registerReaderSettingsBackInterceptor(
  interceptor: SettingsBackInterceptor | null
): () => void {
  settingsBackInterceptor = interceptor;
  return () => {
    if (settingsBackInterceptor === interceptor) {
      settingsBackInterceptor = null;
    }
  };
}

export function registerReaderSettingsCloseListener(
  listener: SettingsCloseListener | null
): () => void {
  settingsCloseListener = listener;
  return () => {
    if (settingsCloseListener === listener) {
      settingsCloseListener = null;
    }
  };
}

export function stepBackReaderSettings(): void {
  if (settingsBackInterceptor?.()) return;
  closeReaderSettingsMode();
}

export function focusWithoutScroll(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}

export function projectReaderSettingsMode(): void {
  const expanded = state.reader.readingSettingsExpanded;
  const settingsPanel = document.getElementById(ids.readingSettingsPanel);
  const settingsButton = document.getElementById(ids.readingSettingsBtn);
  const scriptPanel = document.getElementById(ids.readingScriptPanel);
  if (settingsPanel) {
    if (expanded) {
      const triggerRect = captureTriggerRect(settingsButton);
      settingsPanel.hidden = false;
      const panelRect = settingsPanel.getBoundingClientRect();
      const origin = computeRelativeOrigin(panelRect, triggerRect, "top right");
      settingsPanel.style.setProperty("--biliscript-settings-origin", origin);
    } else {
      settingsPanel.hidden = true;
    }
  }
  settingsButton?.classList.toggle("is-active", expanded);
  settingsButton?.setAttribute("aria-pressed", expanded ? "true" : "false");
  if (expanded) {
    scriptPanel?.setAttribute("data-biliscript-settings-open", "1");
  } else {
    scriptPanel?.removeAttribute("data-biliscript-settings-open");
  }
}

export function openReaderSettingsMode(): void {
  if (isQuoteShareModalOpen()) {
    closeQuoteShareModal({ restoreFocus: true });
  }
  if (!state.reader.readingSettingsExpanded) {
    const activeElement = document.activeElement;
    settingsReturnFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : null;
  }
  state.reader.setSettingsExpanded(true);
  projectReaderSettingsMode();
  focusWithoutScroll(document.getElementById(ids.readingSettingsBackBtn));
}

export function hasReaderSettingsDropdownOpen(): boolean {
  return document.querySelector(
    ".custom-select-dropdown:not([hidden]), .ai-provider-model-dropdown:not([hidden])"
  ) !== null;
}

export function hasReaderSettingsOverlayOpen(): boolean {
  return hasReaderSettingsDropdownOpen() || document.querySelector(
    '.provider-editor-host:not([data-biliscript-closing="1"]), [data-panel-modal-host="1"]:not([data-biliscript-closing="1"]), .confirm-dialog-host:not([data-biliscript-closing="1"])'
  ) !== null;
}

export function closeReaderSettingsMode({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  if (!state.reader.readingSettingsExpanded) return;
  state.reader.setSettingsExpanded(false);
  projectReaderSettingsMode();
  invalidateReaderSetupFlows("all");
  settingsCloseListener?.();
  if (restoreFocus) {
    const returnTarget = settingsReturnFocus?.isConnected ? settingsReturnFocus : null;
    if (returnTarget) {
      focusWithoutScroll(returnTarget);
    } else {
      const settingsPanel = document.getElementById(ids.readingSettingsPanel);
      const active = document.activeElement;
      const focusAlreadyOutsideSettings =
        active instanceof HTMLElement
        && active !== document.body
        && (!settingsPanel || !settingsPanel.contains(active));
      if (!focusAlreadyOutsideSettings) {
        focusWithoutScroll(document.getElementById(TAB_BUTTON_IDS[getReaderActiveScriptTab()]));
      }
    }
  }
  settingsReturnFocus = null;
}
