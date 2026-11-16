// 字幕 tab 内的就地失败提示：切轨 / 副字幕 / 译文失败、播放器缺失等发生在字幕区
// 的失败，显示在字幕列表上方；成功与进行中状态一律不提示。
// 文案写入即显示，到时自动收起；新文案覆盖旧文案并重置计时。节点属字幕 tab 模板，
// 视图未开（节点不存在）时静默丢弃。
//
// 计时句柄挂在节点上（与 core/reader-transcribing 同口径的「状态跟 DOM 走」），
// 壳重建换节点时旧句柄随旧节点一起作废。

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
