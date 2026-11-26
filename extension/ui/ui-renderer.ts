import type { DetachedWindowMode } from "../core/defaults.js";
import { state, uiState } from "../core/state.js";
import {
  activeById,
  getActiveReaderDocument,
  getOpenerDocument,
  isReaderDetached,
  onActiveHostChange,
  resetActiveReaderHost
} from "../shared/active-host.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { detectActiveSite, getSiteCapabilities } from "../shared/site.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";
import { READING_RESET_ICON } from "./reading-icons.js";
import { renderUiIcon } from "./icon-registry.js";
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
import { closeDetachedWindowHost } from "../reader/detached-window.js";
import { detachReaderShell, exitReaderShell, redockReaderShell } from "../reader/shell.js";
import { clearMirroredStyles, ensureReaderChatStyles, ensureReaderSettingsStyles } from "../shared/style-injector.js";
import { withReader } from "./reader-gate.js";
import { reportTabIntent, subscribeUiCommand } from "../reader/reader-bus.js";
import { buildChatTabBodyHtml } from "../reader/chat-template.js";
import { buildSubtitleTabBodyHtml, bindSubtitleTabEvents } from "../reader/subtitle-tab-ui.js";
import { buildExplainPopHtml, buildExplainCardHostHtml, bindReadingExplainEvents } from "../reader/explain-pop-ui.js";
import { buildOverviewTabBodyHtml, bindReadingOverviewEvents } from "../reader/overview-ui.js";

export const DETACH_BTN_ID = "biliscript-reading-detach-btn";
export const DETACHED_NOTICE_ID = "biliscript-reading-detached-notice";

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
                <button id="${DETACH_BTN_ID}" type="button" class="biliscript-reading-icon-btn" title="弹出独立窗口" aria-label="弹出独立窗口" aria-pressed="false">
                  ${READING_HEADER_ICONS.detach}
                </button>
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
            <p id="${DETACHED_NOTICE_ID}" class="biliscript-reading-detached-notice" role="status" aria-live="polite" hidden></p>

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
                  ${renderUiIcon("moreVertical")}
                </button>
                <div id="${ids.readingChatMoreMenu}" class="biliscript-reading-chat-more-menu" hidden>
                  <div class="biliscript-reading-chat-more-actions">
                    <button id="${ids.readingChatNewBtn}" type="button" class="biliscript-reading-chat-more-item">
                      ${renderUiIcon("newChat")}
                      <span>开启新会话</span>
                    </button>
                    <button id="${ids.readingChatHistoryBtn}" type="button" class="biliscript-reading-chat-more-item">
                      ${renderUiIcon("history")}
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
      <div id="${ids.readingResizeHandle}" class="biliscript-reading-resize-handle" aria-hidden="true"></div>
    </section>
  `;
}

export type { ReaderScriptTab } from "../reader/state.js";

const SCRIPT_TAB_DEFS: Array<{ name: ReaderScriptTab; buttonId: string; bodyId: string }> = [
  { name: "subtitle", buttonId: ids.readingTabSubtitle, bodyId: ids.readingTabBodySubtitle },
  { name: "overview", buttonId: ids.readingTabOverview, bodyId: ids.readingTabBodyOverview },
  { name: "chat", buttonId: ids.readingTabChat, bodyId: ids.readingTabBodyChat }
];

export function refreshDetachButton(
  detached = isReaderDetached(),
  detachedMode: DetachedWindowMode | null = detached ? state.reader.readingDetachedMode : null
): void {
  const button = activeById<HTMLButtonElement>(DETACH_BTN_ID);
  const closeBtn = activeById<HTMLButtonElement>(ids.readingCloseBtn);
  if (button) {
    const label = detached ? "归位回页面" : "弹出独立窗口";
    button.innerHTML = detached ? READING_HEADER_ICONS.redock : READING_HEADER_ICONS.detach;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", detached ? "true" : "false");
    button.hidden = detached && detachedMode === "pip";
  }
  if (closeBtn) {
    closeBtn.hidden = detached;
  }
}

export function setReaderScriptTab(tab: ReaderScriptTab): void {
  if (tab === "chat") {
    ensureReaderChatStyles();
  }
  for (const def of SCRIPT_TAB_DEFS) {
    const button = activeById(def.buttonId);
    const body = activeById(def.bodyId);
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
    const site =
      state.clip.site === "youtube" || detectActiveSite() === "youtube"
        ? "youtube"
        : state.clip.site;
    const siteCaps = getSiteCapabilities(site);
    if (
      (target === "live" || target === "gemini-key") &&
      (!supportsLiveCompanion() || !siteCaps.supportsLiveCompanion)
    ) {
      return;
    }
    if (target === "asr") {
      if (!siteCaps.supportsAsr) {
        return;
      }
      void beginReaderAsrSetupFlow();
      return;
    }
    if ((target === "agent" || target === "agent-address") && !siteCaps.supportsAgentBridge) {
      return;
    }
    openReaderSettingsPanel();
    dispatchSettingsPanelTarget(target);
  }
});

const ACTIVE_HOST_DOC_CLEANUP_KEY = Symbol.for("biliscript.uiActiveHostDocCleanup");
type ActiveHostDocCleanupHost = typeof globalThis & Record<symbol, (() => void) | undefined>;

let activeHostUnsubscribe: (() => void) | null = null;

function clearActiveHostDocListeners(): void {
  const host = globalThis as ActiveHostDocCleanupHost;
  const cleanup = host[ACTIVE_HOST_DOC_CLEANUP_KEY];
  host[ACTIVE_HOST_DOC_CLEANUP_KEY] = undefined;
  cleanup?.();
}

function rebindActiveHostDocumentListeners(doc: Document): void {
  clearActiveHostDocListeners();
  const onDocClick = (event: MouseEvent) => {
    dispatchChatTabOutsideClick(event);
    if (!state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen()) return;
    const scriptPanel = doc.getElementById(ids.readingScriptPanel);
    const readingHeader = scriptPanel?.querySelector<HTMLElement>(".biliscript-reading-header");
    if (!scriptPanel || readingHeader?.contains(event.target as Node | null)) return;
    if (!scriptPanel.contains(event.target as Node | null)) {
      closeReaderSettingsMode({ restoreFocus: false });
    }
  };
  const onDocKeydown = (event: KeyboardEvent) => {
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
  };
  doc.addEventListener("click", onDocClick);
  doc.addEventListener("keydown", onDocKeydown);
  (globalThis as ActiveHostDocCleanupHost)[ACTIVE_HOST_DOC_CLEANUP_KEY] = () => {
    try {
      doc.removeEventListener("click", onDocClick);
      doc.removeEventListener("keydown", onDocKeydown);
    } catch {}
  };
}

export function bindUiEvents(): void {
  const readingView = activeById(ids.readingView)!;
  const readingDetachBtn = activeById<HTMLButtonElement>(DETACH_BTN_ID);
  const readingCloseBtn = activeById(ids.readingCloseBtn)!;
  const readingThemeSelect = activeById(ids.readingThemeSelect)!;
  const readingSettingsToggleBtn = activeById(ids.readingSettingsBtn)!;
  const readingSettingsBackBtn = activeById(ids.readingSettingsBackBtn)!;
  const readingHeader = readingView.querySelector<HTMLElement>(".biliscript-reading-header")!;

  bindSubtitleTabEvents();
  bindReadingExplainEvents();
  bindReadingOverviewEvents();

  for (const def of SCRIPT_TAB_DEFS) {
    activeById(def.buttonId)!.addEventListener("click", () => {
      reportTabIntent(def.name);
    });
  }

  const consumeOverlayClick = (event: Event): boolean => {
    if (!state.reader.readingSettingsExpanded || !hasReaderSettingsOverlayOpen()) return false;
    event.stopPropagation();
    return true;
  };
  readingDetachBtn?.addEventListener("click", (event) => {
    if (consumeOverlayClick(event)) return;
    const run = isReaderDetached() ? redockReaderShell() : detachReaderShell();
    void run.catch((error) => logWarn("[BILISCRIPT] detach/redock failed", error));
  });
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
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const backBtn =
      typeof target?.closest === "function"
        ? target.closest(`#${ids.readingSettingsBackBtn}`)
        : null;
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
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    if (typeof target?.closest === "function" && target.closest("button")) return;
    event.stopPropagation();
    closeReaderSettingsMode();
  });

  activeHostUnsubscribe?.();
  activeHostUnsubscribe = onActiveHostChange(({ doc, detached }) => {
    rebindActiveHostDocumentListeners(doc);
    refreshDetachButton(detached);
  });
  rebindActiveHostDocumentListeners(getActiveReaderDocument());
  refreshDetachButton(isReaderDetached());
  state.reader.readingDocumentClickBound = true;

  readingView.addEventListener("transitionend", () => {
    if (!isReaderViewOpen()) {
      withReader(null, (reader) => reader.stopReadingViewSync());
    }
  });
}

