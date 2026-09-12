// shared/dom-ids.ts — Digest 面板与阅读视图的 DOM id 契约表（shared 叶子）。
//
// 为什么独立成 shared 叶子：id 表被三方共享——UI 模板（ui/ui-renderer.js
// buildUiHtml）、总结链（subtitle/ui.js）与 reader 域实现（video-bind/
// sync/lifecycle）。它只是一张纯常量表、零依赖，因此放在 shared 谁都能取；
// 早先它由 reader/state.js 持有时，shared/ui-status.js 为了读一个 id 就得反向
// import reader 域，破了 shared 的叶子纪律（02 分层归位把它下沉到此处）。

export const ids = {
  root: "boc-root",
  // digest-only-ui：经典侧栏面板 ids（panel/status/meta/subtitleSelect/preview/
  // message/copyBtn/downloadBtn/refreshBtn/closeBtn/settingsBtn）已随 A 形态壳
  // 删除——Digest 面板是唯一界面，状态/消息写入 #boc-reading-status。
  readingView: "boc-reading-view",
  readingStatus: "boc-reading-status",
  readingCloseBtn: "boc-reading-close-btn",
  readingThemeSelect: "boc-reading-theme-select",
  readingSettingsBtn: "boc-reading-settings-btn",
  readingSettingsPanel: "boc-reading-settings-panel",
  readingSubtitleSelect: "boc-reading-subtitle-select",
  readingSettingsHost: "boc-reading-settings-host",
  readingMeta: "boc-reading-meta",
  readingSubtitleList: "boc-reading-subtitle",
  // 统一 Digest 面板（PR2）：右侧面板壳 + 三标签（字幕/概览/AI 对话）分段控件。
  // 字幕列表（readingSubtitleList）整体挂进字幕 tab body；概览/AI 对话为诚实占位。
  readingDigestPanel: "boc-reading-digest-panel",
  readingTabSubtitle: "boc-reading-tab-subtitle",
  readingTabOverview: "boc-reading-tab-overview",
  readingTabChat: "boc-reading-tab-chat",
  readingTabBodySubtitle: "boc-reading-tabbody-subtitle",
  readingTabBodyOverview: "boc-reading-tabbody-overview",
  readingTabBodyChat: "boc-reading-tabbody-chat",
  // PR4 概览 tab 渲染宿主：reader/overview.ts 按状态机整块重建其内容
  //（idle/generating/ready/partial/error/empty，全诚实态）。
  readingOverviewBody: "boc-reading-overview-body",
  // PR3 字幕 tab 五件事：句内搜索、Copy/Export、Follow 悬浮按钮、转写中间态
  // 横幅、选区「解释」浮层与卡片、AI 对话 tab 的待解释意图卡。
  readingSearchInput: "boc-reading-search-input",
  readingSearchCount: "boc-reading-search-count",
  readingSearchPrevBtn: "boc-reading-search-prev",
  readingSearchNextBtn: "boc-reading-search-next",
  readingCopySubtitleBtn: "boc-reading-copy-subtitle",
  readingExportSubtitleBtn: "boc-reading-export-subtitle",
  readingFollowBtn: "boc-reading-follow-btn",
  readingTranscribeBanner: "boc-reading-transcribe-banner",
  readingTranscribeProgress: "boc-reading-transcribe-progress",
  readingExplainPop: "boc-reading-explain-pop",
  // 选区「解释」卡片宿主（面板内弹层；状态机与渲染在 reader/explain-card.ts）
  readingExplainCard: "boc-reading-explain-card",
  // PR3 占位期的待解释意图卡（PR5 起由对话 tab 组合根渲染/消费）
  readingChatIntent: "boc-reading-chat-intent",
  // PR5 AI 对话 tab（readingChat* 前缀，不用 sp 前缀）：对话区全部元素 id。
  // 结构与 sidepanel.html 的 sp* 树一一对应（context chip / 刷新 / 设置 / 新对话、
  // 转写提示行、消息区、模型/思考档/预设/历史、输入卡片），逻辑内核
  // 在 reader/chat-tab.ts（组合根）+ reader/chat-{lists,notices,popovers}.ts
  //（重建壳）+ ../chat/*（内核）。
  readingChatRoot: "boc-reading-chat",
  readingChatContextChip: "boc-reading-chat-context-chip",
  readingChatHistoryBtn: "boc-reading-chat-history-btn",
  readingChatRefreshBtn: "boc-reading-chat-refresh-btn",
  readingChatNewBtn: "boc-reading-chat-new-btn",
  readingChatOpenSettings: "boc-reading-chat-open-settings",
  readingChatAsrNotice: "boc-reading-chat-asr-notice",
  readingChatMessages: "boc-reading-chat-messages",
  readingChatSuggestions: "boc-reading-chat-suggestions",
  readingChatModelSelect: "boc-reading-chat-model-select",
  // 模型 + 思考档位面板（发送框底部 chip 弹出）：分组模型列表 + 底部固定
  // 思考档位行与「关不掉」提示行；chip 是隐藏 select 的展示层。
  readingChatModelChip: "boc-reading-chat-model-chip",
  readingChatModelPanel: "boc-reading-chat-model-panel",
  readingChatModelList: "boc-reading-chat-model-list",
  readingChatThinkingToggle: "boc-reading-chat-thinking-toggle",
  // 思考档位「关不掉」提示行（工单 03）：档位行之后（面板底部固定区），
  // 默认 hidden，对话组合根（reader/chat-tab.ts）按 resolver 判定显隐。
  readingChatThinkingHint: "boc-reading-chat-thinking-hint",
  readingChatPresetBtn: "boc-reading-chat-preset-btn",
  readingChatPresetPopover: "boc-reading-chat-preset-popover",
  readingChatPresetList: "boc-reading-chat-preset-list",
  readingChatPresetInput: "boc-reading-chat-preset-input",
  readingChatPresetAddBtn: "boc-reading-chat-preset-add-btn",
  readingChatHistoryPopover: "boc-reading-chat-history-popover",
  readingChatHistoryList: "boc-reading-chat-history-list",
  readingChatHistoryClearBtn: "boc-reading-chat-history-clear-btn",
  readingChatInput: "boc-reading-chat-input",
  readingChatInputBar: "boc-reading-chat-input-bar",
  // 发送按钮：空闲为 ↑（空输入禁用），流式中切换为停止键（圆形 + 方块图标）。
  readingChatSendBtn: "boc-reading-chat-send-btn"
};
