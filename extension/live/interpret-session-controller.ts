import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { sendRuntimeMessage as defaultSendRuntimeMessage } from "../shared/messaging.js";
import {
  encodeBase64Bytes,
  resolveMossLivePermissionOrigins
} from "./moss-live-protocol.js";
import {
  DEFAULT_MOSS_INTERPRET_MODEL,
  MOSS_INTERPRET_PORT_NAME,
  resolveMossInterpretWsUrl,
  type MossInterpretServerEvent,
  type MossInterpretTranscriptEvent
} from "./moss-interpret-protocol.js";
import {
  liveProviderStore,
  resolveActiveLiveProviderId
} from "./live-provider-store.js";
import {
  createVideoAudioCapture,
  type VideoAudioCaptureOptions,
  type VideoAudioCaptureSession
} from "./page-media-capture.js";

export type InterpretSessionState = "idle" | "connecting" | "connected";
export type InterpretAvailability = { ok: true } | { ok: false; error: string };

export interface InterpretSessionControllerDeps {
  getVideoElement?: () => HTMLVideoElement | null;
  getTargetLang?: () => string;
  showNotice?: (message: string, autoHideMs?: number) => void;
  onTranscript?: (event: MossInterpretTranscriptEvent) => void;
  clearSubtitles?: () => void;
  clearSubtitlesOnSeek?: () => void;
  onStateChange?: (state: InterpretSessionState) => void;
  onAvailabilityChange?: (availability: InterpretAvailability) => void;
  connectPort?: () => chrome.runtime.Port;
  sendRuntimeMessage?: typeof defaultSendRuntimeMessage;
  requestOrigins?: typeof requestProviderOriginsViaBackground;
  startAudioCapture?: (options: VideoAudioCaptureOptions) => VideoAudioCaptureSession;
}

export interface InterpretSessionController {
  getState(): InterpretSessionState;
  getAvailability(): InterpretAvailability;
  refreshAvailability(): Promise<InterpretAvailability>;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export function createInterpretSessionController(
  deps: InterpretSessionControllerDeps = {}
): InterpretSessionController {
  const getVideoElement = deps.getVideoElement ?? getRuntimeVideoElement;
  const getTargetLang = deps.getTargetLang ?? (() => "zh");
  const showNotice = deps.showNotice ?? (() => {});
  const connectPort = deps.connectPort ?? (() => chrome.runtime.connect({ name: MOSS_INTERPRET_PORT_NAME }));
  const sendRuntimeMessage = deps.sendRuntimeMessage ?? defaultSendRuntimeMessage;
  const requestOrigins = deps.requestOrigins ?? requestProviderOriginsViaBackground;
  const startAudioCapture = deps.startAudioCapture ?? createVideoAudioCapture;

  let state: InterpretSessionState = "idle";
  let generation = 0;
  let activeSessionId: string | null = null;
  let activePort: chrome.runtime.Port | null = null;
  let activeAudioCapture: VideoAudioCaptureSession | null = null;
  let activeClipSignature = "";
  let targetOrigin = "https://api.mosi.cn";
  let targetModel = DEFAULT_MOSS_INTERPRET_MODEL;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let boundVideo: HTMLVideoElement | null = null;
  let availability: InterpretAvailability = { ok: false, error: "正在检查 MOSS-LIVE 平台配置..." };
  let availabilityGeneration = 0;

  function updateState(next: InterpretSessionState): void {
    state = next;
    deps.onStateChange?.(next);
  }

  function updateAvailability(next: InterpretAvailability): InterpretAvailability {
    availability = next;
    deps.onAvailabilityChange?.(next);
    return availability;
  }

  async function refreshAvailability(): Promise<InterpretAvailability> {
    const currentGeneration = ++availabilityGeneration;
    try {
      const [providers, settings] = await Promise.all([
        liveProviderStore.loadProviders(),
        chrome.storage.sync.get(["activeLiveProviderId"])
      ]);
      const activeId = resolveActiveLiveProviderId(
        providers,
        typeof settings.activeLiveProviderId === "string" ? settings.activeLiveProviderId : undefined
      );
      const active = providers.find((provider) => provider.id === activeId);
      if (currentGeneration !== availabilityGeneration) return availability;
      if (!active) {
        return updateAvailability({
          ok: false,
          error: "未配置 MOSS-LIVE 平台，请先在设置中添加平台并填写 API Key"
        });
      }
      if (active.type === "gemini-live" || active.presetId === "gemini-live") {
        return updateAvailability({
          ok: false,
          error: "实时翻译需要 MOSS-LIVE 平台，请先在设置中切换并填写 API Key"
        });
      }
      if (!active.hasSavedKey) {
        return updateAvailability({
          ok: false,
          error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key"
        });
      }
      targetOrigin = active.baseUrl || targetOrigin;
      targetModel = active.model || targetModel;
      return updateAvailability({ ok: true });
    } catch (error) {
      if (currentGeneration !== availabilityGeneration) return availability;
      return updateAvailability({
        ok: false,
        error: `无法读取 MOSS-LIVE 平台配置：${(error as Error)?.message || String(error)}`
      });
    }
  }

  function clearPauseTimer(): void {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = null;
  }

  function handlePause(): void {
    clearPauseTimer();
    if (!boundVideo?.paused || (state !== "connected" && state !== "connecting")) return;
    const pausedGeneration = generation;
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (pausedGeneration !== generation || !boundVideo?.paused) return;
      void stop();
      showNotice("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
    }, 300_000);
  }

