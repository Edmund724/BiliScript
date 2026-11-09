import { describe, expect, it, vi } from "vitest";
import { createReaderChatComposer } from "../../extension/reader/chat-tab-composer.js";

function setupComposer(overrides: Partial<Parameters<typeof createReaderChatComposer>[0]> = {}) {
  const input = document.createElement("textarea");
  input.placeholder = "回车发送，Shift+Enter 换行";
  const sendBtn = document.createElement("button");

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

  it("字幕等待期间：发送键禁用且占位符显示等待文案", () => {
    const { input, sendBtn, composer } = setupComposer();

    input.value = "有输入内容";
    composer.updateSendBtnState();
    expect(sendBtn.disabled).toBe(false);

    composer.setSubtitleWaitUi(true);
    expect(sendBtn.disabled).toBe(true);
    expect(input.placeholder).toBe("正在抓取字幕…");

    composer.setSubtitleWaitUi(false);
    expect(sendBtn.disabled).toBe(false);
    expect(input.placeholder).toBe("回车发送，Shift+Enter 换行");
  });
});
