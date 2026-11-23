import { state, uiState } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { READING_RESET_ICON } from "./reading-icons.js";
import { themeButtonView } from "./theme-button.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  isChatDisplaySliderAvailable,
  type ChatDisplaySettingKey
} from "../reader/chat-display-settings.js";
import { dispatchChatTabOutsideClick } from "../reader/reader-bus.js";
import { ids, isReaderViewOpen } from "../reader/state.js";
import type { ReaderScriptTab } from "../reader/state.js";
import { closeReaderSettingsMode, hasReaderSettingsOverlayOpen, openReaderSettingsMode, stepBackReaderSettings } from "../reader/settings-mode.js";
import { beginReaderAsrSetupFlow } from "../reader/setup-resume.js";
import { isReaderScriptTab } from "../reader/script-tab-persistence.js";
import { logWarn } from "../shared/logging.js";
import { exitReaderShell } from "../reader/shell.js";
import { ensureReaderChatStyles, ensureReaderSettingsStyles } from "../shared/style-injector.js";
import { withReader } from "./reader-gate.js";
import { reportTabIntent, subscribeUiCommand } from "../reader/reader-bus.js";
import { buildChatTabBodyHtml } from "../reader/chat-template.js";
import { buildSubtitleTabBodyHtml, bindSubtitleTabEvents } from "../reader/subtitle-tab-ui.js";
import { buildExplainPopHtml, buildExplainCardHostHtml, bindReadingExplainEvents } from "../reader/explain-pop-ui.js";
import { buildOverviewTabBodyHtml, bindReadingOverviewEvents } from "../reader/overview-ui.js";

function buildChatMoreSliderRowHtml(
  key: ChatDisplaySettingKey,
  dom: { rowId?: string; inputId: string; valueId: string; resetBtnId: string }
): string {
  const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
  const hiddenAttr = isChatDisplaySliderAvailable(key) ? "" : " hidden";
  const rowIdAttr = dom.rowId ? ` id="${dom.rowId}"` : "";
  const labelsHtml = spec.rangeLabels
    ? `
                      <div class="biliscript-slider-labels">
                        <span>${spec.rangeLabels[0]}</span>
                        <span>${spec.rangeLabels[1]}</span>
                      </div>`
    : "";
  return `
                    <div${rowIdAttr} class="biliscript-slider-row"${hiddenAttr}>
                      <div class="biliscript-slider-header">
                        <label class="biliscript-set-label" for="${dom.inputId}">${spec.label}</label>
                        <div class="biliscript-slider-header-actions">
                          <span id="${dom.valueId}" class="biliscript-slider-badge">${spec.format(spec.defaultValue)}</span>
                          <button id="${dom.resetBtnId}" type="button" class="biliscript-slider-reset-btn" title="${spec.resetTitle}" aria-label="${spec.resetAriaLabel}">${READING_RESET_ICON}</button>
                        </div>
                      </div>
                      <input id="${dom.inputId}" type="range" class="biliscript-range-input" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.defaultValue}" style="--range-progress: ${spec.defaultProgressPct}%;" />${labelsHtml}
                    </div>`;
}

