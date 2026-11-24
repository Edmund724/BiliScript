import {
  chatSessionState,
  setAsrTranscribingActive,
  type CurrentConversationMeta
} from "./chat-state.js";
import { createSubtitleWaiter } from "./subtitle-wait.js";
import { buildNoSubtitleNotice, type NoSubtitleReason } from "./no-subtitle.js";
import { canRetryNoSubtitleOnSend } from "../core/asr-failure-notice.js";
import { buildCanonicalVideoUrl } from "../bilibili/video-id-shared.js";
import {
  isNoSubtitleEmpty,
  isPending,
  isSubtitleFetchFailed,
  readinessFromClip,
  readinessFromSnapshot
} from "./subtitle-readiness.js";
import { isPinnedContextStrict } from "./context-policy.js";
import { isPinnedYoutubeCacheEvicted } from "./conversation-store.js";
import type { ClipState } from "../core/state.js";

export type GateOutcome =
  | { pass: true }
  | { pass: false; kind: "read-failed" | "no-subtitle" | "fetch-error" | "cancelled" };

export const ASR_TRANSCRIBING_NOTICE = "当前视频无字幕，正在进行语音转写…";
export const ASR_WAITING_NOTICE = "当前视频无字幕，正在进行语音转写，完成后自动开始总结…";
export const SUBTITLE_FETCH_FAILED_NOTICE = "字幕抓取失败，请稍后重试。";
export const SUBTITLE_READ_FAILED_NOTICE = "字幕读取失败，请重试。";
export const YOUTUBE_CACHE_EVICTED_SEND_NOTICE =
  "该 YouTube 视频的本地字幕缓存已清理，当前仅可只读查看历史；请重新打开原 YouTube 视频页重载字幕后再继续提问。";

const SUBTITLE_WAIT_POLL_MS = 4000;

export interface CreateSendGateDeps {
  loadContextState: (opts: { forceRefresh: boolean; silent: boolean; preserveInput?: boolean }) => Promise<boolean>;
  hydratePinned: (opts?: { preserveInput?: boolean }) => Promise<boolean>;
  showContextNotice: (
    message: string,
    durationMs: number,
    opts?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      settingsTarget?: "asr";
      placement?: "input";
      action?: { label: string; onClick: () => void };
    }
  ) => void;
  removeContextNotice: () => void;
  onWaitingChange?: (waiting: boolean) => void;
  replayInFlight: () => Promise<void> | null;
  isSessionClosed: () => boolean;
  isReaderTranscribing: () => boolean;
  asrNotice: HTMLElement | null;
  pageBvid: () => string | null;
  clip: () => ClipState;
  startSubtitleFetch: () => Promise<boolean>;
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  pollIntervalMs?: number;
}

export interface SendGate {
  ensureContextForSend: () => Promise<GateOutcome>;
  kickSubtitleWait: () => void;
  cancel: () => void;
  bindStatusBus: () => void;
  unbindStatusBus: () => void;
  refreshAsrNotice: () => void;
}

