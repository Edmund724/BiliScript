// Reader 动态域入口（lazy-reader 的 import() 落点）。
//
// 本文件是 reader/lazy-reader.ts 动态 import("./index.js") 的物理入口，
// esbuild 需要它作为 reader 动态 chunk 的入口模块。它不是 facade：外部模块对
// 静态/常驻符号（ids/view-state/scroll-state/page-state）应直接 import
// "./state.js"，本文件不再转发。
//
// 本文件只聚合 reader 动态域（LAYOUT/SYNC/LIFECYCLE）的导出，供 ensureReaderDomain()
// 装载后使用。依赖图保持无环：
//   reader-bus.ts    显式回调端口组 + 通知/命令槽
//   LAYOUT          video-bind.js + script-host.js → reader-bus 端口组
//   SYNC            sync.js                                        → LAYOUT + reader-bus
//   LIFECYCLE       lifecycle.js                                   → SYNC + LAYOUT + reader-bus
// （reader-bus 的端口组承载逆依赖回调；lifecycle.js 启动时单点注册。
//   player-host/hover-chrome 已随整页接管退役。）
//
// Import-cycle note (issue 08): the reader implementation modules deliberately
// import nothing from core/runtime.js — they read reader DOM ids through local
// helpers and delegate settings persistence/loading to content.js through the
// reader-bus seam (presenter.ts 的改名，arch-slim-2/03). This keeps the reader
// domain free of any static import path back through subtitle/fetcher.js.

// ===== lifecycle.js（reader shell）：组装根——生命周期 + 实例持有 + reader-bus 通知处理体 =====

// 进入阅读模式
export { enterReaderMode } from "./lifecycle.js";
// 退出阅读模式（关闭阅读视图并清理页面状态）
export { closeReadingView } from "./lifecycle.js";
// 渲染阅读视图主体：渲染驱动（base 投影 + 会话态投影）由 lifecycle 装配，
// 投影知识在 ./view-render.ts。
export { renderReadingView } from "./lifecycle.js";
// 阅读视图打开后的交互呈现（renderReaderPanels 是渲染投影之一，属主在 view-render）
export { updateReaderPreferences } from "./lifecycle.js";
export { renderReaderPanels } from "./view-render.js";
// reader-bus seam 通知的 reader 侧处理体与字幕就绪副作用单一收口
export { handleReaderPresenterNotification, onReaderSubtitleReady } from "./lifecycle.js";
// 阅读模式调试快照真身
export { createReaderDebugSnapshot } from "./debug-snapshot.js";

// ===== LAYOUT 层：video-bind.js + script-host.js =====

// 阅读视图的播放器绑定（LAYOUT · video-bind 域，自退役的 player-host 迁出）
export { bindReadingViewVideo } from "./video-bind.js";

// ===== sync.js (SYNC): playback↔subtitle sync =====

// 播放↔字幕同步域：定时器、滚动暂停、章节/字幕点击跳转与跟随状态均来自 ./sync.js
//（依赖 LAYOUT 层 video-bind.js）。
export { startReadingViewSync } from "./sync.js";
export { stopReadingViewSync } from "./sync.js";
export { syncReadingViewPlayback } from "./sync.js";
export { jumpReadingTarget } from "./sync.js";
// seek 深入口（候选06）：阅读视图内点击与侧栏时间戳 seek 的唯一规范序入口
export { seekReadingTarget } from "./sync.js";
export { onReadingSubtitleClick } from "./sync.js";
export { noteManualReaderInteraction } from "./sync.js";
export { updateReaderFollowState } from "./sync.js";
// PR3：Follow playback 悬浮按钮的恢复跟随回调
export { resumeReaderFollowPlayback } from "./sync.js";

// ===== 字幕 tab：句内搜索 / 转写中间态横幅 =====

// 句内搜索：refresh（renderReadingView 尾部重放 + 输入变化）、move（上/下一条）、
// clear（closeReadingView 会话收尾）。实例由 lifecycle（组装根）持有，此处转发具名入口。
export { refreshReadingSubtitleSearch, moveReadingSubtitleSearch, clearReadingSubtitleSearch } from "./lifecycle.js";
// 转写中间态横幅：渲染尾部/tick 收敛（update）与转写中判定
export { updateReadingTranscribeBanner, isReaderTranscribing } from "./transcribe-banner.js";

// ===== 字幕 tab：选区「解释」卡片（reader/explain-card.js） =====

// 打开卡片并发起解释（reader/explain-pop-ui.ts 选区浮层点击经 ui/reader-gate 触达）、卡片内点击委托
//（关闭 / 重试 / 去对话追问）、关闭（closeReadingView 会话收尾）、开着判定。
export {
  openReaderExplainCard,
  onReaderExplainCardClick,
  closeReaderExplainCard,
  isReaderExplainCardOpen
} from "./explain-card.js";

// ===== 概览 tab：协调器实例 + 状态机触达入口（壳 tab 切换回调经 ui/reader-gate 调用面） =====

// 概览协调器实例与状态机触达入口：实例由 lifecycle（组装根）装配持有，此处转发
// 具名入口；呈现函数与类型直挂其属主模块。
export {
  overviewCoordinator,
  ensureReaderOverviewTab,
  triggerReaderOverviewGeneration,
  renderReadingOverview,
  cancelReaderOverview,
  resetReaderOverviewState,
  getReaderOverviewPhase,
  getReaderOverviewSnapshot
} from "./lifecycle.js";
export type {
  ReaderOverviewPhase,
  ReaderOverviewSnapshot,
  ReaderOverviewCoordinator
} from "./overview-coordinator.js";
// 概览 tab 点击委托（壳 tab 切换回调经 ui/reader-gate 调用面）
export { onReadingOverviewClick } from "./overview-ui.js";
