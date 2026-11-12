// 对话 Composer 深 module（arch-review-batch4/01 号票）
//
// 职责：
//   1. 常驻输入区元素级监听（keydown Enter/paste 图片/input/focus/blur/发送钮点击）；
//   2. 输入框高度自适应（autosizeInput，行内 min-height 内容自然高，上限 320）；
//   3. 发送态同步（updateSendBtnState/syncSendState、setStreamingUiState、setSubtitleWaitUi）；
//   4. 发送芯闭包（sendViaInputBox / autoSendPrompt / sendFromUi）。
//
// 边界纪律（ADR-0005）：
//   - 不搬状态袋：state.settings / state.session 由外部持有读写，composer 仅持有自身 UI 相位闭包；
//   - 不动 send-gate 与 chatRuntime 接口；
//   - 三个调用点（建议 chip / runQuickActionPrompt / autoSendPrompt）头部的业务闸保留在组合根。

import type { SendVerdict } from "../chat/turn-lifecycle.js";

// 输入框高度只随内容走：scrollHeight（内容自然高）写回 min-height，上限 320。
// 不设聚焦下限——点击聚焦不再撑高（2026-11 用户决议：去掉「聚焦即展开两行」
// 的两态设计，只有内容换行才自然长高）。杠杆必须是 min-height 而非 height：
// 主轴上 flex 项的 flex-basis:0% 让 height 失效（headless Chromium 实测：行内
// height 写了高度不变，只有 min-height 抬得动盒子）。
// 取值是**屏上盒高**（border-box，见 reader-chat.css 的 box-sizing 声明）：
// scrollHeight 与 min-height 同一坐标系，上限 320 与 CSS max-height 同值，
// 不再叠加 4px 内边距。无布局的 jsdom 下 scrollHeight 恒 0，跳过写行内高，
// 高度落回 CSS 自然高，行为不变。
export const INPUT_MAX_HEIGHT = 320;
export const SUBTITLE_WAIT_NOTICE = "正在等待字幕，完成后自动发送";
export const IMAGE_PROCESSING_NOTICE = "图片处理中…";
export const IMAGE_TEXT_REQUIRED_NOTICE = "图片需随文字一起发送";

export interface ReaderChatComposerEls {
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
}

export interface ReaderChatComposerRuntime {
  sendTurn: (text: string) => Promise<SendVerdict | string>;
  isTurnActive: () => boolean;
  stopActiveStream: () => void;
}

export interface ReaderChatComposerDeps {
  els?: ReaderChatComposerEls;
  input?: HTMLTextAreaElement;
  sendBtn?: HTMLButtonElement;
  chatRuntime: ReaderChatComposerRuntime;
  onPasteImage?: (event: ClipboardEvent) => void;
  onCancelSubtitleWait?: () => void;
  onNotice?: (message: string, autoHideMs?: number) => void;
  isImageProcessing?: () => boolean;
  hasInputImages?: () => boolean;
}

export interface ReaderChatComposer {
  bind: () => void;
  autosizeInput: () => void;
  updateSendBtnState: () => void;
  syncSendState: () => void;
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  setSubtitleWaitUi: (active: boolean) => void;
  sendViaInputBox: (text: string) => Promise<boolean>;
  autoSendPrompt: (text: string) => Promise<boolean>;
}

