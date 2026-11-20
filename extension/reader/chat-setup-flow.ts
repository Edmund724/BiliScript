// extension/reader/chat-setup-flow.ts — AI 对话首配直达与返回视图守卫切片。

import { chatSessionState } from "../chat/chat-state.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import type { ChatSetupTarget } from "./chat-model-panel.js";
import type { ReaderChatFeedback } from "./chat-notices.js";
import { closeReaderSettingsMode } from "./settings-mode.js";
import { beginReaderAiSetupFlow, invalidateReaderSetupFlows } from "./setup-resume.js";
import { ids } from "./state.js";

// 返回对话后的提示（票 03）：只提示，不代发——是否发送始终由用户再点一次。
export const CHAT_SETUP_READY_NOTICE = "平台已就绪，请确认发送。";
// 缺 Key / 缺模型 / 平台失效回合错误的行内提示与动作（「前往设置」与空态同一措辞）。
export const CHAT_SETUP_MISSING_KEY_NOTICE = "该平台 API Key 未配置，配置后请重新发送。";
export const CHAT_SETUP_NO_MODEL_NOTICE = "当前 AI 平台未配置可用模型，配置后请重新发送。";
export const CHAT_SETUP_NO_PROVIDER_NOTICE = "当前 AI 平台配置已失效或未配置，请前往设置。";
export const CHAT_SETUP_ACTION_LABEL = "前往设置";

// 首配返回视图守卫（只在内存）：平台保存会触发 storage 变更 → 平台/偏好重取，
// 而错误回合（用户气泡 + 错误占位）尚未写进 chatHistory——那一刻重建消息区会把
// 刚发生的一问一答一起清掉。守卫期间平台与历史列表照刷，消息区归返回事务
//（blocked 模式由 resume 重渲初始态；error 模式保持原样），直到用户下次发送、
// 新会话、换视频或关闭会话恢复常规重建。
export type ChatSetupMode = "blocked" | "error";

export interface BeginChatSetupOptions {
  // 缺 Key / 缺模型时已选平台的记录 id（直达该记录）；无记录时为空。
  providerId?: string;
  // 来源：受理前拦截（blocked）或已受理错误回合（error）；缺省按当前历史推断。
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
  showNotice: ReaderChatFeedback["showConversationContextNotice"];
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

  // 无平台 / 缺模型状态屏（空态与「发送前拦截」共用一份）：配置动作直达对应平台编辑记录。
  function setupStateHtml(): string {
    if (chatSessionState.providers.length > 0 && !deps.hasSelectableModels()) {
      return `当前 AI 平台还没有配置可用模型，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`;
    }
    return `还没有配置 AI 平台，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`;
  }

  /**
   * 保存成功后的返回：退出设置抽屉、重取平台与偏好、聚焦输入区并提示「平台已就绪，请确认发送」。
   */
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

  /**
   * 首配直达：进入平台编辑并在保存成功且仍有效时回到对话，取消或上下文切换时收敛守卫。
   */
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

  // 缺 Key / 缺模型 / 平台失效回合错误（已受理）的行内动作：只给「前往设置」，不重发本回合。
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
