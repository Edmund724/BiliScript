// extension/live/live-chat-controller.ts
// AI 对话面板中 MOSS-LIVE 实时伴看的控制状态机与生命周期管理。
// 负责校验密钥与权限、采集麦克风音频与视频帧、管理静音/挂断、转发双端字幕与联网查证状态并处理断连/清理。

import {
  MOSS_LIVE_PORT_NAME,
  encodeBase64Bytes,
  resolveMossLiveWsUrl,
  type MossLiveServerEvent,
  type MossLiveToolCall,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "./moss-live-protocol.js";
import {
  createPageAudioCapture,
  type PageAudioCaptureOptions,
  type PageAudioCaptureSession
} from "./page-media-capture.js";
import {
  createPageVideoFrameCapture,
  type PageVideoFrameCaptureOptions,
  type PageVideoFrameCaptureSession
} from "./page-video-frame-capture.js";
import {
  createPageVideoDuck,
  type PageVideoDuckSession
} from "./page-video-duck.js";
import type { LiveTranscriptMerger } from "./live-transcript-merger.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { sendRuntimeMessage as defaultSendRuntimeMessage } from "../shared/messaging.js";

export type LiveChatState = "idle" | "connecting" | "connected" | "failure";

export interface LiveChatControllerDeps {
  liveButton: HTMLElement;
  muteButton?: HTMLElement | null;
  getTargetOrigin?: () => string;
  showNotice?: (message: string, autoHideMs?: number) => void;
  connectPort?: () => chrome.runtime.Port;
  sendRuntimeMessage?: typeof defaultSendRuntimeMessage;
  requestOrigins?: typeof requestProviderOriginsViaBackground;
  startAudioCapture?: (options: PageAudioCaptureOptions) => Promise<PageAudioCaptureSession>;
  startVideoCapture?: (options: PageVideoFrameCaptureOptions) => PageVideoFrameCaptureSession;
  createVideoDuck?: () => PageVideoDuckSession;
  createTranscriptMerger?: () => LiveTranscriptMerger;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  getVideoContext?: () => MossLiveVideoContext | null;
  executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
  subscribeVideoContextChanges?: (listener: () => void) => () => void;
}

export interface LiveChatController {
  getState(): LiveChatState;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  toggleMute(): void;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export function createLiveChatController(deps: LiveChatControllerDeps): LiveChatController {
  const {
    liveButton,
    muteButton = null,
    getTargetOrigin,
    showNotice = () => {},
    connectPort = () => chrome.runtime.connect({ name: MOSS_LIVE_PORT_NAME }),
    sendRuntimeMessage = defaultSendRuntimeMessage,
    requestOrigins = requestProviderOriginsViaBackground,
    startAudioCapture = createPageAudioCapture,
    startVideoCapture = createPageVideoFrameCapture,
    createVideoDuck = createPageVideoDuck,
    createTranscriptMerger,
    onTranscript,
    getVideoContext,
    executeTool,
    subscribeVideoContextChanges
  } = deps;

  let state: LiveChatState = "idle";
  let muted = false;
  let currentGeneration = 0;
  let activePort: chrome.runtime.Port | null = null;
  let activeSessionId: string | null = null;
  let activeAudioCapture: PageAudioCaptureSession | null = null;
  let activeVideoCapture: PageVideoFrameCaptureSession | null = null;
  let activeVideoDuck: PageVideoDuckSession | null = null;
  let activeMerger: LiveTranscriptMerger | null = null;
  let activeTargetOrigin = "https://api.mosi.cn";

  function updateMuteUi(): void {
    if (!muteButton) return;
    const isConnected = state === "connected";
    muteButton.hidden = !isConnected;
    muteButton.classList.toggle("is-muted", muted);
    muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
    const label = muted ? "取消静音麦克风" : "静音麦克风";
    muteButton.title = label;
    muteButton.setAttribute("aria-label", label);
  }

  function updateUi(nextState: LiveChatState, errorMessage?: string): void {
    state = nextState;
    if (nextState !== "connected") {
      muted = false;
    }
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
    updateMuteUi();
  }

  // 初始化 UI 呈现
  updateUi("idle");

  function stopActiveMediaAndMerger(): void {
    if (activeAudioCapture) {
      try {
        activeAudioCapture.stop();
      } catch {}
      activeAudioCapture = null;
    }
    if (activeVideoCapture) {
      try {
        activeVideoCapture.stop();
      } catch {}
      activeVideoCapture = null;
    }
    if (activeVideoDuck) {
      try {
        activeVideoDuck.stop();
      } catch {}
      activeVideoDuck = null;
    }
    if (activeMerger) {
      try {
        activeMerger.dispose();
      } catch {}
      activeMerger = null;
    }
  }

  function startActiveVideoCapture(generation: number): void {
    if (activeVideoCapture || generation !== currentGeneration || state !== "connected") return;
    try {
      activeVideoCapture = startVideoCapture({
        onJpegFrame: (jpegBytes) => {
          if (generation !== currentGeneration || state !== "connected" || !activePort) return;
          try {
            activePort.postMessage({
              action: "video",
              jpegBase64: encodeBase64Bytes(jpegBytes)
            });
          } catch {
            // 忽略断连瞬间的发送异常
          }
        }
      });
    } catch {
      activeVideoCapture = null;
    }
  }

  async function cleanupSessionRule(targetSessionId?: string): Promise<void> {
    try {
      await sendRuntimeMessage({ type: "live-session-cleanup", sessionId: targetSessionId });
    } catch {
      // 忽略清理阶段的发送失败
    }
  }

  let stopVideoContextWatch: (() => void) | null = null;

  function readVideoContext(): MossLiveVideoContext | null {
    try {
      return getVideoContext?.() || null;
    } catch {
      return null;
    }
  }

  function postVideoContext(context: MossLiveVideoContext | null): void {
    if (!activePort) return;
    try {
      activePort.postMessage({ action: "context_update", videoContext: context });
    } catch {}
  }

  function syncVideoContext(): void {
    postVideoContext(readVideoContext());
  }

  function watchVideoContext(generation: number): void {
    const guardedSync = () => {
      if (generation === currentGeneration) syncVideoContext();
    };
    const handleUrlChange = () => {
      if (generation !== currentGeneration) return;
      postVideoContext(null);
      guardedSync();
    };
    window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
    const unsubscribe = subscribeVideoContextChanges?.(guardedSync) || (() => {});
    stopVideoContextWatch = () => {
      window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
      unsubscribe();
      stopVideoContextWatch = null;
    };
  }

  async function start(): Promise<boolean> {
    if (state === "connecting" || state === "connected") {
      return true;
    }

    currentGeneration += 1;
    const generation = currentGeneration;
    const sessionId = `live-${generation}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeSessionId = sessionId;
    muted = false;
    stopActiveMediaAndMerger();
    updateUi("connecting");

    // 1. 同步发起平台域名权限申请（保留 Chrome user gesture 上下文，调用前零先行 await）。
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

    // 3. 请求麦克风授权并启动 16kHz 单声道 20ms PCM 采集
    let captureSession: PageAudioCaptureSession;
    try {
      captureSession = await startAudioCapture({
        initialMuted: false,
        onPcmFrame: (pcmBytes) => {
          if (generation !== currentGeneration || state !== "connected" || muted || !activePort) {
            return;
          }
          try {
            activePort.postMessage({
              action: "audio",
              pcmBase64: encodeBase64Bytes(pcmBytes)
            });
          } catch {
            // 忽略断连瞬间的发送异常
          }
        }
      });
    } catch (error) {
      void cleanupSessionRule(sessionId);
      if (generation !== currentGeneration) {
        return false;
      }
      const errorMsg = (error as Error)?.message || String(error || "麦克风授权或启动失败");
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      return false;
    }

    if (generation !== currentGeneration) {
      captureSession.stop();
      void cleanupSessionRule(sessionId);
      return false;
    }
    activeAudioCapture = captureSession;

    // 4. 创建本轮会话专属双端字幕归并器并连接 Offscreen 端口
    activeMerger = createTranscriptMerger ? createTranscriptMerger() : null;

    let port: chrome.runtime.Port;
    try {
      port = connectPort();
      activePort = port;
    } catch (error) {
      stopActiveMediaAndMerger();
      const errorMsg = `连接后台通信端口失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg);
      showNotice(errorMsg);
      void cleanupSessionRule(sessionId);
      return false;
    }

    port.onMessage.addListener((rawMsg: unknown) => {
      // 代际检查：严格拦截挂断或旧会话的迟到事件
      if (generation !== currentGeneration) return;

      const msg = rawMsg as MossLiveServerEvent;
      if (!msg) return;

      if (msg.type === "connecting") {
        updateUi("connecting");
      } else if (msg.type === "connected") {
        updateUi("connected");
        if (getVideoContext) syncVideoContext();
        startActiveVideoCapture(generation);
      } else if (msg.type === "transcript") {
        if (state === "connected" || state === "connecting") {
          activeMerger?.handleEvent(msg.event);
          onTranscript?.(msg.event);
        }
      } else if (msg.type === "duck_video") {
        if (state === "connected" || state === "connecting") {
          if (!activeVideoDuck && msg.active) {
            try {
              activeVideoDuck = createVideoDuck();
            } catch {}
          }
          activeVideoDuck?.setDucked(msg.active);
        }
      } else if (msg.type === "tool_call") {
        const postToolResult = (result: unknown) => {
          if (generation !== currentGeneration || !activePort) return;
          try {
            activePort.postMessage({ action: "tool_result", callId: msg.call.callId, result });
          } catch {}
        };
        void Promise.resolve()
          .then(() => executeTool
            ? executeTool(msg.call)
            : { ok: false, error: "当前页面未接入页面工具执行器" })
          .then(postToolResult)
          .catch((error) => {
            postToolResult({ ok: false, error: `页面工具执行失败：${(error as Error)?.message || String(error)}` });
          });
      } else if (msg.type === "tool_error") {
        showNotice(msg.error, 4000);
      } else if (msg.type === "tool_status") {
        const event = msg.event;
        const querySuffix = event.query ? `：${event.query}` : "";
        if (event.status === "searching") {
          showNotice(`正在联网查证${querySuffix}`, 35000);
        } else if (event.status === "done") {
          showNotice(`联网查证完成${querySuffix}（${event.resultCount || 0} 条结果）`);
        } else if (event.status === "no_results") {
          showNotice(`联网查证无结果${querySuffix}`, 6000);
        } else {
          showNotice(`联网查证失败${querySuffix}${event.error ? `：${event.error}` : ""}`, 6000);
        }
      } else if (msg.type === "error") {
        const errorMsg = msg.error || "MOSS-LIVE 连接异常中断";
        stopActiveMediaAndMerger();
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      } else if (msg.type === "closed") {
        if (state === "connecting" || state === "connected") {
          const errorMsg = "MOSS-LIVE 连接已关闭";
          stopActiveMediaAndMerger();
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
        stopActiveMediaAndMerger();
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      }
    });

    const wsUrl = resolveMossLiveWsUrl(prepResp.provider?.baseUrl, prepResp.provider?.model);
    if (getVideoContext) {
      watchVideoContext(generation);
    }
    try {
      port.postMessage({
        action: "start",
        wsUrl,
        ...(getVideoContext ? { videoContext: readVideoContext() } : {})
      });
    } catch (error) {
      stopActiveMediaAndMerger();
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
    stopVideoContextWatch?.();
    if (activePort) {
      try {
        activePort.disconnect();
      } catch {}
      activePort = null;
    }
  }

  function setMuted(nextMuted: boolean): void {
    if (state !== "connected") return;
    muted = Boolean(nextMuted);
    activeAudioCapture?.setMuted(muted);
    updateMuteUi();
    if (activePort) {
      try {
        activePort.postMessage({ action: "mic_state", enabled: !muted });
      } catch {}
    }
  }

  function toggleMute(): void {
    setMuted(!muted);
  }

  async function stop(): Promise<void> {
    currentGeneration += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    stopActiveMediaAndMerger();
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
    isMuted: () => muted,
    setMuted,
    toggleMute,
    start,
    stop,
    toggle,
    dispose
  };
}
