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
//   - 外点关闭：popovers 的 handleDocumentClick 经 chat-tab-bridge 注册槽并入
//     ui-renderer 的单一文档级委托（风险 6，不双监听）。
//
// 生命周期（懒加载 + 会话收尾，工单 08 决议）：
//   - 二级惰性：本模块经 reader/lazy-chat-tab.ts 动态装载，首次切到对话 tab（或
//     解释卡片「去对话追问」/概览笔记按钮触达 seam）才 init；
//   - 关闭阅读模式即断流（closeReadingView → closeChatSession：resetStreamState
//     断 port、pending 的 subtitle-wait 立即失效、摘全局触发源）；重开从会话
//     历史恢复（激活路径 loadProvidersAndPrefs → loadContextState → restoreLatest
//     → renderInitialState）；
//     对话 tab 的流式中关闭不做后台续跑（connectPort 的 closed 闸兜底）。
//   - 会话单例 initialized / initInFlight / sessionClosed：init 四路互不依赖的
//     初始化并行起跑；激活/恢复/关闭三入口经 reader/lazy-chat-tab 暴露；全局触发
//     源（storage watcher / Esc / 外点关闭桥接）随激活挂载、随收尾摘除，URL chip
//     适配与意图消费/快捷动作同在元素级绑定一线。sessionClosed 是模块内 let，
//     读侧仅 connectPort / pollContext 两处闭包（读只发生在回调执行时，晚于赋值
//     方求值）。
//
// 测试注意：els 在模块求值时解析（对话 tab 只在面板壳存在后装载，与 sidepanel
// 的页面加载时序同构）；模块级单例状态（chatSessionState + 本文件闭包）在测试里
// 靠 vi.resetModules 换纪元重置。
//
// 曾按 dom / core / lifecycle 浅拆四片（bc1498b），浅拆分并回本单文件。

import { state } from "../core/state.js";
// 当前地址是否 BV 视频页（抓取起跑的前置闸；非视频页对话仍可用，只是不抓字幕）。
import { extractBvid } from "../bilibili/video-id-shared.js";
// 思考档位「关不掉」提示的判定入口（工单 03）：纯查表 resolver，host 推断 +
// 模型名 taxonomy，无 DOM 依赖（后台路径同款判定天然不渲染提示）。
import { resolveThinkingProfile } from "../ai/thinking-profiles.js";
import { formatClock } from "../shared/clock-text.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
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
  rebuildCurrentContextKeyFromContext
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
import { createReaderChatModelPanel } from "./chat-model-panel.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
import { setChatTabOutsideClickHandler } from "./chat-tab-bridge.js";
// 图片附件区内核（image-input 02 号票）：粘贴 → 压缩 → 缩略图 + 单个删除。
import { createChatInputImages } from "../chat/chat-input-images.js";
// 发图门控（image-input 05 号票）：带图发送受理时按目录乐观放行（提示不阻断）。
import { createImageSupportGate } from "../chat/image-support.js";
// 联网搜索回放重建（spec §4）已随历史回放事务移入 ../chat/replay.ts
//（collectHistorySearchTurns 由其消费）。

// 壳命令通道（arch-review-2026-09/10 依赖反转）：快捷动作定位对话 tab 与空态
// 「前往设置」改发 reader-bus 具名命令，由 ui-renderer 注册的 handler 执行——
// 本文件不再静态 import ui/ui-renderer。
import { requestSubtitleRefresh, requestUiCommand } from "./reader-bus.js";
// 发送前主动起跑抓取的装载边（与 reader/lifecycle 同一条链：先 ensure 再经
// reader-bus 发刷新请求）。本模块是动态 chunk，静态 import 本叶子不拖常驻图。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { logWarn } from "../shared/logging.js";
// 对话分区表模块顶兜底挂载（arch-slim-4/07，settings-panel.ts 顶挂载同款先例）：
// 主点在 ui-renderer setReaderScriptTab 的 chat 分支（盖住现役三入口），此处盖
// 住未来新入口——本模块被动态装载即样式在场；ensure 内部 mounted Map 去重。
import { ensureReaderChatStyles } from "../shared/style-injector.js";
import { ids } from "./state.js";
// 时间戳跳转的进程内 seek（reader 域唯一定位入口，见 getTimestampNavDeps）。
import { seekReadingTarget } from "./sync.js";

