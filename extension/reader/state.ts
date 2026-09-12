// Reader 状态微模块聚合（候选04 结构归并）。
//
// 本文件合并原 ids.js / view-state.js / scroll-state.js / page-state.js 四个
// 常驻微模块。它们同属 content 静态 chunk、消费方同一批，合并不改变分包
// 边界，只减少文件碎片与跨文件 import 噪音。
//
// 模块内按原籍分四节，保持原有导出符号名与行为不变；外部消费方统一从
// "./state.js" 导入。

// ===== ids.js：reader 私有 DOM id 表 =====
//
// 为什么聚合前独立成叶子：id 表被 UI 模板（ui/ui-renderer.js buildUiHtml）、
// 总结链（subtitle/ui.js）与 reader 域实现（video-bind/sync/lifecycle）三方
// 共享。若由 LAYOUT 域持有，常驻侧为取一份纯数据就得静态拖入整个
// LAYOUT 域。聚合后本文件仍是 content 静态 chunk 的轻量部分，不 import reader
// 域任何重实现。
//
// 02 分层归位：表体下沉 shared/dom-ids.js——shared/ui-status.js 只需一个 id，
// 却因此反向 import 整个 reader 域，破了 shared 叶子纪律。此处 re-export 保持
// 既有 import 路径（./state.js）不变。

import { ids } from "../shared/dom-ids.js";

export { ids };

// ===== 类选择器契约表（arch-slim-2/03）=====
//
// 模板（ui/ui-renderer.js buildUiHtml）与查询方（reader/lifecycle.js
// renderReadingView）共享、但不是 id 的节点定位，入此表避免字面量双抄。
// 样式消费段在 reader.css（.boc-reading-title）。
export const classes = {
  readingTitle: "boc-reading-title"
} as const;

// ===== view-state.js：阅读视图开关状态访问器 =====
//
// isReaderViewOpen 是纯 state 读取（state.reader.readingViewOpen），被
// ai/player-ai.js、subtitle/fetcher.js、entry/message-handler.js 等域外模块
// 高频使用。聚合后仍只依赖 core/state.js 的常驻叶子，不触碰 reader 域
// 重符号。

import { state } from "../core/state.js";

export function isReaderViewOpen() {
  return state.reader.readingViewOpen;
}

// ===== digest-tab-state：Digest 面板三标签的 single source of truth =====
//
// 当前激活标签的唯一状态位（DOM is-active/aria-selected/hidden 三通道只是本
// 状态的投影，写手是 ui/ui-renderer.js 的 setReaderDigestTab）。此前 tab 状态
// 只存在于 DOM，两个并发写手（shell 进入事务的 reset-tabs 与对话 seam 的
// set-tab:chat）竞态时无从判定与排查——收口成可读状态位后，断言、日志与
// 未来消费方都有单源可依。
//
// 放本叶子而非 core/state：与 scroll-state 同型的瞬态 UI 状态（不持久化、
// 不进 settings 水合），模块级变量随 resetModules 时代自然重置。

export type ReaderDigestTab = "subtitle" | "overview" | "chat";

let readingActiveDigestTab: ReaderDigestTab = "subtitle";

export function getReaderActiveDigestTab(): ReaderDigestTab {
  return readingActiveDigestTab;
}

export function setReaderActiveDigestTab(tab: ReaderDigestTab) {
  readingActiveDigestTab = tab;
}

// ===== scroll-state.js：阅读视图滚动状态共享叶子 =====
//
// 这是 SYNC（./sync.js）与 LAYOUT（./video-bind.js + ./digest-host.js）的共享
// 叶子：拥有手动滚动暂停与程序化滚动两个截止时间的唯一声明与读写函数。
// 放在独立叶子里，让 SYNC 与 LAYOUT 共享同一份状态而不需要访问器穿越
// reader-impl 的闭包 seam，也保持依赖图无环——本模块不 import reader 域内
// 任何其他模块（LAYOUT 仍然不得 import SYNC）。

let manualScrollPauseUntil = 0;    // readingManualScrollPauseUntil
let programmaticScrollUntil = 0;   // readingProgrammaticScrollUntil

export function isManualScrollPaused() {
  return Date.now() < manualScrollPauseUntil;
}

export function resetManualScrollPause() {
  manualScrollPauseUntil = 0;
}

export function isProgrammaticScrolling() {
  return Date.now() <= programmaticScrollUntil;
}

export function setManualScrollPaused(until: number) {
  manualScrollPauseUntil = until;
}

export function setProgrammaticScrollUntil(until: number) {
  programmaticScrollUntil = until;
}

// ===== page-state.js：reader 页面状态守卫 =====
//
// 启动必需的三件套：clearReaderModePageState（清阅读模式页面标记）、
// enforceNormalPageStateIfNeeded（非阅读页状态收敛）、bindNormalPageStateGuard
// （MutationObserver 守卫）。它们全是「DOM 属性读写 + observer 注册」的轻操作，
// 依赖只有 core/state.js、bilibili/video-id-shared.js（isReaderMode）与
// ./presentation-fields.js（纯常量表）——均为常驻轻模块，不触碰 LAYOUT/SYNC/
// LIFECYCLE 的任何重符号，因此整体下沉为常驻，content.js init 无需为它们
// 动态装载 reader 域。

import { uiState } from "../core/state.js";
import { isReaderMode } from "../bilibili/video-id-shared.js";
import { READER_GUARD_CLEAR_ATTRS, READER_GUARD_FILTER } from "./presentation-fields.js";

export function clearReaderModePageState() {
  for (const attr of READER_GUARD_CLEAR_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  for (const attr of READER_GUARD_CLEAR_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
}

function shouldForceNormalPageState(url = location.href) {
  return !isReaderMode(url) && !state.reader.readingViewOpen;
}

export function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

export function bindNormalPageStateGuard() {
  if (state.ui.normalPageStateGuardBound) {
    return;
  }
  uiState.setNormalPageStateGuardBound(true);

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.html
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.body
  });
  enforceNormalPageStateIfNeeded();
}
