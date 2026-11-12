import { describe, expect, it, vi } from "vitest";
import { createReaderChatComposer } from "../../extension/reader/chat-tab-composer.js";

function setupComposer(overrides: Partial<Parameters<typeof createReaderChatComposer>[0]> = {}) {
  const input = document.createElement("textarea");
  input.placeholder = "回车发送，Shift+Enter 换行";
  const sendBtn = document.createElement("button");
  const card = document.createElement("div");
  card.className = "chat-input-card";
  card.innerHTML = `
    <div class="chat-subtitle-wait" hidden>
      <span class="chat-subtitle-wait-text"></span>
      <button type="button" class="chat-subtitle-wait-cancel">取消</button>
    </div>`;
  card.append(input, sendBtn);
  document.body.appendChild(card);

  const chatRuntime = {
    sendTurn: vi.fn(async () => "ok"),
    isTurnActive: vi.fn(() => false),
    stopActiveStream: vi.fn()
  };

  const composer = createReaderChatComposer({
    els: { input, sendBtn },
    chatRuntime,
    ...overrides
  });

  composer.bind();
  composer.updateSendBtnState();

  return {
    input,
    sendBtn,
    chatRuntime,
    composer
  };
}

describe("createReaderChatComposer send/stop button logic", () => {
  it("空闲且输入框为空：发送键禁用，aria-label 为发送，无伴看相关状态类", () => {
    const { input, sendBtn } = setupComposer();

    expect(input.value).toBe("");
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(true);
  });

  it("输入框为空时按 Enter：不触发发送", () => {
    const { input, chatRuntime } = setupComposer();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
  });

  it("输入框有文字时：发送键可用，点击触发 sendTurn", () => {
    const { input, sendBtn, chatRuntime } = setupComposer();

    input.value = "你好，请解释这段视频";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(false);

    sendBtn.click();
    expect(chatRuntime.sendTurn).toHaveBeenCalledWith("你好，请解释这段视频");
  });

  it("流式输出期间：发送键切为停止键形态，点击调用 stopActiveStream", () => {
    const { sendBtn, composer, chatRuntime } = setupComposer();

    composer.setStreamingUiState(true);

    expect(sendBtn.classList.contains("is-stop")).toBe(true);
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("停止");
    expect(sendBtn.getAttribute("title")).toBe("停止生成");
    expect(sendBtn.disabled).toBe(false);

    sendBtn.click();
    expect(chatRuntime.stopActiveStream).toHaveBeenCalledTimes(1);

    composer.setStreamingUiState(false);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
  });

  it("停止请求立即显示正在停止并防连点，终态后恢复发送键", () => {
    const harness = setupComposer();
    const { sendBtn, composer, chatRuntime } = harness;
    chatRuntime.stopActiveStream.mockImplementation(() => composer.setStreamingUiState(true, { stopping: true }));
    composer.setStreamingUiState(true);

    sendBtn.click();
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.getAttribute("aria-label")).toBe("正在停止…");
    expect(sendBtn.getAttribute("title")).toBe("正在停止…");
    sendBtn.click();
    expect(chatRuntime.stopActiveStream).toHaveBeenCalledTimes(1);

    composer.setStreamingUiState(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(true);
  });

  it("字幕等待期间：显示可取消等待卡，输入框与占位符不变", () => {
    const { input, sendBtn, composer } = setupComposer();

    input.value = "有输入内容";
    composer.updateSendBtnState();
    composer.setSubtitleWaitUi(true);

    const card = input.closest(".chat-input-card")!.querySelector<HTMLElement>(".chat-subtitle-wait")!;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain("正在等待字幕，完成后自动发送");
    expect(sendBtn.disabled).toBe(true);
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("回车发送，Shift+Enter 换行");

    composer.setSubtitleWaitUi(false);
    expect(card.hidden).toBe(true);
    expect(sendBtn.disabled).toBe(false);
  });

  it("取消等待：调用既有 cancel 收口，显示短回执并把焦点移到草稿末尾", () => {
    let composer!: ReturnType<typeof createReaderChatComposer>;
    const onCancelSubtitleWait = vi.fn(() => composer.setSubtitleWaitUi(false));
    const onNotice = vi.fn();
    const harness = setupComposer({ onCancelSubtitleWait, onNotice });
    composer = harness.composer;
    harness.input.value = "保留草稿";
    composer.setSubtitleWaitUi(true);

    harness.input.closest(".chat-input-card")!.querySelector<HTMLButtonElement>(".chat-subtitle-wait-cancel")!.click();

    expect(onCancelSubtitleWait).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith("已取消等待，草稿与图片已保留", 3000);
    expect(harness.input.value).toBe("保留草稿");
    expect(document.activeElement).toBe(harness.input);
    expect(harness.input.selectionStart).toBe(harness.input.value.length);
  });

  it("等待中重复发送：ignored 转为明确反馈，不覆盖原等待卡", async () => {
    const onNotice = vi.fn();
    const { input, composer, chatRuntime } = setupComposer({ onNotice });
    chatRuntime.sendTurn.mockResolvedValue("ignored");
    input.value = "重复发送";
    composer.setSubtitleWaitUi(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("正在等待字幕，完成后自动发送", 3000));
    expect(input.closest(".chat-input-card")!.querySelector<HTMLElement>(".chat-subtitle-wait")!.hidden).toBe(false);
    expect(chatRuntime.sendTurn).toHaveBeenCalledTimes(1);
  });
});