ensureReaderChatStyles();

const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";

const els = {
  root: document.getElementById(ids.readingChatRoot) as HTMLElement,
  modelSelect: document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement,
  modelChip: document.getElementById(ids.readingChatModelChip) as HTMLButtonElement,
  modelPanel: document.getElementById(ids.readingChatModelPanel) as HTMLElement,
  modelPanelList: document.getElementById(ids.readingChatModelList) as HTMLElement,
  thinkingToggle: document.getElementById(ids.readingChatThinkingToggle) as HTMLElement,
  thinkingBtns: document.querySelectorAll<HTMLElement>(`#${ids.readingChatThinkingToggle} .chat-thinking-btn`),
  // 联网搜索开关 pill（spec §4，输入行 + 右侧）
  webSearchPill: document.getElementById(ids.readingChatWebSearchPill) as HTMLElement | null,
  // 思考档位「关不掉」提示行（工单 03，模板默认 hidden）
  thinkingHint: document.getElementById(ids.readingChatThinkingHint) as HTMLElement | null,
  newChatBtn: document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement,
  historyBtn: document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement,
  historyPopover: document.getElementById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: document.getElementById(ids.readingChatHistoryClearBtn) as HTMLButtonElement | null,
  // 历史整页头部的返回键（历史入口本身在对话工具条里，整页一开就被盖住，退出靠本键）
  historyBackBtn: document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement | null,
  messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
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
// ../chat/send-gate.ts（CONTEXT.md 词条「发送闸」），本文件经 sendGate 实例
// 持有 bindStatusBus/unbindStatusBus/kickSubtitleWait/refreshAsrNotice 四件。

// reader 触发源：biliscript:urlchange（core/url-watcher 广播）→ 强刷快档（切 P/切视频
// 必须全网络重拉）。调度状态机原在 chat/context-sync.ts 的
// createLiveContextSync（工单 05 并回）：~40 行纯间接层里 reader 只消费
// onUrlChange 一个触发源（sidepanel 世界的 visibility/focus/tabs handler 无
// 调用方，onReaderOpened/Closed 的恢复折叠进激活路径 restoreChatSession），
// 单宿主现实下保留其防抖语义即可——120ms 快档，重复触发即防抖重置（触发源
// 恒为强刷，原「弱刷不覆盖强刷」的合并分支无单宿主场景）。
let urlChangeSyncTimer = 0;
let urlChangeHandler: (() => void) | null = null;

function scheduleLiveContextSync(): void {
  if (urlChangeSyncTimer) {
    window.clearTimeout(urlChangeSyncTimer);
  }
  urlChangeSyncTimer = window.setTimeout(() => {
    urlChangeSyncTimer = 0;
    void syncLiveContextState(true);
  }, 120);
}

function bindUrlChangeTrigger(): void {
  if (urlChangeHandler) {
    return;
  }
  urlChangeHandler = () => scheduleLiveContextSync();
  window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, urlChangeHandler);
}

function unbindUrlChangeTrigger(): void {
  if (!urlChangeHandler) {
    return;
  }
  window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, urlChangeHandler);
  urlChangeHandler = null;
}

// 外部设置变更 → 刷新平台/偏好（与 sidepanel bindEvents 的 storage.onChanged
// 监听同语义；player-ai 信箱键的监听属摘除任务，不在 reader 消费）。
// 区/键过滤经 shared/watch-storage-keys seam（R3 收口）：sync 区六键或
// local 区 aiProviderKeys，解绑改 unsubscribe。
let unwatchStorageKeys: (() => void) | null = null;

