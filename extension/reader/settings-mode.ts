import { state } from "../core/state.js";
import { getReaderActiveScriptTab, ids } from "./state.js";

const TAB_BUTTON_IDS = {
  subtitle: ids.readingTabSubtitle,
  overview: ids.readingTabOverview,
  chat: ids.readingTabChat
} as const;

let settingsReturnFocus: HTMLElement | null = null;

function focusWithoutScroll(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}

export function projectReaderSettingsMode(): void {
  const expanded = state.reader.readingSettingsExpanded;
  const settingsPanel = document.getElementById(ids.readingSettingsPanel);
  const settingsButton = document.getElementById(ids.readingSettingsBtn);
  const scriptPanel = document.getElementById(ids.readingScriptPanel);
  if (settingsPanel) settingsPanel.hidden = !expanded;
  settingsButton?.classList.toggle("is-active", expanded);
  settingsButton?.setAttribute("aria-pressed", expanded ? "true" : "false");
  if (expanded) {
    scriptPanel?.setAttribute("data-biliscript-settings-open", "1");
  } else {
    scriptPanel?.removeAttribute("data-biliscript-settings-open");
  }
}

export function openReaderSettingsMode(): void {
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

export function closeReaderSettingsMode(): void {
  if (!state.reader.readingSettingsExpanded) return;
  state.reader.setSettingsExpanded(false);
  projectReaderSettingsMode();
  const returnTarget = settingsReturnFocus?.isConnected ? settingsReturnFocus : null;
  focusWithoutScroll(returnTarget ?? document.getElementById(TAB_BUTTON_IDS[getReaderActiveScriptTab()]));
  settingsReturnFocus = null;
}
