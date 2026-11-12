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
import { getErrorMessage } from "../shared/error-helpers.js";
import { formatClock } from "../shared/clock-text.js";
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

export interface ChatRegenerationSession {
  turn: ChatAssistantTurn;
  commit: () => void;
  restore: () => void;
}

export interface ChatContinuationSession {
  turn: ChatAssistantTurn;
  commit: () => void;
  restore: () => void;
}

export interface ChatMessageArea {
  appendUserMessage: (text: string, opts?: { source?: ChatMessageSource; messageId?: string; images?: ImagePart[] }) => void;
  appendAssistantMessage: (opts?: { source?: ChatMessageSource; runId?: string; messageId?: string }) => ChatAssistantTurn;
  beginRegeneration: (node: HTMLDivElement) => ChatRegenerationSession;
  beginContinuation: (node: HTMLDivElement, opts?: { initialRaw?: string; thinking?: string }) => ChatContinuationSession;
  setRegenerationDisabled: (disabled: boolean) => void;
  clear: () => void;
}

// 回合节点句柄：一个助手消息节点的操作面（状态机不再出现选择器与节点创建；
// 一代际的 token 缓冲、思考节点状态都由本句柄闭包持有）。
export interface ChatAssistantTurn {
  /** 助手消息节点元素 */
  node?: HTMLDivElement;
  /** 灌入 token 增量（帧合批；未 flush 的增量同样进终态原文）。 */
  appendToken: (token: unknown) => void;
  /** 灌入思考增量；本回合尚无打开的思考节点时新建（token 后的收尾 reasoning 新建第二个）。 */
  appendThinking: (text: unknown) => void;
  /** 获取本回合累积的思考文本。 */
  getThinking?: () => string;
  /** 重置流式（读流中断重试整体重放）：清已渲染容器 / 思考盒 / 时间线卡与累加器，内部自动取消挂起帧，光标归位。 */
  reset: () => void;
  /** 丢弃在途回合（拆除清场）：内部自动取消挂起渲染帧并释放累加器，不破坏已落定 DOM。 */
  discard: () => void;
  /** 收尾成终态形态（正文 + 操作行，折叠思考行；内部自动取消挂起帧）；返回本次渲染所用原文。 */
  finish: (opts?: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number }) => string;
  /** 挂错误占位（内部自动取消挂起帧；清空节点内容，只留给定文案）。 */
  fail: (text: string) => void;
  /** 挂停止态：内部自动取消挂起帧；有正文则收尾成形态 + 停止徽标，无正文清空节点只留徽标。 */
  stop: (reason: string, opts?: { userPrompt?: string; historyIndex?: number }) => { raw: string; body: boolean };
  /** 挂截断徽标（收尾之后追加，位置与停止徽标一致）。 */
  markTruncated: (text: string) => void;
  /** 工具 tool-status → 时间线卡（插在本节点之前）。 */
  applySearchStatus: (msg: ChatToolStatusEvent) => void;
  /** 回放：把该回合的静态时间线卡插在本节点之前（回放只表达顺序）。 */
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
  uncollapsedThinking: HTMLDivElement[];
  allThinking: HTMLDivElement[];
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
  function appendUserMessageNode(text: string, source: ChatMessageSource, messageId?: string, images: ImagePart[] = []): void {
    const node = document.createElement("div");
    node.className = "chat-msg chat-msg-user";
    node.setAttribute("data-message-id", messageId || `chat-message-${++nextMessageId}`);
    const body = document.createElement("div");
    body.className = "chat-msg-user-body";
    body.textContent = text;
    node.appendChild(body);
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
  // createThinkingNode / collapseThinking — 思考节点生命周期
  // =========================================================================
  // 思考块标题图标（2026-09 用户决议）：线性四角星，与 ui/icons.ts 的
  // sparkles 同族（24 视框 / stroke 1.8 / currentColor，14px 渲染描边约 1px），
  // 不引外部资源。纯装饰，随 svg 自带 aria-hidden。星形在视框内几何居中
  // （2026-11 与空态欢迎区图标一并修正：原路径视觉中心比视框中心高 1.6px）。
  const THINKING_ICON_SVG =
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2l1.84 4.96 4.96 1.84-4.96 1.84L12 18.8l-1.84-4.96L5.2 12l4.96-1.84L12 5.2z"/></svg>';

  const thinkingTextNodes = new WeakMap<Element, HTMLElement>();
  const thinkingLabelTexts = new WeakMap<Element, HTMLElement>();

  function flushThinkingText(textNode: Element, state: ThinkingDisplayState): void {
    if (state.renderedText !== state.text) {
      textNode.textContent = state.text;
      state.renderedText = state.text;
    }
  }

  function buildThinkingElement(
    thinkingContent: string,
    opts: { collapsible?: boolean; collapsed?: boolean; labelText?: string } = {}
  ): HTMLDivElement {
    const node = document.createElement("div");
    const classList = ["chat-thinking"];
    if (opts.collapsible) {
      classList.push("chat-thinking-collapsible");
    }
    if (opts.collapsed) {
      classList.push("chat-thinking-collapsed");
    }
    node.className = classList.join(" ");

    const label = document.createElement("span");
    label.className = "chat-thinking-label";
    const icon = document.createElement("span");
    icon.className = "chat-thinking-icon";
    icon.innerHTML = THINKING_ICON_SVG;
    const labelText = document.createElement("span");
    labelText.className = "chat-thinking-label-text";
    labelText.textContent = opts.labelText || "思考过程";
    label.appendChild(icon);
    label.appendChild(labelText);
    label.appendChild(createChevronSpan("chat-thinking-chevron"));
    const text = document.createElement("div");
    text.className = "chat-thinking-text";
    text.textContent = thinkingContent;
    node.appendChild(label);
    node.appendChild(text);

    thinkingTextNodes.set(node, text);
    thinkingLabelTexts.set(node, labelText);

    node.addEventListener("click", () => {
      if (!node.classList.contains("chat-thinking-collapsible")) {
        return;
      }
      node.classList.toggle("chat-thinking-collapsed");
    });
    return node;
  }

  function createThinkingNode(assistantNode: HTMLDivElement | null): HTMLDivElement | null {
    if (!assistantNode) {
      return null;
    }
    const node = buildThinkingElement("", { collapsible: false, collapsed: false, labelText: "思考中…" });
    thinkingStartTimes.set(node, Date.now());
    assistantNode.prepend(node);

    const state = getTokenStreamState(assistantNode);
    state.uncollapsedThinking.push(node);
    state.allThinking.unshift(node);

    return node;
  }

  // 思考流结束（正文首帧渲染 / 终态重渲染）时把思考盒收成一行
  //「已思考（用时 X 秒）▸」：正文成为视觉焦点；点击可展开回看（当轮有效——
  // 思考不落盘，会话回放无思考内容）。
  const thinkingStartTimes = new WeakMap<Element, number>();

  function formatThinkingDuration(elapsedMs: number): string {
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    return `已思考（用时 <span class="chat-thinking-duration-num">${elapsedSec}</span> 秒）`;
  }

  function collapseThinking(thinking: Element): void {
    const textNode = thinkingTextNodes.get(thinking) || thinking.querySelector(".chat-thinking-text");
    if (textNode) {
      const state = thinkingDisplayStates.get(textNode);
      if (state) {
        flushThinkingText(textNode, state);
      }
    }
    thinking.classList.add("chat-thinking-collapsible", "chat-thinking-collapsed");
    const labelText = thinkingLabelTexts.get(thinking) || thinking.querySelector(".chat-thinking-label-text");
    if (labelText) {
      const startTime = thinkingStartTimes.get(thinking);
      if (typeof startTime === "number" && !Number.isNaN(startTime)) {
        labelText.innerHTML = formatThinkingDuration(Math.max(0, Date.now() - startTime));
      } else {
        labelText.textContent = "思考过程";
      }
    }
  }

  // =========================================================================
  // appendThinkingText
  // =========================================================================
  // 思考文本的流式累加器：WeakMap 按节点存放全量文本（不截断——思考过程
  // 完整可见是体验契约），每条增量只复制进缓冲一次，总复制量 O(n)。思考
  // 内容不落盘（chatHistory 只存正文），缓冲随 thinking 节点（每条消息
  // 新建）走，跨消息天然隔离重置。
  const thinkingDisplayStates = new WeakMap<Element, ThinkingDisplayState>();
  // 思考盒钉底恢复阈值：用户回滚到距底 24px 内视为「回到底部」，恢复跟随
  const THINKING_NEAR_BOTTOM_PX = 24;

  // 思考文本按帧写入与滚动合帧（与 token flush 的 rAF 合帧同款机制）：DOM 文本
  // 写入每帧最多一次，且发生在该帧布局读数之前；同帧多条增量统一合批写入并滚动。挂起帧
  // 标志存放在按 textNode 的 WeakMap 状态里（scrollFrame）：不同消息的
  // 思考节点互不阻挡——若用全局单标志，上一条消息滚动帧挂起的 ≤16ms
  // 窗口内新消息首条 reasoning 会漏掉滚动调度。
  // 折叠、完成、停止与错误收尾前同步冲刷待写文本，保持事件顺序且不丢内容。
  // 钉底契约：pinned=false（用户在思考盒内上翻）时不写 scrollTop——绝不
  // 把用户拉回底部。同一帧顺带让外层消息容器跟随（scrollToBottom 内部读
  // shouldAutoScrollMessages，用户上翻外层时同样不打扰）。
  // 思考节点流式结束后折叠保留在消息内（见 collapseThinking），不脱离
  // DOM：挂起帧回调对它写 scrollTop 仍是无害空操作，无需取消。
  function cancelThinkingFrame(thinking: Element): void {
    const textNode = thinkingTextNodes.get(thinking) || thinking.querySelector(".chat-thinking-text");
    if (textNode) {
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
        // 记录写入后的实际读数（scrollTop 写入会被 clamp 到 scrollHeight -
        // clientHeight，回读才是事件判定用的真实基准）。
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

  function appendThinkingText(node: HTMLDivElement | null, text: unknown): void {
    if (!node) {
      return;
    }
    const textNode = thinkingTextNodes.get(node) || node.querySelector(".chat-thinking-text");
    if (!textNode) {
      return;
    }
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { text: "", renderedText: "", scrollFrame: 0, pinned: true, lastTop: 0, syncedHeight: 0 };
      thinkingDisplayStates.set(textNode, state);
      // 用户上翻检测：位置上移即停钉底，回到底部附近恢复。不能只按几何
      // 重算——程序性钉底写入（帧回调 scrollTop=scrollHeight）触发的 scroll
      // 事件要到下一帧 scroll steps 才派发，期间同步落进思考盒的增量（联网
      // 搜索的 reasoning 大块正是这种窗口）会让事件几何显示「不在底部」，
      // 纯几何判定会误判为用户上翻，钉底就此永久失效（不再写入 → 不再有
      // 事件 → 无法自愈）。判定规则：
      //   - scrollTop 低于上次程序性写入的落点：位置上移，程序性写入只会
      //     把 scrollTop 往下推，必是用户上翻 → 停钉底；
      //   - 位置没动（= 上次写入落点）但 scrollHeight 已增长：几何错位是
      //     内容增量造成的，不是用户 → 保持钉底，等下一帧写入追平；
      //   - 其余（位置下移，或高度未变）按几何重算，与旧契约一致。
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
      uncollapsedThinking: [],
      allThinking: [],
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
    // 正文首帧渲染 = 思考流结束：所有未折叠的思考盒（正常情况下一个；
    // 收尾 reasoning 在 token 后到达时可能有第二个）收成「思考过程」行，
    // 保留在消息内供点击回看——不再移除节点。
    if (state.uncollapsedThinking.length > 0) {
      for (const thinking of state.uncollapsedThinking) {
        collapseThinking(thinking);
      }
      state.uncollapsedThinking = [];
    }
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
  // 工具活动时间线卡（搜索含 spec §4 内联引用）
  // =========================================================================
  // tool-status 事件驱动的独立卡片，插在用户消息与回答（assistant 节点）之间：
  // 头部 = 左置 chevron + 工具类别 + 最近一条查询词或目标时间 + 右端状态；
  // 每步一行 = 弹点 + 活动描述 + 结果。搜索完成后底部追加来源列表（整行点击
  // 新标签打开 URL、悬停出预览卡）；历史截帧完成后在对应步骤内追加可查看的
  // 实际帧。状态按 assistant 节点隔离（WeakMap，与 token 流累加器同契约：
  // 随占位节点建立、跨消息天然隔离，stream-reset 整卡清除重放）。
  //
  // 搜索卡默认折叠，截帧卡为展示进行中与实际帧默认展开；点击头部切换折叠态。
  // 记忆只在本次会话内、按卡隔离（展开后后续 tool-status 事件不折回）；不落盘，
  // 新卡 / 历史回放 / stream-reset 重建一律回到各自默认折叠态。
  //
  // 来源编号跨搜索累计（到达顺序），与正文 [n] 内联引用、tool-loop 描述里的
  // 编号契约对齐（spec §4/§5）。悬停预览卡与列表行/cite 点击的新标签打开走
  // window.open（reader 对话 tab 在 content script 上下文，无 chrome.tabs）。

  type SearchActivityStatus = "searching" | "done" | "failed" | "cancelled";
  type ToolActivityKind = "web_search" | "capture_video_frame_at_time";

  interface SearchStepState {
    row: HTMLElement;
    callId?: string;
    kind: ToolActivityKind;
    status: SearchActivityStatus;
    frameCount: number;
    expectedFrameCount: number;
  }

  // 按节点隔离的时间线卡状态（键 = assistant 占位节点）。
  interface SearchCardState {
    card: HTMLElement;
    queryEl: HTMLElement;
    statusEl: HTMLElement;
    stepsEl: HTMLElement;
    announcerEl: HTMLElement;
    steps: SearchStepState[];
    status: SearchActivityStatus;
    // 来源列表容器（首个带 sources 的 done 到达时创建；限高内滚）。
    sourcesWrap: HTMLElement | null;
    // 跨搜索累计的来源（编号顺序 = 到达顺序）。
    sources: ChatSearchSource[];
  }

  const searchCardStates = new WeakMap<HTMLElement, SearchCardState>();

  function isVideoFrameStatus(msg: ChatToolStatusEvent): boolean {
    return msg.tool === "capture_video_frame_at_time";
  }

  function formatVideoFrameTime(seconds: unknown): string {
    const formatted = formatClock(seconds, { hours: "auto" });
    return formatted.includes(":") && formatted.split(":").length === 2
      ? formatted.padStart(5, "0")
      : formatted;
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
  }

  function hideSourcePreview(container: HTMLElement): void {
    container.querySelectorAll("[data-chat-search-preview]").forEach((el) => el.remove());
  }

  function bindSourcePreview(anchor: HTMLElement, source: ChatSearchSource): void {
    anchor.addEventListener("mouseenter", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("mouseleave", () => hideSourcePreview(deps.messages));
    anchor.addEventListener("focus", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("blur", () => hideSourcePreview(deps.messages));
  }

  // 卡骨架由搜索与历史截帧共用；独立 announcer 只承载工具终态。
  function createSearchCardShell(
    statusText: string,
    statusValue: SearchActivityStatus = "searching",
    labelText = "联网搜索"
  ): { card: HTMLElement; queryEl: HTMLElement; statusEl: HTMLElement; stepsEl: HTMLElement; announcerEl: HTMLElement } {
    const card = document.createElement("div");
    card.className = "chat-search-card chat-search-card-collapsed";
    card.dataset.status = statusValue;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "chat-search-card-head";
    head.setAttribute("aria-expanded", "false");
    head.addEventListener("click", () => {
      const collapsed = card.classList.toggle("chat-search-card-collapsed");
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
    const label = document.createElement("span");
    label.className = "chat-search-card-label";
    label.textContent = labelText;
    const query = document.createElement("span");
    query.className = "chat-search-card-query";
    const status = document.createElement("span");
    status.className = "chat-search-card-status";
    status.textContent = statusText;
    head.append(createChevronSpan("chat-search-card-chevron"), label, query, status);
    const steps = document.createElement("div");
    steps.className = "chat-search-card-steps";
    const announcer = document.createElement("div");
    announcer.className = "chat-search-announcer";
    announcer.setAttribute("role", "status");
    announcer.setAttribute("aria-live", "polite");
    announcer.setAttribute("aria-atomic", "true");
    card.append(head, steps, announcer);
    return { card, queryEl: query, statusEl: status, stepsEl: steps, announcerEl: announcer };
  }

  // 步骤行共享构建器：running=true 为进行中形态（live 路径），
  // false 为终态行（回放路径，noteText 记结果数）。
  function createSearchStepRow(query: string, noteText: string, running: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = running ? "chat-search-step is-running" : "chat-search-step";
    const bullet = document.createElement("span");
    bullet.className = "chat-search-step-bullet";
    const queryEl = document.createElement("span");
    queryEl.className = "chat-search-step-query";
    queryEl.textContent = query;
    const note = document.createElement("span");
    note.className = "chat-search-step-note";
    note.textContent = noteText;
    row.append(bullet, queryEl, note);
    return row;
  }

  function createSearchCard(messages: HTMLElement, assistantNode: HTMLElement, msg: ChatToolStatusEvent): SearchCardState {
    const videoFrame = isVideoFrameStatus(msg);
    const { card, queryEl, statusEl, stepsEl, announcerEl } = createSearchCardShell(
      videoFrame ? "截取中…" : "搜索中…",
      "searching",
      videoFrame ? "视频画面" : "联网搜索"
    );
    if (videoFrame) {
      card.classList.remove("chat-search-card-collapsed");
      card.querySelector(".chat-search-card-head")?.setAttribute("aria-expanded", "true");
    }
    messages.insertBefore(card, assistantNode);
    return {
      card,
      queryEl,
      statusEl,
      stepsEl,
      announcerEl,
      steps: [],
      status: "searching",
      sourcesWrap: null,
      sources: []
    };
  }

  function createSearchStep(state: SearchCardState, query: string, callId: string | undefined, kind: ToolActivityKind): SearchStepState {
    const existing = callId ? state.steps.find((step) => step.callId === callId) : undefined;
    if (existing) {
      return existing;
    }
    const row = createSearchStepRow(query, kind === "capture_video_frame_at_time" ? "截取中…" : "搜索中…", true);
    state.stepsEl.appendChild(row);
    const step = { row, callId, kind, status: "searching" as const, frameCount: 0, expectedFrameCount: 3 };
    state.steps.push(step);
    return step;
  }

  function announceSearchTerminal(state: SearchCardState, step: SearchStepState, status: Exclude<SearchActivityStatus, "searching">): void {
    const videoFrame = step.kind === "capture_video_frame_at_time";
    const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
    const text = status === "done"
      ? videoFrame
        ? `已获取 ${step.frameCount} 张画面${missing ? `，缺失 ${missing} 张` : ""}`
        : `搜索完成，共 ${state.sources.length} 条来源`
      : status === "failed"
        ? videoFrame ? "未取到画面，已按文字继续" : "搜索失败"
        : videoFrame ? "画面截取已取消" : "搜索已取消";
    state.announcerEl.setAttribute("role", status === "failed" ? "alert" : "status");
    state.announcerEl.setAttribute("aria-live", status === "failed" ? "assertive" : "polite");
    state.announcerEl.textContent = text;
  }

  function settleSearchStep(step: SearchStepState, status: Exclude<SearchActivityStatus, "searching">, noteText: string): void {
    step.status = status;
    step.row.classList.remove("is-running", "is-failed", "is-cancelled");
    if (status === "failed" || status === "cancelled") {
      step.row.classList.add(status === "failed" ? "is-failed" : "is-cancelled");
    }
    const note = step.row.querySelector(".chat-search-step-note");
    if (note) {
      note.textContent = noteText;
    }
  }

  function setSearchCardStatus(state: SearchCardState, step: SearchStepState, status: SearchActivityStatus): void {
    state.status = status;
    state.card.dataset.status = status;
    const videoFrame = step.kind === "capture_video_frame_at_time";
    state.statusEl.textContent = status === "searching"
      ? videoFrame ? "截取中…" : "搜索中…"
      : status === "failed"
        ? videoFrame ? "未取到画面" : "搜索失败"
        : status === "cancelled"
          ? "已取消"
          : videoFrame ? `${step.frameCount} 张画面` : `${state.sources.length} 条来源`;
  }

  // 来源列表（虚线分隔 + 限高内滚）：每行 = 序号 + 标题（两行截断，title 属性给
  // 完整 URL），整行点击新标签打开、悬停或聚焦出预览卡。序号跨搜索累计（与正文 [n]
  // 内联引用同一套编号）。容器只建一次，后续 done 追加。
  // opts.paid = 本批来源来自付费平台（GLOSSARY「付费平台」）：行尾挂「付费」徽标，
  // 标注随 state.sources 累计（回放路径无此字段，自然不带徽标）；opts.notice =
  // 付费平台失败后回退成功的注记，固定在来源列表顶部一行小字（整个卡片至多一条，
  // 链上首个失败付费平台的注记）。
  function appendSourceList(
    state: SearchCardState,
    sources: ChatSearchSource[],
    opts: { paid?: boolean; notice?: string } = {}
  ): void {
    if (!sources.length && !opts.notice) {
      return;
    }
    if (!state.sourcesWrap) {
      state.sourcesWrap = document.createElement("div");
      state.sourcesWrap.className = "chat-search-sources";
      state.sourcesWrap.addEventListener("scroll", () => hideSourcePreview(deps.messages), { passive: true });
      state.card.appendChild(state.sourcesWrap);
    }
    if (opts.notice && !state.sourcesWrap.querySelector(".chat-search-sources-notice")) {
      const notice = document.createElement("div");
      notice.className = "chat-search-sources-notice";
      notice.textContent = opts.notice;
      state.sourcesWrap.appendChild(notice);
    }
    for (const source of sources) {
      const index = state.sources.length + 1;
      const marked = opts.paid ? ({ ...source, paid: true } as ChatSearchSource) : source;
      state.sources.push(marked);
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
      state.sourcesWrap.appendChild(row);
    }
  }

  function appendVideoFrameList(step: SearchStepState, msg: ChatToolStatusEvent): void {
    const frames = Array.isArray(msg.frames) ? msg.frames.slice(0, 3) : [];
    step.frameCount = typeof msg.resultCount === "number" ? msg.resultCount : frames.length;
    step.expectedFrameCount = msg.expectedCount ?? 3;
    if (!frames.length) {
      return;
    }
    const list = document.createElement("div");
    list.className = "chat-video-frame-results";
    step.row.appendChild(list);
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

  const settledSearchTurns = new WeakSet<HTMLElement>();

  /**
   * applySearchStatus — tool-status 事件驱动时间线卡（live 流路径）。
   * callId 存在时按调用收口；无 callId 的旧事件沿用最近一条同类别进行中步骤。
   */
  function applySearchStatusToNode(node: HTMLDivElement | null, msg: ChatToolStatusEvent): void {
    if (!node || !node.parentNode || settledSearchTurns.has(node)) {
      return;
    }
    let state = searchCardStates.get(node);
    if (!state) {
      state = createSearchCard(deps.messages, node, msg);
      searchCardStates.set(node, state);
    }
    const videoFrame = isVideoFrameStatus(msg);
    const kind: ToolActivityKind = videoFrame ? "capture_video_frame_at_time" : "web_search";
    const label = state.card.querySelector(".chat-search-card-label");
    if (label) {
      label.textContent = videoFrame ? "视频画面" : "联网搜索";
    }
    const target = videoFrame ? formatVideoFrameTime(msg.targetTime) : "";
    state.queryEl.textContent = videoFrame ? `${target} 附近` : String(msg.query || "");
    if (msg.status === "searching") {
      const stepText = videoFrame ? `正在回看 ${target} 附近画面…` : String(msg.query || "");
      const step = createSearchStep(state, stepText, msg.callId, kind);
      if (step.status !== "searching") {
        return;
      }
      setSearchCardStatus(state, step, "searching");
      state.announcerEl.textContent = "";
      return;
    }
    const step = msg.callId
      ? state.steps.find((candidate) => candidate.callId === msg.callId)
      : [...state.steps].reverse().find((candidate) => candidate.kind === kind && candidate.status === "searching");
    if (!step || step.status !== "searching") {
      return;
    }
    if (msg.status === "failed" || msg.status === "cancelled") {
      const failureText = videoFrame ? "未取到画面，已按文字继续" : "搜索失败";
      settleSearchStep(step, msg.status, msg.status === "failed" ? failureText : "已取消");
    } else if (videoFrame) {
      appendVideoFrameList(step, msg);
      const missing = Math.max(0, step.expectedFrameCount - step.frameCount);
      settleSearchStep(step, "done", `${step.frameCount} 张${missing ? `，缺失 ${missing} 张` : ""}`);
    } else {
      const platform = String(msg.platform || "").trim();
      settleSearchStep(step, "done", typeof msg.resultCount === "number"
        ? `${msg.resultCount} 条${platform ? ` · ${platform}` : ""}`
        : "");
      if (Array.isArray(msg.sources) && (msg.sources.length || msg.paidFallbackNotice)) {
        appendSourceList(state, msg.sources, { paid: msg.paid, notice: msg.paidFallbackNotice });
      }
    }
    const running = state.steps.filter((candidate) => candidate.status === "searching");
    setSearchCardStatus(state, running[running.length - 1] ?? step, running.length ? "searching" : msg.status);
    if (!running.length) {
      announceSearchTerminal(state, step, msg.status);
    }
  }

  function settleSearchCard(node: HTMLDivElement | null, status: "failed" | "cancelled"): void {
    if (!node) {
      return;
    }
    settledSearchTurns.add(node);
    hideSourcePreview(deps.messages);
    const state = searchCardStates.get(node);
    if (!state) {
      return;
    }
    const running = state.steps.filter((step) => step.status === "searching");
    if (!running.length) {
      return;
    }
    for (const step of running) {
      const failureText = step.kind === "capture_video_frame_at_time" ? "未取到画面，已按文字继续" : "搜索失败";
      settleSearchStep(step, status, status === "failed" ? failureText : "已取消");
    }
    const latest = running[running.length - 1];
    setSearchCardStatus(state, latest, status);
    announceSearchTerminal(state, latest, status);
  }

  // 终态收口取本回合累计来源（finalize / stopped 传给 renderAssistantMessage
  // 做 [n] 内联引用）；take 语义：顺带收走可能挂着的来源预览卡。
  function takeTurnSearchSources(node: HTMLDivElement | null): ChatSearchSource[] {
    if (!node) {
      return [];
    }
    hideSourcePreview(deps.messages);
    return searchCardStates.get(node)?.sources.slice() ?? [];
  }

  // stream-reset（offscreen 整体重放，含重新搜索）：整卡清除，状态随新事件重建。
  // 卡片恒插在 assistant 节点之前（createSearchCard），即其前兄弟元素。
  function clearSearchCard(node: HTMLDivElement | null): void {
    if (!node) {
      return;
    }
    searchCardStates.delete(node);
    settledSearchTurns.delete(node);
    const previous = node.previousElementSibling;
    if (previous?.classList.contains("chat-search-card")) {
      previous.remove();
    }
    hideSourcePreview(deps.messages);
  }

  /**
   * buildSearchTimelineCard — 回放路径的静态卡构建（spec §4：来源列表与
   * 时间线卡可从历史重建）。从历史聚合回合（collectHistorySearchTurns 的
   * HistorySearchTurn）构建与 live 卡同构的 DOM：头部（最近一条查询词 + 来源
   * 条数）+ 步骤行 + 来源列表（编号从 1 起累计）。平台/耗时未持久化，头部
   * 状态记来源条数；列表行点击与悬停引用同 openSourceUrl / showSourcePreview。
   */
  function buildSearchTimelineCard(turn: HistorySearchTurn): HTMLElement {
    const { card, queryEl, stepsEl, announcerEl } = createSearchCardShell(`${turn.sources.length} 条来源`, "done");
    queryEl.textContent = turn.queries[turn.queries.length - 1] ?? "";
    turn.queries.forEach((query, i) => {
      stepsEl.appendChild(createSearchStepRow(query, `${turn.resultCounts[i] ?? 0} 条`, false));
    });
    const replayState: SearchCardState = {
      card,
      queryEl,
      statusEl: card.querySelector(".chat-search-card-status")!,
      stepsEl,
      announcerEl,
      steps: [],
      status: "done",
      sourcesWrap: null,
      sources: []
    };
    appendSourceList(replayState, turn.sources);
    return card;
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

    const speakBtn = createActionButton("chat-msg-speak-btn", "朗读回答", READING_SPEAKER_ICON);
    speakBtn.disabled = !hasSpeakableContent || !deps.onSpeak;
    speakBtn.setAttribute("aria-pressed", "false");
    speakBtn.addEventListener("click", () => {
      if (content) {
        void deps.onSpeak?.(node.dataset.messageId || "", speakBtn, content);
      }
    });
    actions.append(speakBtn, regenerateBtn);

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
    // 思考行在终态重渲染中保留：仍流式打开的思考盒（如 token 后到达的收尾
    // reasoning 未经正文帧）一并折叠，重挂载到正文之前。
    const state = getTokenStreamState(node);
    if (state.uncollapsedThinking.length > 0) {
      for (const thinking of state.uncollapsedThinking) {
        collapseThinking(thinking);
      }
      state.uncollapsedThinking = [];
    }
    node.innerHTML = "";
    state.allThinking.forEach((thinking) => node.appendChild(thinking));
    if (state.allThinking.length === 0 && typeof thinking === "string" && thinking.trim()) {
      const thinkingEl = buildThinkingElement(thinking, { collapsible: true, collapsed: true, labelText: "思考过程" });
      node.appendChild(thinkingEl);
    }
    const cleanedRaw = stripThinkBlocks(raw);

    const content = document.createElement("div");
    content.className = "chat-msg-assistant-body markdown-body";
    content.innerHTML = renderMarkdownStripped(cleanedRaw, CHAT_MARKDOWN_OPTIONS);
    linkifyAssistantTimestamps(content, deps.getTimestampNavDeps());
    const hasSpeakableContent = Boolean(content.textContent?.trim() || content.querySelector("pre, img[alt]"));
    hydrateMarkdownContent(content);
    if (sources.length) {
      renderSearchCitations(content, sources);
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
  // 终态徽标（截断 / 停止 / 错误）在节点上的唯一装配点：class 与文案由调用方给，
  // 位置语义由本片决定（错误占位清空节点后挂；截断/停止挂在操作行之后）。
  function appendBadge(node: HTMLElement, className: string, text: string): void {
    const badge = document.createElement("div");
    badge.className = className;
    badge.textContent = text;
    node.appendChild(badge);
  }

  // 回合节点句柄：一个助手消息节点的操作面。两处一代际状态由句柄闭包持有
  // （原 chat-runtime 闭包的 thinkingNode / thinkingEnded 换持有方式：从「每实例
  // 一份、跨消息复位」改为「每回合一份」，语义逐字不变）：
  //   - thinkingNode：本回合尚在累积的思考节点（null = 未创建或已收尾）；
  //   - thinkingEnded：本回合思考已收尾（token 到达即收尾）——其后到达的收尾
  //     reasoning 事件新建节点（附着本回合节点），不写进已折叠的旧节点。
  function createTurnHandle(node: HTMLDivElement, opts?: { initialThinking?: string }): ChatAssistantTurn {
    let thinkingNode: HTMLDivElement | null = null;
    let thinkingEnded = false;
    let accumulatedThinking = opts?.initialThinking || "";
    let terminalHistoryIndex: number | undefined;

    function flushPendingThinking(): void {
      const state = getTokenStreamState(node);
      if (state.uncollapsedThinking.length > 0) {
        for (const thinking of state.uncollapsedThinking) {
          const textNode = thinkingTextNodes.get(thinking) || thinking.querySelector(".chat-thinking-text");
          if (textNode) {
            const st = thinkingDisplayStates.get(textNode);
            if (st) {
              flushThinkingText(textNode, st);
            }
          }
        }
      }
    }

    function appendToken(token: unknown): void {
      // token 到达即思考收尾（首帧渲染把旧节点折叠保留）。
      thinkingNode = null;
      thinkingEnded = true;
      appendTokenToNode(node, token);
    }

    function appendThinking(text: unknown): void {
      accumulatedThinking += String(text ?? "");
      if (!thinkingNode && thinkingEnded) {
        thinkingEnded = false;
      }
      if (!thinkingNode) {
        thinkingNode = createThinkingNode(node);
      }
      appendThinkingText(thinkingNode, text);
    }

    function getThinking(): string {
      return accumulatedThinking;
    }

    // 重置流式（读流中断重试：整体重放 / 拆除级重置）：清空本条消息的流式缓冲与已渲染内容，
    // 从头接收重试流——取消挂起 flush、重置 token 累加器（base/pending 清零）、
    // 移除 stable/tail 容器与思考节点（光标先摘下来放回节点末尾，flush 时机随
    // 下一帧恢复）、清时间线卡（整体重放含重新搜索）；思考节点随下一个 reasoning
    // 事件重建。不走收口六步：流并未终止（port 不断开、流式 UI 不退出）。
    function reset(): void {
      accumulatedThinking = "";
      cancelTokenFlush();
      const state = getTokenStreamState(node);
      const cursor = state.cursor;
      for (const thinking of state.allThinking) {
        cancelThinkingFrame(thinking);
        thinking.remove();
      }
      if (state.stableEl) {
        state.stableEl.remove();
      }
      if (state.tailEl) {
        state.tailEl.remove();
      }
      clearSearchCard(node);
      resetTokenStreamState(node);
      const freshState = getTokenStreamState(node);
      freshState.cursor = cursor;
      if (cursor) {
        node.appendChild(cursor);
      }
      thinkingNode = null;
      thinkingEnded = false;
    }

    // 收尾成终态形态：自动取消挂起的流式渲染帧（原 endStream 步骤①，内收至此，
    // 确保终态 DOM 物化前旧帧彻底作废）；raw 缺省 = 本回合累计原文（live 路径），
    // 回放显式传历史正文；sources 缺省 = 本回合累计来源（live：顺带收走悬停预览卡），
    // 回放显式传来源（含空数组），不触发这条消费副作用。
    function finish({ raw, thinking, stopped = false, userPrompt = "", sources, historyIndex }: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number } = {}): string {
      terminalHistoryIndex = historyIndex;
      flushPendingThinking();
      cancelTokenFlush();
      settleSearchCard(node, "cancelled");
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
        if (finalThinking && finalThinking.trim()) {
          const thinkingEl = buildThinkingElement(finalThinking, {
            collapsible: true,
            collapsed: false,
            labelText: "已停止"
          });
          node.appendChild(thinkingEl);
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

    // 挂错误占位：自动取消挂起的流式渲染帧；清空节点内容，只留给定文案。
    function fail(text: string): void {
      flushPendingThinking();
      cancelTokenFlush();
      settleSearchCard(node, "failed");
      const state = getTokenStreamState(node);
      for (const thinking of state.allThinking) {
        cancelThinkingFrame(thinking);
      }
      node.innerHTML = "";
      appendBadge(node, "chat-msg-error", text);
    }

    // 挂停止态：自动取消挂起的流式渲染帧；
    // 有正文则收尾成形态 + 停止徽标；无正文清空节点只留徽标。
    function stop(reason: string, { userPrompt = "", historyIndex }: { userPrompt?: string; historyIndex?: number } = {}): { raw: string; body: boolean } {
      terminalHistoryIndex = historyIndex;
      flushPendingThinking();
      cancelTokenFlush();
      settleSearchCard(node, "cancelled");
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
      if (state.allThinking.length > 0) {
        for (const thinking of state.allThinking) {
          cancelThinkingFrame(thinking);
          const textNode = thinkingTextNodes.get(thinking) || thinking.querySelector(".chat-thinking-text");
          if (textNode) {
            const st = thinkingDisplayStates.get(textNode);
            if (st) {
              flushThinkingText(textNode, st);
            }
          }
          thinking.classList.add("chat-thinking-collapsible");
          thinking.classList.remove("chat-thinking-collapsed");
          const labelText = thinkingLabelTexts.get(thinking) || thinking.querySelector(".chat-thinking-label-text");
          if (labelText) {
            labelText.textContent = "已停止";
          }
        }
        state.uncollapsedThinking = [];
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
      for (const thinking of state.allThinking) {
        cancelThinkingFrame(thinking);
      }
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
      // 卡片插在回答节点之前（装配时节点已在消息区内；先收尾再挂卡——回放只
      // 表达这个顺序，插卡落点由本片决定）。
      deps.messages.insertBefore(buildSearchTimelineCard(turn), node);
    }

    // 丢弃在途回合（拆除清场）：取消挂起渲染帧并释放累加器，不破坏节点已有 DOM。
    function discard(): void {
      cancelTokenFlush();
      settleSearchCard(node, "cancelled");
      const state = getTokenStreamState(node);
      for (const thinking of state.allThinking) {
        cancelThinkingFrame(thinking);
      }
      resetTokenStreamState(node);
    }

    return {
      node,
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

  function beginRegeneration(node: HTMLDivElement): ChatRegenerationSession {
    const originalStreaming = node.classList.contains("chat-msg-streaming");
    const originalContent = document.createDocumentFragment();
    while (node.firstChild) {
      originalContent.appendChild(node.firstChild);
    }
    const previous = node.previousElementSibling;
    const originalSearchCard = previous?.classList.contains("chat-search-card") ? previous : null;
    originalSearchCard?.remove();
    searchCardStates.delete(node);
    settledSearchTurns.delete(node);
    const following: HTMLElement[] = [];
    let next = node.nextElementSibling;
    while (next) {
      if (next instanceof HTMLElement) {
        next.hidden = true;
        following.push(next);
      }
      next = next.nextElementSibling;
    }

    cancelTokenFlush();
    const oldState = getTokenStreamState(node);
    for (const thinking of oldState.allThinking) {
      cancelThinkingFrame(thinking);
    }
    resetTokenStreamState(node);
    const state = getTokenStreamState(node);
    state.cursor = createStreamCursor();
    node.appendChild(state.cursor);
    node.classList.add("chat-msg-streaming");
    const baseTurn = createTurnHandle(node);
    let settled = false;
    function restore(): void {
      if (settled) {
        return;
      }
      settled = true;
      baseTurn.discard();
      clearSearchCard(node);
      node.innerHTML = "";
      node.appendChild(originalContent);
      if (originalSearchCard) {
        deps.messages.insertBefore(originalSearchCard, node);
      }
      following.forEach((element) => {
        element.hidden = false;
      });
      node.classList.toggle("chat-msg-streaming", originalStreaming);
    }
    const turn: ChatAssistantTurn = {
      ...baseTurn,
      discard: restore,
      fail() {
        restore();
      },
      stop(reason, options) {
        const result = baseTurn.stop(reason, options);
        if (!result.body && !baseTurn.getThinking?.()) {
          restore();
        }
        return result;
      }
    };

    return {
      turn,
      commit() {
        if (settled) {
          return;
        }
        settled = true;
        following.forEach((element) => element.remove());
      },
      restore
    };
  }

  function beginContinuation(
    node: HTMLDivElement,
    opts: { initialRaw?: string; thinking?: string } = {}
  ): ChatContinuationSession {
    const originalStreaming = node.classList.contains("chat-msg-streaming");
    const originalChildren = Array.from(node.childNodes);
    settledSearchTurns.delete(node);

    cancelTokenFlush();
    const oldState = getTokenStreamState(node);
    for (const thinking of oldState.allThinking) {
      cancelThinkingFrame(thinking);
    }
    resetTokenStreamState(node);

    node.querySelectorAll(".chat-msg-stopped, .chat-msg-truncated").forEach((el) => el.remove());
    node.querySelectorAll(".chat-msg-actions").forEach((el) => el.remove());

    const existingThinking = Array.from(node.querySelectorAll<HTMLDivElement>(".chat-thinking"));
    const state = getTokenStreamState(node);
    state.allThinking = [...existingThinking];
    state.uncollapsedThinking = existingThinking.filter((el) => !el.classList.contains("chat-thinking-collapsed"));

    const initialRaw = String(opts.initialRaw || "");
    const hasBody = Boolean(initialRaw.trim());

    if (hasBody) {
      const existingBody = node.querySelector(".chat-msg-assistant-body");
      if (existingBody) {
        existingBody.remove();
      }
      state.cursor = createStreamCursor();
      ensureStreamContainers(node, state);
      state.session!.flush(initialRaw, { cursor: state.cursor });
    } else {
      const existingBody = node.querySelector(".chat-msg-assistant-body");
      if (existingBody) {
        existingBody.remove();
      }
      state.cursor = createStreamCursor();
      node.appendChild(state.cursor);
    }

    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    node.classList.add("chat-msg-streaming");
    shouldAutoScrollMessages = true;
    scrollToBottom(true, { instant: true });

    const baseTurn = createTurnHandle(node, { initialThinking: opts.thinking });
    let settled = false;

    function restore(): void {
      if (settled) {
        return;
      }
      settled = true;
      baseTurn.discard();
      clearSearchCard(node);
      node.innerHTML = "";
      originalChildren.forEach((child) => node.appendChild(child));
      node.classList.toggle("chat-msg-streaming", originalStreaming);
    }

    const turn: ChatAssistantTurn = {
      ...baseTurn,
      discard: restore,
      fail() {
        restore();
      },
      stop(reason, options) {
        return baseTurn.stop(reason, options);
      }
    };

    return {
      turn,
      commit() {
        settled = true;
      },
      restore
    };
  }

  const messageArea: ChatMessageArea = {
    appendUserMessage(text, { source = "live", messageId, images = [] } = {}) {
      appendUserMessageNode(text, source, messageId, images);
    },
    appendAssistantMessage({ source = "live", runId, messageId } = {}) {
      return createTurnHandle(appendAssistantMessageNode(source, runId, messageId));
    },
    beginRegeneration,
    beginContinuation,
    setRegenerationDisabled(disabled) {
      deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn, .chat-msg-continue-btn").forEach((button) => {
        button.disabled = disabled;
      });
    },
    clear() {
      deps.onClear?.();
      imageViewer.close();
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
