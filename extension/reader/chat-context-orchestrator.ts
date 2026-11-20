// extension/reader/chat-context-orchestrator.ts — 上下文同步防抖、视图重建与对话重启编排切片。

import {
  applyLiveContextToMain,
  chatSessionState,
  rebuildCurrentContextKeyFromContext
} from "../chat/chat-state.js";
import { isPinnedContextStrict } from "../chat/context-policy.js";
import type { LoadContextStateOptions } from "../chat/conversation-store.js";
import type { ViewResetIntent } from "../chat/view-intent.js";
import { confirmDialog as defaultConfirmDialog, type ConfirmDialogOptions } from "../ui/confirm-dialog.js";
import { findSubtitlePreviewAtTime, type TimestampNavDeps } from "../ui/timestamp-nav.js";

export const NON_VIDEO_CONTEXT_MESSAGE = "当前不是视频播放页，<br>无法获取视频信息，<br>仅支持常规对话。";

export interface ScheduleLiveContextSyncOptions {
  forceRefresh?: boolean;
  preserveInput?: boolean;
}

export interface RestartChatOptions {
  keepContext?: boolean;
  preserveInput?: boolean;
}

export interface CreateChatContextOrchestratorDeps {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  openSettingsId: string;
  isSessionClosed: () => boolean;
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
  detachForRestart: () => void;
  isTurnActive: () => boolean;
  setAutoScroll: (autoScroll: boolean) => void;
  scrollToBottom: (force?: boolean) => void;
  renderReplay: () => void;
  invalidateReplay: () => void;
  updateLayout: () => void;
  autosizeInput: () => void;
  setStreamingUiState: (isStreaming: boolean) => void;
  getInputImageCount: () => number;
  clearInputImages: () => void;
  resetSuggestionsShell: () => void;
  renderSuggestions: () => void;
  resetScrollFollow: () => void;
  hasSelectableModels: () => boolean;
  getSetupStateHtml: () => string;
  invalidateSetupFlow: () => void;
  showNotice: (
    message: string,
    autoHideMs?: number,
    options?: { placement?: "input" }
  ) => void;
  hideOverlaysForNewChat: () => void;
  seekReadingTarget: (seconds: number) => number | null;
  confirmDialog?: (options: ConfirmDialogOptions) => Promise<boolean>;
}

export interface ChatContextOrchestrator {
  scheduleLiveContextSync: (opts?: ScheduleLiveContextSyncOptions) => void;
  cancelPendingSync: () => void;
  syncLiveContextState: (forceRefresh?: boolean, preserveInput?: boolean) => Promise<void>;
  renderInitialState: () => void;
  resetConversationView: (stateHtml?: string) => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  startNewConversation: () => Promise<boolean>;
  restartChat: (opts?: RestartChatOptions) => void;
  getTimestampNavDeps: () => TimestampNavDeps;
  isRestartForContextFollow: () => boolean;
  clearRestartForContextFollow: () => void;
}

