// reader/chat-lists.ts — 对话 tab 两列表渲染（建议/历史）（PR5 自
// extension/pages/sidepanel-lists.ts 重建；原 sidepanel 孪生模块已随侧边栏
// 形态删除，本文件是对话 tab 列表渲染的唯一实现，逻辑改动不再需要与孪生同步，
// 行为契约由 tests/reader/chat-lists.test.ts 钉住。DOM 壳：元素经 deps 注入
// reader 的 readingChat* id 节点，class 名沿用 .chat-*（样式段在 styles/
// reader-chat.css，随对话域按需装载，token 化两主题））。
//
// 依赖方向（无环）：共享可变状态（../chat/chat-state）与 ai/conversation 纯辅助
// 直接 import；DOM 元素、会话动作、布局回调、建议点击发送、suggestionsNode
// 单例钩子经工厂 deps 注入。本模块不 import 组合根。
import {
  doesConversationMatchCurrentContext,
  doesTabMatchContextUrl,
  formatConversationTimestamp,
  buildConversationTitleDisplay
} from "../ai/conversation.js";
import { escapeHtml } from "../shared/string-utils.js";
import { resolveInitialQuickPrompts } from "../chat/quick-prompts.js";
import { readCachedQuickPrompts } from "../chat/quick-prompt-cache.js";
import { chatSessionState } from "../chat/chat-state.js";

export interface CreateReaderChatListsDeps {
  historyList: HTMLElement;
  historyClearBtn: HTMLButtonElement | null;
  input: HTMLTextAreaElement;
  // 会话动作（conversation-store 实例的窄接口）
  applyById: (id: string) => void;
  deleteById: (id: string) => Promise<void>;
  // 布局 / 发送回调（组合根提供）
  autosizeInput: () => void;
  onSuggestionClick: (prompt: string) => void;
  // suggestionsNode 单例 getter（组合根持有）
  getSuggestionsNode: () => HTMLElement | null;
  // 惰性互引（组装点以箭头函数接线，回调执行时实例已存在）
  hideHistoryPopover: () => void;
}

export interface ReaderChatLists {
  renderSuggestions: () => void;
  renderHistoryList: () => void;
}

export function createReaderChatLists(deps: CreateReaderChatListsDeps): ReaderChatLists {
  const { historyList, historyClearBtn, input, getSuggestionsNode } = deps;

  function renderSuggestions(): void {
    const suggestionsNode = getSuggestionsNode();
    if (!suggestionsNode) {
      return;
    }
    if (!chatSessionState.contextData || !chatSessionState.providers.length || chatSessionState.chatHistory.length || chatSessionState.contextData.isVideoContext === false) {
      suggestionsNode.innerHTML = "";
      return;
    }
    // 三档取用：设置里的自定义问题 → 本视频的生成结果（预热缓存）→ 固定三条
    // 兜底（生成不可用时的诚实降级，见 chat/quick-prompts.ts）。
    const prompts = resolveInitialQuickPrompts(
      chatSessionState.aiPrefs.aiInitialQuickPrompts,
      readCachedQuickPrompts(chatSessionState.currentContextKey)
    );
    suggestionsNode.innerHTML = prompts
      .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
      .join("");
    suggestionsNode.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        input.value = btn.textContent || "";
        deps.autosizeInput();
        deps.onSuggestionClick(btn.textContent || "");
      });
    });
  }

  function renderHistoryList(): void {
    if (!historyList) {
      return;
    }
    if (historyClearBtn) {
      historyClearBtn.hidden = chatSessionState.savedConversations.length === 0;
    }
    if (!chatSessionState.savedConversations.length) {
      historyList.innerHTML = '<span class="chat-history-empty">还没有历史对话</span>';
      return;
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
        const isActive = conversation.id === chatSessionState.currentConversationId;
        const isLiveMatch = Boolean(
          !isActive &&
          canHighlightLiveMatches &&
          doesConversationMatchCurrentContext(conversation, liveVideoRef, chatSessionState.liveContextKey)
        );
        const metaText = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
        const titleDisplay = buildConversationTitleDisplay(conversation.title, 30);
        return `
          <div class="chat-history-item ${isActive ? "is-active" : ""} ${isLiveMatch ? "is-live-match" : ""}" data-id="${escapeHtml(conversation.id)}">
            <button type="button" class="chat-history-open" data-id="${escapeHtml(conversation.id)}">
              <span class="chat-history-title" title="${escapeHtml(conversation.title)}">
                <span class="chat-history-title-main">${escapeHtml(titleDisplay.main)}</span>
                ${titleDisplay.suffix ? `<span class="chat-history-title-suffix">${escapeHtml(titleDisplay.suffix)}</span>` : ""}
              </span>
              <span class="chat-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
            </button>
            <button type="button" class="chat-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="删除历史对话">×</button>
          </div>
        `;
      })
      .join("");

    historyList.querySelectorAll(".chat-history-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = String(btn.getAttribute("data-id") || "");
        deps.applyById(id);
        deps.hideHistoryPopover();
      });
    });

    historyList.querySelectorAll(".chat-history-remove").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const id = String(btn.getAttribute("data-id") || "");
        await deps.deleteById(id);
      });
    });
  }

  return { renderSuggestions, renderHistoryList };
}