export function ensureUiReady({ forceRecreate = false }: { forceRecreate?: boolean } = {}): void {
  const openerDoc = getOpenerDocument();
  if (!forceRecreate && isReaderDetached() && activeById(ids.readingView)) {
    let root = openerDoc.getElementById(ids.root);
    if (!root) {
      root = openerDoc.createElement("div");
      root.id = ids.root;
      openerDoc.body.appendChild(root);
    }
    if (!state.ui.uiEventsBound) {
      bindUiEvents();
      uiState.setEventsBound(true);
    }
    return;
  }

  if (isReaderDetached() || state.reader.readingDetached) {
    const staleDetachedDoc = getActiveReaderDocument();
    if (staleDetachedDoc !== openerDoc) {
      clearMirroredStyles(staleDetachedDoc);
    }
    closeDetachedWindowHost(true);
    state.reader.setDetachedMode(null);
    resetActiveReaderHost();
  }

  const existingRoot = openerDoc.getElementById(ids.root);
  const hasOpenerReadingView = Boolean(openerDoc.getElementById(ids.readingView));
  if (existingRoot && (forceRecreate || !hasOpenerReadingView)) {
    clearActiveHostDocListeners();
    activeHostUnsubscribe?.();
    activeHostUnsubscribe = null;
    existingRoot.remove();
    uiState.setEventsBound(false);
  }

  let root = openerDoc.getElementById(ids.root);
  if (!root) {
    root = openerDoc.createElement("div");
    root.id = ids.root;
    root.innerHTML = buildUiHtml();
    openerDoc.body.appendChild(root);
    uiState.setEventsBound(false);
  }

  if (!state.ui.uiEventsBound) {
    bindUiEvents();
    uiState.setEventsBound(true);
  }
}

