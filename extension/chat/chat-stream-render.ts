// extension/chat/chat-stream-render.ts — chat 消息 DOM 渲染/滚动/水合片
// 负责流式双容器增量渲染、思考节点、用户/助手消息装配、消息操作栏、
// 原位重新生成的可恢复 DOM 事务，以及自动滚动。
//
// ChatMessageArea 是消息区操作面：追加消息、清场、重新生成事务与按钮禁用。
// ChatAssistantTurn 是单条助手消息的操作面：token / 思考 / 流式重置 /
// 终态收尾 / 徽标 / 时间线卡。节点装配与选择器只留在本模块。
//
// 工厂闭包自持自动滚动、flush 帧调度与按节点隔离的 WeakMap 状态；
// 每个 createChatRuntime 实例调用一次，实例间互不共享。

import {
  createMarkdownStreamSession,
  hydrateMarkdownContent,
  renderMarkdownStripped,
  stripThinkBlocks,
  type MarkdownRenderOptions,
  type MarkdownStreamSession
} from "../ui/markdown.js";

const CHAT_MARKDOWN_OPTIONS: MarkdownRenderOptions = { dropHeadingAdjacentHr: true };

function createChevronSpan(className: string): HTMLSpanElement {
  const chevron = document.createElement("span");
  chevron.className = className;
  chevron.innerHTML = READING_CHEVRON_DOWN_ICON.trim();
  return chevron;
}
import { linkifyAssistantTimestamps, type TimestampNavDeps } from "../ui/timestamp-nav.js";
import { READING_CHEVRON_DOWN_ICON, READING_COPY_ICON, READING_DOWNLOAD_ICON, READING_PLAY_ICON, READING_RESET_ICON, READING_SPEAKER_ICON } from "../ui/reading-icons.js";

import { flashCopySuccess } from "../ui/copy-feedback.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "../ui/trigger-motion.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { formatClock } from "../shared/clock-text.js";
import { supportsTtsSpeech } from "../shared/runtime-capabilities.js";
import type { ImagePart } from "../ai/types.js";
import { createChatImageViewer, createChatImageViewButton } from "./chat-image-viewer.js";
import type { ChatToolStatusEvent } from "./protocol.js";
import { SEARCH_PREVIEW_MAX_CHARS, type ChatSearchSource, type HistorySearchTurn } from "./search-sources.js";

// chat-stream-render 消费的最窄 deps 面：messages 滚动容器 + 终态渲染与消息操作回调。
export interface ChatStreamRendererDeps {
  messages: HTMLElement;
  getTimestampNavDeps: () => TimestampNavDeps;
  smoothStream?: boolean;
  onRegenerate?: (historyIndex: number, node: HTMLDivElement) => void;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
  onExport?: (historyIndex: number, raw: string) => void;
  onSpeak?: (messageId: string, button: HTMLButtonElement, content: HTMLElement) => Promise<void> | void;
  onClear?: () => void;
  isRegenerationDisabled?: () => boolean;
  // 消息操作反馈（导出失败等）：由装配方接到对话 tab 自己的通知通道
  //（reader 侧 showConversationContextNotice），不借全局状态条——反馈留在对话上下文。
  onNotice?: (message: string) => void;
}

export type ChatMessageSource = "live" | "replay";

export interface ChatInPlaceSession {
  turn: ChatAssistantTurn;
  commit: () => void;
  restore: () => void;
}

export interface BeginInPlaceTurnOptions {
  mode: "replace" | "continue";
  initialRaw?: string;
  thinking?: string;
}

export interface ChatMessageArea {
  appendUserMessage: (text: string, opts?: { source?: ChatMessageSource; messageId?: string; images?: ImagePart[] }) => HTMLDivElement | void;
  appendAssistantMessage: (opts?: { source?: ChatMessageSource; runId?: string; messageId?: string }) => ChatAssistantTurn;
  beginInPlaceTurn: (node: HTMLDivElement, options: BeginInPlaceTurnOptions) => ChatInPlaceSession;
  setRegenerationDisabled: (disabled: boolean) => void;
  clearUncommittedFailedTurns?: () => void;
  closeImageViewer?: (opts?: { restoreFocus?: boolean }) => void;
  clear: () => void;
}

// 回合节点句柄：一个助手消息节点的操作面（状态机不再出现选择器与节点创建；
// 一代际的 token 缓冲、思考节点状态都由本句柄闭包持有）。
export interface ChatAssistantTurn {
  /** 助手消息节点元素 */
  node?: HTMLDivElement;
  /** 登记本回合字幕条数（供思维链自动补齐「读取字幕」前置步骤，不单独创建 DOM）。 */
  setSubtitleContextCount?: (count: number) => void;
  /** 灌入 token 增量（帧合批；未 flush 的增量同样进终态原文）。 */
  appendToken: (token: unknown) => void;
  /** 灌入思考增量；并入当前回合的思维链状态条。 */
  appendThinking: (text: unknown) => void;
  /** 获取本回合累积的思考文本。 */
  getThinking?: () => string;
  /** 重置流式（读流中断重试整体重放）：清已渲染容器 / 思维链状态条与累加器，内部自动取消挂起帧，光标归位。 */
  reset: () => void;
  /** 丢弃在途回合（拆除清场）：内部自动取消挂起渲染帧并释放累加器，不破坏已落定 DOM。 */
  discard: () => void;
  /** 收尾成终态形态（正文 + 操作行，自动折叠思维链为单行摘要；内部自动取消挂起帧）；返回本次渲染所用原文。 */
  finish: (opts?: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number }) => string;
  /** 挂错误占位（内部自动取消挂起帧；收口在途工具并展示错误文案与可选原位重试操作）。 */
  fail: (text: string, opts?: { onRetry?: () => void; searchStatus?: "failed" | "cancelled" }) => void;
  /** 挂停止态：内部自动取消挂起帧；有正文则收尾成形态 + 停止徽标，无正文保留已展开思维链或仅留徽标。 */
  stop: (reason: string, opts?: { userPrompt?: string; historyIndex?: number }) => { raw: string; body: boolean };
  /** 挂截断徽标（收尾之后追加，位置与停止徽标一致）。 */
  markTruncated: (text: string) => void;
  /** 工具 tool-status → 汇入本回合思维链状态条。 */
  applySearchStatus: (msg: ChatToolStatusEvent) => void;
  /** 回放：把该回合的静态检索步骤与来源合并/挂载进本节点思维链状态条。 */
  attachSearchTimelineCard: (turn: HistorySearchTurn) => void;
}

// 渲染片的具名返回面（工厂 createChatStreamRenderer 的返回类型）：字段名 = 函数名，
// 替代 15 元组位置面——扩展只需加字段，消费方按名字取件，不再靠调用两侧按位置
// lockstep 对齐。各字段是闭包内函数声明的签名（模块层取不到闭包的 typeof，故按签名
// 书写；返回处由本接口标注，签名漂移仍被 tsc 拦下）。命名与同域窄门面先例
// ConversationReplayRenderer（replay.ts）一致。
export interface ChatStreamRenderer {
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  setAutoScroll: (value: boolean) => void;
  messageArea: ChatMessageArea;
}

// 流式 token 累加器（按节点存放在 WeakMap）：pending = 未 flush 的增量帧，
// stableEl/tailEl 为双容器，session 为双容器 Markdown 渲染会话。
interface TokenStreamState {
  pending: string[];
  charQueue: string;
  stableEl: HTMLDivElement | null;
  tailEl: HTMLDivElement | null;
  cursor: HTMLSpanElement | null;
  session: MarkdownStreamSession | null;
}

// 思考文本的显示状态（全量文本缓冲 + 按节点隔离的滚动合帧 + 钉底标志）
interface ThinkingDisplayState {
  text: string;
  renderedText: string;
  // 挂起的滚动合帧 id（按节点隔离：0 = 无挂起帧）
  scrollFrame: number;
  // 思考盒钉底标志：用户上翻即停跟随，回到底部附近恢复（与外层消息容器同契约）
  pinned: boolean;
  // 上次程序性钉底写入后的 scrollTop / scrollHeight 读数：scroll 事件判定
  // 「是否用户上翻」的基准（见钉底监听注释）
  lastTop: number;
  syncedHeight: number;
}

/**
 * createChatStreamRenderer(deps) — chat 消息 DOM 渲染/滚动/水合的工厂。
 *
 * 由 createChatRuntime(deps) 在工厂体内调用一次；闭包状态（自动滚动标志 /
 * flush 帧调度 / 按节点 WeakMap）随实例隔离。返回面只含跨片消费的三件——
 * 两个句柄（消息区 / 回合节点，见 ChatMessageArea / ChatAssistantTurn）与
 * 滚动/自动滚动窄入口；collapseThinking / ensureStreamContainers /
 * freshTokenStreamState / getTokenStreamState / yieldToMain / createThinkingNode /
 * appendThinkingText / appendTokenToNode / renderAssistantMessage /
 * takeTurnSearchSources / clearSearchCard / buildSearchTimelineCard 仅本片内部
 * 消费，不外露。
 */
