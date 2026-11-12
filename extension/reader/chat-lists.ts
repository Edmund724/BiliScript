// reader/chat-lists.ts — 对话 tab 两列表渲染（建议/历史）（PR5 自
// extension/pages/sidepanel-lists.ts 重建；原 sidepanel 孪生模块已随侧边栏
// 形态删除，本文件是对话 tab 列表内容决策的唯一实现，逻辑改动不再需要与孪生
// 同步，行为契约由 tests/reader/chat-lists.test.ts 钉住。DOM 壳：元素经 deps
// 注入 reader 的 readingChat* id 节点，class 名沿用 .chat-*（样式段在 styles/
// reader-chat.css，随对话域按需装载，token 化两主题））。
//
// 分工：建议区节点（.chat-suggestions）的建立/写入/摘除全在属主
//（./chat-suggestions-slot），本模块只决定「该显示哪些问题」并按在场与否对账
// 重渲；chip 的点击行为（填输入框 + 发送）也归属主的 onPick，本模块不碰输入框。
//
// 依赖方向（无环）：共享可变状态（../chat/chat-state + ../core/state 的进程内
// clip）与 ai/conversation 纯辅助直接 import；DOM 元素、会话动作、建议区属主经
// 工厂 deps 注入。本模块不 import 组合根。
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
import type { ChatSuggestionsSlot } from "./chat-suggestions-slot.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import { renderLiveTextToolRecordHtml } from "./chat-live-text-records.js";
import { hydrateMarkdownContent } from "../ui/markdown.js";
import type { ConversationDeletion } from "../chat/conversation-store.js";

export interface CreateReaderChatListsDeps {
  historyList: HTMLElement;
  historyClearBtn: HTMLButtonElement | null;
  // applyById 只在在途回合需要 settleTurn 时返回 Promise；空闲切换保持同步完成。
  applyById: (id: string) => Promise<void> | void;
  deleteById: (id: string) => Promise<ConversationDeletion | null>;
  isTurnActive: () => boolean;
  confirmDeleteCurrent: (message: string) => boolean | Promise<boolean>;
  // true = 新会话已建立（可以退出历史并聚焦输入框）；false = 确认被取消。
  startNewConversation: () => Promise<boolean> | boolean;
  // 建议区属主（render / isPresent）：列表只提交内容，节点在场与否由属主回答
  suggestions: ChatSuggestionsSlot;
  // 惰性互引（组装点以箭头函数接线，回调执行时实例已存在）
  hideHistoryPopover: () => void;
}

export interface ReaderChatLists {
  renderSuggestions: () => void;
  renderHistoryList: (options?: { revealCurrent?: boolean }) => void;
  settlePendingDeletion: () => void;
}

// 空态欢迎区图标与建议 chip 的 DOM 均在建议区属主（./chat-suggestions-slot）里。

