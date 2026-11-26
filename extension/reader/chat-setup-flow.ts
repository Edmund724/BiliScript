import { chatSessionState } from "../chat/chat-state.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import type { ChatSetupTarget } from "./chat-model-panel.js";
import type { ChatNoticeSlot } from "./chat-notices.js";
import { closeReaderSettingsMode } from "./settings-mode.js";
import { beginReaderAiSetupFlow, invalidateReaderSetupFlows } from "./setup-resume.js";
import { ids } from "./state.js";

export const CHAT_SETUP_READY_NOTICE = "平台已就绪，请确认发送。";
export const CHAT_SETUP_MISSING_KEY_NOTICE = "该平台 API Key 未配置，配置后请重新发送。";
export const CHAT_SETUP_NO_MODEL_NOTICE = "当前 AI 平台未配置可用模型，配置后请重新发送。";
export const CHAT_SETUP_NO_PROVIDER_NOTICE = "当前 AI 平台配置已失效或未配置，请前往设置。";
export const CHAT_SETUP_ACTION_LABEL = "前往设置";

export type ChatSetupMode = "blocked" | "error";

export interface BeginChatSetupOptions {
  providerId?: string;
  mode?: ChatSetupMode;
}

export interface CreateChatSetupFlowDeps {
  isSessionClosed: () => boolean;
  isInitialized: () => boolean;
  hasSelectableModels: () => boolean;
  resolveSetupTarget: () => ChatSetupTarget;
  reloadModelPanel: () => Promise<void>;
  renderInitialState: () => void;
  autosizeInput: () => void;
  focusInput: () => void;
  showNotice: ChatNoticeSlot["show"];
}

export interface ChatSetupFlow {
  setupStateHtml: () => string;
  beginSetup: (errorClass: OverviewSetupErrorClass, options?: BeginChatSetupOptions) => void;
  showSetupAction: (errorClass: OverviewSetupErrorClass, providerId: string) => void;
  isViewHeld: () => boolean;
  clearViewHold: () => void;
  invalidate: () => void;
}

export function createChatSetupFlow(deps: CreateChatSetupFlowDeps): ChatSetupFlow {
  let chatSetupViewHold = false;

  function setupStateHtml(): string {
    if (chatSessionState.providers.length > 0 && !deps.hasSelectableModels()) {
      return `当前 AI 平台还没有配置可用模型，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`;
    }
    return `还没有配置 AI 平台，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`;
  }

  function resumeChatAfterSetup(mode: ChatSetupMode): void {
    closeReaderSettingsMode({ restoreFocus: false });
    deps.autosizeInput();
    deps.focusInput();
    void (async () => {
      await deps.reloadModelPanel().catch(() => null);
      if (deps.isSessionClosed()) {
        return;
      }
      if (mode === "blocked") {
        deps.renderInitialState();
        chatSetupViewHold = false;
      }
      deps.autosizeInput();
      deps.focusInput();
      deps.showNotice(CHAT_SETUP_READY_NOTICE, 0, {
        tone: "success",
        dismissible: true
      });
    })();
  }

  function beginSetup(errorClass: OverviewSetupErrorClass, { providerId = "", mode }: BeginChatSetupOptions = {}): void {
    if (deps.isSessionClosed()) {
      return;
    }
    const targetProviderId = String(providerId || "").trim();
    const setupMode: ChatSetupMode = mode ?? (chatSessionState.chatHistory.length ? "error" : "blocked");
    const snapshotContextKey = String(chatSessionState.currentContextKey || "");
    const snapshotConversationId = String(chatSessionState.currentConversationId || "");
    chatSetupViewHold = true;

    void beginReaderAiSetupFlow({
      scope: "chat",
      errorClass,
      providerId: targetProviderId,
      isStillValid: () =>
        !deps.isSessionClosed()
        && deps.isInitialized()
        && snapshotContextKey === String(chatSessionState.currentContextKey || "")
        && snapshotConversationId === String(chatSessionState.currentConversationId || ""),
      onResume: () => {
        resumeChatAfterSetup(setupMode);
      },
      onCancel: () => {
        chatSetupViewHold = false;
      }
    });
  }

  function showSetupAction(errorClass: OverviewSetupErrorClass, providerId: string): void {
    let resolvedClass = errorClass;
    let resolvedProviderId = String(providerId || "").trim();
    if (
      resolvedClass === "no-provider"
      && !resolvedProviderId
      && chatSessionState.providers.length > 0
      && !deps.hasSelectableModels()
    ) {
      const target = deps.resolveSetupTarget();
      resolvedClass = target.errorClass;
      resolvedProviderId = target.providerId;
    }
    const message =
      resolvedClass === "missing-key"
        ? CHAT_SETUP_MISSING_KEY_NOTICE
        : resolvedClass === "no-model"
          ? CHAT_SETUP_NO_MODEL_NOTICE
          : CHAT_SETUP_NO_PROVIDER_NOTICE;
    deps.showNotice(message, 0, {
      action: {
        label: CHAT_SETUP_ACTION_LABEL,
        onClick: () => beginSetup(resolvedClass, { providerId: resolvedProviderId, mode: "error" })
      }
    });
  }

  return {
    setupStateHtml,
    beginSetup,
    showSetupAction,
    isViewHeld: () => chatSetupViewHold,
    clearViewHold: () => {
      chatSetupViewHold = false;
    },
    invalidate: () => {
      invalidateReaderSetupFlows("chat");
      chatSetupViewHold = false;
    }
  };
}