export function createChatStreamRenderer(deps: ChatStreamRendererDeps): ChatStreamRenderer {
  const imageViewer = createChatImageViewer();
  let nextMessageId = 0;

  // 自动滚动标志（原 sidepanel 模块级 shouldAutoScrollMessages，归位到本闭包）：
  // scroll 监听与恢复点经 setAutoScroll 写入，token flush / finalize /
  // error / stopped 的非强制滚动在此读取。
  let shouldAutoScrollMessages = true;
  // =========================================================================
  // scrollToBottom
  // =========================================================================
  // instant=true（流式 flush 每帧一次）：显式 behavior:"instant" 覆盖 CSS
  // scroll-behavior:smooth（reader-chat.css 对 .chat-messages 的设定），避免
  // 流式期间每帧都重启一次平滑滚动动画。注意不能用 behavior:"auto"——按
  // CSSOM View 规范它取 CSS scroll-behavior 值，CSS 是 smooth 时压不住。
  // 发送路径（消息区句柄的 live 装配强制滚底）同用
  // instant：CSS smooth 会启动动画扫过上一条长消息刚被 c-v 塌缩的块，估算
  // 占位高逐块弹回真实高（视口突跳），且动画目标固化于调用时刻、落后于
  // 弹高后的真实底部——终点距底被 scroll-sync 判定读到，会把自动跟随关死
  // （追问后流式不跟随的根因）。endStream 收尾仍直写 scrollTop：视图已在
  // 底部，finalize 重渲染的高度差由 clamp 吸收，无扫掠路径。
  function scrollToBottom(force = false, { instant = false }: { instant?: boolean } = {}): void {
    if (!force && !shouldAutoScrollMessages) {
      return;
    }
    const target = deps.messages.scrollHeight;
    if (instant && typeof deps.messages.scrollTo === "function") {
      deps.messages.scrollTo({ top: target, behavior: "instant" });
    } else {
      deps.messages.scrollTop = target;
    }
  }
  // =========================================================================
  // 消息区句柄的两处节点装配（appendUserMessage / appendAssistantMessage）
  // =========================================================================
  function appendUserMessageNode(text: string, source: ChatMessageSource, messageId?: string, images: ImagePart[] = []): HTMLDivElement {
    const node = document.createElement("div");
    node.className = "chat-msg chat-msg-user";
    node.setAttribute("data-message-id", messageId || `chat-message-${++nextMessageId}`);
    if (images.length) {
      const imageStrip = document.createElement("div");
      imageStrip.className = "chat-image-strip chat-msg-user-images";
      images.forEach((image) => {
        const item = document.createElement("div");
        item.className = "chat-image-item";
        item.appendChild(createChatImageViewButton(image, imageViewer, "已发送的图片"));
        imageStrip.appendChild(item);
      });
      node.appendChild(imageStrip);
    }
    const body = document.createElement("div");
    body.className = "chat-msg-user-body";
    body.textContent = text;
    node.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    actions.appendChild(createCopyButton("复制消息", () => text));
    node.appendChild(actions);
    deps.messages.appendChild(node);
    // 只有发送路径（live）接管自动滚动并强制滚底；回放（replay）静默追加。
    if (source === "live") {
      shouldAutoScrollMessages = true;
      // instant：见 scrollToBottom 注释——发送路径的平滑动画会扫过上一条
      // 长消息 c-v 塌缩后的估算块，弹高突跳且动画终点落后于真实底部。
      scrollToBottom(true, { instant: true });
    }
    return node;
  }

  // =========================================================================
  // appendAssistantMessageNode
  // =========================================================================

  // 流式尾部指示 = 三点脉冲（2026-10-06 用户决议，四形态对照后选定；替掉原先那块
  // 5×12 灰块）。三个点是光标的**子节点**：tail 每帧整体重写 innerHTML（flush 里的
  // `tailEl.innerHTML = …`），任何兄弟节点当场被清掉；只有随光标整体搬运的子节点
  // 能活过每帧重写——搬运点有两处，都搬的是同一个节点，形态不变：flush 每帧
  // `tailEl.appendChild(cursor)`、reset 的 `node.appendChild(cursor)`。
  function createStreamCursor(): HTMLSpanElement {
    const cursor = document.createElement("span");
    cursor.className = "chat-msg-cursor";
    for (let i = 0; i < 3; i += 1) {
      cursor.appendChild(document.createElement("i"));
    }
    return cursor;
  }

  function appendAssistantMessageNode(
    source: ChatMessageSource,
    runId?: string,
    messageId?: string
  ): HTMLDivElement {
    // 回放：终态直出形态（无流式豁免类、无光标）——与 live 收尾后的节点逐字
    // 同形（差流式类），正文等回合句柄 finish 填。回放不清场外的东西、不滚底。
    if (source === "replay") {
      const replayed = document.createElement("div");
      replayed.className = "chat-msg chat-msg-assistant";
      if (runId) replayed.setAttribute("data-run-id", runId);
      replayed.setAttribute("data-message-id", messageId || `chat-message-${++nextMessageId}`);
      deps.messages.appendChild(replayed);
      return replayed;
    }
    // 上一条消息的流式豁免（chat-msg-streaming）到此为止，回归历史消息的
    // content-visibility 跳过渲染待遇。切换刻意放在新消息上屏、强制滚底的
    // 同一时刻，且滚底走 instant（见 scrollToBottom 注释）：c-v 首次施加拿
    // 不到高度记忆（记忆只在持有 c-v 期间记录），视口外块塌缩到估算占位
    // 高——平滑动画扫过时逐块弹回真实高会让视口突跳、动画终点落后于真实
    // 底部；instant 一步落底，重估算在落底同帧被 clamp 吸收，零可见跳动。
    // 若在 endStream 切换，刚完成的消息会在静止状态下从真实高度突变回估
    // 算占位高，视口莫名上跳。
    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    const node = document.createElement("div");
    // chat-msg-streaming：流式期间豁免 content-visibility 跳过渲染（M13，
    // 见 reader-chat.css）——正在输出的消息需要准确的实时高度，滚动跟随
    // 才能落到真实底部。
    node.className = "chat-msg chat-msg-assistant chat-msg-streaming";
    if (runId) node.setAttribute("data-run-id", runId);
    node.setAttribute("data-message-id", messageId || `chat-message-${++nextMessageId}`);
    // 流式 token 累加器（原 dataset.raw）随占位节点初始化/重置，
    // 保证第二条消息不会串上上一条的流式文本。
    resetTokenStreamState(node);
    const cursor = createStreamCursor();
    const state = getTokenStreamState(node);
    state.cursor = cursor;
    node.appendChild(cursor);
    deps.messages.appendChild(node);
    shouldAutoScrollMessages = true;
    scrollToBottom(true, { instant: true });
    return node;
  }
  // =========================================================================
  // 思考文本流式缓冲与钉底滚动器（被 ThoughtChain 深度思考步骤消费）
  // =========================================================================
  const THINKING_ICON_SVG =
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2l1.84 4.96 4.96 1.84-4.96 1.84L12 18.8l-1.84-4.96L5.2 12l4.96-1.84L12 5.2z"/></svg>';

  const thinkingDisplayStates = new WeakMap<Element, ThinkingDisplayState>();
  const THINKING_NEAR_BOTTOM_PX = 24;

  function flushThinkingText(textNode: Element, state: ThinkingDisplayState): void {
    if (state.renderedText !== state.text) {
      textNode.textContent = state.text;
      state.renderedText = state.text;
    }
  }

  function flushThinkingTextNode(textNode: Element | null): void {
    if (!textNode) {
      return;
    }
    const state = thinkingDisplayStates.get(textNode);
    if (state) {
      flushThinkingText(textNode, state);
    }
  }

  function cancelThinkingTextFrame(textNode: Element | null): void {
    if (!textNode) {
      return;
    }
    const state = thinkingDisplayStates.get(textNode);
    if (state && state.scrollFrame) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(state.scrollFrame);
      } else {
        window.clearTimeout(state.scrollFrame);
      }
      state.scrollFrame = 0;
    }
  }

  function scheduleThinkingScroll(textNode: Element, state: ThinkingDisplayState): void {
    if (state.scrollFrame) {
      return;
    }
    const scroll = () => {
      state.scrollFrame = 0;
      flushThinkingText(textNode, state);
      if (state.pinned) {
        const height = textNode.scrollHeight;
        textNode.scrollTop = height;
        state.syncedHeight = height;
        state.lastTop = textNode.scrollTop;
      }
      scrollToBottom(false, { instant: true });
    };
    if (typeof window.requestAnimationFrame === "function") {
      state.scrollFrame = window.requestAnimationFrame(scroll);
    } else {
      state.scrollFrame = window.setTimeout(scroll, 16);
    }
  }

  function appendThinkingToTextNode(textNode: Element | null, text: unknown): void {
    if (!textNode) {
      return;
    }
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { text: "", renderedText: "", scrollFrame: 0, pinned: true, lastTop: 0, syncedHeight: 0 };
      thinkingDisplayStates.set(textNode, state);
      textNode.addEventListener("scroll", () => {
        const st = thinkingDisplayStates.get(textNode);
        if (!st) {
          return;
        }
        const top = textNode.scrollTop;
        if (top < st.lastTop) {
          st.pinned = false;
        } else if (top > st.lastTop || textNode.scrollHeight === st.syncedHeight) {
          st.pinned = top + textNode.clientHeight >= textNode.scrollHeight - THINKING_NEAR_BOTTOM_PX;
        }
        st.lastTop = top;
      });
    }
    state.text += String(text || "");
    scheduleThinkingScroll(textNode, state);
  }
  // =========================================================================
  // appendTokenToNode
  // =========================================================================
  // 流式渲染优化：流式过程中按帧做"稳定前缀 + 末块"增量 markdown 渲染。
  // 流式节点的 DOM 为两个堆叠的块级容器（.chat-stream-stable / .chat-stream-tail，
  // 无额外样式——markdown 输出本就是块级，与单容器渲染等价）：
  //   - stable：切点前已稳定的前缀块（splitMarkdownTail 按最后一个空行边界
  //     切分，且切点前围栏已闭合），只在增长时渲染一次；
  //   - tail：最后一个未完块（表格/列表单换行分块、未闭合围栏整段都在
  //     tail），每帧重渲染。
  // 长回复流式期间不再每帧全量 renderMarkdown + innerHTML 重建。光标 span
  // 每帧重接到 tail 尾部（tail 的 innerHTML 赋值会清掉它）。思考盒随正文
  // 首帧渲染折叠成「思考过程」行保留（见 collapseThinking），不再移除。
  //
  // 长任务分片：剥除/切分与两次 renderMarkdown + innerHTML 重建都计入本帧的
  // 同步工作，长 tail（未闭合围栏/超长表格）时是长任务。按 50ms 长任务预算
  // 切片：预算耗尽先让出主线程（scheduler.yield 优先，setTimeout 0 兜底），
  // 让浏览器处理挂起的输入与绘制后继续；flush 因此是 async，恢复点校验
  // tokenFlushEpoch 代际，流被取消/收口或有更新一帧启动时本帧作废。
  let tokenFlushFrame = 0;
  let tokenFlushEpoch = 0;

  // 长任务预算（50ms，浏览器长任务阈值）：流式 flush 的同步工作超过预算即让出
  const STREAM_FRAME_BUDGET_MS = 50;

  // 流式 token 累加器（原挂在 assistant 节点的 dataset.raw，每 token 全量
  // 拼接旧串，O(n²) 复制——全仓读取方仅同流的 flush / finalize / stopped）。
  // 现改为 WeakMap 按节点存放 { base, pending, stableText, stableCut, ... }：
  // append 推入 pending；flush 时把 pending 增量喂给剥除/切分游标（每帧正则只跑
  // 未定居尾 + 新增部分，O(帧间隔)，输出与 stripThinkBlocks/splitMarkdownTail
  // 全量逐字节一致），渲染后 text 收进 base、清空 pending，每帧拼接量与帧间隔成
  // 正比，总复制量 O(n)。stableText/stableCut 记录上次渲染过的稳定前缀，用于
  // 跳过未增长的 stable 重渲染（切点只增不减，切点不变即 stable 不变）。
  // finalize / stopped 从 base + pending 取全量原文。
  // 随占位节点初始化（回合句柄的 live 装配），跨消息天然隔离。
  const tokenStreamStates = new WeakMap<HTMLElement, TokenStreamState>();

  function freshTokenStreamState(): TokenStreamState {
    return {
      pending: [],
      charQueue: "",
      stableEl: null,
      tailEl: null,
      cursor: null,
      session: null
    };
  }

  function resetTokenStreamState(node: HTMLElement): void {
    tokenStreamStates.set(node, freshTokenStreamState());
  }

  function getTokenStreamState(node: HTMLElement): TokenStreamState {
    let state = tokenStreamStates.get(node);
    if (!state) {
      state = freshTokenStreamState();
      tokenStreamStates.set(node, state);
    }
    return state;
  }
  // 流式双容器与 Markdown 会话懒创建（首帧 flush 时挂上；finalize / stopped 的整体重渲染会
  // 自然清掉它们）
  function ensureStreamContainers(node: HTMLDivElement, state: TokenStreamState): void {
    if (state.stableEl && state.tailEl && state.session) {
      return;
    }
    const stableEl = document.createElement("div");
    stableEl.className = "chat-stream-stable markdown-body";
    const tailEl = document.createElement("div");
    tailEl.className = "chat-stream-tail markdown-body";
    node.appendChild(stableEl);
    node.appendChild(tailEl);
    state.stableEl = stableEl;
    state.tailEl = tailEl;
    state.session = createMarkdownStreamSession(stableEl, tailEl, {
      ...CHAT_MARKDOWN_OPTIONS,
      renderMarkdown: renderMarkdownStripped
    });
  }

  // 全量流式文本 = session.rawText + 未 flush 的 pending（不做清空，供 finalize/stopped 只读）
  function getStreamRaw(node: HTMLElement): string {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return "";
    }
    const sessionRaw = state.session ? state.session.rawText : "";
    return sessionRaw + state.pending.join("") + state.charQueue;
  }

  function cancelTokenFlush(): void {
    // 无条件推进代际：挂起在让出点的 flush（tokenFlushFrame 已清零）也要作废
    tokenFlushEpoch++;
    if (!tokenFlushFrame) {
      return;
    }
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(tokenFlushFrame);
    } else {
      window.clearTimeout(tokenFlushFrame);
    }
    tokenFlushFrame = 0;
  }

  // 让出主线程（break-up-long-tasks 模式）：scheduler.yield 优先（让浏览器
  // 处理输入/绘制且延续保持任务调度），Scheduler API 不存在（Safari 等旧
  // 浏览器）时 setTimeout(0) 兜底。
  function yieldToMain(): Promise<void> {
    const scheduler = (window as Window & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler && typeof scheduler.yield === "function") {
      return scheduler.yield();
    }
    return new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  function scheduleTokenFlush(node: HTMLDivElement): void {
    if (tokenFlushFrame) {
      return;
    }
    const runFlush = () => {
      flush(node).catch((err: unknown) => {
        console.error("[chat-runtime] 流式渲染 flush 失败：", err);
      });
    };
    if (typeof window.requestAnimationFrame === "function") {
      tokenFlushFrame = window.requestAnimationFrame(runFlush);
    } else {
      tokenFlushFrame = window.setTimeout(runFlush, 16);
    }
  }

  const flush = async (node: HTMLDivElement) => {
    tokenFlushFrame = 0;
    const epoch = ++tokenFlushEpoch;
    const state = getTokenStreamState(node);
    let delta: string;
    let smoothStep = 0;
    if (deps.smoothStream) {
      const qLen = state.charQueue.length;
      if (qLen === 0) {
        return;
      }
      // 自适应插值步长：低积压时每帧 2 字符匀速打字；突发积压时自适应加速，将延迟收敛在 5~6 帧 (~100ms) 内
      smoothStep = Math.min(qLen, Math.max(2, Math.ceil(qLen / 5)));
      delta = state.charQueue.slice(0, smoothStep);
    } else {
      delta = state.pending.join("");
    }
    // 50ms 长任务预算：长 tail 或图表解析可能超出单帧预算，超出即让出主线程。
    let deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
    ensureStreamContainers(node, state);
    // 正文首帧渲染 = 思考流结束：冻结在途思考耗时并自动折叠思维链为单行摘要。
    collapseThoughtChainOnBodyStart(node);
    // 文本与游标状态原子提交：在让出前先喂入 session 并消耗队列
    if (deps.smoothStream) {
      state.charQueue = state.charQueue.slice(smoothStep);
    } else {
      state.pending.length = 0;
    }
    const sessionRes = state.session!.flush(delta, {
      cursor: state.cursor,
      shouldYield: () => performance.now() >= deadline,
      yieldToMain: async () => {
        await yieldToMain();
        deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
      },
      isStale: () => epoch !== tokenFlushEpoch
    });
    if (sessionRes && typeof sessionRes.then === "function") {
      await sessionRes;
    }
    if (epoch !== tokenFlushEpoch) {
      return;
    }
    // 流式帧滚动瞬时化（见 scrollToBottom instant 分支：不逐帧重启 CSS
    // 平滑滚动动画）
    scrollToBottom(false, { instant: true });
    // 插值队列续帧：若 charQueue 中仍有残余字符且当前流代际未作废，继续调度下一帧平滑释放
    if (deps.smoothStream && state.charQueue.length > 0 && epoch === tokenFlushEpoch) {
      scheduleTokenFlush(node);
    }
  };

  function appendTokenToNode(node: HTMLDivElement | null, token: unknown): void {
    if (!node) {
      return;
    }
    const tokenStr = String(token || "");
    const state = getTokenStreamState(node);
    if (deps.smoothStream) {
      state.charQueue += tokenStr;
    } else {
      state.pending.push(tokenStr);
    }
    scheduleTokenFlush(node);
  }
  // =========================================================================
  // 统一可折叠思维链状态条（ThoughtChain）
  // =========================================================================
  // 将「读取字幕 → 采样关键帧 → 联网检索 → 深度思考」统一收口在助手消息顶部
  // 的单一可折叠状态条内：
  //   - 流式期默认展开（限高内滚），头部按钮全程可点击手动收起/展开；
  //   - 正文首帧 / 生成完成后自动折叠为紧凑单行摘要（如「已思考 4.2s · 参考 3 处字幕」）；
  //   - 状态按 assistant 节点隔离（WeakMap），跨消息天然隔离，stream-reset 整条清除重放。

  type ThoughtStatus = "searching" | "done" | "failed" | "cancelled";
  type ThoughtStepKind = "read_subtitles" | "capture_video_frame_at_time" | "web_search" | "thinking";

  interface ThoughtStepState {
    row: HTMLElement;
    callId?: string;
    kind: ThoughtStepKind;
    status: ThoughtStatus;
    titleEl: HTMLElement;
    detailEl: HTMLElement;
    noteEl: HTMLElement;
    bodyEl: HTMLElement;
    frameCount: number;
    expectedFrameCount: number;
    resultCount?: number;
    startTime?: number;
    elapsedMs?: number;
    implicit?: boolean;
  }

  interface ThoughtChainState {
    root: HTMLDivElement;
    headBtn: HTMLButtonElement;
    summaryEl: HTMLElement;
    stepsEl: HTMLElement;
    innerEl: HTMLElement;
    announcerEl: HTMLElement;
    steps: ThoughtStepState[];
    sourcesWrap: HTMLElement | null;
    sources: ChatSearchSource[];
    status: ThoughtStatus;
    collapsed: boolean;
    userToggled: boolean;
    stoppedWithoutBody: boolean;
    citedSubtitleCount: number;
    activeThinkingStep: ThoughtStepState | null;
    thinkingElapsedMs: number | null;
  }

  const thoughtChainStates = new WeakMap<HTMLElement, ThoughtChainState>();
  const subtitleContextCounts = new WeakMap<HTMLElement, number>();
  const settledSearchTurns = new WeakSet<HTMLElement>();

  function resolveToolKind(msg: ChatToolStatusEvent): Exclude<ThoughtStepKind, "thinking"> {
    if (msg.tool === "read_subtitles") {
      return "read_subtitles";
    }
    if (msg.tool === "capture_video_frame_at_time") {
      return "capture_video_frame_at_time";
    }
    return "web_search";
  }

  function formatVideoFrameTime(seconds: unknown): string {
    const formatted = formatClock(seconds, { hours: "auto" });
    return formatted.includes(":") && formatted.split(":").length === 2
      ? formatted.padStart(5, "0")
      : formatted;
  }

  function formatThinkingSeconds(elapsedMs: number): string {
    const clampedMs = Math.max(100, elapsedMs);
    return (clampedMs / 1000).toFixed(1);
  }

  function stepTitleByKind(kind: ThoughtStepKind): string {
    if (kind === "read_subtitles") return "读取字幕";
    if (kind === "capture_video_frame_at_time") return "采样关键帧";
    if (kind === "web_search") return "联网检索";
    return "深度思考";
  }

  // 预览不随滚动重定位；滚动即收走，Esc 收起当前预览。
  deps.messages.addEventListener("scroll", () => hideSourcePreview(deps.messages), { passive: true });
  deps.messages.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !deps.messages.querySelector("[data-chat-search-preview]")) {
      return;
    }
    hideSourcePreview(deps.messages);
    event.preventDefault();
    event.stopPropagation();
  });

  // 新标签打开 URL（来源列表行 / 内联引用共用的收口；url 非法时静默忽略）。
  function openSourceUrl(url: string): void {
    const target = String(url || "").trim();
    if (!target || !/^https?:\/\//i.test(target)) {
      return;
    }
    window.open(target, "_blank", "noopener");
  }

  // 预览坐标使用消息区内容坐标；底部空间不足时翻到锚点上方，并钳制在视口内。
  function showSourcePreview(container: HTMLElement, anchor: Element, source: ChatSearchSource): void {
    hideSourcePreview(container);
    let domain = "";
    try {
      domain = new URL(source.url).hostname;
    } catch {
      domain = "";
    }
    const card = document.createElement("div");
    card.className = "chat-search-preview";
    card.setAttribute("data-chat-search-preview", "");
    const title = document.createElement("div");
    title.className = "chat-search-preview-title";
    title.textContent = source.title || source.url;
    const host = document.createElement("div");
    host.className = "chat-search-preview-host";
    host.textContent = domain || source.url;
    const excerpt = document.createElement("div");
    excerpt.className = "chat-search-preview-excerpt";
    excerpt.textContent = String(source.snippet || "").slice(0, SEARCH_PREVIEW_MAX_CHARS);
    card.append(title, host);
    if (excerpt.textContent) {
      card.appendChild(excerpt);
    }
    container.appendChild(card);
    const anchorRect = anchor.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const minLeft = container.scrollLeft + 4;
    const left = Math.min(
      Math.max(anchorRect.left - boxRect.left + container.scrollLeft - 40, minLeft),
      Math.max(container.scrollLeft + boxRect.width - cardRect.width - 4, minLeft)
    );
    const belowTop = anchorRect.bottom - boxRect.top + container.scrollTop + 6;
    const aboveTop = anchorRect.top - boxRect.top + container.scrollTop - cardRect.height - 6;
    const belowFits = anchorRect.bottom + 6 + cardRect.height <= boxRect.bottom;
    const aboveFits = anchorRect.top - 6 - cardRect.height >= boxRect.top;
    const preferAbove = !belowFits && (aboveFits || anchorRect.top - boxRect.top > boxRect.bottom - anchorRect.bottom);
    const minTop = container.scrollTop + 4;
    const viewportHeight = container.clientHeight || boxRect.height;
    const maxTop = Math.max(container.scrollTop + viewportHeight - cardRect.height - 4, minTop);
    const top = Math.min(Math.max(preferAbove ? aboveTop : belowTop, minTop), maxTop);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    animateTriggerEnter({
      target: card,
      trigger: anchor,
      fallbackOrigin: preferAbove ? "bottom left" : "top left",
      fromScale: 0.94,
      durationMs: 150
    });
  }

  function hideSourcePreview(container: HTMLElement): void {
    container.querySelectorAll<HTMLElement>("[data-chat-search-preview]").forEach((el) => {
      if (el.hasAttribute("data-biliscript-closing")) {
        cancelTriggerExit(el);
        return;
      }
      animateTriggerExit({
        target: el,
        fallbackOrigin: "top left",
        toScale: 0.96,
        durationMs: 110,
        onFinish: () => el.remove()
      });
    });
  }

  function bindSourcePreview(anchor: HTMLElement, source: ChatSearchSource): void {
    anchor.addEventListener("mouseenter", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("mouseleave", () => hideSourcePreview(deps.messages));
    anchor.addEventListener("focus", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("blur", () => hideSourcePreview(deps.messages));
  }

  function setThoughtChainCollapsed(chain: ThoughtChainState, collapsed: boolean): void {
    chain.collapsed = collapsed;
    chain.root.classList.toggle("chat-thought-chain-collapsed", collapsed);
    chain.root.classList.toggle("chat-thinking-collapsed", collapsed);
    chain.headBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function buildThoughtChainShell(opts: { collapsed?: boolean } = {}): ThoughtChainState {
    const collapsed = Boolean(opts.collapsed);
    const root = document.createElement("div");
    root.className = [
      "chat-thought-chain",
      "chat-thinking",
      "chat-thinking-collapsible",
      ...(collapsed ? ["chat-thought-chain-collapsed", "chat-thinking-collapsed"] : [])
    ].join(" ");
    root.dataset.status = "searching";

    const headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "chat-thought-chain-head chat-thinking-label";
    headBtn.disabled = false;
    headBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");

    const icon = document.createElement("span");
    icon.className = "chat-thought-chain-icon chat-thinking-icon";
    icon.innerHTML = THINKING_ICON_SVG;

    const summaryEl = document.createElement("span");
    summaryEl.className = "chat-thought-chain-summary chat-thinking-label-text";
    summaryEl.textContent = "思考过程";

    headBtn.append(icon, summaryEl, createChevronSpan("chat-thought-chain-chevron chat-thinking-chevron"));

    const body = document.createElement("div");
    body.className = "chat-thought-chain-body";
    const innerEl = document.createElement("div");
    innerEl.className = "chat-thought-chain-inner";
    const stepsEl = document.createElement("div");
    stepsEl.className = "chat-thought-chain-steps";
    innerEl.appendChild(stepsEl);
    body.appendChild(innerEl);

    const announcerEl = document.createElement("div");
    announcerEl.className = "chat-search-announcer";
    announcerEl.setAttribute("role", "status");
    announcerEl.setAttribute("aria-live", "polite");
    announcerEl.setAttribute("aria-atomic", "true");

    root.append(headBtn, body, announcerEl);

    const chain: ThoughtChainState = {
      root,
      headBtn,
      summaryEl,
      stepsEl,
      innerEl,
      announcerEl,
      steps: [],
      sourcesWrap: null,
      sources: [],
      status: "searching",
      collapsed,
      userToggled: false,
      stoppedWithoutBody: false,
      citedSubtitleCount: 0,
      activeThinkingStep: null,
      thinkingElapsedMs: null
    };

    headBtn.addEventListener("click", () => {
      chain.userToggled = true;
      setThoughtChainCollapsed(chain, !chain.collapsed);
    });

    return chain;
  }

  function createThoughtStep(
    kind: ThoughtStepKind,
    detail: string,
    noteText: string,
    status: ThoughtStatus,
    opts: { callId?: string; implicit?: boolean; thinkingText?: string } = {}
  ): ThoughtStepState {
    const row = document.createElement("div");
    row.className = [
      "chat-thought-step",
      status === "searching"
        ? "is-running"
        : status === "failed"
          ? "is-failed"
          : status === "cancelled"
            ? "is-cancelled"
            : "is-done"
    ].join(" ");
    row.dataset.stepKind = kind;

    const dot = document.createElement("span");
    dot.className = "chat-thought-step-dot";

    const main = document.createElement("div");
    main.className = "chat-thought-step-main";

    const line = document.createElement("div");
    line.className = "chat-thought-step-row";

    const titleEl = document.createElement("span");
    titleEl.className = "chat-thought-step-title";
    titleEl.textContent = stepTitleByKind(kind);

    const detailEl = document.createElement("span");
    detailEl.className = "chat-thought-step-detail";
    detailEl.textContent = detail;

    const noteEl = document.createElement("span");
    noteEl.className = "chat-thought-step-meta";
    noteEl.textContent = noteText;

    line.append(titleEl, detailEl, noteEl);
    main.appendChild(line);

    const bodyEl = document.createElement("div");
    if (kind === "thinking") {
      bodyEl.className = "chat-thinking-text";
      if (opts.thinkingText) {
        bodyEl.textContent = opts.thinkingText;
      }
      main.appendChild(bodyEl);
    } else {
      bodyEl.className = "chat-thought-step-body";
      main.appendChild(bodyEl);
    }

    row.append(dot, main);

    return {
      row,
      callId: opts.callId,
      kind,
      status,
      titleEl,
      detailEl,
      noteEl,
      bodyEl,
      frameCount: 0,
      expectedFrameCount: 3,
      implicit: opts.implicit
    };
  }

  function applyStepStatus(step: ThoughtStepState, status: ThoughtStatus, noteText: string): void {
    step.status = status;
    step.row.classList.remove("is-running", "is-done", "is-failed", "is-cancelled");
    step.row.classList.add(
      status === "searching"
        ? "is-running"
        : status === "failed"
          ? "is-failed"
          : status === "cancelled"
            ? "is-cancelled"
            : "is-done"
    );
    step.noteEl.textContent = noteText;
  }

  function ensureImplicitSubtitleStep(node: HTMLElement, chain: ThoughtChainState, incomingKind: ThoughtStepKind): void {
    if (incomingKind === "read_subtitles") {
      return;
    }
    const subtitleCount = subtitleContextCounts.get(node) ?? 0;
    if (subtitleCount <= 0) {
      return;
    }
    if (chain.steps.some((step) => step.kind === "read_subtitles")) {
      return;
    }
    const step = createThoughtStep("read_subtitles", `共 ${subtitleCount} 条字幕`, "已完成", "done", { implicit: true });
    chain.steps.unshift(step);
    chain.stepsEl.prepend(step.row);
  }

  function ensureThoughtChain(node: HTMLDivElement, opts: { collapsed?: boolean } = {}): ThoughtChainState {
    let chain = thoughtChainStates.get(node);
    if (!chain) {
      chain = buildThoughtChainShell({ collapsed: opts.collapsed ?? false });
      thoughtChainStates.set(node, chain);
      node.prepend(chain.root);
    } else if (!chain.root.parentNode) {
      node.prepend(chain.root);
    }
    return chain;
  }

  function syncThoughtChainStatus(chain: ThoughtChainState): void {
    const running = chain.steps.filter((step) => step.status === "searching");
    if (running.length > 0) {
      chain.status = "searching";
    } else if (chain.steps.some((step) => step.status === "failed")) {
      chain.status = "failed";
    } else if (chain.steps.length > 0 && chain.steps.every((step) => step.status === "cancelled")) {
      chain.status = "cancelled";
    } else if (chain.steps.some((step) => step.status === "cancelled") && !chain.steps.some((step) => step.kind === "thinking" && step.status === "done")) {
      const lastStep = chain.steps[chain.steps.length - 1];
      chain.status = lastStep?.status ?? "done";
    } else {
      chain.status = "done";
    }
    chain.root.dataset.status = chain.status;
  }

  function updateThoughtChainHeader(chain: ThoughtChainState): void {
    syncThoughtChainStatus(chain);
    const running = chain.steps.filter((step) => step.status === "searching");
    if (running.length > 0) {
      const current = running[running.length - 1];
      const detail = current.detailEl.textContent?.trim() || "";
      if (current.kind === "read_subtitles") {
        chain.summaryEl.textContent = detail ? `读取字幕 · ${detail}…` : "读取字幕中…";
      } else if (current.kind === "capture_video_frame_at_time") {
        chain.summaryEl.textContent = detail ? `采样关键帧 · ${detail}…` : "采样关键帧中…";
      } else if (current.kind === "web_search") {
        chain.summaryEl.textContent = detail ? `联网检索 · ${detail}…` : "联网检索中…";
      } else {
        chain.summaryEl.textContent = "深度思考中…";
      }
      return;
    }

    if (chain.stoppedWithoutBody) {
      chain.summaryEl.textContent = "已停止";
      return;
    }

    const parts: string[] = [];
    const hasThinking = chain.steps.some((step) => step.kind === "thinking");
    if (hasThinking) {
      if (chain.thinkingElapsedMs !== null) {
        const secs = formatThinkingSeconds(chain.thinkingElapsedMs);
        parts.push(`已思考 <span class="chat-thinking-duration-num">${secs}</span>s`);
      } else {
        parts.push("思考过程");
      }
    }

    const frameSteps = chain.steps.filter((step) => step.kind === "capture_video_frame_at_time");
    if (frameSteps.length > 0) {
      const totalFrames = frameSteps.reduce((sum, step) => sum + step.frameCount, 0);
      if (totalFrames > 0) {
        parts.push(`采样 ${totalFrames} 张画面`);
      } else if (frameSteps.some((step) => step.status === "failed")) {
        parts.push("未取到画面");
      } else if (frameSteps.some((step) => step.status === "cancelled")) {
        parts.push("已取消");
      }
    }

    const searchSteps = chain.steps.filter((step) => step.kind === "web_search");
    if (searchSteps.length > 0) {
      if (chain.sources.length > 0) {
        parts.push(`联网检索 ${chain.sources.length} 条`);
      } else if (searchSteps.some((step) => step.status === "failed")) {
        parts.push("搜索失败");
      } else if (searchSteps.some((step) => step.status === "cancelled")) {
        parts.push("已取消");
      } else {
        parts.push("联网检索 0 条");
      }
    }

    const explicitSubtitleSteps = chain.steps.filter((step) => step.kind === "read_subtitles" && !step.implicit);
    if (chain.citedSubtitleCount > 0) {
      parts.push(`参考 ${chain.citedSubtitleCount} 处字幕`);
    } else if (explicitSubtitleSteps.length > 0) {
      const doneCount = explicitSubtitleSteps.reduce((sum, step) => sum + (step.resultCount ?? 0), 0);
      if (doneCount > 0) {
        parts.push(`参考 ${doneCount} 处字幕`);
      } else if (explicitSubtitleSteps.some((step) => step.status === "failed")) {
        parts.push("字幕读取失败");
      } else if (explicitSubtitleSteps.some((step) => step.status === "cancelled")) {
        parts.push("已取消");
      } else if (parts.length === 0) {
        parts.push("已读取字幕");
      }
    }

    if (parts.length === 0) {
      chain.summaryEl.textContent = "思考过程";
    } else if (hasThinking && chain.thinkingElapsedMs !== null) {
      chain.summaryEl.innerHTML = parts.join(" · ");
    } else {
      chain.summaryEl.textContent = parts.join(" · ");
    }
  }

  function settleThoughtChainThinking(chain: ThoughtChainState, opts: { stopped?: boolean } = {}): void {
    let settledAny = false;
    for (const step of chain.steps) {
      if (step.kind !== "thinking") {
        continue;
      }
      flushThinkingTextNode(step.bodyEl);
      if (step.status === "searching") {
        settledAny = true;
        if (opts.stopped) {
          applyStepStatus(step, "cancelled", "已停止");
        } else {
          const elapsed =
            typeof step.startTime === "number" ? Math.max(0, Date.now() - step.startTime) : 0;
          step.elapsedMs = elapsed;
          chain.thinkingElapsedMs = (chain.thinkingElapsedMs ?? 0) + elapsed;
          applyStepStatus(step, "done", `${formatThinkingSeconds(elapsed)}s`);
        }
      }
    }
    chain.activeThinkingStep = null;
    if (settledAny) {
      updateThoughtChainHeader(chain);
    }
  }

  function collapseThoughtChainOnBodyStart(node: HTMLDivElement): void {
    const chain = thoughtChainStates.get(node);
    if (!chain) {
      return;
    }
    const hadRunningThinking = chain.steps.some((step) => step.kind === "thinking" && step.status === "searching");
    if (!hadRunningThinking) {
      return;
    }
    settleThoughtChainThinking(chain);
    if (!chain.steps.some((step) => step.status === "searching")) {
      setThoughtChainCollapsed(chain, true);
    }
  }

  function appendThinkingStepToNode(node: HTMLDivElement | null, text: unknown, forceNewStep: boolean): ThoughtStepState | null {
    if (!node) {
      return null;
    }
    const chain = ensureThoughtChain(node, { collapsed: false });
    ensureImplicitSubtitleStep(node, chain, "thinking");
    let step = forceNewStep ? null : chain.activeThinkingStep;
    if (!step) {
      step = createThoughtStep("thinking", "", "思考中…", "searching");
      step.startTime = Date.now();
      chain.steps.push(step);
      chain.stepsEl.appendChild(step.row);
      chain.activeThinkingStep = step;
      if (!chain.userToggled) {
        setThoughtChainCollapsed(chain, false);
      }
      updateThoughtChainHeader(chain);
    }
    appendThinkingToTextNode(step.bodyEl, text);
    return step;
  }

  function announceToolTerminal(
    chain: ThoughtChainState,
    step: ThoughtStepState,
    status: Exclude<ThoughtStatus, "searching">
  ): void {
    const isFrame = step.kind === "capture_video_frame_at_time";
    const isSubtitle = step.kind === "read_subtitles";
    const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
    const text = status === "done"
      ? isFrame
        ? `已获取 ${step.frameCount} 张画面${missing ? `，缺失 ${missing} 张` : ""}`
        : isSubtitle
          ? typeof step.resultCount === "number" ? `已读取 ${step.resultCount} 处字幕` : "字幕读取完成"
          : `搜索完成，共 ${chain.sources.length} 条来源`
      : status === "failed"
        ? isFrame
          ? "未取到画面，已按文字继续"
          : isSubtitle
            ? "字幕读取失败"
            : "搜索失败"
        : isFrame
          ? "画面截取已取消"
          : isSubtitle
            ? "字幕读取已取消"
            : "搜索已取消";
    chain.announcerEl.setAttribute("role", status === "failed" ? "alert" : "status");
    chain.announcerEl.setAttribute("aria-live", status === "failed" ? "assertive" : "polite");
    chain.announcerEl.textContent = text;
  }

  function appendSourceList(
    chain: ThoughtChainState,
    sources: ChatSearchSource[],
    opts: { paid?: boolean; notice?: string } = {}
  ): void {
    if (!sources.length && !opts.notice) {
      return;
    }
    if (!chain.sourcesWrap) {
      chain.sourcesWrap = document.createElement("div");
      chain.sourcesWrap.className = "chat-search-sources";
      chain.sourcesWrap.addEventListener("scroll", () => hideSourcePreview(deps.messages), { passive: true });
      chain.innerEl.appendChild(chain.sourcesWrap);
    }
    if (opts.notice && !chain.sourcesWrap.querySelector(".chat-search-sources-notice")) {
      const notice = document.createElement("div");
      notice.className = "chat-search-sources-notice";
      notice.textContent = opts.notice;
      chain.sourcesWrap.appendChild(notice);
    }
    for (const source of sources) {
      const index = chain.sources.length + 1;
      const marked = opts.paid ? ({ ...source, paid: true } as ChatSearchSource) : source;
      chain.sources.push(marked);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-search-source-row";
      row.setAttribute("title", source.url || source.title);
      const idx = document.createElement("span");
      idx.className = "chat-search-source-idx";
      idx.textContent = String(index);
      const title = document.createElement("span");
      title.className = "chat-search-source-title";
      title.textContent = source.title || source.url;
      row.append(idx, title);
      if (marked.paid) {
        const badge = document.createElement("span");
        badge.className = "chat-search-source-paid";
        badge.textContent = "付费";
        row.appendChild(badge);
      }
      row.addEventListener("click", () => {
        openSourceUrl(source.url);
      });
      bindSourcePreview(row, source);
      chain.sourcesWrap.appendChild(row);
    }
  }

  function appendVideoFrameList(step: ThoughtStepState, msg: ChatToolStatusEvent): void {
    const frames = Array.isArray(msg.frames) ? msg.frames.slice(0, 3) : [];
    step.frameCount = typeof msg.resultCount === "number" ? msg.resultCount : frames.length;
    step.expectedFrameCount = msg.expectedCount ?? 3;
    if (!frames.length) {
      return;
    }
    const list = document.createElement("div");
    list.className = "chat-video-frame-results";
    step.bodyEl.appendChild(list);
    for (const frame of frames) {
      const time = formatVideoFrameTime(frame.currentTime);
      const item = document.createElement("div");
      item.className = "chat-video-frame-item";
      const button = createChatImageViewButton(frame.image, imageViewer, `视频在 ${time} 的实际画面`);
      button.setAttribute("aria-label", `查看 ${time} 的实际画面`);
      button.title = `查看 ${time} 的实际画面`;
      const caption = document.createElement("span");
      caption.className = "chat-video-frame-time";
      caption.textContent = time;
      item.append(button, caption);
      list.appendChild(item);
    }
  }

  function applySearchStatusToNode(node: HTMLDivElement | null, msg: ChatToolStatusEvent): void {
    if (!node || !node.parentNode || settledSearchTurns.has(node)) {
      return;
    }
    const kind = resolveToolKind(msg);
    const chain = ensureThoughtChain(node, { collapsed: false });
    ensureImplicitSubtitleStep(node, chain, kind);

    const target = kind === "capture_video_frame_at_time" ? formatVideoFrameTime(msg.targetTime) : "";
    const detailText =
      kind === "capture_video_frame_at_time"
        ? `${target} 附近`
        : String(msg.query || "");

    if (msg.status === "searching") {
      // 若此前已有自动补齐的隐式字幕步骤，收到显式 read_subtitles 时就地升级
      const implicitSub =
        kind === "read_subtitles"
          ? chain.steps.find((candidate) => candidate.kind === "read_subtitles" && candidate.implicit)
          : undefined;
      if (implicitSub) {
        implicitSub.implicit = false;
        implicitSub.callId = msg.callId;
        implicitSub.detailEl.textContent = detailText;
        applyStepStatus(implicitSub, "searching", "读取中…");
        chain.announcerEl.textContent = "";
        updateThoughtChainHeader(chain);
        return;
      }
      const existing = msg.callId ? chain.steps.find((candidate) => candidate.callId === msg.callId) : undefined;
      if (existing) {
        return;
      }
      const runningMeta =
        kind === "capture_video_frame_at_time"
          ? "截取中…"
          : kind === "read_subtitles"
            ? "读取中…"
            : "搜索中…";
      const step = createThoughtStep(kind, detailText, runningMeta, "searching", { callId: msg.callId });
      chain.steps.push(step);
      chain.stepsEl.appendChild(step.row);
      chain.announcerEl.textContent = "";
      if (!chain.userToggled) {
        setThoughtChainCollapsed(chain, false);
      }
      updateThoughtChainHeader(chain);
      return;
    }

    let step = msg.callId
      ? chain.steps.find((candidate) => candidate.callId === msg.callId)
      : [...chain.steps].reverse().find((candidate) => candidate.kind === kind && candidate.status === "searching");

    if (!step && kind === "read_subtitles") {
      const implicitSub = chain.steps.find((candidate) => candidate.kind === "read_subtitles" && candidate.implicit);
      if (implicitSub) {
        implicitSub.implicit = false;
        implicitSub.callId = msg.callId;
        implicitSub.detailEl.textContent = detailText;
        step = implicitSub;
      } else {
        step = createThoughtStep(kind, detailText, "", "searching", { callId: msg.callId });
        chain.steps.push(step);
        chain.stepsEl.appendChild(step.row);
      }
    }

    if (!step || step.status !== "searching") {
      return;
    }

    if (msg.status === "failed" || msg.status === "cancelled") {
      const failureText =
        kind === "capture_video_frame_at_time"
          ? "未取到画面，已按文字继续"
          : kind === "read_subtitles"
            ? "字幕读取失败"
            : "搜索失败";
      applyStepStatus(step, msg.status, msg.status === "failed" ? failureText : "已取消");
    } else if (kind === "capture_video_frame_at_time") {
      appendVideoFrameList(step, msg);
      const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
      applyStepStatus(step, "done", `${step.frameCount} 张${missing ? `，缺失 ${missing} 张` : ""}`);
    } else if (kind === "read_subtitles") {
      step.resultCount = typeof msg.resultCount === "number" ? msg.resultCount : undefined;
      applyStepStatus(step, "done", typeof msg.resultCount === "number" ? `${msg.resultCount} 处` : "已完成");
    } else {
      const platform = String(msg.platform || "").trim();
      step.resultCount = typeof msg.resultCount === "number" ? msg.resultCount : undefined;
      applyStepStatus(
        step,
        "done",
        typeof msg.resultCount === "number" ? `${msg.resultCount} 条${platform ? ` · ${platform}` : ""}` : ""
      );
      if (Array.isArray(msg.sources) && (msg.sources.length || msg.paidFallbackNotice)) {
        appendSourceList(chain, msg.sources, { paid: msg.paid, notice: msg.paidFallbackNotice });
      }
    }

    const runningTools = chain.steps.filter((candidate) => candidate.kind !== "thinking" && candidate.status === "searching");
    updateThoughtChainHeader(chain);
    if (!runningTools.length) {
      announceToolTerminal(chain, step, msg.status);
    }
  }

  function settleThoughtChainTools(node: HTMLDivElement | null, status: "failed" | "cancelled"): void {
    if (!node) {
      return;
    }
    settledSearchTurns.add(node);
    hideSourcePreview(deps.messages);
    const chain = thoughtChainStates.get(node);
    if (!chain) {
      return;
    }
    const runningTools = chain.steps.filter((step) => step.kind !== "thinking" && step.status === "searching");
    if (!runningTools.length) {
      return;
    }
    for (const step of runningTools) {
      const failureText =
        step.kind === "capture_video_frame_at_time"
          ? "未取到画面，已按文字继续"
          : step.kind === "read_subtitles"
            ? "字幕读取失败"
            : "搜索失败";
      applyStepStatus(step, status, status === "failed" ? failureText : "已取消");
    }
    const latest = runningTools[runningTools.length - 1];
    updateThoughtChainHeader(chain);
    announceToolTerminal(chain, latest, status);
  }

  function takeTurnSearchSources(node: HTMLDivElement | null): ChatSearchSource[] {
    if (!node) {
      return [];
    }
    hideSourcePreview(deps.messages);
    return thoughtChainStates.get(node)?.sources.slice() ?? [];
  }

  function clearThoughtChain(node: HTMLDivElement | null): void {
    if (!node) {
      return;
    }
    const chain = thoughtChainStates.get(node);
    if (chain) {
      for (const step of chain.steps) {
        if (step.kind === "thinking") {
          cancelThinkingTextFrame(step.bodyEl);
        }
      }
      chain.root.remove();
    }
    thoughtChainStates.delete(node);
    settledSearchTurns.delete(node);
    hideSourcePreview(deps.messages);
  }

  function attachHistorySearchToThoughtChain(node: HTMLDivElement, turn: HistorySearchTurn): void {
    const existing = thoughtChainStates.get(node);
    const chain = existing ?? buildThoughtChainShell({ collapsed: true });
    if (!existing) {
      thoughtChainStates.set(node, chain);
      const uniqueTs = new Set(
        Array.from(node.querySelectorAll<HTMLElement>(".chat-timestamp-link"))
          .map((el) => el.dataset.timestampSeconds)
          .filter(Boolean)
      );
      chain.citedSubtitleCount = uniqueTs.size;
      node.prepend(chain.root);
    }

    const searchRows: ThoughtStepState[] = turn.queries.map((query, i) =>
      createThoughtStep("web_search", query, `${turn.resultCounts[i] ?? 0} 条`, "done")
    );
    const firstThinking = chain.steps.find((step) => step.kind === "thinking");
    if (firstThinking) {
      const insertIdx = chain.steps.indexOf(firstThinking);
      chain.steps.splice(insertIdx, 0, ...searchRows);
      for (const row of searchRows) {
        chain.stepsEl.insertBefore(row.row, firstThinking.row);
      }
    } else {
      chain.steps.push(...searchRows);
      for (const row of searchRows) {
        chain.stepsEl.appendChild(row.row);
      }
    }
    appendSourceList(chain, turn.sources);
    setThoughtChainCollapsed(chain, true);
    updateThoughtChainHeader(chain);
  }

  // =========================================================================
  // renderSearchCitations — 正文 [n] → 内联引用（spec §4）
  // =========================================================================
  // 流结束后（renderAssistantMessage）把正文文本节点里的 [n] 换成上标引用：
  // 点击或 Enter/Space 打开来源 URL；悬停或聚焦出预览卡（标题 + 域名 + 摘录 200 字符）。
  // 只处理不在 a / code / pre / button / sup 内的文本节点（时间戳 linkify
  // 同款 walker 纪律），编号越界（模型编造 / 历史截断）按纯文本保留。

  const CITATION_PATTERN = /\[(\d{1,2})\]/g;

  function renderSearchCitations(root: HTMLElement, sources: ChatSearchSource[]): void {
    if (!sources.length) {
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (!(current instanceof Text)) {
        continue;
      }
      const parent = current.parentElement;
      if (!parent || parent.closest("a, code, pre, button, sup")) {
        continue;
      }
      CITATION_PATTERN.lastIndex = 0;
      if (!CITATION_PATTERN.test(current.textContent || "")) {
        continue;
      }
      textNodes.push(current);
    }
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || "";
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let hasMatch = false;
      CITATION_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CITATION_PATTERN.exec(text))) {
        hasMatch = true;
        if (match.index > lastIndex) {
          fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const marker = match[0];
        const index = Number(match[1]);
        const source = sources[index - 1];
        if (!source || !source.url) {
          fragment.append(document.createTextNode(marker));
        } else {
          const cite = document.createElement("sup");
          cite.className = "chat-cite";
          cite.tabIndex = 0;
          cite.setAttribute("role", "button");
          cite.setAttribute("aria-label", `打开来源 ${index}：${source.title || source.url}`);
          cite.setAttribute("data-cite-url", source.url);
          cite.textContent = marker;
          cite.addEventListener("click", () => {
            openSourceUrl(source.url);
          });
          cite.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }
            event.preventDefault();
            openSourceUrl(source.url);
          });
          bindSourcePreview(cite, source);
          fragment.append(cite);
        }
        lastIndex = match.index + marker.length;
      }
      if (!hasMatch) {
        return;
      }
      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.replaceWith(fragment);
    });
  }

  function createActionButton(className: string, label: string, icon: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-msg-action-btn ${className}`;
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.innerHTML = icon.trim();
    return button;
  }

  function createCopyButton(label: string, getRaw: () => string): HTMLButtonElement {
    const button = createActionButton("chat-msg-copy-btn", label, READING_COPY_ICON);
    button.disabled = !getRaw().trim();
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(getRaw());
        flashCopySuccess(button, { originalSvg: READING_COPY_ICON, originalLabel: label });
      } catch {
        deps.onNotice?.("复制失败，请检查浏览器剪贴板权限后重试");
      }
    });
    return button;
  }

  function createContinueButton(node: HTMLDivElement, historyIndex?: number): HTMLButtonElement {
    const button = createActionButton("chat-msg-continue-btn", "继续生成", READING_PLAY_ICON);
    button.disabled = historyIndex === undefined || Boolean(deps.isRegenerationDisabled?.());
    button.addEventListener("click", () => {
      if (historyIndex !== undefined && !deps.isRegenerationDisabled?.()) {
        deps.onContinue?.(historyIndex, node);
      }
    });
    return button;
  }

  function createActionBar(
    node: HTMLDivElement,
    {
      stopped = false,
      historyIndex,
      content,
      hasSpeakableContent = false,
      cleanedRaw = ""
    }: {
      stopped?: boolean;
      historyIndex?: number;
      content?: HTMLElement;
      hasSpeakableContent?: boolean;
      cleanedRaw?: string;
    } = {}
  ): HTMLDivElement {
    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";

    const regenerateBtn = createActionButton("chat-msg-regenerate-btn", "重新生成", READING_RESET_ICON);
    regenerateBtn.disabled = historyIndex === undefined || Boolean(deps.isRegenerationDisabled?.());
    regenerateBtn.addEventListener("click", () => {
      if (historyIndex !== undefined && !deps.isRegenerationDisabled?.()) {
        deps.onRegenerate?.(historyIndex, node);
      }
    });

    if (stopped && !content) {
      actions.append(regenerateBtn, createContinueButton(node, historyIndex));
      return actions;
    }

    actions.appendChild(createCopyButton("复制回复", () => cleanedRaw));

    if (supportsTtsSpeech()) {
      const speakBtn = createActionButton("chat-msg-speak-btn", "朗读回答", READING_SPEAKER_ICON);
      speakBtn.disabled = !hasSpeakableContent || !deps.onSpeak;
      speakBtn.setAttribute("aria-pressed", "false");
      speakBtn.addEventListener("click", () => {
        if (content) {
          void deps.onSpeak?.(node.dataset.messageId || "", speakBtn, content);
        }
      });
      actions.appendChild(speakBtn);
    }
    actions.appendChild(regenerateBtn);

    if (stopped) {
      actions.appendChild(createContinueButton(node, historyIndex));
    }

    const exportBtn = createActionButton("chat-msg-export-btn", "导出 Markdown", READING_DOWNLOAD_ICON);
    exportBtn.disabled = historyIndex === undefined || !cleanedRaw.trim();
    exportBtn.addEventListener("click", () => {
      if (historyIndex === undefined) {
        return;
      }
      try {
        deps.onExport?.(historyIndex, cleanedRaw);
      } catch (error) {
        deps.onNotice?.(`导出失败：${getErrorMessage(error)}`);
      }
    });
    actions.appendChild(exportBtn);

    return actions;
  }
  // =========================================================================
  // renderAssistantMessage
  // =========================================================================
  function renderAssistantMessage(
    node: HTMLDivElement | null,
    raw: unknown,
    { sources = [], historyIndex, stopped = false, thinking }: { userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number; stopped?: boolean; thinking?: string } = {}
  ): void {
    if (!node) {
      return;
    }
    const cleanedRaw = stripThinkBlocks(raw);
    const content = document.createElement("div");
    content.className = "chat-msg-assistant-body markdown-body";
    content.innerHTML = renderMarkdownStripped(cleanedRaw, CHAT_MARKDOWN_OPTIONS);
    const citedSubtitleCount = linkifyAssistantTimestamps(content, deps.getTimestampNavDeps());
    const hasSpeakableContent = Boolean(content.textContent?.trim() || content.querySelector("pre, img[alt]"));
    hydrateMarkdownContent(content);
    if (sources.length) {
      renderSearchCitations(content, sources);
    }

    let chain = thoughtChainStates.get(node);
    if (chain) {
      chain.stoppedWithoutBody = false;
      settleThoughtChainThinking(chain);
      chain.citedSubtitleCount = citedSubtitleCount;
      setThoughtChainCollapsed(chain, true);
      updateThoughtChainHeader(chain);
    } else if (typeof thinking === "string" && thinking.trim()) {
      chain = buildThoughtChainShell({ collapsed: true });
      const step = createThoughtStep("thinking", "", "", "done", { thinkingText: thinking });
      chain.steps.push(step);
      chain.stepsEl.appendChild(step.row);
      chain.citedSubtitleCount = citedSubtitleCount;
      thoughtChainStates.set(node, chain);
      updateThoughtChainHeader(chain);
    }

    node.innerHTML = "";
    if (chain) {
      node.appendChild(chain.root);
    }
    node.appendChild(content);

    const actions = createActionBar(node, {
      stopped,
      historyIndex,
      content,
      hasSpeakableContent,
      cleanedRaw
    });
    node.appendChild(actions);
  }
  // =========================================================================
  // setAutoScroll — 自动滚动标志的窄写入口（sidepanel scroll 监听与消息区
  // 重建点调用；消息区句柄的 live 装配直接写闭包）
  // =========================================================================
  function setAutoScroll(value: boolean): void {
    shouldAutoScrollMessages = Boolean(value);
  }

  // =========================================================================
  // 终态徽标 / 回合节点句柄（ChatAssistantTurn）/ 消息区句柄（ChatMessageArea）
  // =========================================================================
  function appendBadge(node: HTMLElement, className: string, text: string): void {
    const badge = document.createElement("div");
    badge.className = className;
    badge.textContent = text;
    node.appendChild(badge);
  }

  function createTurnHandle(node: HTMLDivElement, opts?: { initialThinking?: string }): ChatAssistantTurn {
    let thinkingEnded = false;
    let accumulatedThinking = opts?.initialThinking || "";
    let terminalHistoryIndex: number | undefined;

    function flushPendingThinking(): void {
      const chain = thoughtChainStates.get(node);
      if (!chain) {
        return;
      }
      for (const step of chain.steps) {
        if (step.kind === "thinking") {
          flushThinkingTextNode(step.bodyEl);
        }
      }
    }

    function cancelAllThinkingFrames(): void {
      const chain = thoughtChainStates.get(node);
      if (!chain) {
        return;
      }
      for (const step of chain.steps) {
        if (step.kind === "thinking") {
          cancelThinkingTextFrame(step.bodyEl);
        }
      }
    }

    function setSubtitleContextCount(count: number): void {
      if (Number.isFinite(count) && count > 0) {
        subtitleContextCounts.set(node, Math.floor(count));
      } else {
        subtitleContextCounts.delete(node);
      }
    }

    function appendToken(token: unknown): void {
      thinkingEnded = true;
      appendTokenToNode(node, token);
    }

    function appendThinking(text: unknown): void {
      accumulatedThinking += String(text ?? "");
      const forceNewStep = thinkingEnded;
      if (thinkingEnded) {
        thinkingEnded = false;
      }
      appendThinkingStepToNode(node, text, forceNewStep);
    }

    function getThinking(): string {
      return accumulatedThinking;
    }

    function reset(): void {
      accumulatedThinking = "";
      cancelTokenFlush();
      const state = getTokenStreamState(node);
      const cursor = state.cursor;
      clearThoughtChain(node);
      if (state.stableEl) {
        state.stableEl.remove();
      }
      if (state.tailEl) {
        state.tailEl.remove();
      }
      resetTokenStreamState(node);
      const freshState = getTokenStreamState(node);
      freshState.cursor = cursor;
      if (cursor) {
        node.appendChild(cursor);
      }
      thinkingEnded = false;
    }

    function finish({ raw, thinking, stopped = false, userPrompt = "", sources, historyIndex }: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number } = {}): string {
      terminalHistoryIndex = historyIndex;
      flushPendingThinking();
      cancelTokenFlush();
      settleThoughtChainTools(node, "cancelled");
      const text = raw === undefined ? getStreamRaw(node) : String(raw ?? "");
      const finalThinking = typeof thinking === "string" && thinking.trim() ? thinking : accumulatedThinking;
      if (stopped) {
        const label = "已停止生成";
        if (text.trim()) {
          renderAssistantMessage(node, text, {
            userPrompt,
            sources: sources ?? takeTurnSearchSources(node),
            historyIndex,
            stopped: true,
            thinking: finalThinking
          });
          appendBadge(node, "chat-msg-stopped", label);
          return text;
        }
        node.innerHTML = "";
        let chain = thoughtChainStates.get(node);
        if (!chain && finalThinking && finalThinking.trim()) {
          chain = buildThoughtChainShell({ collapsed: false });
          const step = createThoughtStep("thinking", "", "已停止", "cancelled", { thinkingText: finalThinking });
          chain.steps.push(step);
          chain.stepsEl.appendChild(step.row);
          thoughtChainStates.set(node, chain);
        }
        if (chain) {
          chain.stoppedWithoutBody = true;
          settleThoughtChainThinking(chain, { stopped: true });
          setThoughtChainCollapsed(chain, false);
          updateThoughtChainHeader(chain);
          node.appendChild(chain.root);
        }
        const actions = createActionBar(node, {
          stopped: true,
          historyIndex
        });
        node.appendChild(actions);
        appendBadge(node, "chat-msg-stopped", label);
        return text;
      }
      renderAssistantMessage(node, text, { userPrompt, sources: sources ?? takeTurnSearchSources(node), historyIndex, thinking: finalThinking });
      return text;
    }

    function fail(text: string, opts?: { onRetry?: () => void; searchStatus?: "failed" | "cancelled" }): void {
      flushPendingThinking();
      cancelTokenFlush();
      settleThoughtChainTools(node, opts?.searchStatus ?? "failed");
      cancelAllThinkingFrames();
      const chain = thoughtChainStates.get(node);
      const keepChain = Boolean(chain && chain.steps.some((step) => step.kind !== "thinking"));
      if (chain) {
        settleThoughtChainThinking(chain, { stopped: true });
        setThoughtChainCollapsed(chain, true);
        updateThoughtChainHeader(chain);
      }
      node.innerHTML = "";
      if (keepChain && chain) {
        node.appendChild(chain.root);
      }
      appendBadge(node, "chat-msg-error", text);
      if (opts?.onRetry) {
        const actions = document.createElement("div");
        actions.className = "chat-msg-actions";
        const retryBtn = createActionButton("chat-msg-retry-btn", "重试", READING_RESET_ICON);
        retryBtn.disabled = Boolean(deps.isRegenerationDisabled?.());
        retryBtn.addEventListener("click", () => {
          if (!deps.isRegenerationDisabled?.()) {
            opts.onRetry?.();
          }
        });
        actions.appendChild(retryBtn);
        node.appendChild(actions);
      }
    }

    function stop(reason: string, { userPrompt = "", historyIndex }: { userPrompt?: string; historyIndex?: number } = {}): { raw: string; body: boolean } {
      terminalHistoryIndex = historyIndex;
      flushPendingThinking();
      cancelTokenFlush();
      settleThoughtChainTools(node, "cancelled");
      const text = getStreamRaw(node);
      const label = reason || "已停止生成";
      if (text.trim()) {
        renderAssistantMessage(node, text, {
          userPrompt,
          sources: takeTurnSearchSources(node),
          historyIndex,
          stopped: true,
          thinking: accumulatedThinking
        });
        appendBadge(node, "chat-msg-stopped", label);
        return { raw: text, body: true };
      }
      const state = getTokenStreamState(node);
      const chain = thoughtChainStates.get(node);
      if (chain && chain.steps.length > 0) {
        cancelAllThinkingFrames();
        chain.stoppedWithoutBody = true;
        settleThoughtChainThinking(chain, { stopped: true });
        setThoughtChainCollapsed(chain, false);
        updateThoughtChainHeader(chain);
        if (state.cursor?.parentNode === node) {
          state.cursor.remove();
        }
        if (state.stableEl?.parentNode === node) {
          state.stableEl.remove();
        }
        if (state.tailEl?.parentNode === node) {
          state.tailEl.remove();
        }
        const actions = createActionBar(node, {
          stopped: true,
          historyIndex
        });
        node.appendChild(actions);
        appendBadge(node, "chat-msg-stopped", label);
        return { raw: text, body: false };
      }
      cancelAllThinkingFrames();
      node.innerHTML = "";
      appendBadge(node, "chat-msg-stopped", label);
      return { raw: text, body: false };
    }

    function markTruncated(text: string): void {
      const actions = node.querySelector(".chat-msg-actions");
      if (actions && !actions.querySelector(".chat-msg-continue-btn")) {
        actions.insertBefore(createContinueButton(node, terminalHistoryIndex), actions.querySelector(".chat-msg-export-btn"));
      }
      appendBadge(node, "chat-msg-truncated", text);
    }

    function applySearchStatus(msg: ChatToolStatusEvent): void {
      applySearchStatusToNode(node, msg);
    }

    function attachSearchTimelineCard(turn: HistorySearchTurn): void {
      attachHistorySearchToThoughtChain(node, turn);
    }

    function discard(): void {
      cancelTokenFlush();
      settleThoughtChainTools(node, "cancelled");
      cancelAllThinkingFrames();
      resetTokenStreamState(node);
    }

    return {
      node,
      setSubtitleContextCount,
      appendToken,
      appendThinking,
      getThinking,
      reset,
      discard,
      finish,
      fail,
      stop,
      markTruncated,
      applySearchStatus,
      attachSearchTimelineCard
    };
  }

  function createFollowingVisibilityScope(node: HTMLElement): { restore: () => void; remove: () => void } {
    const following: HTMLElement[] = [];
    let next = node.nextElementSibling;
    while (next) {
      if (next instanceof HTMLElement) {
        next.hidden = true;
        following.push(next);
      }
      next = next.nextElementSibling;
    }
    return {
      restore() {
        following.forEach((element) => {
          element.hidden = false;
        });
      },
      remove() {
        following.forEach((element) => element.remove());
      }
    };
  }

  function beginInPlaceTurn(
    node: HTMLDivElement,
    options: BeginInPlaceTurnOptions
  ): ChatInPlaceSession {
    const savedScrollTop = deps.messages.scrollTop;
    const originalStreaming = node.classList.contains("chat-msg-streaming");
    const originalChildren = Array.from(node.childNodes);
    const originalThoughtChain = thoughtChainStates.get(node) ?? null;
    if (options.mode === "replace") {
      thoughtChainStates.delete(node);
    }
    settledSearchTurns.delete(node);
    const following = createFollowingVisibilityScope(node);

    cancelTokenFlush();
    if (originalThoughtChain) {
      for (const step of originalThoughtChain.steps) {
        if (step.kind === "thinking") {
          cancelThinkingTextFrame(step.bodyEl);
        }
      }
    }
    resetTokenStreamState(node);

    const state = getTokenStreamState(node);
    if (options.mode === "replace") {
      originalChildren.forEach((child) => {
        if (child.parentNode === node) {
          node.removeChild(child);
        }
      });
      state.cursor = createStreamCursor();
      node.appendChild(state.cursor);
    } else {
      node.querySelectorAll(".chat-msg-stopped, .chat-msg-truncated, .chat-msg-actions").forEach((el) => el.remove());

      const existingBody = node.querySelector(".chat-msg-assistant-body");
      if (existingBody) {
        existingBody.remove();
      }
      state.cursor = createStreamCursor();
      const initialRaw = String(options.initialRaw || "");
      if (initialRaw.trim()) {
        ensureStreamContainers(node, state);
        state.session!.flush(initialRaw, { cursor: state.cursor });
      } else {
        node.appendChild(state.cursor);
      }
      shouldAutoScrollMessages = true;
      scrollToBottom(true, { instant: true });
    }

    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    node.classList.add("chat-msg-streaming");

    const baseTurn = createTurnHandle(
      node,
      options.mode === "continue" ? { initialThinking: options.thinking } : undefined
    );
    let settled = false;

    function restore(): void {
      if (settled) {
        return;
      }
      settled = true;
      baseTurn.discard();
      clearThoughtChain(node);
      node.innerHTML = "";
      originalChildren.forEach((child) => node.appendChild(child));
      if (originalThoughtChain) {
        thoughtChainStates.set(node, originalThoughtChain);
      }
      following.restore();
      node.classList.toggle("chat-msg-streaming", originalStreaming);
      deps.messages.scrollTop = savedScrollTop;
    }

    const turn: ChatAssistantTurn = {
      ...baseTurn,
      discard: restore,
      fail() {
        restore();
      }
    };

    return {
      turn,
      commit() {
        if (settled) {
          return;
        }
        settled = true;
        following.remove();
      },
      restore
    };
  }

  const messageArea: ChatMessageArea = {
    appendUserMessage(text, { source = "live", messageId, images = [] } = {}) {
      return appendUserMessageNode(text, source, messageId, images);
    },
    appendAssistantMessage({ source = "live", runId, messageId } = {}) {
      return createTurnHandle(appendAssistantMessageNode(source, runId, messageId));
    },
    beginInPlaceTurn,
    setRegenerationDisabled(disabled) {
      deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn, .chat-msg-continue-btn, .chat-msg-retry-btn").forEach((button) => {
        button.disabled = disabled;
      });
    },
    clearUncommittedFailedTurns() {
      deps.messages.querySelectorAll('[data-uncommitted-failed-turn="1"]').forEach((el) => el.remove());
    },
    closeImageViewer(opts) {
      imageViewer.close(opts?.restoreFocus);
    },
    clear() {
      deps.onClear?.();
      imageViewer.close(false);
      deps.messages.innerHTML = "";
    }
  };

  // 跨片消费面：chat-runtime.ts（流状态机片）经对象解构取滚动窄入口与消息区
  // 句柄；回合节点句柄由消息区句柄产出（状态机不再出现选择器与节点创建）。具名
  // 对象返回面替代 15 元组位置面：字段名即函数名，增删件只改字段，不按位置对齐。
  return {
    scrollToBottom,
    setAutoScroll,
    messageArea
  };
}
