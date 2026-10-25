// extension/reader/chat-tab.ts — 阅读模式「AI 对话」tab 组合根（PR5）。
//
// sidepanel.ts 的 reader 等价物：工厂组装 + init 时序 + bindEvents + 页面级编排。
// 四个页面级编排函数（syncLiveContextState / ensureCurrentContextForSend /
// restartChat / renderInitialState）**整段迁自 extension/pages/sidepanel.ts**，
// 只换宿主 DOM 引用（readingChat* id）与两处 reader 语境适配（见各自函数头注），
// 分支顺序/时序咬合逐字保持——subtitle-wait 轮询、no-subtitle 拦截、pinned
// 补水、流式守卫在侧栏版被时序咬合得很紧（context-policy.ts :58-61 两个 pinned
// 谓词的疑义记录仍在），按新 UI 心态重写必引入行为漂移（盘点报告风险 4）。
//
// 组装面（与 sidepanel.ts 同构；内核链五件自 arch-review-2026-09/08 起收进
// ../chat/tab-domain.ts 的 createChatTabDomain 单一深入口，本文件 chat 域
// import 面 10→1）：
//   conversation-store（pinned 补水的 context 解析 dep 接复合适配器：会话
//     contextRef 与当前 clip 身份一致 → 进程内快照装配（工单 04 短路，零网络
//     解析）；未命中走 ai/context-resolver 的 bgFetchJson 通道，content script
//     可用）+ context-load（编排壳）+ 装配链（createInProcessContextFetch /
//     createInProcessPinnedContextResolver：AiContext 装配唯一入口，工单 07
//     收口到 core/context-assembly，锚定 context-payload 的形状/签名单源；
//     工单 08 三事已配测试）+ providers +
//     subtitle-wait + no-subtitle + notices/lists/popovers（三壳重建于
//     reader/chat-{notices,lists,popovers}.ts，逻辑照抄）。URL 变化的实时上下文
//     同步调度（原 chat/context-sync.ts 的防抖状态机，工单 05 并回为本地闭包）
//     由 biliscript:urlchange 触发，reader 打开/关闭的恢复折叠进本组合根的激活路径。
//   - offscreen 连接：chrome.offscreen/getContexts 仅扩展上下文可用，content
//     script 经 "ensure-offscreen-chat" 消息委托 background 幂等 ensure，再
//     connect "offscreen-chat" 端口——sidepanel.ts connectPort 的自愈设计照搬。
//   - subtitleWaiter.kick 的触发源：content script 收不到自己的
//     biliscript-subtitle-status 广播（PR3 已核实），改订阅 shared/subtitle-status-bus
//     的进程内相位（asr-transcribing/done/failed），语义与侧栏广播监听一致。
//   - 外点关闭：popovers 的 handleDocumentClick 经 reader-bus 的转发槽并入
//     ui-renderer 的单一文档级委托（风险 6，不双监听）。
//
// 生命周期（懒加载 + 会话收尾，工单 08 决议）：
//   - 二级惰性：本模块经 reader/lazy-chat-tab.ts 动态装载，首次切到对话 tab（或
//     解释卡片「去对话追问」/概览笔记按钮触达 seam）才 init；
//   - 关闭阅读模式即断流（closeReadingView → closeChatSession：resetStreamState
//     断 port、pending 的 subtitle-wait 立即失效、摘会话级触发源）；重开从会话
//     历史恢复（激活路径 loadProvidersAndPrefs → loadContextState → restoreLatest
//     → renderInitialState）；
//     对话 tab 的流式中关闭不做后台续跑（connectPort 的 closed 闸兜底）。
//   - 会话单例 initialized / initInFlight / sessionClosed：init 四路互不依赖的
//     初始化并行起跑；激活/恢复/关闭三入口经 reader/lazy-chat-tab 暴露。会话级
//     触发源（字幕相位总线 / URL 变化 / clip 落定 / 存储变更 / 预热落定 / 外点
//     关闭槽 / Esc）收在 createReaderChatSessionTriggers 的会话对象里，随激活
//     挂载、随收尾摘除；元素级 bindEvents 与窗口 resize 是常驻监听，只在 init
//     接一次。sessionClosed 是模块内 let，读侧仅 connectPort / pollContext 两处
//     闭包（读只发生在回调执行时，晚于赋值方求值）。
//
// 测试注意：els 在模块求值时解析（对话 tab 只在面板壳存在后装载，与 sidepanel
// 的页面加载时序同构）；模块级单例状态（chatSessionState + 本文件闭包）在测试里
// 靠 vi.resetModules 换纪元重置。
//
// els 与文件级闭包状态长期持有壳内节点 ⇒ 本模块要求壳根建成后不重建
//（ui/ui-renderer.ts 的 ensureUiReady：forceRecreate 只用于域叶子装载前的清场；
// 退出阅读形态不摘壳根，再次进入复用同一批节点）。
//
// 曾按 dom / core / lifecycle 浅拆四片（bc1498b），浅拆分并回本单文件。

import { state } from "../core/state.js";
// 当前地址是否 BV 视频页（抓取起跑的前置闸；非视频页对话仍可用，只是不抓字幕）。
import { extractBvid } from "../bilibili/video-id-shared.js";
// 思考档位的显示视图（一级行 · chip 条目 · 提示文案）：一次解析（偏好 + 上下文）的产出，
// 纯函数、无 DOM 依赖。候选 6 起本文件不再自己判定提示文案、也不手工摘解析字段——解析
// 与显示口径的同源关系收在 chat/thinking-picker 的 thinkingViewOf 里。
import { thinkingViewOf } from "../chat/thinking-picker.js";
// 档位入参的声明面（未归一的外部值；词表叶，纯类型引入、无运行时依赖边）。
import type { ThinkingLevelInput } from "../ai/thinking-levels.js";
import { formatClock } from "../shared/clock-text.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { normalizeChatLineHeight, normalizeChatParagraphSpacing } from "../core/validators.js";
import { bindResettableRangeSlider } from "../ui/range-slider.js";
import { applyReadingViewTypography } from "./presentation.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
// 对话域单一深入口（arch-review-2026-09/08）：内核链七件（pinned 补水解析器 +
// conversation-store + context-load（含内联 createInProcessContextFetch 进程内
// 直读装配策略）+ 发送闸 + chat-runtime + 历史回放）在 ../chat/tab-domain.ts
// 组装；chat 域其余出口（状态单例、providers 工厂等）统一经该门面转出——
// 本文件的 chat 域 import 面收敛为一处（10 → 1）。
import {
  OFFSCREEN_CHAT_PORT_NAME,
  applyLiveContextToMain,
  chatSessionState,
  createChatTabDomain,
  createProviderPrefs,
  noteDefaultModelChoice,
  parseModelOptionValue,
  rebuildCurrentContextKeyFromContext,
  type ViewResetIntent
} from "../chat/tab-domain.js";
// pinned 判定单一谓词（context-policy.ts）：全仓统一严格 === true，两处真值读
// 已并入。
import { isPinnedContextStrict } from "../chat/context-policy.js";
import { scheduleModelSelectWidthUpdate, updateModelSelectWidth, type ModelSelectWidthEls } from "../chat/model-select-width.js";
// 初始快捷问题的预热缓存（写方 reader/quick-prompts.ts 由 lifecycle 触发）：
// 缓存落定时若建议区正开着，就地换成生成结果。
import { subscribeQuickPromptsChange } from "../chat/quick-prompt-cache.js";
// reader 触发源与进程内相位（content script 收不到自己的 runtime 广播）。
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
// 转写中判定（与字幕 tab 横幅同源：相位 transcribing 且字幕体为空）。
import { isReaderTranscribing } from "./transcribe-banner.js";
// PR3 契约：待解释意图 peek/consume/clear（消费落在本组合根）。
import {
  peekPendingExplainIntent,
  consumePendingExplainIntent,
  clearPendingExplainIntent
} from "./explain-intent.js";
// 壳三件（重建于 reader 域）+ 模型 chip/面板渲染 + tab 定位 + reader ids。
import { createReaderChatLists } from "./chat-lists.js";
import { createReaderChatFeedback } from "./chat-notices.js";
// 会话级触发源对象（「属会话 vs 常驻」的声明与摘挂闭合处）与建议区属主
//（建议区节点的唯一归属，其余模块只调它的方法）。
import { createReaderChatSessionTriggers } from "./chat-session-triggers.js";
import { createChatSuggestionsSlot } from "./chat-suggestions-slot.js";
import { createReaderChatModelPanel } from "./chat-model-panel.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
// 图片附件区内核（image-input 02 号票）：粘贴 → 压缩 → 缩略图 + 单个删除。
import { createChatInputImages } from "../chat/chat-input-images.js";
// 对话 Composer 深 module（arch-review-batch4/01 号票）：输入区监听、autosize 与发送态
import { createReaderChatComposer } from "./chat-tab-composer.js";
// 对话滚动跟随与回底闸状态机（arch-review-2026-10 候选 8）：合帧 + 近底判据同源 + 回底途中闸与放闸矩阵
import { createScrollFollowController } from "./chat-scroll-follow.js";
// 发图门控（image-input 05 号票）：带图发送受理时按目录乐观放行（提示不阻断）。
import { createImageSupportGate } from "../chat/image-support.js";
// 联网搜索回放重建（spec §4）已随历史回放事务移入 ../chat/replay.ts
//（collectHistorySearchTurns 由其消费）。