  function handlePlay(): void {
    clearPauseTimer();
  }

  function handleSeek(): void {
    (deps.clearSubtitlesOnSeek ?? deps.clearSubtitles)?.();
  }

  function unbindVideoLifecycle(): void {
    clearPauseTimer();
    boundVideo?.removeEventListener("pause", handlePause);
    boundVideo?.removeEventListener("play", handlePlay);
    boundVideo?.removeEventListener("seeking", handleSeek);
    boundVideo = null;
  }

  function bindVideoLifecycle(): void {
    unbindVideoLifecycle();
    boundVideo = getVideoElement();
    boundVideo?.addEventListener("pause", handlePause);
    boundVideo?.addEventListener("play", handlePlay);
    boundVideo?.addEventListener("seeking", handleSeek);
    handlePause();
  }

  async function cleanupSessionRule(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    try {
      await sendRuntimeMessage({
        type: "live-session-cleanup",
        sessionId,
        channel: "interpret"
      });
    } catch {}
  }

  async function stop(): Promise<void> {
    generation += 1;
    const stoppingSessionId = activeSessionId;
    activeSessionId = null;
    unbindVideoLifecycle();
    activeAudioCapture?.stop();
    activeAudioCapture = null;
    const port = activePort;
    activePort = null;
    if (port) {
      try {
        port.postMessage({ action: "stop" });
      } catch {}
      try {
        port.disconnect();
      } catch {}
    }
    deps.clearSubtitles?.();
    updateState("idle");
    await cleanupSessionRule(stoppingSessionId);
  }

