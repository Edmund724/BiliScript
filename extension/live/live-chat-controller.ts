import {
  MOSS_LIVE_PORT_NAME,
  formatLiveCloseDiagnostics,
  encodeBase64Bytes,
  isLiveRoomContext,
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
  isGeminiLiveProvider,
  resolveActiveLiveProviderId,
  type LiveProvider
} from "./live-provider-store.js";
import type { LiveFailureKind } from "./live-session-tracker.js";
import {
  isOfficialAiCredentialEndpoint,
  queryAiCredentialKey,
  type AiCredentialMessageSender
} from "../core/ai-credential-reference.js";
import { createLiveToolsBridge } from "./live-tools-bridge.js";
import type { LiveAudioSettingsPatch } from "./live-audio-settings.js";
import { normalizeLiveVoiceSpeed } from "./live-voice-speed.js";
import { consumeRuntimeLastError } from "../shared/messaging.js";
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
  createLiveTextToolCoordinator,
  formatLiveOverviewRecordResult,
  summarizeLiveTextToolMarkdown,
  type LiveTextToolRecord
} from "./live-text-tool-records.js";
import { normalizeLiveTextToolVideo } from "./live-text-tool-history.js";
import {
  createPageAudioCapture,
  type PageAudioCaptureOptions,
  type PageAudioCaptureSession,
  type VideoAudioTrackStatus
} from "./page-media-capture.js";
import {
  capturePageVideoFrame,
  createPageVideoFrameCapture,
  type PageVideoFrameCaptureOptions,
  type PageVideoFrameCaptureSession
} from "./page-video-frame-capture.js";
import { resolveMossVideoConfig, type MossVideoCaptureConfig } from "./moss-video-config.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { formatClock } from "../shared/clock-text.js";
import { sendRuntimeMessage as defaultSendRuntimeMessage } from "../shared/messaging.js";

export type LiveChatState = "idle" | "connecting" | "connected" | "failure";
export const DEFAULT_LIVE_DUCK_RATIO = 0.2;

const CONFIG_FAILURE_KINDS = new Set<LiveFailureKind>([
  "provider-unconfigured",
  "key-missing",
  "gemini-credential"
]);

function classifyConnectionFailure(
  providerType: LiveProviderType,
  details: { code?: string | number; reason?: string; error?: string }
): LiveFailureKind {
  const diagnostic = `${details.code ?? ""} ${details.reason ?? ""} ${details.error ?? ""}`;
  if (/\b(?:401|403)\b|unauthorized|forbidden|authentication|invalid[^\n]*(?:api[ -]?key|key)|(?:api[ -]?key|密钥)[^\n]*(?:invalid|无效|失效|拒绝)/i.test(diagnostic)) {
    return providerType === "gemini-live" ? "gemini-credential" : "key-rejected";
  }
  return "network";
}

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
  initialVolume?: number;
  initialSpeed?: number;
  initialVoicePriority?: boolean;
  initialShareVideoAudio?: boolean;
  duckRatio?: number;
  getVideoElement?: () => HTMLVideoElement | null;
  onServerOutputConfigured?: (
    patch: Pick<LiveAudioSettingsPatch, "liveVoiceVolume" | "liveVoiceSpeed">
  ) => void;
  onStateChange?: (state: LiveChatState, error?: string, failureKind?: LiveFailureKind) => void;
  onReconnecting?: (info: LiveReconnectingInfo) => void;
  onVadStateChange?: (active: boolean) => void;
  onVideoAudioStatusChange?: (status: VideoAudioTrackStatus) => void;
  showNotice?: (message: string, autoHideMs?: number) => void;
  connectPort?: () => chrome.runtime.Port;
  sendRuntimeMessage?: typeof defaultSendRuntimeMessage;
  requestOrigins?: typeof requestProviderOriginsViaBackground;
  startAudioCapture?: (options: PageAudioCaptureOptions) => Promise<PageAudioCaptureSession>;
  startVideoCapture?: (options: PageVideoFrameCaptureOptions) => PageVideoFrameCaptureSession;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onVideoContextSwitch?: (context: MossLiveSessionContext | null) => void;
  getVideoContext?: () => MossLiveSessionContext | null;
  executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
  subscribeVideoContextChanges?: (listener: () => void) => () => void;
  videoBackendTaskManager?: LiveVideoBackendTaskManager;
  persistTextToolRecord?: (record: LiveTextToolRecord) => Promise<void> | void;
}

