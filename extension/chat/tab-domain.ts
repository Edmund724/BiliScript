// extension/chat/tab-domain.ts — 对话 tab 内核链组装（arch-review-2026-09/08，
// 自 reader/chat-tab.ts 收口）。createChatTabDomain(deps) 是 chat 域对对话 tab
// 组合根的单一深入口：pinned 补水解析器（core/context-assembly）+
// conversation-store + context-load（含内联 createInProcessContextFetch）+
// sendGate（发送闸：发送前上下文就绪事务）+ chat-runtime + 历史回放 replay
// 七件在本模块组装；DOM 编排六件
//（feedback/lists/popovers/presets/providers/subtitle-wait）与页面级编排函数
// 留在 reader/chat-tab.ts，经 deps 注入。
//
// 组装内的实例级硬边顺序（唯一顺序约束，逐字保持自 chat-tab 原组装位）：
//   pinnedResolver → store → contextLoad → sendGate → runtime（→ replay 消费
//   runtime）。sendGate 夹在 contextLoad 与 runtime 之间：它消费前两件的实例
//   方法（loadContextState / hydratePinned），runtime 的 ensureCurrentContextForSend
//   又指向它的 ensureContextForSend。
// 其余跨实例引用一律惰性箭头（回调执行时实例已存在），不显式化：
//   store.loadContextState → contextLoad（后建）；contextLoad.restoreLatest →
//   store（先建）；contextLoad.isStreaming / hasPendingUserPrompt → runtime
//（后建）；sendGate.replayInFlight → replay（后建）。
//
// deps 面（reader/chat-tab 侧实现注入）：
//   - DOM 元素：messages / input（对话 tab 壳的 readingChat* id）；
//   - ui 门面：ChatRuntimeUi（chat-runtime 的布局/UI 回调纯分组，8 件回调由
//     组合根实现）+ store 能力事件三件（渲染编排反转：store 编排时机，组合根
//     订阅结果）+ contextLoad 的四个渲染编排回调（renderHistoryList /
//     renderInitialState / renderSuggestions / restartChat）；
//   - storage：store 存档读写（测试可注入，缺省 chrome.storage.local）；
//   - 状态 getter：clip / settings（进程内装配链两条路的运行时输入，与
//     core/context-assembly 的注入口径一致）；
//   - 发送闸编排：isSessionClosed / isReaderTranscribing / asrNotice /
//     pageBvid / startSubtitleFetch / subscribeStatusPhase（发送闸消费的
//     页面级读侧与通知面，组合根闭包注入）；
//   - runtime 传输/AI 回调：getProviderId /
//     getSelectedModel（multi-model-catalog 起，可选）/ takeInputImages
//     （image-input 02 号票起，可选：发送受理时消费图片附件区）/
//     getTimestampNavDeps / normalizeMarkdownForSectionPaste / connectPort
//    （闭包连着组合根的页面级状态与 DOM，留在 chat-tab）。
//
// 门面 re-exports：组合根仍需的 chat 域零散出口（chatSessionState 与三个
// B 档写方归并原语、offscreen 端口名、presets/providers 工厂）统一自本模块
// 转出——chat-tab 的 chat 域 import 面收敛为本模块一处（工单 08 验收：10 → 1）。
import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { ImagePart } from "../ai/types.js";
import type { ClipState } from "../core/state.js";
import type { Settings } from "../core/defaults.js";
import {
  createInProcessContextFetch,
  createInProcessPinnedContextResolver
} from "../core/context-assembly.js";
// pinned 补水未命中时落回的网络路径（ai/context-resolver 纯网络适配器，装配链
// 不复制其装配知识）；purpose="page" 的分页补水同源。
import { resolveAiConversationContext, resolveAiConversationPageRef } from "../ai/context-resolver.js";
import { createChatRuntime, type ChatPort, type ChatRuntimeUi } from "./chat-runtime.js";
import {
  createConversationStore,
  type ConversationChange,
  type ConversationContextNotice,
  type ConversationStore,
  type StorageArea
} from "./conversation-store.js";
import { createContextLoad, type ContextLoad } from "./context-load.js";
import { createSendGate, type SendGate } from "./send-gate.js";
import { createConversationReplay, type ConversationReplay } from "./replay.js";

