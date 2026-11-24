import { state, transitionReaderShell } from "../core/state.js";
import { getCurrentClipScope } from "../shared/content-event-bus.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";
import {
  activeById,
  getActiveReaderDocument,
  getOpenerDocument,
  isReaderDetached,
  resetActiveReaderHost
} from "../shared/active-host.js";
import { closeDetachedWindowHost, syncDetachedWindowHostTitle } from "./detached-window.js";
import { clearMirroredStyles } from "../shared/style-injector.js";
import { normalizeReaderTheme } from "../core/validators.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { requestSubtitleRefresh, persistReaderSettingsThroughSeam, subscribeReaderPresenter, notifyReaderPresenter, registerReaderPorts, readerPorts } from "./reader-bus.js";
import type { ReaderPresenterEvent } from "./reader-bus.js";
import { logWarn } from "../shared/logging.js";
import { ensureSecondarySubtitleLoaded } from "./secondary-subtitle.js";
import { ensureAsrTranslation } from "./asr-translation.js";

import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  syncReaderExternalTheme
} from "./presentation.js";
import {
  resolveEffectiveTheme,
  watchExternalThemeChanges,
  writeThemeSnapshot
} from "../shared/host-theme.js";
import { READER_CLOSE_ATTRS, READER_READY_ATTR } from "./presentation-fields.js";
import { clearSubtitleNotice, showSubtitleNotice } from "./subtitle-notice.js";

import { getReaderActiveScriptTab, ids } from "./state.js";
import { openScriptHost, closeScriptHost, relayoutScriptHost, waitForScriptAnchor } from "./script-host.js";

import { loadReaderScriptTab } from "./script-tab-persistence.js";
import { activateScriptTab } from "./script-tab-activation.js";
import {
  projectReaderSettingsMode,
  closeReaderSettingsMode,
  focusWithoutScroll
} from "./settings-mode.js";
import { captureTriggerRect, computeRelativeOrigin } from "../ui/trigger-motion.js";
import { ensureReaderChatTab, isReaderChatTabLoaded } from "./lazy-chat-tab.js";
import {
  cancelReadingSubtitleAppend,
  ensureReadingSubtitleRenderedUpTo,
  setReadingSubtitleBatchHook
} from "./batched-render.js";
import { createSubtitleSearch } from "./subtitle-search.js";
import { bindReadingTranscribeBanner, updateReadingTranscribeBanner } from "./transcribe-banner.js";
import {
  createSubtitleToolbar,
  type SubtitleToolbar
} from "./subtitle-tab-ui.js";
import { clearPendingExplainIntent } from "./explain-intent.js";
import { applySubtitleHighlightsToRange } from "./subtitle-highlights-ui.js";
import {
  beginReaderAiSetupFlow,
  beginReaderAsrSetupFlow,
  invalidateReaderSetupFlows
} from "./setup-resume.js";
import { closeReaderExplainCard } from "./explain-card.js";
import { unbindReadingExplainEvents } from "./explain-pop-ui.js";
import { closeQuoteShareModal } from "./quote-share-modal.js";
import { closeCommandPalette } from "./command-palette.js";
import {
  createOverviewCoordinator,
  type ReaderOverviewCoordinator,
  type ReaderOverviewPhase,
  type ReaderOverviewSnapshot
} from "./overview-coordinator.js";
import {
  registerOverviewUiActions,
  renderReadingOverview as renderReadingOverviewUi
} from "./overview-ui.js";
import { registerReaderOverviewSource } from "./live-overview-source.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { confirmDialog, dismissConfirmDialog } from "../ui/confirm-dialog.js";
import { createViewRender, renderReaderPanels } from "./view-render.js";
import { warmUpInitialQuickPrompts } from "./quick-prompts.js";

registerReaderPorts({
  syncReadingViewPlayback,
  noteManualReaderInteraction,
  flushReadingSubtitleToIndex: ensureReadingSubtitleRenderedUpTo
});

subscribeReaderPresenter(handleReaderPresenterNotification);

