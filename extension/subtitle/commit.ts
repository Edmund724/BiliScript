import { state, clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";
import { STATUS_LINE_BASE, getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { normalizeSubtitleSegmentationStrategy } from "../core/validators.js";
import { findTrackByRef, sortSubtitleBodyByFrom } from "./selection.js";
import { segmentSubtitles, shouldSegmentTrack, type CoarseSubtitleInput } from "./segmentation.js";
import { buildSegmentationSignature, saveSegmentedSubtitleTrack } from "./cache.js";
import { subtitleSourceKey, trackIdentity } from "./source-key.js";
import { refreshHotComments, invalidateDerived } from "./core.js";
import { slot } from "./slot.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";
import { publishSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { ensureRunActive } from "../shared/error-helpers.js";

export interface CommitUiCallbacks {
  setStatus(message: string): void;
}

let commitUi: CommitUiCallbacks | null = null;

export function configureCommitUi({ setStatus }: CommitUiCallbacks) {
  commitUi = { setStatus };
}

export interface AcceptSubtitleArgs {
  body: unknown[] | null | undefined;
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
}: AcceptSubtitleArgs): Promise<unknown[] | null | undefined> {
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  const sortedInput = sortSubtitleBodyByFrom(body);
  const matchedTrack = findTrackByRef(state.clip.subtitles, {
    id: selectedSubtitleId,
    url: selectedSubtitleUrl
  });
  const trackLan = typeof matchedTrack?.lan === "string" ? matchedTrack.lan : undefined;
  const strategy = normalizeSubtitleSegmentationStrategy(state.settings?.subtitleSegmentationStrategy);
  const segmented = Array.isArray(sortedInput)
    ? shouldSegmentTrack({
        strategy,
        selectedSubtitleId,
        selectedSubtitleLang,
        trackLan,
        items: sortedInput as CoarseSubtitleInput[]
      })
    : false;
  const segmentedBody = Array.isArray(sortedInput)
    ? segmentSubtitles(sortedInput as CoarseSubtitleInput[], {
        strategy,
        selectedSubtitleId,
        selectedSubtitleLang,
        trackLan
      })
    : sortedInput;
  const sortedBody = sortSubtitleBodyByFrom(segmentedBody);
  slot.install(
    {
      id: selectedSubtitleId,
      url: selectedSubtitleUrl,
      lang: selectedSubtitleLang
    },
    sortedBody as SubtitleBodyItem[]
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
      await saveSegmentedSubtitleTrack({
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        trackKey,
        segmentationSig,
        items: sortedBody
      });
    } catch {
    }
  }
  return sortedBody;
}

export interface AcceptSecondarySubtitleArgs {
  body: unknown[] | null | undefined;
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
    sortedBody as SubtitleBodyItem[]
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
