// shared/dom-ids.ts — 文摘面板与阅读视图的 DOM id 契约表（shared 叶子）。
//
// 为什么独立成 shared 叶子：id 表被三方共享——UI 模板（ui/ui-renderer.js
// buildUiHtml）、总结链（subtitle/ui.js）与 reader 域实现（video-bind/
// sync/lifecycle）。它只是一张纯常量表、零依赖，因此放在 shared 谁都能取；
// 早先它由 reader/state.js 持有时，shared/ui-status.js 为了读一个 id 就得反向
// import reader 域，破了 shared 的叶子纪律（02 分层归位把它下沉到此处）。

export const ids = {
  root: "biliscript-root",
  // script-only-ui：经典侧栏面板 ids（panel/status/meta/subtitleSelect/preview/
  // message/copyBtn/downloadBtn/refreshBtn/closeBtn/settingsBtn）已随 A 形态壳
  // 删除——文摘面板是唯一界面，状态/消息写入 #biliscript-reading-status。
  readingView: "biliscript-reading-view",
  readingStatus: "biliscript-reading-status",
  readingCloseBtn: "biliscript-reading-close-btn",
  readingThemeSelect: "biliscript-reading-theme-select",
  readingSettingsBtn: "biliscript-reading-settings-btn",
  readingSettingsPanel: "biliscript-reading-settings-panel",
  readingSubtitleSelect: "biliscript-reading-subtitle-select",
  readingSettingsHost: "biliscript-reading-settings-host",
  readingMeta: "biliscript-reading-meta",
  readingSubtitleList: "biliscript-reading-subtitle",
  // 统一 文摘面板（PR2）：右侧面板壳 + 三标签（字幕/概览/AI 对话）分段控件。
  // 字幕列表（readingSubtitleList）整体挂进字幕 tab body；概览/AI 对话为诚实占位。
  readingScriptPanel: "biliscript-reading-script-panel",
  readingTabSubtitle: "biliscript-reading-tab-subtitle",
  readingTabOverview: "biliscript-reading-tab-overview",
  readingTabChat: "biliscript-reading-tab-chat",
  readingTabBodySubtitle: "biliscript-reading-tabbody-subtitle",
  readingTabBodyOverview: "biliscript-reading-tabbody-overview",
  readingTabBodyChat: "biliscript-reading-tabbody-chat",
  // PR4 概览 tab 渲染宿主：reader/overview.ts 按状态机整块重建其内容
  //（idle/generating/ready/partial/error/empty，全诚实态）。
  readingOverviewBody: "biliscript-reading-overview-body",
  // PR3 字幕 tab 五件事：句内搜索、Copy/Export、Follow 悬浮按钮、转写中间态
  // 横幅、选区「解释」浮层与卡片、AI 对话 tab 的待解释意图卡。
  readingSearchInput: "biliscript-reading-search-input",
  readingSearchCount: "biliscript-reading-search-count",
  readingSearchPrevBtn: "biliscript-reading-search-prev",
  readingSearchNextBtn: "biliscript-reading-search-next",
  readingCopySubtitleBtn: "biliscript-reading-copy-subtitle",
  readingExportSubtitleBtn: "biliscript-reading-export-subtitle",
  readingFollowBtn: "biliscript-reading-follow-btn",
  readingTranscribeBanner: "biliscript-reading-transcribe-banner",
  readingTranscribeProgress: "biliscript-reading-transcribe-progress",
  readingExplainPop: "biliscript-reading-explain-pop",
  // 选区「解释」卡片宿主（面板内弹层；状态机与渲染在 reader/explain-card.ts）
  readingExplainCard: "biliscript-reading-explain-card",
  // PR3 占位期的待解释意图卡（PR5 起由对话 tab 组合根渲染/消费）
  readingChatIntent: "biliscript-reading-chat-intent",
  // PR5 AI 对话 tab（readingChat* 前缀，不用 sp 前缀）：对话区全部元素 id。
  // 结构与 sidepanel.html 的 sp* 树一一对应（context chip / 刷新 / 设置 / 新对话、
  // 转写提示行、消息区、模型/思考档/预设/历史、输入卡片），逻辑内核
  // 在 reader/chat-tab.ts（组合根）+ reader/chat-{lists,notices,popovers}.ts
  //（重建壳）+ ../chat/*（内核）。
  readingChatRoot: "biliscript-reading-chat",
  readingChatContextChip: "biliscript-reading-chat-context-chip",
  // 联网搜索开关 pill（spec §4，chat header 工具条，历史按钮同排）
  readingChatWebSearchPill: "biliscript-reading-chat-web-search-pill",
  readingChatHistoryBtn: "biliscript-reading-chat-history-btn",
  readingChatRefreshBtn: "biliscript-reading-chat-refresh-btn",
  readingChatNewBtn: "biliscript-reading-chat-new-btn",
  readingChatOpenSettings: "biliscript-reading-chat-open-settings",
  readingChatAsrNotice: "biliscript-reading-chat-asr-notice",
  readingChatMessages: "biliscript-reading-chat-messages",
  readingChatSuggestions: "biliscript-reading-chat-suggestions",
  readingChatModelSelect: "biliscript-reading-chat-model-select",
  // 模型 + 思考档位面板（发送框底部 chip 弹出）：分组模型列表 + 底部固定
  // 思考档位行与「关不掉」提示行；chip 是隐藏 select 的展示层。
  readingChatModelChip: "biliscript-reading-chat-model-chip",
  readingChatModelPanel: "biliscript-reading-chat-model-panel",
  readingChatModelList: "biliscript-reading-chat-model-list",
  readingChatThinkingToggle: "biliscript-reading-chat-thinking-toggle",
  // 思考档位「关不掉」提示行（工单 03）：档位行之后（面板底部固定区），
  // 默认 hidden，对话组合根（reader/chat-tab.ts）按 resolver 判定显隐。
  readingChatThinkingHint: "biliscript-reading-chat-thinking-hint",
  readingChatPresetBtn: "biliscript-reading-chat-preset-btn",
  readingChatPresetPopover: "biliscript-reading-chat-preset-popover",
  readingChatPresetList: "biliscript-reading-chat-preset-list",
  readingChatPresetInput: "biliscript-reading-chat-preset-input",
  readingChatPresetAddBtn: "biliscript-reading-chat-preset-add-btn",
  readingChatHistoryPopover: "biliscript-reading-chat-history-popover",
  readingChatHistoryList: "biliscript-reading-chat-history-list",
  readingChatHistoryClearBtn: "biliscript-reading-chat-history-clear-btn",
  readingChatInput: "biliscript-reading-chat-input",
  readingChatInputBar: "biliscript-reading-chat-input-bar",
  // 图片附件区（image-input 02 号票）：粘贴图片的缩略图条目 + 单个删除键，
  // 无附件时 hidden（不占位）。
  readingChatImageStrip: "biliscript-reading-chat-image-strip",
  // 发送按钮：空闲为 ↑（空输入禁用），流式中切换为停止键（圆形 + 方块图标）。
  readingChatSendBtn: "biliscript-reading-chat-send-btn"
};
