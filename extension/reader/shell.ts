import { suppressUntil } from "../ai/player-ai-state.js";
import { buildReaderModeUrl, replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import { ensureReaderChatTab } from "./lazy-chat-tab.js";
import { activateScriptTab } from "./script-tab-activation.js";
import { createSerialQueue } from "./serial-queue.js";
import { ensureUiReady } from "../ui/lazy-ui.js";
import { loadPlayerAi, isPlayerAiLoaded } from "../ai/lazy-player-ai.js";
import { ensureReaderDomain } from "./lazy-reader.js";
import {
  clearMirroredStyles,
  ensureReaderStyles,
  removeReaderStyles,
  syncStylesToDocument
} from "../shared/style-injector.js";
import { applyPrePaintReaderTheme } from "../shared/host-theme.js";
import { logWarn, logWarnAlways } from "../shared/logging.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import {
  activeById,
  getActiveReaderDocument,
  getOpenerDocument,
  getOpenerWindow,
  isReaderDetached,
  registerDetachedModeSwitchHandler,
  setActiveReaderHost
} from "../shared/active-host.js";
import {
  clampDetachedWindowBounds,
  loadDetachedWindowBounds,
  resolveInitialDetachedWindowBounds,
  saveDetachedWindowBounds,
  type DetachedWindowBounds
} from "../core/detached-bounds-store.js";
import { normalizeDetachedWindowMode } from "../core/validators.js";
import { state, getReaderShellState, transitionReaderShell } from "../core/state.js";
import { ids, isReaderViewOpen } from "./state.js";
import { isReaderShellIntact } from "./shell-intact.js";
import { requestUiCommand } from "./reader-bus.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import { captureTriggerRect, resolveTriggerElement } from "../ui/trigger-motion.js";
import {
  applyDetachedHostDocumentAttrs,
  blurActiveFocusInside,
  clearDetachedHostDocument,
  closeDetachedWindowHost,
  focusDetachedWindowHost,
  formatDetachedWindowTitle,
  getDetachedWindowHost,
  openDetachedWindowHost,
  reclaimDetachedViewToOpener,
  switchDetachedWindowHostMode,
  syncDetachedWindowHostTitle,
  type DetachedWindowMode
} from "./detached-window.js";
import { closeScriptHost, openScriptHost } from "./script-host.js";
import type { PlayerAiActionMode } from "../core/defaults.js";
import { cleanYoutubeWatchUrl, detectActiveSite } from "../shared/site.js";

export { isReaderShellIntact };

export type ReaderShellIntent = "open" | "restore" | "chat";

export interface EnterReaderShellOptions {
  readerUrl: string;
  intent: ReaderShellIntent;
  prompt?: string;
  chatMode?: PlayerAiActionMode;
  chatTurnKind?: "player-ai" | "video-note";
  settingsTarget?: LiveSettingsTarget;
}

function isYoutubeSiteActive(): boolean {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube";
}

function resolveDetachedWindowTitle(): string {
  return formatDetachedWindowTitle(state.clip.title, getOpenerDocument().title);
}

function resolveReaderEntryUrl(readerUrl: string): string {
  if (isYoutubeSiteActive()) {
    return readerUrl || cleanYoutubeWatchUrl(location.href) || location.href;
  }
  if (readerUrl || isReaderViewOpen()) {
    return readerUrl;
  }
  return buildReaderModeUrl(location.href);
}

interface ReaderEntrySequenceOptions {
  readerUrl: string;
  intent?: ReaderShellIntent;
  beforeEntry?: () => Promise<void>;
  triggerRect?: DOMRect | null;
}

const shellTransactionQueue = createSerialQueue();

function runReaderEntryExclusive(run: () => Promise<void>): Promise<void> {
  return shellTransactionQueue.enqueue(run);
}

function runReaderShellEnterTransaction(
  run: () => Promise<void>,
  onEnterFailed: (error: unknown) => void
): Promise<void> {
  return runReaderEntryExclusive(async () => {
    if (getReaderShellState() === "closed") {
      transitionReaderShell("entering");
    }
    await run();
  }).catch((error) => {
    if (getReaderShellState() === "entering") {
      transitionReaderShell("closed");
      logWarnAlways("[BILISCRIPT] reading shell enter transaction failed, state rolled back to closed", error);
    }
    onEnterFailed(error);
    throw error;
  });
}

