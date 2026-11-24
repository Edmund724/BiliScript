import { state, clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";
import { STATUS_LINE_BASE, getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { normalizeSubtitleSegmentationStrategy } from "../core/validators.js";
import { findTrackByRef, sortSubtitleBodyByFrom } from "./selection.js";
import { segmentSubtitles, shouldSegmentTrack } from "./segmentation.js";
import { buildSegmentationSignature, saveSegmentedSubtitleTrack } from "./cache.js";
import { subtitleSourceKey, trackIdentity } from "./source-key.js";
import { refreshHotComments, invalidateDerived } from "./core.js";
import { slot } from "./slot.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";
import { publishSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { ensureRunActive } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";

export interface CommitUiCallbacks {
  setStatus(message: string): void;
}

let commitUi: CommitUiCallbacks | null = null;

export function configureCommitUi({ setStatus }: CommitUiCallbacks) {
  commitUi = { setStatus };
}

export interface AcceptSubtitleArgs {
  body: SubtitleBodyItem[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
  runId?: number;
  skipHotComments?: boolean;
}

export async function acceptSubtitle({
  body,
  selectedSubtitleId,
  selectedSubtitleUrl,
  selectedSubtitleLang,
  runId,
  skipHotComments = false
}: AcceptSubtitleArgs): Promise<SubtitleBodyItem[]> {
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  const sortedInput = sortSubtitleBodyByFrom(body);
  const matchedTrack = findTrackByRef(state.clip.subtitles, {
    id: selectedSubtitleId,
    url: selectedSubtitleUrl
  });
  const trackLan = typeof matchedTrack?.lan === "string" ? matchedTrack.lan : undefined;
  const trackOrigin = matchedTrack?.origin;
  const trackKind = matchedTrack?.kind;
  const trackSource = matchedTrack?.source;
  const strategy = normalizeSubtitleSegmentationStrategy(state.settings?.subtitleSegmentationStrategy);
  const segmented = Array.isArray(sortedInput)
    ? shouldSegmentTrack({
        strategy,
        selectedSubtitleId,
        selectedSubtitleLang,
        trackLan,
        origin: trackOrigin,
        kind: trackKind,
        source: trackSource,
        items: sortedInput
      })
    : false;
  const segmentedBody = Array.isArray(sortedInput)
    ? segmentSubtitles(sortedInput, {
        strategy,
        selectedSubtitleId,
        selectedSubtitleLang,
        trackLan,
        origin: trackOrigin,
        kind: trackKind,
        source: trackSource
      })
    : sortedInput;
  const sortedBody = sortSubtitleBodyByFrom(segmentedBody);
  const normalizedBody: SubtitleBodyItem[] = Array.isArray(sortedBody) ? sortedBody : [];
  slot.install(
    {
      id: selectedSubtitleId,
      url: selectedSubtitleUrl,
      lang: selectedSubtitleLang
    },
    normalizedBody
  );
  if (!skipHotComments) {
    await refreshHotComments();
  }
  notifyReaderPresenter({ kind: "subtitle-ready" });
  publishSubtitleStatusPhase("subtitle-ready");
  if (segmented && strategy !== "off" && Array.isArray(sortedBody) && state.clip.bvid && state.clip.cid) {
    try {
      const trackKey = subtitleSourceKey(trackIdentity(selectedSubtitleId, selectedSubtitleUrl, selectedSubtitleLang));
      const segmentationSig = buildSegmentationSignature({
        strategy,
        lang: trackLan || selectedSubtitleLang
      });
      const saveResult = await saveSegmentedSubtitleTrack({
        site: state.clip.site,
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        trackKey,
        segmentationSig,
        items: normalizedBody
      });
      if (saveResult && !saveResult.ok) {
        throw saveResult.error ?? saveResult;
      }
    } catch (error) {
      logWarn("[BILISCRIPT] failed to save segmented subtitle track", {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        error
      });
    }
  }
  return normalizedBody;
}

export interface AcceptSecondarySubtitleArgs {
  body: SubtitleBodyItem[];
  subtitleId: string;
  subtitleUrl: string;
  runId?: number;
}

export async function acceptSecondarySubtitle({
  body,
  subtitleId,
  subtitleUrl,
  runId
}: AcceptSecondarySubtitleArgs): Promise<void> {
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  const sortedBody = sortSubtitleBodyByFrom(body);
  slot.installSecondary(
    {
      id: subtitleId,
      url: subtitleUrl
    },
    Array.isArray(sortedBody) ? sortedBody : []
  );
  notifyReaderPresenter({ kind: "secondary-subtitle-ready" });
}

export interface CommitNoSubtitleArgs {
  noSubtitleReason?: NoSubtitleReason;
  runId?: number;
}

export async function commitNoSubtitle({ noSubtitleReason, runId }: CommitNoSubtitleArgs = {}): Promise<void> {
  if (!commitUi) {
    throw new Error("字幕接受事务的 UI 回调未注入（configureCommitUi），无字幕出口拒绝执行。");
  }
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  slot.clearToEmpty(noSubtitleReason);
  clipState.setHotComments([]);
  invalidateDerived();
  const message = buildNoSubtitleStatusMessage();
  notifyReaderPresenter({ kind: "subtitle-ready" });
  commitUi.setStatus(message);
}

export function buildNoSubtitleStatusMessage(
  base = STATUS_LINE_BASE,
  reason: NoSubtitleReason = clipState.noSubtitleReason,
  detailLine = clipState.noSubtitleDetail
): string {
  const notice = getAsrFailureNotice(reason);
  return [base, notice.cause, notice.remedyText, detailLine].filter(Boolean).join(" ");
}
