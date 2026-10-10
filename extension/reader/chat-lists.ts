// reader/chat-lists.ts — 对话 tab 两列表渲染（建议/历史）（PR5 自
// extension/pages/sidepanel-lists.ts 重建；原 sidepanel 孪生模块已随侧边栏
// 形态删除，本文件是对话 tab 列表渲染的唯一实现，逻辑改动不再需要与孪生同步，
// 行为契约由 tests/reader/chat-lists.test.ts 钉住。DOM 壳：元素经 deps 注入
// reader 的 readingChat* id 节点，class 名沿用 .chat-*（样式段在 styles/
// reader-chat.css，随对话域按需装载，token 化两主题））。
//
// 依赖方向（无环）：共享可变状态（../chat/chat-state + ../core/state 的进程内
// clip）与 ai/conversation 纯辅助直接 import；DOM 元素、会话动作、布局回调、
// 建议点击发送、suggestionsNode 单例钩子经工厂 deps 注入。本模块不 import 组合根。
import {
  buildContextKey,
  doesConversationMatchCurrentContext,
  doesTabMatchContextUrl,
  formatConversationTimestamp,
  buildConversationTitleDisplay
} from "../ai/conversation.js";
import { escapeHtml } from "../shared/string-utils.js";
import { resolveInitialQuickPrompts } from "../chat/quick-prompts.js";
import { readCachedQuickPrompts } from "../chat/quick-prompt-cache.js";
import { chatSessionState } from "../chat/chat-state.js";
import { extractBvid } from "../bilibili/video-id-shared.js";
import { state } from "../core/state.js";

export interface CreateReaderChatListsDeps {
  historyList: HTMLElement;
  historyClearBtn: HTMLButtonElement | null;
  input: HTMLTextAreaElement;
  // 会话动作（conversation-store 实例的窄接口）
  // applyById 由组合根包一层 C′ 接缝：在途回合先由 chat-runtime 体面停流落盘
  //（settleTurn）再切换，故其兑现晚于本次点击——不在途时同一 tick 内完成。
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

// 空态欢迎区图标（✦ sparkles，24 视框 / stroke 1.8 / currentColor）：纯装饰，
// svg 自带 aria-hidden；图标资产本模块自带，不引外部资源。
const HERO_ICON_SVG =
  '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l1.84 4.96 4.96 1.84-4.96 1.84L12 17.2l-1.84-4.96L5.2 10.4l4.96-1.84L12 3.6z"/></svg>';

export function createReaderChatLists(deps: CreateReaderChatListsDeps): ReaderChatLists {
  const { historyList, historyClearBtn, input, getSuggestionsNode } = deps;

  // ===== 建议区缓存键：当前页视频身份（读进程内 clip） =====
  //
  // 为什么不用 chatSessionState.currentContextKey：那个键是「对话上下文快照」的
  // 投影，SPA 换片时 URL 变化同步可能早于 clip 重置（重置链在动态装载之后），
  // 上下文按旧 clip 装配且此后不再对账——照它读缓存，就会把上一个视频生成的问题
  // 显示在新视频上（用户报障：新视频转写中，三个建议还是上一个视频的）。
  //
  // 缓存写方 reader/quick-prompts.ts 的预热键也取自 state.clip 的
  // buildContextKey（同一函数、同一来源），本函数让读写对称：键相同 ⇔ 同一视频。
  // 两处返回空键（不取生成结果、回落固定三条默认问题）：
  //   - 字幕体为空：转写/抓取未就绪，此视频不可能有生成结果；就算缓存里有同键
  //     的旧结果（同视频重看场景），此刻也不该拿它当「当前视频的问题」；
  //   - clip 的 bvid 与地址不符：clip 还停在上一个视频（换片竞态窗口）。
  function currentPageVideoKey(): string {
    const clip = state.clip;
    if (!clip.subtitleBody?.length) {
      return "";
    }
    const bvid = String(clip.bvid || "").trim();
    if (!bvid || bvid !== extractBvid(location.href)) {
      return "";
    }
    return buildContextKey({ bvid, cid: clip.cid, aid: clip.aid });
  }

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
      readCachedQuickPrompts(currentPageVideoKey())
    );
    // 空态欢迎区（「居中开场」）：✦ 图标 + 引导语在上，建议 chips 居中于
    // 消息区；有对话时本函数走上方清空分支，欢迎区不出现。
    suggestionsNode.innerHTML =
      `<div class="chat-hero">` +
      `<span class="chat-hero-icon">${HERO_ICON_SVG}</span>` +
      `<p class="chat-hero-title">围绕这期视频，问点什么</p>` +
      `<div class="chat-hero-sugs">` +
      prompts
        .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
        .join("") +
      `</div></div>`;
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