async function runReaderEntrySequence(options: ReaderEntrySequenceOptions): Promise<void> {
  pendingDetachedExitFocusRestore = false;
  await ensureUiReady();
  await options.beforeEntry?.();
  if (isReaderViewOpen() && !options.intent) {
    return;
  }
  const isYoutube = isYoutubeSiteActive();
  const readerUrl = resolveReaderEntryUrl(options.readerUrl);
  if (isYoutube || readerUrl) {
    if (!isYoutube && readerUrl) {
      replaceReaderModeUrl(readerUrl);
    }
    await ensureReaderStyles();
    applyPrePaintReaderTheme(state.settings);
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    const readingView = document.getElementById(ids.readingView);
    if (readingView) {
      void window.getComputedStyle(readingView).display;
    }
  }
  if (!isReaderViewOpen()) {
    const reader = await ensureReaderDomain();
    await reader.enterReaderMode(
      options.intent === "restore" ? "restore" : "open",
      options.triggerRect ? { triggerRect: options.triggerRect } : undefined
    );
  } else if (options.intent === "open") {
    const reader = await ensureReaderDomain();
    reader.focusReadingView();
  }
}

interface ReaderExitDomain {
  beginClosingReadingView: (options?: { preserveFocusRestore?: boolean }) => boolean;
  closeReadingView: () => void;
  restoreReadingViewFocus: () => void;
}

function waitForReaderExitTransition(readingView: HTMLElement): Promise<void> {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timeout = 0;
    const finish = () => {
      window.clearTimeout(timeout);
      readingView.removeEventListener("transitionend", onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === readingView && event.propertyName === "scale") {
        finish();
      }
    };
    readingView.addEventListener("transitionend", onTransitionEnd);
    timeout = window.setTimeout(finish, 400);
  });
}

const DETACHED_NOTICE_ID = "biliscript-reading-detached-notice";
const DETACHED_NOTICE_DURATION_MS = 6000;

let activeDetachedDoc: Document | null = null;
let detachedNoticeTimer = 0;
let pendingDetachedExternalClose = false;
let pendingDetachedExitFocusRestore = false;

interface ScrollSnapshotEntry {
  element: HTMLElement;
  top: number;
  left: number;
}

function captureScrollPositions(readingView: HTMLElement | null): ScrollSnapshotEntry[] {
  if (!readingView) {
    return [];
  }
  const entries: ScrollSnapshotEntry[] = [];
  const candidates = [readingView, ...Array.from(readingView.querySelectorAll<HTMLElement>("*"))];
  for (const element of candidates) {
    if (element.scrollTop > 0 || element.scrollLeft > 0) {
      entries.push({ element, top: element.scrollTop, left: element.scrollLeft });
    }
  }
  return entries;
}