// 壳命令通道（arch-review-2026-09/10 依赖反转）：空态「前往设置」改发 reader-bus
// 具名命令，由 ui-renderer 注册的 handler 执行——本文件不再静态 import
// ui/ui-renderer。切对话 tab 的回头调不走壳命令，改经标签激活属主
// ./script-tab-activation（见 runQuickActionPrompt）。
import { requestSubtitleRefresh, requestUiCommand, subscribeReaderPresenter, setChatTabOutsideClickHandler } from "./reader-bus.js";
// 标签激活属主（工单：标签激活收口 reader 域）：快捷动作的「定位对话 tab + 激活」
// 经它执行，不再各写一半（收口前 = set-tab:chat 壳命令 + 显式 ensureChatTabActivated 双写）。
import { activateScriptTab } from "./script-tab-activation.js";
// 发送前主动起跑抓取的装载边（先 ensure 总结链再经 reader-bus 发刷新请求——
// 次序本体在 subtitle/kick-subtitle-fetch）。本模块是动态 chunk，静态 import
// 本叶子不拖常驻图。
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { logWarn } from "../shared/logging.js";
// 对话分区表模块顶兜底挂载（arch-slim-4/07，settings-panel.ts 顶挂载同款先例）：
// 主点在 ui-renderer setReaderScriptTab 的 chat 分支（盖住现役三入口），此处盖
// 住未来新入口——本模块被动态装载即样式在场；ensure 内部 mounted Map 去重。
import { ensureReaderChatStyles } from "../shared/style-injector.js";
import { ids } from "./state.js";
// 时间戳跳转的进程内 seek（reader 域唯一定位入口，见 getTimestampNavDeps）。
import { seekReadingTarget } from "./sync.js";

ensureReaderChatStyles();

const NON_VIDEO_CONTEXT_MESSAGE = "当前不是视频播放页，<br>无法获取视频信息，<br>仅支持常规对话。";

const els = {
  root: document.getElementById(ids.readingChatRoot) as HTMLElement,
  modelSelect: document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement,
  modelChip: document.getElementById(ids.readingChatModelChip) as HTMLButtonElement,
  modelPanel: document.getElementById(ids.readingChatModelPanel) as HTMLElement,
  modelPanelList: document.getElementById(ids.readingChatModelList) as HTMLElement,
  thinkingToggle: document.getElementById(ids.readingChatThinkingToggle) as HTMLElement,
  // 思考强度内联选择区：底部固定区容器与它的当前值 span。
  thinkingRow: document.getElementById(ids.readingChatThinkingRow) as HTMLElement,
  thinkingRowValue: document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement,
  // 联网搜索开关 pill（spec §4，输入行 + 右侧）
  webSearchPill: document.getElementById(ids.readingChatWebSearchPill) as HTMLElement | null,
  newChatBtn: document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement,
  historyBtn: document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement,
  moreBtn: document.getElementById(ids.readingChatMoreBtn) as HTMLButtonElement | null,
  moreMenu: document.getElementById(ids.readingChatMoreMenu) as HTMLElement | null,
  lineHeightSlider: document.getElementById(ids.readingChatLineHeight) as HTMLInputElement | null,
  lineHeightValue: document.getElementById(ids.readingChatLineHeightValue) as HTMLElement | null,
  lineHeightResetBtn: document.getElementById(ids.readingChatLineHeightResetBtn) as HTMLButtonElement | null,
  paraSpacingSlider: document.getElementById(ids.readingChatParagraphSpacing) as HTMLInputElement | null,
  paraSpacingValue: document.getElementById(ids.readingChatParagraphSpacingValue) as HTMLElement | null,
  paraSpacingResetBtn: document.getElementById(ids.readingChatParagraphSpacingResetBtn) as HTMLButtonElement | null,
  historyPopover: document.getElementById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: document.getElementById(ids.readingChatHistoryClearBtn) as HTMLButtonElement | null,
  // 历史整页头部的返回键（历史入口本身在对话工具条里，整页一开就被盖住，退出靠本键）
  historyBackBtn: document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement | null,
  messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
  // 滚底按钮（DeepSeek Harness 同款）：挂在 footer 内、浮在输入卡上方，模板默认
  // hidden；显隐与自动滚动共用同一条近底判据（见 chat-scroll-follow）。
  scrollBottomBtn: document.getElementById(ids.readingChatScrollBottomBtn) as HTMLButtonElement,
  input: document.getElementById(ids.readingChatInput) as HTMLTextAreaElement,
  // 图片附件区（image-input 02 号票，模板默认 hidden）
  imageStrip: document.getElementById(ids.readingChatImageStrip) as HTMLElement | null,
  sendBtn: document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement,
  asrNotice: document.getElementById(ids.readingChatAsrNotice) as HTMLElement | null,
  intentCard: document.getElementById(ids.readingChatIntent) as HTMLElement | null
};

function requireShell(): void {
  if (!els.root || !els.messages || !els.input) {
    throw new Error("AI 对话 tab 壳未就绪（readingChat* DOM 缺失）");
  }
}


// 无字幕视频做音频转写时，转写编排经进程内相位镜像广播阶段；本条状态行据此
// 在转写期间显示一行转写提示，替代仅有「无字幕」却不说在做什么的状态。只在
// 转写阶段展示，其余阶段（含转写结束后未再发布的情况）由 phase 判断隐藏。
// asr-done/asr-failed：一键总结若正在等待转写
//（subtitleWaiter.wait），立即触发一轮上下文轮询，不必等 4 秒间隔。
// （sidepanel 版监听 chrome.runtime.onMessage 的 biliscript-subtitle-status 广播；
// 转写相位订阅、等待提示路由、asrNotice 状态行维护已随发送闸整段迁入
// ../chat/send-gate.ts（GLOSSARY.md 词条「发送闸」），本文件经 sendGate 实例
// 持有 bindStatusBus/unbindStatusBus/kickSubtitleWait/refreshAsrNotice 四件。

// reader 触发源两处（共用一个 120ms 防抖槽，后到者定档；两者的挂载点见下方会话
// 触发源组装）：
//   ① biliscript:urlchange（core/url-watcher 广播）→ 强刷快档（切 P/切视频必须
//      全网络重拉）；
//   ② reader-bus 的 subtitle-ready（clip 身份与字幕体原子落定时发）→ 弱档对账
//      + 保输入。
// 调度状态机原在 chat/context-sync.ts 的 createLiveContextSync（工单 05 并回）：
// ~40 行纯间接层里 reader 只消费 onUrlChange 一个触发源（sidepanel 世界的
// visibility/focus/tabs handler 无调用方，onReaderOpened/Closed 的恢复折叠进激活
// 路径 restoreChatSession），单宿主现实下保留其防抖语义即可——120ms 快档，重复
// 触发即防抖重置（触发源恒为强刷，原「弱刷不覆盖强刷」的合并分支无单宿主场景）。
let urlChangeSyncTimer = 0;

