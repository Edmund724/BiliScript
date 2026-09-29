// 转写中判定（转写横幅 / 对话 tab 转写提示 / 面板状态行共用一处）：
// 相位为 asr-transcribing 且字幕体仍为空。subtitleBody 非空时强制不算转写中：
// 字幕接受事务（acceptSubtitle）先写 body 再由 finishAsrFallback 广播 asr-done，
// 中间窗口相位仍是 asr-transcribing，不能让转写态压住已成稿的列表（防御相位残留）。
//
// 自 reader/transcribe-banner.js 下沉 core 的原因：面板状态行的显示策略
//（core/reading-status-line.js）也要用它决定「转写进度是否落 header 行」，
// 而 core 不能反向依赖 reader 域。transcribe-banner 原样再导出该名字，
// reader 域内既有引用（chat-tab/overview/index）不受影响。

import { getSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { state } from "./state.js";

export function isReaderTranscribing(): boolean {
  return getSubtitleStatusPhase() === "asr-transcribing" && !(state.clip.subtitleBody?.length > 0);
}
