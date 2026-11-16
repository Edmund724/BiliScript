// 轻量状态文本写入器（候选3 常驻瘦身）。
//
// setStatus 把文案写入 state.ui.statusText，供转写横幅的进度行与总结链（clip 快照、
// 侧边栏轮询）读取；它不落任何可见的状态行——面板里没有常驻状态位，正常流程
// 不提示，失败在出错的位置就地提示（按钮反馈 / 字幕区提示 / 列表空态）。
//
// 02 分层归位：自 shared/ 下沉 core/——本模块要写 core/state 的 ui 状态，
// 留在 shared 会让 shared 反向 import 上层，破 shared 叶子纪律。落 core 后
// core 只向下依赖 shared，依赖方向捋顺。

import { uiState } from "./state.js";

export function setStatus(text: string): void {
  uiState.setStatusText(String(text || ""));
}