// 参数：forceRefresh 缺省强刷（URL 变化 = 明确要求全网络重拉）；preserveInput 缺省
// false（换片是用户动作，清场是既有语义）。字幕落定的对账走弱档 + 保输入（见会话
// 触发源组装处 clipSettle 的取舍说明）。
function scheduleLiveContextSync({ forceRefresh = true, preserveInput = false }: { forceRefresh?: boolean; preserveInput?: boolean } = {}): void {
  if (sessionClosed) {
    return;
  }
  if (urlChangeSyncTimer) {
    window.clearTimeout(urlChangeSyncTimer);
  }
  urlChangeSyncTimer = window.setTimeout(() => {
    urlChangeSyncTimer = 0;
    if (sessionClosed) {
      return;
    }
    void syncLiveContextState(forceRefresh, preserveInput);
  }, 120);
}

// 跨模块共享状态（contextData / currentContextKey / providers / chatHistory /
// savedConversations / currentConversationId / currentConversationMeta /
// liveContextData / liveContextKey / liveTabUrl / aiPrefs / asrTranscribingActive /
// aiThinkingLevel）收拢在 ../chat/chat-state.ts 的 chatSessionState，本文件与各
// 子模块直接 import 读写。以下为纯局部单例。
let initialized = false;
let initInFlight: Promise<void> | null = null;
// 会话收尾标志（closeChatSession 置位、激活路径复位）：闸住关闭后仍会兑现的
// 发送流程（subtitle-wait 等待中的 pollContext 与 connectPort），落实「关闭即
// 断流、不做后台续跑」。
let sessionClosed = false;

// 建议区属主（reader/chat-suggestions-slot）：建议区节点的建立 / 写入 / 摘除只在
// 它手里——本文件的消息区清场路径经 render 重建它，通知模块经 clear 撤除它，
// 列表模块经 render 填内容、经 isPresent 决定要不要对账。
const suggestionsSlot = createChatSuggestionsSlot({
  messages: els.messages,
  id: ids.readingChatSuggestions,
  // chip 点击 = 发送芯（填输入框 → 重测高度 → 发送闸受理），与快捷动作同一尾部。
  onPick: (prompt) => {
    void composer.sendViaInputBox(prompt);
  }
});

// 消息区反馈（通知条/居中错误/建议区撤除/近底判定）：contextNoticeTimer 是
// notices 模块闭包私有状态；定时器用 window（测试可注入 fake）。
const feedback = createReaderChatFeedback({
  messages: els.messages,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatRuntime.scrollToBottom(),
  suggestions: suggestionsSlot,
  // script-only-ui：提示条「前往设置」打开侧边栏设置抽屉（open-options 已删；
  // 经 reader-bus open-settings 命令由壳执行，arch-review-2026-09/10）
  onOpenSettings: () => requestUiCommand("open-settings")
});
const {
  showConversationContextNotice,
  removeConversationContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom,
  getMessagesBottomOffset
} = feedback;

// 图片附件区（image-input 02 号票）：粘贴 → 压缩（03 号票规格）→ 缩略图 + 单个
// 删除；拒绝提示走消息区通知条（与上下文提示同一出口，自动隐藏）。流式闸问
// 回合生命周期的一条判据（isTurnActive：受理窗口 ∪ 流段）——发送流程从受理到
// 落定的整段窗口里都不收新图。消费点两处：chat-runtime 发送受理
//（deps.takeInputImages）与 restartChat 清场。
const inputImages = createChatInputImages({
  strip: els.imageStrip,
  isStreaming: () => chatRuntime.isTurnActive(),
  onReject: (message) => showConversationContextNotice(message, 4000)
});

// 对话输入与发送区深 module（arch-review-batch4/01 号票）：收敛输入框常驻监听、
// autosize（高度只随内容走，封顶 320）、发送态同步与发送芯闭包。
const composer = createReaderChatComposer({
  els: {
    input: els.input,
    sendBtn: els.sendBtn
  },
  chatRuntime: {
    sendTurn: (text) => chatRuntime.sendTurn(text),
    isTurnActive: () => chatRuntime.isTurnActive(),
    stopActiveStream: () => chatRuntime.stopActiveStream()
  },
  onPasteImage: (e) => inputImages.handlePaste(e)
});

// 发图门控（image-input 05 号票）：带图消息被发送受理时查一次模型目录，目录明确
// 登记不收图才提示（乐观放行，不阻断发送）；目录查不到静默放过，交给平台 400 兜底。
// 提示走消息区通知条（与附件区拒绝提示同一出口）。目录模块只经动态 import 装载，
// 不进 content 静态图。
const imageSupportGate = createImageSupportGate({
  getSelectedModelValue: () => els.modelSelect.value,
  notify: (message) => showConversationContextNotice(message, 4000)
});

// 对话域内核链单一深入口（arch-review-2026-09/08）：pinned 补水解析器 +
// conversation-store + context-load（含内联 createInProcessContextFetch）+
// chat-runtime 在 ../chat/tab-domain.ts 组装——实例级硬边顺序 pinnedResolver →
// store → contextLoad → runtime 在组装模块内保持，其余 30+ 处跨实例互引保持
// 惰性箭头（回调执行时实例已存在）。本侧只注入 deps：壳 DOM 三件 + ui 门面
//（ChatRuntimeUi 8 件回调）+ store 能力事件订阅 + contextLoad 渲染编排回调 +
// storage + 状态 getter + runtime 传输/AI 回调（闭包连着本文件的页面级编排、
// 触发源状态与 DOM）。
// 会话状态（会话列表/当前会话/上下文）已收拢至 chatSessionState，store 直接
// import 读写。能力事件三件（工单 05 渲染编排反转：store 自己编排渲染时机，
// 本组合根只订阅结果）：
//   - onConversationChanged：历史列表恒随事件重渲，change 标志（historyCleared /
//     resetView）声明其余需要刷新的呈现面；
//   - onStreamInterrupted：流式中删除当前会话 / 清空全部 / restoreLatest 无匹配
//     时由 store 同步发出——断 port、清在途一问一答、清消息区并退出流式 UI 态
//    （对应 restartChat 的清理动作，但不清会话状态——那由 store 自己做）。
//     store 不直接 import chatRuntime，依赖方向由 tab-domain 组装；回调幂等
//    （非流式时为无害空操作）。
//   - onContextNotice：上下文补水提示生命周期（pending 展示 / clear 撤除 /
//     error 展示）。
const { runtime: chatRuntime, store: conversationStore, contextLoad, sendGate, replay: conversationReplay } = createChatTabDomain({
  messages: els.messages,
  input: els.input,
  // 历史回放事务的编排回调：updateChatLayoutState 进 replay 首行（输入框重测），
  // 建议区两件见下方 suggestions（replay 只在重建消息区时清引用）。
  updateChatLayoutState,
  // 建议区（属主 = suggestionsSlot）：域内只表达「对账重渲」与「清引用」两个意图，
  // 节点与会话状态都不出台。
  suggestions: {
    render: () => lists.renderSuggestions(),
    clear: () => suggestionsSlot.clear()
  },
  ui: {
    setStreamingUiState: composer.setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice,
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    requestViewReset,
    autosizeInput: composer.autosizeInput
  },
  onConversationChanged: (change) => {
    lists.renderHistoryList();
    if (change.historyCleared) {
      popovers.hideHistoryPopover();
    }
    if (change.resetView) {
      renderInitialState();
    }
  },
  onStreamInterrupted: () => {
    chatRuntime.resetStreamState();
    resetConversationView();
    composer.setStreamingUiState(false);
  },
  onContextNotice: (notice) => {
    if (notice.kind === "pending") {
      showConversationContextNotice(notice.message);
    } else if (notice.kind === "clear") {
      removeConversationContextNotice();
    } else {
      showConversationContextError(notice.message);
    }
  },
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState,
  restartChat,
  requestViewReset,
  storage: chrome.storage.local,
  clip: () => state.clip,
  settings: () => state.settings,
  // 发送闸编排六件（send-gate 消费，见 tab-domain 头注）：会话关闭闸读组合根
  // 模块级 sessionClosed；转写相位判定与字幕 tab 横幅同源；状态行/页 BV 取
  // 壳元素与当前地址；主动起跑 = 确保总结链装载 + reader 刷新请求（读
  // state.clip 的判定已随闸迁移，此处只剩起跑动作本体）。
  isSessionClosed: () => sessionClosed,
  isReaderTranscribing,
  asrNotice: els.asrNotice,
  pageBvid: () => extractBvid(location.href),
  startSubtitleFetch,
  subscribeStatusPhase: subscribeSubtitleStatusPhase,
  // 等待闸开关信号：等待期间发送键禁用 + placeholder 换等待文案（见
  // setSubtitleWaitUi）。
  onWaitingChange: (waiting) => composer.setSubtitleWaitUi(waiting),
  getProviderId: () => parseModelOptionValue(els.modelSelect.value).providerId,
  // 选中模型 id（multi-model-catalog）：随 chat 消息下发，offscreen 覆盖平台
  // 目录首项；复合值编码见 chat/providers.ts 的 MODEL_OPTION_SEPARATOR。
  getSelectedModel: () => parseModelOptionValue(els.modelSelect.value).model,
  // 图片附件（image-input 02 号票）：发送受理时消费附件区（读取并清空），随本条
  // chat 消息的 images 字段下发。发图门控（05 号票）挂在这一步：受理点才是「图在
  // 手 + 模型已定」的唯一时刻（被前置闸拦下的发送不会提示）。
  takeInputImages: () => {
    const images = inputImages.takeImages();
    imageSupportGate.check(images);
    return images;
  },
  getTimestampNavDeps,
  normalizeMarkdownForSectionPaste,
  // 发送前 ensure offscreen 文档再连端口：文档死亡后自愈重建（ensure 失败
  // 不阻断 connect，维持历史行为，由连接结果兜底）。chrome.offscreen 仅扩展
  // 上下文可用：content script 经 "ensure-offscreen-chat" 消息委托 background
  // 幂等 ensure（sidepanel 直调同款自愈设计的 reader 通道）。关闭会话后不再
  // 发起流（工单 08：关闭即断流，不做后台续跑）。
  connectPort: async () => {
    if (sessionClosed) {
      throw new Error("阅读模式已关闭，对话已中止。");
    }
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    return chrome.runtime.connect({ name: OFFSCREEN_CHAT_PORT_NAME });
  }
});

