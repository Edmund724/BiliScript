import { state } from "../core/state.js";
import { activeById, onActiveHostChange } from "../shared/active-host.js";
import { isHtmlElement, resolveNodeDocument, safeRemoveListener } from "../shared/cross-doc.js";
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage, isAbortedMarkerError } from "../shared/error-helpers.js";
import { ensureReaderChatStyles } from "../shared/style-injector.js";
import { hydrateMarkdownContent, renderMarkdown } from "../ui/markdown.js";
import { renderUiIcon } from "../ui/icon-registry.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { resolveWebSearchOptIn } from "../search/opt-in-notice.js";
import { resolveWebSearchRuntime, type WebSearchRuntime } from "../search/search-runtime.js";
import { logWarn } from "../shared/logging.js";
import { ids } from "./state.js";
import { setPendingExplainIntent } from "./explain-intent.js";
import { beginReaderAiSetupFlow, invalidateReaderSetupFlows } from "./setup-resume.js";
import {
  closeReaderSettingsMode,
  hasReaderSettingsOverlayOpen
} from "./settings-mode.js";
import { findSubtitleItem } from "./subtitle-item-dom.js";
import { activateScriptTab } from "./script-tab-activation.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  applyElementTriggerOrigin,
  cancelTriggerExit,
  captureTriggerRect
} from "../ui/trigger-motion.js";

type ExplainCardPhase = "loading" | "ready" | "error";

interface ExplainCardState {
  open: boolean;
  phase: ExplainCardPhase;
  selection: string;
  line: string;
  from: number;
  index: number;
  text: string;
  error: string;
  controller: AbortController | null;
  runId: number;
  searching: boolean;
  notice: string;
}

const card: ExplainCardState = {
  open: false,
  phase: "loading",
  selection: "",
  line: "",
  from: 0,
  index: -1,
  text: "",
  error: "",
  controller: null,
  runId: 0,
  searching: false,
  notice: ""
};

export interface ReaderExplainCardPayload {
  selection: string;
  line: string;
  from: number;
  index: number;
}

const CARD_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let returnFocusEl: HTMLElement | null = null;
let pendingInitialFocus = false;
let pendingCardEnterAnimation = false;
let cardTriggerRect: DOMRect | null = null;

function isElementFocusable(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element || !element.isConnected) {
    return false;
  }
  if (
    element.hidden ||
    element.closest("[hidden]") ||
    element.closest('[aria-hidden="true"]') ||
    element.closest("[inert]")
  ) {
    return false;
  }
  if ((element as HTMLButtonElement).disabled) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  if (view) {
    const style = view.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
  }
  return true;
}

function getDialogFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR)).filter(isElementFocusable);
}

function focusExplainDialog(): void {
  const root = getCardRoot();
  const dialog = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  dialog?.focus?.({ preventScroll: true });
}

function getCardRoot(): HTMLElement | null {
  return activeById(ids.readingExplainCard);
}