export function buildUiHtml(): string {
  const themeView = themeButtonView(state.reader.readingTheme, state.reader.readingThemeMode);
  return `
    <section id="${ids.readingView}" hidden aria-hidden="true" data-biliscript-reader-ready="0" aria-busy="true">
      <aside id="${ids.readingScriptPanel}" class="biliscript-reading-script-panel" aria-label="文摘面板">
            <header class="biliscript-reading-header">
              <div class="biliscript-reading-header-copy">
                <div id="${ids.readingMeta}" class="biliscript-reading-meta" hidden></div>
              </div>
              <div class="biliscript-reading-actions">
                <button id="${ids.readingThemeSelect}" type="button" class="biliscript-reading-icon-btn" title="主题：${themeView.title}" aria-label="主题：${themeView.title}">
                  ${themeView.icon}
                </button>
                <button id="${ids.readingSettingsBtn}" type="button" class="biliscript-reading-icon-btn" title="设置" aria-label="设置" aria-pressed="false">
                  ${READING_HEADER_ICONS.settings}
                </button>
                <button id="${ids.readingCloseBtn}" type="button" class="biliscript-reading-icon-btn" title="退出" aria-label="退出阅读视图">
                  ${READING_HEADER_ICONS.close}
                </button>
              </div>
            </header>

            <section id="${ids.readingSettingsPanel}" class="biliscript-reading-panel biliscript-reading-settings-panel" hidden>
              <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
                <div id="${ids.readingSettingsHost}" class="biliscript-reading-settings-host">
                  <div class="biliscript-settings-nav-bar">
                    <button id="${ids.readingSettingsBackBtn}" type="button" class="biliscript-reading-icon-btn biliscript-reading-settings-back-btn" title="返回" aria-label="返回">
                      ${READING_HEADER_ICONS.back}
                    </button>
                    <span class="biliscript-settings-nav-title">设置</span>
                  </div>
                </div>
              </section>
            </section>

            <div class="biliscript-reading-tabs-row">
              <div class="biliscript-reading-tabs" role="tablist" aria-label="Script 标签" data-active-tab="subtitle">
                <button id="${ids.readingTabSubtitle}" type="button" class="biliscript-reading-tab is-active" role="tab" aria-selected="true">字幕</button>
                <button id="${ids.readingTabOverview}" type="button" class="biliscript-reading-tab" role="tab" aria-selected="false">概览</button>
                <button id="${ids.readingTabChat}" type="button" class="biliscript-reading-tab" role="tab" aria-selected="false">AI 对话</button>
              </div>
              <div class="biliscript-reading-tabs-tools">
                <button id="${ids.readingChatMoreBtn}" type="button" class="biliscript-reading-icon-btn" title="更多操作" aria-label="更多操作" aria-haspopup="true" aria-controls="${ids.readingChatMoreMenu}" aria-expanded="false">
                  <svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.75"></circle>
                    <circle cx="12" cy="12" r="1.75"></circle>
                    <circle cx="12" cy="19" r="1.75"></circle>
                  </svg>
                </button>
                <div id="${ids.readingChatMoreMenu}" class="biliscript-reading-chat-more-menu" hidden>
                  <div class="biliscript-reading-chat-more-actions">
                    <button id="${ids.readingChatNewBtn}" type="button" class="biliscript-reading-chat-more-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">
                        <path d="M5.87 16.44A8.2 8.2 0 1 1 10.73 19.86L3.11 19.86 5.87 16.44Z"></path>
                        <path d="M12.7 8.7v6.4"></path>
                        <path d="M9.5 11.9h6.4"></path>
                      </svg>
                      <span>开启新会话</span>
                    </button>
                    <button id="${ids.readingChatHistoryBtn}" type="button" class="biliscript-reading-chat-more-item">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                        <path d="M3 3v5h5"></path>
                        <path d="M12 7v5l4 2"></path>
                      </svg>
                      <span>历史对话</span>
                    </button>
                  </div>
                  <div class="biliscript-reading-chat-more-typography">${buildChatMoreSliderRowHtml("chatLineHeight", {
                    inputId: ids.readingChatLineHeight,
                    valueId: ids.readingChatLineHeightValue,
                    resetBtnId: ids.readingChatLineHeightResetBtn
                  })}${buildChatMoreSliderRowHtml("chatParagraphSpacing", {
                    inputId: ids.readingChatParagraphSpacing,
                    valueId: ids.readingChatParagraphSpacingValue,
                    resetBtnId: ids.readingChatParagraphSpacingResetBtn
                  })}${buildChatMoreSliderRowHtml("speechVoiceVolume", {
                    rowId: ids.readingChatSpeechVolume,
                    inputId: ids.readingChatSpeechVolumeInput,
                    valueId: ids.readingChatSpeechVolumeValue,
                    resetBtnId: ids.readingChatSpeechVolumeResetBtn
                  })}
                  </div>
                  <button id="${ids.readingChatDisplaySettingsBtn}" type="button" class="biliscript-reading-chat-more-item">更多显示设置</button>
                </div>
              </div>
            </div>

            <div id="${ids.readingTabBodySubtitle}" class="biliscript-reading-tab-body is-active" role="tabpanel" aria-label="字幕">
              ${buildSubtitleTabBodyHtml()}
            </div>

            <div id="${ids.readingTabBodyOverview}" class="biliscript-reading-tab-body" role="tabpanel" aria-label="概览" hidden>
              ${buildOverviewTabBodyHtml()}
            </div>

            <div id="${ids.readingTabBodyChat}" class="biliscript-reading-tab-body" role="tabpanel" aria-label="AI 对话" hidden>
              ${buildChatTabBodyHtml()}
            </div>

            ${buildExplainPopHtml()}
            ${buildExplainCardHostHtml()}
      </aside>
    </section>
  `;
}