// ---- 门面 re-exports（对话 tab 组合根的单点 chat 域出口，见头注）----
export {
  chatSessionState,
  applyLiveContextToMain,
  noteDefaultModelChoice,
  rebuildCurrentContextKeyFromContext
} from "./chat-state.js";
// offscreen 聊天端口名单源（chat/protocol.ts，ticket 08，原裸写字面量收口）。
export { OFFSCREEN_CHAT_PORT_NAME } from "./protocol.js";
export { createProviderPrefs, parseModelOptionValue } from "./providers.js";

export interface CreateChatTabDomainDeps {
  // ---- DOM 元素（reader/chat-tab 模块级 `els` 的壳两件）----
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  // ---- ui 门面（ChatRuntimeUi，组合根实现注入）----
  ui: ChatRuntimeUi;
  // ---- store 能力事件（渲染编排反转，组合根订阅结果）----
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: () => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  // ---- contextLoad 的渲染编排回调（DOM 编排留在组合根）----
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  restartChat: (opts?: { keepContext?: boolean; preserveInput?: boolean }) => void;
  // ---- 历史回放事务的编排回调（replay 消费，组合根注入）----
  updateChatLayoutState: () => void;
  clearSuggestions: () => void;
  // ---- 存储（可选；测试注入，缺省 chrome.storage.local）----
  storage?: StorageArea;
  // ---- 状态 getter（进程内装配链的运行时输入）----
  clip: () => Partial<ClipState>;
  settings: () => Partial<Settings>;
  // ---- 发送闸编排（sendGate 消费，组合根闭包）----
  // 会话关闭闸：pollContext 首行判定（关闭后等待立即兑现 false）。
  isSessionClosed: () => boolean;
  // 转写相位判定（与字幕 tab 横幅同源）。
  isReaderTranscribing: () => boolean;
  // 转写状态行元素（reader 壳 asrNotice；null = 壳未提供）。
  asrNotice: HTMLElement | null;
  // 当前页 BV（发送闸主动起跑字幕抓取的判定门输入）。
  pageBvid: () => string | null;
  // 主动起跑字幕抓取（ensure 总结链装载 + reader 刷新请求；失败返回 false）。
  startSubtitleFetch: () => Promise<boolean>;
  // 字幕状态总线订阅具名入口。
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  // ---- chat-runtime 传输/AI 回调（组合根闭包）----
  getProviderId: () => string;
  // 选中模型 id（multi-model-catalog，可选）：chat-runtime 透传进 chat 消息
  getSelectedModel?: () => string;
  // 图片附件（image-input 02 号票，可选）：发送受理时消费附件区，随 chat 消息的
  // images 字段下发（组合根接 reader/chat-tab.ts 的 inputImages.takeImages）。
  takeInputImages?: () => ImagePart[];
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
}

