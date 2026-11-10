// extension/live/live-chat-controller.ts
// AI 对话面板中实时伴看的控制状态机与生命周期管理。
// 负责校验密钥与权限、采集音视频、执行前台工具与后台视频委派，并管理静音、挂断、断连及换片清理。

import {
  MOSS_LIVE_PORT_NAME,
  formatLiveCloseDiagnostics,
  encodeBase64Bytes,
  resolveGeminiLiveWsUrl,
  resolveMossLivePermissionOrigins,
  resolveMossLiveWsUrl,
  type LiveProviderType,
  type MossLiveDelegationRequest,
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
import { normalizeLiveVoiceSpeed } from "./live-voice-speed.js";
import {
  LIVE_VOICE_FALLBACK_NOTICE_TEXT,
  recordLiveVoiceFallbackNotice
} from "./live-voice-fallback-notice.js";
import {
  VideoBackendTaskManager,
  type VideoBackendTaskOptions,
  type VideoBackendTaskResult
} from "./video-backend-task.js";
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
import { resolveMossVideoConfig, type MossVideoCaptureConfig } from "./moss-video-config.js";
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

export interface LiveVideoBackendTaskManager {
  runTask(options: VideoBackendTaskOptions): Promise<VideoBackendTaskResult | null>;
  cancelTask(taskId: string): boolean;
  cancelAllTasks(): void;
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
  onVolumeChange?: (volumePercent: number) => void;
  onSpeedChange?: (speed: number) => void;
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
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  getVideoContext?: () => MossLiveSessionContext | null;
  executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
  subscribeVideoContextChanges?: (listener: () => void) => () => void;
  videoBackendTaskManager?: LiveVideoBackendTaskManager;
}

export interface LiveChatController {
  getState(): LiveChatState;
  getSavedSessionId?(): string | null;
  isMuted(): boolean;
  isSpeaking(): boolean;
  isReconnecting?(): boolean;
  getVideoAudioStatus(): VideoAudioTrackStatus;
  isMicVadActive(): boolean;
  isVoiceRecentlyActive?(): boolean;
  setShareVideoAudio(enabled: boolean): void;
  isSharingVideoAudio(): boolean;
  setVoicePriority(enabled: boolean): void;
  isVoicePriority(): boolean;
  isDucked(): boolean;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  setSpeed(speed: number): void;
  getSpeed(): number;
  toggleMute(): void;
  interrupt(): void;
  refreshTarget(): Promise<void>;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
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
    onVolumeChange,
    onSpeedChange,
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
  const backendTasks = deps.videoBackendTaskManager ?? new VideoBackendTaskManager();

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
  let volume = Number.isFinite(initialVolume) ? Math.max(0, Math.min(2, initialVolume)) : 1;
  let speed = normalizeLiveVoiceSpeed(initialSpeed);
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

  const pendingLongSummaryDelegations = new Set<string>();
  let longSummaryControlActive = false;
  let longSummaryVideo: HTMLVideoElement | null = null;
  let longSummaryShouldResume = false;

  function beginLongSummaryControl(): void {
    if (longSummaryControlActive || pendingLongSummaryDelegations.size === 0) return;
    const delegationId = pendingLongSummaryDelegations.values().next().value;
    if (typeof delegationId !== "string") return;
    pendingLongSummaryDelegations.delete(delegationId);
    longSummaryControlActive = true;
    longSummaryVideo = resolveVideoElement();
    longSummaryShouldResume = Boolean(longSummaryVideo && !longSummaryVideo.paused);
    if (longSummaryShouldResume) {
      try {
        longSummaryVideo?.pause();
      } catch {}
    }
  }

  function endLongSummaryControl(): void {
    if (!longSummaryControlActive) return;
    const video = longSummaryVideo;
    const shouldResume = longSummaryShouldResume;
    longSummaryControlActive = false;
    longSummaryVideo = null;
    longSummaryShouldResume = false;
    if (shouldResume && video && resolveVideoElement() === video) {
      try {
        void video.play().catch(() => {});
      } catch {}
    }
  }

  function clearLongSummaryControls(): void {
    pendingLongSummaryDelegations.clear();
    endLongSummaryControl();
  }

  let activePort: chrome.runtime.Port | null = null;
  let activeSessionId: string | null = null;
  let savedMossSessionId: string | null = null;
  let activeAudioCapture: PageAudioCaptureSession | null = null;
  let reconnecting = false;
  let activeVideoCapture: PageVideoFrameCaptureSession | null = null;
  // 本次会话的画面采集参数：先按开关取请求档位，收到 media.configured 后以回执为准。
  let videoCaptureConfig: MossVideoCaptureConfig = resolveMossVideoConfig(false);
  let videoConfigErrorNotified = false;
  let activeTargetOrigin = "https://api.mosi.cn";
  let activeTargetModel = DEFAULT_LIVE_MODEL;
  let activeTargetProviderType: LiveProviderType = "moss-live";
  let activeTargetProviderId = "";
  let activeTargetVoiceId = "";

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
      activeTargetProviderId = String(active?.id || "");
      // 通话中改音色：设置改动经 liveProviders 存储监听回到这里，直接向 offscreen
      // 下发 change_voice（服务端从下一轮回答开始使用）；未连接时只更新目标值。
      const nextVoiceId = String(active?.voiceId || "").trim();
      const voiceChanged = nextVoiceId !== activeTargetVoiceId;
      activeTargetVoiceId = nextVoiceId;
      if (
        voiceChanged &&
        nextVoiceId &&
        state === "connected" &&
        activeTargetProviderType === "moss-live" &&
        activePort
      ) {
        try {
          activePort.postMessage({ action: "change_voice", voiceId: nextVoiceId });
        } catch {}
      }
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

  function updateSpeakingUi(): void {
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
      clearLongSummaryControls();
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
    updateSpeakingUi();
    onStateChange?.(nextState, errorMessage);
  }

  // 初始化 UI 呈现
  updateUi("idle");

  function stopActiveMedia(): void {
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
  }

  function startActiveVideoCapture(generation: number): void {
    if (activeVideoCapture || generation !== currentGeneration || state !== "connected") return;
    try {
      activeVideoCapture = startVideoCapture({
        getVideo: resolveVideoElement,
        config: videoCaptureConfig,
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

  // change_voice 失败（如音色已被删）：页面内先告知，再清掉该 provider 的
  // voiceId（下次会话回到平台默认）并留下一次性提示给设置面板。
  function handleVoiceFallback(voiceId: string): void {
    showNotice(LIVE_VOICE_FALLBACK_NOTICE_TEXT, 6000);
    activeTargetVoiceId = "";
    void clearFallbackVoiceSelection(voiceId);
  }

  async function clearFallbackVoiceSelection(voiceId: string): Promise<void> {
    await recordLiveVoiceFallbackNotice({ voiceId });
    try {
      const providers = await liveProviderStore.loadProviders();
      const index = providers.findIndex((provider) => provider.id === activeTargetProviderId);
      if (index < 0 || providers[index].voiceId !== voiceId) return;
      const { voiceId: _removed, ...rest } = providers[index];
      const next = providers.map((provider, i) => (i === index ? rest : provider));
      await liveProviderStore.saveProviders(next);
    } catch {
      // 回退提示已落盘；清选择失败时下次会话仍会走同一条回退路径
    }
  }

  let stopVideoContextWatch: (() => void) | null = null;
  let lastPostedContextJson: string | null = null;
  let lastDelegationVideoKey: string | null = null;

  function readVideoContext(): MossLiveSessionContext | null {
    try {
      return resolveVideoContext() || null;
    } catch {
      return null;
    }
  }

  function delegationVideoKey(context: MossLiveSessionContext | null): string {
    return context && !("kind" in context)
      ? `${context.bvid}:${context.cid}:${context.pageIndex}`
      : "";
  }

  function postDelegationSilent(
    delegationId: string,
    content: string,
    generation: number
  ): void {
    if (generation !== currentGeneration || !activePort) return;
    try {
      activePort.postMessage({
        action: "delegation_silent",
        delegationId,
        content: Array.from(content).slice(0, 2000).join("")
      });
    } catch {}
  }

  function postDelegationResult(
    delegationId: string,
    status: "completed" | "failed",
    content: string,
    generation: number
  ): void {
    if (generation !== currentGeneration || !activePort) return;
    try {
      activePort.postMessage({
        action: "delegation_result",
        delegationId,
        status,
        content: Array.from(content).slice(0, 2000).join("")
      });
    } catch {}
  }

  async function runBackendDelegation(
    delegation: MossLiveDelegationRequest,
    generation: number
  ): Promise<void> {
    const controller = new AbortController();
    try {
      await backendTasks.runTask({
        taskId: delegation.delegationId,
        objective: delegation.objective,
        context: delegation.context,
        scope: delegation.scope,
        timeRange: delegation.timeRange,
        signal: controller.signal,
        onSilentProgress: (content) => {
          postDelegationSilent(delegation.delegationId, content, generation);
        },
        onSpokenResult: (content) => {
          if (generation !== currentGeneration || !activePort) return;
          pendingLongSummaryDelegations.add(delegation.delegationId);
          postDelegationResult(delegation.delegationId, "completed", content, generation);
        },
        onError: (content) => {
          postDelegationResult(delegation.delegationId, "failed", content, generation);
        }
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      postDelegationResult(
        delegation.delegationId,
        "failed",
        (error as Error)?.message || String(error),
        generation
      );
    }
  }

  function postVideoContext(context: MossLiveSessionContext | null): void {
    if (!activePort) return;
    const nextDelegationVideoKey = delegationVideoKey(context);
    if (
      lastDelegationVideoKey !== null &&
      nextDelegationVideoKey !== lastDelegationVideoKey
    ) {
      backendTasks.cancelAllTasks();
      pendingLongSummaryDelegations.clear();
    }
    lastDelegationVideoKey = nextDelegationVideoKey;
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
    backendTasks.cancelAllTasks();
    stopActiveMedia();
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
    // 低带宽开关在会话建立时生效：请求档位先用于抽帧，服务端回执到达后再覆盖。
    videoCaptureConfig = resolveMossVideoConfig(prepResp.liveLowBandwidth === true);
    videoConfigErrorNotified = false;
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
        getVideoElement: resolveVideoElement,
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

    // 4. 连接 Offscreen 端口

    let port: chrome.runtime.Port;
    try {
      port = connectPort();
      activePort = port;
    } catch (error) {
      stopActiveMedia();
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
      } else if (msg.type === "voice_fallback") {
        handleVoiceFallback(msg.voiceId);
      } else if (msg.type === "connecting") {
        backendTasks.cancelAllTasks();
        updateUi("connecting");
      } else if (msg.type === "connected") {
        if (msg.sessionId) {
          savedMossSessionId = msg.sessionId;
        }
        updateUi("connected");
        syncVideoContext();
        startActiveVideoCapture(generation);
      } else if (msg.type === "output_configured") {
        volume = Number.isFinite(msg.volume) ? Math.max(0, Math.min(2, msg.volume)) : volume;
        speed = normalizeLiveVoiceSpeed(msg.speed);
        onVolumeChange?.(Math.round(volume * 100));
        onSpeedChange?.(speed);
      } else if (msg.type === "video_configured") {
        videoCaptureConfig = msg.video;
        activeVideoCapture?.configure(msg.video);
        if (msg.error && !videoConfigErrorNotified) {
          videoConfigErrorNotified = true;
          showNotice(`伴看画面参数未生效，已回退默认画质：${msg.error}`, 6000);
        }
      } else if (msg.type === "speaking_state") {
        if (state === "connected" || state === "connecting") {
          const nextSpeaking = Boolean(msg.speaking);
          if (nextSpeaking && !speaking) beginLongSummaryControl();
          speaking = nextSpeaking;
          if (!nextSpeaking) endLongSummaryControl();
          updateSpeakingUi();
          syncVideoDucking();
        }
      } else if (msg.type === "transcript") {
        if (state === "connected" || state === "connecting") {
          onTranscript?.(msg.event);
        }
      } else if (msg.type === "delegation_created") {
        void runBackendDelegation(msg.delegation, generation);
      } else if (msg.type === "delegation_cancelled") {
        pendingLongSummaryDelegations.delete(msg.delegationId);
        backendTasks.cancelTask(msg.delegationId);
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
        backendTasks.cancelAllTasks();
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
        stopActiveMedia();
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
          stopActiveMedia();
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
        stopActiveMedia();
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
    lastDelegationVideoKey = delegationVideoKey(initialVideoContext);
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
        ...(activeTargetVoiceId ? { voiceId: activeTargetVoiceId } : {}),
        ...(typeof prepResp.liveGeminiNativeSearch === "boolean"
          ? { liveGeminiNativeSearch: prepResp.liveGeminiNativeSearch }
          : {}),
        ...(typeof prepResp.liveLowBandwidth === "boolean"
          ? { lowBandwidth: prepResp.liveLowBandwidth }
          : {}),
        ...(initialVideoContext || getVideoContext ? { videoContext: initialVideoContext } : {})
      });
    } catch (error) {
      stopActiveMedia();
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
    backendTasks.cancelAllTasks();
    stopVideoContextWatch?.();
    lastPostedContextJson = null;
    lastDelegationVideoKey = null;
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
    updateSpeakingUi();
    syncVideoDucking();
    if (activePort) {
      try {
        activePort.postMessage({ action: "mic_state", enabled: !muted });
      } catch {}
    }
  }

  function setVolume(nextVolume: number): void {
    volume = Number.isFinite(nextVolume) ? Math.max(0, Math.min(2, nextVolume)) : 1;
    if (!activePort) return;
    try {
      activePort.postMessage({ action: "set_volume", volume });
    } catch {}
  }

  function setSpeed(nextSpeed: number): void {
    speed = normalizeLiveVoiceSpeed(nextSpeed);
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
    endLongSummaryControl();
    updateSpeakingUi();
    syncVideoDucking();
  }

  async function stop(): Promise<void> {
    currentGeneration += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    savedMossSessionId = null; // 用户主动点击结束伴看时清除 session_id
    stopActiveMedia();
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
    isVoiceRecentlyActive: () => activeAudioCapture?.isVoiceRecentlyActive() ?? true,
    setShareVideoAudio,
    isSharingVideoAudio: () => shareVideoAudio,
    setVoicePriority,
    isVoicePriority: () => voicePriority,
    isDucked: () => isDucked,
    setMuted,
    setVolume,
    getVolume: () => volume,
    setSpeed,
    getSpeed: () => speed,
    toggleMute,
    interrupt,
    refreshTarget,
    start,
    stop,
    toggle,
    dispose
  };
}
