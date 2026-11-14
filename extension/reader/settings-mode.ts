import { state } from "../core/state.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
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

export function focusWithoutScroll(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}

export function focusProviderEditorModelControl(): void {
  const target = document.querySelector<HTMLElement>(
    '.provider-editor-dialog [data-provider-editor-action="add-model"], .provider-editor-dialog .provider-editor-model-input, .provider-editor-dialog .provider-editor-model'
  );
  focusWithoutScroll(target);
}

/**
 * 缺模型错误进入设置时定位要编辑的启用 AI 平台 id（defaultModel 优先，否则首个启用平台）。
 */
export async function resolveEditableAiProviderId(): Promise<string> {
  try {
    const [providersResp, settingsResp] = await Promise.all([
      sendRuntimeMessage({ type: "ai-providers-list" }),
      sendRuntimeMessage({ type: "get-settings" })
    ]);
    const list = Array.isArray(providersResp?.providers) ? providersResp.providers : [];
    const enabled = list.filter(
      (item: unknown): item is { enabled?: unknown; id?: unknown } =>
        Boolean(item)
        && typeof item === "object"
        && (item as { enabled?: unknown }).enabled !== false
        && String((item as { id?: unknown }).id || "").trim() !== ""
    );
    if (!enabled.length) {
      return "";
    }
    const preferredId = String(settingsResp?.settings?.defaultModel || "").trim();
    const matched = preferredId ? enabled.find((item) => String(item.id) === preferredId) : null;
    return String((matched || enabled[0]).id || "").trim();
  } catch {
    return "";
  }
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
