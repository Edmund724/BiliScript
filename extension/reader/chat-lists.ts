import {
  doesConversationMatchCurrentContext,
  doesTabMatchContextUrl,
  formatConversationTimestamp,
  buildConversationTitleDisplay
} from "../ai/conversation.js";
import { isElementNode } from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";
import { chatSessionState } from "../chat/chat-state.js";
import { readConversationById } from "../chat/conversation-storage.js";
import { isLiveTextToolSummary, type ConversationSummaryItem } from "../chat/conversation-types.js";
import { detectSiteFromUrl, normalizeSiteId, type SiteId } from "../shared/site.js";
import { isLiveTextToolHistoryEntry, type LiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import type { LiveTextToolRecord } from "../live/live-text-tool-records.js";
import { renderLiveTextToolRecordHtml } from "./chat-live-text-records.js";
import { hydrateMarkdownContent } from "../ui/markdown.js";
import type { ConversationDeletion } from "../chat/conversation-store.js";

export interface CreateReaderChatListsDeps {
  historyList: HTMLElement;
  historyClearBtn: HTMLButtonElement | null;
  applyById: (id: string) => Promise<boolean | void> | boolean | void;
  deleteById: (id: string) => Promise<ConversationDeletion | null>;
  isTurnActive: () => boolean;
  confirmDeleteCurrent: (message: string) => boolean | Promise<boolean>;
  startNewConversation: () => Promise<boolean> | boolean;
  hideHistoryPopover: () => void;
  settleTurn?: () => Promise<void> | undefined;
  loadLiveHistoryById?: (id: string) => Promise<LiveTextToolHistoryEntry | null>;
}

export interface ReaderChatLists {
  renderHistoryList: (options?: { revealCurrent?: boolean }) => void;
  settlePendingDeletion: () => void;
  cancelPendingSwitch: () => void;
  exitLiveHistoryDetail: () => boolean;
  resetLiveHistoryDetail: () => void;
}

export function createReaderChatLists(deps: CreateReaderChatListsDeps): ReaderChatLists {
  const { historyList, historyClearBtn } = deps;
  const loadLiveHistoryById =
    deps.loadLiveHistoryById ??
    (async (id: string): Promise<LiveTextToolHistoryEntry | null> => {
      const full = await readConversationById(id);
      return full && isLiveTextToolHistoryEntry(full) ? full : null;
    });

  function resolveConversationSite(conversation: ConversationSummaryItem): SiteId {
    if (conversation.site) {
      return normalizeSiteId(conversation.site);
    }
    if (!isLiveTextToolSummary(conversation) && conversation.contextRef?.site) {
      return normalizeSiteId(conversation.contextRef.site);
    }
    const contextKey = String(conversation.contextKey || "").trim();
    if (contextKey.startsWith("video:youtube:")) {
      return "youtube";
    }
    const rawUrl =
      (!isLiveTextToolSummary(conversation) ? conversation.contextRef?.url : "") ||
      conversation.contextUrl;
    return normalizeSiteId(detectSiteFromUrl(rawUrl));
  }

  function formatSiteBadgeLabel(site: SiteId): string {
    return site === "youtube" ? "YouTube" : "B 站";
  }

  let openLiveHistoryId: string | null = null;
  let openLiveHistoryRecords: LiveTextToolRecord[] | null = null;
  let liveDetailSeq = 0;
  let liveHistoryReturnScrollTop = 0;
  let pendingSwitchId: string | null = null;
  let switchSeq = 0;
  let pendingDeletion: { id: string; undo: () => Promise<void>; timer: number } | null = null;
  let deletionSeq = 0;
  let lastCurrentId = "";

  function focusHistoryOpen(id: string): void {
    historyList.querySelectorAll<HTMLButtonElement>(".chat-history-open").forEach((button) => {
      if (button.dataset.id === id) button.focus({ preventScroll: true });
    });
  }

  function settlePendingDeletion(): void {
    deletionSeq += 1;
    if (!pendingDeletion) {
      return;
    }
    window.clearTimeout(pendingDeletion.timer);
    pendingDeletion = null;
    renderHistoryList();
  }

  function undoHtml(): string {
    if (!pendingDeletion) {
      return "";
    }
    return `<div class="chat-history-undo" role="status">
      <span>已删除历史记录</span>
      <button type="button" class="chat-history-undo-button">撤销</button>
    </div>`;
  }

  function cancelPendingSwitch(): void {
    switchSeq += 1;
    if (historyClearBtn) {
      historyClearBtn.disabled = false;
    }
    if (!pendingSwitchId) {
      return;
    }
    pendingSwitchId = null;
    renderHistoryList();
  }

  function clearOpenLiveHistoryState(): void {
    liveDetailSeq += 1;
    openLiveHistoryId = null;
    openLiveHistoryRecords = null;
  }

  function exitLiveHistoryDetail(): boolean {
    if (!openLiveHistoryId) {
      return false;
    }
    const returnId = openLiveHistoryId;
    clearOpenLiveHistoryState();
    renderHistoryList();
    historyList.scrollTop = liveHistoryReturnScrollTop;
    focusHistoryOpen(returnId);
    return true;
  }

  function resetLiveHistoryDetail(): void {
    if (!openLiveHistoryId && openLiveHistoryRecords === null) {
      return;
    }
    clearOpenLiveHistoryState();
    liveHistoryReturnScrollTop = 0;
    renderHistoryList();
  }

  function openConversation(id: string): void {
    if (pendingSwitchId) {
      return;
    }
    const conversation = chatSessionState.savedConversations.find((item) => item.id === id);
    if (isLiveTextToolSummary(conversation)) {
      liveHistoryReturnScrollTop = historyList.scrollTop;
      openLiveHistoryId = id;
      openLiveHistoryRecords = null;
      const seq = ++liveDetailSeq;
      renderHistoryList();
      historyList.scrollTop = 0;
      historyList.querySelector<HTMLButtonElement>(".chat-live-history-back")?.focus({ preventScroll: true });
      void Promise.resolve(loadLiveHistoryById(id))
        .then((hydrated) => {
          if (seq !== liveDetailSeq || openLiveHistoryId !== id) {
            return;
          }
          openLiveHistoryRecords = hydrated && isLiveTextToolHistoryEntry(hydrated) ? hydrated.records : [];
          renderHistoryList();
          historyList.scrollTop = 0;
          historyList.querySelector<HTMLButtonElement>(".chat-live-history-back")?.focus({ preventScroll: true });
        })
        .catch(() => {
          if (seq !== liveDetailSeq || openLiveHistoryId !== id) {
            return;
          }
          openLiveHistoryRecords = [];
          renderHistoryList();
        });
      return;
    }
    if (!conversation) {
      return;
    }
    clearOpenLiveHistoryState();
    pendingSwitchId = id;
    const seq = ++switchSeq;
    if (historyClearBtn) {
      historyClearBtn.disabled = true;
    }
    const completeSwitch = () => {
      if (seq !== switchSeq || pendingSwitchId !== id) {
        return;
      }
      pendingSwitchId = null;
      if (historyClearBtn) {
        historyClearBtn.disabled = false;
      }
      renderHistoryList();
      deps.hideHistoryPopover();
    };
    const abortSwitch = () => {
      if (seq !== switchSeq || pendingSwitchId !== id) {
        return;
      }
      pendingSwitchId = null;
      if (historyClearBtn) {
        historyClearBtn.disabled = false;
      }
      renderHistoryList();
      focusHistoryOpen(id);
    };
    const isPromiseLike = (v: unknown): v is Promise<unknown> =>
      Boolean(v && typeof (v as { then?: unknown }).then === "function");
    const settling = deps.settleTurn?.();
    if (settling) {
      renderHistoryList();
      focusHistoryOpen(id);
      settling.then(
        () => {
          if (seq !== switchSeq || pendingSwitchId !== id) {
            return;
          }
          const switching = deps.applyById(id);
          if (!isPromiseLike(switching)) {
            completeSwitch();
            return;
          }
          switching.then(completeSwitch, abortSwitch);
        },
        abortSwitch
      );
      return;
    }
    const switching = deps.applyById(id);
    if (!isPromiseLike(switching)) {
      pendingSwitchId = null;
      if (historyClearBtn) {
        historyClearBtn.disabled = false;
      }
      renderHistoryList();
      deps.hideHistoryPopover();
      return;
    }
    renderHistoryList();
    focusHistoryOpen(id);
    switching.then(completeSwitch, abortSwitch);
  }

  async function deleteConversation(id: string): Promise<void> {
    if (pendingSwitchId) {
      return;
    }
    if (id === chatSessionState.currentConversationId && deps.isTurnActive()) {
      const confirmed = await deps.confirmDeleteCurrent("正在生成的回答将被丢弃。确定删除当前会话吗？");
      if (!confirmed) {
        return;
      }
    }
    const ids = chatSessionState.savedConversations.map((item) => item.id);
    const index = ids.indexOf(id);
    if (index < 0) {
      return;
    }
    const nextFocusId = ids[index + 1] ?? ids[index - 1] ?? "";
    clearOpenLiveHistoryState();
    settlePendingDeletion();
    const seq = ++deletionSeq;
    const deletion = await deps.deleteById(id);
    if (!deletion || seq !== deletionSeq) {
      return;
    }
    const record = {
      id,
      undo: deletion.undo,
      timer: 0
    };
    record.timer = window.setTimeout(() => {
      if (pendingDeletion !== record) return;
      pendingDeletion = null;
      renderHistoryList();
    }, 6000);
    pendingDeletion = record;
    renderHistoryList();
    if (nextFocusId) {
      focusHistoryOpen(nextFocusId);
    } else {
      historyList.querySelector<HTMLButtonElement>(".chat-history-undo-button, .chat-history-start-new")?.focus({ preventScroll: true });
    }
  }

  function bindHistoryActions(): void {
    historyList.querySelectorAll<HTMLElement>(".chat-history-item").forEach((item) => {
      item.addEventListener("click", (event) => {
        if (isElementNode(event.target) && event.target.closest(".chat-history-remove")) return;
        event.stopPropagation();
        openConversation(String(item.dataset.id || ""));
      });
    });
    historyList.querySelectorAll(".chat-history-remove").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteConversation(String((button as HTMLElement).dataset.id || ""));
      });
    });
    historyList.querySelector<HTMLButtonElement>(".chat-history-undo-button")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (pendingSwitchId) return;
      const record = pendingDeletion;
      if (!record) return;
      window.clearTimeout(record.timer);
      pendingDeletion = null;
      (event.currentTarget as HTMLButtonElement).disabled = true;
      clearOpenLiveHistoryState();
      await record.undo();
      renderHistoryList();
      focusHistoryOpen(record.id);
    });
    historyList.querySelector<HTMLButtonElement>(".chat-history-start-new")?.addEventListener("click", async (event) => {
      event.stopPropagation();
      settlePendingDeletion();
      if ((await deps.startNewConversation()) === false) {
        return;
      }
      deps.hideHistoryPopover();
    });
  }

  function renderHistoryList({ revealCurrent = false }: { revealCurrent?: boolean } = {}): void {
    const currentId = chatSessionState.currentConversationId || "";
    const currentAppeared = Boolean(currentId) && currentId !== lastCurrentId;
    lastCurrentId = currentId;
    const selected = chatSessionState.savedConversations.find((item) => item.id === openLiveHistoryId);
    const inLiveDetail = isLiveTextToolSummary(selected);
    if (historyClearBtn) {
      historyClearBtn.hidden = chatSessionState.savedConversations.length === 0 || inLiveDetail;
      historyClearBtn.disabled = Boolean(pendingSwitchId);
    }
    if (pendingSwitchId) {
      historyList.setAttribute("aria-busy", "true");
    } else {
      historyList.removeAttribute("aria-busy");
    }
    if (!chatSessionState.savedConversations.length) {
      clearOpenLiveHistoryState();
      historyList.innerHTML = `<div class="chat-history-empty-state">
        <span class="chat-history-empty">还没有历史记录</span>
        <button type="button" class="chat-history-start-new">开始新会话</button>
      </div>${undoHtml()}`;
      bindHistoryActions();
      return;
    }

    if (inLiveDetail && isLiveTextToolSummary(selected)) {
      const records = openLiveHistoryRecords;
      const count = records !== null ? records.length : selected.recordCount;
      const metaText = `${formatConversationTimestamp(selected.updatedAt || selected.createdAt)} · ${count} 条记录`;
      const bodyHtml =
        records === null
          ? '<div class="chat-history-empty">正在加载伴看记录…</div>'
          : records.map((record) => renderLiveTextToolRecordHtml(record, { readOnly: true })).join("");
      historyList.innerHTML = `
        <section class="chat-live-history-detail" aria-label="伴看记录">
          <button type="button" class="chat-live-history-back">返回历史列表</button>
          <div class="chat-live-history-heading">
            <span class="chat-live-history-title">${escapeHtml(selected.title)}</span>
            <span class="chat-live-history-meta">${escapeHtml(metaText)}</span>
          </div>
          <div class="chat-live-history-records">
            ${bodyHtml}
          </div>
        </section>${undoHtml()}`;
      if (records !== null) {
        hydrateMarkdownContent(historyList);
      }
      historyList.querySelector(".chat-live-history-back")?.addEventListener("click", (event) => {
        event.stopPropagation();
        exitLiveHistoryDetail();
      });
      bindHistoryActions();
      return;
    }
    if (openLiveHistoryId !== null || openLiveHistoryRecords !== null) {
      clearOpenLiveHistoryState();
    }

    const liveVideoRef = chatSessionState.liveContextData?.isVideoContext ? chatSessionState.liveContextData : null;
    const canHighlightLiveMatches = Boolean(
      liveVideoRef &&
      chatSessionState.currentConversationMeta?.pinnedContext &&
      chatSessionState.currentConversationMeta?.contextUrl &&
      !doesTabMatchContextUrl(liveVideoRef.url || chatSessionState.liveTabUrl, chatSessionState.currentConversationMeta.contextUrl || "")
    );

    historyList.innerHTML = chatSessionState.savedConversations
      .map((conversation) => {
        const liveEntry = isLiveTextToolSummary(conversation) ? conversation : null;
        const isActive = !liveEntry && conversation.id === chatSessionState.currentConversationId;
        const isLiveMatch = Boolean(
          !liveEntry &&
          !isActive &&
          canHighlightLiveMatches &&
          doesConversationMatchCurrentContext(conversation, liveVideoRef, chatSessionState.liveContextKey)
        );
        const isSwitching = conversation.id === pendingSwitchId;
        const timestamp = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
        const metaText = isSwitching ? "正在保存当前回答…" : liveEntry ? `${timestamp} · ${liveEntry.recordCount} 条记录` : timestamp;
        const site = resolveConversationSite(conversation);
        const siteLabel = formatSiteBadgeLabel(site);
        const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
        return `
          <div class="chat-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""} ${isSwitching ? "is-switching" : ""}" data-id="${escapeHtml(conversation.id)}" ${isSwitching ? 'aria-busy="true"' : ""}>
            <button type="button" class="chat-history-open" data-id="${escapeHtml(conversation.id)}" ${isActive ? 'aria-current="true"' : ""} ${pendingSwitchId ? 'aria-disabled="true"' : ""}>
              <span class="chat-history-title" title="${escapeHtml(conversation.title)}">
                ${isActive ? '<span class="chat-history-current">当前</span>' : ""}
                ${liveEntry ? '<span class="chat-history-kind">伴看记录</span>' : ""}
                <span class="chat-history-title-main">${escapeHtml(titleDisplay.main)}</span>
                ${titleDisplay.suffix ? `<span class="chat-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
              </span>
              <span class="chat-history-meta-row">
                <span class="chat-history-site" data-site="${escapeHtml(site)}">${escapeHtml(siteLabel)}</span>
                <span class="chat-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
              </span>
            </button>
            <button type="button" class="chat-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="${liveEntry ? "删除伴看记录" : "删除历史对话"}" ${pendingSwitchId ? 'aria-disabled="true"' : ""}>×</button>
          </div>
        `;
      })
      .join("") + undoHtml();
    bindHistoryActions();
    if ((revealCurrent || currentAppeared) && !historyList.closest("[hidden], [inert]")) {
      historyList.querySelector<HTMLElement>(".chat-history-item.is-active .chat-history-open")?.scrollIntoView({ block: "nearest" });
    }
  }

  return {
    renderHistoryList,
    settlePendingDeletion,
    cancelPendingSwitch,
    exitLiveHistoryDetail,
    resetLiveHistoryDetail
  };
}