function bindStorageWatcher(): void {
  if (unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys = watchStorageKeys(() => {
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
  });
}

function unbindStorageWatcher(): void {
  if (!unwatchStorageKeys) {
    return;
  }
  unwatchStorageKeys();
  unwatchStorageKeys = null;
}

// 跨模块共享状态（contextData / currentContextKey / providers / chatHistory /
// savedConversations / currentConversationId / currentConversationMeta /
// liveContextData / liveContextKey / liveTabUrl / aiPrefs / asrTranscribingActive /
// aiThinkingLevel）收拢在 ../chat/chat-state.ts 的 chatSessionState，本文件与各
// 子模块直接 import 读写。以下为纯局部单例。
let suggestionsNode: HTMLElement | null = null;
let initialized = false;
let initInFlight: Promise<void> | null = null;
// 会话收尾标志（closeChatSession 置位、激活路径复位）：闸住关闭后仍会兑现的
// 发送流程（subtitle-wait 等待中的 pollContext 与 connectPort），落实「关闭即
// 断流、不做后台续跑」。
let sessionClosed = false;

// 消息区反馈（通知条/居中错误/建议区清理/近底判定）：contextNoticeTimer 是
// notices 模块闭包私有状态；定时器用 window（测试可注入 fake）。
const feedback = createReaderChatFeedback({
  messages: els.messages,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatRuntime.scrollToBottom(),
  getSuggestionsNode: () => suggestionsNode,
  setSuggestionsNode: (node) => {
    suggestionsNode = node;
  },
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
  isMessagesNearBottom
} = feedback;

// 图片附件区（image-input 02 号票）：粘贴 → 压缩（03 号票规格）→ 缩略图 + 单个
// 删除；拒绝提示走消息区通知条（与上下文提示同一出口，自动隐藏）。流式闸含
// 「在途发送」（hasPendingUserPrompt）——发送流程从受理到落定的窗口里也不收新图。
// 消费点两处：chat-runtime 发送受理（deps.takeInputImages）与 restartChat 清场。
const inputImages = createChatInputImages({
  strip: els.imageStrip,
  isStreaming: () => chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt(),
  onReject: (message) => showConversationContextNotice(message, 4000)
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
  // 历史回放事务的编排回调：updateChatLayoutState 进 replay 首行（紧凑输入
  // 判定），clearSuggestions 置空模块级 suggestionsNode 引用。
  updateChatLayoutState,
  clearSuggestions: () => {
    suggestionsNode = null;
  },
  ui: {
    setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice,
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    resetConversationView,
    autosizeInput
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
    setStreamingUiState(false);
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
  renderSuggestions: () => lists.renderSuggestions(),
  restartChat,
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

// 两列表渲染（建议/历史）。hideHistoryPopover 与本实例/popovers 实例互引，惰性
// 箭头接线（回调执行时实例已存在）。
const lists = createReaderChatLists({
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  input: els.input,
  applyById: (id) => conversationStore.applyById(id),
  deleteById: (id) => conversationStore.deleteById(id),
  autosizeInput,
  onSuggestionClick: () => void sendFromUi(),
  getSuggestionsNode: () => suggestionsNode,
  hideHistoryPopover: () => popovers.hideHistoryPopover()
});

// 历史/模型面板两个弹层的开合与互斥；文档级外点关闭经 chat-tab-bridge 并入
// ui-renderer 的单一 document click 委托（组合根在激活/收尾时注册/摘除，见
// bindGlobalTriggers）；Esc 关闭走组合根的 window keydown 监听（同一时机挂载）。
const popovers = createReaderChatPopovers({
  historyPopover: els.historyPopover,
  modelPanel: els.modelPanel,
  historyBtn: els.historyBtn,
  modelChipBtn: els.modelChip,
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
  hidePanel: () => popovers.hideModelPanel()
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
// 宽度）。思考档位「关不掉」提示（工单 03）的 DOM 与判定在本文件
//（updateThinkingHint），baseUrl 识别入参由 providers 模块自 ai-providers-list
// 载荷透传。
const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  thinkingBtns: els.thinkingBtns,
  widthEls,
  webSearchPill: els.webSearchPill
});
const { loadProvidersAndPrefs, setThinkingLevel, setWebSearchEnabled } = providerPrefs;

// ============================================================
// 思考档位「关不掉」提示（工单 03，对话 tab 档位区唯一的 UI 增量）
// ============================================================

// 文案逐字给定（工单 03，勿改写）：长版 = 级联落了 low 档；短版 = 连 low 都没有。
const THINKING_OFF_FALLBACK_LOW_HINT = "当前模型不支持在本次请求中关闭思考，已使用最小思考档位";
const THINKING_OFF_UNAVAILABLE_HINT = "当前模型没办法关掉思考";

// 按当前档位 + 选中平台重判提示显隐。刷新点三处：模型选择 change、档位按钮
// 点击、平台列表重载（init 与外部设置变更后的 loadProvidersAndPrefs 之后）——
// 「关不掉」模型切回可关模型时提示随之消失。档位不是 Off、或 resolver 判 off
// 正常可用（含 never 模型静默与 unknown 哨兵）时一律隐藏。
function updateThinkingHint(): void {
  const hint = els.thinkingHint;
  if (!hint) {
    return;
  }
  hint.textContent = "";
  hint.hidden = true;
  if (chatSessionState.aiThinkingLevel !== "off") {
    return;
  }
  // 识别入参：baseUrl / presetId 沿 loadProvidersAndPrefs 已拉的
  // ai-providers-list 载荷（providers.ts 已透传进 chatSessionState.providers，
  // 不开新消息链）；模型名取选中项的模型 id（multi-model-catalog：选项值是
  // 「平台 id\u0001模型 id」复合值，解析后取模型段，平台记录仅作回落）。
  // stream 传 true：对话请求是流式，streamOnly 关闭规则（如 qwen3-235b 的
  // enable_thinking:false）在对话里正常可用，不误报提示。
  const selected = parseModelOptionValue(els.modelSelect.value);
  const provider = chatSessionState.providers.find((item) => item.id === selected.providerId);
  const resolution = resolveThinkingProfile({
    presetId: String(provider?.presetId || ""),
    baseUrl: String(provider?.baseUrl || ""),
    model: selected.model || String(provider?.model || ""),
    level: "off",
    stream: true
  });
  if (!resolution.offUnavailable) {
    return;
  }
  hint.textContent = resolution.offFallback === "low" ? THINKING_OFF_FALLBACK_LOW_HINT : THINKING_OFF_UNAVAILABLE_HINT;
  hint.hidden = false;
}

// 抓取/音频转写进行中（content 的 subtitleFetchState 为 loading 且字幕体为空）
// 时等待其完成再放行发送流程——等待闸状态机与提示路由已随发送闸迁入
// ../chat/send-gate.ts，本文件不直接持有 subtitleWaiter。

// ============================================================
// 激活 / 会话收尾（对外入口，经 reader/lazy-chat-tab 暴露）
// ============================================================

function bindGlobalTriggers(): void {
  sendGate.bindStatusBus();
  bindUrlChangeTrigger();
  bindStorageWatcher();
  bindQuickPromptRefresh();
  // 外点关闭单委托：注册进 ui-renderer 的文档级 click 委托（chat-tab-bridge）。
  setChatTabOutsideClickHandler(popovers.handleDocumentClick);
  // Esc 关闭三个弹层（window 级监听，与文档级 click 委托不同事件，不互踩）。
  window.addEventListener("keydown", onWindowEscapeKey);
}

function unbindGlobalTriggers(): void {
  sendGate.unbindStatusBus();
  unbindUrlChangeTrigger();
  unbindStorageWatcher();
  unbindQuickPromptRefresh();
  setChatTabOutsideClickHandler(null);
  window.removeEventListener("keydown", onWindowEscapeKey);
}

function onWindowEscapeKey(event: KeyboardEvent): void {
  popovers.handleEscapeKey(event);
}

// 预热落定 → 重渲建议区：字幕就绪后后台生成的问题到位时，建议区若正显示兜底
// 三条（用户手速快，刚进对话 tab 就撞上预热还在飞），就地换成逐视频生成的结果。
// 有会话历史时 renderSuggestions 自身会清空建议区，这里不必另判。
let unsubscribeQuickPrompts: (() => void) | null = null;

function bindQuickPromptRefresh(): void {
  if (unsubscribeQuickPrompts) {
    return;
  }
  unsubscribeQuickPrompts = subscribeQuickPromptsChange(() => {
    if (!initialized || chatRuntime.isStreaming()) {
      return;
    }
    lists.renderSuggestions();
  });
}

function unbindQuickPromptRefresh(): void {
  unsubscribeQuickPrompts?.();
  unsubscribeQuickPrompts = null;
}

async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  requireShell();
  bindEvents();
  bindGlobalTriggers();
  // 四路互不依赖的初始化并行起跑（opt-backlog-2026-09/05）——原先 offscreen
  // 确保 → 平台列表 → 会话存档 → 上下文装配四连串行 await，总等待为各路之和
  // （会话存档还曾随 loadAll 对至多 12 条历史会话各发一次串行视频元数据请求，
  // 现已收敛到 restoreLatest 命中项单条）；并行后总等待 = 最慢一路。offscreen
  // 失败不阻断 init（catch 吞掉，与每次发送前的 ensure 复用同一自愈路径）。
  await Promise.all([
    sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null),
    loadProvidersAndPrefs().then(() => {
      // 平台列表/档位落定后：首判「关不掉」提示（此后由模型切换/档位点击/
      // 外部刷新续判）+ 模型 chip 首渲（renderModelSelect 已把选中项写进 select）。
      updateThinkingHint();
      modelPanel.renderChip();
    }),
    conversationStore.loadAll(),
    loadContextState()
  ]);
  // 会话恢复依赖存档（loadAll）与上下文（loadContextState）双双落定。
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
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
  // 与 init / 外部变更刷新同口径三件：平台列表 + 模型 chip + 档位提示。
  await loadProvidersAndPrefs().catch(() => null);
  modelPanel.renderChip();
  updateThinkingHint();
  const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok) {
    return;
  }
  await conversationStore.restoreLatest();
  renderInitialState();
  autosizeInput();
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
    bindGlobalTriggers();
    await restoreChatSession();
  }
  // 已初始化的普通激活（tab 切回）：消费可能新写入的待解释意图（解释卡片
  // 「去对话追问」在对话 tab 已装载时点击 / 上次挂起的意图重试）。无意图时为无害 no-op。
  if (consumeIntent) {
    await consumeExplainIntentIfPending();
  }
}

export function closeChatSession(): void {
  if (!initialized) {
    return;
  }
  sessionClosed = true;
  // 断流收口（chat-runtime 断连路径已兜底 UI 态）：断 port、清在途一问一答与
  // 慢响应计时器；未流式时为无害空操作。
  chatRuntime.resetStreamState();
  setStreamingUiState(false);
  // 挂起中的 subtitle-wait 立即失效（pollContext 的 closed 闸 → wait 兑现
  // false → 发送流程提前返回并清等待提示）。
  sendGate.kickSubtitleWait();
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  removeConversationContextNotice();
  sendGate.refreshAsrNotice();
  // 会话收尾（意图已被 lifecycle.clearPendingExplainIntent 清掉）：引用卡随之
  // 隐藏，下次激活按无意图渲染。
  hideExplainIntentCard();
  unbindGlobalTriggers();
}

// ============================================================
// player-ai 快捷动作消费 seam（工单 08 决议：阅读模式内点击 = 定位/聚焦对话
// tab + 自动发送快捷提示词；PR4b 概览「生成完整笔记」按钮同 seam 直发）
// ============================================================

export async function runQuickActionPrompt(prompt: string): Promise<boolean> {
  // 定位/聚焦对话 tab（不触达字幕 tab 的滚动状态）。切 tab + 激活由壳经
  // set-tab:chat 命令统一执行（arch-review-2026-09/10）；consumeIntent:false
  // 透传给壳的激活入口——与快捷发送互不踩踏，不消费待解释意图。下方再显式
  // await 激活：命令是 fire-and-forget，发送流程必须等装载/恢复落定。
  requestUiCommand("set-tab:chat", { consumeIntent: false });
  // 首次调用完成装载；已装载时为幂等 no-op（不消费待解释意图——与快捷动作
  // 发送互不踩踏）。
  await ensureChatTabActivated({ consumeIntent: false });
  const text = String(prompt || "").trim();
  if (!text) {
    autosizeInput();
    els.input?.focus?.();
    return false;
  }
  await startNewConversation();
  return sendViaInputBox(text);
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

// peek 意图 → 渲染引用卡 → 自动发送解释提示词；发送成功（发送流程受理）才
// consumePendingExplainIntent——一次意图只发一次。发送被 subtitle-wait 挂起时
// sendMessage 的 promise 不提前兑现（等待在其内部 await），意图保持 pending
// 直到真正发出或用户取消（引用卡上的取消按钮）。
async function consumeExplainIntentIfPending(): Promise<void> {
  const intent = peekPendingExplainIntent();
  if (!intent || !intent.content) {
    hideExplainIntentCard();
    return;
  }
  renderExplainIntentCard(intent);
  const sent = await autoSendPrompt(buildExplainPrompt(intent));
  if (sent) {
    consumePendingExplainIntent();
    hideExplainIntentCard();
  }
}

// 发送芯（runQuickActionPrompt / autoSendPrompt 的共同尾部）：填输入框 →
// autosize → sendMessage → 折算是否受理。两函数头部的闸（新会话 vs 双发闸、
// 空串聚焦 vs 空串直 false）语义不同，不并入本芯。
// 受理成功 = 发送路径清空了输入框（ensureCurrentContextForSend 通过后才会清）；
// false = 被 provider/上下文/无字幕闸拦下（notice 已显示）。
async function sendViaInputBox(text: string): Promise<boolean> {
  els.input.value = text;
  autosizeInput();
  // 回放让出期发送同样先等回放落定（否则新消息插进未完成回放的中间）。
  await conversationReplay.inFlight;
  // sendMessage 兑现即发送流程已出结果（subtitle-wait 挂起在其内部 await）。
  await chatRuntime.sendMessage();
  return els.input.value === "" || chatRuntime.hasPendingUserPrompt();
}

// 自动发送共用体：填输入框 → sendMessage → 折算是否受理。流式中/有待发 prompt
// 时不注入第二次发送（双发竞态闸也会拦下），返回 false 让意图保持 pending。
async function autoSendPrompt(text: string): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }
  if (chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    return false;
  }
  return sendViaInputBox(text);
}