export type { ReaderScriptTab } from "../reader/state.js";

const SCRIPT_TAB_DEFS: Array<{ name: ReaderScriptTab; buttonId: string; bodyId: string }> = [
  { name: "subtitle", buttonId: ids.readingTabSubtitle, bodyId: ids.readingTabBodySubtitle },
  { name: "overview", buttonId: ids.readingTabOverview, bodyId: ids.readingTabBodyOverview },
  { name: "chat", buttonId: ids.readingTabChat, bodyId: ids.readingTabBodyChat }
];

export function setReaderScriptTab(tab: ReaderScriptTab): void {
  if (tab === "chat") {
    ensureReaderChatStyles();
  }
  for (const def of SCRIPT_TAB_DEFS) {
    const button = document.getElementById(def.buttonId);
    const body = document.getElementById(def.bodyId);
    if (!button || !body) {
      continue;
    }
    const container = button.parentElement;
    if (container && container.classList.contains("biliscript-reading-tabs")) {
      container.setAttribute("data-active-tab", tab);
    }
    const active = def.name === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    body.classList.toggle("is-active", active);
    if (active) {
      body.removeAttribute("hidden");
    } else {
      body.setAttribute("hidden", "");
    }
  }
}

let settingsAssetsPrewarmed = false;

function prewarmReaderSettingsAssets(): void {
  ensureReaderSettingsStyles();
  if (settingsAssetsPrewarmed) return;
  settingsAssetsPrewarmed = true;
  void import("./settings-panel.js").catch(() => {
    settingsAssetsPrewarmed = false;
  });
}

export function openReaderSettingsPanel(): void {
  ensureReaderSettingsStyles();
  openReaderSettingsMode();
  withReader("reader panels render", (reader) => reader.renderReaderPanels());
}

function resolveSettingsTargetAction(
  target: unknown
): ((mod: typeof import("./settings-panel.js")) => Promise<void>) | null {
  switch (target) {
    case "live":
    case "gemini-key":
      return (mod) => mod.openLiveSettings(target);
    case "appearance":
      return (mod) => mod.openAppearanceSettings();
    case "note-export":
      return (mod) => mod.openNoteExportSettings();
    default:
      return null;
  }
}

function dispatchSettingsPanelTarget(target: unknown): void {
  const openTarget = resolveSettingsTargetAction(target);
  if (!openTarget) return;
  void import("./settings-panel.js")
    .then((mod) => openTarget(mod))
    .catch((error) => logWarn("[BILISCRIPT] open settings target failed", { target, error }));
}

subscribeUiCommand((name, payload) => {
  if (name === "project-tab") {
    const tab = (payload as { tab?: unknown } | null)?.tab;
    if (!isReaderScriptTab(tab)) {
      return;
    }
    setReaderScriptTab(tab);
    return;
  }
  if (name === "open-settings") {
    const target = (payload as { target?: unknown } | null)?.target;
    if ((target === "live" || target === "gemini-key") && !supportsLiveCompanion()) {
      return;
    }
    if (target === "asr") {
      void beginReaderAsrSetupFlow();
      return;
    }
    openReaderSettingsPanel();
    dispatchSettingsPanelTarget(target);
  }
});

