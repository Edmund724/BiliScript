// reader/chat-notices.ts — 对话 tab 消息区提示 / 居中态 / 建议区清理 / 近底判定
//（PR5 自 extension/pages/sidepanel-notices.ts 重建；原 sidepanel 孪生模块已
// 随侧边栏形态删除，本文件是唯一实现，判定逻辑（通知条去重、textContent 防注入、
// 自动消失定时器、居中错误块、建议区撤除、近底阈值、spinner 加载
// 动画插槽）不再与孪生
// 同步，行为契约由 tests/reader/chat-notices.test.ts 钉住。DOM 壳：容器经 deps
// 注入 reader 的 readingChatMessages，class 名沿用 .chat-context-notice /
// .chat-notice-spinner / .chat-center-error / .chat-suggestions）。
//
// 唯一语义改造（盘点报告 §1.1 notices 判定行）：「前往设置」链接在 reader
//（content script）语境下没有 chrome.runtime.openOptionsPage；script-only-ui
// 起 open-options 消息与独立设置页已删除，链接点击经 deps.onOpenSettings
// 回调打开侧边栏设置抽屉（生产组装点在 reader/chat-tab.ts 注入，转发到
// ui-renderer 的 openReaderSettingsPanel）。
//
// 依赖方向（无环）：DOM 容器经工厂 deps 注入，建议区撤除经建议区属主
//（reader/chat-suggestions-slot）的方法调用；定时器可注入（生产组装点用
// window.setTimeout/clearTimeout，测试手动推进）。通知条自动消失定时器是本模块
// 闭包私有状态。本模块不 import 组合根。

import type { ChatSuggestionsSlot } from "./chat-suggestions-slot.js";

export interface CreateReaderChatFeedbackDeps {
  messages: HTMLElement;
  inputCard?: HTMLElement | null;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  // showConversationContextError 追加居中错误块后滚动到底（chatRuntime 的
  // scrollToBottom，惰性接线）
  scrollToBottom: () => void;
  // 建议区属主：本模块以 clear 撤除建议区（节点引用只归属主，本模块不持节点）
  suggestions: ChatSuggestionsSlot;
  // 通知条「前往设置」链接的点击回调（打开侧边栏设置抽屉；带目标时直达该分区
  // 的设置动作——票 04：ASR 配置类拦截直达 ASR 平台编辑 / 自动转写开关）
  onOpenSettings: (settingsTarget?: "asr") => void;
}

export interface ReaderChatFeedback {
  showConversationContextNotice: (
    message: string,
    autoHideMs?: number,
    options?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      // 自定义动作链接（票 03：缺 Key 错误回合的「前往设置」直达平台编辑记录）。
      // 与 openSettingsAction 同一种呈现（行内 accent 链接），动作由调用方给。
      action?: { label: string; onClick: () => void };
      // 前往设置的分区目标（票 04：ASR 配置类拦截直达 ASR 平台编辑 / 自动转写开关）
      settingsTarget?: "asr";
      placement?: "input";
      tone?: "default" | "success";
      dismissible?: boolean;
    }
  ) => void;
  removeConversationContextNotice: () => void;
  showConversationContextError: (message: string) => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  isMessagesNearBottom: (threshold?: number) => boolean;
  getMessagesBottomOffset: () => number;
}

export function createReaderChatFeedback({ messages, inputCard, setTimer, clearTimer, scrollToBottom, suggestions, onOpenSettings }: CreateReaderChatFeedbackDeps): ReaderChatFeedback {
  // 通知条自动消失定时器（闭包私有单例；0 = 无挂起定时器）
  let contextNoticeTimer = 0;

  function showConversationContextNotice(
    message: string,
    autoHideMs = 0,
    {
      openSettingsAction = false,
      spinner = false,
      action,
      settingsTarget,
      placement,
      tone = "default",
      dismissible = false
    }: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      action?: { label: string; onClick: () => void };
      settingsTarget?: "asr";
      placement?: "input";
      tone?: "default" | "success";
      dismissible?: boolean;
    } = {}
  ): void {
    removeConversationContextNotice();
    const notice = document.createElement("div");
    notice.className = "chat-context-notice";
    if (tone === "success") {
      notice.classList.add("is-success");
    }
    notice.setAttribute("role", placement === "input" ? "alert" : "status");
    notice.textContent = String(message || "").trim();
    if (spinner) {
      const indicator = document.createElement("span");
      indicator.className = "chat-notice-spinner";
      indicator.setAttribute("aria-hidden", "true");
      notice.insertBefore(indicator, notice.firstChild);
    }
    const actions = [
      ...(action ? [action] : []),
      ...(openSettingsAction ? [{ label: "前往设置", onClick: () => onOpenSettings(settingsTarget) }] : [])
    ];
    for (const descriptor of actions) {
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = descriptor.label;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        descriptor.onClick();
      });
      notice.appendChild(document.createTextNode(" "));
      notice.appendChild(link);
    }
    if (dismissible) {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "chat-notice-close";
      closeBtn.setAttribute("aria-label", "关闭提示");
      closeBtn.title = "关闭";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeConversationContextNotice();
      });
      notice.appendChild(document.createTextNode(" "));
      notice.appendChild(closeBtn);
    }
    (placement === "input" && inputCard ? inputCard : messages).prepend(notice);
    if (autoHideMs > 0) {
      contextNoticeTimer = setTimer(() => {
        removeConversationContextNotice();
      }, autoHideMs);
    }
  }

  function removeConversationContextNotice(): void {
    if (contextNoticeTimer) {
      clearTimer(contextNoticeTimer);
      contextNoticeTimer = 0;
    }
    messages.querySelectorAll(".chat-context-notice").forEach((node) => node.remove());
    inputCard?.querySelectorAll(".chat-context-notice").forEach((node) => node.remove());
  }

  function showConversationContextError(message: string): void {
    if (!String(message || "").trim()) {
      return;
    }
    removeConversationContextNotice();
    removeCenteredState();
    const stateNode = document.createElement("div");
    stateNode.className = "chat-center-error";
    stateNode.textContent = String(message);
    messages.appendChild(stateNode);
    scrollToBottom();
  }

  function removeCenteredState(): void {
    messages.querySelectorAll(".chat-center-error").forEach((node) => node.remove());
  }

  function removeSuggestions(): void {
    suggestions.clear();
  }

  function getMessagesBottomOffset(): number {
    const { scrollTop, scrollHeight, clientHeight } = messages;
    return Math.max(0, scrollHeight - (scrollTop + clientHeight));
  }

  function isMessagesNearBottom(threshold = 40): boolean {
    return getMessagesBottomOffset() <= threshold;
  }

  return {
    showConversationContextNotice,
    removeConversationContextNotice,
    showConversationContextError,
    removeCenteredState,
    removeSuggestions,
    isMessagesNearBottom,
    getMessagesBottomOffset
  };
}
