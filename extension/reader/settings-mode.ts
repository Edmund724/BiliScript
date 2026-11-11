import { state } from "../core/state.js";
import { getReaderActiveScriptTab, ids } from "./state.js";
import { clearOverviewSetupResumeIntent } from "./overview-setup-resume.js";
import { clearExplainSetupResumeIntent } from "./explain-setup-resume.js";
import { clearChatSetupResumeIntent } from "./chat-setup-resume.js";
import { clearAsrSetupResumeIntent } from "./asr-setup-resume.js";

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

export function hasReaderSettingsDropdownOpen(): boolean {
  return document.querySelector(
    ".custom-select-dropdown:not([hidden]), .ai-provider-model-dropdown:not([hidden])"
  ) !== null;
}

export function hasReaderSettingsOverlayOpen(): boolean {
  return hasReaderSettingsDropdownOpen() || document.querySelector(
    ".provider-editor-host, .confirm-dialog-host"
  ) !== null;
}

export function closeReaderSettingsMode({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  if (!state.reader.readingSettingsExpanded) return;
  state.reader.setSettingsExpanded(false);
  projectReaderSettingsMode();
  // 首配续跑意图随设置抽屉关闭作废（票 01/02/03/04：关闭面板即失效）；配置成功的
  // 消费路径先取走意图，这里的清除落到空槽。
  clearOverviewSetupResumeIntent();
  clearExplainSetupResumeIntent();
  clearChatSetupResumeIntent();
  clearAsrSetupResumeIntent();
  if (restoreFocus) {
    const returnTarget = settingsReturnFocus?.isConnected ? settingsReturnFocus : null;
    focusWithoutScroll(returnTarget ?? document.getElementById(TAB_BUTTON_IDS[getReaderActiveScriptTab()]));
  }
  settingsReturnFocus = null;
}
