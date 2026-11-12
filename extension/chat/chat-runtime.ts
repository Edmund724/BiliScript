// extension/chat/chat-runtime.ts — chat + stream state machine orchestration layer
// extracted out of extension/pages/sidepanel.js (ticket 07 of sidepanel-split;
// PR5 自 extension/pages/sidepanel-chat-runtime.ts 迁入 chat 域).
//
// 12 票浅拆：DOM 渲染/滚动/水合（流式双容器增量渲染/思考节点/用户与助手消息
// 装配/终态重渲染/自动滚动）已迁 ./chat-stream-render.ts（createChatStreamRenderer
// 工厂，闭包自持流式渲染状态）。本文件保留流状态机与 port 协议分派。
//
// 句柄化（渲染片 seam）：本文件不再出现 DOM 选择器与节点创建——DOM 装配全部经
// 渲染片的两个句柄：消息区句柄（messageArea：追加用户/助手消息 + 清场，助手节点
// 形状只有渲染片一个主人）与回合节点句柄（ChatAssistantTurn：activeTurn 槽位持有
// 的在途助手消息操作面——token / 思考 / 重置流式 / 三终态收尾 / 徽标 / 时间线卡）。
// 一代际的思考节点状态（原 thinkingNode / thinkingEnded）随句柄持有（换持有方式，
// 不改状态袋归属）。
//
// Responsibility: orchestrate "send message → stream receive → render assistant
// tokens → stop/error handling". It owns the stream runtime state
// (activePort / sendInFlight / activeTurn / activeUserPrompt /
// activeUserImages / streamSlowNoticeTimer /
// streamFirstTokenReceived) and the port
// protocol dispatch, delegates persistence (conversation-store, injected via
// deps), and hands DOM rendering / scrolling / hydration to
// ./chat-stream-render.js (consumed below by destructuring
// createChatStreamRenderer(deps)).
//
// 回合生命周期（受理窗口 / 在途判据 / 终态结算）收在 ./turn-lifecycle.ts
// （createTurnLifecycle，GLOSSARY.md 词条「发送闸」「历史回放」的时序面）：本文件
// 保留两个字段本体的声明（sendInFlight / activePort，ADR-0005 红线不搬归属）与
// 受理体 runAcceptance（provider 检查 / 闸 / 上屏 / 附件消费 / 连端口 /
// postMessage），把「何时算在途、如何停流、何时兑现 settle」全部交给 turn。
//
// 候选07：offscreen port 消息协议（reasoning/token/stream-reset/done/stopped/
// error/notice/cost-guard）统一经 dispatchChatPortMessage 分派——真实 port
// 监听器与公开的协议测试入口 handleChatPortMessage 共用；done/stopped/error
// 三条终态路径的六步收尾时序收敛为唯一的 endStream 实现。返回面收窄为
// 10 个 sidepanel 消费方法（含在途回合的 isTurnActive / settleTurn，C′ 停流
// 结算）+ 协议测试入口 handleChatPortMessage + 消息区句柄 messageArea（spec §4
// 回放重建经它表达顺序），内部步骤与全部 DOM 装配/选择器私有化。
//
// PR5 改造（宿主解耦补齐）：cost-guard 的确认通道经 deps.confirmCostGuard
// 注入，缺省为面板内确认弹层（ui/confirm-dialog.js；原生 confirm 绘制在浏
// 览器窗口正中央，面板停靠右侧时可能看不到）。endStream 的输入框聚焦
//（deps.input.focus()）本就经 deps 注入，无需改动。
//
// Boundary: this module does NOT touch sidepanel module-level layout variables
// or the surrounding chrome (header/popovers). Conversation state
// (chatHistory / conversation meta / context / aiPrefs / thinking level) lives
// in ./chat-state.js and is imported directly; everything else it needs —
// layout callback, context notices, DOM container references, input/stop-button
// element refs — arrives via the `deps` object of the `createChatRuntime(deps)`
// factory. The auto-scroll flag (shouldAutoScrollMessages) is owned by this
// module's closure: sidepanel writes it through the narrow setAutoScroll() /
// scrollToBottom() entries, the token flush / finalize paths read it here.
//
// Top-level side effects: NONE (no document/chrome/window access at module
// scope) — unlike sidepanel.js, this module evaluates cleanly under a Node test
// harness without a DOM shim.

import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { CaptureCurrentVideoFrame, ImagePart } from "../ai/types.js";
// 会话 id 生成（平台会话头 x-opencode-session 的身份来源，见 ai/preset-headers.ts）：
// 发送时物化，缺失才生成——持久化路径 persistCurrent 见已有 id 直接沿用。
import { generateConversationId } from "../ai/conversation.js";
// 成本护栏缺省确认通道：面板内弹层（ui/confirm-dialog.js）——原生 confirm
// 绘制在浏览器窗口正中央，面板停靠右侧时可能落在可视区外。
import { confirmDialog } from "../ui/confirm-dialog.js";
import { resolveWebSearchOptIn, SEARCH_OPT_IN_DECLINED_NOTICE } from "../search/opt-in-notice.js";
import type { ConversationStore } from "./conversation-store.js";
import {
  appendChatHistory,
  applyConversationIdentity,
  chatSessionState,
  clearConversationIdentity,
  ensureConversationId,
  type ChatSessionMessage
} from "./chat-state.js";
import { sanitizeFileName } from "../shared/string-utils.js";
// offscreen → 宿主的出向 port 消息联合（ticket 08 单源，原本处手抄八分派）。
// 注意：ChatPort 不从 protocol re-export——本侧消费的是 chrome.runtime.Port
// 全视图（监听/断连半边），protocol 的 ChatPort 是生产侧 postMessage 窄视图。
import type { ChatPortMessage } from "./protocol.js";
import type { GateOutcome } from "./send-gate.js";
import type { ViewResetIntent } from "./view-intent.js";
// 配置类回合错误（无平台 / 缺 Key）的分类单源：错误文案由 SW resolve-ai-provider
// 产生，分类与概览/解释两条链共用同一零依赖叶子（票 03）。
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { createTurnLifecycle, type SendVerdict } from "./turn-lifecycle.js";
import { createChatStreamRenderer, type ChatAssistantTurn, type ChatRegenerationSession, type ChatContinuationSession } from "./chat-stream-render.js";
// 图片支持的降级文案（image-input 05 号票）：平台 400 且本轮带图时的可操作提示。
import { imageUnsupportedErrorHint } from "./image-support.js";
import { createChatSpeechController, type ChatSpeechEngine } from "./chat-speech.js";

const STREAM_SLOW_NOTICE_MS = 15000;

// 发送受理结论由回合生命周期模块拥有（GLOSSARY.md 词条「发送闸」）；此处只转出，
// 保持既有 import 面（自 chat-runtime 取 SendVerdict 的调用方零改动）。
export type { SendVerdict };

// 在途回合结算（C′，见 isTurnActive / settleTurn）的看门狗兜底窗口（含「为什么
// 必须有」的推证）已随结算协议收进 ./turn-lifecycle.ts 的 TURN_SETTLE_FALLBACK_MS。

// ---------------------------------------------------------------------------
// offscreen chat port 的窄视图（chrome.runtime.Port 的结构子集，测试假 port 同构）
// ---------------------------------------------------------------------------

export interface ChatPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export type { ChatPortMessage };

