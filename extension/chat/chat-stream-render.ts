// extension/chat/chat-stream-render.ts — chat 消息 DOM 渲染/滚动/水合片
// 12 票浅拆（自 extension/chat/chat-runtime.ts 迁入，函数体逐字节未变）：
// 流式双容器增量渲染（token 累加器 / flush 帧调度 / 长任务预算切片）、思考节点
// 生命周期与滚动合帧、用户/助手消息 DOM 装配（占位 / 终态重渲染 / mermaid 水合 /
// 时间戳链接 / 复制按钮）、自动滚动标志与 scrollToBottom。
//
// 拆分手法：本片是工厂 createChatStreamRenderer(deps)，闭包自持流式渲染状态
//（shouldAutoScrollMessages / tokenFlushFrame / tokenFlushEpoch / 两个按节点隔离
// 的 WeakMap）——每个 createChatRuntime 实例调用一次，实例间隔离语义与拆分前
// 一致。流状态机与 port 协议分派留在 chat-runtime.ts，经解构以原名消费本片
// 返回面（调用点零改动）；deps 只需 messages 与两个渲染回调（ChatStreamRendererDeps
// 结构子集，createChatRuntime 直接传入完整 deps）。

import {
  createMarkdownTailCursor,
  createThinkStripCursor,
  renderMarkdownStripped,
  stripThinkBlocks,
  type MarkdownTailCursor,
  type ThinkStripCursor
} from "../ui/markdown.js";
// mermaid 图表：renderMarkdown 只产出占位 DOM，SVG 由这里在节点插入之后异步水合
//（懒 chunk，见 ui/lazy-mermaid 头注）。
import { hydrateMermaid } from "../ui/lazy-mermaid.js";
import { linkifyAssistantTimestamps, type TimestampNavDeps } from "../ui/timestamp-nav.js";

// chat-stream-render 消费的最窄 deps 面：messages 滚动容器 + 终态渲染的两个
// 回调（结构子集——createChatRuntime 直接传入完整 CreateChatRuntimeDeps）。
export interface ChatStreamRendererDeps {
  messages: HTMLElement;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  getTimestampNavDeps: () => TimestampNavDeps;
}

// 流式 token 累加器（按节点存放在 WeakMap）：base = 已 flush 的全量原文，
// pending = 未 flush 的增量帧，stableText/stableCut/stableEl/tailEl 为双容器渲染
// 状态，stripCursor/tailCursor 为剥除/切分的增量游标（ui/markdown 头注有逐字节
// 论证；cursor 状态随 resetTokenStreamState 一并重置）。
interface TokenStreamState {
  base: string;
  pending: string[];
  stableText: string;
  // 上次渲染时的切点行号（与 tailCursor.cut 比较；初值 -2 保证首帧必物化）
  stableCut: number;
  stableEl: HTMLDivElement | null;
  tailEl: HTMLDivElement | null;
  stripCursor: ThinkStripCursor;
  tailCursor: MarkdownTailCursor;
}

// 思考文本的显示状态（全量文本缓冲 + 按节点隔离的滚动合帧 + 钉底标志）
interface ThinkingDisplayState {
  text: string;
  // 挂起的滚动合帧 id（按节点隔离：0 = 无挂起帧）
  scrollFrame: number;
  // 思考盒钉底标志：用户上翻即停跟随，回到底部附近恢复（与外层消息容器同契约）
  pinned: boolean;
}

/**
 * createChatStreamRenderer(deps) — chat 消息 DOM 渲染/滚动/水合的工厂。
 *
 * 由 createChatRuntime(deps) 在工厂体内调用一次；闭包状态（自动滚动标志 /
 * flush 帧调度 / 按节点 WeakMap）随实例隔离。返回面只含跨片消费的函数——
 * collapseThinking / ensureStreamContainers / freshTokenStreamState /
 * getTokenStreamState / yieldToMain 仅本片内部消费，不外露。
 */