// 发送闸（P2-1 回放期）：回放让出期间新消息若直接 append，会插进未完成回放的
// 中间。所有 UI 发送入口（回车/建议 chip/解释意图自动发送）先 await 进行中的
// 回放再交给 chatRuntime；无进行中回放时为无害 no-op。
async function sendFromUi(): Promise<void> {
  await conversationReplay.inFlight;
  await chatRuntime.sendMessage();
}

// ============================================================
// bindEvents（元素级绑定；全局触发源见 bindGlobalTriggers）
// ============================================================

// 消息区滚动通知 rAF 合帧（10-2）：滚动事件的判定回调会在每次触发时读
// scrollHeight（强制布局）。按帧合批——同帧多条 scroll 只判定/通知一次，
// scrollHeight 读沉到帧回调，且来自 scrollToBottom 的写后紧跟读不再交错。
let scrollSyncFrame = 0;
function flushScrollAutoScrollSync(): void {
  scrollSyncFrame = 0;
  chatRuntime.setAutoScroll(isMessagesNearBottom());
}
function scheduleScrollAutoScrollSync(): void {
  if (scrollSyncFrame) {
    return;
  }
  if (typeof window.requestAnimationFrame === "function") {
    scrollSyncFrame = window.requestAnimationFrame(flushScrollAutoScrollSync);
  } else {
    scrollSyncFrame = window.setTimeout(flushScrollAutoScrollSync, 16);
  }
}