// chat-runtime 消费的最窄 store 面（会话身份守卫 + 在途一问一答持久化）
export interface ChatRuntimeStore {
  isCurrent(id: string): boolean;
  persistCurrent(): Promise<void>;
}

// UI 门面（sidepanel 布局回调的纯分组；requestViewReset 为视图意图通道，
// 见 ./view-intent.ts 头注，其余方法名不变）
export interface ChatRuntimeUi {
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  showConversationContextNotice: (
    message: string,
    autoHideMs?: number,
    options?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      settingsTarget?: "asr";
      placement?: "input";
      action?: { label: string; onClick: () => void };
    }
  ) => void;
  removeConversationContextNotice: () => void;
  hideHistoryPopover: () => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  // 视图意图通道（view-intent.ts）：无平台等状态屏不再直调清场回调，只发意图；
  // 执行体唯一住在组合根的 requestViewReset。
  requestViewReset: (intent: ViewResetIntent) => void;
  autosizeInput: () => void;
  // 配置类回合错误（票 03）：缺 Key 的回合已受理（用户气泡已上屏），组合根据此在
  // 错误回合上给「直达平台编辑」的动作并记录返回意图。只提示，不重发——是否发送
  // 由用户再点一次。providerId = 本回合实际请求的平台记录。
  onSetupRequired?: (errorClass: OverviewSetupErrorClass, providerId: string) => void;
}

export interface CreateChatRuntimeDeps {
  // ---- DOM container / element refs (sidepanel module-level `els`) ----
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  // ---- conversation-store narrow interface (ticket 05) ----
  store: ChatRuntimeStore;
  // ---- UI 门面 ----
  ui: ChatRuntimeUi;
  // ---- context/transport helpers (AI domain, chat local) ----
  // 发送闸出口：{pass:true} 放行；{pass:false,kind} 拦截或取消。拦截通知由闸侧
  // 显示，所有非放行结果都保留文本与图片。
  ensureCurrentContextForSend: () => Promise<GateOutcome>;
  getProviderId: () => string;
  // 选中模型 id（multi-model-catalog）：chat 模型选择器一模型一选项后随
  // port 消息下发，offscreen 以它覆盖解析平台的目录首项。可选——未注入的
  // 旧组合根（测试）不发该字段，offscreen 回落平台目录首项。
  getSelectedModel?: () => string;
  // 图片在受理开始时只读快照，闸通过后按快照消费；等待期间新增的图片不随原
  // 回合发出。未注入快照入口的旧组合根仍在闸后全量消费，保持既有测试/宿主兼容。
  getInputImages?: () => ImagePart[];
  takeInputImages?: (snapshot?: ImagePart[]) => ImagePart[];
  canUseVideoFrameTool?: () => Promise<boolean>;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
  // cost-guard 确认通道（offscreen 发起 Map-Reduce 前的成本护栏）。缺省
  // 面板内确认弹层（ui/confirm-dialog.js）；同步布尔返回值也合法（注入桩/
  // 旧组合根），回执统一走 Promise 归一。
  confirmCostGuard?: (message: string) => boolean | Promise<boolean>;
  speechEngine?: ChatSpeechEngine;
  getSpeechVolume?: () => number | undefined;
  smoothStream?: boolean;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
}

/**
 * createChatRuntime(deps) — factory returning the chat runtime method set.
 *
 * The runtime owns the stream state machine; the auto-scroll flag
 * (shouldAutoScrollMessages) and the DOM render/scroll/hydrate step functions
 * live in the ./chat-stream-render.js piece (created once per factory call, so
 * per-instance isolation is preserved); conversation state (chatHistory /
 * conversation meta / context / aiPrefs / thinking level) is read/written via
 * the shared chatSessionState module. deps only carries DOM refs, the store
 * instance and UI/transport callbacks. The returned methods are bound closures
 * over the runtime's own closure state, so multiple factories would be isolated —
 * sidepanel constructs exactly one.
 *
 * @param {object} deps
 *   {
 *     // ---- DOM container / element refs (sidepanel module-level `els`) ----
 *     messages,        // els.messages  (messages scroll container)
 *     input,           // els.input
 *     // ---- conversation-store narrow interface (ticket 05) ----
 *     store,           // conversationStore instance: { isCurrent(id), persistCurrent() }
 *                      // isCurrent(id)：会话身份守卫的单一判定点（store 内实现，
 *                      // finalize/stopped 持久化前调用）
 *     // ---- UI 门面（sidepanel 布局回调的纯分组，方法名不变）----
 *     ui: {
 *       setStreamingUiState,               // (isStreaming, { stopping }) => void
 *       showConversationContextNotice,     // (message, autoHideMs) => void
 *       removeConversationContextNotice,   // () => void
 *       hideHistoryPopover,                // () => void
 *       removeCenteredState,               // () => void
 *       removeSuggestions,                 // () => void  (撤除建议区：属主 clear)
 *       requestViewReset,                  // (intent: ViewResetIntent) => void  视图意图通道
 *       autosizeInput,                     // () => void
 *     },
 *     // ---- context/transport helpers (AI domain, sidepanel local) ----
 *     ensureCurrentContextForSend,       // () => Promise<GateOutcome>
 *                                        //    {pass:true}=放行；
 *                                        //    {pass:false,kind:"read-failed"}=读取失败；
 *                                        //    {pass:false,kind:"no-subtitle"}=无字幕拦截（notice 已显示）
 *     getProviderId,                     // () => els.modelSelect.value
 *     getTimestampNavDeps,               // () => timestamp-nav deps object
 *     normalizeMarkdownForSectionPaste,  // (raw, baseLevel) => string
   *     connectPort,                       // () => Promise<chrome.runtime.Port> (name OFFSCREEN_CHAT_PORT_NAME 即 "offscreen-chat"; 先 ensure offscreen 文档)
   *     confirmCostGuard,                  // (message) => boolean | Promise<boolean>（可选；缺省面板内确认弹层 ui/confirm-dialog.js。cost-guard 确认通道）
   *   }
 *
 * @returns {object} method set (all closures; stream state only via the
 *   runtime's own closure variables — sidepanel queries it with isStreaming() /
 *   isTurnActive(), never by reading runtime internals)。
 *   接口面收窄为 10 + 1 + 1——只暴露 sidepanel 实际消费的 10 个方法 +
 *   1 个协议测试入口 + 1 个消息区句柄（联网搜索回放重建经它表达顺序，spec §4：
 *   历史回放的时间线卡从 chatHistory 重建）；内部渲染/收尾步骤（首 token、
 *   计时器、占位、token 追加、三类终态收口、thinking 节点、全部 DOM 选择器与
 *   节点装配）全部私有化，测试经 sendTurn + 假 port 或 handleChatPortMessage 以
 *   协议消息驱动，不直接戳内部步骤：
 *   {
 *     sendTurn,                    // (text) => Promise<SendVerdict>（accepted / blocked / ignored）
 *     stopActiveStream,            // () => void
 *     stopSpeech,                  // () => void  (离开对话 tab 时停止朗读)
 *     // ---- auto-scroll (flag owned by the ./chat-stream-render.js piece;
 *     // sidepanel writes via these narrow entries, flush/finalize read it
 *     // internally) ----
 *     setAutoScroll,               // (value) => void  (scroll listener / reset points)
 *     scrollToBottom,              // (force?) => void
 *     // ---- stream state queries / reset (sidepanel reads runtime state) ----
 *     isStreaming,                 // () => boolean   (activePort !== null)
 *     isTurnActive,                // () => boolean   (turn.isActive()：受理窗口 ∪ 流段，C′)
 *     settleTurn,                  // () => Promise<void>（在途：停流并在终态落定后兑现）
 *     hasPendingUserPrompt,        // () => boolean   (activeUserPrompt !== "")
 *     resetStreamState,            // () => void  (clear + disconnect + null state)
 *     // ---- 协议测试入口：offscreen port 消息对象进、UI/状态变化出 ----
 *     handleChatPortMessage,       // (msg) => void  (与 port.onMessage 监听器同分派)
 *     // ---- 消息区句柄（渲染片产出）：追加用户/助手消息（带来源）+ 清场；
 *     // 回放（replay.ts）与协议级测试经它取回合句柄（ChatAssistantTurn）----
 *     messageArea,                 // ChatMessageArea
 *   }
 */