function getClipBody(): { from: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

function renderCard(): void {
  const root = getCardRoot();
  if (!root) {
    return;
  }
  if (!card.open) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
    ensureReaderChatStyles();
  }
  root.hidden = false;

  const docActive = resolveNodeDocument(root).activeElement;
  const activeEl = isHtmlElement(docActive) ? docActive : null;
  const wasFocusInsideCard = Boolean(activeEl && root.contains(activeEl));
  const activeAction = wasFocusInsideCard ? activeEl?.dataset.explainCardAction ?? "" : "";

  const setupClass = card.phase === "error" ? classifyOverviewSetupError(card.error) : null;
  const bodyHtml =
    card.phase === "loading"
      ? `
        <div class="biliscript-reading-explain-card-state">
          <span class="biliscript-reading-explain-card-dot" aria-hidden="true"></span>
          <span>${card.searching ? "正在联网搜索…" : "正在解释…"}</span>
        </div>
        <div class="biliscript-reading-explain-card-skeleton" aria-hidden="true">
          <span class="biliscript-reading-explain-card-skeleton-line is-long"></span>
          <span class="biliscript-reading-explain-card-skeleton-line is-mid"></span>
          <span class="biliscript-reading-explain-card-skeleton-line is-short"></span>
        </div>
      `
      : card.phase === "error"
        ? `
          <div class="biliscript-reading-explain-card-state is-error">${escapeHtml(card.error || "解释失败")}</div>
          <div class="biliscript-reading-explain-card-actions">
            ${
              setupClass
                ? `<button type="button" class="biliscript-reading-mini-btn is-primary" data-explain-card-action="setup">去设置</button>`
                : `<button type="button" class="biliscript-reading-mini-btn" data-explain-card-action="retry">重试</button>`
            }
          </div>
        `
        : `<div class="biliscript-reading-explain-card-answer markdown-body">${renderMarkdown(card.text)}</div>`;
  const noticeHtml = card.notice
    ? `<div class="biliscript-reading-explain-card-notice">${escapeHtml(card.notice)}</div>`
    : "";
  const showAskChat = card.phase === "ready" || (card.phase === "error" && !setupClass);
  const footerHtml = showAskChat
    ? `
      <footer class="biliscript-reading-explain-card-foot">
        <button type="button" class="biliscript-reading-mini-btn" data-explain-card-action="ask-chat">去对话追问</button>
      </footer>
    `
    : "";

  root.innerHTML = `
    <div class="biliscript-reading-explain-card-mask" data-explain-card-action="close"></div>
    <section class="biliscript-reading-explain-card-dialog" role="dialog" aria-modal="true" aria-label="解释" tabindex="-1">
      <header class="biliscript-reading-explain-card-head">
        <span class="biliscript-reading-explain-card-title">解释</span>
        <button type="button" class="biliscript-reading-explain-card-close" data-explain-card-action="close" title="关闭" aria-label="关闭解释">${renderUiIcon("close", { size: 16 })}</button>
      </header>
      <div class="biliscript-reading-explain-card-quote">${escapeHtml(card.selection)}</div>
      <div class="biliscript-reading-explain-card-content">${bodyHtml}${noticeHtml}</div>
      ${footerHtml}
    </section>
  `;

  hydrateMarkdownContent(root);

  const dialogForMotion = root.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  if (dialogForMotion) {
    if (pendingCardEnterAnimation) {
      pendingCardEnterAnimation = false;
      animateTriggerEnter({
        target: dialogForMotion,
        mask: root.querySelector<HTMLElement>(".biliscript-reading-explain-card-mask"),
        trigger: cardTriggerRect,
        fallbackOrigin: "bottom center",
        fromScale: 0.92,
        durationMs: 190
      });
    } else {
      applyElementTriggerOrigin(dialogForMotion, cardTriggerRect, "bottom center");
    }
  }

  const overlayBlocked = state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen();
  if (!overlayBlocked) {
    if (pendingInitialFocus) {
      pendingInitialFocus = false;
      focusExplainDialog();
    } else if (wasFocusInsideCard) {
      const dialog = root.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
      const matching = activeAction
        ? dialog?.querySelector<HTMLElement>(`[data-explain-card-action="${activeAction}"]:not([disabled])`) ?? null
        : null;
      if (matching && isElementFocusable(matching)) {
        matching.focus?.({ preventScroll: true });
      } else {
        focusExplainDialog();
      }
    }
  }
}