function bindEvents(): void {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendFromUi();
    }
  });
  // 图片粘贴（image-input 02 号票）：仅当剪贴板含 image/* 时拦截（纯文本/其它
  // 非图片内容不 preventDefault，既有粘贴行为不变）；压缩与上限判定在
  // chat/chat-input-images.ts，拒绝提示走消息区通知条。
  els.input.addEventListener("paste", (e) => {
    inputImages.handlePaste(e);
  });
  els.input.addEventListener("input", () => {
    autosizeInput();
    updateSendBtnState();
  });
  // 输入框高度两态：聚焦（有光标）展开、失焦收回一行。
  els.input.addEventListener("focus", autosizeInput);
  els.input.addEventListener("blur", autosizeInput);
  els.messages.addEventListener("scroll", scheduleScrollAutoScrollSync);
  els.newChatBtn.addEventListener("click", () => {
    void startNewConversation();
  });
  els.historyBtn.addEventListener("click", popovers.toggleHistoryPopover);
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
  // 发送键：空闲走与回车同一发送路径；流式中同键变停止键（圆形 + 方块图标）。
  els.sendBtn.addEventListener("click", () => {
    if (els.sendBtn.classList.contains("is-stop")) {
      chatRuntime.stopActiveStream();
      return;
    }
    void sendFromUi();
  });
  els.modelSelect.addEventListener("change", () => {
    // multi-model-catalog：选项值是「平台 id\u0001模型 id」复合值。选中项的
    // 持久化 = 复合值进 chrome.storage.local（providers 模块的 setSelectedProvider，
    // renderModelSelect 的选中回落直接消费）；sync settings 的 defaultModel 仍是
    // 裸平台 id（SW 激活平台解析的消费口径不变）。
    const selected = parseModelOptionValue(els.modelSelect.value);
    const providerId = selected.providerId;
    if (providerId) {
      providerPrefs.setSelectedProvider(els.modelSelect.value);
      noteDefaultModelChoice(providerId);
      chrome.storage.sync.set({ defaultModel: providerId }).catch(() => {});
    } else {
      noteDefaultModelChoice("");
      chrome.storage.sync.set({ defaultModel: "" }).catch(() => {});
    }
    updateModelSelectWidth(widthEls);
    // 模型选择变化：重渲 chip 文案（模型名）+ 重判提示（含从「关不掉」模型
    // 切回可关模型时消失）。
    modelPanel.renderChip();
    updateThinkingHint();
  });
  els.thinkingBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // setThinkingLevel 首行同步写 chatSessionState.aiThinkingLevel，紧随的
      // 重判读到的是新档位（档位切走即收提示，切回 Off 再现）。
      void setThinkingLevel(btn.dataset.level || "off");
      // chip 上的档位文案随新档位重渲。
      modelPanel.renderChip();
      updateThinkingHint();
    });
  });
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

