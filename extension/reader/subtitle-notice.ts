import { ids } from "./state.js";

export const SUBTITLE_NOTICE_AUTO_HIDE_MS = 6000;

type NoticeNode = HTMLElement & { __biliscriptNoticeTimer?: number | undefined };

function cancelAutoHide(node: NoticeNode): void {
  if (node.__biliscriptNoticeTimer !== undefined) {
    clearTimeout(node.__biliscriptNoticeTimer);
    delete node.__biliscriptNoticeTimer;
  }
}

export function showSubtitleNotice(text: string | number | null | undefined): void {
  const node = document.getElementById(ids.readingSubtitleNotice) as NoticeNode | null;
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

export function clearSubtitleNotice(): void {
  showSubtitleNotice("");
}
