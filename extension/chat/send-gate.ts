import {
  chatSessionState,
  setAsrTranscribingActive,
  type ChatSessionContextSnapshot,
  type CurrentConversationMeta
} from "./chat-state.js";
import {
  buildAsrNoSubtitleMessage,
  canRetryNoSubtitleOnSend,
  requiresAsrSetup
} from "../core/asr-failure-notice.js";
import { buildCanonicalVideoUrl } from "../bilibili/video-id-shared.js";
import { isPinnedContextStrict } from "./context-load.js";
import { isPinnedYoutubeCacheEvicted } from "./conversation-store.js";
import type { ClipState, NoSubtitleReason, SubtitleFetchState } from "../core/state.js";
import type { ChatNoticeSlot } from "../reader/chat-notices.js";

interface SubtitleReadiness {
  hasBody: boolean;
  fetchState: SubtitleFetchState;
  asrActive: boolean;
}

function hasSubtitleBody(body: unknown): boolean {
  return Array.isArray(body) && body.length > 0;
}

function normalizeFetchState(value: unknown): SubtitleFetchState {
  return value === "loading" || value === "ready" || value === "error" || value === "empty" ? value : "idle";
}

function readinessFromClip(clip: Pick<ClipState, "subtitleBody" | "subtitleFetchState">): SubtitleReadiness {
  return {
    hasBody: hasSubtitleBody(clip.subtitleBody),
    fetchState: normalizeFetchState(clip.subtitleFetchState),
    asrActive: false
  };
}

function readinessFromSnapshot(
  snapshot: ChatSessionContextSnapshot | null | undefined,
  { asrTranscribingActive = false }: { asrTranscribingActive?: boolean } = {}
): SubtitleReadiness | null {
  if (!snapshot) {
    return null;
  }
  return {
    hasBody: hasSubtitleBody(snapshot.subtitleBody),
    fetchState: normalizeFetchState(snapshot.subtitleFetchState),
    asrActive: asrTranscribingActive === true
  };
}

function isPending(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && (view.fetchState === "loading" || view.asrActive);
}

function isNoSubtitleEmpty(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "empty";
}

function isSubtitleFetchFailed(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "error";
}

function buildNoSubtitleNotice(reason: NoSubtitleReason | undefined): { message: string; openSettings: boolean } {
  return {
    message: buildAsrNoSubtitleMessage("sidepanel", reason ?? null),
    openSettings: requiresAsrSetup(reason ?? null)
  };
}

export type GateOutcome =
  | { pass: true }
  | { pass: false; kind: "read-failed" | "no-subtitle" | "fetch-error" | "cancelled" };

export const ASR_TRANSCRIBING_NOTICE = "当前视频无字幕，正在进行语音转写…";
export const ASR_WAITING_NOTICE = "当前视频无字幕，正在进行语音转写，完成后自动开始总结…";
export const SUBTITLE_FETCH_FAILED_NOTICE = "字幕抓取失败，请稍后重试。";
export const SUBTITLE_READ_FAILED_NOTICE = "字幕读取失败，请重试。";
export const SUBTITLE_RETRYING_NOTICE = "正在重新抓取字幕…";
export const SUBTITLE_RETRY_READY_NOTICE = "已获取字幕，可以继续提问。";
export const YOUTUBE_CACHE_EVICTED_SEND_NOTICE =
  "该 YouTube 视频的本地字幕缓存已清理，当前仅可只读查看历史；请重新打开原 YouTube 视频页重载字幕后再继续提问。";

const SUBTITLE_WAIT_POLL_MS = 4000;

export interface StartSubtitleFetchOptions {
  forceRefresh?: boolean;
  awaitRefresh?: boolean;
}