const { loadContextState } = contextLoad;

// 历史项点击的切换接缝（C′：先体面停流落盘、再切换）：在途回合（受理窗口 ∪
// 流段，chatRuntime.isTurnActive 一条判据）时先 await chatRuntime.settleTurn()——
// 它发停流并在 stopped/done/error 终态落定后兑现，而终态路径内的
// commitAssistantTurn 会把在途一问一答（含 partial 正文）写回**原**会话并落盘；
// 落定后才 applyById 切换。不进 conversation-store（store 不碰 runtime 的分层
// 不动），也不动 replay（回放仍不感知在途流——等待保持单向，见 ./replay.ts 头注）。
// 不在途时零延迟零行为差：这里不留 await，applyById 在同一 tick 内完成
//（characterization 钉在 tests/reader/chat-tab.test.ts）。
async function openConversationById(id: string): Promise<void> {
  if (chatRuntime.isTurnActive()) {
    await chatRuntime.settleTurn();
  }
  conversationStore.applyById(id);
}

// 两列表渲染（建议/历史）。hideHistoryPopover 与本实例/popovers 实例互引，惰性
// 箭头接线（回调执行时实例已存在）；建议区内容经属主写入（lists 只提交问题清单）。
const lists = createReaderChatLists({
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  applyById: (id) => {
    void openConversationById(id);
  },
  deleteById: (id) => conversationStore.deleteById(id),
  suggestions: suggestionsSlot,
  hideHistoryPopover: () => popovers.hideHistoryPopover()
});

// 历史/模型面板两个弹层的开合与互斥；文档级外点关闭经 reader-bus 的转发槽并入
// ui-renderer 的单一 document click 委托（会话触发源组装处随激活注册 / 随收尾
// 摘除）；Esc 关闭走组合根的 window keydown 监听（同一时机挂载）。
const popovers = createReaderChatPopovers({
  historyPopover: els.historyPopover,
  modelPanel: els.modelPanel,
  historyBtn: els.historyBtn,
  modelChipBtn: els.modelChip,
  moreBtn: els.moreBtn,
  moreMenu: els.moreMenu,
  renderHistoryList: () => lists.renderHistoryList(),
  renderModelPanel: () => modelPanel.renderPanel()
});

// 模型 chip + 面板的渲染（chip 是隐藏 select 的展示层）；hidePanel 惰性互引
// popovers 实例（回调执行时实例已存在）。
const modelPanel = createReaderChatModelPanel({
  modelSelect: els.modelSelect,
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement,
  panelList: els.modelPanelList,
  panel: els.modelPanel,
  thinkingToggle: els.thinkingToggle,
  thinkingRow: els.thinkingRow,
  thinkingRowValue: els.thinkingRowValue,
  // 思考档位「关不掉」提示行（工单 03，模板默认 hidden）：随本次深化移入面板注入面——
  // 本文件不再持有该元素、不写它的显隐/文案，也不知道「先画档位再画提示」这种调用顺序
  // （面板 renderThinkingPicker 收整份视图值一次画完）。
  thinkingHint: document.getElementById(ids.readingChatThinkingHint) as HTMLElement | null,
  hidePanel: () => popovers.hideModelPanel(),
  // 档位条目的落盘出口（惰性互引 pickThinkingLevel，见下）。
  pickLevel: (level) => pickThinkingLevel(level)
});

// 滚动跟随与回底闸状态机（chat-scroll-follow）：按帧合批 + 双阈值迟滞 + 物理手势即时断跟
// + smooth 动画回底途中闸与放闸矩阵。
const scrollFollow = createScrollFollowController({
  messages: els.messages,
  scrollBottomBtn: els.scrollBottomBtn,
  getBottomOffset: getMessagesBottomOffset,
  isNearBottom: isMessagesNearBottom,
  setAutoScroll: (autoScroll) => chatRuntime.setAutoScroll(autoScroll),
  scrollToBottom: (smooth) => chatRuntime.scrollToBottom(smooth)
});

// 宽度度量专用 els 引用包（model-select-width 的契约键名 chip/chipModel/chipLevel；
// 模块级 els 用 readingChat* 语义键名，二者在此显式对齐）。
const widthEls: ModelSelectWidthEls = {
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement
};

// 上下文状态加载编排壳（../chat/context-load.ts）与 chat 流状态机
//（../chat/chat-runtime.ts）均已收进上面的 createChatTabDomain 组装；本文件
// 经解构消费 contextLoad（loadContextState，见上）与
// chatRuntime 实例方法。
// AI 平台加载渲染 + 思考档位（widthEls 见上：度量对象是 chip/chipModel/chipLevel
// 引用包；providers 内部的 updateModelSelectWidth 调用随 select 渲染刷新 chip
// 宽度）。思考档位区的判定在本文件（refreshThinkingUi：偏好 + 上下文 → 视图值），
// DOM 全在面板（含提示行），baseUrl 识别入参由 providers 模块自 ai-providers-list
// 载荷透传。
const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  widthEls,
  webSearchPill: els.webSearchPill
});
const { loadProvidersAndPrefs, setThinkingLevel, setWebSearchEnabled } = providerPrefs;

// ============================================================
// 思考档位区刷新（解析 → 整份视图值交给面板）
// ============================================================