function restoreScrollPositions(entries: ScrollSnapshotEntry[], targetWin: Window): void {
  if (entries.length === 0) {
    return;
  }
  const apply = () => {
    for (const { element, top, left } of entries) {
      if (!element.isConnected) {
        continue;
      }
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  };
  apply();
  if (typeof targetWin.requestAnimationFrame === "function") {
    targetWin.requestAnimationFrame(apply);
  }
}

function isWindowClosed(win: Window | null | undefined): boolean {
  if (!win) {
    return true;
  }
  try {
    return win.closed === true;
  } catch {
    return true;
  }
}

function safeAdoptNode(targetDoc: Document, node: HTMLElement): HTMLElement {
  if (node.ownerDocument === targetDoc) {
    return node;
  }
  try {
    return targetDoc.adoptNode(node) as HTMLElement;
  } catch {
    return node;
  }
}

function findReadingViewAcrossHosts(): HTMLElement | null {
  return (
    activeById(ids.readingView) ??
    activeDetachedDoc?.getElementById(ids.readingView) ??
    getDetachedWindowHost()?.document.getElementById(ids.readingView) ??
    getOpenerDocument().getElementById(ids.readingView)
  );
}

function clearDetachedNotice(readingView?: HTMLElement | null): void {
  if (detachedNoticeTimer) {
    getOpenerWindow().clearTimeout(detachedNoticeTimer);
    detachedNoticeTimer = 0;
  }
  const view = readingView ?? findReadingViewAcrossHosts();
  const notice =
    view?.querySelector<HTMLElement>(`#${DETACHED_NOTICE_ID}`) ??
    activeById<HTMLElement>(DETACHED_NOTICE_ID) ??
    getOpenerDocument().getElementById(DETACHED_NOTICE_ID);
  if (!notice) {
    return;
  }
  notice.textContent = "";
  notice.hidden = true;
}

function showDetachedNotice(readingView: HTMLElement | null, text: string): void {
  clearDetachedNotice(readingView);
  const view = readingView ?? findReadingViewAcrossHosts();
  if (!view) {
    return;
  }
  let notice =
    view.querySelector<HTMLElement>(`#${DETACHED_NOTICE_ID}`) ??
    activeById<HTMLElement>(DETACHED_NOTICE_ID);
  if (!notice) {
    const ownerDoc = view.ownerDocument || getActiveReaderDocument();
    notice = ownerDoc.createElement("p");
    notice.id = DETACHED_NOTICE_ID;
    notice.className = "biliscript-reading-detached-notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    const hostPanel =
      view.querySelector<HTMLElement>(`#${ids.readingScriptPanel}`) ?? view;
    hostPanel.appendChild(notice);
  }
  notice.textContent = text;
  notice.hidden = false;
  detachedNoticeTimer = getOpenerWindow().setTimeout(() => {
    clearDetachedNotice();
  }, DETACHED_NOTICE_DURATION_MS);
}

function reclaimDetachedReadingViewToOpener(
  options: { blurFocus?: boolean } = {}
): HTMLElement | null {
  const openerDoc = getOpenerDocument();
  const activeDoc = getActiveReaderDocument();
  const detachedDoc =
    activeDetachedDoc ??
    getDetachedWindowHost()?.document ??
    (activeDoc !== openerDoc ? activeDoc : null);
  const readingView = findReadingViewAcrossHosts();
  clearDetachedNotice(readingView);
  if (options.blurFocus && blurActiveFocusInside(readingView)) {
    pendingDetachedExitFocusRestore = true;
  }
  const reclaimed = reclaimDetachedViewToOpener({
    readingView,
    rootId: ids.root,
    detachedDoc
  });
  activeDetachedDoc = null;
  state.reader.setDetachedMode(null);
  return reclaimed;
}

function restoreOpenerInPageReadingView(readingView: HTMLElement | null): void {
  const openerDoc = getOpenerDocument();
  openerDoc.documentElement.setAttribute("data-biliscript-reader-mode", "1");
  openerDoc.body.setAttribute("data-biliscript-reader-mode", "1");
  openerDoc.body.setAttribute("data-biliscript-reading-active", "1");
  if (readingView) {
    readingView.setAttribute("data-biliscript-reader-restore", "1");
    readingView.hidden = false;
    readingView.classList.remove("closing");
    readingView.classList.add("open", "reader-page");
    readingView.setAttribute("aria-hidden", "false");
    void readingView.getBoundingClientRect();
    const openerWin = getOpenerWindow();
    if (typeof openerWin?.requestAnimationFrame === "function") {
      openerWin.requestAnimationFrame(() => {
        readingView.removeAttribute("data-biliscript-reader-restore");
      });
    } else {
      readingView.removeAttribute("data-biliscript-reader-restore");
    }
  }
  openScriptHost();
}

function handleDetachedExternalClose(): void {
  const scrollSnapshot = captureScrollPositions(findReadingViewAcrossHosts());
  if (!isReaderViewOpen()) {
    reclaimDetachedReadingViewToOpener();
    return;
  }
  pendingDetachedExternalClose = true;
  pendingDetachedExitFocusRestore = false;
  const readingView = reclaimDetachedReadingViewToOpener();
  if (readingView) {
    restoreOpenerInPageReadingView(readingView);
  }
  void shellTransactionQueue
    .enqueue(async () => {
      if (!pendingDetachedExternalClose) {
        return;
      }
      pendingDetachedExternalClose = false;
      if (!isReaderViewOpen() || isReaderDetached()) {
        return;
      }
      const presentation = await import("./presentation.js");
      if (!isReaderViewOpen() || isReaderDetached()) {
        return;
      }
      presentation.applyReadingViewPresentation();
      restoreScrollPositions(scrollSnapshot, getOpenerWindow());
      const reader = await ensureReaderDomain();
      if (
        isReaderViewOpen() &&
        !isReaderDetached() &&
        !getOpenerDocument()
          .getElementById(ids.readingView)
          ?.querySelector('[data-panel-modal-host="1"]')
      ) {
        reader.focusReadingView();
      }
    })
    .catch((error) => {
      pendingDetachedExternalClose = false;
      logWarn("[BILISCRIPT] detached external redock failed", error);
    });
}

registerDetachedModeSwitchHandler((mode) => switchDetachedWindowMode(mode));

async function resolveDetachedBoundsForOpen(): Promise<DetachedWindowBounds> {
  const saved = await loadDetachedWindowBounds();
  return resolveInitialDetachedWindowBounds({
    saved,
    customPanelWidthEnabled: state.settings?.customPanelWidthEnabled === true,
    customPanelWidth: state.settings?.customPanelWidth,
    availHeight: getOpenerWindow().screen?.availHeight
  });
}

async function closeReaderViewAfterTransition(
  reader: ReaderExitDomain,
  options: { skipTransition?: boolean; preserveFocusRestore?: boolean } = {}
): Promise<void> {
  const readingView =
    activeById(ids.readingView) ?? getOpenerDocument().getElementById(ids.readingView);
  const shouldWait = reader.beginClosingReadingView(
    options.preserveFocusRestore ? { preserveFocusRestore: true } : undefined
  );
  if (!options.skipTransition && shouldWait && readingView) {
    await waitForReaderExitTransition(readingView);
  }
  reader.closeReadingView();
}

async function restoreSelfHealBeforeEntry(
  options: { skipTransition?: boolean } = {}
): Promise<void> {
  if (!isReaderViewOpen() || isReaderShellIntact()) {
    return;
  }
  const wasDetached =
    pendingDetachedExternalClose ||
    isReaderDetached() ||
    state.reader.readingDetached ||
    activeDetachedDoc !== null;
  pendingDetachedExternalClose = false;
  if (wasDetached) {
    reclaimDetachedReadingViewToOpener({ blurFocus: true });
    closeDetachedWindowHost(true);
  }
  pendingDetachedExitFocusRestore = false;
  try {
    const reader = await ensureReaderDomain();
    await closeReaderViewAfterTransition(reader, {
      skipTransition: options.skipTransition || wasDetached
    });
  } catch (error) {
    logWarn("[BILISCRIPT] reading view restore: close failed", error);
  }
}

async function removePlayerAiQuickButtonQuietly(): Promise<void> {
  try {
    const playerAi = await loadPlayerAi();
    await playerAi.removePlayerAiQuickActionButton();
  } catch {
  }
}

async function dispatchChatEntryIntent(options: {
  chatMode?: PlayerAiActionMode;
  prompt: string;
  chatTurnKind?: "player-ai" | "video-note";
}): Promise<void> {
  if (options.chatMode === "note") {
    const chat = await ensureReaderChatTab();
    await chat.runVideoNotePrompt();
    return;
  }
  if (options.prompt) {
    const chat = await ensureReaderChatTab();
    if (options.chatTurnKind) {
      await chat.runQuickActionPrompt(options.prompt, { turnKind: options.chatTurnKind });
    } else {
      await chat.runQuickActionPrompt(options.prompt);
    }
    return;
  }
  await activateScriptTab("chat", { consumeIntent: false });
}

export function enterReaderShell(options: EnterReaderShellOptions): Promise<void> {
  const { intent, chatMode, chatTurnKind } = options;
  const readerUrl = String(options.readerUrl || "").trim();
  const prompt = String(options.prompt || "").trim();
  const onFailed = (error: unknown): void => {
    logWarn(
      intent === "open"
        ? "[BILISCRIPT] reading mode trigger failed"
        : intent === "restore"
          ? "[BILISCRIPT] reading view restore failed"
          : "[BILISCRIPT] reading chat trigger failed",
      error
    );
  };

  const alreadyDetached = isReaderViewOpen() && isReaderDetached();
  const launchTriggerRect = alreadyDetached
    ? null
    : captureTriggerRect(
        resolveTriggerElement() ??
          document.getElementById("biliscript-script-button") ??
          document.getElementById("biliscript-player-ai-quick-action")
      );

  suppressUntil(Date.now() + 2500);

  if (
    intent !== "restore" &&
    !alreadyDetached &&
    (isPlayerAiLoaded() || Boolean(document.getElementById("biliscript-player-ai-quick-action")))
  ) {
    void removePlayerAiQuickButtonQuietly();
  }
  return runReaderShellEnterTransaction(async () => {
    if (isReaderViewOpen() && isReaderDetached()) {
      if (intent === "restore") {
        if (isReaderShellIntact()) {
          return;
        }
        await restoreSelfHealBeforeEntry({ skipTransition: true });
        if (getReaderShellState() === "closed") {
          transitionReaderShell("entering");
        }
      } else {
        focusDetachedWindowHost();
        if (intent === "open") {
          const reader = await ensureReaderDomain();
          reader.focusReadingView();
        } else if (intent === "chat") {
          await dispatchChatEntryIntent({ chatMode, prompt, chatTurnKind });
        }
        if (options.settingsTarget) {
          requestUiCommand("open-settings", { target: options.settingsTarget });
        }
        return;
      }
    }
    await runReaderEntrySequence({
      readerUrl,
      intent,
      beforeEntry: intent === "restore" ? restoreSelfHealBeforeEntry : undefined,
      triggerRect: launchTriggerRect
    });
    if (intent === "chat") {
      await dispatchChatEntryIntent({ chatMode, prompt, chatTurnKind });
    }
    if (options.settingsTarget) {
      requestUiCommand("open-settings", { target: options.settingsTarget });
    }
  }, onFailed);
}

export interface EnterReaderShellOnUrlNavigationOptions {
  readerUrl: string;
  onEnterFailed?: (error: unknown) => void;
}

export function enterReaderShellOnUrlNavigation(
  options: EnterReaderShellOnUrlNavigationOptions
): Promise<void> {
  const onEnterFailed = (error: unknown): void => {
    if (options.onEnterFailed) {
      options.onEnterFailed(error);
    } else {
      logWarn("[BILISCRIPT] reading view start failed", error);
    }
  };
  return runReaderShellEnterTransaction(async () => {
    await runReaderEntrySequence({ readerUrl: options.readerUrl });
  }, onEnterFailed);
}

export function detachReaderShell(): Promise<boolean> {
  return shellTransactionQueue.enqueue(async () => {
    registerDetachedModeSwitchHandler((mode) => switchDetachedWindowMode(mode));
    if (pendingDetachedExternalClose || !isReaderViewOpen()) {
      return false;
    }
    if (isReaderDetached() && getDetachedWindowHost()) {
      focusDetachedWindowHost();
      return true;
    }
    const openerDoc = getOpenerDocument();
    const readingView = openerDoc.getElementById(ids.readingView) ?? findReadingViewAcrossHosts();
    if (!readingView) {
      return false;
    }
    const [bounds, presentation] = await Promise.all([
      resolveDetachedBoundsForOpen(),
      import("./presentation.js")
    ]);
    if (pendingDetachedExternalClose || !isReaderViewOpen()) {
      return false;
    }
    if (isReaderDetached() && getDetachedWindowHost()) {
      focusDetachedWindowHost();
      return true;
    }
    const mode = normalizeDetachedWindowMode(state.settings?.detachedWindowMode);
    const opened = await openDetachedWindowHost({
      mode,
      bounds,
      onExternalClose: handleDetachedExternalClose,
      onResizeBounds: (nextBounds) => {
        void saveDetachedWindowBounds(nextBounds);
      }
    });
    if (!opened.ok) {
      if (pendingDetachedExternalClose || !isReaderViewOpen()) {
        return false;
      }
      showDetachedNotice(readingView, "浏览器阻止了独立窗口弹出，请允许弹窗后重试。");
      return false;
    }
    if (pendingDetachedExternalClose || !isReaderViewOpen()) {
      closeDetachedWindowHost(true);
      return false;
    }
    clearDetachedNotice(readingView);
    const scrollSnapshot = captureScrollPositions(readingView);
    await syncStylesToDocument(opened.document);
    if (pendingDetachedExternalClose || !isReaderViewOpen() || isWindowClosed(opened.window)) {
      clearMirroredStyles(opened.document);
      closeDetachedWindowHost(true);
      return false;
    }
    closeScriptHost();
    applyDetachedHostDocumentAttrs(opened.document);
    readingView.removeAttribute("data-biliscript-script-float");
    readingView.style.removeProperty("--biliscript-float-origin");
    readingView.setAttribute("data-biliscript-detached", "1");
    const targetView = safeAdoptNode(opened.document, readingView);
    (opened.document.body ?? opened.document.documentElement).appendChild(targetView);
    activeDetachedDoc = opened.document;
    state.reader.setDetachedMode(opened.actualMode);
    setActiveReaderHost(opened.document, opened.window);
    syncDetachedWindowHostTitle(resolveDetachedWindowTitle());
    presentation.applyReadingViewPresentation();
    restoreScrollPositions(scrollSnapshot, opened.window);
    focusDetachedWindowHost();
    return true;
  });
}

export function redockReaderShell(): Promise<boolean> {
  return shellTransactionQueue.enqueue(async () => {
    const wasDetached =
      isReaderDetached() || state.reader.readingDetached || activeDetachedDoc !== null;
    if (pendingDetachedExternalClose || !isReaderViewOpen()) {
      return false;
    }
    if (!wasDetached) {
      return true;
    }
    const presentation = await import("./presentation.js");
    const stillDetached =
      isReaderDetached() || state.reader.readingDetached || activeDetachedDoc !== null;
    if (pendingDetachedExternalClose || !isReaderViewOpen() || !stillDetached) {
      return false;
    }
    const readingViewBefore = findReadingViewAcrossHosts();
    const scrollSnapshot = captureScrollPositions(readingViewBefore);
    pendingDetachedExitFocusRestore = false;
    const readingView = reclaimDetachedReadingViewToOpener();
    closeDetachedWindowHost(true);
    restoreOpenerInPageReadingView(readingView);
    presentation.applyReadingViewPresentation();
    restoreScrollPositions(scrollSnapshot, getOpenerWindow());
    const reader = await ensureReaderDomain();
    if (
      isReaderViewOpen() &&
      !isReaderDetached() &&
      !getOpenerDocument()
        .getElementById(ids.readingView)
        ?.querySelector('[data-panel-modal-host="1"]')
    ) {
      reader.focusReadingView();
    }
    return true;
  });
}

export function switchDetachedWindowMode(nextMode: DetachedWindowMode): Promise<boolean> {
  return shellTransactionQueue.enqueue(async () => {
    if (pendingDetachedExternalClose || !isReaderViewOpen() || !isReaderDetached()) {
      return false;
    }
    const currentHost = getDetachedWindowHost();
    if (!currentHost || isWindowClosed(currentHost.window)) {
      return false;
    }
    if (currentHost.actualMode === nextMode) {
      focusDetachedWindowHost();
      return true;
    }
    const previousDoc = currentHost.document;
    const previousWin = currentHost.window;
    const previousMode = currentHost.actualMode;
    const w = Number(previousWin.innerWidth);
    const h = Number(previousWin.innerHeight);
    const bounds =
      Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0
        ? clampDetachedWindowBounds({ width: w, height: h })
        : await resolveDetachedBoundsForOpen();
    const presentation = await import("./presentation.js");
    if (
      pendingDetachedExternalClose ||
      !isReaderViewOpen() ||
      !isReaderDetached() ||
      getDetachedWindowHost()?.window !== previousWin ||
      isWindowClosed(previousWin)
    ) {
      return false;
    }
    const readingView = findReadingViewAcrossHosts();
    if (!readingView) {
      return false;
    }
    let scrollSnapshot: ScrollSnapshotEntry[] = [];
    let migratedView: HTMLElement = readingView;
    const switched = await switchDetachedWindowHostMode({
      mode: nextMode,
      bounds,
      onExternalClose: handleDetachedExternalClose,
      onResizeBounds: (nextBounds) => {
        void saveDetachedWindowBounds(nextBounds);
      },
      beforeClosePrevious: async (next) => {
        if (
          pendingDetachedExternalClose ||
          !isReaderViewOpen() ||
          isWindowClosed(previousWin) ||
          isWindowClosed(next.window)
        ) {
          throw new Error("Detached host closed");
        }
        await syncStylesToDocument(next.document);
        if (
          pendingDetachedExternalClose ||
          !isReaderViewOpen() ||
          isWindowClosed(previousWin) ||
          isWindowClosed(next.window)
        ) {
          clearMirroredStyles(next.document);
          throw new Error("Detached host closed");
        }
        scrollSnapshot = captureScrollPositions(readingView);
        applyDetachedHostDocumentAttrs(next.document);
        readingView.setAttribute("data-biliscript-detached", "1");
        migratedView = safeAdoptNode(next.document, readingView);
        (next.document.body ?? next.document.documentElement).appendChild(migratedView);
        activeDetachedDoc = next.document;
        state.reader.setDetachedMode(next.actualMode);
        setActiveReaderHost(next.document, next.window);
        syncDetachedWindowHostTitle(resolveDetachedWindowTitle());
        presentation.applyReadingViewPresentation();
        if (previousDoc !== next.document) {
          clearDetachedHostDocument(previousDoc);
        }
      }
    });
    if (!switched.ok) {
      if (
        pendingDetachedExternalClose ||
        !isReaderViewOpen() ||
        isWindowClosed(previousWin)
      ) {
        if (migratedView.ownerDocument !== getOpenerDocument()) {
          reclaimDetachedReadingViewToOpener({ blurFocus: true });
        }
        return false;
      }
      if (migratedView.ownerDocument !== previousDoc) {
        await syncStylesToDocument(previousDoc);
        applyDetachedHostDocumentAttrs(previousDoc);
        migratedView.setAttribute("data-biliscript-detached", "1");
        const restoredView = safeAdoptNode(previousDoc, migratedView);
        (previousDoc.body ?? previousDoc.documentElement).appendChild(restoredView);
        activeDetachedDoc = previousDoc;
        state.reader.setDetachedMode(previousMode);
        setActiveReaderHost(previousDoc, previousWin);
        presentation.applyReadingViewPresentation();
        migratedView = restoredView;
      }
      showDetachedNotice(
        migratedView,
        "浏览器阻止了模式切换，已保留当前窗口；下次弹出时生效。"
      );
      return false;
    }
    clearDetachedNotice(migratedView);
    restoreScrollPositions(scrollSnapshot, switched.window);
    focusDetachedWindowHost();
    return true;
  });
}

export function exitReaderShell(): Promise<void> {
  return runReaderEntryExclusive(async () => {
    if (getReaderShellState() !== "closed") {
      transitionReaderShell("exiting");
    }
    const wasDetached =
      pendingDetachedExternalClose ||
      isReaderDetached() ||
      state.reader.readingDetached ||
      activeDetachedDoc !== null;
    pendingDetachedExternalClose = false;
    clearDetachedNotice();
    if (wasDetached) {
      reclaimDetachedReadingViewToOpener({ blurFocus: true });
      closeDetachedWindowHost(true);
    }
    const preserveFocusRestore = pendingDetachedExitFocusRestore;
    pendingDetachedExitFocusRestore = false;
    if (!isYoutubeSiteActive() && isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
    const reader = await ensureReaderDomain();
    await closeReaderViewAfterTransition(reader, {
      skipTransition: wasDetached,
      preserveFocusRestore
    });
    removeReaderStyles();
    contentEventBus.emit("reader:closed");
    reader.restoreReadingViewFocus();
  }).catch((error) => {
    if (getReaderShellState() === "exiting") {
      transitionReaderShell("open");
      logWarnAlways("[BILISCRIPT] reading shell exit transaction failed, state rolled back to open", error);
    }
    throw error;
  });
}

export function resetDetachedShellStateForTests(): void {
  if (detachedNoticeTimer) {
    getOpenerWindow().clearTimeout(detachedNoticeTimer);
    detachedNoticeTimer = 0;
  }
  activeDetachedDoc = null;
  pendingDetachedExternalClose = false;
  pendingDetachedExitFocusRestore = false;
  closeDetachedWindowHost(true);
  registerDetachedModeSwitchHandler((mode) => switchDetachedWindowMode(mode));
}
