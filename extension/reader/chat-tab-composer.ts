import type { SendTurnOptions } from "../chat/chat-runtime.js";
import type { SendVerdict } from "../chat/turn-lifecycle.js";
import type { InteractionAnchorHint } from "../ai/chat-hybrid-retrieval.js";

export const INPUT_MAX_HEIGHT = 320;
export const SUBTITLE_WAIT_NOTICE = "正在等待字幕，完成后自动发送";
export const IMAGE_PROCESSING_NOTICE = "图片处理中…";
export const IMAGE_TEXT_REQUIRED_NOTICE = "图片需随文字一起发送";

export interface ReaderChatComposerEls {
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
}

export interface ReaderChatComposerRuntime {
  sendTurn: (text: string, options?: SendTurnOptions) => Promise<SendVerdict | string>;
  isTurnActive: () => boolean;
  stopActiveStream: () => void;
}

export interface SendViaInputBoxOptions {
  preserveDraft?: boolean;
  restoreOnReject?: boolean;
  interactionAnchor?: InteractionAnchorHint;
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
  prepareManualPrompt?: (text: string) => string;
  getManualPromptAnchor?: () => InteractionAnchorHint | undefined;
  onManualPromptAccepted?: () => void;
  getLiveState?: () => "idle" | "connecting" | "connected" | "failure";
  onStartLive?: () => void;
}

export interface ReaderChatComposer {
  bind: () => void;
  autosizeInput: () => void;
  updateSendBtnState: () => void;
  syncSendState: () => void;
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  setSubtitleWaitUi: (active: boolean) => void;
  sendViaInputBox: (text: string, options?: SendViaInputBoxOptions) => Promise<boolean>;
  sendDetachedPrompt: (text: string) => Promise<boolean>;
}