function onCardKeyDown(event: KeyboardEvent): void {
  if (!card.open) {
    return;
  }
  if (state.reader.readingSettingsExpanded || hasReaderSettingsOverlayOpen()) {
    return;
  }
  if (event.key === "Escape") {
    event.stopPropagation();
    closeReaderExplainCard();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const root = getCardRoot();
  const dialog = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  if (!dialog) {
    return;
  }
  const focusables = getDialogFocusables(dialog);
  if (focusables.length === 0) {
    event.preventDefault();
    dialog.focus?.({ preventScroll: true });
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = resolveNodeDocument(dialog).activeElement;
  if (event.shiftKey) {
    if (active === first || active === dialog || !dialog.contains(active)) {
      event.preventDefault();
      last.focus?.({ preventScroll: true });
    }
    return;
  }
  if (active === last || active === dialog || !dialog.contains(active)) {
    event.preventDefault();
    first.focus?.({ preventScroll: true });
  }
}

let boundKeyDownDoc: Document | null = null;
let stopCardHostWatch: (() => void) | null = null;

function bindCardEsc(): void {
  unbindCardEsc();
  const doc = resolveNodeDocument(getCardRoot());
  boundKeyDownDoc = doc;
  doc.addEventListener("keydown", onCardKeyDown, true);
  stopCardHostWatch = onActiveHostChange((ctx) => {
    if (!card.open) {
      unbindCardEsc();
      return;
    }
    safeRemoveListener(boundKeyDownDoc, "keydown", onCardKeyDown, true);
    boundKeyDownDoc = ctx.doc;
    ctx.doc.addEventListener("keydown", onCardKeyDown, true);
  });
}

function unbindCardEsc(): void {
  stopCardHostWatch?.();
  stopCardHostWatch = null;
  safeRemoveListener(boundKeyDownDoc, "keydown", onCardKeyDown, true);
  boundKeyDownDoc = null;
}

function startExplainRequest(): void {
  const runId = card.runId;
  card.phase = "loading";
  card.text = "";
  card.error = "";
  card.searching = false;
  card.notice = "";
  renderCard();

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  card.controller = controller;

  void (async () => {
    try {
      const provider = await resolveActiveProvider();
      const { explainSelection } = await import("../ai/explain.js");
      const optIn = await resolveWebSearchOptIn();
      if (optIn === "view-destroyed" || runId !== card.runId) {
        return;
      }
      let webSearch: WebSearchRuntime | undefined;
      if (optIn === "granted") {
        const resolved = await resolveWebSearchRuntime(controller?.signal ?? null);
        webSearch = resolved.runtime;
        if (!webSearch && resolved.notice && runId === card.runId) {
          card.notice = resolved.notice;
          renderCard();
        }
      }
      const text = await explainSelection({
        provider,
        site: state.clip.site,
        videoTitle: state.clip.title,
        selection: card.selection,
        line: card.line,
        from: card.from,
        index: card.index,
        body: getClipBody(),
        signal: controller?.signal,
        webSearch,
        onSearchStatus: (payload) => {
          if (runId !== card.runId) {
            return;
          }
          card.searching = payload.status === "searching";
          if (card.phase === "loading") {
            renderCard();
          }
        },
        onNotice: (notice) => {
          if (runId === card.runId) {
            card.notice = String(notice || "");
            renderCard();
          }
        }
      });
      if (runId !== card.runId) {
        return;
      }
      card.phase = "ready";
      card.text = text;
      card.searching = false;
      renderCard();
    } catch (error) {
      if (runId !== card.runId || isAbortedMarkerError(error)) {
        return;
      }
      logWarn("[BILISCRIPT] explain selection failed", error);
      card.phase = "error";
      card.error = getErrorMessage(error);
      card.searching = false;
      renderCard();
    }
  })();
}

function beginExplainSetup(): void {
  if (!card.open) {
    return;
  }
  const errorClass = classifyOverviewSetupError(card.error);
  if (!errorClass) {
    return;
  }
  const targetRunId = card.runId;
  const targetBvid = String(state.clip.bvid || "");
  const targetCid = String(state.clip.cid || "");
  const targetSelection = card.selection;
  const targetLine = card.line;

  void beginReaderAiSetupFlow({
    scope: "explain",
    errorClass,
    isStillValid: () =>
      card.open
      && card.runId === targetRunId
      && String(state.clip.bvid || "") === targetBvid
      && String(state.clip.cid || "") === targetCid
      && card.selection === targetSelection
      && card.line === targetLine,
    onResume: () => {
      card.runId += 1;
      startExplainRequest();
      closeReaderSettingsMode({ restoreFocus: false });
      pendingInitialFocus = false;
      focusExplainDialog();
    },
    onCancel: (reason) => {
      if (reason === "stale") {
        closeReaderSettingsMode({ restoreFocus: true });
      }
    }
  });
}

export function openReaderExplainCard(payload: ReaderExplainCardPayload): void {
  const selection = String(payload?.selection || "").trim();
  const line = String(payload?.line || "").trim();
  if (!selection) {
    return;
  }
  const root = getCardRoot();
  const pop = activeById(ids.readingExplainPop);
  const popBtn = pop?.querySelector<HTMLElement>(".biliscript-reading-explain-btn") ?? null;
  const subtitleList = activeById(ids.readingSubtitleList);
  const nextIndex = Number.isFinite(Number(payload?.index)) ? Number(payload.index) : -1;
  const fallbackItem = nextIndex >= 0 ? findSubtitleItem(subtitleList, nextIndex) : null;
  if (root) {
    cancelTriggerExit(root);
  }
  const popRect = pop && !pop.hidden ? captureTriggerRect(popBtn || pop) : null;
  cardTriggerRect = popRect ?? captureTriggerRect(fallbackItem) ?? cardTriggerRect;
  if (pop) {
    pop.hidden = true;
    delete pop.dataset.itemIndex;
  }
  if (!card.open) {
    const doc = resolveNodeDocument(root ?? pop ?? subtitleList);
    const active = isHtmlElement(doc.activeElement) ? doc.activeElement : null;
    const fromCardOrPop = Boolean(active && ((root && root.contains(active)) || (pop && pop.contains(active))));
    returnFocusEl =
      active && active.isConnected && !fromCardOrPop && active !== doc.body && active !== doc.documentElement
        ? active
        : fallbackItem;
    pendingCardEnterAnimation = true;
  }
  pendingInitialFocus = true;
  invalidateReaderSetupFlows("explain");
  card.controller?.abort();
  card.runId += 1;
  card.open = true;
  card.selection = selection;
  card.line = line || selection;
  card.from = Number(payload?.from) || 0;
  card.index = nextIndex;
  bindCardEsc();
  startExplainRequest();
}

export function closeReaderExplainCard(options?: { restoreFocus?: boolean }): void {
  if (!card.open) {
    return;
  }
  const shouldRestoreFocus = options?.restoreFocus !== false;
  const savedIndex = card.index;
  const targetToRestore = shouldRestoreFocus ? returnFocusEl : null;
  returnFocusEl = null;
  pendingInitialFocus = false;
  invalidateReaderSetupFlows("explain");
  unbindCardEsc();
  card.controller?.abort();
  card.controller = null;
  card.runId += 1;
  card.open = false;
  card.text = "";
  card.error = "";
  card.searching = false;
  card.notice = "";
  pendingCardEnterAnimation = false;
  const savedTriggerRect = cardTriggerRect;
  cardTriggerRect = null;
  const root = getCardRoot();
  const dialog = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-dialog");
  const mask = root?.querySelector<HTMLElement>(".biliscript-reading-explain-card-mask") ?? null;
  if (root && dialog) {
    animateTriggerExit({
      target: dialog,
      host: root,
      mask,
      trigger: savedTriggerRect,
      fallbackOrigin: "bottom center",
      toScale: 0.93,
      durationMs: 130,
      onFinish: () => {
        if (!card.open) {
          renderCard();
        }
      }
    });
  } else {
    renderCard();
  }
  if (shouldRestoreFocus && !state.reader.readingSettingsExpanded && !hasReaderSettingsOverlayOpen()) {
    const subtitleList = activeById(ids.readingSubtitleList);
    const fallbackItem = savedIndex >= 0 ? findSubtitleItem(subtitleList, savedIndex) : null;
    const candidate =
      targetToRestore && isElementFocusable(targetToRestore)
        ? targetToRestore
        : fallbackItem && isElementFocusable(fallbackItem)
          ? fallbackItem
          : null;
    candidate?.focus?.({ preventScroll: true });
  }
}

export function onReaderExplainCardClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-explain-card-action]");
  if (!target) {
    return;
  }
  event.stopPropagation();
  const action = target.dataset.explainCardAction;
  if (action === "close") {
    closeReaderExplainCard();
    return;
  }
  if (action === "retry") {
    if (card.open) {
      card.runId += 1;
      startExplainRequest();
    }
    return;
  }
  if (action === "setup") {
    beginExplainSetup();
    return;
  }
  if (action === "ask-chat") {
    const explanation = card.phase === "ready" && card.text.trim() ? card.text.trim() : undefined;
    setPendingExplainIntent({
      from: card.from,
      content: card.line,
      selection: card.selection,
      ...(explanation ? { explanation } : {}),
      createdAt: Date.now()
    });
    closeReaderExplainCard({ restoreFocus: false });
    void activateScriptTab("chat");
  }
}

export function isReaderExplainCardOpen(): boolean {
  return card.open;
}