// 档位区刷新（06 号票：一次解析同时决定「哪些档位存在」与「提示文案」；候选 6 起这次
// 解析直接产出视图值）。本函数只做「解析入参装配 → 交给面板」——思考强度标题行、滑块/重置键、
// chip 的档位 span 与底部提示行都由面板从这**一份**视图值画出来，本文件不碰这些 DOM，也不再
// 承担 chip 与面板的重渲顺序（面板 renderThinkingPicker 内部一次画完）。
// 刷新点三处：模型选择 change、档位切换、平台列表重载（init 与
// loadProvidersAndPrefs 之后）——模型/档位一变即重判。
function refreshThinkingUi(): void {
  // 识别入参：baseUrl / presetId 沿 loadProvidersAndPrefs 已拉的
  // ai-providers-list 载荷（providers.ts 已透传进 chatSessionState.providers，
  // 不开新消息链）；模型名取选中项的模型 id（multi-model-catalog：选项值是
  // 「平台 id\u0001模型 id」复合值，解析后取模型段，平台记录仅作回落）。
  // stream 传 true：对话请求是流式，streamOnly 关闭规则（如 qwen3-235b 的
  // enable_thinking:false）在对话里正常可用，不误报提示。
  const selected = parseModelOptionValue(els.modelSelect.value);
  const provider = chatSessionState.providers.find((item) => item.id === selected.providerId);
  // 偏好 + 上下文 → 视图值（档位集合 = 只显示存在的档位、不置灰；思考强度行/chip 的显示名 =
  // 口径 ③ 的实发档；底部提示行 = 口径①②的文案）。解析只发生这一次，显示口径与请求落线
  // 同源——本文件不再自己判文案，也不手工摘解析字段。
  const view = thinkingViewOf({
    presetId: String(provider?.presetId || ""),
    baseUrl: String(provider?.baseUrl || ""),
    model: selected.model || String(provider?.model || ""),
    level: chatSessionState.aiThinkingLevel,
    stream: true
  });
  // 整份视图值交给面板（唯一画侧入口）：开关型模型在这里被收成 Off/On 两项、chip 与思考强度行
  // 同步显示 On；偏好 ≠ 实发档时显示**实发档**（关不掉 → {high,max} 显示 High；档位型
  // clamp → 偏好 high 而 A' = {low,medium} 显示 Medium），不再显示线上没发的东西；
  // 提示行（工单 03 / 05 号票）也随这次解析一起落 DOM。
  modelPanel.renderThinkingPicker(view);
}

// 档位落盘出口（面板档位滑块 / ↻ 重置键 / 单档胶囊经 deps.pickLevel 回到这里）：setThinkingLevel
// 首行同步写 chatSessionState.aiThinkingLevel，紧随的重判读到的是新档位（档位切走
// 即收提示，切回 Off 再现）；chip 的档位文案、滑块选中态与提示行都随重判重渲。
// **一次切换只渲一遍**：本函数不再先调 renderChip（那是 refreshThinkingUi →
// renderThinkingPicker 内部的事），chip 的渲染路径收敛为 refreshThinkingUi 一条。
// 调整思考档位不关面板（点选上方模型项才关面板）。
// 入参与 providers 的 setThinkingLevel 同域：**未归一的外部值**（面板传的是 dataset
// 里的档位词，宽容面见 ai/thinking-levels.ts 的 ThinkingLevelInput）——本函数只转交，
// 归一化在落盘入口做一次。
function pickThinkingLevel(level: ThinkingLevelInput): void {
  void setThinkingLevel(level);
  refreshThinkingUi();
}

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程——等待闸状态机与提示路由已随发送闸迁入
// ../chat/send-gate.ts，本文件不直接持有 subtitleWaiter。

// ============================================================
// 激活 / 会话收尾（对外入口，经 reader/lazy-chat-tab 暴露）
// ============================================================

// 会话级触发源对象：下面七项是「属会话」的触发源（随激活挂载、随会话收尾摘除，
// 摘挂闭合在 reader/chat-session-triggers.ts，重复激活幂等）；常驻监听（元素级
// bindEvents 与窗口 resize）只在 init 接一次，不在这一组里。
const sessionTriggers = createReaderChatSessionTriggers({
  // 字幕相位总线（sendGate 的绑/摘一对）：转写相位订阅、等待提示路由与 asrNotice
  // 状态行维护都在发送闸里，本文件只持有这一对。
  statusBus: () => {
    sendGate.bindStatusBus();
    return () => sendGate.unbindStatusBus();
  },
  // ① URL 变化 → 强刷快档（见上方 scheduleLiveContextSync 的 120ms 防抖槽）。
  urlChange: () => {
    const handler = () => scheduleLiveContextSync();
    window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, handler);
    return () => window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, handler);
  },
  // ② clip 落定 → 主动补一次上下文对账。
  //
  // 为什么需要：换片瞬间 URL 变化同步可能早于 clip 重置（重置链在动态加载之后），
  // 那次装配按「clip 不属于当前页即未就绪空快照」收口（core/context-assembly 的
  // 页身份校验）——此后没有第二个触发源，对话上下文就一直停在空档，标题与上下文键
  // 都不归位，直到用户发送或再次换片。subtitle-ready 正是「视频身份 + 字幕体原子
  // 落定」的信号（subtitle/commit 的 acceptSubtitle / commitNoSubtitle 两个出口都
  // 发，无字幕收尾同样算落定），收到即补一轮。
  //
  // 档位取舍：弱档 forceRefresh:false——签名里含字幕体长度与 subtitleFetchState，
  // 真落定必然签名变化走全量，重复通知/无变化则短路零开销（强刷档每轮都会重拉热评）。
  // 保输入 preserveInput:true——这次对账是「跟着 clip 走」，不是用户语义上的新会话，
  // 而转写等待期间用户很可能已经在输入框里打好了草稿，不该被后台对账清掉。
  clipSettle: () => subscribeReaderPresenter((event) => {
    if (event.kind === "subtitle-ready") {
      scheduleLiveContextSync({ forceRefresh: false, preserveInput: true });
    }
  }),
  // 外部设置变更 → 刷新平台/偏好（与 sidepanel bindEvents 的 storage.onChanged
  // 监听同语义；player-ai 信箱键的监听属摘除任务，不在 reader 消费）。
  // 区/键过滤经 shared/watch-storage-keys seam（R3 收口）：sync 区五键 + local 区
  // aiProviderKeys，摘除即 unsubscribe。
  storageWatcher: () => watchStorageKeys(() => {
    void refreshProvidersAndPrefsAfterExternalChange();
  }, {
    sync: [
      "aiProviders",
      "aiSystemPrompt",
      "aiInitialQuickPrompts",
      "defaultModel",
      "aiThinkingLevel"
    ],
    local: ["aiProviderKeys"]
  }),
  // 预热落定 → 重渲建议区：字幕就绪后后台生成的问题到位时，建议区若正显示兜底
  // 三条（用户手速快，刚进对话 tab 就撞上预热还在飞），就地换成逐视频生成的结果。
  // 有会话历史时 renderSuggestions 自身会走空表分支，这里不必另判。
  quickPrompts: () => subscribeQuickPromptsChange(() => {
    if (!initialized || chatRuntime.isStreaming()) {
      return;
    }
    lists.renderSuggestions();
  }),
  // 外点关闭单委托：注册进 ui-renderer 的文档级 click 委托（reader-bus 转发槽），
  // 同一时刻至多一个注册者，摘除即置回 null。
  outsideClick: () => {
    setChatTabOutsideClickHandler(popovers.handleDocumentClick);
    return () => setChatTabOutsideClickHandler(null);
  },
  // Esc 关闭三个弹层（window 级监听，与文档级 click 委托不同事件，不互踩）。
  escapeKey: () => {
    window.addEventListener("keydown", onWindowEscapeKey);
    return () => window.removeEventListener("keydown", onWindowEscapeKey);
  }
});

function onWindowEscapeKey(event: KeyboardEvent): void {
  popovers.handleEscapeKey(event);
}

async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  requireShell();
  bindEvents();
  sessionTriggers.activate();
  // 四路互不依赖的初始化并行起跑（opt-backlog-2026-09/05）——原先 offscreen
  // 确保 → 平台列表 → 会话存档 → 上下文装配四连串行 await，总等待为各路之和
  // （会话存档还曾随 loadAll 对至多 12 条历史会话各发一次串行视频元数据请求，
  // 现已收敛到 restoreLatest 命中项单条）；并行后总等待 = 最慢一路。offscreen
  // 失败不阻断 init（catch 吞掉，与每次发送前的 ensure 复用同一自愈路径）。
  await Promise.all([
    sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null),
    loadProvidersAndPrefs().then(() => {
      // 平台列表/档位落定后：首判档位区（「关不掉」提示 + 档位条目 + 模型 chip 首渲，
      // renderModelSelect 已把选中项写进 select）——此后由模型切换/档位点击/外部刷新续判。
      // chip 首渲不再单独调用（refreshThinkingUi 经面板内部画它），一次刷新只渲一遍。
      refreshThinkingUi();
    }),
    conversationStore.loadAll(),
    loadContextState()
  ]);
  // 会话恢复依赖存档（loadAll）与上下文（loadContextState）双双落定。
  await conversationStore.restoreLatest();
  renderInitialState();
  composer.autosizeInput();
  initialized = true;
  // PR3 契约消费：有待解释意图 → 渲染引用卡 + 自动发送（发送成功即 consume）。
  // 快捷动作路径传 consumeIntent:false 跳过（与快捷发送互不踩踏）。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

