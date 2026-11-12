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
  let liveState: "idle" | "connecting" | "connected" | "failure" = "idle";
  const onStartLive = vi.fn(() => {
    liveState = "connecting";
    composer.updateSendBtnState();
  });

  const composer = createReaderChatComposer({
    els: { input, sendBtn },
    chatRuntime,
    getLiveState: () => liveState,
    onStartLive,
    ...overrides
  });

  composer.bind();
  composer.updateSendBtnState();

  return {
    input,
    sendBtn,
    chatRuntime,
    composer,
    onStartLive,
    setLiveState: (state: typeof liveState) => {
      liveState = state;
      composer.updateSendBtnState();
    }
  };
}

describe("createReaderChatComposer send/stop button logic", () => {
  it("idle 空草稿：同一按钮显示可聚焦的麦克风，点击启动并在 connecting 防连点", () => {
    const { input, sendBtn, onStartLive } = setupComposer();

    expect(input.value).toBe("");
    expect(sendBtn.classList.contains("is-live")).toBe(true);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("开启实时伴看");
    expect(sendBtn.title).toBe("开启实时伴看");
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.tabIndex).toBe(0);

    sendBtn.focus();
    expect(document.activeElement).toBe(sendBtn);
    sendBtn.click();
    expect(onStartLive).toHaveBeenCalledTimes(1);
    expect(sendBtn.classList.contains("is-connecting")).toBe(true);
    expect(sendBtn.getAttribute("aria-busy")).toBe("true");
    expect(sendBtn.getAttribute("aria-label")).toBe("正在连接伴看…");
    expect(sendBtn.disabled).toBe(true);

    sendBtn.click();
    expect(onStartLive).toHaveBeenCalledTimes(1);
  });

  it("输入框为空时按 Enter：不触发发送也不启动伴看", () => {
    const { input, chatRuntime, onStartLive } = setupComposer();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
    expect(onStartLive).not.toHaveBeenCalled();
  });

  it("输入框有文字时：切回发送键，点击触发 sendTurn 而不启动伴看", () => {
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

  it("connected 与 failure 不显示启动键，回 idle 才恢复；状态切换不清草稿", () => {
    const { input, sendBtn, setLiveState } = setupComposer();
    input.value = "保留这段草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    setLiveState("connected");
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(false);
    expect(input.value).toBe("保留这段草稿");

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.disabled).toBe(true);

    setLiveState("failure");
    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-busy")).toBeNull();
    expect(sendBtn.disabled).toBe(true);

    setLiveState("idle");
    expect(sendBtn.classList.contains("is-live")).toBe(true);
    expect(sendBtn.disabled).toBe(false);
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
    expect(sendBtn.getAttribute("aria-label")).toBe("开启实时伴看");
  });

  it("停止请求立即显示正在停止并防连点，终态后恢复空草稿麦克风", () => {
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
    expect(sendBtn.getAttribute("aria-label")).toBe("开启实时伴看");
    expect(sendBtn.disabled).toBe(false);
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


describe("图片发送守卫", () => {
  it("图片处理中：发送键禁用并说明原因，Enter 不发送且给出同样反馈", () => {
    const onNotice = vi.fn();
    const { input, sendBtn, chatRuntime } = setupComposer({
      isImageProcessing: () => true,
      hasInputImages: () => true,
      onNotice
    });
    input.value = "分析这张图";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.title).toBe("图片处理中…");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("图片处理中…", 3000);
  });

  it("处理完成后重新同步：发送键恢复并可发出文字与附件所在回合", () => {
    let processing = true;
    const { input, sendBtn, composer, chatRuntime } = setupComposer({
      isImageProcessing: () => processing,
      hasInputImages: () => true
    });
    input.value = "分析这张图";
    composer.updateSendBtnState();
    expect(sendBtn.disabled).toBe(true);

    processing = false;
    composer.updateSendBtnState();
    sendBtn.click();

    expect(sendBtn.disabled).toBe(false);
    expect(chatRuntime.sendTurn).toHaveBeenCalledWith("分析这张图");
  });

  it("只有图片没有正文：Enter 明确提示需随文字发送，不进入运行时", () => {
    const onNotice = vi.fn();
    const { input, sendBtn, chatRuntime } = setupComposer({
      hasInputImages: () => true,
      onNotice
    });
    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(sendBtn.classList.contains("is-live")).toBe(false);
    expect(sendBtn.getAttribute("aria-label")).toBe("发送");
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.title).toBe("图片需随文字一起发送");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("图片需随文字一起发送", 3000);
  });

  it("自动发送入口同样不能在图片处理中越过守卫", async () => {
    const onNotice = vi.fn();
    const { composer, chatRuntime } = setupComposer({
      isImageProcessing: () => true,
      hasInputImages: () => true,
      onNotice
    });

    await expect(composer.sendViaInputBox("分析这张图")).resolves.toBe(false);

    expect(chatRuntime.sendTurn).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith("图片处理中…", 3000);
  });
});