export function createSendGate(deps: CreateSendGateDeps): SendGate {
  let asrWaitingActive = false;
  let waitingUiActive = false;
  let waitGeneration = 0;
  let cancelledWaitGeneration = -1;
  let unsubscribeStatusBus: (() => void) | null = null;

  function updateAsrNotice(): void {
    if (!deps.asrNotice) {
      return;
    }
    deps.asrNotice.hidden = !deps.isReaderTranscribing() && !asrWaitingActive;
    deps.asrNotice.textContent = asrWaitingActive ? ASR_WAITING_NOTICE : ASR_TRANSCRIBING_NOTICE;
  }

  function showWaitNotice(): void {
    if (!waitingUiActive) {
      waitingUiActive = true;
      deps.onWaitingChange?.(true);
    }
    if (deps.isReaderTranscribing()) {
      asrWaitingActive = true;
      updateAsrNotice();
    }
  }

  function clearWaitNotice(): void {
    deps.removeContextNotice();
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    if (waitingUiActive) {
      waitingUiActive = false;
      deps.onWaitingChange?.(false);
    }
  }

  const subtitleWaiter = createSubtitleWaiter({
    pollIntervalMs: deps.pollIntervalMs ?? SUBTITLE_WAIT_POLL_MS,
    pollContext: async () => {
      if (deps.isSessionClosed()) {
        return { ok: false, pending: false };
      }
      const ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => false);
      const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
      const readiness = readinessFromSnapshot(snapshot, {
        asrTranscribingActive: chatSessionState.asrTranscribingActive
      });
      return {
        ok: Boolean(snapshot),
        pending: isPending(readiness)
      };
    },
    showWaitingNotice: showWaitNotice,
    removeNotice: clearWaitNotice,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle)
  });

  function bindStatusBus(): void {
    if (unsubscribeStatusBus) {
      return;
    }
    unsubscribeStatusBus = deps.subscribeStatusPhase((phase) => {
      if (phase === "asr-transcribing") {
        setAsrTranscribingActive(true);
        deps.removeContextNotice();
      } else if (phase === "asr-done" || phase === "asr-failed" || phase === "subtitle-ready") {
        setAsrTranscribingActive(false);
        subtitleWaiter.kick();
      }
      if (phase !== "asr-transcribing") {
        asrWaitingActive = false;
      }
      updateAsrNotice();
    });
    updateAsrNotice();
  }

  function unbindStatusBus(): void {
    unsubscribeStatusBus?.();
    unsubscribeStatusBus = null;
  }

  async function startSubtitleFetchIfNeeded(): Promise<boolean> {
    const pageBvid = deps.pageBvid();
    if (!pageBvid) {
      return true;
    }
    const clip = deps.clip();
    const readiness = readinessFromClip(clip);
    if (String(clip.bvid || "") === pageBvid && readiness.hasBody) {
      return true;
    }
    if (readiness.fetchState !== "idle" && readiness.fetchState !== "error") {
      const retryableEmpty =
        readiness.fetchState === "empty" &&
        !readiness.hasBody &&
        canRetryNoSubtitleOnSend(clip.noSubtitleReason);
      if (!retryableEmpty) {
        return true;
      }
    }
    return deps.startSubtitleFetch();
  }

  function retryContextRead(): void {
    void (async () => {
      const ok = await deps.loadContextState({ forceRefresh: true, silent: true, preserveInput: true }).catch(() => false);
      if (!ok) {
        return;
      }
      if (isPinnedContextStrict(chatSessionState.currentConversationMeta) && !(await deps.hydratePinned({ preserveInput: true }))) {
        return;
      }
      if (chatSessionState.contextData) {
        deps.removeContextNotice();
      }
    })();
  }

  function resolveYoutubeWatchUrl(meta: CurrentConversationMeta | null | undefined): string {
    const bvid = String(meta?.contextRef?.bvid || "").trim();
    if (bvid) {
      return buildCanonicalVideoUrl(bvid, 1, "youtube");
    }
    const rawUrl = String(meta?.contextRef?.url || meta?.contextUrl || "").trim();
    return /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
  }

  function showYoutubeCacheEvictedNotice(): void {
    const targetUrl = resolveYoutubeWatchUrl(chatSessionState.currentConversationMeta);
    deps.showContextNotice(YOUTUBE_CACHE_EVICTED_SEND_NOTICE, 0, {
      placement: "input",
      ...(targetUrl
        ? {
            action: {
              label: "打开原视频",
              onClick: () => {
                if (typeof globalThis.open === "function") {
                  globalThis.open(targetUrl, "_blank", "noopener");
                }
              }
            }
          }
        : {})
    });
  }

  function showReadFailedNotice(): void {
    deps.showContextNotice(SUBTITLE_READ_FAILED_NOTICE, 0, {
      placement: "input",
      action: { label: "重试读取", onClick: retryContextRead }
    });
  }

  function retrySubtitleFetch(): void {
    void deps.startSubtitleFetch().then((started) => {
      if (started) {
        deps.removeContextNotice();
      }
    });
  }

  async function ensureContextForSend(): Promise<GateOutcome> {
    if (isPinnedContextStrict(chatSessionState.currentConversationMeta)) {
      await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
      if (!(await deps.hydratePinned({ preserveInput: true }))) {
        if (isPinnedYoutubeCacheEvicted(chatSessionState.currentConversationMeta)) {
          showYoutubeCacheEvictedNotice();
        } else {
          showReadFailedNotice();
        }
        return { pass: false, kind: "read-failed" };
      }
      await deps.replayInFlight();
      return { pass: true };
    }
    const ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true });
    if (!ok || !chatSessionState.contextData) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    if (!(await startSubtitleFetchIfNeeded())) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    const currentWaitGeneration = ++waitGeneration;
    const ready = await subtitleWaiter.wait();
    if (!ready) {
      if (cancelledWaitGeneration === currentWaitGeneration) {
        return { pass: false, kind: "cancelled" };
      }
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
    if (!chatSessionState.contextData) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    const finalReadiness = readinessFromSnapshot(chatSessionState.contextData, {
      asrTranscribingActive: chatSessionState.asrTranscribingActive
    });
    if (isNoSubtitleEmpty(finalReadiness)) {
      const notice = buildNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
      deps.showContextNotice(notice.message, 0, {
        placement: "input",
        action: { label: "重新抓取", onClick: retrySubtitleFetch },
        openSettingsAction: notice.openSettings,
        settingsTarget: "asr"
      });
      return { pass: false, kind: "no-subtitle" };
    }
    if (isSubtitleFetchFailed(finalReadiness)) {
      deps.showContextNotice(SUBTITLE_FETCH_FAILED_NOTICE, 0, {
        placement: "input",
        action: { label: "重试读取", onClick: retryContextRead }
      });
      return { pass: false, kind: "fetch-error" };
    }
    await deps.replayInFlight();
    return { pass: true };
  }

  return {
    ensureContextForSend,
    kickSubtitleWait: () => subtitleWaiter.kick(),
    cancel: () => {
      cancelledWaitGeneration = waitGeneration;
      subtitleWaiter.cancel();
    },
    bindStatusBus,
    unbindStatusBus,
    refreshAsrNotice: updateAsrNotice
  };
}