// 重开/重进的恢复路径（工单 08：重开从会话历史恢复）：重取平台/偏好（会话关闭
// 期间存储变更 watcher 已随触发源摘下，设置抽屉里的新增平台只能在此补读）→
// 静默重取上下文（签名短路便宜）→ 恢复匹配当前上下文的最近会话 → 按会话历史
// 重渲消息区（顺带清掉关闭时残留的流式半截节点）。
async function restoreChatSession(): Promise<void> {
  // 与 init / 外部变更刷新同口径一件：平台列表落定后重判档位区（chip + 档位条目 + 提示行
  // 都由这一次重判画出来，不再另调 renderChip）。
  await loadProvidersAndPrefs().catch(() => null);
  refreshThinkingUi();
  const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok) {
    return;
  }
  await conversationStore.restoreLatest();
  renderInitialState();
  composer.autosizeInput();
}

export async function ensureChatTabActivated({ consumeIntent = true }: { consumeIntent?: boolean } = {}): Promise<void> {
  if (!initialized) {
    if (!initInFlight) {
      initInFlight = initChatTab({ consumeIntent }).finally(() => {
        initInFlight = null;
      });
    }
    await initInFlight;
    return;
  }
  if (sessionClosed) {
    sessionClosed = false;
    sessionTriggers.activate();
    await restoreChatSession();
  }
  // 已初始化的普通激活（tab 切回）：消费可能新写入的待解释意图（解释卡片
  // 「去对话追问」在对话 tab 已装载时点击 / 上次挂起的意图重试）。无意图时为无害 no-op。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

export function closeChatSession(): void {
  if (urlChangeSyncTimer) {
    window.clearTimeout(urlChangeSyncTimer);
    urlChangeSyncTimer = 0;
  }
  if (!initialized) {
    return;
  }
  sessionClosed = true;
  // 断流收口（chat-runtime 断连路径已兜底 UI 态）：断 port、清在途一问一答与
  // 慢响应计时器；未流式时为无害空操作。
  chatRuntime.resetStreamState();
  composer.setStreamingUiState(false);
  scrollFollow.reset();
  // 挂起中的 subtitle-wait 立即失效（pollContext 的 closed 闸 → wait 兑现
  // false → 发送流程提前返回并清等待提示）。
  sendGate.kickSubtitleWait();
  // 等待态收口：kick 只在其后无在途轮询时才立刻兑现（tick 的去重闸会吞掉这次
  // kick），那条「等待结束 → false」的推送因此可能滞后一轮轮询才到；本行保证
  // 会话关闭即不残留等待态，重开时发送键不会带着「正在抓取字幕…」禁用下去。
  composer.setSubtitleWaitUi(false);
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  removeConversationContextNotice();
  sendGate.refreshAsrNotice();
  // 会话收尾（意图已被 lifecycle.clearPendingExplainIntent 清掉）：引用卡随之
  // 隐藏，下次激活按无意图渲染。
  hideExplainIntentCard();
  sessionTriggers.deactivate();
}

// ============================================================
// player-ai 快捷动作消费 seam（工单 08 决议：阅读模式内点击 = 定位/聚焦对话
// tab + 自动发送快捷提示词；PR4b 概览「生成完整笔记」按钮同 seam 直发）
// ============================================================

export async function runQuickActionPrompt(prompt: string): Promise<boolean> {
  // 定位/聚焦对话 tab（不触达字幕 tab 的滚动状态）：切 tab + 写状态位/持久化 +
  // 对话组合根激活统一由标签激活属主执行（reader/script-tab-activation），
  // consumeIntent:false 透传——与快捷发送互不踩踏，不消费待解释意图。属主的
  // promise 在其激活（含装载/恢复）落定后才 resolve，本函数后续的发送流程因此
  // 天然等到装载落定，无需再单独 await ensureChatTabActivated（收口前的
  // fire-and-forget 壳命令 + 显式补 await 的双写已退役）。
  await activateScriptTab("chat", { consumeIntent: false });
  const text = String(prompt || "").trim();
  if (!text) {
    composer.autosizeInput();
    els.input?.focus?.();
    return false;
  }
  await startNewConversation();
  return composer.sendViaInputBox(text);
}

// ============================================================
// PR3 契约消费：待解释意图 → 引用卡（时间戳 pill 母题）+ 自动发送
// ============================================================

// 解释提示词模板：引用句 + 时间戳 pill 文案，发送出去的消息自带引用上下文。
// 两种口径：卡片「去对话追问」带选中片段 → 解释这个词句；整句意图（无
// selection）→ 解释这句字幕。
function buildExplainPrompt(intent: { from: number; content: string; selection?: string }): string {
  const stamp = formatClock(intent.from, { hours: "auto" });
  if (intent.selection) {
    return `请结合视频上下文解释我选中的词句：「${intent.selection}」。它出自字幕句「${intent.content}」（${stamp}）。说明它的含义、背景，以及在这句话里指什么。`;
  }
  return `请结合视频上下文解释这句字幕：「${intent.content}」（${stamp}）。说明它的含义、背景，以及与前后文的关系。`;
}

function renderExplainIntentCard(intent: { from: number; content: string; selection?: string }): void {
  if (!els.intentCard) {
    return;
  }
  const quote = els.intentCard.querySelector<HTMLElement>(".biliscript-reading-chat-intent-quote");
  if (quote) {
    quote.textContent = intent.selection ? `「${intent.selection}」｜${intent.content}` : `「${intent.content}」`;
  }
  const stamp = els.intentCard.querySelector<HTMLElement>(".biliscript-reading-chat-intent-time");
  if (stamp) {
    stamp.textContent = formatClock(intent.from, { hours: "auto" });
  }
  els.intentCard.hidden = false;
}

function hideExplainIntentCard(): void {
  if (els.intentCard) {
    els.intentCard.hidden = true;
  }
}

// peek 意图 → 渲染引用卡 → 自动发送解释提示词；发送成功（受理结论 accepted）才
// consumePendingExplainIntent——一次意图只发一次。发送被 subtitle-wait 挂起时
// sendTurn 的 promise 不提前兑现（等待在其内部 await），意图保持 pending；回合
// 已在途（受理窗口 / 流段）时 autoSendPrompt 直接返回 false（不消费，留在 pending，
// 下一次激活补发）——直到真正发出或用户取消（引用卡上的取消按钮）。
async function consumeExplainIntentIfPending(): Promise<void> {
  const intent = peekPendingExplainIntent();
  if (!intent || !intent.content) {
    hideExplainIntentCard();
    return;
  }
  renderExplainIntentCard(intent);
  const sent = await composer.autoSendPrompt(buildExplainPrompt(intent));
  if (sent) {
    consumePendingExplainIntent();
    hideExplainIntentCard();
  }
}

// ============================================================
// bindEvents（元素级绑定，常驻）；会话级触发源见 sessionTriggers 的组装
// ============================================================

function bindEvents(): void {
  // 输入区常驻监听（keydown/paste/input/focus/blur 与发送钮点击）收敛进 composer 深 module
  composer.bind();
  // 滚动跟随与滚底按钮常驻监听（合帧防抖、近底判据、回底途中闸与放闸）收敛进 scrollFollow 深 module
  scrollFollow.bind();
  const lineHeightSlider = bindResettableRangeSlider({
    input: els.lineHeightSlider,
    badge: els.lineHeightValue,
    resetBtn: els.lineHeightResetBtn,
    defaultValue: DEFAULT_SETTINGS.chatLineHeight,
    normalize: normalizeChatLineHeight,
    format: (val) => `${val}%`,
    initialValue: state.settings?.chatLineHeight,
    onPreview: (val) => {
      state.patchSettings({ chatLineHeight: val });
      applyReadingViewTypography();
    },
    onCommit: (val) => {
      void sendRuntimeMessage({ type: "save-settings", settings: { chatLineHeight: val } }).catch(() => null);
    }
  });

  const paraSpacingSlider = bindResettableRangeSlider({
    input: els.paraSpacingSlider,
    badge: els.paraSpacingValue,
    resetBtn: els.paraSpacingResetBtn,
    defaultValue: DEFAULT_SETTINGS.chatParagraphSpacing,
    normalize: normalizeChatParagraphSpacing,
    format: (val) => `${val}px`,
    initialValue: state.settings?.chatParagraphSpacing,
    onPreview: (val) => {
      state.patchSettings({ chatParagraphSpacing: val });
      applyReadingViewTypography();
    },
    onCommit: (val) => {
      void sendRuntimeMessage({ type: "save-settings", settings: { chatParagraphSpacing: val } }).catch(() => null);
    }
  });

  const syncTypographySlidersFromState = () => {
    lineHeightSlider.setValue(state.settings?.chatLineHeight);
    paraSpacingSlider.setValue(state.settings?.chatParagraphSpacing);
  };

  els.moreBtn?.addEventListener("click", (event) => {
    syncTypographySlidersFromState();
    popovers.toggleMoreMenu(event);
  });
  els.newChatBtn?.addEventListener("click", () => {
    popovers.hideMoreMenu();
    void startNewConversation();
  });
  els.historyBtn?.addEventListener("click", (event) => {
    popovers.toggleHistoryPopover(event);
  });
  els.historyClearBtn?.addEventListener("click", () => {
    void conversationStore.clearAll();
  });
  // 历史整页的退出键（整页盖住对话工具条，toggle 入口自己也被盖住；Esc 与
  // 「切走标签条」走既有的 window keydown / 文档级外点转发，不另挂监听）。
  els.historyBackBtn?.addEventListener("click", () => {
    popovers.hideHistoryPopover();
  });
  // 模型 chip：点开模型 + 思考档位面板。
  els.modelChip.addEventListener("click", popovers.toggleModelPanel);
  els.modelSelect.addEventListener("change", () => {
    // multi-model-catalog：选项值是「平台 id\u0001模型 id」复合值。选中项的
    // 持久化 = 复合值进 chrome.storage.local（providers 模块的 setSelectedProvider，
    // renderModelSelect 的选中回落直接消费）；sync settings 的 defaultModel 仍是
    // 裸平台 id（SW 激活平台解析的消费口径不变），但落盘收编进 save-settings
    // 通道（C5）：此前直写 chrome.storage.sync.set 绕过写白名单与
    // normalizeDefaultModel（trim），也不触发 SW 设置快照的写后 inline 失效；
    // 现与 aiThinkingLevel / webSearchEnabled 同一条口径（见 chat/providers.ts 的
    // setThinkingLevel）。
    const selected = parseModelOptionValue(els.modelSelect.value);
    const providerId = selected.providerId;
    if (providerId) {
      providerPrefs.setSelectedProvider(els.modelSelect.value);
      noteDefaultModelChoice(providerId);
    } else {
      noteDefaultModelChoice("");
    }
    void sendRuntimeMessage({ type: "save-settings", settings: { defaultModel: providerId } }).catch(() => null);
    updateModelSelectWidth(widthEls);
    // 模型选择变化：重判档位区（chip 文案含模型名 + 档位显示名 + 提示行一起重渲，含从
    // 「关不掉」模型切回可关模型时提示消失）。chip 不单独调用——refreshThinkingUi 经面板
    // 内部画它，一次 change 只渲一遍。
    refreshThinkingUi();
  });
  // 档位条目的点击接线已随二级菜单下沉到 reader/chat-model-panel.ts（条目现渲，
  // 静态 NodeList 不存在了）：面板点中条目 → pickLevel（下面的 pickThinkingLevel）
  // → 关面板。原「7 个静态按钮逐个 addEventListener」的接线随之退役。
  // 联网搜索开关（spec §4）：点击即改全局记忆（sync settings.webSearchEnabled）。
  if (els.webSearchPill) {
    els.webSearchPill.addEventListener("click", () => {
      void setWebSearchEnabled(!chatSessionState.webSearchEnabled);
    });
  }
  window.addEventListener("resize", onWindowResize);
  // 容器层委托（对话 tab 根节点 #readingChatRoot，元素随态重建而容器不换，
  // 对齐 batched-render 头注的容器委托先例）：
  //   1. 引用卡取消：[data-chat-intent-action="cancel"] 点击；
  //   2. 图片附件删除：[data-chat-image-remove] 点击（附件条目由
  //      chat/chat-input-images.ts 重建，容器委托对每次重建的键都生效）；
  //   3. 无平台空态「前往设置」：[id=readingChatOpenSettings] 点击 → 打开侧边栏
  //      设置抽屉（arch-slim-2/06 死绑定修复——该链接由 renderInitialState →
  //      resetConversationView 用 innerHTML 后建，原先 ui-renderer 在壳构建时
  //      getElementById 直绑，绑定时点早于元素诞生、监听器永远挂不上；容器
  //      委托对每次重建的链接都生效。href="#" 的默认跳转一并 preventDefault）。
  els.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const intentBtn = target?.closest<HTMLElement>("[data-chat-intent-action]");
    if (intentBtn && intentBtn.dataset.chatIntentAction === "cancel") {
      clearPendingExplainIntent();
      hideExplainIntentCard();
      return;
    }
    const removeBtn = target?.closest<HTMLElement>("[data-chat-image-remove]");
    if (removeBtn) {
      inputImages.removeAt(Number(removeBtn.dataset.chatImageRemove));
      return;
    }
    if (target?.closest<HTMLElement>(`[id="${ids.readingChatOpenSettings}"]`)) {
      // stopPropagation 必须有：打开抽屉的点击若继续冒泡到 ui-renderer 的文档级
      // click 委托，会被「settingsExpanded 已开 + 点在面板外」判定当成外点立即
      // 关闭（与壳内 readingSettingsToggleBtn 的 stopPropagation 同一先例）。
      event.preventDefault();
      event.stopPropagation();
      requestUiCommand("open-settings");
    }
  });
}