// 输入框高度两态：未聚焦恒一行（模板 rows=1，省空间），聚焦（有光标）才展开——
// 下限两行、之上随内容长高、上限 320。杠杆必须是 min-height 而非 height：主轴上
// flex 项的 flex-basis:0% 让 height 失效（headless Chromium 实测：行内 height 写了
// 高度不变，只有 min-height 抬得动盒子），故失焦清空行内 min-height 即收回一行。
const INPUT_MAX_HEIGHT = 320;
// 聚焦下限按内容高写：textarea 是 content-box，屏上盒子另加 4px 内边距 → 56/48。
const INPUT_FOCUS_MIN_HEIGHT = 52;
const INPUT_FOCUS_MIN_HEIGHT_NON_VIDEO = 44;

function autosizeInput(): void {
  if (document.activeElement === els.input) {
    const focusMin = els.root.classList.contains("chat-non-video-context")
      ? INPUT_FOCUS_MIN_HEIGHT_NON_VIDEO
      : INPUT_FOCUS_MIN_HEIGHT;
    els.input.style.minHeight = `${Math.min(Math.max(els.input.scrollHeight, focusMin), INPUT_MAX_HEIGHT)}px`;
  } else {
    els.input.style.minHeight = "";
  }
  // 发送受理/重启会话等路径是程序化清输入框（不触发 input 事件），发送键禁用
  // 态统一在每次自适应时同步（autosizeInput 是所有这些路径的公共尾部）。
  updateSendBtnState();
}

