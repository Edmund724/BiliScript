// extension/live/live-chat-controller.ts
// AI 对话面板中实时伴看的控制状态机与生命周期管理。
// 负责校验密钥与权限、采集麦克风音频与视频帧、管理静音/挂断、转发双端字幕与联网查证状态并处理断连/清理。

import {
  MOSS_LIVE_PORT_NAME,
  formatLiveCloseDiagnostics,
  encodeBase64Bytes,
  resolveGeminiLiveWsUrl,
  resolveMossLivePermissionOrigins,
  resolveMossLiveWsUrl,
  type LiveProviderType,
  type MossLiveServerEvent,
  type MossLiveToolCall,
  type MossLiveTranscriptEvent,
  type MossLiveSessionContext
} from "./moss-live-protocol.js";
import {
  DEFAULT_LIVE_MODEL,
  liveProviderStore,
  resolveActiveLiveProviderId
} from "./live-provider-store.js";
import { createLiveToolsBridge } from "./live-tools-bridge.js";
import {
  createPageAudioCapture,
  type PageAudioCaptureOptions,
  type PageAudioCaptureSession,
  type VideoAudioTrackStatus
} from "./page-media-capture.js";
import {
  createPageVideoFrameCapture,
  type PageVideoFrameCaptureOptions,
  type PageVideoFrameCaptureSession
} from "./page-video-frame-capture.js";
import type { LiveTranscriptMerger } from "./live-transcript-merger.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { sendRuntimeMessage as defaultSendRuntimeMessage } from "../shared/messaging.js";

export type LiveChatState = "idle" | "connecting" | "connected" | "failure";
export const DEFAULT_LIVE_DUCK_RATIO = 0.2;

export interface LiveReconnectingInfo {
  attempt: number;
  maxAttempts: number;
  code?: number;
  reason?: string;
  error?: string;
  notice: string;
}

export interface LiveChatControllerDeps {
  liveButton?: HTMLElement | null;
  muteButton?: HTMLElement | null;
  volumeControl?: HTMLDetailsElement | null;
  initialVolume?: number;
  initialSpeed?: number;
  initialVoicePriority?: boolean;
  initialShareVideoAudio?: boolean;
  duckRatio?: number;
  getVideoElement?: () => HTMLVideoElement | null;
  onVoicePriorityChange?: (enabled: boolean) => void;
  onShareVideoAudioChange?: (enabled: boolean) => void;
  // 中断键复用输入栏最右侧的发送/停止同键（组合根传 sendBtn）：说话期间挂
  // .is-live-interrupt 类切停止键形态，点击路由由组合根决定。
  interruptButton?: HTMLElement | null;
  onInterruptStateChange?: (active: boolean) => void;
  onStateChange?: (state: LiveChatState, error?: string) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onReconnecting?: (info: LiveReconnectingInfo) => void;
  onVadStateChange?: (active: boolean) => void;
  onVideoAudioStatusChange?: (status: VideoAudioTrackStatus) => void;
  getTargetOrigin?: () => string;
  getTargetModel?: () => string;
  getTargetProviderType?: () => LiveProviderType;
  showNotice?: (message: string, autoHideMs?: number) => void;
  connectPort?: () => chrome.runtime.Port;
  sendRuntimeMessage?: typeof defaultSendRuntimeMessage;
  requestOrigins?: typeof requestProviderOriginsViaBackground;
  startAudioCapture?: (options: PageAudioCaptureOptions) => Promise<PageAudioCaptureSession>;
  startVideoCapture?: (options: PageVideoFrameCaptureOptions) => PageVideoFrameCaptureSession;
  createTranscriptMerger?: (opts?: { isVoiceRecentlyActive?: () => boolean }) => LiveTranscriptMerger;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  getVideoContext?: () => MossLiveSessionContext | null;
  executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
  subscribeVideoContextChanges?: (listener: () => void) => () => void;
}