setReadingSubtitleBatchHook((fromIndex, toIndex) => {
  subtitleSearch.handleRangeAppended(fromIndex, toIndex);
  applySubtitleHighlightsToRange(activeById(ids.readingSubtitleList), fromIndex, toIndex);
}
);
bindReadingTranscribeBanner();
export const subtitleToolbar: SubtitleToolbar = createSubtitleToolbar({
  onNotice: (text) => notifyReaderPresenter({ kind: "notice", text })
});
subtitleToolbar.bindEvents();

const subtitleSearch = createSubtitleSearch({
  getSearchInput: () => activeById<HTMLInputElement>(ids.readingSearchInput),
  getSubtitleList: () => activeById(ids.readingSubtitleList),
  flushReadingSubtitleToIndex: (itemIndex) => readerPorts.flushReadingSubtitleToIndex(itemIndex),
  noteManualReaderInteraction: () => noteManualReaderInteraction()
});

export function refreshReadingSubtitleSearch(
  options: { preserveIndex?: boolean; scroll?: boolean } = {}
): void {
  subtitleSearch.refresh(options);
}

export function moveReadingSubtitleSearch(direction: 1 | -1): void {
  subtitleSearch.move(direction);
}

export function clearReadingSubtitleSearch(): void {
  subtitleSearch.clear();
}

const overviewCoordinator: ReaderOverviewCoordinator = createOverviewCoordinator({
  getClip: () => state.clip,
  isReadingViewOpen: () => state.reader.readingViewOpen,
  resolveProvider: () => resolveActiveProvider(),
  loadAnalysis: () => import("../ai/analysis.js"),
  confirm: (options) =>
    state.reader.readingViewOpen && state.settings?.enableCostGuard === true
      ? confirmDialog(options)
      : Promise.resolve(true),
  registerUiActions: (actions) => registerOverviewUiActions(actions),
  setupResume: {
    begin: (request) => {
      void beginReaderAiSetupFlow({
        scope: "overview",
        errorClass: request.errorClass,
        isStillValid: request.isStillValid,
        onResume: () => {
          const resumePromise = request.onResume();
          closeReaderSettingsMode({ restoreFocus: false });
          void resumePromise.then(() => {
            const overviewBody = activeById(ids.readingOverviewBody);
            if (overviewBody) {
              if (overviewBody.tabIndex < 0) overviewBody.tabIndex = -1;
              focusWithoutScroll(overviewBody);
              return;
            }
            focusWithoutScroll(activeById(ids.readingTabOverview));
          });
        },
        onCancel: (reason) => {
          if (reason === "stale") {
            closeReaderSettingsMode({ restoreFocus: false });
            focusWithoutScroll(activeById(ids.readingTabOverview));
          }
        }
      });
    }
  },
  openTranscribeSettings: () => {
    void beginReaderAsrSetupFlow();
  },
  now: () => Date.now(),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args)
});
export { overviewCoordinator };

registerReaderOverviewSource({
  getSnapshot: () => overviewCoordinator.getSnapshot(),
  subscribe: (listener) => overviewCoordinator.subscribe(listener),
  ensureOverview: async (options) => {
    await overviewCoordinator.trigger(options);
    return overviewCoordinator.getSnapshot();
  },
  cancel: () => overviewCoordinator.cancel()
});

export const triggerReaderOverviewGeneration = (
  options?: { forceRefresh?: boolean }
): Promise<void> => overviewCoordinator.trigger(options);
export const cancelReaderOverview = (): void => overviewCoordinator.cancel();
export const resetReaderOverviewState = (): void => overviewCoordinator.reset();
export const getReaderOverviewPhase = (): ReaderOverviewPhase => overviewCoordinator.getPhase();
export const getReaderOverviewSnapshot = (): ReaderOverviewSnapshot =>
  overviewCoordinator.getSnapshot();
export const ensureReaderOverviewTab = (): void => overviewCoordinator.ensureTab();

export function renderReadingOverview(snapshot?: ReaderOverviewSnapshot): void {
  if (snapshot) {
    renderReadingOverviewUi(snapshot);
  } else {
    renderReadingOverviewUi(overviewCoordinator.getSnapshot());
  }
}

