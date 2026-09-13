// extension/reader/chat-tab-core.ts — 对话 tab 组合根内核（chat-tab 拆分片，工单 12）。
//
// 职责：实例装配（feedback / createChatTabDomain / lists / popovers / modelPanel /
// presets / providerPrefs / subtitleWaiter，惰性箭头互引与顶层求值顺序必须整体
// 保持）+ ASR 提示行 + 思考档位提示 + widthEls 度量包 
// + URL 变化同步调度 + 页面级渲染（renderInitialState / resetConversationView /
// updateChatLayoutState）+ 历史回放分片 + ensureCurrentContextForSend 发送闸 +
// restartChat。四个页面级编排函数（syncLiveContextState / renderInitialState /
// resetConversationView / updateChatLayoutState）整段迁自 sidepanel.ts，时序咬合
// 逐字保持（见 chat-tab.ts 壳头注）；模块级单例（chatSessionState + 本片闭包）
// 在测试里靠 vi.resetModules 换纪元重置。

import { state } from "../core/state.js";
// 当前地址是否 BV 视频页（抓取起跑的前置闸；非视频页对话仍可用，只是不抓字幕）。
import { extractBvid } from "../bilibili/video-id-shared.js";
import { buildContextKey } from "../ai/conversation.js";
// 思考档位「关不掉」提示的判定入口（工单 03）：纯查表 resolver，host 推断 +
// 模型名 taxonomy，无 DOM 依赖（后台路径同款判定天然不渲染提示）。
import { resolveThinkingProfile } from "../ai/thinking-profiles.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
// 对话域单一深入口（arch-review-2026-09/08）：内核链五件（pinned 补水解析器 +
// conversation-store + context-load（含内联 createInProcessContextFetch 进程内
// 直读装配策略）+ chat-runtime）在 ../chat/tab-domain.ts 组装；chat 域其余出口
//（状态单例、subtitle-wait、no-subtitle 文案、context-policy 谓词、offscreen
// 端口名、presets/providers 工厂）统一经该门面转出——本文件的 chat 域 import
// 面收敛为一处（10 → 1）。
import {
  CONTEXT_READ_FAILED_MESSAGE,
  NO_SUBTITLE_SEND_BLOCKED,
  OFFSCREEN_CHAT_PORT_NAME,
  buildNoSubtitleNotice,
  chatSessionState,
  createChatTabDomain,
  createPresetPrompts,
  createProviderPrefs,
  createSubtitleWaiter,
  isContextPending,
  isNoSubtitleEmptyContext,
  isPinnedContextTruthy,
  parseModelOptionValue,
  type NoSubtitleReason
} from "../chat/tab-domain.js";
// reader 触发源与进程内相位（content script 收不到自己的 runtime 广播）。
import { BOC_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
// 转写中判定（与字幕 tab 横幅同源：相位 transcribing 且字幕体为空）。
import { isReaderTranscribing } from "./transcribe-banner.js";
// 壳三件（重建于 reader 域）+ 模型 chip/面板渲染 + tab 定位 + reader ids。
import { createReaderChatLists } from "./chat-lists.js";
import { createReaderChatFeedback } from "./chat-notices.js";
import { createReaderChatModelPanel } from "./chat-model-panel.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
// 壳命令通道（arch-review-2026-09/10 依赖反转）：快捷动作定位对话 tab 与空态
// 「前往设置」改发 reader-bus 具名命令，由 ui-renderer 注册的 handler 执行——
// 本文件不再静态 import ui/ui-renderer。
import { requestSubtitleRefresh, requestUiCommand } from "./reader-bus.js";
// 发送前主动起跑抓取的装载边（与 reader/lifecycle 同一条链：先 ensure 再经
// reader-bus 发刷新请求）。本模块是动态 chunk，静态 import 本叶子不拖常驻图。
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { logWarn } from "../shared/logging.js";
import { ids } from "./state.js";
import type { ModelSelectWidthEls } from "../chat/model-select-width.js";
// 时间戳跳转的进程内 seek（reader 域唯一定位入口，见 getTimestampNavDeps）。
import { seekReadingTarget } from "./sync.js";
import { els } from "./chat-tab-dom.js";
// 联网搜索回放重建（spec §4）：历史中的 tool 轮消息聚合为搜索回合（查询词 +
// 来源），时间线卡挂在回合的回答消息上；tool 消息本体不作为正文渲染。
import { collectHistorySearchTurns } from "../chat/search-sources.js";
// sessionClosed 读侧回边（唯一）：connectPort / pollContext 闭包读 lifecycle 片的
// sessionClosed，赋值方（ensureChatTabActivated / closeChatSession）在 lifecycle——
// 纯搬移约束下函数体不可改，读经 ESM live binding 只发生在回调执行时（两片求值
// 顺序任意均安全），模块图仅此一条回边。
import { sessionClosed } from "./chat-tab-lifecycle.js";

const NON_VIDEO_CONTEXT_MESSAGE = "当前页非 B 站视频页面，<br>无法获取当前页面信息作为对话上下文，<br>仅支持 AI 对话。";
// 无字幕视频做音频转写时，转写编排经进程内相位镜像广播阶段；刷新键转圈等待
// 期间据此显示一行转写提示，替代仅有图标旋转却没有说明的状态。只在转写阶段
// 展示，其余阶段（含转写结束后未再发布的情况）经由 setRefreshing(false) 与
// phase 判断隐藏。asr-done/asr-failed：一键总结若正在等待转写
//（subtitleWaiter.wait），立即触发一轮上下文轮询，不必等 4 秒间隔。
// （sidepanel 版监听 chrome.runtime.onMessage 的 boc-subtitle-status 广播；
// reader 与转写编排同进程收不到自己的广播，改订阅 shared/subtitle-status-bus。）
let unsubscribeStatusBus: (() => void) | null = null;

// 无字幕转写提示：本行只在转写相位（含等待发送期间）显示。原实现等待发送时在
// 消息区另起一条 .chat-context-notice（「正在等待音频转写完成…」），与状态行
// 「该视频无字幕，正在音频转写…」同屏重复——现按等待原因路由：转写中的等待并入
// 本行切换为合并句（唯一提示），仅字幕抓取中的等待走消息区通知（抓取文案，该
// 场景状态行隐藏，无重复）。
const ASR_TRANSCRIBING_NOTICE = "该视频无字幕，正在音频转写…";
const ASR_WAITING_NOTICE = "该视频无字幕，正在音频转写，完成后自动开始总结…";
const SUBTITLE_FETCHING_NOTICE = "正在抓取字幕，完成后自动开始总结…";
let asrWaitingActive = false;

export function updateAsrNotice(): void {
  if (!els.asrNotice) {
    return;
  }
  // 转写判定与字幕 tab 横幅同源（isReaderTranscribing：相位 transcribing 且
  // 字幕体为空——防御切视频后的相位残留压住有字幕视频的对话栏）。
  els.asrNotice.hidden = !isReaderTranscribing() && !asrWaitingActive;
  els.asrNotice.textContent = asrWaitingActive ? ASR_WAITING_NOTICE : ASR_TRANSCRIBING_NOTICE;
}

export function bindSubtitleStatusBus(): void {
  if (unsubscribeStatusBus) {
    return;
  }
  unsubscribeStatusBus = subscribeSubtitleStatusPhase((phase) => {
    if (phase === "asr-transcribing") {
      chatSessionState.asrTranscribingActive = true;
      // 转写相位开始：清掉等待闸此前落下的「正在抓取字幕…」消息区通知。那条
      // 通知描述的是抓取阶段，与转写状态行同屏即为自相矛盾的两条提示（用户
      // 报障：一闪两条重复且不正确的提示）；等待期间的正确提示由下一轮轮询
      // 把状态行切到合并句，消息区不再需要通知。
      removeConversationContextNotice();
    } else if (phase === "asr-done" || phase === "asr-failed") {
      chatSessionState.asrTranscribingActive = false;
      subtitleWaiter.kick();
    }
    if (phase !== "asr-transcribing") {
      // 转写相位结束：状态行从合并句回落基础句/隐藏，等待提示回消息区通知。
      asrWaitingActive = false;
    }
    updateAsrNotice();
  });
  // 订阅不回放当前相位：按当前相位恢复提示行呈现（打开晚于转写发起的窗口）。
  updateAsrNotice();
}

export function unbindSubtitleStatusBus(): void {
  unsubscribeStatusBus?.();
  unsubscribeStatusBus = null;
}
// reader 触发源：boc:urlchange（core/url-watcher 广播）→ 强刷快档（切 P/切视频
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

export function bindUrlChangeTrigger(): void {
  if (urlChangeHandler) {
    return;
  }
  urlChangeHandler = () => scheduleLiveContextSync();
  window.addEventListener(BOC_URL_CHANGE_EVENT, urlChangeHandler);
}

export function unbindUrlChangeTrigger(): void {
  if (!urlChangeHandler) {
    return;
  }
  window.removeEventListener(BOC_URL_CHANGE_EVENT, urlChangeHandler);
  urlChangeHandler = null;
}
// 跨模块共享状态（contextData / currentContextKey / providers / chatHistory /
// savedConversations / currentConversationId / currentConversationMeta /
// liveContextData / liveContextKey / liveTabUrl / aiPrefs / asrTranscribingActive /
// aiThinkingLevel）收拢在 ../chat/chat-state.ts 的 chatSessionState，本文件与各
// 子模块直接 import 读写。以下为纯局部单例。
let suggestionsNode: HTMLElement | null = null;
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
  // digest-only-ui：提示条「前往设置」打开侧边栏设置抽屉（open-options 已删；
  // 经 reader-bus open-settings 命令由壳执行，arch-review-2026-09/10）
  onOpenSettings: () => requestUiCommand("open-settings")
});
export const {
  showConversationContextNotice,
  removeConversationContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom
} = feedback;
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
//   - onConversationChanged：历史列表恒随事件重渲，change 标志（refreshContext-
//     Chip / historyCleared / resetView）声明其余需要刷新的呈现面；
//   - onStreamInterrupted：流式中删除当前会话 / 清空全部 / restoreLatest 无匹配
//     时由 store 同步发出——断 port、清在途一问一答、清消息区并退出流式 UI 态
//    （对应 restartChat 的清理动作，但不清会话状态——那由 store 自己做）。
//     store 不直接 import chatRuntime，依赖方向由 tab-domain 组装；回调幂等
//    （非流式时为无害空操作）。
//   - onContextNotice：上下文补水提示生命周期（pending 展示 / clear 撤除 /
//     error 展示）。
export const { runtime: chatRuntime, store: conversationStore, contextLoad } = createChatTabDomain({
  messages: els.messages,
  input: els.input,
  contextChip: els.contextChip,
  ui: {
    setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice,
    hidePresetPopover: () => popovers.hidePresetPopover(),
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    resetConversationView,
    autosizeInput
  },
  onConversationChanged: (change) => {
    lists.renderHistoryList();
    if (change.refreshContextChip) {
      contextLoad.updateContextChip();
    }
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
  ensureCurrentContextForSend,
  getProviderId: () => parseModelOptionValue(els.modelSelect.value).providerId,
  // 选中模型 id（multi-model-catalog）：随 chat 消息下发，offscreen 覆盖平台
  // 目录首项；复合值编码见 chat/providers.ts 的 MODEL_OPTION_SEPARATOR。
  getSelectedModel: () => parseModelOptionValue(els.modelSelect.value).model,
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
export const { loadContextState, updateContextChip } = contextLoad;
// 三列表渲染（建议/预设/历史）+ 预设提示词插入。insertPresetPrompt /
// hidePresetPopover / hideHistoryPopover 与本实例/popovers 实例互引，惰性
// 箭头接线（回调执行时实例已存在）。
export const lists = createReaderChatLists({
  presetList: els.presetList,
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  input: els.input,
  applyById: (id) => conversationStore.applyById(id),
  deleteById: (id) => conversationStore.deleteById(id),
  removePresetPrompt: (index) => presets.removePresetPrompt(index),
  autosizeInput,
  onSuggestionClick: () => void sendFromUi(),
  getSuggestionsNode: () => suggestionsNode,
  insertPresetPrompt: (prompt) => lists.insertPresetPrompt(prompt),
  hidePresetPopover: () => popovers.hidePresetPopover(),
  hideHistoryPopover: () => popovers.hideHistoryPopover()
});
// 预设/历史/模型面板三个弹层的开合与互斥；文档级外点关闭经 chat-tab-bridge 并入
// ui-renderer 的单一 document click 委托（组合根在激活/收尾时注册/摘除，见
// bindGlobalTriggers）；Esc 关闭走组合根的 window keydown 监听（同一时机挂载）。
export const popovers = createReaderChatPopovers({
  presetPopover: els.presetPopover,
  historyPopover: els.historyPopover,
  modelPanel: els.modelPanel,
  presetBtn: els.presetBtn,
  historyBtn: els.historyBtn,
  modelChipBtn: els.modelChip,
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  renderHistoryList: () => lists.renderHistoryList(),
  renderModelPanel: () => modelPanel.renderPanel()
});
// 模型 chip + 面板的渲染（chip 是隐藏 select 的展示层）；hidePanel 惰性互引
// popovers 实例（回调执行时实例已存在）。
export const modelPanel = createReaderChatModelPanel({
  modelSelect: els.modelSelect,
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement,
  panelList: els.modelPanelList,
  hidePanel: () => popovers.hideModelPanel()
});
// 宽度度量专用 els 引用包（model-select-width 的契约键名 chip/chipModel/chipLevel；
// 模块级 els 用 readingChat* 语义键名，二者在此显式对齐）。
export const widthEls: ModelSelectWidthEls = {
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement
};

// 上下文状态加载编排壳（../chat/context-load.ts）与 chat 流状态机
//（../chat/chat-runtime.ts）均已收进上面的 createChatTabDomain 组装；本文件
// 经解构消费 contextLoad（loadContextState / updateContextChip，见上）与
// chatRuntime 实例方法。
// 预设提示词 CRUD（deps 注入本文件的编排回调与 DOM 引用）。
export const presets = createPresetPrompts({
  presetInput: els.presetInput,
  renderPresetPrompts: () => lists.renderPresetPrompts()
});

// AI 平台加载渲染 + 思考档位（widthEls 见上：度量对象是 chip/chipModel/chipLevel
// 引用包；providers 内部的 updateModelSelectWidth 调用随 select 渲染刷新 chip
// 宽度）；persistAiPresetPrompts 惰性互引 presets。
// 思考档位「关不掉」提示（工单 03）的 DOM 与判定在本文件（updateThinkingHint），
// baseUrl 识别入参由 providers 模块自 ai-providers-list 载荷透传。
export const providerPrefs = createProviderPrefs({
  modelSelect: els.modelSelect,
  thinkingBtns: els.thinkingBtns,
  widthEls,
  webSearchPill: els.webSearchPill,
  renderPresetPrompts: () => lists.renderPresetPrompts(),
  persistAiPresetPrompts: () => presets.persistAiPresetPrompts()
});
export const { loadProvidersAndPrefs, setThinkingLevel, setWebSearchEnabled } = providerPrefs;

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
export function updateThinkingHint(): void {
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
// 时等待其完成再放行发送流程，状态机本体在 ../chat/subtitle-wait.ts（可测）。
// 这里只组装 deps：轮询读当前上下文、提示走消息区 notice、定时器用 window。
// 引用的 loadContextState / 通知函数都是组装后的实例方法（惰性接线）。
const SUBTITLE_WAIT_POLL_MS = 4000;
export const subtitleWaiter = createSubtitleWaiter({
  pollIntervalMs: SUBTITLE_WAIT_POLL_MS,
  pollContext: async () => {
    // 会话已收尾：立即失败放行（wait 兑现 false → 发送流程提前返回），
    // 不让关闭后的后台轮询继续养着一次「迟早会发」的发送。
    if (sessionClosed) {
      return { ok: false, pending: false };
    }
    const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
    // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
    // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
    const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
    return {
      ok: Boolean(snapshot),
      pending: isContextPending(snapshot, { asrTranscribingActive: chatSessionState.asrTranscribingActive })
    };
  },
  // 等待提示按原因路由：转写中的等待并入转写状态行（合成一句，不另起消息区
  // 通知，顺带清掉此前抓取文案残留的消息区通知）；仅字幕抓取中的等待（状态行
  // 隐藏）走消息区抓取文案，两者互斥不重复。
  showWaitingNotice: () => {
    if (isReaderTranscribing()) {
      asrWaitingActive = true;
      removeConversationContextNotice();
      updateAsrNotice();
      return;
    }
    showConversationContextNotice(SUBTITLE_FETCHING_NOTICE, 0);
  },
  removeNotice: () => {
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    removeConversationContextNotice();
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle)
});
// 发送闸（P2-1 回放期）：回放让出期间新消息若直接 append，会插进未完成回放的
// 中间。所有 UI 发送入口（回车/建议 chip/解释意图自动发送）先 await 进行中的
// 回放再交给 chatRuntime；无进行中回放时为无害 no-op。
export async function sendFromUi(): Promise<void> {
  await conversationReplayInFlight;
  await chatRuntime.sendMessage();
}
export function autosizeInput(): void {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  const minHeight = els.root.classList.contains("chat-non-video-context") ? 72 : 94;
  els.input.style.height = `${Math.max(next, minHeight)}px`;
  // 发送受理/重启会话等路径是程序化清输入框（不触发 input 事件），发送键禁用
  // 态统一在每次自适应时同步（autosizeInput 是所有这些路径的公共尾部）。
  updateSendBtnState();
}

// 发送键禁用态：流式中（停止键形态）仅「停止中」禁用；空闲时空输入禁用置灰。
let stopInFlight = false;

export function updateSendBtnState(): void {
  if (els.sendBtn.classList.contains("is-stop")) {
    els.sendBtn.disabled = stopInFlight;
    return;
  }
  els.sendBtn.disabled = !els.input.value.trim();
}

export function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
  els.input.disabled = isStreaming;
  stopInFlight = stopping;
  // 同键双形态：空闲 = ↑ 发送键（空输入禁用）；流式中 = 停止键（圆形 + 方块
  // 图标，点击 abort 同一条 stopActiveStream 链），停止中禁用防连点。
  els.sendBtn.classList.toggle("is-stop", isStreaming);
  els.sendBtn.setAttribute("aria-label", isStreaming ? "停止" : "发送");
  els.sendBtn.disabled = isStreaming ? stopping : !els.input.value.trim();
}
// ============================================================
// 上下文状态加载 / context chip：编排壳在 ../chat/context-load.ts（装配策略在
// ../core/context-assembly.ts，动作判定在 ../chat/context-policy.ts）；下方为
// 整段迁自 sidepanel.ts 的页面级编排函数。
// ============================================================

// 【整段迁移自 sidepanel.ts】post-sync 分支编排：流式守卫 + 三个渲染回调。
async function syncLiveContextState(forceRefresh = false): Promise<void> {
  const ok = await loadContextState({ forceRefresh, silent: true }).catch(() => false);
  if (chatSessionState.currentConversationMeta?.pinnedContext || chatRuntime.isStreaming() || chatRuntime.hasPendingUserPrompt()) {
    updateContextChip();
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
    // 首片同步上屏，其余在让出点续跑，末尾由 renderConversationMessages 统一收尾。
    void renderConversationMessages();
    return;
  }
  if (chatSessionState.contextData.isVideoContext === false) {
    resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
    return;
  }
  resetConversationView("");
}

// 【迁移自 sidepanel.ts resetConversationView】消息区重建 + 建议区/预设列表刷新。
function resetConversationView(stateHtml = ""): void {
  // 清场即作废进行中的回放分片（P2-1）：过期分片不得写进重建后的消息区。
  invalidateConversationReplay();
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
  lists.renderPresetPrompts();
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
    !chatSessionState.currentConversationMeta?.pinnedContext
  );
  els.root.classList.toggle("chat-non-video-context", useCompactInput);
  if (els.input) {
    autosizeInput();
  }
}
// ============================================================
// 消息区渲染（历史对话回放 → chat-runtime 渲染）
// ============================================================

// 回放分片预算（P2-1）：单帧同步渲染上限 50ms——长会话（数百条 markdown +
// 时间戳 linkify）一次性同步 append 会把主线程占满，期间输入/滚动全部卡住。
// 超过预算即让出（scheduler.yield 优先，setTimeout 0 兜底），让浏览器处理
// 输入与重绘后继续，末尾仍由本函数统一 scrollToBottom。
const REPLAY_FRAME_BUDGET_MS = 50;

// 回放世代号：每次重建消息区（重渲/清场）自增。让出点据此判定本轮是否已被
// 更新的一轮取代（切会话、新消息上屏、resetConversationView 清场）——过期
// 分片直接丢弃，不写进已重建的消息区，杜绝交错 append。
let conversationReplayGeneration = 0;
// 进行中的回放（让出点未落定时非 null）。发送路径先 await 它再 append：否则
// 用户回放途中回车/建议 chip/解释意图自动发送会把新消息插进未完成回放的中间。
export let conversationReplayInFlight: Promise<void> | null = null;

function invalidateConversationReplay(): void {
  conversationReplayGeneration += 1;
}

// 让出主线程：优先 scheduler.yield（续跑排到队列前部），无 scheduler 的浏览器
// 退回 setTimeout 0（续跑排到队尾，仅作兜底，语义仍是「先让浏览器喘一口气」）。
function yieldToMainThread(): Promise<void> {
  const schedulerApi = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof schedulerApi?.yield === "function") {
    return schedulerApi.yield();
  }
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function renderConversationMessages(): Promise<void> {
  const task = runConversationReplay();
  conversationReplayInFlight = task;
  try {
    await task;
  } finally {
    if (conversationReplayInFlight === task) {
      conversationReplayInFlight = null;
    }
  }
}

async function runConversationReplay(): Promise<void> {
  updateChatLayoutState();
  els.messages.innerHTML = "";
  suggestionsNode = null;
  if (!chatSessionState.chatHistory.length) {
    resetConversationView("");
    return;
  }
  invalidateConversationReplay();
  const generation = conversationReplayGeneration;
  const history = chatSessionState.chatHistory;
  // 联网搜索回合（spec §4）：历史中的 assistant(tool_calls) + tool 消息聚合为
  // 搜索回合，按回答消息下标对位——时间线卡插在回答前，来源随正文重建成
  // [n] 内联引用；tool 消息本体（含 JSON 结果）不作为消息渲染。
  const searchTurnByAssistantIndex = new Map(
    collectHistorySearchTurns(history).map((turn) => [turn.assistantIndex, turn])
  );
  // 与原 forEach 同语义：只遍历开跑时的长度，渲染期间新追加的消息不在此列
  //（流式写回走各自的 append 路径）。
  const total = history.length;
  let deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
  for (let index = 0; index < total; index += 1) {
    if (generation !== conversationReplayGeneration) {
      return;
    }
    const message = history[index];
    if (message.role === "user") {
      chatRuntime.appendUserMessage(message.content, false);
    } else if (message.role === "tool" || (Array.isArray(message.tool_calls) && message.tool_calls.length && !String(message.content || "").trim())) {
      // 工具轮消息（spec §2.5）：查询与结果由回合回答消息上的搜索时间线卡
      // 承载，消息本体不渲染（assistant(tool_calls) 无正文，tool 是 JSON）；
      // 带正文 + tool_calls 的混合消息照常渲染（正文不丢）。
      continue;
    } else {
      const node = document.createElement("div");
      node.className = "chat-msg chat-msg-assistant";
      const searchTurn = searchTurnByAssistantIndex.get(index);
      chatRuntime.renderAssistantMessage(node, String(message.content || ""), {
        userPrompt: findPreviousUserPrompt(index),
        ...(searchTurn ? { sources: searchTurn.sources } : {})
      });
      els.messages.appendChild(node);
      if (searchTurn) {
        // 卡片插在回答节点之前（先 append 节点再插卡——insertBefore 的参照
        // 节点必须已在 DOM 内）。
        els.messages.insertBefore(chatRuntime.buildSearchTimelineCard(searchTurn), node);
      }
    }
    if (performance.now() >= deadline) {
      await yieldToMainThread();
      if (generation !== conversationReplayGeneration) {
        return;
      }
      deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
    }
  }
  if (generation !== conversationReplayGeneration) {
    return;
  }
  chatRuntime.setAutoScroll(true);
  chatRuntime.scrollToBottom(true);
}

// 历史回放时找该助手消息的前一条用户消息（注入 renderAssistantMessage 的 userPrompt）
function findPreviousUserPrompt(index: number): string {
  for (let i = Number(index) - 1; i >= 0; i -= 1) {
    const item = chatSessionState.chatHistory[i];
    if (item?.role === "user" && typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}
// 发送前主动起跑字幕抓取（finding 有字幕视频点 AI 键发出空上下文）：等待闸
// （isContextPending）只认 subtitleFetchState === "loading"——面板打开后的后台
// 抓取要等播放器元数据（最多 5 秒）才起跑，这段「还没开始抓」的窗口里状态是
// idle，闸判定「非 pending」直接放行，字幕体为空就发给模型，只能得到凭标题
// 编造「无公开字幕」的总结（截图形态：状态行还停在「正在获取可用字幕...」，
// 对话里已经是一条无效回答）。这里在发送路径上补上抓取发起方：idle 且无字幕
// 体时主动起跑一轮，随后的 wait() 首轮轮询必见 loading，提示词被挂住直到
// 抓取落定（ready 放行完整字幕 / empty 走无字幕拦截）。
// 其余状态各有归属不重起一轮：loading 交给等待闸、ready 有字幕体、empty 走
// 无字幕拦截、error 由用户「刷新抓取」重试（不改其现状）。非 BV 视频页不抓
// （对话在非视频页仍可用，起跑只会换来一条「无法抓取字幕」的失败状态行）。
// 判定读 state.clip（进程内权威状态）而非上下文快照：快照是「装配时刻的投影」
//——createInProcessContextFetch 的载荷在拉热评之前组装（core/context-assembly），
// 热评那次网络往返期间落账的字幕不在快照里。按快照判定会在「另一轮抓取刚好
// 落账」时误判「还没抓」而多起一轮：这一轮把刚落账的抓取顶成 STALE_RUN，它的
// 终态文案（状态行「抓取完成…」）随之丢失，状态行停在「正在获取可用字幕...」，
// 而字幕列表已由前一轮填好、对话侧却还在等这轮多余抓取。
// 返回 false 只在总结链装载失败（抓取没能起跑）时，调用方按上下文读取失败拦截。
async function startSubtitleFetchIfNeeded(): Promise<boolean> {
  const pageBvid = extractBvid(location.href);
  if (!pageBvid) {
    return true;
  }
  const clipMatchesPage = String(state.clip.bvid || "") === pageBvid;
  if (clipMatchesPage && state.clip.subtitleBody.length > 0) {
    return true;
  }
  if (state.clip.subtitleFetchState !== "idle") {
    return true;
  }
  try {
    // 与 reader/lifecycle 同一次序：先确保总结链装载（refreshClip 注册进
    // reader-bus seam），再发刷新请求。refreshClip 的同步前缀即写 loading
    //（首个 await 之前），因此 wait() 不会抢在起跑前放行。
    await ensureSummarizeChain();
    requestSubtitleRefresh().catch(() => {});
  } catch (error) {
    logWarn("[BOC] subtitle fetch start failed", { error });
    return false;
  }
  return true;
}
// 【整段迁移自 sidepanel.ts】发送前确保当前上下文就绪（pinned 对话补水 / 普通
// 对话读当前页；抓取或音频转写进行中时先等待，避免空字幕上下文直接发给模型；
// 还没起跑时主动起跑，见 startSubtitleFetchIfNeeded）。
// 最终快照若是「无字幕收尾」（empty 且字幕体为空）则拦截发送：返回
// NO_SUBTITLE_SEND_BLOCKED 类型化信号让 sendMessage 提前返回（不追加用户消息、
// 不落 chatHistory、不发起 port），并按 noSubtitleReason 显示对应 notice。
async function ensureCurrentContextForSend(): Promise<boolean | string> {
  // pinned 判定沿用本调用点的原始语义（真值判断，与 loadContextState 的严格
  // 相等不同——见 ../chat/context-policy.ts 两个谓词的疑义记录）。
  if (isPinnedContextTruthy(chatSessionState.currentConversationMeta)) {
    await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
    return conversationStore.hydratePinned();
  }
  // 失败闸把「无标签页」与「读取失败」合并为同一文案（与策略模块的
  // resolveNoTabPlan 语义不同：这里即使静默加载也会重置视图），保持原状。
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !chatSessionState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  // 抓取还没起跑（idle）时主动起跑，再进等待闸——否则等待闸见不到 loading，
  // 空字幕上下文会被直接放行。
  if (!(await startSubtitleFetchIfNeeded())) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  const ready = await subtitleWaiter.wait();
  if (!ready) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  // 等待期间 contextData 可能停在旧快照（守卫分支或就绪瞬间），放行前重取
  // 一次，确保发送出去的是转写完成后的完整字幕。
  await loadContextState({ forceRefresh: false, silent: true }).catch(() => null);
  if (!chatSessionState.contextData) {
    resetConversationView(CONTEXT_READ_FAILED_MESSAGE);
    return false;
  }
  if (isNoSubtitleEmptyContext(chatSessionState.contextData)) {
    const notice = buildNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
    showConversationContextNotice(notice.message, 0, { openSettingsAction: notice.openSettings });
    return NO_SUBTITLE_SEND_BLOCKED;
  }
  // 本函数内的 loadContextState 可能因上下文变化触发一轮新的历史回放
  //（applyContextPayload → renderInitialState）；等它落定再返回，否则调用方
  // 紧随的 appendUserMessage 会插进这轮回放的中间（P2-1）。
  await conversationReplayInFlight;
  return true;
}
// 时间戳跳转依赖包（注入 timestamp-nav）。reader 适配：seek 走进程内直调
// seekReadingTarget（reader 域唯一定位入口，content script 无 chrome.tabs 消息
// 链），deps 形状保持 timestamp-nav 契约——getActiveTab 恒返回当前页伪 tab、
// matchContextUrl 恒 true（同一页面）、sendMessageToActiveTab 折算成 seek 回包。
function getTimestampNavDeps() {
  return {
    contextUrl: String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim(),
    notice: showConversationContextNotice,
    getActiveTab: async () => ({ id: 0, url: location.href }),
    matchContextUrl: () => true,
    sendMessageToActiveTab: async (_tabId: number, message: unknown) => {
      const seconds = Number((message as { seconds?: unknown } | null)?.seconds ?? 0);
      const applied = seekReadingTarget(seconds);
      return applied === null ? { ok: false, error: "视频时间跳转失败" } : { ok: true };
    }
  };
}
// 【整段迁移自 sidepanel.ts】重启对话：清流状态 + 清会话状态 + 重置消息区
//（编排入口，被新对话/上下文切换复用）。
export function restartChat({ keepContext = false }: { keepContext?: boolean } = {}): void {
  // 「拆除会话」出口四（CONTEXT.md 词条；工单 arch-slim-2/07 D 半场）：断流
  // 双轨统一——经 conversationStore.detachForRestart 发出 onStreamInterrupted，
  // 本函数不再直调 chatRuntime.resetStreamState。断流仍先于会话身份清空（订阅
  // 回调同步先执行，时序与直调时代一致）；订阅处是 resetStreamState 的唯一接线
  // 点，runtime 直调仅剩该订阅处与会话关闭 closeChatSession（非拆除事务，不属
  // 本收口）——store 事件管断流通知，防再造第三轨。
  conversationStore.detachForRestart();
  if (!keepContext) {
    chatSessionState.currentContextKey = buildContextKey(chatSessionState.contextData);
  }
  updateContextChip();
  resetConversationView("");
  setStreamingUiState(false);
  els.input.value = "";
  autosizeInput();
}