export function createChatContextOrchestrator(deps: CreateChatContextOrchestratorDeps): ChatContextOrchestrator {
  let urlChangeSyncTimer = 0;
  let restartForContextFollow = false;
  const confirmPrompt = deps.confirmDialog ?? defaultConfirmDialog;

  function cancelPendingSync(): void {
    if (urlChangeSyncTimer) {
      window.clearTimeout(urlChangeSyncTimer);
      urlChangeSyncTimer = 0;
    }
  }

  // 参数：forceRefresh 缺省强刷（URL 变化 = 明确要求全网络重拉）；preserveInput 缺省
  // false（换片是用户动作，清场是既有语义）。字幕落定的对账走弱档 + 保输入（见会话
  // 触发源组装处 clipSettle 的取舍说明）。
  function scheduleLiveContextSync({ forceRefresh = true, preserveInput = false }: ScheduleLiveContextSyncOptions = {}): void {
    if (deps.isSessionClosed()) {
      return;
    }
    if (urlChangeSyncTimer) {
      window.clearTimeout(urlChangeSyncTimer);
    }
    urlChangeSyncTimer = window.setTimeout(() => {
      urlChangeSyncTimer = 0;
      if (deps.isSessionClosed()) {
        return;
      }
      void syncLiveContextState(forceRefresh, preserveInput);
    }, 120);
  }

  // 【整段迁移自 sidepanel.ts】post-sync 分支编排：流式守卫 + 三个渲染回调。
  // preserveInput 透传进上下文装载（gate 链与字幕落定对账为「上下文跟随」，见
  // 各自调用点）。
  async function syncLiveContextState(forceRefresh = false, preserveInput = false): Promise<void> {
    if (deps.isSessionClosed()) {
      return;
    }
    const ok = await deps.loadContextState({ forceRefresh, silent: true, preserveInput }).catch(() => false);
    if (deps.isSessionClosed() || isPinnedContextStrict(chatSessionState.currentConversationMeta) || deps.isTurnActive()) {
      return;
    }
    if (
      !ok
      || !chatSessionState.contextData
      || !chatSessionState.providers.length
      || !deps.hasSelectableModels()
      || !chatSessionState.chatHistory.length
    ) {
      renderInitialState();
      return;
    }
    deps.renderSuggestions();
  }

  // 【迁移自 sidepanel.ts resetConversationView】消息区重建 + 建议区重开。
  function resetConversationView(stateHtml = ""): void {
    // 清场即作废进行中的回放分片（P2-1）：过期分片不得写进重建后的消息区。
    deps.invalidateReplay();
    deps.updateLayout();
    deps.messagesEl.innerHTML = "";
    if (stateHtml) {
      const stateNode = document.createElement("div");
      stateNode.className = "chat-center-error";
      stateNode.innerHTML = stateHtml;
      deps.messagesEl.appendChild(stateNode);
    }
    // 清场即重开本代建议区：消息区刚被清空，属主手里的节点已脱开文档，这一步是
    // 建议区的建立点（空表 = 在场的空建议区）；随后列表按当前状态填内容——列表的
    // 对账重渲只写在场建议区，不负责重建（历史回放清场后不得复活空壳）。
    deps.resetSuggestionsShell();
    deps.renderSuggestions();
    deps.setAutoScroll(true);
    deps.scrollToBottom(true);
    // 清场后没有「回底」需求，且必须放闸（内容短的清场不产生 scroll 事件，闸若
    // 留着，用户此后的上翻会被误当成「回底途中」，按钮再也不亮）：统一交由 scrollFollow.reset()。
    deps.resetScrollFollow();
  }

  // 【整段迁移自 sidepanel.ts】初始态渲染：无上下文 / 无平台或无模型 / 会话回放 / 非视频
  // 四态分支逐字保持；配置引导分支的「前往设置」换 readingChatOpenSettings id。
  function renderInitialState(): void {
    restartForContextFollow = false;
    deps.updateLayout();
    if (!chatSessionState.contextData) {
      resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
      return;
    }
    if (!chatSessionState.providers.length || !deps.hasSelectableModels()) {
      resetConversationView(deps.getSetupStateHtml());
      return;
    }
    if (chatSessionState.chatHistory.length) {
      // 回放改为按预算分片让出（P2-1）：fire-and-forget——本函数保持同步返回，
      // 首片同步上屏，其余在让出点续跑，末尾由 conversationReplay 统一收尾。
      deps.renderReplay();
      return;
    }
    if (chatSessionState.contextData.isVideoContext === false) {
      resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
      return;
    }
    resetConversationView("");
  }

  // 视图意图通道（chat/view-intent.ts 词表）：「清场/状态屏」的唯一决策执行入口。
  function requestViewReset(intent: ViewResetIntent): void {
    // 配置类拦截屏（票 03）：无平台/缺模型状态屏与空态同源——同一句文案、同一个「前往设置」
    // 动作；发送被拦下的草稿与附件区在此不受影响。
    if (intent.kind === "setup") {
      resetConversationView(deps.getSetupStateHtml());
      document.getElementById(deps.openSettingsId)?.focus({ preventScroll: true });
      deps.showNotice("请先配置平台与模型，点击下方「前往设置」", 4000, { placement: "input" });
      return;
    }
    resetConversationView(intent.html);
  }

  // 新建会话只在确认后拆除旧视图；草稿、附件与在途回合的风险合并在一次确认中。
  async function startNewConversation(): Promise<boolean> {
    const turnActive = deps.isTurnActive();
    const hasDraft = Boolean(deps.inputEl.value);
    const imageCount = deps.getInputImageCount();
    if (turnActive || hasDraft || imageCount > 0) {
      const risks: string[] = [];
      if (turnActive) risks.push("中断正在生成的回复");
      if (hasDraft) risks.push("清空未发送的草稿");
      if (imageCount > 0) risks.push(`移除 ${imageCount} 张已添加的图片`);
      const confirmed = await confirmPrompt({
        title: "新建会话",
        message: `新建会话会${risks.join("，")}。`,
        confirmText: "新建会话"
      });
      if (!confirmed) return false;
    }
    deps.invalidateSetupFlow();
    deps.hideOverlaysForNewChat();
    await deps.loadContextState({ forceRefresh: true, silent: true });
    // 组合根绕过点（有意，不经 plan.action 分支）：live 快照非空即落到主上下文。
    // startNewConversation 是拆除事务——下一句 restartChat 才断流并清会话身份
    //（conversation-store.detachForRestart），所以流式中点「新对话」（策略给
    // blocked-streaming）与 pinned 会话（apply-pinned）都在此被绕过：新会话要在
    // 当前页上下文上起跑，两个守卫在此让位，与策略守卫正交；live 为空时空操作。
    if (chatSessionState.liveContextData) {
      applyLiveContextToMain();
    }
    restartChat({ keepContext: true });
    renderInitialState();
    deps.inputEl?.focus?.({ preventScroll: true });
    return true;
  }

  // 【整段迁移自 sidepanel.ts】重启对话：清流状态 + 清会话状态 + 重置消息区
  //（编排入口，被新对话/上下文切换复用）。
  function restartChat({ keepContext = false, preserveInput = false }: RestartChatOptions = {}): void {
    restartForContextFollow = Boolean(preserveInput);
    try {
      deps.detachForRestart();
    } catch (error) {
      restartForContextFollow = false;
      throw error;
    }
    if (!keepContext) {
      rebuildCurrentContextKeyFromContext();
    }
    resetConversationView("");
    deps.setStreamingUiState(false);
    if (!preserveInput) {
      deps.inputEl.value = "";
      // 附件随输入框一起清场（新会话/上下文切换后不带着上一轮的图片）。
      deps.clearInputImages();
    }
    deps.autosizeInput();
  }

  // 时间戳跳转依赖包（注入 timestamp-nav）。reader 适配：seek 直接包进程内单入口
  // seekReadingTarget（content script 无 chrome.tabs 消息链，无跨标签导航可言），
  // 返回 null = 未绑定到视频，由 nav 侧降级为失败播报。
  function getTimestampNavDeps(): TimestampNavDeps {
    const targetContextKey = String(
      chatSessionState.currentConversationMeta?.contextKey || chatSessionState.currentContextKey || ""
    ).trim();
    return {
      contextUrl: String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim(),
      isContextValid: () => {
        const liveKey = String(chatSessionState.liveContextKey || "").trim();
        const hasLiveVideo = chatSessionState.liveContextData ? chatSessionState.liveContextData.isVideoContext !== false : true;
        if (!hasLiveVideo) {
          return false;
        }
        return !targetContextKey || !liveKey || targetContextKey === liveKey;
      },
      notice: deps.showNotice,
      seek: (seconds: number) => deps.seekReadingTarget(seconds),
      getSubtitlePreview: (seconds: number) => {
        const body =
          chatSessionState.contextData?.subtitleBody ??
          chatSessionState.currentConversationMeta?.resolvedContext?.subtitleBody;
        return findSubtitlePreviewAtTime(body, seconds);
      },
      tooltipContainer: deps.messagesEl
    };
  }

  return {
    scheduleLiveContextSync,
    cancelPendingSync,
    syncLiveContextState,
    renderInitialState,
    resetConversationView,
    requestViewReset,
    startNewConversation,
    restartChat,
    getTimestampNavDeps,
    isRestartForContextFollow: () => restartForContextFollow,
    clearRestartForContextFollow: () => {
      restartForContextFollow = false;
    }
  };
}
