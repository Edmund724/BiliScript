import { describe, expect, it, vi } from "vitest";
import { createReaderChatComposer } from "../../extension/reader/chat-tab-composer.js";

function setupComposer(overrides: Partial<Parameters<typeof createReaderChatComposer>[0]> = {}) {
  const input = document.createElement("textarea");
  input.placeholder = "回车发送，Shift+Enter 换行";
  const sendBtn = document.createElement("button");
  const liveSwitchBtn = document.createElement("button");
  liveSwitchBtn.hidden = true;

  const chatRuntime = {
    sendTurn: vi.fn(async () => "ok"),
    isTurnActive: vi.fn(() => false),
    stopActiveStream: vi.fn()
  };

  const onStartLive = vi.fn();
  const onSwitchToLive = vi.fn();
  const onInterruptLive = vi.fn();

  let liveActive = false;
  let liveConnecting = false;

  const composer = createReaderChatComposer({
    els: { input, sendBtn, liveSwitchBtn },
    chatRuntime,
    isLiveActive: () => liveActive,
    isLiveConnecting: () => liveConnecting,
    onStartLive,
    onSwitchToLive,
    onInterruptLive,
    ...overrides
  });

  composer.bind();
  composer.updateSendBtnState();

  return {
    input,
    sendBtn,
    liveSwitchBtn,
    chatRuntime,
    composer,
    onStartLive,
    onSwitchToLive,
    onInterruptLive,
    setLiveActive: (v: boolean) => {
      liveActive = v;
      composer.updateSendBtnState();
    },
    setLiveConnecting: (v: boolean) => {
      liveConnecting = v;
      composer.updateSendBtnState();
    }
  };
}

describe("createReaderChatComposer multi-state button logic", () => {
  it("空闲且输入框为空：发送键自动变为开启实时伴看键，点击触发 onStartLive", () => {
    const { input, sendBtn, onStartLive } = setupComposer();

    expect(input.value).toBe("");
    expect(sendBtn.classList.contains("is-live")).toBe(true);
    expect(sendBtn.getAttribute("aria-label")).toBe("开启实时伴看");
    expect(sendBtn.disabled).toBe(false);

    sendBtn.click();
    expect(onStartLive).toHaveBeenCalledTimes(1);
  });

  it("输入框为空时按 Enter：不触发发送也不触发伴看", () => {
    const { input, chatRuntime, onStartLive } = setupComposer();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
    expect(onStartLive).not.toHaveBeenCalled();
  });

  it("输入框有文字时：伴看开关消失，切回发送键", () => {
    const { input, sendBtn, chatRuntime, onStartLive } = setupComposer();

    input.value = "你好，请解释这段视频";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(false);

    sendBtn.click();
    expect(chatRuntime.sendTurn).toHaveBeenCalledWith("你好，请解释这段视频");
    expect(onStartLive).not.toHaveBeenCalled();
  });

  it("流式输出期间：右侧恒为停止键，其左侧出现切换伴看按钮，点击调用 onSwitchToLive", () => {
    const { sendBtn, liveSwitchBtn, composer, chatRuntime, onSwitchToLive } = setupComposer();

    composer.setStreamingUiState(true);

    expect(sendBtn.classList.contains("is-stop")).toBe(true);
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("停止");
    expect(liveSwitchBtn.hidden).toBe(false);

    liveSwitchBtn.click();
    expect(onSwitchToLive).toHaveBeenCalledTimes(1);

    sendBtn.click();
    expect(chatRuntime.stopActiveStream).toHaveBeenCalledTimes(1);

    composer.setStreamingUiState(false);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);
    expect(liveSwitchBtn.hidden).toBe(true);
  });

  it("伴看建连中（connecting）：按键展示转圈加载态并禁用防重", () => {
    const { sendBtn, setLiveConnecting } = setupComposer();

    setLiveConnecting(true);

    expect(sendBtn.classList.contains("is-connecting")).toBe(true);
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.getAttribute("aria-label")).toBe("正在连接伴看...");

    setLiveConnecting(false);
    expect(sendBtn.classList.contains("is-connecting")).toBe(false);
  });

  it("伴看运行中（connected）：AI说话时为打断键，空闲且无字时禁用，有字时切回发送键", () => {
    const { input, sendBtn, setLiveActive, onInterruptLive, chatRuntime } = setupComposer();

    setLiveActive(true);

    // 空闲且无字：禁用（结束会话由上方 End 负责）
    expect(input.value).toBe("");
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.disabled).toBe(true);

    // AI说话中（控制器挂 is-live-interrupt）
    sendBtn.classList.add("is-live-interrupt");
    setLiveActive(true);
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("打断当前回答");
    sendBtn.click();
    expect(onInterruptLive).toHaveBeenCalledTimes(1);

    // AI静止，用户输入文字：切回发送键
    sendBtn.classList.remove("is-live-interrupt");
    input.value = "向伴看提个文字问题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");

    sendBtn.click();
    expect(chatRuntime.sendTurn).toHaveBeenCalledWith("向伴看提个文字问题");
  });
});