function onWindowResize(): void {
  // resize 路径读写交错（P2-3）：经 rAF 合帧，一帧至多跑一次「读布局 → 写宽度」。
  scheduleModelSelectWidthUpdate(widthEls);
}

// 输入框高度上限常量（实现与逻辑收归 chat-tab-composer.ts，本处保留供测试与类型锁定）
export const INPUT_MAX_HEIGHT = 320;

// AI 平台 / 预设：实现在 ../chat/providers.ts，本文件只组装 deps 并保留「外部
// 设置变更 → 刷新」编排（流式守卫 + 重渲染留在组合根）。
async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  // 选中平台回退取 providers 模块的 storage 闭包缓存。
  const previousProviderId = String(els.modelSelect?.value || providerPrefs.getStoredSelectedProviderId() || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  // 外部变更可能整体替换平台列表/选中平台/档位：与 init 同口径重判档位区（chip + 档位
  // 条目 + 提示行）。chip 不单独调用——refreshThinkingUi 经面板内部画它。
  refreshThinkingUi();
  // 在途回合（含「已受理、端口未建」的窗口）只推迟视图重建：历史列表照刷
  //（renderHistoryList 提到守卫之前，顺序即契约），in-flight 的流式节点不被
  // 重建清场。守卫判据是 isTurnActive() 而非 isStreaming()——后者在 connectPort
  // 之前的窗口为假，旧判据会在这个窗口把消息区重建掉（把已上屏的提问清走）。
  lists.renderHistoryList();
  if (chatRuntime.isTurnActive()) {
    return;
  }
  renderInitialState();
}

// ============================================================
// 上下文状态加载：编排壳在 ../chat/context-load.ts（装配策略在
// ../core/context-assembly.ts，动作判定在 ../chat/context-policy.ts）；下方为
// 整段迁自 sidepanel.ts 的页面级编排函数。
// ============================================================

// 【整段迁移自 sidepanel.ts】post-sync 分支编排：流式守卫 + 三个渲染回调。
// preserveInput 透传进上下文装载（gate 链与字幕落定对账为「上下文跟随」，见
// 各自调用点）。
async function syncLiveContextState(forceRefresh = false, preserveInput = false): Promise<void> {
  if (sessionClosed) {
    return;
  }
  const ok = await loadContextState({ forceRefresh, silent: true, preserveInput }).catch(() => false);
  if (sessionClosed || isPinnedContextStrict(chatSessionState.currentConversationMeta) || chatRuntime.isTurnActive()) {
    return;
  }
  if (!ok || !chatSessionState.contextData || !chatSessionState.providers.length || !chatSessionState.chatHistory.length) {
    renderInitialState();
    return;
  }
  lists.renderSuggestions();
}