export function createChatRuntime(deps: CreateChatRuntimeDeps) {
  // ---- stream runtime state (closure-local) ----
  let activePort: ChatPort | null = null;
  // 在途助手消息的回合节点句柄（渲染片产出的操作面）：本字段槽位不变，持有物从
  // 「节点引用」换成「节点句柄」——状态机不再出现选择器与节点创建，节点装配形状
  // 只有渲染片一个主人。思考节点的一代际状态随句柄持有（原本文件的
  // thinkingNode / thinkingEnded 两条字段随之消失）。
  let activeTurn: ChatAssistantTurn | null = null;
  let activeRegeneration: {
    originalHistory: ChatSessionMessage[];
    userIndex: number;
    session: ChatRegenerationSession;
  } | null = null;
  let activeContinuation: {
    originalHistory: ChatSessionMessage[];
    userIndex: number;
    historyIndex: number;
    initialRaw: string;
    userPrompt: string;
    branch: "A" | "B";
    session: ChatContinuationSession;
  } | null = null;
  let activeUserPrompt = "";
  // 本回合实际请求的平台记录 id（票 03）：配置类回合错误（缺 Key）到达时已无处
  // 重新解析选中项（用户气泡已上屏、回合正在收尾），故受理时快照一份，供
  // onSetupRequired 直达那条平台记录。与 activeUserPrompt 同生命周期清空。
  let activeTurnProviderId = "";
  // 本代际用户消息的图片（image-input 04 号票）：发送受理时随 activeUserPrompt
  // 一起捕获，done/stopped 写回时挂在那条 user 消息上——图片从此进历史，
  // 追问/落盘才看得到（收口与 activeUserPrompt 同步清空，不串进下一条消息）。
  let activeUserImages: ImagePart[] = [];
  // 联网搜索的 tool 轮持久化副本（spec §2.5）：tool-turn 事件到达时缓存，
  // done/stopped 写回时按 user → tool 消息 → assistant 顺序插入 chatHistory，
  // 收口时清空（终态后不串入下一条消息）。
  let pendingToolMessages: ChatSessionMessage[] = [];
  // 本代际的截断提示文案（notice(code:"truncated") 落到这里；空串 = 未被截断）。
  // 文案由引擎给（ai/client.ts 的 TRUNCATED_NOTICE），宿主不复制一份；done 收尾时
  // 渲染成 assistant 消息尾部的常驻徽标（.chat-msg-truncated）。生命周期与
  // pendingToolMessages 同款：发送时复位、终态消费——只活在本次视图，不落会话记录，
  // 重开对话后不再有。
  let turnTruncatedNotice = "";
  // 会话身份快照：受理发起时捕获 currentConversationId，finalize /
  // stopped 持久化前经 deps.store.isCurrent(快照) 判定（守卫逻辑单点收在
  // store，见 sidepanel-conversation-store.js）。发送后当前会话被删除/清空/
  // 切换（id 已变）则只更新 DOM，不 push 进 chatHistory、不 persistCurrent——
  // 流式中删除当前会话导致会话"复活"的竞态兜底（第一道防线是 store reset 路
  // 径注入的 stopActiveChat）。
  let activeConversationId = "";
  let streamSlowNoticeTimer = 0;
  // 慢响应计时器与首 token 标志的分离（见 startStreamSlowNoticeTimer /
  // handleFirstStreamToken / clearStreamRuntimeState）：
  // - streamSlowNoticeTimer 只表达「慢响应计时器挂起中」；clearStreamRuntimeState
  //   清它（每代际一次，done/stopped/error/断连/流重置时）；
  // - streamFirstTokenReceived 是「本代际已收到首 token」的一代际语义标志，
  //   由发送时置 false、首 token 置 true，slow 计时器与「首 token 后不再重弹」
  //   都读它。它不能被 clearStreamRuntimeState 复位——clear 也会在收尾时被调，
  //   一旦复位，收尾后到达的下一带 reasoning/token 事件会再次触发
  //   handleFirstStreamToken 的清理副作用（计时器其实已清、无可见后果，但
  //   reasoning 收尾事件可能误清下一条消息的提示状态）——见 handleFirstStreamToken。
  let streamFirstTokenReceived = false;
  // 受理窗口标志（字段本体，ADR-0005 红线：声明处不动）：sendInFlight 管
  // connectPort await 之前的窗口（此时端口未建立，isStreaming() 为假），
  // activePort 管流式窗口。两者的**组合方式**（在途判据 / 停流登记 / 终态结算）
  // 收在下面的 turn（./turn-lifecycle.ts）——置位与复位只经 turn 的
  // accepting 槽位，本文件不再直接读写它。
  let sendInFlight = false;
  // 候选5：offscreen 侧已确认缓存字幕体的 contextKey（从其每次回执的
  // cachedContextKey 读到）。追问消息据此省略整份 subtitleBody——长视频单份
  // 字幕体可达数 MB，逐条追问经 port 重传纯属浪费。null = 未确认（首条消息、
  // port 断连、字幕体缺失错误之后），必然全量携带。
  let lastAckedContextKey: string | null = null;
  const pendingVideoFrames = new Map<string, AbortController>();
  const activeToolCalls = new Set<string>();

  // ---- 回合生命周期（./turn-lifecycle.ts，GLOSSARY.md 词条「发送闸」「历史回放」）----
  // 一个回合「受理开始 → 终态落定」的时序与结算唯一实现点：在途判据（受理窗口
  //  ∪ 流段）、「端口就绪即停」的登记与补发、待决 settle 队列与看门狗兜底都在
  // 那边。这里只交出能力：两个字段本体的槽位/读法（sendInFlight / activePort）、
  // 停流动作、拆除兜底、受理体 runAcceptance。
  const turn = createTurnLifecycle({
    accepting: {
      get: () => sendInFlight,
      set: (value) => {
        sendInFlight = value;
      }
    },
    isStreaming: () => activePort !== null,
    stopStream: () => stopStreamNow(),
    forceReset: () => {
      resetStreamState();
      setStreamingUiState(false);
    },
    runAcceptance: (text) => runAcceptance(text)
  });

  // ---- internal helpers ----
  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    deps.ui.setStreamingUiState(isStreaming, { stopping });
    messageArea.setRegenerationDisabled(isStreaming || turn.isActive() || activeRegeneration !== null || activeContinuation !== null);
  }
  function abortAllVideoFrames(): void {
    const controllers = [...pendingVideoFrames.values()];
    pendingVideoFrames.clear();
    for (const controller of controllers) controller.abort();
  }
  // =========================================================================
  // DOM 渲染/滚动/水合片（./chat-stream-render.ts）的跨片消费面
  // =========================================================================
  // 渲染片对外只给两个句柄：消息区句柄（messageArea：追加用户/助手消息 + 清场）
  // 与滚动/自动滚动窄入口。回合节点句柄（ChatAssistantTurn）由消息区句柄产出、
  // 经 activeTurn 槽位持有——本文件不再解构/调用任何 DOM 步骤函数。
  const speech = createChatSpeechController({
    engine: deps.speechEngine,
    getVolume: deps.getSpeechVolume,
    onError: (message) => deps.ui.showConversationContextNotice(message, 4000)
  });
  const { scrollToBottom, setAutoScroll, messageArea } = createChatStreamRenderer({
    ...deps,
    onRegenerate: regenerateAssistant,
    onContinue: (historyIndex, node) => {
      deps.onContinue?.(historyIndex, node);
      continueAssistant(historyIndex, node);
    },
    onExport: exportAssistant,
    onNotice: (message) => deps.ui.showConversationContextNotice(message, 4000),
    onSpeak: (messageId, button, text) => speech.toggle(button, text, { messageId }),
    onClear: () => speech.stop(),
    isRegenerationDisabled: () => turn.isActive() || activeRegeneration !== null || activeContinuation !== null
  });
  // =========================================================================
  // dispatchChatPortMessage — offscreen port 消息的协议分派（八分派 + 代际重置）
  // =========================================================================
  // 受理体内注册的 port.onMessage 监听器的函数体与公开的 handleChatPortMessage
  // （协议测试入口）共用同一份分派。port 参数仅用于 cost-guard 的确认回执：
  // 真实监听器传当前 port；测试入口传 activePort。
  function dispatchChatPortMessage(msg: ChatPortMessage | null | undefined, port: ChatPort | null): void {
    if (!msg) return;
    // 候选5：offscreen 每次回执都带 cachedContextKey（其单槽字幕体缓存当前
    // 持有的 key）——推进 lastAcked，后续追问省略 subtitleBody。字幕体缺失
    // 错误不带该字段，由下方 error 分支显式重置。
    if (typeof msg.cachedContextKey === "string" && msg.cachedContextKey) {
      lastAckedContextKey = msg.cachedContextKey;
    }
    if (msg.type === "video-frame-cancel") {
      const controller = pendingVideoFrames.get(msg.requestId);
      pendingVideoFrames.delete(msg.requestId);
      controller?.abort();
      return;
    }
    if (msg.type === "video-frame-request") {
      if (!port) return;
      const controller = new AbortController();
      pendingVideoFrames.get(msg.requestId)?.abort();
      pendingVideoFrames.set(msg.requestId, controller);
      void (async () => {
        try {
          if (!deps.captureCurrentVideoFrame) {
            throw new Error("当前页面不支持视频截图");
          }
          const captureResult = await deps.captureCurrentVideoFrame(msg.targetTime, controller.signal);
          if (controller.signal.aborted || pendingVideoFrames.get(msg.requestId) !== controller) return;
          port.postMessage({
            action: "video-frame-result",
            requestId: msg.requestId,
            ...(Array.isArray(captureResult)
              ? { frames: captureResult }
              : { image: captureResult.image, currentTime: captureResult.currentTime })
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          try {
            port.postMessage({
              action: "video-frame-result",
              requestId: msg.requestId,
              error: String((error as Error)?.message || error)
            });
          } catch {}
        } finally {
          if (pendingVideoFrames.get(msg.requestId) === controller) {
            pendingVideoFrames.delete(msg.requestId);
          }
        }
      })();
      return;
    }
    if (msg.type === "reasoning") {
      handleFirstStreamToken();
      // 思考节点的一代际状态（是否已有打开的节点 / 是否已收尾）随回合句柄持有
      // （./chat-stream-render.ts 的 ChatAssistantTurn）：token 收尾后仍到达的
      // reasoning 收尾事件由句柄新建节点（附着当前在途回合的节点——跨消息时
      // activeTurn 已换到新回合），不再写进已折叠的旧节点。
      activeTurn?.appendThinking(msg.data);
    } else if (msg.type === "token") {
      handleFirstStreamToken();
      activeTurn?.appendToken(msg.data);
    } else if (msg.type === "token-batch") {
      // 07 票合帧：与逐 token 同一 appendToken 渲染收口（首个 token 注册帧，
      // 同批其余 token 并入挂起帧），视觉输出与逐 token 传输逐字节一致。
      handleFirstStreamToken();
      for (const token of Array.isArray(msg.data) ? msg.data : []) {
        if (typeof token === "string") {
          activeTurn?.appendToken(token);
        }
      }
    } else if (msg.type === "stream-reset") {
      // 读流中断重试（offscreen 重新从头生成）：已吐 token 撤不回且新流不保证
      // 前缀一致，清空本条消息缓冲整体重放，避免两代流拼接成重复文本。
      activeToolCalls.clear();
      activeTurn?.reset();
    } else if (msg.type === "done") {
      finalizeAssistant(activeTurn);
    } else if (msg.type === "stopped") {
      handleAssistantStopped(activeTurn, msg.reason || "已停止生成");
    } else if (msg.type === "error") {
      // 候选5：offscreen 单槽缓存缺失（文档被回收后重启 / 槽 key 不匹配）回
      // 「字幕体缺失」→ 重置 lastAcked 让下一条消息重发全文。本条不自动重发，
      // 避免失败风暴；用户重发时自然走全量。
      if (msg.code === "subtitle-body-missing") {
        lastAckedContextKey = null;
      }
      // 配置类错误（票 03）：错误文案的单源分类器在 core/overview-setup-error。
      // 先快照本回合的平台记录，再收尾（endStream 会清 activeTurnProviderId）。
      const setupErrorClass = classifyOverviewSetupError(msg.error);
      const setupProviderId = activeTurnProviderId;
      showAssistantError(activeTurn, msg.error || "未知错误");
      // 收尾之后才通知组合根：endStream 的 clearStreamRuntimeState 会撤掉消息区
      // 通知条，动作必须排在它之后才能留在屏上。已受理回合（用户气泡 / 部分回复 /
      // 历史记录都在）不重发，只由组合根提供直达平台编辑的入口。
      if (setupErrorClass) {
        deps.ui.onSetupRequired?.(setupErrorClass, setupProviderId);
      }
    } else if (msg.type === "notice") {
      // 截断提示（code:"truncated"）：不走 4 秒通知条——记在本代际上，done 收尾时
      // 渲染成 assistant 消息尾部的常驻徽标（文案由引擎给，宿主不复制一份）。
      if (msg.code === "truncated") {
        turnTruncatedNotice = String(msg.data || "");
      } else {
        deps.ui.showConversationContextNotice(msg.data, 4000);
      }
    } else if (msg.type === "tool-status") {
      const activityId = msg.callId || `${msg.tool || "web_search"}:${msg.query}`;
      if (msg.status === "searching") {
        activeToolCalls.add(activityId);
        clearStreamSlowNoticeTimer();
        deps.ui.removeConversationContextNotice();
      } else {
        activeToolCalls.delete(activityId);
        if (!activeToolCalls.size && activePort && !streamFirstTokenReceived) {
          armStreamSlowNoticeTimer();
        }
      }
      activeTurn?.applySearchStatus(msg);
    } else if (msg.type === "tool-turn") {
      // 工具轮持久化副本（spec §2.5）：缓存，done/stopped 时随一问一答写回。
      // 同一 user 回合内每个 tool-turn 累积（runToolLoop 多轮各吐一次）——
      // 整体替换会把多轮搜索的中间轮冲掉，回放重建只剩最后一轮。
      if (Array.isArray(msg.messages)) {
        pendingToolMessages.push(
          ...msg.messages.filter((m) => Boolean(m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string"))
        );
      }
    } else if (msg.type === "cost-guard") {
      // offscreen 发起 Map-Reduce 前弹成本护栏，等待确认后回执。确认通道经
      // deps 注入（缺省面板内确认弹层）；弹层是异步的，回执挂在 Promise 上，
      // 期间端口若已断开（用户停止/换片）则回执无接收方，丢弃。
      const confirmCostGuard = deps.confirmCostGuard || ((message: string) => confirmDialog({ message, confirmText: "继续" }));
      const replyPort = port;
      void Promise.resolve(confirmCostGuard(String(msg.data?.message || "预计会有多次调用，是否继续？"))).then((ok) => {
        try {
          replyPort?.postMessage({ action: "cost-guard-confirm", ok: Boolean(ok) });
        } catch {
          // 弹层挂起期间流已停止/重置，端口断开：回执无接收方
        }
      });
    }
  }

  // =========================================================================
  // sendTurn / runAcceptance — chat flow entry point
  // =========================================================================
  // 发送受理入口（唯一）：受理时序（空文本/在途早退、受理窗口开关、blocked 的
  // 终态结算）归 ./turn-lifecycle.ts；本文件的 runAcceptance 是受理体本体——
  // 从 provider 检查到 postMessage 的副作用链，逐字节保持原次序。
  async function sendTurn(text: string): Promise<SendVerdict> {
    messageArea.setRegenerationDisabled(true);
    const verdict = await turn.send(text);
    if (!turn.isActive()) {
      messageArea.setRegenerationDisabled(false);
    }
    return verdict;
  }

  function regenerateAssistant(historyIndex: number, node: HTMLDivElement): void {
    if (turn.isActive() || activeRegeneration || activeContinuation) {
      return;
    }
    const originalHistory = [...chatSessionState.chatHistory];
    if (originalHistory[historyIndex]?.role !== "assistant") {
      return;
    }
    let userIndex = historyIndex - 1;
    while (userIndex >= 0 && originalHistory[userIndex]?.role !== "user") {
      userIndex -= 1;
    }
    const prompt = userIndex >= 0 ? originalHistory[userIndex].content.trim() : "";
    if (!prompt) {
      return;
    }
    speech.stop();
    const regeneration = {
      originalHistory,
      userIndex,
      session: messageArea.beginRegeneration(node)
    };
    activeRegeneration = regeneration;
    messageArea.setRegenerationDisabled(true);
    void turn.send(prompt).then((verdict) => {
      if (verdict === "accepted" || activeRegeneration !== regeneration) {
        return;
      }
      regeneration.session.restore();
      activeRegeneration = null;
      messageArea.setRegenerationDisabled(false);
    });
  }

  function continueAssistant(historyIndex: number, node: HTMLDivElement): void {
    if (turn.isActive() || activeRegeneration || activeContinuation) {
      return;
    }
    const originalHistory = [...chatSessionState.chatHistory];
    const targetMessage = originalHistory[historyIndex];
    if (targetMessage?.role !== "assistant") {
      return;
    }
    let userIndex = historyIndex - 1;
    while (userIndex >= 0 && originalHistory[userIndex]?.role !== "user") {
      userIndex -= 1;
    }
    if (userIndex < 0) {
      return;
    }
    const userPrompt = originalHistory[userIndex]?.content?.trim() || "";
    if (!userPrompt) {
      return;
    }
    speech.stop();
    const hasBody = Boolean(targetMessage.content?.trim());
    const branch: "A" | "B" = hasBody ? "B" : "A";
    const initialRaw = hasBody ? targetMessage.content! : "";
    const initialThinking = targetMessage.thinking || "";
    const continuation = {
      originalHistory,
      userIndex,
      historyIndex,
      initialRaw,
      userPrompt,
      branch,
      session: messageArea.beginContinuation(node, {
        initialRaw,
        thinking: initialThinking
      })
    };
    activeContinuation = continuation;
    messageArea.setRegenerationDisabled(true);
    const sendPrompt = branch === "B" ? "继续" : userPrompt;
    void turn.send(sendPrompt).then((verdict) => {
      if (verdict === "accepted" || activeContinuation !== continuation) {
        return;
      }
      continuation.session.restore();
      activeContinuation = null;
      messageArea.setRegenerationDisabled(false);
    });
  }

  function exportAssistant(historyIndex: number, raw: string): void {
    const answerNumber = chatSessionState.chatHistory.slice(0, historyIndex + 1).filter((message) => (
      message.role === "assistant" && !(Array.isArray(message.tool_calls) && message.tool_calls.length && !String(message.content || "").trim())
    )).length || 1;
    const videoTitle = String(chatSessionState.currentConversationMeta?.contextTitle || chatSessionState.contextData?.title || "");
    const safeTitle = sanitizeFileName(videoTitle) || "BiliScript";
    const filename = `${safeTitle}-回答-${answerNumber}.md`;
    const blob = new Blob([raw], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // 受理体（turn.runAcceptance 的实现）：闸已由 turn 放行（受理窗口已开）才进入。
  // 未起流的 blocked 出口直接 return "blocked"——复位双发闸与兑现待决 settle 由
  // turn 统一负责（历史上这两条提前返回没有任何出口复位 sendInFlight，此后每次
  // 发送都被入口判 ignored 而静默发不出去）。首 token 之前的每一步（provider 检查、
  // 发送闸、上屏、附件消费、连端口）都在同一个 try 里——任意一步抛错都走用户可见
  // 的错误收口（与迁移前的 sendMessage 逐字一致）。
  async function runAcceptance(text: string): Promise<SendVerdict> {
    try {
      deps.ui.hideHistoryPopover();

      const providerId = deps.getProviderId();
      if (!providerId) {
        // 配置类拦截屏（票 03）：状态屏的文案与「前往设置」动作由组合根产出
        //（与无平台空态同源），这里只交标记。
        deps.ui.requestViewReset({ kind: "setup" });
        return "blocked";
      }

      const branched = activeRegeneration !== null || activeContinuation !== null;
      const inputSnapshot = deps.input.value;
      const imageSnapshot = branched ? null : deps.getInputImages?.() ?? null;
      const outcome = await deps.ensureCurrentContextForSend();
      // 取消、读取失败与空上下文拦截都不追加消息、不消费文本或图片快照。
      if (!outcome.pass) {
        return "blocked";
      }
      const currentMeta = chatSessionState.currentConversationMeta;
      // 发送前上下文失配守卫（GLOSSARY.md「拆除会话」词条出口五）：刻意只清身份
      // 两键（id/meta）——不清 chatHistory、不发断流（此点流式尚未发起，无断流
      // 可言；旧会话的消息史仍在视图中延续，仅会话身份随上下文键失配作废）。
      // 不收编进 store 的 detachCurrent 原语（它连带清历史）：本守卫只表达
      // 「身份作废」这一个意图，写纪律经 chat-state 的
      // clearConversationIdentity 原语（工单 arch-slim-2/07 D/E 半场裁定）。
      if (!currentMeta?.pinnedContext && currentMeta?.contextKey && currentMeta.contextKey !== chatSessionState.currentContextKey) {
        clearConversationIdentity();
      }

      deps.ui.removeCenteredState();
      deps.ui.removeSuggestions();

      const regeneration = activeRegeneration;
      const continuation = activeContinuation;
      // 授权在字幕闸通过后、用户气泡上屏前完成；视图销毁不是用户拒绝，直接取消回合。
      const optIn = await resolveWebSearchOptIn(chatSessionState.webSearchEnabled);
      if (optIn === "view-destroyed") {
        return "blocked";
      }
      const webSearchEnabled = optIn === "granted";
      let preserveSnapshotNotice = false;
      if (!regeneration && !continuation) {
        messageArea.appendUserMessage(text, { source: "live", images: imageSnapshot ?? [] });
        preserveSnapshotNotice = deps.input.value !== inputSnapshot;
        if (!preserveSnapshotNotice) {
          deps.input.value = "";
        }
        deps.ui.autosizeInput();
      }

      const branchRecord = regeneration || continuation;
      const images = branchRecord
        ? (branchRecord.originalHistory[branchRecord.userIndex]?.images ?? [])
        : imageSnapshot
          ? deps.takeInputImages?.(imageSnapshot) ?? []
          : deps.takeInputImages?.() ?? [];
      if (!branchRecord) {
        preserveSnapshotNotice ||= (deps.getInputImages?.().length ?? 0) > 0;
      }

      setStreamingUiState(true);
      activeUserPrompt = text;
      activeUserImages = images;
      activeTurnProviderId = providerId;
      pendingToolMessages = [];
      turnTruncatedNotice = "";
      if (!chatSessionState.currentConversationId) {
        ensureConversationId(generateConversationId());
      }
      activeConversationId = chatSessionState.currentConversationId;
      activeTurn = continuation?.session.turn ?? regeneration?.session.turn ?? messageArea.appendAssistantMessage({ source: "live" });
      activeToolCalls.clear();
      startStreamSlowNoticeTimer();
      if (preserveSnapshotNotice) {
        deps.ui.showConversationContextNotice("已发送原文，保留了后来修改的草稿与图片", 4000);
      }
      if (optIn === "declined") {
        deps.ui.showConversationContextNotice(SEARCH_OPT_IN_DECLINED_NOTICE, 4000, { placement: "input" });
      }
      streamFirstTokenReceived = false;

      // connectPort 现为 async（发送前先 ensure offscreen 文档，文档死亡后
      // 自愈重建）；await 兼容旧的同步返回 Port 的 deps 实现。
      const port = await deps.connectPort();
      activePort = port;

      port.onMessage.addListener((msg) => {
        if (activePort !== port) return;
        dispatchChatPortMessage(msg as ChatPortMessage, port);
      });

      port.onDisconnect.addListener(() => {
        if (activePort !== port) return;
        abortAllVideoFrames();
        activeTurn?.discard();
        activeToolCalls.clear();
        activePort = null;
        lastAckedContextKey = null;
        if (activeRegeneration) {
          activeRegeneration.session.restore();
          activeRegeneration = null;
          pendingToolMessages = [];
        }
        if (activeContinuation) {
          activeContinuation.session.restore();
          activeContinuation = null;
          pendingToolMessages = [];
        }
        clearStreamRuntimeState();
        setStreamingUiState(false);
        // 断连即回合终结（offscreen 文档被回收 / 会话关闭）：结算待决 settle——
        // 此后不再有终态到来，不兑现则历史项点击的 await 悬挂（settle 兜底红线）。
        // 收口语义（清哪些字段）保持原状：activeUserPrompt / activeTurn
        // 是既有行为，本处不动它们。
        turn.resolve();
      });

      // 候选5：字幕体省略传输——offscreen 已确认缓存当前上下文的字幕体
      //（lastAckedContextKey === contextKey）时本条消息不再重传整份 subtitleBody；
      // contextKey 始终携带，offscreen 据此校验单槽匹配并在缺失时报错触发重置。
      // 其余元数据/history/aiSystemPrompt 保持全量（体积小且每条都可能变）。
      const context = {
        ...chatSessionState.contextData,
        aiSystemPrompt: chatSessionState.aiPrefs.aiSystemPrompt
      };
      const contextKey = String(chatSessionState.currentContextKey || "").trim();
      if (contextKey && lastAckedContextKey === contextKey) {
        delete context.subtitleBody;
      }
      const videoFrameToolEnabled = await deps.canUseVideoFrameTool?.() === true;

      port.postMessage({
        action: "chat",
        providerId,
        // 选中模型（multi-model-catalog）：offscreen 解析平台后以它覆盖目录首项
        model: deps.getSelectedModel?.() || "",
        // 会话身份（平台会话头取值来源，见 shared/messaging-protocol.ts 与
        // ai/preset-headers.ts）：上面已物化，恒非空。
        conversationId: chatSessionState.currentConversationId,
        thinkingLevel: chatSessionState.aiThinkingLevel,
        // 联网搜索开关（spec §2.1）：全局记忆（chat header pill），offscreen 据此
        // 解析搜索配置并注入 tools。本条的取值为上面 opt-in 闸的产物：拒绝授权 /
        // 偏好已关时本条传 false（本轮不搜索），其余情况等于全局记忆。
        webSearchEnabled,
        ...(videoFrameToolEnabled ? { videoFrameToolEnabled: true } : {}),
        context,
        contextKey,
        prompt: text,
        // 图片输入（image-input 路线 B）：本轮用户消息的图片（content 侧已压缩成
        // WebP 的 ImagePart，经 port 结构化克隆到 offscreen 进请求体）；无图片时
        // 不带该字段——无图消息的线格式逐字节不变。
        ...(images.length ? { images } : {}),
        // 历史只走顶层 history（offscreen/ai 侧统一读 msg.history）；
        // 不再向 context 里塞 chatHistory 副本（无任何读取方的死负载）。
        history: continuation
          ? (continuation.branch === "B"
              ? [
                  ...continuation.originalHistory.slice(0, continuation.userIndex),
                  continuation.originalHistory[continuation.userIndex],
                  { role: "assistant", content: continuation.initialRaw }
                ]
              : continuation.originalHistory.slice(0, continuation.userIndex))
          : (regeneration
              ? regeneration.originalHistory.slice(0, regeneration.userIndex)
              : chatSessionState.chatHistory)
      });

      // 闸内登记的停流请求（settled 在端口就绪前收到，见 turn.stop）：端口已就绪、
      // chat 消息已发出，此处立刻补发 stop——本轮尽快走 stopped 终态落定（写回
      // partial 后 settle 兑现）。补发点必须排在 postMessage 之后：stop 早于 chat
      // 到达会被 offscreen 当无活动请求而空转，终态也就永不回来（turn-lifecycle
      // 把这条次序收在 flushDeferredStop 的唯一调用点上）。
      turn.flushDeferredStop();
    } catch (err) {
      // connectPort 失败（ensure offscreen 文档/建连抛错）无回退：UI 卡流式
      // 态而 isStreaming() 为 false（activePort 从未置位，但 setStreamingUiState
      // (true) 已调用）。这里恢复全部半置位流状态并走用户可见错误路径——
      // 与 showAssistantError 同款机制（endStream 收口六步 + .chat-msg-error 占位）。
      // 受理结论仍是 "accepted"：用户消息已 append、输入框已清，失败发生在受理
      // 之后（与旧 sendViaInputBox「看到空输入框判受理」的语义等价）。
      console.error("[chat-runtime] runAcceptance 失败：", err);
      const streamTurn = activeTurn;
      if (streamTurn) {
        showAssistantError(streamTurn, (err as Error)?.message || String(err));
      } else {
        // 失败发生在占位建立前（ensure/上下文阶段）：只复位流式 UI 与计时器。
        clearStreamRuntimeState();
        setStreamingUiState(false);
      }
      activeTurn = null;
      // 异常路径同样是回合终结：结算待决 settle（并撤下未兑现的停流登记与看门狗）。
      turn.resolve();
      return "accepted";
    }
    return "accepted";
  }


  // =========================================================================
  // endStream — 流生命周期收口（done / stopped / error 三条终态路径唯一实现）
  // =========================================================================
  // 收口时序（原步骤①取消挂起帧已内收至 finish / fail / stop 意图方法内部自动处理）：
  //   ① clearStreamRuntimeState          清慢响应计时器 / 上下文 notice；
  //   ② renderStep(streamTurn)           终态各自的 DOM / 持久化收尾（内部自动取消挂起帧）；
  //   ③ 断开并清空 activePort；
  //   ④ setStreamingUiState(false)；
  //   ⑤ deps.input.focus() + scrollToBottom()。
  // activeUserPrompt 在 ② 之后统一清空（② 内的写回判定还要读它）。
  function endStream(streamTurn: ChatAssistantTurn, renderStep: ((turn: ChatAssistantTurn) => void) | undefined): void {
    clearStreamRuntimeState();
    if (renderStep) {
      renderStep(streamTurn);
    }
    activeRegeneration = null;
    activeContinuation = null;
    activeUserPrompt = "";
    activeUserImages = [];
    activeTurnProviderId = "";
    activeToolCalls.clear();
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    setStreamingUiState(false);
    deps.input.focus();
    scrollToBottom();
    turn.resolve();
  }

  function getActiveAssistantHistoryIndex(): number {
    if (activeContinuation) {
      return activeContinuation.historyIndex;
    }
    if (activeRegeneration) {
      return activeRegeneration.userIndex + 1 + pendingToolMessages.length;
    }
    return chatSessionState.chatHistory.length + 1 + pendingToolMessages.length;
  }

  function commitAssistantTurn(
    raw: string,
    opts: { thinking?: string; stopped?: boolean } = {}
  ): boolean {
    const thinkingText = typeof opts.thinking === "string" && opts.thinking.trim() ? opts.thinking : undefined;
    const hasContent = Boolean(raw && raw.trim());
    const hasThinking = Boolean(thinkingText);
    const isStopped = Boolean(opts.stopped);

    const assistantMsg: ChatSessionMessage = {
      role: "assistant",
      content: raw || ""
    };
    if (hasThinking) {
      assistantMsg.thinking = thinkingText;
    }
    if (isStopped) {
      assistantMsg.stopped = true;
    }

    if (activeRegeneration) {
      if (!deps.store.isCurrent(activeConversationId)) {
        pendingToolMessages = [];
        return false;
      }
      if (isStopped && !hasContent && !hasThinking) {
        pendingToolMessages = [];
        return false;
      }
      const history = activeRegeneration.originalHistory.slice(0, activeRegeneration.userIndex + 1);
      history.push(...pendingToolMessages, assistantMsg);
      applyConversationIdentity({ history });
      void deps.store.persistCurrent();
      pendingToolMessages = [];
      return true;
    }

    if (activeContinuation) {
      if (!deps.store.isCurrent(activeConversationId)) {
        pendingToolMessages = [];
        return false;
      }
      if (isStopped && !hasContent && !hasThinking) {
        pendingToolMessages = [];
        return false;
      }
      const history = [...activeContinuation.originalHistory];
      history[activeContinuation.historyIndex] = assistantMsg;
      applyConversationIdentity({ history });
      void deps.store.persistCurrent();
      pendingToolMessages = [];
      return true;
    }

    if (activeUserPrompt && deps.store.isCurrent(activeConversationId)) {
      appendChatHistory(
        {
          role: "user",
          content: activeUserPrompt,
          ...(activeUserImages.length ? { images: activeUserImages } : {})
        },
        ...pendingToolMessages,
        assistantMsg
      );
      void deps.store.persistCurrent();
    }
    pendingToolMessages = [];
    return true;
  }

  function finalizeAssistant(streamTurn: ChatAssistantTurn | null): void {
    if (!streamTurn) {
      return;
    }
    endStream(streamTurn, (turn) => {
      const raw = turn.finish({
        userPrompt: activeContinuation?.userPrompt || activeUserPrompt,
        historyIndex: getActiveAssistantHistoryIndex()
      });
      const thinking = turn.getThinking?.();
      appendTruncatedBadge(turn);
      const committed = commitAssistantTurn(raw, { thinking });
      if (activeRegeneration) {
        if (committed) {
          activeRegeneration.session.commit();
        } else {
          activeRegeneration.session.restore();
        }
      }
      if (activeContinuation) {
        if (committed) {
          activeContinuation.session.commit();
        } else {
          activeContinuation.session.restore();
        }
      }
    });
  }

  function appendTruncatedBadge(turn: ChatAssistantTurn): void {
    if (!turnTruncatedNotice) {
      return;
    }
    turn.markTruncated(turnTruncatedNotice);
  }

  function showAssistantError(streamTurn: ChatAssistantTurn | null, error: unknown): void {
    if (!streamTurn) {
      return;
    }
    endStream(streamTurn, (turn) => {
      const message = `${error}${imageUnsupportedErrorHint(error, activeUserImages)}`;
      turn.fail(`错误：${message}`);
      if (activeRegeneration) {
        deps.ui.showConversationContextNotice(`重新生成失败：${message}`, 4000);
      }
      if (activeContinuation) {
        deps.ui.showConversationContextNotice(`继续生成失败：${message}`, 4000);
      }
    });
  }

  function handleAssistantStopped(streamTurn: ChatAssistantTurn | null, reason: string): void {
    if (!streamTurn) {
      return;
    }
    endStream(streamTurn, (turn) => {
      const { raw } = turn.stop(reason, {
        userPrompt: activeContinuation?.userPrompt || activeUserPrompt,
        historyIndex: getActiveAssistantHistoryIndex()
      });
      const thinking = turn.getThinking?.();
      const committed = commitAssistantTurn(raw, { thinking, stopped: true });
      if (activeRegeneration) {
        if (committed) {
          activeRegeneration.session.commit();
        } else {
          activeRegeneration.session.restore();
        }
      }
      if (activeContinuation) {
        if (committed) {
          activeContinuation.session.commit();
        } else {
          activeContinuation.session.restore();
        }
      }
    });
  }

  // =========================================================================
  // stopActiveStream / stopStreamNow
  // =========================================================================
  // 停流入口（停止按钮 / settled 的停流请求）：时序归 turn——端口在途即发停流，
  // 端口未建（闸 / opt-in 弹层 / connectPort 的 await 窗口）则登记「端口就绪即停」，
  // 受理体在 postMessage 之后经 turn.flushDeferredStop 补发。不登记即静默丢失，
  // settle 悬到整段流自然结束。
  function stopActiveStream(): void {
    if (!turn.isActive()) {
      return;
    }
    setStreamingUiState(true, { stopping: true });
    turn.stop();
  }

  // 停流动作本体（turn.stopStream 的实现）：只处理端口在途的一半；「端口未建怎么
  // 办」的判定在 turn（本函数被调用即已保证端口就绪）。
  function stopStreamNow(): void {
    if (!activePort) {
      return;
    }
    // 按钮终态（disabled + 「停止中...」）由 ui.setStreamingUiState 的 stopping
    // 分支统一负责，不再直写按钮——组合根是按钮态的唯一所有者。
    setStreamingUiState(true, { stopping: true });
    try {
      activePort.postMessage({ action: "stop" });
    } catch {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
  }

  // =========================================================================
  // startStreamSlowNoticeTimer
  // =========================================================================
  function clearStreamSlowNoticeTimer(): void {
    if (streamSlowNoticeTimer) {
      window.clearTimeout(streamSlowNoticeTimer);
      streamSlowNoticeTimer = 0;
    }
  }

  function armStreamSlowNoticeTimer(): void {
    clearStreamSlowNoticeTimer();
    streamSlowNoticeTimer = window.setTimeout(() => {
      if (!activePort || streamFirstTokenReceived || activeToolCalls.size > 0) {
        return;
      }
      deps.ui.showConversationContextNotice("模型响应较慢，可能正在思考，请稍候…", 0);
    }, STREAM_SLOW_NOTICE_MS);
  }

  function startStreamSlowNoticeTimer(): void {
    clearStreamRuntimeState();
    armStreamSlowNoticeTimer();
  }

  // =========================================================================
  // handleFirstStreamToken
  // =========================================================================
  // 首 token 语义：本代际首个流事件（token 或 reasoning——两者都算"模型开始
  // 输出"）到达时撤下慢响应提示（每代际一次）。一代际只清一次：
  // streamFirstTokenReceived 置 true 后不再重复执行；clearStreamRuntimeState
  // 不复位它（见下方注释），下一代的重新武装由受理体在发送前显式
  // streamFirstTokenReceived = false 完成。
  function handleFirstStreamToken(): void {
    if (streamFirstTokenReceived) {
      return;
    }
    streamFirstTokenReceived = true;
    clearStreamRuntimeState();
  }

  // =========================================================================
  // clearStreamRuntimeState
  // =========================================================================
  // 「本代际收尾」的清理原语：清慢响应计时器、撤上下文 notice。endStream /
  // port 断连 / resetStreamState 都调它。
  //
  // 注意：不复位 streamFirstTokenReceived——它是一代际标志，不是"计时器挂起"
  // 标志。此前在 clear 里复位造成两个错位：
  // 1. 「只清一次」失效——done/stopped/error 收尾后（clear 被调、标志被复位），
  //    同一节点上到达的收尾 reasoning/token 事件（竞态）会让
  //    handleFirstStreamToken 再次执行、撤下下一条消息的上下文 notice；
  // 2. 慢响应提示在发送时与最后一个工具终态重新武装，clear 只清计时器。
  function clearStreamRuntimeState(): void {
    clearStreamSlowNoticeTimer();
    deps.ui.removeConversationContextNotice();
  }

  // =========================================================================
  // isStreaming / hasPendingUserPrompt / isTurnActive / settleTurn /
  // resetStreamState — state queries and the reset entry point for sidepanel
  // (replaces direct reads of the old module-level variables)
  // =========================================================================
  function isStreaming(): boolean {
    return activePort !== null;
  }

  // 「在途回合」判据（C′）：唯一的语义查询由 turn.isActive() 给出（受理窗口 ∪
  // 流段）——覆盖「发送受理 → 回合落定」全程，包括 connectPort await 之前的窗口
  //（此时 activePort 尚未置位、activeUserPrompt 尚未置位，isStreaming() 为假）。
  // 调用点（组合根的在途守卫、图像输入闸、自动发送闸）一律只问这一条，不再手拼
  // sendInFlight / activePort / hasPendingUserPrompt。
  function isTurnActive(): boolean {
    return turn.isActive();
  }

  // 在途回合体面结算（C′：流式中点历史项 = 先停流落盘、再切换）：订阅与停流登记
  // 都在 turn.settled()（看门狗兜底、端口就绪补发、终态兑现同源）。
  function settleTurn(): Promise<void> {
    return turn.settled();
  }

  function hasPendingUserPrompt(): boolean {
    return activeUserPrompt !== "";
  }

  function stopSpeech(): void {
    speech.stop();
  }

  function resetStreamState(): void {
    speech.stop();
    abortAllVideoFrames();
    // 拆除清场：经回合意图 discard() 取消挂起渲染帧并释放流式累加器，
    // 避免向已脱离的旧节点渲染（首帧还会把新消息的思考节点当旧的移除）。
    // activeTurn 为 null 时没有在途回合，无帧可撤。
    activeTurn?.discard();
    activeRegeneration?.session.restore();
    activeRegeneration = null;
    activeContinuation?.session.restore();
    activeContinuation = null;
    pendingToolMessages = [];
    clearStreamRuntimeState();
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    activeTurn = null;
    activeUserPrompt = "";
    activeUserImages = [];
    activeTurnProviderId = "";
    activeToolCalls.clear();
    // 拆除类入口同样终结回合：复位受理窗口（resetStreamState 可能在 connectPort
    // await 窗口内被调——store reset / restartChat 路径；标志若不清，此后用户的
    // 新发送会被永久拦下），并兑现已武装的 settle（不留悬挂）。
    turn.discard();
  }

  // =========================================================================
  // handleChatPortMessage — 协议分派的公开测试入口
  // =========================================================================
  // 与受理体注册的 port.onMessage 监听器走同一份
  // dispatchChatPortMessage：协议消息对象进、DOM/状态变化出。测试以此喂
  // reasoning / token / stream-reset / done / stopped / error / notice /
  // cost-guard，无需触达任何内部渲染步骤函数。
  function handleChatPortMessage(msg: ChatPortMessage | null | undefined): void {
    dispatchChatPortMessage(msg, activePort);
  }

  // 返回面 12 键（sidepanel 消费的 11 个方法 + 1 个协议测试入口；联网
  // 搜索回放重建与消息区/回合句柄不再单列出口——回放经 messageArea 句柄表达顺序，
  // 节点装配形状只有渲染片一个主人）。内部步骤（handleFirstStreamToken /
  // clearStreamRuntimeState / startStreamSlowNoticeTimer / finalizeAssistant /
  // handleAssistantStopped / showAssistantError / 回合结算协议 / 全部 DOM 装配与
  // 选择器）不再外露，也不再解构渲染片的步骤函数。
  return {
    sendTurn,
    stopActiveStream,
    stopSpeech,
    setAutoScroll,
    scrollToBottom,
    isStreaming,
    isTurnActive,
    settleTurn,
    hasPendingUserPrompt,
    resetStreamState,
    handleChatPortMessage,
    messageArea
  };
}
