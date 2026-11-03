// extension/live/live-chat-controller.ts
// AI 对话面板中 MOSS-LIVE 实时伴看的控制状态机与生命周期管理。
// 负责校验密钥与权限、与 Background/Offscreen 握手、更新 UI 状态并处理断连/清理。

import {
  MOSS_LIVE_PORT_NAME,
  resolveMossLiveWsUrl,
  type MossLiveServerEvent
} from "./moss-live-protocol.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { sendRuntimeMessage as defaultSendRuntimeMessage } from "../shared/messaging.js";

export type LiveChatState = "idle" | "connecting" | "connected" | "failure";

export interface LiveChatControllerDeps {
  liveButton: HTMLElement;
  getTargetOrigin?: () => string;
  showNotice?: (message: string, autoHideMs?: number) => void;
  connectPort?: () => chrome.runtime.Port;
  sendRuntimeMessage?: typeof defaultSendRuntimeMessage;
  requestOrigins?: typeof requestProviderOriginsViaBackground;
}

export interface LiveChatController {
  getState(): LiveChatState;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export function createLiveChatController(deps: LiveChatControllerDeps): LiveChatController {
  const {
    liveButton,
    getTargetOrigin,
    showNotice = () => {},
    connectPort = () => chrome.runtime.connect({ name: MOSS_LIVE_PORT_NAME }),
    sendRuntimeMessage = defaultSendRuntimeMessage,
    requestOrigins = requestProviderOriginsViaBackground
  } = deps;

  let state: LiveChatState = "idle";
  let currentGeneration = 0;
  let activePort: chrome.runtime.Port | null = null;
  let activeSessionId: string | null = null;
  let activeTargetOrigin = "https://api.mosi.cn";

  function updateUi(nextState: LiveChatState, errorMessage?: string): void {
    state = nextState;
    liveButton.dataset.state = nextState;
    liveButton.classList.toggle("is-connecting", nextState === "connecting");
    liveButton.classList.toggle("is-connected", nextState === "connected");
    liveButton.classList.toggle("is-failure", nextState === "failure");

    liveButton.setAttribute("aria-busy", nextState === "connecting" ? "true" : "false");
    liveButton.setAttribute("aria-pressed", nextState === "connected" ? "true" : "false");

    let tooltip = "开启实时伴看 (MOSS-LIVE)";
    if (nextState === "connecting") {
      tooltip = "正在连接 MOSS-LIVE 伴看...";
    } else if (nextState === "connected") {
      tooltip = "正在伴看中，点击结束伴看";
    } else if (nextState === "failure") {
      tooltip = errorMessage ? `伴看失败：${errorMessage}，点击重试` : "伴看失败，点击重试";
    }
    liveButton.title = tooltip;
    liveButton.setAttribute("aria-label", tooltip);
  }

  // 初始化 UI 呈现
  updateUi("idle");

  async function cleanupSessionRule(targetSessionId?: string): Promise<void> {
    try {
      await sendRuntimeMessage({ type: "live-session-cleanup", sessionId: targetSessionId });
    } catch {
      // 忽略清理阶段的发送失败
    }
  }

  async function start(): Promise<boolean> {
    if (state === "connecting" || state === "connected") {
      return true;
    }

    currentGeneration += 1;
    const generation = currentGeneration;
    const sessionId = `live-${generation}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeSessionId = sessionId;
    updateUi("connecting");

    // 1. 同步发起平台域名权限申请（保留 Chrome user gesture 上下文，调用前零先行 await）。
    // 优先取宿主提供的目标源（自定义平台），未配置或缺省时回落至默认官方域名（https://api.mosi.cn）。
    const targetOrigin = (getTargetOrigin?.() || activeTargetOrigin || "https://api.mosi.cn").trim();
    const permPromise = requestOrigins([targetOrigin]);

    let permResult: { ok: boolean; error?: string };
    try {
      permResult = await permPromise;
    } catch (error) {
      if (generation !== currentGeneration) {
        void cleanupSessionRule(sessionId);
        return false;
      }
      const errorMsg = `权限申请异常：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      return false;
    }

    if (generation !== currentGeneration) {
      void cleanupSessionRule(sessionId);
      return false;
    }

    if (!permResult.ok) {
      const errorMsg = permResult.error || "未授予平台域名权限，无法建立伴看连接";
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      return false;
    }

    // 2. 委托 Background 验证密钥、配置 DNR 会话规则并确保 Offscreen 文档
    let prepResp: any;
    try {
      prepResp = await sendRuntimeMessage({ type: "live-session-prepare", sessionId });
    } catch (error) {
      if (generation !== currentGeneration) {
        void cleanupSessionRule(sessionId);
        return false;
      }
      const errorMsg = `启动服务通信失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      return false;
    }

    if (generation !== currentGeneration) {
      // 若 prepare 在途期间已触发 stop()，必须立即清理刚刚安装的 DNR 规则与会话
      void cleanupSessionRule(sessionId);
      return false;
    }

    if (!prepResp?.ok) {
      const errorMsg = prepResp?.error || "伴看会话准备失败";
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      return false;
    }

    if (prepResp.provider?.baseUrl) {
      activeTargetOrigin = prepResp.provider.baseUrl;
    }

    // 3. 连接 Offscreen 文档专属端口并触发 WebSocket 连接
    let port: chrome.runtime.Port;
    try {
      port = connectPort();
      activePort = port;
    } catch (error) {
      const errorMsg = `连接后台通信端口失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      void cleanupSessionRule(sessionId);
      return false;
    }

    port.onMessage.addListener((rawMsg: unknown) => {
      // 代际检查：拒绝或忽略迟到的历史会话事件
      if (generation !== currentGeneration) return;

      const msg = rawMsg as MossLiveServerEvent;
      if (!msg) return;

      if (msg.type === "connecting") {
        updateUi("connecting");
      } else if (msg.type === "connected") {
        updateUi("connected");
      } else if (msg.type === "error") {
        const errorMsg = msg.error || "MOSS-LIVE 连接异常中断";
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      } else if (msg.type === "closed") {
        if (state === "connecting" || state === "connected") {
          const errorMsg = "MOSS-LIVE 连接已关闭";
          updateUi("failure", errorMsg);
          showNotice(errorMsg);
          disconnectPort();
          void cleanupSessionRule(sessionId);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (generation !== currentGeneration) return;
      if (state === "connecting" || state === "connected") {
        const errorMsg = "后台伴看通道已断开";
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      }
    });

    const wsUrl = resolveMossLiveWsUrl(prepResp.provider?.baseUrl, prepResp.provider?.model);
    try {
      port.postMessage({ action: "start", wsUrl });
    } catch (error) {
      const errorMsg = `下发启动指令失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      disconnectPort();
      void cleanupSessionRule(sessionId);
      return false;
    }

    return true;
  }

  function disconnectPort(): void {
    if (activePort) {
      try {
        activePort.disconnect();
      } catch {}
      activePort = null;
    }
  }

  async function stop(): Promise<void> {
    currentGeneration += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    if (activePort) {
      try {
        activePort.postMessage({ action: "stop" });
      } catch {}
      disconnectPort();
    }
    updateUi("idle");
    await cleanupSessionRule(stoppingSessionId || undefined);
  }

  async function toggle(): Promise<void> {
    if (state === "connected" || state === "connecting") {
      await stop();
    } else {
      await start();
    }
  }

  function dispose(): void {
    void stop();
  }

  return {
    getState: () => state,
    start,
    stop,
    toggle,
    dispose
  };
}
