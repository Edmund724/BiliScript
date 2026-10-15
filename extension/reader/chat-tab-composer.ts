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
  sendGate?: unknown;
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

  // 输入框 placeholder 的默认串（模板的静态属性，见 reader/chat-template.ts）：
  // 实例初始化时捕获一次原值，字幕抓取等待期间换成等待文案、结束即还原此值——
  // 不在代码里另抄一份字面量，模板改动自动跟随。
  const defaultPlaceholder = input.placeholder;

  // 发送键禁用态：流式中（停止键形态）仅「停止中」禁用；空闲时空输入禁用置灰。
  let stopInFlight = false;

  // 字幕抓取等待态（发送闸经 deps.onWaitingChange 推送）：等待期间发送键禁用 +
  // 输入框 placeholder 换成等待文案——发送键亮着却点了静默无反应（等待可能几秒）
  // 正是要消除的观感。输入框本身保持可编辑：等待期间可继续输入/改提示词（本轮
  // 已受理的文本在回车那一刻定下，本轮之后照常清空）。
  let subtitleWaitActive = false;

  function updateSendBtnState(): void {
    if (sendBtn.classList.contains("is-stop")) {
      sendBtn.disabled = stopInFlight;
      return;
    }
    sendBtn.disabled = subtitleWaitActive || !input.value.trim();
  }

  function setSubtitleWaitUi(active: boolean): void {
    subtitleWaitActive = active;
    input.placeholder = active ? "正在抓取字幕…" : defaultPlaceholder;
    updateSendBtnState();
  }

  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    // 流式中输入框不禁用（等待期间可继续打字）：发送闸由双发竞态闸拦——流式中
    // 回车/发送键走到的 sendTurn 会被在途判据直接忽略，新消息发不出去。
    stopInFlight = stopping;
    // 同键双形态：空闲 = ↑ 发送键（空输入禁用）；流式中 = 停止键（圆形 + 方块
    // 图标，点击 abort 同一条 stopActiveStream 链），停止中禁用防连点。
    sendBtn.classList.toggle("is-stop", isStreaming);
    sendBtn.setAttribute("aria-label", isStreaming ? "停止" : "发送");
    // 空闲分支同 updateSendBtnState：等待态下的 restartChat（新对话/上下文跟随）
    // 也会走到这里，不带等待态会把等待中的发送键放回可用。
    sendBtn.disabled = isStreaming ? stopping : subtitleWaitActive || !input.value.trim();
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
  async function sendViaInputBox(text: string): Promise<boolean> {
    input.value = text;
    autosizeInput();
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
    await chatRuntime.sendTurn(input.value);
  }

  function bind(): void {
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