export interface LiveChatController {
  getState(): LiveChatState;
  getLastError(): string | undefined;
  getLastFailureKind(): LiveFailureKind | undefined;
  isMuted(): boolean;
  isReconnecting?(): boolean;
  getVideoAudioStatus(): VideoAudioTrackStatus;
  isVoiceRecentlyActive?(): boolean;
  applyAudioSettings(patch: LiveAudioSettingsPatch): void;
  setShareVideoAudio(enabled: boolean): void;
  isSharingVideoAudio(): boolean;
  setVoicePriority(enabled: boolean): void;
  isVoicePriority(): boolean;
  getVideoBaseVolume(): number | null;
  setVideoBaseVolume(volume: number): number | null;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  setSpeed(speed: number): void;
  getSpeed(): number;
  toggleMute(): void;
  interrupt(): void;
  sendUserPrompt(prompt: string, options?: { includeVideoFrame?: boolean }): Promise<boolean>;
  refreshTarget(): Promise<void>;
  handleStorageChanges(areaName: string, changedKeys: readonly string[]): void;
  getTextToolRecords(): LiveTextToolRecord[];
  subscribeTextToolRecords(listener: () => void): () => void;
  retryTextToolRecord(callId: string): boolean;
  dismissTextToolRecord(callId: string): void;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): void;
}