// 【整段迁移自 sidepanel.ts】初始态渲染：无上下文 / 无平台 / 会话回放 / 非视频
// 四态分支逐字保持；无平台分支的「前往设置」换 readingChatOpenSettings id——
// 点击经本文件 bindEvents 的 #readingChatRoot 容器委托打开侧边栏设置抽屉
//（arch-slim-2/06 死绑定修复；open-options 消息已删除）。
// 唯一为测试而留的导出面（测试锚点：tests/reader/chat-tab.test.ts 直连渲染入口），
// 运行时消费方只需 closeChatSession / ensureChatTabActivated / runQuickActionPrompt。
export function renderInitialState(): void {
  updateChatLayoutState();
  if (!chatSessionState.contextData) {
    resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
    return;
  }
  if (!chatSessionState.providers.length) {
    resetConversationView(`还没有配置 AI 平台，<a href="#" id="${ids.readingChatOpenSettings}">前往设置</a>`);
    return;
  }
  if (chatSessionState.chatHistory.length) {
    // 回放改为按预算分片让出（P2-1）：fire-and-forget——本函数保持同步返回，
    // 首片同步上屏，其余在让出点续跑，末尾由 conversationReplay 统一收尾。
    conversationReplay.render();
    return;
  }
  if (chatSessionState.contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

// 【迁移自 sidepanel.ts resetConversationView】消息区重建 + 建议区重开。
function resetConversationView(stateHtml = ""): void {
  // 清场即作废进行中的回放分片（P2-1）：过期分片不得写进重建后的消息区。
  conversationReplay.invalidate();
  updateChatLayoutState();
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "chat-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  // 清场即重开本代建议区：消息区刚被清空，属主手里的节点已脱开文档，这一步是
  // 建议区的建立点（空表 = 在场的空建议区）；随后列表按当前状态填内容——列表的
  // 对账重渲只写在场建议区，不负责重建（历史回放清场后不得复活空壳）。
  suggestionsSlot.render([]);
  lists.renderSuggestions();
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
  // 清场后没有「回底」需求，且必须放闸（内容短的清场不产生 scroll 事件，闸若
  // 留着，用户此后的上翻会被误当成「回底途中」，按钮再也不亮）：统一交由 scrollFollow.reset()。
  scrollFollow.reset();
}

// 视图意图通道（chat/view-intent.ts 词表，arch-review-2026-10 候选 11 第一刀）：
// 「清场/状态屏」的唯一决策执行入口。chat 域 module（send-gate / context-load /
// chat-runtime）不再各自持清场回调，只发意图；本入口委托 resetConversationView，
// 其第一行恒作废在飞回放（世代号 +1）——「清场即作废回放」由本入口一处承重，
// 消费方不感知 replay，历史上的 replay→resetView→invalidate 回环已随 replay
// 空历史死分支一并摘除。
function requestViewReset(intent: ViewResetIntent): void {
  resetConversationView(intent.kind === "state" ? intent.html : "");
}

// 【整段迁移自 sidepanel.ts】布局状态：输入框高度只随内容走（autosizeInput），
// 上下文/历史变化时重测一次。
function updateChatLayoutState(): void {
  if (els.input) {
    composer.autosizeInput();
  }
}

// 【整段迁移自 sidepanel.ts】开启新会话：隐藏 popover → 强刷静默取上下文 →
// live 快照落地主上下文 → restartChat(keepContext) → 初始态渲染。
async function startNewConversation(): Promise<void> {
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  await loadContextState({ forceRefresh: true, silent: true });
  // 组合根绕过点（有意，不经 plan.action 分支）：live 快照非空即落到主上下文。
  // startNewConversation 是拆除事务——下一句 restartChat 才断流并清会话身份
  //（conversation-store.detachForRestart），所以流式中点「新对话」（策略给
  // blocked-streaming）与 pinned 会话（apply-pinned）都在此被绕过：新会话要在
  // 当前页上下文上起跑，两个守卫在此让位，与策略守卫正交；live 为空时空操作
  //（no-tab / error 的非 pinned 路径已由 loadContextState 自行清空主上下文），
  // skip-unchanged 同步的则是上一轮保留的 live 读。
  if (chatSessionState.liveContextData) {
    applyLiveContextToMain();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================

// 历史回放事务已抽进 ../chat/replay.ts（createConversationReplay，GLOSSARY.md 词条
// 「历史回放」），在 createChatTabDomain 内组装；本文件经 conversationReplay 的
// render/invalidate 两件持有（起跑 / 清场作废），inFlight 的发送前让位消费方
// 已收敛进发送闸（send-gate.ts 的 G7，经 tab-domain 的 replayInFlight 注入）——
// 世代作废、分片预算语义不变。

// 发送闸事务（ensureCurrentContextForSend G1-G7 + 字幕等待闸 + 转写相位订阅 +
// 主动起跑字幕抓取的读侧判定）已抽进 ../chat/send-gate.ts（createSendGate，
// GLOSSARY.md 词条「发送闸」），在 createChatTabDomain 内组装；本文件经 sendGate
// 实例持有。

// 主动起跑字幕抓取（finding 有字幕视频点 AI 键发出空上下文：等待闸只认 loading，
// idle 窗口会放行空字幕上下文，须由发送路径补发起跑方）：动作本体在
// subtitle/kick-subtitle-fetch——先确保总结链装载（refreshClip 注册进
// reader-bus seam）再发刷新请求。refreshClip 的同步前缀即写 loading（首个
// await 之前），因此等待闸不会抢在起跑前放行。refresh 有意不 await（浮空，
// 失败全吞）——业务上只需 loading 同步前缀；返回 false 只在总结链装载失败
//（抓取没能起跑）时，调用方按上下文读取失败拦截。
async function startSubtitleFetch(): Promise<boolean> {
  return kickSubtitleFetch(() => requestSubtitleRefresh(), {
    onChainLoadFailed: (error) => logWarn("[BILISCRIPT] subtitle fetch start failed", { error }),
    awaitRefresh: false,
    // 浮空 refresh 的失败原链上即 .catch(() => {}) 全吞，保持同口径。
    onRefreshFailed: () => {}
  });
}


// 时间戳跳转依赖包（注入 timestamp-nav）。reader 适配：seek 直接包进程内单入口
// seekReadingTarget（content script 无 chrome.tabs 消息链，无跨标签导航可言），
// 返回 null = 未绑定到视频，由 nav 侧降级为失败播报。
function getTimestampNavDeps() {
  return {
    contextUrl: String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim(),
    notice: showConversationContextNotice,
    seek: (seconds: number) => seekReadingTarget(seconds)
  };
}

// 【整段迁移自 sidepanel.ts】重启对话：清流状态 + 清会话状态 + 重置消息区
//（编排入口，被新对话/上下文切换复用）。
// preserveInput（发送闸调用链专用）：闸内 apply-live 的重启是「上下文跟随」，
// 不是用户语义上的「新会话」——不清输入框与附件区。附件在闸之后才被
// takeInputImages 消费，闸内清场会把随本条消息附的图片静默吞掉（正文照发）；
// 被闸拦下时用户已打好的文本也会一起没。用户主动点「新会话」（startNewConversation）
// 与上下文切换的其它路径不带该标志，仍照旧清场。
function restartChat({ keepContext = false, preserveInput = false }: { keepContext?: boolean; preserveInput?: boolean } = {}): void {
  // 「拆除会话」出口四（GLOSSARY.md 词条；工单 arch-slim-2/07 D 半场）：断流
  // 双轨统一——经 conversationStore.detachForRestart 发出 onStreamInterrupted，
  // 本函数不再直调 chatRuntime.resetStreamState。断流仍先于会话身份清空（订阅
  // 回调同步先执行，时序与直调时代一致）；订阅处是 resetStreamState 的唯一接线
  // 点，runtime 直调仅剩该订阅处与会话关闭 closeChatSession（非拆除事务，不属
  // 本收口）——store 事件管断流通知，防再造第三轨。
  conversationStore.detachForRestart();
  if (!keepContext) {
    rebuildCurrentContextKeyFromContext();
  }
  resetConversationView("");
  composer.setStreamingUiState(false);
  if (!preserveInput) {
    els.input.value = "";
    // 附件随输入框一起清场（新会话/上下文切换后不带着上一轮的图片）。
    inputImages.clear();
  }
  composer.autosizeInput();
}
