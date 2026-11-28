import { resolveCreationDocument } from "../shared/cross-doc.js";

export interface ChatNoticeAction {
  label: string;
  onClick: () => void;
}

export interface ChatNoticeOptions {
  openSettingsAction?: boolean;
  spinner?: boolean;
  action?: ChatNoticeAction;
  settingsTarget?: "asr";
  tone?: "default" | "success";
  dismissible?: boolean;
  tag?: string;
}

export interface ChatNoticeSlot {
  show: (message: string, autoHideMs?: number, options?: ChatNoticeOptions) => void;
  clear: (tag?: string) => void;
}

export interface CreateReaderChatFeedbackDeps {
  messages: HTMLElement;
  inputCard?: HTMLElement | null;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  scrollToBottom: () => void;
  onOpenSettings: (settingsTarget?: "asr") => void;
}

export interface ReaderChatFeedback {
  messagesNotice: ChatNoticeSlot;
  inputNotice: ChatNoticeSlot;
  clearAllNotices: () => void;
  showConversationContextError: (message: string) => void;
  removeCenteredState: () => void;
}

export function createReaderChatFeedback({
  messages,
  inputCard,
  setTimer,
  clearTimer,
  scrollToBottom,
  onOpenSettings
}: CreateReaderChatFeedbackDeps): ReaderChatFeedback {
  function createSlot(targetParent: HTMLElement, role: "status" | "alert"): ChatNoticeSlot {
    let timer = 0;
    let activeNode: HTMLElement | null = null;
    let activeTag: string | undefined;

    function clear(tag?: string): void {
      if (tag !== undefined && activeTag !== tag) {
        return;
      }
      if (timer) {
        clearTimer(timer);
        timer = 0;
      }
      activeTag = undefined;
      activeNode?.remove();
      activeNode = null;
    }

    function show(
      message: string,
      autoHideMs = 0,
      {
        openSettingsAction = false,
        spinner = false,
        action,
        settingsTarget,
        tone = "default",
        dismissible = false,
        tag
      }: ChatNoticeOptions = {}
    ): void {
      clear();
      const doc = resolveCreationDocument(targetParent);
      const notice = doc.createElement("div");
      notice.className = "chat-context-notice";
      if (tone === "success") {
        notice.classList.add("is-success");
      }
      notice.setAttribute("role", role);
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
          clear();
        });
        notice.appendChild(doc.createTextNode(" "));
        notice.appendChild(closeBtn);
      }
      targetParent.prepend(notice);
      activeNode = notice;
      activeTag = tag;
      if (autoHideMs > 0) {
        timer = setTimer(() => {
          clear();
        }, autoHideMs);
      }
    }

    return { show, clear };
  }

  const messagesNotice = createSlot(messages, "status");
  const inputNotice = createSlot(inputCard ?? messages, "alert");

  function clearAllNotices(): void {
    messagesNotice.clear();
    inputNotice.clear();
  }

  function showConversationContextError(message: string): void {
    if (!String(message || "").trim()) {
      return;
    }
    clearAllNotices();
    removeCenteredState();
    const stateNode = resolveCreationDocument(messages).createElement("div");
    stateNode.className = "chat-center-error";
    stateNode.textContent = String(message);
    messages.appendChild(stateNode);
    scrollToBottom();
  }

  function removeCenteredState(): void {
    messages.querySelectorAll(".chat-center-error").forEach((node) => node.remove());
  }

  return {
    messagesNotice,
    inputNotice,
    clearAllNotices,
    showConversationContextError,
    removeCenteredState
  };
}