export function createReaderChatComposer(deps: ReaderChatComposerDeps): ReaderChatComposer {
  const input = deps.els?.input ?? deps.input!;
  const sendBtn = deps.els?.sendBtn ?? deps.sendBtn!;
  const { chatRuntime, onPasteImage } = deps;
  const inputCard = input.closest(".chat-input-card");
  const waitCard = inputCard?.querySelector<HTMLElement>(".chat-subtitle-wait") ?? null;
  const waitText = waitCard?.querySelector<HTMLElement>(".chat-subtitle-wait-text") ?? null;
  const waitCancel = waitCard?.querySelector<HTMLButtonElement>(".chat-subtitle-wait-cancel") ?? null;

  // 流式中发送键变为停止键；空闲时图片处理中与无正文均不可发送。
  let stopInFlight = false;
  let subtitleWaitActive = false;
  let cancelRequested = false;

  function updateSendBtnState(): void {
    const isStreaming = sendBtn.classList.contains("is-stop");
    const hasText = Boolean(input.value.trim());

    if (isStreaming) {
      sendBtn.disabled = stopInFlight;
      sendBtn.setAttribute("aria-label", "停止");
      sendBtn.setAttribute("title", "停止生成");
      return;
    }

    sendBtn.setAttribute("aria-label", "发送");
    if (deps.isImageProcessing?.()) {
      sendBtn.disabled = true;
      sendBtn.setAttribute("title", IMAGE_PROCESSING_NOTICE);
    } else if (hasText) {
      sendBtn.disabled = subtitleWaitActive;
      sendBtn.setAttribute("title", "发送");
    } else {
      sendBtn.disabled = true;
      if (deps.hasInputImages?.()) {
        sendBtn.setAttribute("title", IMAGE_TEXT_REQUIRED_NOTICE);
      } else {
        sendBtn.removeAttribute("title");
      }
    }
  }

  function setSubtitleWaitUi(active: boolean): void {
    subtitleWaitActive = active;
    if (waitCard) {
      waitCard.hidden = !active;
    }
    if (active && waitText) {
      waitText.textContent = SUBTITLE_WAIT_NOTICE;
    }
    if (!active && cancelRequested) {
      cancelRequested = false;
      deps.onNotice?.("已取消等待，草稿与图片已保留", 3000);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    updateSendBtnState();
  }

  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    stopInFlight = stopping;
    sendBtn.classList.toggle("is-stop", isStreaming);
    updateSendBtnState();
  }

  function autosizeInput(): void {
    // 测量前先清空行内 min-height（2026-11 用户报障「每敲/删一键长高一行」的 JS
    // 那一半）：不清空时 textarea 一旦带行内高，scrollHeight 会返回**自身撑开后的
    // 高度**而非内容自然高——每敲一键把上次写进去的高读回来再加一点，只增不减
    //（连删除键都会继续长）。先塌回内容高，读到的才是真实自然高；配合 CSS 的
    // border-box 让 scrollHeight 与 min-height 同一坐标系。
    input.style.minHeight = "";
    input.style.overflowY = "hidden";
    if (input.value !== "") {
      // 高度只认内容：空输入恒一行（不写行内高、也不留上次的高）。新网页入场时的
      // 瞬时布局（面板显隐/flex 重排）会把空输入框的 scrollHeight 读成撑开后的盒
      // 高，旧聚焦分支尚能靠失焦清空兜底；改成每次自适应都写之后，这个巨值会粘在
      // 行内高上不回缩——用户看到的就是「刚进页面卡一下、输入框巨大」
      // （2026-11 用户报障）。空内容不测量，这类巨盒从机制上不可能出现。
      const naturalHeight = input.scrollHeight;
      if (naturalHeight > 0) {
        input.style.minHeight = `${Math.min(naturalHeight, INPUT_MAX_HEIGHT)}px`;
        // 滚动条收口：未封顶时 overflow-y 恒 hidden——「内容刚好等于盒高」的边界
        // （line-height 1.45 亚像素行高，实测两行整）会被 Chromium 判出 1px 溢出、
        // 闪出原生滚动条（2026-11 用户报障：两行出滚动条、三行以上又没了）。封顶
        // 320 后才放行 auto：超长文本必须滚得动，否则看不见底。
        input.style.overflowY = naturalHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
      }
    }
    // 发送受理/重启会话等路径是程序化清输入框（不触发 input 事件），发送键禁用
    // 态统一在每次自适应时同步（autosizeInput 是所有这些路径的公共尾部）。
    updateSendBtnState();
  }

  // 建议区属主的 onPick 落点：chip 点击与回车 / 发送键走同一条发送芯。
  //
  // 发送芯（建议 chip / runQuickActionPrompt / autoSendPrompt 的共同尾部）：填输入框
  // → autosize → sendTurn（交出文本，拿回受理结论）→ 按返回值折算是否受理。三个调用
  // 点头部的闸（新会话 vs 双发闸、空串聚焦 vs 空串直 false）语义不同，不并入本芯。
  // 受理结论来自回合生命周期模块的 SendVerdict（accepted → true，blocked /
  // ignored → false）：ignored 是「入口早退、什么都没发」——折算成受理成功会让
  // 调用方（解释意图）把它消费掉而消息从未发出（时间轴只有一条空档）。回放让位
  // 不再手抄：等待已收敛进发送闸（send-gate.ts 的 G7，放行路径统一 await
  // replayInFlight）。
  function imageSendBlockReason(text: string): string | null {
    if (deps.isImageProcessing?.()) {
      return IMAGE_PROCESSING_NOTICE;
    }
    if (!text.trim() && deps.hasInputImages?.()) {
      return IMAGE_TEXT_REQUIRED_NOTICE;
    }
    return null;
  }

  async function sendViaInputBox(text: string): Promise<boolean> {
    input.value = text;
    autosizeInput();
    const blockReason = imageSendBlockReason(text);
    if (blockReason) {
      deps.onNotice?.(blockReason, 3000);
      return false;
    }
    // sendTurn 兑现即发送流程已出结果（subtitle-wait 挂起在其内部 await）。
    const verdict = await chatRuntime.sendTurn(text);
    return verdict === "accepted";
  }

  // 自动发送共用体：填输入框 → sendTurn → 折算是否受理。回合在途（受理窗口 ∪
  // 流段，含「已受理、端口未建、用户消息尚未上屏」的那段窗口）时不注入第二次
  // 发送（双发闸也会拦下并返回 ignored），返回 false 让意图保持 pending——被折算
  // 成 true 就会「意图已消费、消息从未发出」，这正是本判据收口修掉的实证 bug。
  async function autoSendPrompt(text: string): Promise<boolean> {
    if (!text.trim()) {
      return false;
    }
    if (chatRuntime.isTurnActive()) {
      return false;
    }
    return sendViaInputBox(text);
  }

  // 发送入口（回车 / 发送键）直接交给 chatRuntime 的回合受理；
  // 回放让位（P2-1）已收敛进发送闸的放行路径（send-gate.ts 对 G1 与直通路径统一
  // await replayInFlight），此处不再手抄等待——借口径等价于发送闸必须等到其放行。
  async function sendFromUi(): Promise<void> {
    const blockReason = imageSendBlockReason(input.value);
    if (blockReason) {
      deps.onNotice?.(blockReason, 3000);
      return;
    }
    if (!input.value.trim()) {
      return;
    }
    const verdict = await chatRuntime.sendTurn(input.value);
    if (verdict === "ignored" && subtitleWaitActive) {
      deps.onNotice?.(SUBTITLE_WAIT_NOTICE, 3000);
    }
  }

  function bind(): void {
    waitCancel?.addEventListener("click", () => {
      if (!subtitleWaitActive) {
        return;
      }
      cancelRequested = true;
      deps.onCancelSubtitleWait?.();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendFromUi();
      }
    });
    // 图片粘贴（image-input 02 号票）：仅当剪贴板含 image/* 时拦截（纯文本/其它
    // 非图片内容不 preventDefault，既有粘贴行为不变）；压缩与上限判定在
    // chat/chat-input-images.ts，拒绝提示走消息区通知条。
    input.addEventListener("paste", (e) => {
      onPasteImage?.(e);
    });
    input.addEventListener("input", () => {
      autosizeInput();
      updateSendBtnState();
    });
    // 聚焦/失焦只重测高度（高度只随内容走，聚焦不再撑高——见 autosizeInput）。
    input.addEventListener("focus", autosizeInput);
    input.addEventListener("blur", autosizeInput);

    // 发送键：空闲走与回车同一发送路径；流式中同键变停止键（圆形 + 方块图标）。
    sendBtn.addEventListener("click", () => {
      if (sendBtn.classList.contains("is-stop")) {
        chatRuntime.stopActiveStream();
        return;
      }
      void sendFromUi();
    });
  }

  return {
    bind,
    autosizeInput,
    updateSendBtnState,
    syncSendState: updateSendBtnState,
    setStreamingUiState,
    setSubtitleWaitUi,
    sendViaInputBox,
    autoSendPrompt
  };
}
