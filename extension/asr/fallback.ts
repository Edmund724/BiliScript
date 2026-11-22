import { ensureRunActive, isStaleRunError, getErrorMessage, makeStaleRunError } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { state, clipState } from "../core/state.js";
import type { NoSubtitleReason } from "../core/state.js";
import { getAsrFailureNotice, reasonFromFailureKind, buildAsrNoSubtitleMessage } from "../core/asr-failure-notice.js";
import { resolveActiveAsrProviderId } from "./asr-provider-normalize.js";
import { readAsrFailureSummary } from "./protocol.js";
import type { AsrAttemptOutcome } from "./protocol.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  findCachedAsrSubtitleTrack,
  clearSubtitleCacheByKey,
  persistAsrSubtitleToCache
} from "../subtitle/cache.js";
import type { TrackIdentity } from "../subtitle/source-key.js";
import {
  ASR_SUBTITLE_TRACK_ID,
  createAsrPseudoTrack,
  upsertAsrPseudoTrack
} from "../subtitle/selection.js";
import { validateSubtitleByDuration } from "../subtitle/duration-validation.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import { sleep } from "../shared/utils.js";

const ASR_RUN_RETRIES = 1;
const ASR_RETRY_DELAY_MS = 2000;
const ASR_RETRY_MAX_ELAPSED_MS = 60000;

const KNOWN_ASR_SKIP_REASONS = new Set(["asr-disabled", "no-asr-config"]);

function noSubtitleReasonFromAsrSkipError(error: unknown): NoSubtitleReason {
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === "string" && KNOWN_ASR_SKIP_REASONS.has(reason)
    ? (reason as NoSubtitleReason)
    : null;
}

function classifyEmptyOutcome(outcome?: AsrAttemptOutcome | null): { reason: NoSubtitleReason; detail: string } {
  const failed = Number(outcome?.failedChunks) || 0;
  const failure = readAsrFailureSummary(outcome);
  const reason: NoSubtitleReason = failed > 0 ? reasonFromFailureKind(failure?.kind) : "asr-empty";
  const detail = getAsrFailureNotice(reason, { status: failure?.status, detail: failure?.detail }).detail;
  return { reason, detail };
}

function setNoSubtitleReasonWithDetail(reason: NoSubtitleReason, detail: string): void {
  clipState.setNoSubtitleReason(reason);
  clipState.setNoSubtitleDetail(detail);
}

function seedAsrPseudoTrack(sourceLabel: string): void {
  clipState.setSubtitles(
    upsertAsrPseudoTrack(state.clip.subtitles || [], { ...createAsrPseudoTrack(sourceLabel) })
  );
}

export interface AsrSettings {
  asrAutoFallback?: boolean;
  activeAsrProviderId?: string;
  asrLanguage?: string;
}

export interface AsrProviderMeta {
  id: string;
  name?: string;
  model?: string;
  type?: string;
}

export interface SubtitleItem {
  from: number;
  to: number;
  content: string;
}