export function createLiveChatController(deps: LiveChatControllerDeps = {}): LiveChatController {
  const {
    initialVolume = 1,
    initialSpeed = 1,
    initialVoicePriority = true,
    initialShareVideoAudio = false,
    duckRatio = DEFAULT_LIVE_DUCK_RATIO,
    getVideoElement = null,
    onServerOutputConfigured,
    onStateChange,
    onReconnecting,
    onVadStateChange,
    onVideoAudioStatusChange,
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
    ? createLiveToolsBridge({
        showNotice,
        getPlayer: () => resolveVideoElement(),
        getVideoBaseVolume: () => getVideoBaseVolume(),
        setVideoBaseVolume: (nextVolume) => setVideoBaseVolume(nextVolume),
        isSharingVideoAudio: () => shareVideoAudio
      })
    : null;
  const resolveVideoContext = getVideoContext ?? defaultToolsBridge!.getVideoContext;
  const resolveExecuteTool = executeTool ?? defaultToolsBridge!.executeTool;
  const backendTasks = deps.videoBackendTaskManager ?? new VideoBackendTaskManager();
  const textToolCoordinator = createLiveTextToolCoordinator({
    persistRecord: deps.persistTextToolRecord,
    canRetry: () => state === "connected" && Boolean(activePort)
  });

  let state: LiveChatState = "idle";
  let lastError: string | undefined;
  let lastFailureKind: LiveFailureKind | undefined;
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

  function getVideoBaseVolume(): number | null {
    if (isDucked && originalVideoVolume !== null) {
      return originalVideoVolume;
    }
    const video = resolveVideoElement();
    return video && Number.isFinite(video.volume) ? Math.max(0, Math.min(1, video.volume)) : null;
  }

  function setVideoBaseVolume(nextVolume: number): number | null {
    if (!Number.isFinite(nextVolume)) return null;
    const clamped = Math.max(0, Math.min(1, nextVolume));
    const video = resolveVideoElement();
    if (!video) return null;
    if (isDucked) {
      originalVideoVolume = clamped;
      const targetVol = Math.max(0, Math.min(1, clamped * effectiveDuckRatio));
      try {
        video.volume = targetVol;
      } catch {}
    } else {
      try {
        video.volume = clamped;
      } catch {}
    }
    return clamped;
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
  let videoCaptureConfig: MossVideoCaptureConfig = resolveMossVideoConfig(false);
  let videoConfigErrorNotified = false;
  let activeTargetOrigin = "https://api.mosi.cn";
  let activeTargetModel = DEFAULT_LIVE_MODEL;
  let activeTargetProviderType: LiveProviderType = "moss-live";
  let activeTargetProviderId = "";
  let activeTargetVoiceId = "";

  async function loadLiveProvidersList(): Promise<Array<LiveProvider & { hasSavedKey?: boolean }>> {
    const resp = await sendRuntimeMessage({ type: "live-providers-list" });
    return resp?.ok && Array.isArray(resp.providers)
      ? (resp.providers as Array<LiveProvider & { hasSavedKey?: boolean }>)
      : [];
  }

  async function isActiveTargetCredentialReady(
    active: (LiveProvider & { hasSavedKey?: boolean }) | undefined,
    providerType: LiveProviderType
  ): Promise<boolean> {
    if (!active) return false;
    if (providerType === "gemini-live") {
      if (!isOfficialAiCredentialEndpoint("gemini-live", active.baseUrl)) {
        return false;
      }
      const cred = await queryAiCredentialKey(
        "gemini-live",
        sendRuntimeMessage as unknown as AiCredentialMessageSender
      );
      return cred.status === "ok" && Boolean(cred.key);
    }
    return active.hasSavedKey === true;
  }

  async function refreshTarget(): Promise<void> {
    const generationAtStart = currentGeneration;
    const failureKindAtStart = lastFailureKind;
    const shouldRecheckFailure =
      state === "failure" &&
      failureKindAtStart !== undefined &&
      CONFIG_FAILURE_KINDS.has(failureKindAtStart);
    try {
      const [providers, settingsResp] = await Promise.all([
        loadLiveProvidersList(),
        sendRuntimeMessage({ type: "get-settings" })
      ]);
      const rawActiveId = settingsResp?.ok
        ? (settingsResp.settings as { activeLiveProviderId?: unknown } | undefined)?.activeLiveProviderId
        : undefined;
      const activeId = resolveActiveLiveProviderId(
        providers,
        typeof rawActiveId === "string" ? rawActiveId : undefined
      );
      const active = providers.find((p) => p.id === activeId);
      activeTargetProviderType =
        active && isGeminiLiveProvider(active)
          ? "gemini-live"
          : "moss-live";
      activeTargetOrigin =
        active?.baseUrl ||
        (activeTargetProviderType === "gemini-live"
          ? "https://generativelanguage.googleapis.com"
          : "https://api.mosi.cn");
      activeTargetModel = active?.model || DEFAULT_LIVE_MODEL;
      const nextProviderId = String(active?.id || "");
      const providerChanged = Boolean(
        activeTargetProviderId &&
        nextProviderId !== activeTargetProviderId &&
        (state === "connecting" || state === "connected")
      );
      activeTargetProviderId = nextProviderId;
      if (providerChanged) {
        showNotice("伴看平台已切换，当前连接保持不变；重新连接后生效", 6000);
      }
      const nextVoiceId = String(active?.voiceId || "").trim();
      const voiceChanged = nextVoiceId !== activeTargetVoiceId;
      activeTargetVoiceId = nextVoiceId;
      if (
        voiceChanged &&
        !providerChanged &&
        nextVoiceId &&
        state === "connected" &&
        activeTargetProviderType === "moss-live" &&
        activePort
      ) {
        try {
          activePort.postMessage({ action: "change_voice", voiceId: nextVoiceId });
        } catch {}
      }
      if (shouldRecheckFailure) {
        const ready = await isActiveTargetCredentialReady(active, activeTargetProviderType);
        if (
          ready &&
          generationAtStart === currentGeneration &&
          state === "failure" &&
          lastFailureKind === failureKindAtStart
        ) {
          updateUi("failure", "", "unknown");
        }
      }
    } catch {
    }
  }

  function handleStorageChanges(areaName: string, changedKeys: readonly string[]): void {
    if (changedKeys.length === 0) return;
    const keySet = new Set(changedKeys);
    const isAiCredentialChange = areaName === "sync"
      ? keySet.has("aiProviders")
      : areaName === "local" && keySet.has("aiProviderKeys");
    const isLiveChange = areaName === "sync"
      ? keySet.has("liveProviders") || keySet.has("activeLiveProviderId")
      : areaName === "local" && keySet.has("liveProviderKeys");
    if (!isLiveChange && (!isAiCredentialChange || lastFailureKind !== "gemini-credential")) {
      return;
    }
    void refreshTarget();
  }

  function updateUi(nextState: LiveChatState, errorMessage?: string, failureKind?: LiveFailureKind): void {
    state = nextState;
    if (nextState === "failure") {
      lastError = errorMessage;
      lastFailureKind = failureKind;
    } else {
      lastError = undefined;
      lastFailureKind = undefined;
    }
    if (nextState !== "connecting") {
      reconnecting = false;
    }
    if (nextState !== "connected") {
      muted = nextState === "connecting" && activeAudioCapture ? activeAudioCapture.isMuted() : false;
      speaking = false;
      micVadActive = false;
      activeAudioCapture?.setAiSpeaking?.(false);
      clearLongSummaryControls();
    }
    syncVideoDucking();
    onStateChange?.(nextState, errorMessage, failureKind);
  }

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
        pauseWhenStatic: activeTargetProviderType === "gemini-live",
        onJpegFrame: (jpegBytes) => {
          if (generation !== currentGeneration || state !== "connected" || !activePort) return;
          try {
            activePort.postMessage({
              action: "video",
              jpegBase64: encodeBase64Bytes(jpegBytes)
            });
          } catch {
          }
        }
      });
    } catch {
      activeVideoCapture = null;
    }
  }

  async function cleanupSessionRule(targetSessionId?: string): Promise<void> {
    if (!targetSessionId) return;
    try {
      await sendRuntimeMessage({ type: "live-session-cleanup", sessionId: targetSessionId });
    } catch {
    }
  }

  function handleVoiceFallback(voiceId: string): void {
    showNotice(LIVE_VOICE_FALLBACK_NOTICE_TEXT, 6000);
    activeTargetVoiceId = "";
    void clearFallbackVoiceSelection(voiceId);
  }

  async function clearFallbackVoiceSelection(voiceId: string): Promise<void> {
    await recordLiveVoiceFallbackNotice({ voiceId });
    try {
      const providers = await loadLiveProvidersList();
      const index = providers.findIndex((provider) => provider.id === activeTargetProviderId);
      if (index < 0 || providers[index].voiceId !== voiceId) return;
      const { voiceId: _removed, ...rest } = providers[index];
      const next = providers.map((provider, i) => (i === index ? rest : provider));
      await sendRuntimeMessage({ type: "live-providers-save", providers: next });
    } catch {
    }
  }

  let stopVideoContextWatch: (() => void) | null = null;
  let lastPostedContextJson: string | null = null;
  let lastDelegationVideoKey: string | null = null;
  let currentVideoGeneration = 0;

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

  function currentTextToolVideo() {
    return normalizeLiveTextToolVideo(readVideoContext()) || undefined;
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
    status: "in_progress" | "completed" | "failed",
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
    generation: number,
    retry = false
  ): Promise<void> {
    const callId = delegation.delegationId;
    const attempt = textToolCoordinator.startAttempt({
      callId,
      retry,
      source: activeTargetProviderType === "gemini-live" ? "gemini" : "moss",
      objective: delegation.objective,
      startedAt: Date.now(),
      video: currentTextToolVideo(),
      onRetry: () => {
        void runBackendDelegation(delegation, generation, true);
      }
    });
    if (attempt === null) return;

    const controller = new AbortController();
    const timeout = delegation.purpose === "reasoning" && delegation.timeoutMs !== undefined
      ? setTimeout(() => {
          if (!textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
          postDelegationResult(
            callId,
            "in_progress",
            "后台分析仍在进行，完成后我会继续汇报。",
            generation
          );
        }, delegation.timeoutMs)
      : null;
    try {
      const result = await backendTasks.runTask({
        taskId: callId,
        objective: delegation.objective,
        context: delegation.context,
        scope: delegation.scope,
        timeRange: delegation.timeRange,
        signal: controller.signal,
        onSilentProgress: (content) => {
          if (!textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
          postDelegationSilent(callId, content, generation);
        },
        onSpokenResult: (content) => {
          if (!textToolCoordinator.isCurrentAttempt(callId, attempt) || generation !== currentGeneration || !activePort) return;
          pendingLongSummaryDelegations.add(callId);
          postDelegationResult(callId, "completed", content, generation);
        },
        onTextProgress: (markdown) => {
          textToolCoordinator.apply(attempt, {
            type: "progress",
            callId,
            summary: summarizeLiveTextToolMarkdown(markdown),
            markdown
          });
        },
        onError: (content) => {
          if (!textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
          postDelegationResult(callId, "failed", content, generation);
          textToolCoordinator.apply(attempt, { type: "failed", callId, error: content, endedAt: Date.now() });
        }
      });
      if (result) {
        textToolCoordinator.apply(attempt, {
          type: "completed",
          callId,
          summary: summarizeLiveTextToolMarkdown(result.rawText),
          markdown: result.detailText || result.rawText,
          endedAt: Date.now()
        });
      } else if (!controller.signal.aborted) {
        textToolCoordinator.failRecord(callId, "后台视频任务未返回可用结果，请重试。");
      }
    } catch (error) {
      if (controller.signal.aborted || !textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
      const content = (error as Error)?.message || String(error);
      postDelegationResult(callId, "failed", content, generation);
      textToolCoordinator.apply(attempt, { type: "failed", callId, error: content, endedAt: Date.now() });
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  function postPageToolResult(
    callId: string,
    result: unknown,
    generation: number,
    videoGeneration: number
  ): void {
    if (
      generation !== currentGeneration ||
      videoGeneration !== currentVideoGeneration ||
      !activePort
    ) return;
    try {
      activePort.postMessage({ action: "tool_result", callId, result });
    } catch {}
  }

  async function runPageTool(
    call: MossLiveToolCall,
    generation: number,
    retry = false,
    videoGeneration = currentVideoGeneration
  ): Promise<void> {
    const isSummary = call.name === "summarize_video";
    const callId = call.callId;
    if (!isSummary) {
      try {
        const result = await resolveExecuteTool(call);
        postPageToolResult(callId, result, generation, videoGeneration);
      } catch (error) {
        postPageToolResult(callId, {
          ok: false,
          error: `页面工具执行失败：${(error as Error)?.message || String(error)}`
        }, generation, videoGeneration);
      }
      return;
    }

    const attempt = textToolCoordinator.startAttempt({
      callId,
      retry,
      source: "moss",
      objective: "生成当前视频全片总结",
      startedAt: Date.now(),
      video: currentTextToolVideo(),
      onRetry: () => {
        void runPageTool(call, generation, true, videoGeneration);
      }
    });
    if (attempt === null) return;

    try {
      const result = await resolveExecuteTool(call);
      if (!textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
      postPageToolResult(callId, result, generation, videoGeneration);
      const completed = formatLiveOverviewRecordResult(result);
      if (completed) {
        textToolCoordinator.apply(attempt, { type: "completed", callId, ...completed, endedAt: Date.now() });
      } else {
        const error = result && typeof result === "object" && typeof (result as Record<string, unknown>).error === "string"
          ? String((result as Record<string, unknown>).error)
          : "全片概览生成失败，请重试。";
        textToolCoordinator.apply(attempt, { type: "failed", callId, error, endedAt: Date.now() });
      }
    } catch (error) {
      if (!textToolCoordinator.isCurrentAttempt(callId, attempt)) return;
      const message = `页面工具执行失败：${(error as Error)?.message || String(error)}`;
      postPageToolResult(callId, { ok: false, error: message }, generation, videoGeneration);
      textToolCoordinator.apply(attempt, { type: "failed", callId, error: message, endedAt: Date.now() });
    }
  }

  function postVideoContext(context: MossLiveSessionContext | null): void {
    if (!activePort) return;
    const nextDelegationVideoKey = delegationVideoKey(context);
    if (
      lastDelegationVideoKey !== null &&
      nextDelegationVideoKey !== lastDelegationVideoKey
    ) {
      currentVideoGeneration += 1;
      savedMossSessionId = null;
      backendTasks.cancelAllTasks();
      clearLongSummaryControls();
      textToolCoordinator.clear();
      deps.onVideoContextSwitch?.(context);
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
    };
    const unsubscribeUrlChange = contentEventBus.on("host:url-change", handleUrlChange);
    const unsubscribe = subscribeVideoContextChanges?.(guardedSync) || (() => {});
    stopVideoContextWatch = () => {
      unsubscribeUrlChange();
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
    textToolCoordinator.clear();
    stopActiveMedia();
    updateUi("connecting");

    const targetProviderType: LiveProviderType =
      activeTargetProviderType === "gemini-live" ? "gemini-live" : "moss-live";
    const targetOrigin = (
      activeTargetOrigin ||
      (targetProviderType === "gemini-live"
        ? "https://generativelanguage.googleapis.com"
        : "https://api.mosi.cn")
    ).trim();
    const targetModel = (activeTargetModel || DEFAULT_LIVE_MODEL).trim();
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
      updateUi("failure", errorMsg, "permission-denied");
      return false;
    }

    if (generation !== currentGeneration) {
      void cleanupSessionRule(sessionId);
      return false;
    }

    if (!permResult.ok) {
      const errorMsg = permResult.error || "未授予平台域名权限，无法建立伴看连接";
      updateUi("failure", errorMsg, "permission-denied");
      return false;
    }

    let prepResp: any;
    try {
      prepResp = await sendRuntimeMessage({ type: "live-session-prepare", sessionId });
    } catch (error) {
      if (generation !== currentGeneration) {
        void cleanupSessionRule(sessionId);
        return false;
      }
      const errorMsg = `启动服务通信失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg, "network");
      return false;
    }

    if (generation !== currentGeneration) {
      void cleanupSessionRule(sessionId);
      return false;
    }

    if (!prepResp?.ok) {
      const errorMsg = prepResp?.error || "伴看会话准备失败";
      updateUi("failure", errorMsg, prepResp?.failureKind);
      return false;
    }

    const resolvedProviderType: LiveProviderType =
      prepResp.provider?.type === "gemini-live"
        ? "gemini-live"
        : prepResp.provider?.type === "moss-live"
          ? "moss-live"
          : targetProviderType;
    videoCaptureConfig = resolveMossVideoConfig(prepResp.liveLowBandwidth === true);
    videoConfigErrorNotified = false;
    activeTargetProviderType = resolvedProviderType;
    if (prepResp.provider?.id) {
      activeTargetProviderId = String(prepResp.provider.id);
    }
    if (prepResp.provider?.baseUrl) {
      activeTargetOrigin = prepResp.provider.baseUrl;
    }
    if (prepResp.provider?.model) {
      activeTargetModel = prepResp.provider.model;
    }

    let captureSession: PageAudioCaptureSession;
    let microphoneFailed = false;
    try {
      captureSession = await startAudioCapture({
        initialMuted: false,
        initialAiSpeaking: speaking,
        shareVideoAudio,
        getVideoElement: resolveVideoElement,
        onVadStateChange: (active) => {
          if (generation !== currentGeneration) return;
          micVadActive = Boolean(active);
          onVadStateChange?.(active);
          syncVideoDucking();
        },
        onBargeInSpeechChange: (active) => {
          if (generation !== currentGeneration || !active || muted || state !== "connected") return;
          try {
            activePort?.postMessage({ action: "barge_in" });
          } catch {}
          if (speaking) {
            speaking = false;
            activeAudioCapture?.setAiSpeaking?.(false);
            endLongSummaryControl();
            syncVideoDucking();
          }
        },
        onVideoAudioStatusChange: (status) => {
          if (generation !== currentGeneration) return;
          currentVideoAudioStatus = status;
          onVideoAudioStatusChange?.(status);
        },
        onMicrophoneError: (error) => {
          if (
            microphoneFailed ||
            generation !== currentGeneration ||
            (state !== "connecting" && state !== "connected")
          ) {
            return;
          }
          microphoneFailed = true;
          const errorMsg = error.message || "麦克风连接已中断，请检查设备或浏览器权限后重试";
          stopActiveMedia();
          textToolCoordinator.failRunning("伴看连接已断开，本次分析已中断。");
          updateUi("failure", errorMsg, "microphone");
          disconnectPort();
          void cleanupSessionRule(sessionId);
        },
        onPcmFrame: (pcmBytes) => {
          if (muted || generation !== currentGeneration || state !== "connected" || !activePort) {
            return;
          }
          try {
            activePort.postMessage({
              action: "audio",
              pcmBase64: encodeBase64Bytes(pcmBytes)
            });
          } catch {
          }
        }
      });
    } catch (error) {
      void cleanupSessionRule(sessionId);
      if (generation !== currentGeneration) {
        return false;
      }
      const errorMsg = (error as Error)?.message || String(error || "麦克风授权或启动失败");
      updateUi("failure", errorMsg, "microphone");
      return false;
    }

    if (generation !== currentGeneration || microphoneFailed) {
      captureSession.stop();
      if (generation !== currentGeneration) {
        void cleanupSessionRule(sessionId);
      }
      return false;
    }
    activeAudioCapture = captureSession;

    let port: chrome.runtime.Port;
    try {
      port = connectPort();
      activePort = port;
    } catch (error) {
      stopActiveMedia();
      const errorMsg = `连接后台通信端口失败：${(error as Error)?.message || error}`;
      updateUi("failure", errorMsg, "network");
      void cleanupSessionRule(sessionId);
      return false;
    }

    port.onMessage.addListener((rawMsg: unknown) => {
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
        textToolCoordinator.failRunning("伴看连接中断，本次分析已取消，可重试。");
        updateUi("connecting");
      } else if (msg.type === "connected") {
        if (msg.sessionId) {
          savedMossSessionId = msg.sessionId;
        }
        updateUi("connected");
        syncVideoContext();
        startActiveVideoCapture(generation);
      } else if (msg.type === "output_configured") {
        const volumePercent = Number.isFinite(msg.volume)
          ? Math.round(Math.max(0, Math.min(2, msg.volume)) * 100)
          : Math.round(volume * 100);
        volume = volumePercent / 100;
        speed = Number.isFinite(msg.speed) ? normalizeLiveVoiceSpeed(msg.speed) : speed;
        onServerOutputConfigured?.({
          liveVoiceVolume: volumePercent,
          liveVoiceSpeed: speed
        });
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
          activeAudioCapture?.setAiSpeaking?.(speaking);
          if (!nextSpeaking) endLongSummaryControl();
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
        textToolCoordinator.failRecord(msg.delegationId, "本次分析已取消，可重试。");
      } else if (msg.type === "tool_call") {
        void runPageTool(msg.call, generation);
      } else if (msg.type === "tool_error") {
        if (msg.callId) textToolCoordinator.failRecord(msg.callId, msg.error);
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
        textToolCoordinator.failRunning("伴看连接中断，本次分析已取消，可重试。");
        reconnecting = true;
        const notice = formatLiveCloseDiagnostics({
          isReconnect: true,
          attempt: msg.attempt,
          maxAttempts: msg.maxAttempts,
          code: msg.code
        });
        updateUi("connecting", notice);
        showNotice(notice, 6000);
        onReconnecting?.({
          attempt: msg.attempt,
          maxAttempts: msg.maxAttempts,
          code: msg.code,
          notice
        });
      } else if (msg.type === "error" || msg.type === "closed") {
        handleConnectionFailure(msg);
      }
    });

    function handleConnectionFailure(msg: Extract<MossLiveServerEvent, { type: "error" | "closed" }>): void {
      if (msg.type === "closed" && state !== "connecting" && state !== "connected") return;
      const failureKind = classifyConnectionFailure(resolvedProviderType, msg);
      const errorMsg = failureKind === "key-rejected" || failureKind === "gemini-credential"
        ? resolvedProviderType === "gemini-live"
          ? "Gemini 凭据无效或已被拒绝，请检查后重试"
          : "平台拒绝了 API Key，请检查或更换后重试"
        : formatLiveCloseDiagnostics({ code: msg.code });
      stopActiveMedia();
      textToolCoordinator.failRunning("伴看连接已断开，本次分析已中断。");
      updateUi("failure", errorMsg, failureKind);
      disconnectPort();
      void cleanupSessionRule(sessionId);
    }

    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      if (generation !== currentGeneration) return;
      if (state === "connecting" || state === "connected") {
        const errorMsg = "后台伴看通道已断开。";
        stopActiveMedia();
        textToolCoordinator.failRunning("伴看连接已断开，本次分析已中断。");
        updateUi("failure", errorMsg, "network");
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
      updateUi("failure", errorMsg, "network");
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
    const next = Boolean(nextMuted);
    if (muted === next) return;
    muted = next;
    activeAudioCapture?.setMuted(muted);
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
  }

  function setShareVideoAudio(enabled: boolean): void {
    shareVideoAudio = Boolean(enabled);
    activeAudioCapture?.setShareVideoAudio(shareVideoAudio);
    if (!shareVideoAudio) {
      currentVideoAudioStatus = "未开启";
      onVideoAudioStatusChange?.("未开启");
    }
  }

  function applyAudioSettings(patch: LiveAudioSettingsPatch): void {
    if (patch.liveVoiceVolume !== undefined) setVolume(patch.liveVoiceVolume / 100);
    if (patch.liveVoiceSpeed !== undefined) setSpeed(patch.liveVoiceSpeed);
    if (patch.liveVoicePriority !== undefined) setVoicePriority(patch.liveVoicePriority);
    if (patch.liveShareVideoAudio !== undefined) setShareVideoAudio(patch.liveShareVideoAudio);
  }

  function interrupt(): void {
    if (state !== "connected" || !activePort) return;
    try {
      activePort.postMessage({ action: "interrupt" });
    } catch {}
    speaking = false;
    activeAudioCapture?.setAiSpeaking?.(false);
    endLongSummaryControl();
    syncVideoDucking();
  }

  async function sendUserPrompt(
    prompt: string,
    options?: { includeVideoFrame?: boolean }
  ): Promise<boolean> {
    const trimmed = typeof prompt === "string" ? prompt.trim() : "";
    if (!trimmed || state !== "connected" || !activePort) return false;
    const generation = currentGeneration;
    const video = resolveVideoElement();
    const context = readVideoContext();
    const formattedText =
      video && !isLiveRoomContext(context) && Number.isFinite(video.currentTime) && video.currentTime >= 0
        ? `[当前播放时刻：${formatClock(video.currentTime, { hours: "auto" })}]\n${trimmed}`
        : trimmed;
    const shouldIncludeFrame =
      options?.includeVideoFrame ??
      (activeVideoCapture?.isSuspended?.() ??
        Boolean(
          video &&
            (video.paused ||
              video.ended ||
              (typeof document !== "undefined" && document.hidden))
        ));

    let jpegBase64 = "";
    if (shouldIncludeFrame) {
      try {
        if (activeVideoCapture?.captureSnapshot) {
          const snapshot = await activeVideoCapture.captureSnapshot();
          if (snapshot && snapshot.byteLength > 0) {
            jpegBase64 = encodeBase64Bytes(snapshot);
          }
        } else if (video) {
          const snapshot = await capturePageVideoFrame({ getVideo: () => video });
          if (snapshot.jpegBytes.byteLength > 0) {
            jpegBase64 = encodeBase64Bytes(snapshot.jpegBytes);
          }
        }
      } catch {
      }
    }

    if (generation !== currentGeneration || state !== "connected" || !activePort) {
      return false;
    }
    try {
      activePort.postMessage({
        action: "user_text",
        text: formattedText,
        ...(jpegBase64 ? { jpegBase64 } : {})
      });
      return true;
    } catch {
      return false;
    }
  }

  async function stop(): Promise<void> {
    currentGeneration += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    savedMossSessionId = null;
    textToolCoordinator.clear();
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

  function dispose(): void {
    void stop();
    syncVideoDucking();
  }

  return {
    getState: () => state,
    getLastError: () => lastError,
    getLastFailureKind: () => lastFailureKind,
    isMuted: () => muted,
    isReconnecting: () => reconnecting,
    getVideoAudioStatus: () => (!shareVideoAudio ? "未开启" : (activeAudioCapture?.getVideoAudioStatus() ?? "未开启")),
    isVoiceRecentlyActive: () => activeAudioCapture?.isVoiceRecentlyActive() ?? true,
    applyAudioSettings,
    setShareVideoAudio,
    isSharingVideoAudio: () => shareVideoAudio,
    setVoicePriority,
    isVoicePriority: () => voicePriority,
    getVideoBaseVolume,
    setVideoBaseVolume,
    setMuted,
    setVolume,
    getVolume: () => volume,
    setSpeed,
    getSpeed: () => speed,
    toggleMute,
    interrupt,
    sendUserPrompt,
    refreshTarget,
    handleStorageChanges,
    getTextToolRecords: textToolCoordinator.getSnapshot,
    subscribeTextToolRecords: textToolCoordinator.subscribe,
    retryTextToolRecord: textToolCoordinator.retry,
    dismissTextToolRecord: textToolCoordinator.dismiss,
    start,
    stop,
    dispose
  };
}