export function createReaderChatLists(deps: CreateReaderChatListsDeps): ReaderChatLists {
  const { historyList, historyClearBtn } = deps;

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
    // 建议区不在场（发送受理撤除 / 历史回放清场）→ 不重建：本函数是对账重渲，
    // 建立建议区是消息区清场路径的事（属主的 render 负责补齐节点）。
    if (!deps.suggestions.isPresent()) {
      return;
    }
    if (!chatSessionState.contextData || !chatSessionState.providers.length || chatSessionState.chatHistory.length || chatSessionState.contextData.isVideoContext === false) {
      deps.suggestions.render([]);
      return;
    }
    // 三档取用：设置里的自定义问题 → 本视频的生成结果（预热缓存）→ 固定三条
    // 兜底（生成不可用时的诚实降级，见 chat/quick-prompts.ts）。
    deps.suggestions.render(
      resolveInitialQuickPrompts(
        chatSessionState.aiPrefs.aiInitialQuickPrompts,
        readCachedQuickPrompts(currentPageVideoKey())
      )
    );
  }

  // 历史事务（跨重渲存活）：切换单飞（pendingSwitchId，settleTurn 落定后才退出
  // 历史页）；删除撤销（pendingDeletion，一次性 6 秒计时）；settlePendingDeletion
  // 是离开历史、换视频、关闭面板与新建会话共用的结算口。
  let openLiveHistoryId: string | null = null;
  // 取消返回（伴看详情 → 历史列表）恢复进入详情前的列表滚动位置。
  let liveHistoryReturnScrollTop = 0;
  let pendingSwitchId: string | null = null;
  let pendingDeletion: { id: string; undo: () => Promise<void>; timer: number } | null = null;
  // 删除请求序号：连续删除时只有最后一次的落定结果能占用撤销条与焦点，
  // 先发后至的旧删除不得覆盖。
  let deletionSeq = 0;
  // 上次渲染时的当前会话：身份晚于首次渲染落定时，重渲同样要定位到当前项。
  let lastCurrentId = "";

  function focusHistoryOpen(id: string): void {
    historyList.querySelectorAll<HTMLButtonElement>(".chat-history-open").forEach((button) => {
      if (button.dataset.id === id) button.focus({ preventScroll: true });
    });
  }

  function settlePendingDeletion(): void {
    // 事务边界：在途删除的续体随之作废（落定后不再复活撤销条/抢焦点）。
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

  function openConversation(id: string): void {
    if (pendingSwitchId) {
      return;
    }
    const conversation = chatSessionState.savedConversations.find((item) => item.id === id);
    if (isLiveTextToolHistoryEntry(conversation)) {
      liveHistoryReturnScrollTop = historyList.scrollTop;
      openLiveHistoryId = id;
      renderHistoryList();
      historyList.scrollTop = 0;
      historyList.querySelector<HTMLButtonElement>(".chat-live-history-back")?.focus();
      return;
    }
    if (!conversation) {
      return;
    }
    openLiveHistoryId = null;
    pendingSwitchId = id;
    const switching = deps.applyById(id);
    if (!switching) {
      pendingSwitchId = null;
      renderHistoryList();
      deps.hideHistoryPopover();
      return;
    }
    renderHistoryList();
    // 重渲换了节点：把键盘焦点留在正在保存的目标行（aria-disabled 仍可聚焦），
    // 落定后才交给 hideHistoryPopover 转到输入框。
    focusHistoryOpen(id);
    switching.then(
      () => {
        if (pendingSwitchId !== id) return;
        pendingSwitchId = null;
        renderHistoryList();
        deps.hideHistoryPopover();
      },
      () => {
        if (pendingSwitchId !== id) return;
        pendingSwitchId = null;
        renderHistoryList();
        focusHistoryOpen(id);
      }
    );
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
    openLiveHistoryId = null;
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
      historyList.querySelector<HTMLButtonElement>(".chat-history-undo-button, .chat-history-start-new")?.focus();
    }
  }

  function bindHistoryActions(): void {
    historyList.querySelectorAll<HTMLElement>(".chat-history-item").forEach((item) => {
      item.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".chat-history-remove")) return;
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
      // 撤销从伴看详情里也可见：恢复后回列表，把焦点还给被恢复的条目。
      openLiveHistoryId = null;
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
    if (historyClearBtn) {
      historyClearBtn.hidden = chatSessionState.savedConversations.length === 0;
    }
    if (pendingSwitchId) {
      historyList.setAttribute("aria-busy", "true");
    } else {
      historyList.removeAttribute("aria-busy");
    }
    if (!chatSessionState.savedConversations.length) {
      openLiveHistoryId = null;
      historyList.innerHTML = `<div class="chat-history-empty-state">
        <span class="chat-history-empty">还没有历史记录</span>
        <button type="button" class="chat-history-start-new">开始新会话</button>
      </div>${undoHtml()}`;
      bindHistoryActions();
      return;
    }

    const selected = chatSessionState.savedConversations.find((item) => item.id === openLiveHistoryId);
    if (isLiveTextToolHistoryEntry(selected)) {
      const metaText = `${formatConversationTimestamp(selected.updatedAt || selected.createdAt)} · ${selected.records.length} 条记录`;
      historyList.innerHTML = `
        <section class="chat-live-history-detail" aria-label="伴看记录">
          <button type="button" class="chat-live-history-back">返回历史列表</button>
          <div class="chat-live-history-heading">
            <span class="chat-live-history-title">${escapeHtml(selected.title)}</span>
            <span class="chat-live-history-meta">${escapeHtml(metaText)}</span>
          </div>
          <div class="chat-live-history-records">
            ${selected.records.map((record) => renderLiveTextToolRecordHtml(record, { readOnly: true })).join("")}
          </div>
        </section>${undoHtml()}`;
      hydrateMarkdownContent(historyList);
      historyList.querySelector(".chat-live-history-back")?.addEventListener("click", (event) => {
        event.stopPropagation();
        const returnId = openLiveHistoryId;
        openLiveHistoryId = null;
        renderHistoryList();
        historyList.scrollTop = liveHistoryReturnScrollTop;
        if (returnId) focusHistoryOpen(returnId);
      });
      bindHistoryActions();
      return;
    }
    openLiveHistoryId = null;

    const liveVideoRef = chatSessionState.liveContextData?.isVideoContext ? chatSessionState.liveContextData : null;
    const canHighlightLiveMatches = Boolean(
      liveVideoRef &&
      chatSessionState.currentConversationMeta?.pinnedContext &&
      chatSessionState.currentConversationMeta?.contextUrl &&
      !doesTabMatchContextUrl(liveVideoRef.url || chatSessionState.liveTabUrl, chatSessionState.currentConversationMeta.contextUrl || "")
    );

    historyList.innerHTML = chatSessionState.savedConversations
      .map((conversation) => {
        const liveEntry = isLiveTextToolHistoryEntry(conversation) ? conversation : null;
        const isActive = !liveEntry && conversation.id === chatSessionState.currentConversationId;
        const isLiveMatch = Boolean(
          !liveEntry &&
          !isActive &&
          canHighlightLiveMatches &&
          doesConversationMatchCurrentContext(conversation, liveVideoRef, chatSessionState.liveContextKey)
        );
        const isSwitching = conversation.id === pendingSwitchId;
        const timestamp = formatConversationTimestamp(conversation.updatedAt || conversation.createdAt);
        const metaText = isSwitching ? "正在保存当前回答…" : liveEntry ? `${timestamp} · ${liveEntry.records.length} 条记录` : timestamp;
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
              <span class="chat-history-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</span>
            </button>
            <button type="button" class="chat-history-remove" data-id="${escapeHtml(conversation.id)}" aria-label="${liveEntry ? "删除伴看记录" : "删除历史对话"}" ${pendingSwitchId ? 'aria-disabled="true"' : ""}>×</button>
          </div>
        `;
      })
      .join("") + undoHtml();
    bindHistoryActions();
    if (revealCurrent || currentAppeared) {
      historyList.querySelector<HTMLElement>(".chat-history-item.is-active .chat-history-open")?.scrollIntoView({ block: "nearest" });
    }
  }

  return { renderSuggestions, renderHistoryList, settlePendingDeletion };
}