const viewRender = createViewRender({
  sessionProjections: [
    { id: "subtitle-search", project: () => subtitleSearch.refresh({ scroll: false }) },
    { id: "transcribe-banner", project: updateReadingTranscribeBanner },
    { id: "overview", project: () => renderReadingOverview() },
    { id: "subtitle-toolbar", project: () => subtitleToolbar.render() }
  ]
});
export const renderReadingView = viewRender.render;
export const READER_VIEW_PROJECTIONS = viewRender.projections;

import {
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  noteManualReaderInteraction,
  resetReaderScrollFollow,
  updateReaderFollowState
} from "./sync.js";

import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";

let subtitleReadyNotificationSeq = 0;

async function maybeRefreshReaderSubtitleInBackground() {
  const notifiedBeforeKick = subtitleReadyNotificationSeq;
  const syncIfNotAlreadyNotified = () => {
    if (subtitleReadyNotificationSeq !== notifiedBeforeKick) {
      return;
    }
    syncReaderWithCurrentClipState();
  };
  await kickSubtitleFetch(() => requestSubtitleRefresh(), {
    skipIfInHandOrInFlight: true,
    awaitVideoMetadata: true,
    recheckAfterVideoMetadata: true,
    signal: getCurrentClipScope().signal,
    onChainLoadFailed: (error) =>
      logWarn("[BILISCRIPT] subtitle refresh (summarize chain load) failed", { error }),
    continueAfterChainLoadFailed: true,
    onRefreshFailed: (error) => logWarn("[BILISCRIPT] subtitle refresh failed", { error }),
    onInHandOrInFlight: syncIfNotAlreadyNotified,
    afterRefreshSettled: syncIfNotAlreadyNotified
  });
}

export interface ReaderSubtitleReadyOptions {
  syncPlayback?: boolean;
  ensureSecondarySubtitle?: boolean;
  triggerMode?: "always" | "if-subtitles-present";
}

export function onReaderSubtitleReady(options: ReaderSubtitleReadyOptions = {}) {
  const {
    syncPlayback = false,
    ensureSecondarySubtitle = false,
    triggerMode = "always"
  } = options;

  if (state.reader.readingViewOpen) {
    if (isReaderDetached()) {
      applyReadingViewPresentation();
      const clipTitle = String(state.clip.title || "").trim();
      if (clipTitle) {
        syncDetachedWindowHostTitle(`${clipTitle} - 文摘`);
      }
    } else {
      relayoutScriptHost();
    }
    renderReadingView();

    if (syncPlayback) {
      startReadingViewSync();
      syncReadingViewPlayback(true);
    }

    const shouldTrigger = triggerMode === "always" || state.clip.subtitleBody.length > 0;
    if (shouldTrigger) {
      triggerReaderOverviewGeneration();
      warmUpReaderQuickPrompts();
    }
  }

  if (ensureSecondarySubtitle) {
    ensureSecondarySubtitleLoaded();
    if (state.settings.bilingualSubtitles === true) {
      void ensureAsrTranslation("cache-only");
    }
  }
}

function syncReaderWithCurrentClipState() {
  if (!state.reader.readingViewOpen) {
    return;
  }
  onReaderSubtitleReady({
    ensureSecondarySubtitle: true,
    triggerMode: "if-subtitles-present"
  });
}

function warmUpReaderQuickPrompts() {
  if (!state.clip.subtitleBody.length) {
    return;
  }
  void warmUpInitialQuickPrompts({
    site: state.clip.site,
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    aid: state.clip.aid,
    title: state.clip.title,
    subtitleBody: state.clip.subtitleBody
  });
}

