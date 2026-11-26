import { resolveNodeDocument } from "../shared/cross-doc.js";

export interface CreateReaderChatFeedbackDeps {
  messages: HTMLElement;
  inputCard?: HTMLElement | null;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  scrollToBottom: () => void;
  onOpenSettings: (settingsTarget?: "asr") => void;
}

export interface ReaderChatFeedback {
  showConversationContextNotice: (
    message: string,
    autoHideMs?: number,
    options?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      action?: { label: string; onClick: () => void };
      settingsTarget?: "asr";
      placement?: "input";
      tone?: "default" | "success";
      dismissible?: boolean;
    }
  ) => void;
  removeConversationContextNotice: () => void;
  removePersistentContextNotice: () => void;
  showConversationContextError: (message: string) => void;
  removeCenteredState: () => void;
}

export function createReaderChatFeedback({ messages, inputCard, setTimer, clearTimer, scrollToBottom, onOpenSettings }: CreateReaderChatFeedbackDeps): ReaderChatFeedback {
  let messageNoticeTimer = 0;
  let messageNoticePersistent = false;
  let inputNoticeTimer = 0;

  function removeMessagesNotice(): void {
    if (messageNoticeTimer) {
      clearTimer(messageNoticeTimer);
      messageNoticeTimer = 0;
    }
    messageNoticePersistent = false;
    messages.querySelectorAll(".chat-context-notice").forEach((node) => node.remove());
  }

  function removeInputNotice(): void {
    if (inputNoticeTimer) {
      clearTimer(inputNoticeTimer);
      inputNoticeTimer = 0;
    }
    inputCard?.querySelectorAll(".chat-context-notice").forEach((node) => node.remove());
  }

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
    const isInputSlot = placement === "input" && Boolean(inputCard);
    if (isInputSlot) {
      removeInputNotice();
    } else {
      removeMessagesNotice();
    }
    const targetParent = isInputSlot && inputCard ? inputCard : messages;
    const doc = resolveNodeDocument(targetParent);
    const notice = doc.createElement("div");
    notice.className = "chat-context-notice";
    if (tone === "success") {
      notice.classList.add("is-success");
    }
    notice.setAttribute("role", placement === "input" ? "alert" : "status");
    notice.textContent = String(message || "").trim();
    if (spinner) {
      const indicator = doc.createElement("span");
      indicator.className = "chat-notice-spinner";
      indicator.setAttribute("aria-hidden", "true");
      notice.insertBefore(indicator, notice.firstChild);
    }
    const actions = [
      ...(action ? [action] : []),
      ...(openSettingsAction ? [{ label: "前往设置", onClick: () => onOpenSettings(settingsTarget) }] : [])
    ];
    for (const descriptor of actions) {
      const link = doc.createElement("a");
      link.href = "#";
      link.textContent = descriptor.label;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        descriptor.onClick();
      });
      notice.appendChild(doc.createTextNode(" "));
      notice.appendChild(link);
    }
    if (dismissible) {
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "chat-notice-close";
      closeBtn.setAttribute("aria-label", "关闭提示");
      closeBtn.title = "关闭";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isInputSlot) {
          removeInputNotice();
        } else {
          removeMessagesNotice();
        }
      });
      notice.appendChild(doc.createTextNode(" "));
      notice.appendChild(closeBtn);
    }
    targetParent.prepend(notice);
    if (!isInputSlot) {
      messageNoticePersistent = autoHideMs <= 0 && !openSettingsAction && !action && tone !== "success";
    }
    if (autoHideMs > 0) {
      const timer = setTimer(() => {
        if (isInputSlot) {
          removeInputNotice();
        } else {
          removeMessagesNotice();
        }
      }, autoHideMs);
      if (isInputSlot) {
        inputNoticeTimer = timer;
      } else {
        messageNoticeTimer = timer;
      }
    }
  }

  function removeConversationContextNotice(): void {
    removeMessagesNotice();
    removeInputNotice();
  }

  function removePersistentContextNotice(): void {
    if (!messageNoticePersistent) {
      return;
    }
    removeMessagesNotice();
  }

  function showConversationContextError(message: string): void {
    if (!String(message || "").trim()) {
      return;
    }
    removeConversationContextNotice();
    removeCenteredState();
    const stateNode = resolveNodeDocument(messages).createElement("div");
    stateNode.className = "chat-center-error";
    stateNode.textContent = String(message);
    messages.appendChild(stateNode);
    scrollToBottom();
  }

  function removeCenteredState(): void {
    messages.querySelectorAll(".chat-center-error").forEach((node) => node.remove());
  }

  return {
    showConversationContextNotice,
    removeConversationContextNotice,
    removePersistentContextNotice,
    showConversationContextError,
    removeCenteredState
  };
}