// 发送键禁用态：流式中（停止键形态）仅「停止中」禁用；空闲时空输入禁用置灰。
let stopInFlight = false;

function updateSendBtnState(): void {
  if (els.sendBtn.classList.contains("is-stop")) {
    els.sendBtn.disabled = stopInFlight;
    return;
  }
  els.sendBtn.disabled = !els.input.value.trim();
}

function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
  // 流式中输入框不禁用（等待期间可继续打字）：发送闸由双发竞态闸拦——流式中
  // 回车/发送键走到的 sendMessage 会被 activePort 直接忽略，新消息发不出去。
  stopInFlight = stopping;
  // 同键双形态：空闲 = ↑ 发送键（空输入禁用）；流式中 = 停止键（圆形 + 方块
  // 图标，点击 abort 同一条 stopActiveStream 链），停止中禁用防连点。
  els.sendBtn.classList.toggle("is-stop", isStreaming);
  els.sendBtn.setAttribute("aria-label", isStreaming ? "停止" : "发送");
  els.sendBtn.disabled = isStreaming ? stopping : !els.input.value.trim();
}

// AI 平台 / 预设：实现在 ../chat/providers.ts，本文件只组装 deps 并保留「外部
// 设置变更 → 刷新」编排（流式守卫 + 重渲染留在组合根）。
async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  // 选中平台回退取 providers 模块的 storage 闭包缓存。
  const previousProviderId = String(els.modelSelect?.value || providerPrefs.getStoredSelectedProviderId() || "").trim();
  await loadProvidersAndPrefs({ preferredProviderId: previousProviderId });
  // 外部变更可能整体替换平台列表/选中平台/档位：与 init 同口径重渲 chip + 重判提示。
  modelPanel.renderChip();
  updateThinkingHint();
  if (chatRuntime.isStreaming()) {
    return;
  }
  lists.renderHistoryList();
  renderInitialState();
}