  async function start(): Promise<boolean> {
    if (state === "connecting" || state === "connected") return true;

    generation += 1;
    const currentGeneration = generation;
    const sessionId = `interpret-${currentGeneration}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    activeSessionId = sessionId;
    activeClipSignature = computeCurrentClipSignature();
    updateState("connecting");

    try {
      const permission = await requestOrigins(
        resolveMossLivePermissionOrigins(targetOrigin, targetModel, "moss-live")
      );
      if (currentGeneration !== generation) {
        void cleanupSessionRule(sessionId);
        return false;
      }
      if (!permission.ok) throw new Error(permission.error || "未授予平台域名权限，无法建立同传连接");

      const prepared = await sendRuntimeMessage({
        type: "live-session-prepare",
        sessionId,
        channel: "interpret"
      });
      if (currentGeneration !== generation) {
        void cleanupSessionRule(sessionId);
        return false;
      }
      if (!prepared.ok) throw new Error(prepared.error || "同传会话准备失败");
      if (prepared.provider?.type === "gemini-live" || prepared.provider?.presetId === "gemini-live") {
        throw new Error("实时翻译需要 MOSS-LIVE 平台，请先在设置中切换并填写 API Key");
      }
      targetOrigin = prepared.provider?.baseUrl || targetOrigin;
      targetModel = prepared.provider?.model || targetModel;

      const capture = await startAudioCapture({
        getVideoElement,
        onPcmFrame: (pcmBytes) => {
          if (currentGeneration !== generation || state !== "connected" || !activePort) return;
          try {
            activePort.postMessage({
              action: "audio",
              pcmBase64: encodeBase64Bytes(pcmBytes)
            });
          } catch {}
        }
      });
      if (currentGeneration !== generation) {
        capture.stop();
        void cleanupSessionRule(sessionId);
        return false;
      }
      activeAudioCapture = capture;

      const port = connectPort();
      activePort = port;
      port.onMessage.addListener((rawMsg: unknown) => {
        if (currentGeneration !== generation) return;
        const msg = rawMsg as MossInterpretServerEvent;
        if (msg.type === "connected") {
          updateState("connected");
          bindVideoLifecycle();
          return;
        }
        if (msg.type === "transcript") {
          deps.onTranscript?.(msg.event);
          return;
        }
        if (msg.type === "closed") {
          generation += 1;
          unbindVideoLifecycle();
          activeAudioCapture?.stop();
          activeAudioCapture = null;
          activePort = null;
          activeSessionId = null;
          port.disconnect();
          deps.clearSubtitles?.();
          updateState("idle");
          if (msg.code !== 1000 || msg.error) {
            showNotice(
              msg.error || `同传连接已关闭${msg.code ? `（${msg.code}）` : ""}${msg.reason ? `：${msg.reason}` : ""}`,
              6000
            );
          }
          void cleanupSessionRule(sessionId);
          return;
        }
        if (msg.type !== "error") return;
        generation += 1;
        unbindVideoLifecycle();
        activeAudioCapture?.stop();
        activeAudioCapture = null;
        activePort = null;
        activeSessionId = null;
        port.disconnect();
        deps.clearSubtitles?.();
        updateState("idle");
        showNotice(msg.error || `同传连接失败${msg.code ? `（${msg.code}）` : ""}${msg.reason ? `：${msg.reason}` : ""}`, 6000);
        void cleanupSessionRule(sessionId);
      });
      port.onDisconnect.addListener(() => {
        if (currentGeneration !== generation || activePort !== port) return;
        generation += 1;
        unbindVideoLifecycle();
        activeAudioCapture?.stop();
        activeAudioCapture = null;
        activePort = null;
        activeSessionId = null;
        deps.clearSubtitles?.();
        updateState("idle");
        showNotice("同传后台通道已断开", 6000);
        void cleanupSessionRule(sessionId);
      });
      port.postMessage({
        action: "start",
        wsUrl: resolveMossInterpretWsUrl(targetOrigin, targetModel, getTargetLang())
      });
      return true;
    } catch (error) {
      if (currentGeneration === generation) {
        generation += 1;
        activeAudioCapture?.stop();
        activeAudioCapture = null;
        const port = activePort;
        activePort = null;
        activeSessionId = null;
        activeClipSignature = "";
        try {
          port?.disconnect();
        } catch {}
        deps.clearSubtitles?.();
        updateState("idle");
        showNotice((error as Error)?.message || String(error), 6000);
      }
      void cleanupSessionRule(sessionId);
      return false;
    }
  }

  function handleUrlChange(): void {
    if (
      (state === "connecting" || state === "connected") &&
      computeCurrentClipSignature() !== activeClipSignature
    ) {
      void stop();
    }
  }

  async function toggle(): Promise<void> {
    if (state === "connecting" || state === "connected") {
      await stop();
    } else {
      await start();
    }
  }

  function dispose(): void {
    window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
    void stop();
  }

  window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
  return {
    getState: () => state,
    getAvailability: () => availability,
    refreshAvailability,
    start,
    stop,
    toggle,
    dispose
  };
}
