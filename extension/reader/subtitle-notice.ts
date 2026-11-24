import { activeById } from "../shared/active-host.js";
import {
  getAsrFailureNotice,
  type AsrFailureDetailInput
} from "../core/asr-failure-notice.js";
import type { NoSubtitleReason } from "../core/state.js";
import { ids } from "./state.js";

export const SUBTITLE_NOTICE_AUTO_HIDE_MS = 6000;
export const YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE =
  "未能获取该 YouTube 视频的字幕正文，请在视频播放器底部开启原生 CC 字幕开关后重试。";

type NoticeNode = HTMLElement & { __biliscriptNoticeTimer?: number | undefined };

function cancelAutoHide(node: NoticeNode): void {
  if (node.__biliscriptNoticeTimer !== undefined) {
    clearTimeout(node.__biliscriptNoticeTimer);
    delete node.__biliscriptNoticeTimer;
  }
}

export function resolveNoSubtitleNoticeText(
  reason: NoSubtitleReason,
  detail?: AsrFailureDetailInput | null
): string {
  if (reason === "youtube-captions-unavailable") {
    return YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE;
  }
  const notice = getAsrFailureNotice(reason, detail);
  return [notice.cause, notice.remedyText, notice.detail].filter(Boolean).join(" ");
}

export function showSubtitleNotice(text: string | number | null | undefined): void {
  const node = activeById<NoticeNode>(ids.readingSubtitleNotice);
  if (!node) {
    return;
  }
  const next = String(text ?? "").trim();
  cancelAutoHide(node);
  node.textContent = next;
  node.hidden = !next;
  if (!next) {
    return;
  }
  node.__biliscriptNoticeTimer = window.setTimeout(() => {
    delete node.__biliscriptNoticeTimer;
    node.textContent = "";
    node.hidden = true;
  }, SUBTITLE_NOTICE_AUTO_HIDE_MS);
}

export function showNoSubtitleNotice(
  reason: NoSubtitleReason,
  detail?: AsrFailureDetailInput | null
): void {
  showSubtitleNotice(resolveNoSubtitleNoticeText(reason, detail));
}

export function clearSubtitleNotice(): void {
  showSubtitleNotice("");
}