// ============================================================
// 上下文状态加载：编排壳在 ../chat/context-load.ts（装配策略在
// ../core/context-assembly.ts，动作判定在 ../chat/context-policy.ts）；下方为
// 整段迁自 sidepanel.ts 的页面级编排函数。
// ============================================================

// 【整段迁移自 sidepanel.ts】post-sync 分支编排：流式守卫 + 三个渲染回调。
async function syncLiveContextState(forceRefresh = false): Promise<void> {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (isPinnedContextStrict(chatSessionState.currentConversationMeta) || chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
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

// 【迁移自 sidepanel.ts resetConversationView】消息区重建 + 建议区刷新。
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
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "chat-suggestions";
  suggestionsNode.id = ids.readingChatSuggestions;
  els.messages.appendChild(suggestionsNode);
  lists.renderSuggestions();
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 【整段迁移自 sidepanel.ts】布局状态：紧凑输入判定写在对话 tab 根元素
//（sidepanel 写 document.body 的 chat-non-video-context）。
function updateChatLayoutState(): void {
  const useCompactInput = Boolean(
    chatSessionState.contextData &&
    chatSessionState.contextData.isVideoContext === false &&
    !chatSessionState.chatHistory.length &&
    !isPinnedContextStrict(chatSessionState.currentConversationMeta)
  );
  els.root.classList.toggle("chat-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}

// 【整段迁移自 sidepanel.ts】开启新会话：隐藏 popover → 强刷静默取上下文 →
// live 快照落地主上下文 → restartChat(keepContext) → 初始态渲染。
async function startNewConversation(): Promise<void> {
  popovers.hideHistoryPopover();
  popovers.hideModelPanel();
  await loadContextState({ forceRefresh: true, silent: true });
  if (chatSessionState.liveContextData) {
    applyLiveContextToMain();
  }
  restartChat({ keepContext: true });
  renderInitialState();
}

// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================

// 历史回放事务已抽进 ../chat/replay.ts（createConversationReplay，CONTEXT.md 词条
// 「历史回放」），在 createChatTabDomain 内组装；本文件经 conversationReplay 的
// render/invalidate/inFlight 三件持有——世代作废、分片预算、发送前让位语义不变。

// 发送闸事务（ensureCurrentContextForSend G1-G7 + 字幕等待闸 + 转写相位订阅 +
// 主动起跑字幕抓取的读侧判定）已抽进 ../chat/send-gate.ts（createSendGate，
// CONTEXT.md 词条「发送闸」），在 createChatTabDomain 内组装；本文件经 sendGate
// 实例持有。

// 主动起跑字幕抓取的动作本体（finding 有字幕视频点 AI 键发出空上下文：等待闸
// 只认 loading，idle 窗口会放行空字幕上下文，须由发送路径补发起跑方）：与
// reader/lifecycle 同一次序——先确保总结链装载（refreshClip 注册进
// reader-bus seam），再发刷新请求。refreshClip 的同步前缀即写 loading（首个
// await 之前），因此等待闸不会抢在起跑前放行。返回 false 只在总结链装载失败
//（抓取没能起跑）时，调用方按上下文读取失败拦截。
async function startSubtitleFetch(): Promise<boolean> {
  try {
    await ensureSummarizeChain();
    requestSubtitleRefresh().catch(() => {});
  } catch (error) {
    logWarn("[BILISCRIPT] subtitle fetch start failed", { error });
    return false;
  }
  return true;
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
function restartChat({ keepContext = false }: { keepContext?: boolean } = {}): void {
  // 「拆除会话」出口四（CONTEXT.md 词条；工单 arch-slim-2/07 D 半场）：断流
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
  setStreamingUiState(false);
  els.input.value = "";
  // 附件随输入框一起清场（新会话/上下文切换后不带着上一轮的图片）。
  inputImages.clear();
  autosizeInput();
}
