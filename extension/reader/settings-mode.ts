import { state } from "../core/state.js";
import { activeById, getActiveReaderDocument } from "../shared/active-host.js";
import { isHtmlElement } from "../shared/cross-doc.js";
import { getReaderActiveScriptTab, ids } from "./state.js";
import { hasReaderSettingsDropdownOpen } from "./settings-dropdown-open.js";
import { invalidateReaderSetupFlows } from "./setup-resume.js";

export { hasReaderSettingsDropdownOpen };
import { closeQuoteShareModal, isQuoteShareModalOpen } from "./quote-share-modal.js";
import {
  cancelNavTransition,
  runHorizontalLayerTransition,
  supportsWebAnimations
} from "../ui/nav-motion.js";

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

function collectActiveMainLayers(scriptPanel: HTMLElement | null): HTMLElement[] {
  if (!scriptPanel) return [];
  const layers: HTMLElement[] = [];
  const tabsRow = scriptPanel.querySelector<HTMLElement>(":scope > .biliscript-reading-tabs-row");
  const activeTabBody = scriptPanel.querySelector<HTMLElement>(
    ":scope > .biliscript-reading-tab-body.is-active:not([hidden])"
  );
  const chatHistoryOpen = Boolean(
    activeTabBody?.id === ids.readingTabBodyChat
      && activeTabBody.querySelector(".chat-history-popover:not([hidden])")
  );
  if (tabsRow && !tabsRow.hidden && !chatHistoryOpen) {
    layers.push(tabsRow);
  }
  if (activeTabBody) {
    layers.push(activeTabBody);
  }
  return layers;
}

export function projectReaderSettingsMode(options: { onExitSettled?: () => void } = {}): void {
  const expanded = state.reader.readingSettingsExpanded;
  const settingsPanel = activeById(ids.readingSettingsPanel);
  const settingsButton = activeById(ids.readingSettingsBtn);
  const scriptPanel = activeById(ids.readingScriptPanel);

  settingsButton?.classList.toggle("is-active", expanded);
  settingsButton?.setAttribute("aria-pressed", expanded ? "true" : "false");
  if (expanded) {
    scriptPanel?.setAttribute("data-biliscript-settings-open", "1");
  } else {
    scriptPanel?.removeAttribute("data-biliscript-settings-open");
  }

  if (!settingsPanel) {
    if (!expanded) {
      options.onExitSettled?.();
    }
    return;
  }

  const wasExpanded = !settingsPanel.hidden;
  if (wasExpanded === expanded) {
    if (!expanded) {
      options.onExitSettled?.();
    }
    return;
  }

  if (scriptPanel) {
    cancelNavTransition(scriptPanel);
  }

  if (expanded) {
    settingsPanel.hidden = false;
    if (scriptPanel && supportsWebAnimations(settingsPanel)) {
      const outgoingMain = collectActiveMainLayers(scriptPanel);
      scriptPanel.setAttribute("data-biliscript-settings-motion", "opening");
      runHorizontalLayerTransition({
        scope: scriptPanel,
        direction: "forward",
        outgoing: outgoingMain.map((el) => ({ el, distancePx: 14 })),
        incoming: [{ el: settingsPanel, distancePx: 22 }],
        durationEnterMs: 230,
        durationExitMs: 110,
        enterDelayMs: 20,
        onExitDone: () => {
          if (scriptPanel.getAttribute("data-biliscript-settings-motion") === "opening") {
            scriptPanel.removeAttribute("data-biliscript-settings-motion");
          }
        }
      });
    }
    return;
  }

  if (scriptPanel && supportsWebAnimations(settingsPanel)) {
    settingsPanel.setAttribute("data-biliscript-settings-leaving", "1");
    settingsPanel.hidden = true;
    const incomingMain = collectActiveMainLayers(scriptPanel);
    scriptPanel.setAttribute("data-biliscript-settings-motion", "closing");
    runHorizontalLayerTransition({
      scope: scriptPanel,
      direction: "backward",
      outgoing: [{ el: settingsPanel, distancePx: 22 }],
      incoming: incomingMain.map((el) => ({ el, distancePx: 14 })),
      durationEnterMs: 190,
      durationExitMs: 120,
      enterDelayMs: 30,
      onExitDone: () => {
        settingsPanel.removeAttribute("data-biliscript-settings-leaving");
        options.onExitSettled?.();
      },
      onAllDone: () => {
        if (scriptPanel.getAttribute("data-biliscript-settings-motion") === "closing") {
          scriptPanel.removeAttribute("data-biliscript-settings-motion");
        }
      }
    });
  } else {
    settingsPanel.hidden = true;
    options.onExitSettled?.();
  }
}

export function openReaderSettingsMode(): void {
  if (isQuoteShareModalOpen()) {
    closeQuoteShareModal({ restoreFocus: true });
  }
  const activeDoc = getActiveReaderDocument();
  if (!state.reader.readingSettingsExpanded) {
    const activeElement = activeDoc.activeElement;
    settingsReturnFocus = isHtmlElement(activeElement) && activeElement !== activeDoc.body
      ? activeElement
      : null;
  }
  state.reader.setSettingsExpanded(true);
  projectReaderSettingsMode();
  focusWithoutScroll(activeById(ids.readingSettingsBackBtn));
}

export function hasReaderSettingsOverlayOpen(): boolean {
  return hasReaderSettingsDropdownOpen() || getActiveReaderDocument().querySelector(
    '.provider-editor-host:not([data-biliscript-closing="1"]), [data-panel-modal-host="1"]:not([data-biliscript-closing="1"]), .confirm-dialog-host:not([data-biliscript-closing="1"])'
  ) !== null;
}

export function closeReaderSettingsMode({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  if (!state.reader.readingSettingsExpanded) return;
  state.reader.setSettingsExpanded(false);
  const closeListener = settingsCloseListener;
  projectReaderSettingsMode({
    onExitSettled: () => closeListener?.()
  });
  invalidateReaderSetupFlows("all");
  if (restoreFocus) {
    const returnTarget = settingsReturnFocus?.isConnected ? settingsReturnFocus : null;
    if (returnTarget) {
      focusWithoutScroll(returnTarget);
    } else {
      const activeDoc = getActiveReaderDocument();
      const settingsPanel = activeById(ids.readingSettingsPanel);
      const active = activeDoc.activeElement;
      const focusAlreadyOutsideSettings =
        isHtmlElement(active)
        && active !== activeDoc.body
        && (!settingsPanel || !settingsPanel.contains(active));
      if (!focusAlreadyOutsideSettings) {
        focusWithoutScroll(activeById(TAB_BUTTON_IDS[getReaderActiveScriptTab()]));
      }
    }
  }
  settingsReturnFocus = null;
}