export interface CreateSendGateDeps {
  loadContextState: (opts: { forceRefresh: boolean; silent: boolean; preserveInput?: boolean }) => Promise<boolean>;
  hydratePinned: (opts?: { preserveInput?: boolean }) => Promise<boolean>;
  inputNotice: ChatNoticeSlot;
  onWaitingChange?: (waiting: boolean) => void;
  onRetrySubtitleReady?: () => boolean | Promise<boolean>;
  replayInFlight: () => Promise<void> | null;
  isSessionClosed: () => boolean;
  isReaderTranscribing: () => boolean;
  asrNotice: HTMLElement | null;
  pageBvid: () => string | null;
  clip: () => ClipState;
  startSubtitleFetch: (options?: StartSubtitleFetchOptions) => Promise<boolean>;
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  pollIntervalMs?: number;
}

export interface SendGate {
  ensureContextForSend: () => Promise<GateOutcome>;
  isNoSubtitleBlocked: () => boolean;
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
  let noSubtitleBlocked = false;
  let retryGeneration = 0;
  let retryInFlight = false;
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
    deps.inputNotice.clear();
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    if (waitingUiActive) {
      waitingUiActive = false;
      deps.onWaitingChange?.(false);
    }
  }

  const pollIntervalMs = deps.pollIntervalMs ?? SUBTITLE_WAIT_POLL_MS;
  let waitToken = 0;
  let activeWaitFinish: ((ok: boolean) => void) | null = null;
  let kickCurrentWait: (() => void) | null = null;

  async function pollContext(): Promise<{ ok: boolean; pending: boolean }> {
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
  }

  function waitForSubtitles(): Promise<boolean> {
    if (activeWaitFinish) {
      activeWaitFinish(false);
    }
    return new Promise((resolve) => {
      let timer: number | null = null;
      let ticking = false;
      const currentToken = ++waitToken;
      const finish = (ok: boolean) => {
        if (currentToken !== waitToken) {
          return;
        }
        activeWaitFinish = null;
        kickCurrentWait = null;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        clearWaitNotice();
        resolve(ok);
      };
      activeWaitFinish = finish;
      const tick = async () => {
        if (ticking) {
          return;
        }
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        ticking = true;
        try {
          const outcome = await pollContext();
          if (currentToken !== waitToken) {
            return;
          }
          if (!outcome.ok) {
            finish(false);
            return;
          }
          if (!outcome.pending) {
            finish(true);
            return;
          }
          showWaitNotice();
          timer = window.setTimeout(() => {
            timer = null;
            void tick();
          }, pollIntervalMs);
        } finally {
          ticking = false;
        }
      };
      kickCurrentWait = () => {
        if (currentToken === waitToken) {
          void tick();
        }
      };
      void tick();
    });
  }

  function kickSubtitleWait(): void {
    kickCurrentWait?.();
  }

  function cancelSubtitleWait(): void {
    if (!activeWaitFinish) {
      return;
    }
    activeWaitFinish(false);
    waitToken += 1;
  }

  function bindStatusBus(): void {
    if (unsubscribeStatusBus) {
      return;
    }
    unsubscribeStatusBus = deps.subscribeStatusPhase((phase) => {
      if (phase === "asr-transcribing") {
        setAsrTranscribingActive(true);
        noSubtitleBlocked = false;
        deps.inputNotice.clear();
      } else if (phase === "asr-done" || phase === "subtitle-ready") {
        setAsrTranscribingActive(false);
        noSubtitleBlocked = false;
        if (!retryInFlight) {
          deps.inputNotice.clear();
        }
        kickSubtitleWait();
      } else if (phase === "asr-failed") {
        setAsrTranscribingActive(false);
        kickSubtitleWait();
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
        deps.inputNotice.clear();
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
    deps.inputNotice.show(YOUTUBE_CACHE_EVICTED_SEND_NOTICE, 0, {
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
    deps.inputNotice.show(SUBTITLE_READ_FAILED_NOTICE, 0, {
      action: { label: "重试读取", onClick: retryContextRead }
    });
  }

  function showNoSubtitleNotice(reason: NoSubtitleReason | undefined): void {
    const notice = buildNoSubtitleNotice(reason);
    deps.inputNotice.show(notice.message, 0, {
      action: { label: "重新抓取", onClick: retrySubtitleFetch },
      openSettingsAction: notice.openSettings,
      settingsTarget: "asr"
    });
  }

  function showRetryFetchFailedNotice(): void {
    deps.inputNotice.show(SUBTITLE_FETCH_FAILED_NOTICE, 0, {
      action: { label: "重新抓取", onClick: retrySubtitleFetch }
    });
  }

  function retrySubtitleFetch(): void {
    if (retryInFlight) {
      return;
    }
    const currentRetryGen = ++retryGeneration;
    retryInFlight = true;
    deps.inputNotice.show(SUBTITLE_RETRYING_NOTICE, 0, {
      spinner: true
    });
    void (async () => {
      try {
        const started = await deps.startSubtitleFetch({ forceRefresh: true, awaitRefresh: true }).catch(() => false);
        if (deps.isSessionClosed() || currentRetryGen !== retryGeneration) {
          return;
        }
        if (!started) {
          showRetryFetchFailedNotice();
          return;
        }
        let ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => false);
        if (deps.isSessionClosed() || currentRetryGen !== retryGeneration) {
          return;
        }
        let readiness = ok
          ? readinessFromSnapshot(chatSessionState.contextData, {
              asrTranscribingActive: chatSessionState.asrTranscribingActive
            })
          : null;
        if (isPending(readiness)) {
          const ready = await waitForSubtitles();
          if (deps.isSessionClosed() || currentRetryGen !== retryGeneration) {
            return;
          }
          if (!ready) {
            showReadFailedNotice();
            return;
          }
          ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => false);
          if (deps.isSessionClosed() || currentRetryGen !== retryGeneration) {
            return;
          }
          readiness = ok
            ? readinessFromSnapshot(chatSessionState.contextData, {
                asrTranscribingActive: chatSessionState.asrTranscribingActive
              })
            : null;
        }
        if (!ok || !readiness) {
          showReadFailedNotice();
          return;
        }
        if (isNoSubtitleEmpty(readiness)) {
          noSubtitleBlocked = true;
          showNoSubtitleNotice(chatSessionState.contextData?.noSubtitleReason as NoSubtitleReason);
          return;
        }
        if (isSubtitleFetchFailed(readiness)) {
          noSubtitleBlocked = false;
          showRetryFetchFailedNotice();
          return;
        }
        noSubtitleBlocked = false;
        retryInFlight = false;
        deps.inputNotice.clear();
        const resumed = await Promise.resolve(deps.onRetrySubtitleReady?.()).catch(() => false);
        if (deps.isSessionClosed() || currentRetryGen !== retryGeneration) {
          return;
        }
        if (!resumed) {
          deps.inputNotice.show(SUBTITLE_RETRY_READY_NOTICE, 3000, {
            tone: "success"
          });
        }
      } finally {
        if (currentRetryGen === retryGeneration) {
          retryInFlight = false;
        }
      }
    })();
  }

  async function ensureContextForSend(): Promise<GateOutcome> {
    noSubtitleBlocked = false;
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
    const ready = await waitForSubtitles();
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
      noSubtitleBlocked = true;
      showNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
      return { pass: false, kind: "no-subtitle" };
    }
    if (isSubtitleFetchFailed(finalReadiness)) {
      deps.inputNotice.show(SUBTITLE_FETCH_FAILED_NOTICE, 0, {
        action: { label: "重试读取", onClick: retryContextRead }
      });
      return { pass: false, kind: "fetch-error" };
    }
    await deps.replayInFlight();
    return { pass: true };
  }

  return {
    ensureContextForSend,
    isNoSubtitleBlocked: () => noSubtitleBlocked,
    kickSubtitleWait,
    cancel: () => {
      retryGeneration += 1;
      retryInFlight = false;
      noSubtitleBlocked = false;
      cancelledWaitGeneration = waitGeneration;
      cancelSubtitleWait();
    },
    bindStatusBus,
    unbindStatusBus,
    refreshAsrNotice: updateAsrNotice
  };
}