export interface AcceptSubtitleArgs {
  body: SubtitleItem[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
}

export interface CommitNoSubtitleArgs {
  noSubtitleReason: NoSubtitleReason;
}

export interface AsrPipelineArgs {
  bvid: string;
  cid: string;
  onProgress?: (message: string) => void;
  onEmptyDiagnostic?: (diagText: string) => void;
  onAttemptOutcome?: (outcome: AsrAttemptOutcome) => void;
}

export interface AsrSharedTranscribeResult {
  body: SubtitleItem[];
  outcome: AsrAttemptOutcome;
}

export interface CreateAsrFallbackDeps {
  getSettings: () => Promise<AsrSettings>;
  loadProviders: () => Promise<AsrProviderMeta[]>;
  setStatus: (message: string) => void;
  acceptSubtitle: (args: AcceptSubtitleArgs) => Promise<unknown>;
  commitNoSubtitle: (args: CommitNoSubtitleArgs) => Promise<unknown>;
  runAsrPipeline: (args: AsrPipelineArgs) => Promise<SubtitleItem[]>;
  broadcastSubtitleStatus: (status: string) => void;
  sleepFor?: (ms: number) => Promise<void>;
}

export interface ActiveAsrTranscribe {
  promise: Promise<AsrSharedTranscribeResult>;
  sourceLabel: string;
  videoKey: string;
}

export type AsrFallbackOutcome = "skip" | "done" | "empty" | "error";

export interface LoadAsrTrackOptions {
  runId: number;
  allowTranscribe?: boolean;
  sourceLabel?: string;
  fallbackBody?: SubtitleItem[];
}

export interface AsrFallback {
  maybeRunAsrFallback: (args: { runId: number }) => Promise<AsrFallbackOutcome>;
  loadAsrTrack: (args: LoadAsrTrackOptions) => Promise<AsrFallbackOutcome>;
  awaitActiveAsrTranscribe: (args: { runId: number; bvid: string; cid: string }) => Promise<void>;
  hasActiveAsrTranscribe: (args: { bvid: string; cid: string }) => boolean;
}

export function createAsrFallback(deps: CreateAsrFallbackDeps): AsrFallback {
  const {
    getSettings,
    loadProviders,
    setStatus,
    acceptSubtitle,
    commitNoSubtitle,
    runAsrPipeline,
    broadcastSubtitleStatus,
    sleepFor = sleep
  } = deps;

  const activeAsrTranscribes = new Map<string, ActiveAsrTranscribe>();

  async function runOrJoinAsrTranscribe({
    runId,
    bvid,
    cid,
    videoKey,
    cacheKey,
    identity,
    sourceLabel,
    isStale,
    statusMessage,
    recordNoSubtitleReason
  }: {
    runId: number;
    bvid: string;
    cid: string;
    videoKey: string;
    cacheKey: string;
    identity: TrackIdentity;
    sourceLabel: string;
    isStale: () => boolean;
    statusMessage: string;
    recordNoSubtitleReason: boolean;
  }): Promise<"done" | "empty"> {
    setStatus(statusMessage);
    broadcastSubtitleStatus("asr-transcribing");

    const active = activeAsrTranscribes.get(cacheKey);
    if (active) {
      const shared = await active.promise;
      const sharedBody = shared.body;
      if (!Array.isArray(sharedBody) || sharedBody.length === 0) {
        if (isStale()) {
          throw makeStaleRunError();
        }
        if (recordNoSubtitleReason) {
          const { reason, detail } = classifyEmptyOutcome(shared.outcome);
          setNoSubtitleReasonWithDetail(reason, detail);
        }
        return "empty";
      }
      return finishAsrFallback({ runId, body: sharedBody, sourceLabel });
    }

    let emptyDiag = "";
    const runAttempt = async (): Promise<{ body: SubtitleItem[]; outcome: AsrAttemptOutcome }> => {
      emptyDiag = "";
      let outcome: AsrAttemptOutcome = { totalChunks: 0, failedChunks: 0, elapsedMs: 0 };
      const rawBody = await runAsrPipeline({
        bvid,
        cid,
        onProgress: (msg) => {
          if (!isStale()) {
            setStatus(msg);
          }
        },
        onEmptyDiagnostic: (diagText) => {
          emptyDiag = diagText;
        },
        onAttemptOutcome: (o) => {
          outcome = o;
        }
      });
      const body = Array.isArray(rawBody) ? rawBody : [];
      if (body.length > 0) {
        const saveResult = await persistAsrSubtitleToCache({ bvid, cid, identity, body });
        if (saveResult && saveResult.ok === false) {
          logWarn("[BILISCRIPT] 语音识别结果已生成，但本地缓存写入失败（已自动清理旧缓存仍失败），仅本次会话有效。");
        }
      }
      return { body, outcome };
    };

    const transcribePromise = (async () => {
      try {
        let outcome: AsrAttemptOutcome = { totalChunks: 0, failedChunks: 0, elapsedMs: 0 };
        let body: SubtitleItem[] = [];
        for (let attemptNo = 0; attemptNo <= ASR_RUN_RETRIES; attemptNo += 1) {
          const attempt = await runAttempt();
          body = attempt.body;
          outcome = attempt.outcome;
          const canRetry =
            body.length === 0 &&
            Number(outcome.failedChunks) > 0 &&
            Number(outcome.elapsedMs) < ASR_RETRY_MAX_ELAPSED_MS &&
            !isStale() &&
            attemptNo < ASR_RUN_RETRIES;
          if (!canRetry) {
            break;
          }
          setStatus("语音识别失败，正在自动重试…");
          await sleepFor(ASR_RETRY_DELAY_MS);
        }
        return { body, outcome };
      } finally {
        activeAsrTranscribes.delete(cacheKey);
      }
    })();
    activeAsrTranscribes.set(cacheKey, { promise: transcribePromise, sourceLabel, videoKey });

    const { body, outcome } = await transcribePromise;

    if (!Array.isArray(body) || body.length === 0) {
      if (isStale()) {
        logInfo("[BILISCRIPT] asr transcribe finished empty after video switch; terminal broadcast only", {
          bvid,
          cid,
          ...(emptyDiag ? { diagnostic: emptyDiag } : {})
        });
        broadcastSubtitleStatus("asr-done");
        throw makeStaleRunError();
      }
      if (recordNoSubtitleReason) {
        const { reason, detail } = classifyEmptyOutcome(outcome);
        setNoSubtitleReasonWithDetail(reason, detail);
      }
      broadcastSubtitleStatus("asr-done");
      return "empty";
    }

    if (isStale()) {
      logInfo("[BILISCRIPT] asr transcribe finished after video switch; result cached, UI deferred", {
        bvid,
        cid,
        itemCount: body.length
      });
      broadcastSubtitleStatus("asr-done");
      return "done";
    }

    return finishAsrFallback({ runId, body, sourceLabel });
  }

  async function maybeRunAsrFallback({ runId }: { runId: number }): Promise<AsrFallbackOutcome> {
    let bvid = "";
    let cid = "";
    let isStale: () => boolean = () => false;
    try {
      ensureRunActive(runId, state.clip.fetchRunId);

      const settings = state.settings || (await getSettings());
      const enabled = settings.asrAutoFallback === true;
      if (!enabled) {
        setNoSubtitleReasonWithDetail("asr-disabled", "");
        return "skip";
      }

      const providers = await loadProviders();
      const providerList = Array.isArray(providers) ? providers : [];
      const activeId = resolveActiveAsrProviderId(providerList, settings.activeAsrProviderId);
      const activeProvider = providerList.find((p) => p.id === activeId);
      if (!activeProvider) {
        setNoSubtitleReasonWithDetail("no-asr-config", "");
        return "skip";
      }
      const language = String(settings.asrLanguage || "").trim() || "auto";
      const sourceLabel = buildAsrSubtitleLabel(language);
      const model = String(activeProvider.model || "").trim();
      bvid = state.clip.bvid;
      cid = state.clip.cid;
      const videoKey = `${bvid}|${cid}`;
      isStale = () => `${state.clip.bvid}|${state.clip.cid}` !== videoKey;
      const identity: TrackIdentity = { kind: "asr", providerId: activeId, model, lang: language };
      const cacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        identity
      });

      const cachedBody = await loadSubtitleFromCache(cacheKey);
      ensureRunActive(runId, state.clip.fetchRunId);
      if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
        const cachedCheck = validateSubtitleByDuration(cachedBody as SubtitleItem[], state.clip.videoDuration);
        if (cachedCheck.ok) {
          seedAsrPseudoTrack(sourceLabel);
          await acceptSubtitle({
            body: cachedBody as SubtitleItem[],
            selectedSubtitleId: ASR_SUBTITLE_TRACK_ID,
            selectedSubtitleUrl: "",
            selectedSubtitleLang: sourceLabel
          });
          setStatus("语音识别完成（缓存命中）。");
          return "done";
        }
        logWarn("[BILISCRIPT] cached asr subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: (cachedCheck as { reason?: string }).reason
        });
        await clearSubtitleCacheByKey(cacheKey);
        ensureRunActive(runId, state.clip.fetchRunId);
      }

      return await runOrJoinAsrTranscribe({
        runId,
        bvid,
        cid,
        videoKey,
        cacheKey,
        identity,
        sourceLabel,
        isStale,
        statusMessage: "无字幕轨，正在使用语音转写生成字幕…",
        recordNoSubtitleReason: true
      });
    } catch (error) {
      if (isStaleRunError(error)) {
        throw error;
      }
      if (isStale()) {
        const phase = (error as { code?: string }).code === "asr-skip" ? "asr-done" : "asr-failed";
        logWarn("[BILISCRIPT] asr transcribe failed after video switch; terminal broadcast only", {
          bvid,
          cid,
          phase,
          message: getErrorMessage(error)
        });
        broadcastSubtitleStatus(phase);
        throw makeStaleRunError();
      }
      if ((error as { code?: string }).code === "asr-skip") {
        broadcastSubtitleStatus("asr-done");
        setNoSubtitleReasonWithDetail(noSubtitleReasonFromAsrSkipError(error), "");
        return "skip";
      }
      const failureError = error as { kind?: unknown };
      const reason = reasonFromFailureKind(failureError.kind);
      logWarn("[BILISCRIPT] asr fallback failed", {
        bvid,
        cid,
        reason,
        kind: failureError.kind,
        message: getErrorMessage(error)
      });
      setNoSubtitleReasonWithDetail(reason, "");
      broadcastSubtitleStatus("asr-failed");
      await commitNoSubtitle({ noSubtitleReason: reason });
      return "error";
    }
  }

  async function loadAsrTrack({
    runId,
    allowTranscribe = true,
    sourceLabel: requestedLabel,
    fallbackBody
  }: LoadAsrTrackOptions): Promise<AsrFallbackOutcome> {
    let bvid = "";
    let cid = "";
    let isStale: () => boolean = () => false;
    try {
      ensureRunActive(runId, state.clip.fetchRunId);

      const settings = state.settings || (await getSettings());
      ensureRunActive(runId, state.clip.fetchRunId);

      const providers = await loadProviders().catch(() => []);
      ensureRunActive(runId, state.clip.fetchRunId);
      const providerList = Array.isArray(providers) ? providers : [];
      const activeId = resolveActiveAsrProviderId(providerList, settings.activeAsrProviderId);
      const activeProvider = providerList.find((p) => p.id === activeId) ?? null;

      const language = String(settings.asrLanguage || "").trim() || "auto";
      const defaultLabel = String(requestedLabel || "").trim() || buildAsrSubtitleLabel(language);
      const model = String(activeProvider?.model || "").trim();
      bvid = state.clip.bvid;
      cid = state.clip.cid;
      const videoKey = `${bvid}|${cid}`;
      isStale = () => `${state.clip.bvid}|${state.clip.cid}` !== videoKey;

      const preferredIdentity: TrackIdentity | null = activeProvider
        ? { kind: "asr", providerId: activeId, model, lang: language }
        : null;
      const preferredCacheKey = preferredIdentity
        ? getSubtitleCacheKey({ bvid, cid, identity: preferredIdentity })
        : undefined;

      const cachedRecord = await findCachedAsrSubtitleTrack({
        bvid,
        cid,
        preferredCacheKey
      });
      ensureRunActive(runId, state.clip.fetchRunId);
      if (cachedRecord && cachedRecord.body.length > 0) {
        const cachedCheck = validateSubtitleByDuration(cachedRecord.body, state.clip.videoDuration);
        if (cachedCheck.ok) {
          const label =
            String(requestedLabel || "").trim() ||
            buildAsrSubtitleLabel(cachedRecord.lang || language);
          seedAsrPseudoTrack(label);
          await acceptSubtitle({
            body: cachedRecord.body,
            selectedSubtitleId: ASR_SUBTITLE_TRACK_ID,
            selectedSubtitleUrl: "",
            selectedSubtitleLang: label
          });
          setStatus("语音识别完成（缓存命中）。");
          return "done";
        }
        logWarn("[BILISCRIPT] cached asr subtitle duration mismatch, clearing cache", {
          cacheKey: cachedRecord.cacheKey,
          reason: (cachedCheck as { reason?: string }).reason
        });
        await clearSubtitleCacheByKey(cachedRecord.cacheKey);
        ensureRunActive(runId, state.clip.fetchRunId);
      }

      if (Array.isArray(fallbackBody) && fallbackBody.length > 0) {
        const fallbackCheck = validateSubtitleByDuration(fallbackBody, state.clip.videoDuration);
        if (fallbackCheck.ok) {
          seedAsrPseudoTrack(defaultLabel);
          await acceptSubtitle({
            body: fallbackBody,
            selectedSubtitleId: ASR_SUBTITLE_TRACK_ID,
            selectedSubtitleUrl: "",
            selectedSubtitleLang: defaultLabel
          });
          return "done";
        }
      }

      if (!allowTranscribe || !activeProvider || !preferredIdentity || !preferredCacheKey) {
        return "skip";
      }

      return await runOrJoinAsrTranscribe({
        runId,
        bvid,
        cid,
        videoKey,
        cacheKey: preferredCacheKey,
        identity: preferredIdentity,
        sourceLabel: defaultLabel,
        isStale,
        statusMessage: "正在使用语音转写生成字幕…",
        recordNoSubtitleReason: false
      });
    } catch (error) {
      if (isStaleRunError(error)) {
        throw error;
      }
      if (isStale()) {
        const phase = (error as { code?: string }).code === "asr-skip" ? "asr-done" : "asr-failed";
        logWarn("[BILISCRIPT] asr track load failed after video switch; terminal broadcast only", {
          bvid,
          cid,
          phase,
          message: getErrorMessage(error)
        });
        broadcastSubtitleStatus(phase);
        throw makeStaleRunError();
      }
      if ((error as { code?: string }).code === "asr-skip") {
        broadcastSubtitleStatus("asr-done");
        return "skip";
      }
      const failureError = error as { kind?: unknown };
      const reason = reasonFromFailureKind(failureError.kind);
      logWarn("[BILISCRIPT] asr track load failed", {
        bvid,
        cid,
        reason,
        kind: failureError.kind,
        message: getErrorMessage(error)
      });
      broadcastSubtitleStatus("asr-failed");
      return "error";
    }
  }

  async function awaitActiveAsrTranscribe({ runId, bvid, cid }: { runId: number; bvid: string; cid: string }): Promise<void> {
    const videoKey = `${bvid}|${cid}`;
    let active: ActiveAsrTranscribe | null = null;
    for (const entry of activeAsrTranscribes.values()) {
      if (entry.videoKey === videoKey) {
        active = entry;
        break;
      }
    }
    if (!active) {
      return;
    }
    try {
      const shared = await active.promise;
      const sharedBody = shared.body;
      if (!Array.isArray(sharedBody) || sharedBody.length === 0) {
        const { reason, detail } = classifyEmptyOutcome(shared.outcome);
        setNoSubtitleReasonWithDetail(reason, detail);
        const failure = readAsrFailureSummary(shared.outcome);
        setStatus(buildAsrNoSubtitleMessage("status-line", reason, { status: failure?.status, detail: failure?.detail }));
        broadcastSubtitleStatus("asr-done");
        return;
      }
      await finishAsrFallback({ runId, body: sharedBody, sourceLabel: active.sourceLabel });
    } catch {
    }
  }

  async function finishAsrFallback({ runId, body, sourceLabel }: { runId: number; body: SubtitleItem[]; sourceLabel: string }): Promise<"done"> {
    ensureRunActive(runId, state.clip.fetchRunId);
    seedAsrPseudoTrack(sourceLabel);
    await acceptSubtitle({
      body,
      selectedSubtitleId: ASR_SUBTITLE_TRACK_ID,
      selectedSubtitleUrl: "",
      selectedSubtitleLang: sourceLabel
    });
    setStatus(`语音识别完成，已生成 ${body.length} 条字幕。`);
    broadcastSubtitleStatus("asr-done");
    return "done";
  }

  function hasActiveAsrTranscribe({ bvid, cid }: { bvid: string; cid: string }): boolean {
    const videoKey = `${bvid}|${cid}`;
    for (const entry of activeAsrTranscribes.values()) {
      if (entry.videoKey === videoKey) {
        return true;
      }
    }
    return false;
  }

  return { maybeRunAsrFallback, loadAsrTrack, awaitActiveAsrTranscribe, hasActiveAsrTranscribe };
}