export function handleReaderPresenterNotification(event: ReaderPresenterEvent): void {
  switch (event.kind) {
    case "reset":
      clearSubtitleNotice();
      stopReadingViewSync();
      resetReaderScrollFollow();
      closeReaderExplainCard();
      closeQuoteShareModal({ restoreFocus: false });
      closeCommandPalette();
      clearPendingExplainIntent();
      invalidateReaderSetupFlows("all");
      resetReaderOverviewState();
      if (state.reader.readingViewOpen && isReaderDetached()) {
        syncDetachedWindowHostTitle("文摘");
      }
      return;
    case "subtitle-ready":
      subtitleReadyNotificationSeq += 1;
      onReaderSubtitleReady({
        syncPlayback: true,
        ensureSecondarySubtitle: true,
        triggerMode: "always"
      });
      return;
    case "rerender":
      if (state.reader.readingViewOpen) {
        if (isReaderDetached()) {
          const clipTitle = String(state.clip.title || "").trim();
          if (clipTitle) {
            syncDetachedWindowHostTitle(`${clipTitle} - 文摘`);
          }
        }
        renderReadingView();
      }
      return;
    case "secondary-subtitle-ready":
      if (state.reader.readingViewOpen) {
        renderReadingView();
      }
      return;
    case "notice":
      showSubtitleNotice(event.text);
      return;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

const READER_TAB_BUTTON_IDS = {
  subtitle: ids.readingTabSubtitle,
  overview: ids.readingTabOverview,
  chat: ids.readingTabChat
} as const;

let readerReturnFocus: HTMLElement | null = null;
let restoreReaderFocusOnClose = false;
let readerFocusRestorePending = false;
let readerPanelScope: DisposableContext | null = null;

export function getReaderPanelSignal(): AbortSignal | undefined {
  return readerPanelScope?.signal;
}

function findReadingView(): HTMLElement | null {
  return activeById(ids.readingView) ?? getOpenerDocument().getElementById(ids.readingView);
}

function requireReadingView(): HTMLElement {
  const readingView = findReadingView();
  if (!readingView) {
    throw new Error(`Missing node: ${ids.readingView}`);
  }
  return readingView;
}

export function focusReadingView(): void {
  const tabId = READER_TAB_BUTTON_IDS[getReaderActiveScriptTab()];
  focusWithoutScroll(activeById(tabId) ?? activeById(ids.readingCloseBtn));
}

function captureReaderReturnFocus(readingView: HTMLElement): void {
  const openerDoc = getOpenerDocument();
  const active = openerDoc.activeElement;
  readerFocusRestorePending = false;
  restoreReaderFocusOnClose = false;
  readerReturnFocus = active instanceof HTMLElement &&
    active !== openerDoc.body &&
    active !== openerDoc.documentElement &&
    !readingView.contains(active)
    ? active
    : null;
}

function isReaderFocusTargetAvailable(target: HTMLElement | null, readingView: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    (!readingView || !readingView.contains(target)) &&
    !target.closest("[hidden], [aria-hidden='true']") &&
    !(target instanceof HTMLButtonElement && target.disabled)
  );
}

export function restoreReadingViewFocus(): void {
  if (!readerFocusRestorePending) return;
  readerFocusRestorePending = false;
  const returnFocus = readerReturnFocus;
  readerReturnFocus = null;
  if (state.reader.readingViewOpen) return;
  const openerDoc = getOpenerDocument();
  const readingView =
    activeById(ids.readingView) ?? openerDoc.getElementById(ids.readingView);
  const active = openerDoc.activeElement;
  if (
    active instanceof Node &&
    active !== openerDoc.body &&
    active !== openerDoc.documentElement &&
    (!readingView || !readingView.contains(active))
  ) {
    return;
  }
  const scriptButton = openerDoc.getElementById("biliscript-script-button");
  const target = isReaderFocusTargetAvailable(returnFocus, readingView)
    ? returnFocus
    : isReaderFocusTargetAvailable(scriptButton, readingView)
      ? scriptButton
      : null;
  if (target) {
    focusWithoutScroll(target);
    return;
  }
  const root = openerDoc.getElementById(ids.root);
  if (root) {
    root.tabIndex = -1;
    focusWithoutScroll(root);
  }
}

export async function enterReaderMode(
  mode: "open" | "restore" = "open",
  options: { triggerRect?: DOMRect | null } = {}
) {
  const readingView = requireReadingView();
  const launchTriggerRect =
    captureTriggerRect(options.triggerRect) ??
    captureTriggerRect(document.activeElement instanceof Element ? document.activeElement : null);
  captureReaderReturnFocus(readingView);
  readerPanelScope?.dispose();
  readerPanelScope = createDisposableContext();
  transitionReaderShell("open");
  if (!isReaderDetached()) {
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
  }
  document.body.setAttribute("data-biliscript-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  watchExternalThemeChanges(
    () => {
      syncReaderExternalTheme();
    },
    { signal: readerPanelScope.signal }
  );
  const restoredScriptTab = await loadReaderScriptTab();
  await activateScriptTab(restoredScriptTab, { persist: false });
  await waitForScriptAnchor();
  openScriptHost();
  openReaderViewShell(readingView, mode);
  if (readingView && readingView.getAttribute("data-biliscript-script-float") === "1") {
    const floatOrigin = computeRelativeOrigin(
      readingView.getBoundingClientRect(),
      launchTriggerRect,
      "top right"
    );
    readingView.style.setProperty("--biliscript-float-origin", floatOrigin);
  } else if (readingView) {
    readingView.style.removeProperty("--biliscript-float-origin");
  }
  onReaderSubtitleReady({
    syncPlayback: true,
    ensureSecondarySubtitle: true,
    triggerMode: "always"
  });
  void maybeRefreshReaderSubtitleInBackground();
}

function setReadingViewInert(readingView: HTMLElement, inert: boolean): void {
  readingView.inert = inert;
  readingView.toggleAttribute("inert", inert);
}

function blurActiveFocusInside(container: HTMLElement): boolean {
  const ownerDoc = container.ownerDocument ?? getActiveReaderDocument();
  const active = ownerDoc.activeElement;
  const contained = Boolean(active && container.contains(active as Node));
  if (contained && typeof (active as HTMLElement | null)?.blur === "function") {
    (active as HTMLElement).blur();
  }
  const openerDoc = getOpenerDocument();
  if (contained && ownerDoc !== openerDoc) {
    const openerActive = openerDoc.activeElement as
      | (HTMLElement & { contentDocument?: Document | null })
      | null;
    if (openerActive?.contentDocument === ownerDoc && typeof openerActive.blur === "function") {
      openerActive.blur();
    }
  }
  return contained;
}

function openReaderViewShell(
  readingView = requireReadingView(),
  mode: "open" | "restore" = "open"
) {
  if (!readingView) {
    return;
  }
  if (mode === "restore") {
    readingView.setAttribute("data-biliscript-reader-restore", "1");
    requestAnimationFrame(() => {
      readingView.removeAttribute("data-biliscript-reader-restore");
    });
  }
  readingView.hidden = false;
  setReadingViewInert(readingView, false);
  readingView.classList.remove("closing");
  readingView.classList.add("open", "reader-page");
  readingView.setAttribute("aria-hidden", "false");
  setReadingViewReady(true);
  focusReadingView();
}

export function beginClosingReadingView(
  options: { preserveFocusRestore?: boolean } = {}
): boolean {
  const readingView = findReadingView();
  if (!readingView) {
    restoreReaderFocusOnClose = Boolean(options.preserveFocusRestore);
    if (isReaderChatTabLoaded()) {
      void closeChatSessionQuietly();
    }
    return false;
  }
  const wasOpen = readingView.classList.contains("open");
  restoreReaderFocusOnClose =
    Boolean(options.preserveFocusRestore) || blurActiveFocusInside(readingView);
  setReadingViewInert(readingView, true);
  readingView.classList.remove("open");
  readingView.classList.add("closing");
  readingView.setAttribute("aria-hidden", "true");
  if (isReaderChatTabLoaded()) {
    void closeChatSessionQuietly();
  }
  return wasOpen;
}

export function closeReadingView() {
  const openerDoc = getOpenerDocument();
  let readingView = findReadingView();
  const hadFocusInside = readingView ? blurActiveFocusInside(readingView) : false;
  readerFocusRestorePending = restoreReaderFocusOnClose || hadFocusInside;
  restoreReaderFocusOnClose = false;
  if (!readerFocusRestorePending) {
    readerReturnFocus = null;
  }
  if (readingView && readingView.ownerDocument !== openerDoc) {
    const detachedDoc = readingView.ownerDocument;
    if (detachedDoc) {
      detachedDoc.documentElement?.removeAttribute("data-biliscript-detached");
      detachedDoc.documentElement?.removeAttribute("data-biliscript-reader-mode");
      detachedDoc.body?.removeAttribute("data-biliscript-detached");
      detachedDoc.body?.removeAttribute("data-biliscript-reader-mode");
      detachedDoc.body?.removeAttribute("data-biliscript-reading-active");
      clearMirroredStyles(detachedDoc);
    }
    let root = openerDoc.getElementById(ids.root);
    if (!root) {
      root = openerDoc.createElement("div");
      root.id = ids.root;
      openerDoc.body.appendChild(root);
    }
    try {
      readingView = openerDoc.adoptNode(readingView) as HTMLElement;
    } catch {
    }
    root.appendChild(readingView);
  }
  state.reader.setDetachedMode(null);
  resetActiveReaderHost();
  closeDetachedWindowHost(true);
  transitionReaderShell("closed");
  state.reader.setViewReady(false);
  state.reader.setSettingsExpanded(false);
  projectReaderSettingsMode();
  state.reader.setNextScrollBehavior("smooth");
  resetReaderScrollFollow();

  if (readingView) {
    readingView.classList.remove("open", "closing", "reader-page");
    readingView.hidden = true;
    setReadingViewInert(readingView, false);
    readingView.getAnimations?.().forEach((animation) => animation.cancel());
    readingView.setAttribute("aria-hidden", "true");
    readingView.setAttribute(READER_READY_ATTR, "0");
    readingView.removeAttribute("data-biliscript-reader-restore");
    readingView.removeAttribute("data-biliscript-detached");
    readingView.style.removeProperty("--biliscript-float-origin");
    for (const attr of READER_CLOSE_ATTRS.readingView) {
      readingView.removeAttribute(attr);
    }
  }
  for (const attr of READER_CLOSE_ATTRS.body) {
    openerDoc.body.removeAttribute(attr);
  }
  for (const attr of READER_CLOSE_ATTRS.html) {
    openerDoc.documentElement.removeAttribute(attr);
  }
  cancelReadingSubtitleAppend();
  clearReadingSubtitleSearch();
  clearPendingExplainIntent();
  invalidateReaderSetupFlows("all");
  dismissConfirmDialog();
  closeReaderExplainCard();
  closeQuoteShareModal({ restoreFocus: false });
  closeCommandPalette();
  unbindReadingExplainEvents();
  if (isReaderChatTabLoaded()) {
    void closeChatSessionQuietly();
  }
  resetReaderOverviewState();
  stopReadingViewSync();
  closeScriptHost();
  readerPanelScope?.dispose();
  readerPanelScope = null;
}

async function closeChatSessionQuietly(): Promise<void> {
  try {
    const chat = await ensureReaderChatTab();
    await chat.closeChatSession();
  } catch {
  }
}

export function updateReaderPreferences(next: Partial<Record<string, unknown>>, { persist = true } = {}) {
  const mode = normalizeReaderTheme(next.readerTheme ?? state.reader.readingThemeMode);
  const resolved = resolveEffectiveTheme(mode);
  state.reader.setThemeMode(mode);
  state.reader.setTheme(resolved);
  state.setSettings({
    ...state.settings,
    readerTheme: mode,
    readerThemeUserSet: true
  });
  writeThemeSnapshot({
    mode,
    palette: state.reader.readingPalette || "flyme",
    resolved
  });
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

function persistReaderSettings() {
  persistReaderSettingsThroughSeam();
}

function setReadingViewReady(ready: boolean) {
  state.reader.setViewReady(Boolean(ready));
  const readingView =
    activeById(ids.readingView) ?? getOpenerDocument().getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute(READER_READY_ATTR, state.reader.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.reader.readingViewReady ? "false" : "true");
}