export interface LiveChatController {
  getState(): LiveChatState;
  getSavedSessionId?(): string | null;
  isMuted(): boolean;
  isSpeaking(): boolean;
  isReconnecting?(): boolean;
  getVideoAudioStatus(): VideoAudioTrackStatus;
  isMicVadActive(): boolean;
  setShareVideoAudio(enabled: boolean): void;
  isSharingVideoAudio(): boolean;
  setVoicePriority(enabled: boolean): void;
  isVoicePriority(): boolean;
  isDucked(): boolean;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  setSpeed(speed: number): void;
  getSpeed(): number;
  toggleMute(): void;
  interrupt(): void;
  refreshTarget(): Promise<void>;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  resetMerger?(): void;
  dispose(): void;
}

export function createLiveChatController(deps: LiveChatControllerDeps): LiveChatController {
  const {
    liveButton = null,
    muteButton = null,
    volumeControl = null,
    initialVolume = 1,
    initialSpeed = 1,
    initialVoicePriority = true,
    initialShareVideoAudio = false,
    duckRatio = DEFAULT_LIVE_DUCK_RATIO,
    getVideoElement = null,
    onVoicePriorityChange,
    onShareVideoAudioChange,
    interruptButton = null,
    onInterruptStateChange,
    onStateChange,
    onSpeakingChange,
    onReconnecting,
    onVadStateChange,
    onVideoAudioStatusChange,
    getTargetOrigin,
    getTargetModel,
    getTargetProviderType,
    showNotice = () => {},
    connectPort = () => chrome.runtime.connect({ name: MOSS_LIVE_PORT_NAME }),
    sendRuntimeMessage = defaultSendRuntimeMessage,
    requestOrigins = requestProviderOriginsViaBackground,
    startAudioCapture = createPageAudioCapture,
    startVideoCapture = createPageVideoFrameCapture,
    createTranscriptMerger,
    onTranscript,
    getVideoContext,
    executeTool,
    subscribeVideoContextChanges
  } = deps;

  const defaultToolsBridge = (!getVideoContext || !executeTool)
    ? createLiveToolsBridge({ showNotice })
    : null;
  const resolveVideoContext = getVideoContext ?? defaultToolsBridge!.getVideoContext;
  const resolveExecuteTool = executeTool ?? defaultToolsBridge!.executeTool;

  let state: LiveChatState = "idle";
  let muted = false;
  let speaking = false;
  let voicePriority = initialVoicePriority !== false;
  let shareVideoAudio = Boolean(initialShareVideoAudio);
  let micVadActive = false;
  let isDucked = false;
  let originalVideoVolume: number | null = null;
  let currentVideoAudioStatus: VideoAudioTrackStatus = "未开启";
  const effectiveDuckRatio = Number.isFinite(duckRatio) && duckRatio >= 0 && duckRatio <= 1 ? duckRatio : DEFAULT_LIVE_DUCK_RATIO;
  const resolveVideoElement = getVideoElement ?? getRuntimeVideoElement;
  let volume = Number.isFinite(initialVolume) ? Math.max(0, Math.min(1, initialVolume)) : 1;
  let speed = Number.isFinite(initialSpeed) && initialSpeed > 0 ? initialSpeed : 1;
  let currentGeneration = 0;
  function shouldDuck(): boolean {
    if (!voicePriority) return false;
    if (state !== "connected") return false;
    const userTalking = !muted && micVadActive;
    return Boolean(userTalking || speaking);
  }

  function syncVideoDucking(): void {
    const targetShouldDuck = shouldDuck();
    if (targetShouldDuck === isDucked) return;

    const video = resolveVideoElement();
    if (targetShouldDuck) {
      if (video) {
        originalVideoVolume = video.volume;
        const targetVol = Math.max(0, Math.min(1, originalVideoVolume * effectiveDuckRatio));
        try {
          video.volume = targetVol;
        } catch {}
      }
      isDucked = true;
    } else {
      if (video && originalVideoVolume !== null) {
        try {
          video.volume = originalVideoVolume;
        } catch {}
      }
      originalVideoVolume = null;
      isDucked = false;
    }
  }

  let activePort: chrome.runtime.Port | null = null;
  let activeSessionId: string | null = null;
  let savedMossSessionId: string | null = null;
  let activeAudioCapture: PageAudioCaptureSession | null = null;
  let reconnecting = false;
  let activeVideoCapture: PageVideoFrameCaptureSession | null = null;
  let activeMerger: LiveTranscriptMerger | null = null;
  let activeTargetOrigin = "https://api.mosi.cn";
  let activeTargetModel = DEFAULT_LIVE_MODEL;
  let activeTargetProviderType: LiveProviderType = "moss-live";

  async function refreshTarget(): Promise<void> {
    try {
      const [providers, syncSettings] = await Promise.all([
        liveProviderStore.loadProviders(),
        chrome.storage.sync.get(["activeLiveProviderId"])
      ]);
      const rawActiveId = (syncSettings as Record<string, unknown> | undefined)?.activeLiveProviderId;
      const activeId = resolveActiveLiveProviderId(
        providers,
        typeof rawActiveId === "string" ? rawActiveId : undefined
      );
      const active = providers.find((p) => p.id === activeId);
      activeTargetProviderType =
        active?.type === "gemini-live" || active?.presetId === "gemini-live"
          ? "gemini-live"
          : "moss-live";
      activeTargetOrigin =
        active?.baseUrl ||
        (activeTargetProviderType === "gemini-live"
          ? "https://generativelanguage.googleapis.com"
          : "https://api.mosi.cn");
      activeTargetModel = active?.model || DEFAULT_LIVE_MODEL;
    } catch {
      // 忽略加载错误
    }
  }

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

  function updateInterruptUi(): void {
    if (!interruptButton) return;
    // 中断键复用输入栏最右侧的发送/停止同键（文本对话流式时的停止键形态），不新增
    // 专用按钮：说话期间挂 .is-live-interrupt 切停止图标（与 .is-stop 同视觉，但两个
    // 类各归各的驱动方、互不覆盖）。禁用态经 onInterruptStateChange 通知 composer
    // 统一同步，未传回调时回退为直接切换 disabled。
    // label 回落按文本流式相位（.is-stop）还原，不复读旧值。
    const shouldShow = state === "connected" && speaking;
    interruptButton.classList.toggle("is-live-interrupt", shouldShow);
    if (shouldShow) {
      interruptButton.setAttribute("aria-label", "打断当前回答");
      interruptButton.setAttribute("title", "打断当前回答");
    } else {
      interruptButton.removeAttribute("title");
      interruptButton.setAttribute(
        "aria-label",
        interruptButton.classList.contains("is-stop") ? "停止" : "发送"
      );
    }
    if (interruptButton instanceof HTMLButtonElement) {
      interruptButton.disabled = !shouldShow;
    }
    onInterruptStateChange?.(shouldShow);
    onSpeakingChange?.(speaking);
  }

  function updateUi(nextState: LiveChatState, errorMessage?: string): void {
    state = nextState;
    if (nextState !== "connecting") {
      reconnecting = false;
    }
    if (nextState !== "connected") {
      muted = false;
      speaking = false;
      micVadActive = false;
    }
    syncVideoDucking();
    if (liveButton) {
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
    if (volumeControl) {
      volumeControl.hidden = nextState !== "connected";
      if (nextState !== "connected") volumeControl.open = false;
    }
    updateMuteUi();
    updateInterruptUi();
    onStateChange?.(nextState, errorMessage);
  }

  // 初始化 UI 呈现
  updateUi("idle");

  function stopActiveMediaAndMerger(): void {
    micVadActive = false;
    currentVideoAudioStatus = "未开启";
    syncVideoDucking();
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
  let lastPostedContextJson: string | null = null;

  function readVideoContext(): MossLiveSessionContext | null {
    try {
      return resolveVideoContext() || null;
    } catch {
      return null;
    }
  }

  function postVideoContext(context: MossLiveSessionContext | null): void {
    if (!activePort) return;
    const nextJson = JSON.stringify(context);
    if (nextJson === lastPostedContextJson) return;
    lastPostedContextJson = nextJson;
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
    const targetProviderType: LiveProviderType =
      (getTargetProviderType?.() || activeTargetProviderType) === "gemini-live"
        ? "gemini-live"
        : "moss-live";
    const targetOrigin = (
      getTargetOrigin?.() ||
      activeTargetOrigin ||
      (targetProviderType === "gemini-live"
        ? "https://generativelanguage.googleapis.com"
        : "https://api.mosi.cn")
    ).trim();
    const targetModel = (getTargetModel?.() || activeTargetModel || DEFAULT_LIVE_MODEL).trim();
    const permPromise = requestOrigins(
      resolveMossLivePermissionOrigins(targetOrigin, targetModel, targetProviderType)
    );

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

    const resolvedProviderType: LiveProviderType =
      prepResp.provider?.type === "gemini-live"
        ? "gemini-live"
        : prepResp.provider?.type === "moss-live"
          ? "moss-live"
          : targetProviderType;
    activeTargetProviderType = resolvedProviderType;
    if (prepResp.provider?.baseUrl) {
      activeTargetOrigin = prepResp.provider.baseUrl;
    }
    if (prepResp.provider?.model) {
      activeTargetModel = prepResp.provider.model;
    }

    // 3. 请求麦克风授权并启动 16kHz 单声道 20ms PCM 采集
    let captureSession: PageAudioCaptureSession;
    try {
      captureSession = await startAudioCapture({
        initialMuted: false,
        shareVideoAudio,
        onVadStateChange: (active) => {
          if (generation !== currentGeneration) return;
          micVadActive = Boolean(active);
          onVadStateChange?.(active);
          syncVideoDucking();
        },
        onVideoAudioStatusChange: (status) => {
          if (generation !== currentGeneration) return;
          currentVideoAudioStatus = status;
          onVideoAudioStatusChange?.(status);
        },
        onPcmFrame: (pcmBytes) => {
          if (generation !== currentGeneration || state !== "connected" || !activePort) {
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
    activeMerger = createTranscriptMerger
      ? createTranscriptMerger({
          isVoiceRecentlyActive: () => activeAudioCapture?.isVoiceRecentlyActive() ?? true
        })
      : null;

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

      if (msg.type === "session_attached") {
        if (msg.sessionId) {
          savedMossSessionId = msg.sessionId;
        }
      } else if (msg.type === "connecting") {
        updateUi("connecting");
      } else if (msg.type === "connected") {
        if (msg.sessionId) {
          savedMossSessionId = msg.sessionId;
        }
        updateUi("connected");
        syncVideoContext();
        startActiveVideoCapture(generation);
      } else if (msg.type === "speaking_state") {
        if (state === "connected" || state === "connecting") {
          speaking = Boolean(msg.speaking);
          updateInterruptUi();
          syncVideoDucking();
        }
      } else if (msg.type === "transcript") {
        if (state === "connected" || state === "connecting") {
          activeMerger?.handleEvent(msg.event);
          onTranscript?.(msg.event);
        }
      } else if (msg.type === "tool_call") {
        const postToolResult = (result: unknown) => {
          if (generation !== currentGeneration || !activePort) return;
          try {
            activePort.postMessage({ action: "tool_result", callId: msg.call.callId, result });
          } catch {}
        };
        void Promise.resolve()
          .then(() => resolveExecuteTool(msg.call))
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
      } else if (msg.type === "reconnecting") {
        reconnecting = true;
        const notice = formatLiveCloseDiagnostics({
          isReconnect: true,
          attempt: msg.attempt,
          maxAttempts: msg.maxAttempts,
          code: msg.code,
          reason: msg.reason,
          error: msg.error
        });
        updateUi("connecting", notice);
        showNotice(notice, 6000);
        onReconnecting?.({
          attempt: msg.attempt,
          maxAttempts: msg.maxAttempts,
          code: msg.code,
          reason: msg.reason,
          error: msg.error,
          notice
        });
      } else if (msg.type === "error") {
        const errorMsg = formatLiveCloseDiagnostics({
          code: msg.code,
          reason: msg.reason,
          error: msg.error || "MOSS-LIVE 连接异常中断"
        });
        stopActiveMediaAndMerger();
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      } else if (msg.type === "closed") {
        if (state === "connecting" || state === "connected") {
          const errorMsg = formatLiveCloseDiagnostics({
            code: msg.code,
            reason: msg.reason,
            error: msg.error || "MOSS-LIVE 连接已关闭"
          });
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
        const errorMsg = formatLiveCloseDiagnostics({
          error: "后台伴看通道已断开"
        });
        stopActiveMediaAndMerger();
        updateUi("failure", errorMsg);
        showNotice(errorMsg);
        disconnectPort();
        void cleanupSessionRule(sessionId);
      }
    });

    const resolvedModel = prepResp.provider?.model || targetModel;
    const wsUrl =
      resolvedProviderType === "gemini-live"
        ? resolveGeminiLiveWsUrl(prepResp.provider?.baseUrl || targetOrigin)
        : resolveMossLiveWsUrl(prepResp.provider?.baseUrl || targetOrigin, resolvedModel);
    const initialVideoContext = readVideoContext();
    lastPostedContextJson = JSON.stringify(initialVideoContext);
    watchVideoContext(generation);
    try {
      port.postMessage({
        action: "start",
        wsUrl,
        providerType: resolvedProviderType,
        model: resolvedModel,
        volume,
        ...(savedMossSessionId ? { sessionId: savedMossSessionId } : {}),
        ...(speed !== 1 ? { speed } : {}),
        ...(typeof prepResp.liveGeminiNativeSearch === "boolean"
          ? { liveGeminiNativeSearch: prepResp.liveGeminiNativeSearch }
          : {}),
        ...(initialVideoContext || getVideoContext ? { videoContext: initialVideoContext } : {})
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
    lastPostedContextJson = null;
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
    updateInterruptUi();
    syncVideoDucking();
    if (activePort) {
      try {
        activePort.postMessage({ action: "mic_state", enabled: !muted });
      } catch {}
    }
  }

  function setVolume(nextVolume: number): void {
    volume = Number.isFinite(nextVolume) ? Math.max(0, Math.min(1, nextVolume)) : 1;
    if (!activePort) return;
    try {
      activePort.postMessage({ action: "set_volume", volume });
    } catch {}
  }

  function setSpeed(nextSpeed: number): void {
    speed = Number.isFinite(nextSpeed) && nextSpeed > 0 ? nextSpeed : 1;
    if (!activePort) return;
    try {
      activePort.postMessage({ action: "set_speed", speed });
    } catch {}
  }

  function toggleMute(): void {
    setMuted(!muted);
  }


  function setVoicePriority(enabled: boolean): void {
    voicePriority = Boolean(enabled);
    syncVideoDucking();
    onVoicePriorityChange?.(voicePriority);
  }

  function setShareVideoAudio(enabled: boolean): void {
    shareVideoAudio = Boolean(enabled);
    activeAudioCapture?.setShareVideoAudio(shareVideoAudio);
    if (!shareVideoAudio) {
      currentVideoAudioStatus = "未开启";
      onVideoAudioStatusChange?.("未开启");
    }
    onShareVideoAudioChange?.(shareVideoAudio);
  }
  function interrupt(): void {
    if (state !== "connected" || !activePort) return;
    try {
      activePort.postMessage({ action: "interrupt" });
    } catch {}
    speaking = false;
    updateInterruptUi();
    syncVideoDucking();
  }

  async function stop(): Promise<void> {
    currentGeneration += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    savedMossSessionId = null; // 用户主动点击结束伴看时清除 session_id
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
    syncVideoDucking();
  }

  liveButton?.addEventListener("click", () => {
    void toggle();
  });
  muteButton?.addEventListener("click", () => {
    toggleMute();
  });

  return {
    getState: () => state,
    getSavedSessionId: () => savedMossSessionId,


    isMuted: () => muted,
    isSpeaking: () => speaking,
    isReconnecting: () => reconnecting,
    getVideoAudioStatus: () => (!shareVideoAudio ? "未开启" : (activeAudioCapture?.getVideoAudioStatus() ?? "未开启")),
    isMicVadActive: () => activeAudioCapture?.isMicVadActive() ?? false,
    setShareVideoAudio,
    isSharingVideoAudio: () => shareVideoAudio,
    setVoicePriority,
    isVoicePriority: () => voicePriority,
    isDucked: () => isDucked,
    setMuted,
    setVolume,
    setSpeed,
    getSpeed: () => speed,
    toggleMute,
    interrupt,
    refreshTarget,
    start,
    stop,
    toggle,
    resetMerger: () => {
      activeMerger?.resetActiveTurns?.();
    },
    dispose
  };
}