export function bindUiEvents(): void {
  const readingView = byId(ids.readingView);
  const readingCloseBtn = byId(ids.readingCloseBtn);
  const readingThemeSelect = byId(ids.readingThemeSelect);
  const readingSettingsToggleBtn = byId(ids.readingSettingsBtn);
  const readingSettingsBackBtn = byId(ids.readingSettingsBackBtn);
  const readingHeader = readingView.querySelector<HTMLElement>(".biliscript-reading-header")!;

  bindSubtitleTabEvents();
  bindReadingExplainEvents();
  bindReadingOverviewEvents();

  for (const def of SCRIPT_TAB_DEFS) {
    byId(def.buttonId).addEventListener("click", () => {
      reportTabIntent(def.name);
    });
  }

  const consumeOverlayClick = (event: Event): boolean => {
    if (!state.reader.readingSettingsExpanded || !hasReaderSettingsOverlayOpen()) return false;
    event.stopPropagation();
    return true;
  };
  readingCloseBtn.addEventListener("click", (event) => {
    if (consumeOverlayClick(event)) return;
    exitReaderShell().catch((error) => logWarn("[BILISCRIPT] close reading view failed", error));
  });
  readingThemeSelect.addEventListener("click", (event) => {
    if (consumeOverlayClick(event)) return;
    const next = state.reader.readingTheme === "dark" ? "light" : "dark";
    withReader("reader theme switch", (reader) => {
      reader.updateReaderPreferences({ readerTheme: next }, { persist: true });
      readingThemeSelect.classList.add("is-active");
      setTimeout(() => readingThemeSelect.classList.remove("is-active"), 300);
    });
  });
  readingSettingsBackBtn.addEventListener("click", (event) => {
    if (consumeOverlayClick(event)) return;
    stepBackReaderSettings();
  });
  readingView.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const backBtn = target?.closest<HTMLButtonElement>(`#${ids.readingSettingsBackBtn}`);
    if (backBtn && backBtn !== readingSettingsBackBtn) {
      if (consumeOverlayClick(event)) return;
      stepBackReaderSettings();
    }
  });
  readingSettingsToggleBtn.addEventListener("pointerenter", prewarmReaderSettingsAssets, { once: true });
  readingSettingsToggleBtn.addEventListener("focus", prewarmReaderSettingsAssets, { once: true });
  readingSettingsToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (consumeOverlayClick(event)) return;
    if (state.reader.readingSettingsExpanded) {
      closeReaderSettingsMode();
    } else {
      openReaderSettingsPanel();
    }
  });
  readingHeader.addEventListener("click", (event) => {
    if (!state.reader.readingSettingsExpanded) return;
    if (consumeOverlayClick(event)) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.stopPropagation();
    closeReaderSettingsMode();
  });

  if (!state.reader.readingDocumentClickBound) {
    document.addEventListener("click", (event) => {
      dispatchChatTabOutsideClick(event);
      if (!state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen()) return;
      const scriptPanel = document.getElementById(ids.readingScriptPanel);
      if (!scriptPanel || readingHeader.contains(event.target as Node | null)) return;
      if (!scriptPanel.contains(event.target as Node | null)) {
        closeReaderSettingsMode({ restoreFocus: false });
      }
    });
    document.addEventListener("keydown", (event) => {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k" &&
        isReaderViewOpen()
      ) {
        event.preventDefault();
        event.stopPropagation();
        withReader("toggle command palette", (reader) => reader.toggleCommandPalette());
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || !state.reader.readingSettingsExpanded) return;
      event.preventDefault();
      event.stopPropagation();
      stepBackReaderSettings();
    });
    state.reader.readingDocumentClickBound = true;
  }

  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      withReader(null, (reader) => reader.stopReadingViewSync());
    }
  });
}

export function ensureUiReady({ forceRecreate = false }: { forceRecreate?: boolean } = {}): void {
  const existingRoot = document.getElementById(ids.root);
  if (existingRoot && forceRecreate) {
    existingRoot.remove();
    uiState.setEventsBound(false);
  }

  let root = document.getElementById(ids.root);
  if (!root) {
    root = document.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    document.body.appendChild(root);
    uiState.setEventsBound(false);
  }

  if (!state.ui.uiEventsBound) {
    bindUiEvents();
    uiState.setEventsBound(true);
  }
}