export function createReaderChatComposer(deps: ReaderChatComposerDeps): ReaderChatComposer {
  const input = deps.els?.input ?? deps.input!;
  const sendBtn = deps.els?.sendBtn ?? deps.sendBtn!;
  const { chatRuntime, onPasteImage } = deps;
  const inputCard = input.closest(".chat-input-card");
  const waitCard = inputCard?.querySelector<HTMLElement>(".chat-subtitle-wait") ?? null;
  const waitText = waitCard?.querySelector<HTMLElement>(".chat-subtitle-wait-text") ?? null;
  const waitCancel = waitCard?.querySelector<HTMLButtonElement>(".chat-subtitle-wait-cancel") ?? null;

  let stopInFlight = false;
  let subtitleWaitActive = false;
  let cancelRequested = false;

  function updateSendBtnState(): void {
    const isStreaming = sendBtn.classList.contains("is-stop");
    const hasText = Boolean(input.value.trim());
    const hasImages = deps.hasInputImages?.() ?? false;
    const imageProcessing = deps.isImageProcessing?.() ?? false;
    const liveState = deps.getLiveState?.() ?? "idle";

    sendBtn.classList.remove("is-live", "is-connecting");
    sendBtn.removeAttribute("aria-busy");

    if (isStreaming) {
      sendBtn.disabled = stopInFlight;
      sendBtn.setAttribute("aria-label", stopInFlight ? "正在停止…" : "停止");
      sendBtn.setAttribute("title", stopInFlight ? "正在停止…" : "停止生成");
      return;
    }

    if (!hasText && !hasImages && !imageProcessing && liveState === "connecting") {
      sendBtn.classList.add("is-connecting");
      sendBtn.disabled = true;
      sendBtn.setAttribute("aria-busy", "true");
      sendBtn.setAttribute("aria-label", "正在连接伴看…");
      sendBtn.setAttribute("title", "正在连接伴看…");
      return;
    }

    if (!hasText && !hasImages && !imageProcessing && liveState === "idle" && deps.onStartLive) {
      sendBtn.classList.add("is-live");
      sendBtn.disabled = subtitleWaitActive;
      sendBtn.setAttribute("aria-label", "开启实时伴看");
      sendBtn.setAttribute("title", "开启实时伴看");
      return;
    }

    sendBtn.setAttribute("aria-label", "发送");
    if (imageProcessing) {
      sendBtn.disabled = true;
      sendBtn.setAttribute("title", IMAGE_PROCESSING_NOTICE);
    } else if (hasText) {
      sendBtn.disabled = subtitleWaitActive;
      sendBtn.setAttribute("title", "发送");
    } else {
      sendBtn.disabled = true;
      if (hasImages) {
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
      const hasDraft = Boolean(input.value.trim()) || Boolean(deps.hasInputImages?.());
      deps.onNotice?.(hasDraft ? "已取消等待，草稿与图片已保留" : "已取消等待", 3000);
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
    updateSendBtnState();
  }

  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    stopInFlight = stopping;
    sendBtn.classList.toggle("is-stop", isStreaming);
    updateSendBtnState();
  }

  function supportsFieldSizing(): boolean {
    return (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("field-sizing", "content")
    );
  }

  function autosizeInput(): void {
    if (!supportsFieldSizing()) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      if (input.value !== "") {
        const naturalHeight = input.scrollHeight;
        if (naturalHeight > 0) {
          input.style.height = `${Math.min(naturalHeight, INPUT_MAX_HEIGHT)}px`;
          input.style.overflowY = naturalHeight > INPUT_MAX_HEIGHT ? "auto" : "hidden";
        }
      }
    }
    updateSendBtnState();
  }

  function imageSendBlockReason(text: string): string | null {
    if (deps.isImageProcessing?.()) {
      return IMAGE_PROCESSING_NOTICE;
    }
    if (!text.trim() && deps.hasInputImages?.()) {
      return IMAGE_TEXT_REQUIRED_NOTICE;
    }
    return null;
  }

  async function sendViaInputBox(text: string, options: SendViaInputBoxOptions = {}): Promise<boolean> {
    const prevValue = input.value;
    const hasDraft = Boolean(prevValue.trim()) || Boolean(deps.hasInputImages?.());
    if (options.preserveDraft && hasDraft) {
      deps.onNotice?.("已保留未发送草稿，本次未自动发送。", 4000);
      input.focus?.();
      return false;
    }
    input.value = text;
    autosizeInput();
    const blockReason = imageSendBlockReason(text);
    if (blockReason) {
      if (options.restoreOnReject) {
        input.value = prevValue;
        autosizeInput();
        updateSendBtnState();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      deps.onNotice?.(blockReason, 3000);
      return false;
    }
    const verdict = options.interactionAnchor
      ? await chatRuntime.sendTurn(text, { interactionAnchor: options.interactionAnchor })
      : await chatRuntime.sendTurn(text);
    if (verdict !== "accepted") {
      if (options.restoreOnReject) {
        input.value = prevValue;
        autosizeInput();
        updateSendBtnState();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return false;
    }
    return true;
  }

  async function sendDetachedPrompt(text: string): Promise<boolean> {
    const verdict = await chatRuntime.sendTurn(text, { preserveInputDraft: true });
    return verdict === "accepted";
  }

  async function sendFromUi(): Promise<void> {
    const blockReason = imageSendBlockReason(input.value);
    if (blockReason) {
      deps.onNotice?.(blockReason, 3000);
      return;
    }
    if (!input.value.trim()) {
      return;
    }
    const interactionAnchor = deps.getManualPromptAnchor?.();
    const outgoing = deps.prepareManualPrompt ? deps.prepareManualPrompt(input.value) : input.value;
    const verdict = interactionAnchor
      ? await chatRuntime.sendTurn(outgoing, { interactionAnchor })
      : await chatRuntime.sendTurn(outgoing);
    if (verdict === "accepted") {
      deps.onManualPromptAccepted?.();
    } else if (verdict === "ignored" && subtitleWaitActive) {
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
    input.addEventListener("paste", (e) => {
      onPasteImage?.(e);
    });
    input.addEventListener("input", () => {
      autosizeInput();
      updateSendBtnState();
    });
    input.addEventListener("focus", autosizeInput);
    input.addEventListener("blur", autosizeInput);

    sendBtn.addEventListener("click", () => {
      if (sendBtn.classList.contains("is-stop")) {
        chatRuntime.stopActiveStream();
        return;
      }
      if (sendBtn.classList.contains("is-live")) {
        deps.onStartLive?.();
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
    sendDetachedPrompt
  };
}
