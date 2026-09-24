// 轻量状态栏/消息写入器（候选3 常驻瘦身）。
//
// setStatus / setMessage 原在 ui/ui-renderer.js，被 message-handler、player-ai、
// 总结链等多处引用。若继续放在 ui-renderer，该模块随面板/阅读壳一起被拖入
// 常驻闭包。本模块只负责把文案写入 state 并在 DOM 节点已存在时同步更新，
// 不依赖 UI 壳的构建，因此自身保持常驻轻量；ui/ui-renderer.js 的壳构建逻辑
// 则整体惰性化。
//（script-only-ui：经典侧栏面板（#biliscript-status/#biliscript-message）已删除，Script
// 面板是唯一界面——状态/消息的可见宿主收敛到面板 header 下方的
// #biliscript-reading-status（renderReadingStatus 同节点：sync tick 的进度文案会覆盖
// 抓取/操作提示，语义上正是「当前状态行」，阅读视图未开时节点不存在则静默
// 只写 state，clip 快照 payload 与转写横幅仍从 state 取值）。）
//
// 02 分层归位：自 shared/ 下沉 core/——本模块要读写 core/state 的状态行，
// 留在 shared 会让 shared 反向 import 上层，破 shared 叶子纪律。落 core 后
// core 只向下依赖 shared，依赖方向捋顺。

import { state, uiState } from "./state.js";
import { ids } from "../shared/dom-ids.js";

export function setStatus(text: string): void {
  uiState.setStatusText(String(text || ""));
  const node = document.getElementById(ids.readingStatus);
  if (node) {
    node.textContent = state.ui.statusText;
  }
}

export function setMessage(text: string): void {
  uiState.setMessageText(String(text || ""));
  const node = document.getElementById(ids.readingStatus);
  if (node) {
    node.textContent = state.ui.messageText;
  }
}
