// extension/live/fullscreen-live-overlay.ts
// 播放器全屏（浏览器全屏与网页全屏）右上角半透明实时伴看浮窗：
// 1. 头部状态胶囊（状态文本、麦克风 VAD 动效、点击结束伴看）
// 2. 音频快捷设置入口（静音、把视频声音也分享给 Agent、语音优先）
// 3. 最小化（-）与关闭隐藏（×）
// 4. 纯语音实时流式对话气泡（右侧绿色用户气泡、左侧 Agent 流式气泡）与「清空」按钮
// 5. 播放器容器内拖拽移动

import type { LiveChatController, LiveChatState } from "./live-chat-controller.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

export interface FullscreenLiveOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  getChatHistory?: () => Array<{ role: string; content: string }>;
  onStopLive?: () => void;
  onClearHistory?: () => Promise<void> | void;
}

export interface FullscreenLiveOverlay {
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  syncState(state?: LiveChatState, reconnecting?: boolean): void;
  updateVad(active: boolean): void;
  updateTranscript(event: MossLiveTranscriptEvent): void;
  clearMessages(): void;
  getElement(): HTMLElement | null;
  dispose(): void;
}

export function createFullscreenLiveOverlay(deps: FullscreenLiveOverlayDeps): FullscreenLiveOverlay {
  let rootEl: HTMLElement | null = null;
  let statusCapsuleEl: HTMLButtonElement | null = null;
  let statusDotEl: HTMLElement | null = null;
  let statusTextEl: HTMLElement | null = null;
  let audioBtnEl: HTMLButtonElement | null = null;
  let audioPopEl: HTMLElement | null = null;
  let muteSwitchEl: HTMLButtonElement | null = null;
  let shareAudioSwitchEl: HTMLButtonElement | null = null;
  let voicePrioritySwitchEl: HTMLButtonElement | null = null;
  let minBtnEl: HTMLButtonElement | null = null;
  let closeBtnEl: HTMLButtonElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let messagesEl: HTMLElement | null = null;
  let clearBtnEl: HTMLButtonElement | null = null;

  let isMin = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  // 活跃转写气泡记录
  let pendingUserBubble: HTMLElement | null = null;
  let currentAssistantBubble: HTMLElement | null = null;
  let currentAssistantRunId: string | null = null;
  let currentAssistantTurnId: string | null = null;

  function ensureMounted(): HTMLElement {
    if (rootEl && rootEl.isConnected) {
      return rootEl;
    }

    const host = deps.getPlayerHost() || document.body;
    let existing = host.querySelector("#biliscript-fullscreen-live-overlay") as HTMLElement | null;
    if (existing) {
      rootEl = existing;
      bindDomReferences(rootEl);
      return rootEl;
    }

    const overlay = document.createElement("div");
    overlay.id = "biliscript-fullscreen-live-overlay";
    overlay.className = "biliscript-fullscreen-live-overlay";
    overlay.setAttribute("data-biliscript-extension-node", "fullscreen-live-overlay");
    overlay.innerHTML = `
      <div class="live-overlay-header">
        <button type="button" class="live-overlay-status-capsule" title="点击结束伴看" aria-label="点击结束伴看">
          <span class="live-overlay-status-dot"></span>
          <span class="live-overlay-status-text">正在陪看</span>
        </button>
        <div class="live-overlay-header-actions">
          <div class="live-overlay-audio-anchor">
            <button type="button" class="live-overlay-icon-btn live-overlay-audio-btn" title="音频设置" aria-label="音频设置">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              </svg>
            </button>
            <div class="live-overlay-audio-popover" hidden>
              <div class="live-overlay-pop-item">
                <span>麦克风</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-mute-switch" aria-label="切换麦克风静音"></button>
              </div>
              <div class="live-overlay-pop-item">
                <span>把视频声音也分享给 Agent</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-share-switch" aria-label="把视频声音也分享给 Agent"></button>
              </div>
              <div class="live-overlay-pop-item">
                <span>语音优先</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-priority-switch" aria-label="语音优先"></button>
              </div>
            </div>
          </div>
          <button type="button" class="live-overlay-icon-btn live-overlay-min-btn" title="最小化" aria-label="最小化">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button type="button" class="live-overlay-icon-btn live-overlay-close-btn" title="隐藏浮窗" aria-label="隐藏浮窗">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="live-overlay-body">
        <div class="live-overlay-messages"></div>
        <div class="live-overlay-footer">
          <button type="button" class="live-overlay-clear-btn" title="清空对话" aria-label="清空对话">清空</button>
        </div>
      </div>
    `;

    host.appendChild(overlay);
    rootEl = overlay;
    bindDomReferences(overlay);
    bindEvents(overlay);
    loadInitialHistory();
    return overlay;
  }

  function bindDomReferences(overlay: HTMLElement): void {
    statusCapsuleEl = overlay.querySelector(".live-overlay-status-capsule");
    statusDotEl = overlay.querySelector(".live-overlay-status-dot");
    statusTextEl = overlay.querySelector(".live-overlay-status-text");
    audioBtnEl = overlay.querySelector(".live-overlay-audio-btn");
    audioPopEl = overlay.querySelector(".live-overlay-audio-popover");
    muteSwitchEl = overlay.querySelector(".live-overlay-mute-switch");
    shareAudioSwitchEl = overlay.querySelector(".live-overlay-share-switch");
    voicePrioritySwitchEl = overlay.querySelector(".live-overlay-priority-switch");
    minBtnEl = overlay.querySelector(".live-overlay-min-btn");
    closeBtnEl = overlay.querySelector(".live-overlay-close-btn");
    bodyEl = overlay.querySelector(".live-overlay-body");
    messagesEl = overlay.querySelector(".live-overlay-messages");
    clearBtnEl = overlay.querySelector(".live-overlay-clear-btn");
  }

  function loadInitialHistory(): void {
    if (!messagesEl || !deps.getChatHistory) return;
    const history = deps.getChatHistory();
    messagesEl.innerHTML = "";
    if (Array.isArray(history)) {
      for (const item of history) {
        if (!item || !item.content) continue;
        const bubble = document.createElement("div");
        bubble.className =
          item.role === "user"
            ? "live-overlay-bubble live-overlay-bubble-user"
            : "live-overlay-bubble live-overlay-bubble-assistant";
        bubble.textContent = item.content;
        messagesEl.appendChild(bubble);
      }
      scrollToBottom();
    }
  }

  function scrollToBottom(): void {
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function bindEvents(overlay: HTMLElement): void {
    const header = overlay.querySelector(".live-overlay-header") as HTMLElement | null;

    // 拖拽逻辑
    if (header) {
      header.addEventListener("pointerdown", onDragStart);
    }

    // 头部胶囊点击：结束伴看
    statusCapsuleEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deps.onStopLive) {
        deps.onStopLive();
      } else {
        void deps.getLiveController()?.stop();
      }
      hide();
    });

    // 音频设置菜单展示与切换
    audioBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!audioPopEl) return;
      const willOpen = audioPopEl.hidden;
      audioPopEl.hidden = !willOpen;
      if (willOpen) {
        syncAudioSwitches();
      }
    });

    audioPopEl?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    muteSwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      controller?.toggleMute();
      syncAudioSwitches();
    });

    shareAudioSwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setShareVideoAudio(!controller.isSharingVideoAudio());
        syncAudioSwitches();
      }
    });

    voicePrioritySwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setVoicePriority(!controller.isVoicePriority());
        syncAudioSwitches();
      }
    });

    // 最小化按钮
    minBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMinimize();
    });

    // 关闭按钮（隐藏浮窗，伴看后台继续）
    closeBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      hide();
    });

    // 清空按钮
    clearBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      clearMessages();
      deps.getLiveController()?.resetMerger?.();
      if (deps.onClearHistory) {
        void deps.onClearHistory();
      }
    });
  }

  function syncAudioSwitches(): void {
    const controller = deps.getLiveController();
    if (!controller) return;

    if (muteSwitchEl) {
      const isMuted = controller.isMuted();
      muteSwitchEl.setAttribute("aria-checked", String(!isMuted));
      muteSwitchEl.classList.toggle("is-active", !isMuted);
    }
    if (shareAudioSwitchEl) {
      const share = controller.isSharingVideoAudio();
      shareAudioSwitchEl.setAttribute("aria-checked", String(share));
      shareAudioSwitchEl.classList.toggle("is-active", share);
    }
    if (voicePrioritySwitchEl) {
      const prio = controller.isVoicePriority();
      voicePrioritySwitchEl.setAttribute("aria-checked", String(prio));
      voicePrioritySwitchEl.classList.toggle("is-active", prio);
    }
  }

  function toggleMinimize(): void {
    isMin = !isMin;
    if (rootEl) {
      rootEl.classList.toggle("is-minimized", isMin);
    }
    if (bodyEl) {
      bodyEl.hidden = isMin;
    }
    if (minBtnEl) {
      minBtnEl.title = isMin ? "展开" : "最小化";
      minBtnEl.setAttribute("aria-label", isMin ? "展开" : "最小化");
    }
  }

  // 拖拽处理
  function onDragStart(e: PointerEvent): void {
    // 排除交互控件点击触发拖拽
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, [role='switch'], input, .live-overlay-audio-popover")) {
      return;
    }
    if (!rootEl) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = rootEl.getBoundingClientRect();
    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();

    initialLeft = rect.left - hostRect.left;
    initialTop = rect.top - hostRect.top;

    rootEl.style.left = `${initialLeft}px`;
    rootEl.style.top = `${initialTop}px`;
    rootEl.style.right = "auto";
    rootEl.style.bottom = "auto";

    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  }

  function onDragMove(e: PointerEvent): void {
    if (!isDragging || !rootEl) return;
    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    const host = deps.getPlayerHost() || document.body;
    const hostRect = host.getBoundingClientRect();
    const rect = rootEl.getBoundingClientRect();

    let nextLeft = initialLeft + deltaX;
    let nextTop = initialTop + deltaY;

    // 边界限制在播放器区域内
    const maxLeft = Math.max(0, hostRect.width - rect.width);
    const maxTop = Math.max(0, hostRect.height - rect.height);

    nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    nextTop = Math.max(0, Math.min(nextTop, maxTop));

    rootEl.style.left = `${nextLeft}px`;
    rootEl.style.top = `${nextTop}px`;
  }

  function onDragEnd(): void {
    isDragging = false;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  }

  function show(): void {
    const el = ensureMounted();
    el.hidden = false;
    el.classList.remove("is-hidden");
    syncState();
    loadInitialHistory();
  }

  function hide(): void {
    if (rootEl) {
      rootEl.hidden = true;
      rootEl.classList.add("is-hidden");
    }
    if (audioPopEl) {
      audioPopEl.hidden = true;
    }
  }

  function toggle(): void {
    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  function isVisible(): boolean {
    return Boolean(rootEl && !rootEl.hidden && !rootEl.classList.contains("is-hidden"));
  }

  function isMinimized(): boolean {
    return isMin;
  }

  function syncState(customState?: LiveChatState, reconnecting?: boolean): void {
    if (!rootEl) return;
    const controller = deps.getLiveController();
    const state = customState ?? controller?.getState() ?? "idle";
    const isReconnecting = reconnecting ?? Boolean(controller?.isReconnecting?.());

    if (!statusTextEl || !statusDotEl) return;

    statusDotEl.className = "live-overlay-status-dot";

    if (isReconnecting) {
      statusTextEl.textContent = "重连中...";
      statusDotEl.classList.add("is-reconnecting");
    } else if (state === "connecting") {
      statusTextEl.textContent = "连接中...";
      statusDotEl.classList.add("is-connecting");
    } else if (state === "connected") {
      statusTextEl.textContent = "正在陪看";
      statusDotEl.classList.add("is-connected");
    } else if (state === "failure") {
      statusTextEl.textContent = "连接异常";
      statusDotEl.classList.add("is-failure");
    } else {
      statusTextEl.textContent = "已就绪";
    }

    syncAudioSwitches();
  }

  function updateVad(active: boolean): void {
    if (statusCapsuleEl) {
      statusCapsuleEl.classList.toggle("is-talking", active);
    }
    if (statusDotEl) {
      statusDotEl.classList.toggle("is-talking", active);
    }
  }

  function updateTranscript(event: MossLiveTranscriptEvent): void {
    if (!messagesEl || !event) return;

    switch (event.kind) {
      case "input.updated": {
        if (!pendingUserBubble) {
          pendingUserBubble = document.createElement("div");
          pendingUserBubble.className = "live-overlay-bubble live-overlay-bubble-user is-pending";
          messagesEl.appendChild(pendingUserBubble);
        }
        pendingUserBubble.textContent = event.text;
        scrollToBottom();
        break;
      }
      case "input.done": {
        if (!pendingUserBubble) {
          pendingUserBubble = document.createElement("div");
          pendingUserBubble.className = "live-overlay-bubble live-overlay-bubble-user";
          messagesEl.appendChild(pendingUserBubble);
        }
        pendingUserBubble.textContent = event.text;
        pendingUserBubble.classList.remove("is-pending");
        pendingUserBubble = null;
        scrollToBottom();
        break;
      }
      case "output.updated": {
        const { runId, turnId, text } = event;
        if (
          !currentAssistantBubble ||
          currentAssistantRunId !== runId ||
          currentAssistantTurnId !== turnId
        ) {
          currentAssistantBubble = document.createElement("div");
          currentAssistantBubble.className =
            "live-overlay-bubble live-overlay-bubble-assistant is-streaming";
          messagesEl.appendChild(currentAssistantBubble);
          currentAssistantRunId = runId;
          currentAssistantTurnId = turnId;
        }
        currentAssistantBubble.textContent = text;
        scrollToBottom();
        break;
      }
      case "output.done": {
        if (currentAssistantBubble) {
          currentAssistantBubble.textContent = event.text;
          currentAssistantBubble.classList.remove("is-streaming");
        }
        currentAssistantBubble = null;
        currentAssistantRunId = null;
        currentAssistantTurnId = null;
        scrollToBottom();
        break;
      }
      case "response.interrupted":
      case "response.ended": {
        if (currentAssistantBubble) {
          currentAssistantBubble.classList.remove("is-streaming");
        }
        currentAssistantBubble = null;
        currentAssistantRunId = null;
        currentAssistantTurnId = null;
        break;
      }
    }
  }

  function clearMessages(): void {
    if (messagesEl) {
      messagesEl.innerHTML = "";
    }
    pendingUserBubble = null;
    currentAssistantBubble = null;
    currentAssistantRunId = null;
    currentAssistantTurnId = null;
  }

  function getElement(): HTMLElement | null {
    return rootEl;
  }

  function dispose(): void {
    onDragEnd();
    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }
    pendingUserBubble = null;
    currentAssistantBubble = null;
  }

  return {
    show,
    hide,
    toggle,
    isVisible,
    isMinimized,
    syncState,
    updateVad,
    updateTranscript,
    clearMessages,
    getElement,
    dispose
  };
}