export function createChatStreamRenderer(deps: ChatStreamRendererDeps) {

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
  // 非流式路径（appendUserMessage / endStream 收尾）直写 scrollTop，滚动
  // 节奏交给 CSS（smooth）。jsdom 等无 Element.scrollTo 的环境退回直写。
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
  // appendUserMessage
  // =========================================================================
  function appendUserMessage(text: string, shouldScroll = true): void {
    const node = document.createElement("div");
    node.className = "chat-msg chat-msg-user";
    node.textContent = text;
    deps.messages.appendChild(node);
    if (shouldScroll) {
      shouldAutoScrollMessages = true;
      scrollToBottom(true);
    }
  }

  // =========================================================================
  // appendAssistantPlaceholder
  // =========================================================================
  function appendAssistantPlaceholder(): HTMLDivElement {
    // 上一条消息的流式豁免（chat-msg-streaming）到此为止，回归历史消息的
    // content-visibility 跳过渲染待遇。切换刻意放在新消息上屏、强制滚底的
    // 同一时刻：高度重估算被发送动作掩盖。若在 endStream 切换，刚完成的
    // 消息会在静止状态下从真实高度突变回估算占位高（c-v 记忆只在持有
    // c-v 期间记录，首次施加拿不到），视口莫名上跳。
    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    const node = document.createElement("div");
    // chat-msg-streaming：流式期间豁免 content-visibility 跳过渲染（M13，
    // 见 reader-chat.css）——正在输出的消息需要准确的实时高度，滚动跟随
    // 才能落到真实底部。
    node.className = "chat-msg chat-msg-assistant chat-msg-streaming";
    // 流式 token 累加器（原 dataset.raw）随占位节点初始化/重置，
    // 保证第二条消息不会串上上一条的流式文本。
    resetTokenStreamState(node);
    const cursor = document.createElement("span");
    cursor.className = "chat-msg-cursor";
    node.appendChild(cursor);
    deps.messages.appendChild(node);
    shouldAutoScrollMessages = true;
    scrollToBottom(true);
    return node;
  }
  // =========================================================================
  // createThinkingNode / collapseThinking — 思考节点生命周期
  // =========================================================================
  // 思考块标题图标（2026-09 用户决议）：线性四角星，与 ui/icons.ts 的
  // sparkles 同族（24 视框 / stroke 1.8 / currentColor，14px 渲染描边约 1px），
  // 不引外部资源。纯装饰，随 svg 自带 aria-hidden。
  const THINKING_ICON_SVG =
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l1.84 4.96 4.96 1.84-4.96 1.84L12 17.2l-1.84-4.96L5.2 10.4l4.96-1.84L12 3.6z"/></svg>';

  function createThinkingNode(assistantNode: HTMLDivElement | null): HTMLDivElement | null {
    if (!assistantNode) {
      return null;
    }
    const node = document.createElement("div");
    node.className = "chat-thinking";
    const label = document.createElement("span");
    label.className = "chat-thinking-label";
    // 图标与文案各占一个子节点：折叠态只改文案（见 collapseThinking），
    // 直接写 label.textContent 会连图标一起清掉。
    const icon = document.createElement("span");
    icon.className = "chat-thinking-icon";
    icon.innerHTML = THINKING_ICON_SVG;
    const labelText = document.createElement("span");
    labelText.className = "chat-thinking-label-text";
    labelText.textContent = "思考中…";
    label.appendChild(icon);
    label.appendChild(labelText);
    const text = document.createElement("div");
    text.className = "chat-thinking-text";
    node.appendChild(label);
    node.appendChild(text);
    // 折叠交互在思考流结束后生效（见 collapseThinking）：点击整行在
    // 折叠/展开间切换；流式期间（不可折叠态）点击无事发生。
    node.addEventListener("click", () => {
      if (!node.classList.contains("chat-thinking-collapsible")) {
        return;
      }
      node.classList.toggle("chat-thinking-collapsed");
    });
    assistantNode.prepend(node);
    return node;
  }

  // 思考流结束（正文首帧渲染 / 终态重渲染）时把思考盒收成一行
  //「思考过程 ▸」：正文成为视觉焦点；点击可展开回看（当轮有效——
  // 思考不落盘，会话回放无思考内容）。
  function collapseThinking(thinking: Element): void {
    thinking.classList.add("chat-thinking-collapsible", "chat-thinking-collapsed");
    const labelText = thinking.querySelector(".chat-thinking-label-text");
    if (labelText) {
      labelText.textContent = "思考过程";
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

  // 思考文本的滚动合帧（与 appendToken 的 rAF 合帧同款机制）：textContent
  // 写入无布局成本，保持逐 token 同步；scrollTop=scrollHeight 每次读
  // scrollHeight 都强制布局——按帧合批，同帧多条增量只滚动一次。挂起帧
  // 标志存放在按 textNode 的 WeakMap 状态里（scrollFrame）：不同消息的
  // 思考节点互不阻挡——若用全局单标志，上一条消息滚动帧挂起的 ≤16ms
  // 窗口内新消息首条 reasoning 会漏掉滚动调度。
  // 钉底契约：pinned=false（用户在思考盒内上翻）时不写 scrollTop——绝不
  // 把用户拉回底部。同一帧顺带让外层消息容器跟随（scrollToBottom 内部读
  // shouldAutoScrollMessages，用户上翻外层时同样不打扰）。
  // 思考节点流式结束后折叠保留在消息内（见 collapseThinking），不脱离
  // DOM：挂起帧回调对它写 scrollTop 仍是无害空操作，无需取消。
  function scheduleThinkingScroll(textNode: Element, state: ThinkingDisplayState): void {
    if (state.scrollFrame) {
      return;
    }
    const scroll = () => {
      state.scrollFrame = 0;
      if (state.pinned) {
        textNode.scrollTop = textNode.scrollHeight;
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
    const textNode = node.querySelector(".chat-thinking-text");
    if (!textNode) {
      return;
    }
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { text: "", scrollFrame: 0, pinned: true };
      thinkingDisplayStates.set(textNode, state);
      // 用户上翻检测：离开底部即停钉底，回到底部附近恢复。程序性钉底
      //（帧回调写 scrollTop=scrollHeight）触发的 scroll 事件落点即底部，
      // 天然归为 pinned=true，无需区分事件来源。
      textNode.addEventListener("scroll", () => {
        const st = thinkingDisplayStates.get(textNode);
        if (!st) {
          return;
        }
        st.pinned = textNode.scrollTop + textNode.clientHeight >= textNode.scrollHeight - THINKING_NEAR_BOTTOM_PX;
      });
    }
    state.text += String(text || "");
    textNode.textContent = state.text;
    scheduleThinkingScroll(textNode, state);
  }
  // =========================================================================
  // appendToken
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
  // 随占位节点初始化（appendAssistantPlaceholder），跨消息天然隔离。
  const tokenStreamStates = new WeakMap<HTMLElement, TokenStreamState>();

  function freshTokenStreamState(): TokenStreamState {
    return {
      base: "",
      pending: [],
      stableText: "",
      stableCut: -2,
      stableEl: null,
      tailEl: null,
      stripCursor: createThinkStripCursor(),
      tailCursor: createMarkdownTailCursor()
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
  // 流式双容器懒创建（首帧 flush 时挂上；finalize / stopped 的整体重渲染会
  // 自然清掉它们）
  function ensureStreamContainers(node: HTMLDivElement, state: TokenStreamState): void {
    if (state.stableEl && state.tailEl) {
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
  }

  // 全量流式文本 = base + 未 flush 的 pending（不做清空，供 finalize/stopped 只读）
  function getStreamRaw(node: HTMLElement): string {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return "";
    }
    return state.base + state.pending.join("");
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

  function appendToken(node: HTMLDivElement | null, token: unknown): void {
    if (!node) {
      return;
    }
    getTokenStreamState(node).pending.push(String(token || ""));
    if (tokenFlushFrame) {
      return;
    }
    const flush = async () => {
      tokenFlushFrame = 0;
      const epoch = ++tokenFlushEpoch;
      const state = getTokenStreamState(node);
      const delta = state.pending.join("");
      // 50ms 长任务预算：deadline 取样在剥除/切分之前，让增量游标的耗时也计入
      // 本帧预算，与「剥除/切分、稳定块与末块的 renderMarkdown + innerHTML 重建
      // 都计入本帧同步工作」的注释一致。预算耗尽先让出主线程（yieldToMain）再
      // 继续；恢复后校验代际（流被取消/收口，或有更新的一帧已启动），不等即作
      // 废本帧——不渲染（文本与游标状态已在下方同步段原子提交，下一帧从游标
      // 状态续渲，不会丢也不会重复）。预算检查保持同步：未触发让出时 flush 在
      // 帧回调内同步完成（与旧的同步渲染时序一致）。
      let deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
      const stale = () => epoch !== tokenFlushEpoch;
      // think 块先剥除再切分（增量游标内部保持同一顺序），保证未闭合的  ```
      // 或 <think> 不会横跨 stable/tail 切点。游标输出与 stripThinkBlocks /
      // splitMarkdownTail 全量逐字节一致（ui/markdown 头注论证），每帧正则只跑
      // 未定居尾 + 本帧新增，不再随已渲染前缀增长。
      state.stripCursor.push(delta);
      const lines = state.stripCursor.lines;
      state.tailCursor.update(lines);
      const cut = state.tailCursor.cut;
      // stable 物化：切点不变即 stable 不变（切点只增不减），增长点才拼接。
      // stableCut/stableText 是渲染簿记，随渲染提交——让出点作废的帧不得留下
      // 「已渲染」记录（否则下一帧会跳过 stable 重渲染）。
      const stableChanged = !(cut >= 0 && cut === state.stableCut);
      let stableText: string;
      if (!stableChanged) {
        stableText = state.stableText;
      } else {
        stableText = cut < 0 ? "" : lines.slice(0, cut).join("\n");
      }
      // tail 每帧物化（拼接 + trimEnd 还原全量版的尾部 trim，逐字节等价）
      const tailText = (cut < 0 ? lines.join("\n") : lines.slice(cut).join("\n")).trimEnd();
      // 文本与游标状态原子提交：游标位置与 base 必须同步前进——否则帧在让出
      // 点作废或渲染抛错后，下一帧会把同一段 pending 重复喂给游标。
      state.base += delta;
      state.pending.length = 0;
      ensureStreamContainers(node, state);
      // 正文首帧渲染 = 思考流结束：所有未折叠的思考盒（正常情况下一个；
      // 收尾 reasoning 在 token 后到达时可能有第二个）收成「思考过程」行，
      // 保留在消息内供点击回看——不再移除节点。
      node.querySelectorAll(".chat-thinking:not(.chat-thinking-collapsible)").forEach(collapseThinking);
      // 稳定前缀只在增长时渲染一次；末块每帧重渲染。空 stable 且容器本就
      // 空时跳过（与旧实现的 stableText 比较语义一致，避免无谓的空串重建）。
      if (stableChanged && (stableText !== "" || state.stableEl!.innerHTML !== "")) {
        if (performance.now() >= deadline) {
          await yieldToMain();
          deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
          if (stale()) {
            return;
          }
        }
        state.stableCut = cut;
        state.stableText = stableText;
        state.stableEl!.innerHTML = renderMarkdownStripped(stableText);
        // stable 只在增长时重渲染一次，其内的 mermaid 占位在此水合（整体重建
        // 会换掉节点，但 SVG 有「主题 + 源码」缓存兜底，重入只是字符串替换）。
        hydrateMermaid(state.stableEl!);
      }
      if (performance.now() >= deadline) {
        await yieldToMain();
        deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
        if (stale()) {
          return;
        }
      }
      // 先取光标引用再重写 tail（innerHTML 赋值会清掉 tail 内的旧光标）
      const cursor = node.querySelector(".chat-msg-cursor");
      // tail 每帧整体重建，且未闭合的围栏本就整段留在 tail——不对它水合
      //（每帧重渲染一遍图表既慢又闪）；围栏闭合进入 stable 后自然渲染，流收口
      // 的整渲染再兜一次。
      state.tailEl!.innerHTML = renderMarkdownStripped(tailText);
      if (cursor) {
        state.tailEl!.appendChild(cursor);
      }
      // 流式帧滚动瞬时化（见 scrollToBottom instant 分支：不逐帧重启 CSS
      // 平滑滚动动画）
      scrollToBottom(false, { instant: true });
    };
    // flush 是 async：同步段（剥除/切分/渲染）的抛错经 promise 变 unhandled
    // rejection，必须 catch 收口记日志（与仓内 console.error 惯例一致）。
    const runFlush = () => {
      flush().catch((err: unknown) => {
        console.error("[chat-runtime] 流式渲染 flush 失败：", err);
      });
    };
    if (typeof window.requestAnimationFrame === "function") {
      tokenFlushFrame = window.requestAnimationFrame(runFlush);
    } else {
      tokenFlushFrame = window.setTimeout(runFlush, 16);
    }
  }
  // =========================================================================
  // renderAssistantMessage
  // =========================================================================
  function renderAssistantMessage(node: HTMLDivElement | null, raw: unknown, { userPrompt = "" }: { userPrompt?: string } = {}): void {
    if (!node) {
      return;
    }
    // 思考行在终态重渲染中保留：仍流式打开的思考盒（如 token 后到达的收尾
    // reasoning 未经正文帧）一并折叠，重挂载到正文之前。历史回放路径无思考
    // 节点（思考不落盘），此处为无害空操作。
    const thinkings = Array.from(node.querySelectorAll(".chat-thinking"));
    thinkings.forEach((thinking) => {
      if (!thinking.classList.contains("chat-thinking-collapsible")) {
        collapseThinking(thinking);
      }
    });
    node.innerHTML = "";
    thinkings.forEach((thinking) => node.appendChild(thinking));
    const cleanedRaw = stripThinkBlocks(raw);
    const pasteReadyRaw = deps.normalizeMarkdownForSectionPaste(cleanedRaw);

    const content = document.createElement("div");
    // markdown-body：启用 github-markdown-css 排版基线（样式随对话分区表挂载，
    // 变量由 github-markdown-theme.css 桥接到 --boc-reader-*）。
    content.className = "chat-msg-assistant-body markdown-body";
    content.innerHTML = renderMarkdownStripped(cleanedRaw);
    linkifyAssistantTimestamps(content, deps.getTimestampNavDeps());
    // 时间戳链接在前、mermaid 水合在后：linkify 跳过 pre/code 内的文本，占位里
    // 的图表源码不会被它改写；水合换入的 SVG 里也不该再长出时间戳按钮。
    hydrateMermaid(content);
    node.appendChild(content);

    const actions = document.createElement("div");
    actions.className = "chat-msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "chat-msg-copy-btn";
    copyBtn.setAttribute("aria-label", "复制回复");
    copyBtn.setAttribute("title", "复制回复");
    copyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pasteReadyRaw);
        copyBtn.disabled = true;
        window.setTimeout(() => {
          copyBtn.disabled = false;
        }, 500);
      } catch {
        copyBtn.disabled = true;
        window.setTimeout(() => {
          copyBtn.disabled = false;
        }, 500);
      }
    });
    actions.appendChild(copyBtn);

    node.appendChild(actions);
  }
  // =========================================================================
  // setAutoScroll — 自动滚动标志的窄写入口（sidepanel scroll 监听与消息区
  // 重建点调用；appendUserMessage / appendAssistantPlaceholder 直接写闭包）
  // =========================================================================
  function setAutoScroll(value: boolean): void {
    shouldAutoScrollMessages = Boolean(value);
  }

  // 跨片消费面：chat-runtime.ts（流状态机片）经解构消费以下函数——函数名与
  // 拆分前一致，调用点与 createChatRuntime 返回面键名零改动。
  return [
    scrollToBottom,
    appendUserMessage,
    appendAssistantPlaceholder,
    appendToken,
    appendThinkingText,
    createThinkingNode,
    resetTokenStreamState,
    cancelTokenFlush,
    getStreamRaw,
    renderAssistantMessage,
    setAutoScroll
  ] as const;
}