export function createChatTabDomain(deps: CreateChatTabDomainDeps): {
  runtime: ReturnType<typeof createChatRuntime>;
  store: ConversationStore;
  contextLoad: ContextLoad;
  sendGate: SendGate;
  replay: ConversationReplay;
} {
  // pinned 补水的 context 解析（工单 04 身份短路）接在 resolveAiConversationRef
  // 的 purpose="context" 用途上：会话 contextRef 与当前 clip 一致 → 进程内快照
  // 装配（零网络解析、不重下字幕正文）；未命中（换视频/换分P/换轨/无页面）→
  // ai/context-resolver 的网络路径原样兜底。
  const resolveConversationContext = createInProcessPinnedContextResolver({
    clip: deps.clip,
    settings: deps.settings,
    resolveNetwork: resolveAiConversationContext
  });
  // 会话状态（会话列表/当前会话/上下文）收拢在 chatSessionState，store 直接
  // import 读写；能力事件三件由组合根订阅（工单 05 渲染编排反转：store 自己
  // 编排渲染时机，组合根只订阅结果——历史列表恒随 onConversationChanged 重渲，
  // 标志驱动 popover/视图重建）。
  const store = createConversationStore({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    resolveAiConversationRef: (contextRef, purpose) =>
      purpose === "page" ? resolveAiConversationPageRef(contextRef) : resolveConversationContext(contextRef),
    onConversationChanged: deps.onConversationChanged,
    onStreamInterrupted: deps.onStreamInterrupted,
    onContextNotice: deps.onContextNotice,
    storage: deps.storage
  });
  // 上下文状态加载（读当前页状态 → 按策略动作执行编排副作用）。
  // 流式守卫判定惰性取 runtime（回调执行时实例已存在）。
  // 拉数据一段为 ContextFetch 策略注入——reader 与 content 同进程，用
  // createInProcessContextFetch 直读 state.clip（不走扩展页消息链；装配策略
  // 自工单 07 起收口在 core/context-assembly 的唯一装配链）。
  const contextLoad = createContextLoad({
    fetchContext: createInProcessContextFetch({
      clip: deps.clip,
      settings: deps.settings
    }),
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: deps.renderInitialState,
    renderSuggestions: deps.renderSuggestions,
    resetConversationView: deps.ui.resetConversationView,
    restartChat: deps.restartChat,
    restoreLatest: () => store.restoreLatest(),
    isStreaming: () => runtime.isStreaming(),
    hasPendingUserPrompt: () => runtime.hasPendingUserPrompt()
  });
  // 发送闸（CONTEXT.md 词条「发送闸」）：发送前上下文就绪事务（G1-G7 + 字幕
  // 等待闸 + 转写相位订阅）。消费前两件的实例方法（loadContextState /
  // hydratePinned）；replayInFlight 惰性取后建的 replay 实例（箭头推迟到回调
  // 执行期，无 TDZ）。
  const sendGate = createSendGate({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    hydratePinned: (opts) => store.hydratePinned(opts),
    resetView: deps.ui.resetConversationView,
    showContextNotice: deps.ui.showConversationContextNotice,
    removeContextNotice: deps.ui.removeConversationContextNotice,
    replayInFlight: () => replay?.inFlight ?? null,
    isSessionClosed: deps.isSessionClosed,
    isReaderTranscribing: deps.isReaderTranscribing,
    asrNotice: deps.asrNotice,
    pageBvid: deps.pageBvid,
    clip: () => deps.clip() as ClipState,
    startSubtitleFetch: deps.startSubtitleFetch,
    subscribeStatusPhase: deps.subscribeStatusPhase
  });
  // chat 流状态机：自身流状态（activePort 等）与自动滚动标志（shouldAutoScroll-
  // Messages）都在 runtime 闭包内；会话状态读 chatSessionState；deps 只剩 DOM
  // 容器/元素引用、store 实例与 UI/transport 回调。
  const runtime = createChatRuntime({
    // ---- DOM 容器 / 元素引用 ----
    messages: deps.messages,
    input: deps.input,
    // ---- conversation-store 窄接口（实例；isCurrent 为会话身份守卫的单一判定
    // 点，chat-runtime finalize/stopped 持久化前调用）----
    store,
    // ---- UI 门面 ----
    ui: deps.ui,
    // ---- AI 域 / 上下文 / 传输辅助 ----
    ensureCurrentContextForSend: () => sendGate.ensureContextForSend(),
    getProviderId: deps.getProviderId,
    getSelectedModel: deps.getSelectedModel,
    takeInputImages: deps.takeInputImages,
    getTimestampNavDeps: deps.getTimestampNavDeps,
    normalizeMarkdownForSectionPaste: deps.normalizeMarkdownForSectionPaste,
    connectPort: deps.connectPort
  });
  // 历史回放事务（CONTEXT.md 词条「历史回放」）：消费 runtime 的五件渲染方法，
  // 组装必须在 runtime 之后（实例互引由本调用点显式持有，回调侧不再绕箭头）。
  const replay = createConversationReplay({
    messages: deps.messages,
    renderer: runtime,
    updateLayout: deps.updateChatLayoutState,
    resetView: deps.ui.resetConversationView,
    clearSuggestions: deps.clearSuggestions
  });
  return { runtime, store, contextLoad, sendGate, replay };
}
