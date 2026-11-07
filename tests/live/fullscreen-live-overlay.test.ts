import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFullscreenLiveOverlay } from "../../extension/live/fullscreen-live-overlay.js";
import type { LiveChatController } from "../../extension/live/live-chat-controller.js";

describe("live/fullscreen-live-overlay 全屏伴看浮窗", () => {
  let playerHost: HTMLElement;
  let mockController: Partial<LiveChatController>;
  let onStopLive: () => void;
  let onClearHistory: () => Promise<void>;

  beforeEach(() => {
    document.body.innerHTML = "";
    playerHost = document.createElement("div");
    playerHost.className = "bpx-player-container";
    // Mock getBoundingClientRect
    playerHost.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => {}
    });
    document.body.appendChild(playerHost);

    onStopLive = vi.fn();
    onClearHistory = vi.fn(async () => {});

    let muted = false;
    let shareAudio = true;
    let voicePriority = true;
    let state = "connected" as const;

    mockController = {
      getState: () => state,
      isMuted: () => muted,
      toggleMute: vi.fn(() => {
        muted = !muted;
      }),
      isSharingVideoAudio: () => shareAudio,
      setShareVideoAudio: vi.fn((val: boolean) => {
        shareAudio = val;
      }),
      isVoicePriority: () => voicePriority,
      setVoicePriority: vi.fn((val: boolean) => {
        voicePriority = val;
      }),
      stop: vi.fn(async () => {}),
      resetMerger: vi.fn()
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("show() 挂载浮窗节点并显示，默认位于右上角", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });

    expect(overlay.isVisible()).toBe(false);
    overlay.show();
    expect(overlay.isVisible()).toBe(true);

    const el = overlay.getElement();
    expect(el).not.toBeNull();
    expect(playerHost.contains(el)).toBe(true);
    expect(el?.id).toBe("biliscript-fullscreen-live-overlay");
  });

  it("头部状态胶囊展示连接状态，且点击结束伴看", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    const statusText = overlay.getElement()?.querySelector(".live-overlay-status-text");
    expect(statusText?.textContent).toBe("正在陪看");

    overlay.syncState("connecting");
    expect(statusText?.textContent).toBe("连接中...");

    overlay.syncState("failure");
    expect(statusText?.textContent).toBe("连接异常");

    overlay.syncState("connected", true); // reconnecting
    expect(statusText?.textContent).toBe("重连中...");

    const capsule = overlay.getElement()?.querySelector(".live-overlay-status-capsule") as HTMLButtonElement;
    capsule.click();

    expect(onStopLive).toHaveBeenCalledTimes(1);
    expect(overlay.isVisible()).toBe(false);
  });

  it("麦克风语音活动（VAD）动效类切换", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    const capsule = overlay.getElement()?.querySelector(".live-overlay-status-capsule");
    expect(capsule?.classList.contains("is-talking")).toBe(false);

    overlay.updateVad(true);
    expect(capsule?.classList.contains("is-talking")).toBe(true);

    overlay.updateVad(false);
    expect(capsule?.classList.contains("is-talking")).toBe(false);
  });

  it("音频快捷设置入口弹出与切换（静音、原声分享、语音优先）", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    const audioBtn = overlay.getElement()?.querySelector(".live-overlay-audio-btn") as HTMLButtonElement;
    const popover = overlay.getElement()?.querySelector(".live-overlay-audio-popover") as HTMLElement;

    expect(popover.hidden).toBe(true);
    audioBtn.click();
    expect(popover.hidden).toBe(false);

    const muteSwitch = popover.querySelector(".live-overlay-mute-switch") as HTMLButtonElement;
    muteSwitch.click();
    expect(mockController.toggleMute).toHaveBeenCalled();

    const shareSwitch = popover.querySelector(".live-overlay-share-switch") as HTMLButtonElement;
    shareSwitch.click();
    expect(mockController.setShareVideoAudio).toHaveBeenCalledWith(false);

    const prioSwitch = popover.querySelector(".live-overlay-priority-switch") as HTMLButtonElement;
    prioSwitch.click();
    expect(mockController.setVoicePriority).toHaveBeenCalledWith(false);
  });

  it("最小化按钮收起与展开对话流", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    const minBtn = overlay.getElement()?.querySelector(".live-overlay-min-btn") as HTMLButtonElement;
    const body = overlay.getElement()?.querySelector(".live-overlay-body") as HTMLElement;

    expect(overlay.isMinimized()).toBe(false);
    expect(body.hidden).toBe(false);

    minBtn.click();
    expect(overlay.isMinimized()).toBe(true);
    expect(body.hidden).toBe(true);

    minBtn.click();
    expect(overlay.isMinimized()).toBe(false);
    expect(body.hidden).toBe(false);
  });

  it("关闭按钮仅隐藏浮窗，不调用 stopLive", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();
    expect(overlay.isVisible()).toBe(true);

    const closeBtn = overlay.getElement()?.querySelector(".live-overlay-close-btn") as HTMLButtonElement;
    closeBtn.click();

    expect(overlay.isVisible()).toBe(false);
    expect(onStopLive).not.toHaveBeenCalled();
    expect(mockController.stop).not.toHaveBeenCalled();
  });

  it("纯语音对话流转写更新：用户绿气泡与 Agent 流式气泡，以及清空按钮", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    // 1. 用户语音转写中与落定
    overlay.updateTranscript({
      kind: "input.updated",
      text: "你能看到画面吗？"
    });

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;
    let userBubble = messages.querySelector(".live-overlay-bubble-user");
    expect(userBubble).not.toBeNull();
    expect(userBubble?.textContent).toBe("你能看到画面吗？");
    expect(userBubble?.classList.contains("is-pending")).toBe(true);

    overlay.updateTranscript({
      kind: "input.done",
      text: "你能看到画面里的猫吗？"
    });
    expect(userBubble?.textContent).toBe("你能看到画面里的猫吗？");
    expect(userBubble?.classList.contains("is-pending")).toBe(false);

    // 2. Agent 流式回复转写
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "run-1",
      turnId: "turn-1",
      text: "我看到了，"
    });
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "run-1",
      turnId: "turn-1",
      text: "我看到了，是一只橘猫！"
    });

    let assistantBubble = messages.querySelector(".live-overlay-bubble-assistant");
    expect(assistantBubble).not.toBeNull();
    expect(assistantBubble?.textContent).toBe("我看到了，是一只橘猫！");

    overlay.updateTranscript({
      kind: "output.done",
      runId: "run-1",
      turnId: "turn-1",
      text: "我看到了，是一只可爱的橘猫！"
    });
    expect(assistantBubble?.textContent).toBe("我看到了，是一只可爱的橘猫！");

    // 3. 点击清空按钮
    const clearBtn = overlay.getElement()?.querySelector(".live-overlay-clear-btn") as HTMLButtonElement;
    clearBtn.click();

    expect(messages.children.length).toBe(0);
    expect(onClearHistory).toHaveBeenCalledTimes(1);
    expect(mockController.resetMerger).toHaveBeenCalledTimes(1);
  });

  it("麦克风未激活（isVoiceRecentlyActive 为 false）时拦截纯背景原声的 input 转写", () => {
    let voiceActive = false;
    mockController.isVoiceRecentlyActive = () => voiceActive;

    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive,
      onClearHistory
    });
    overlay.show();

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;

    // 1. 麦克风静默期间的背景主播人声转写被拦截，不生成绿色用户气泡
    overlay.updateTranscript({ kind: "input.updated", text: "主播正在说话" });
    overlay.updateTranscript({ kind: "input.done", text: "主播正在说话" });
    expect(messages.querySelector(".live-overlay-bubble-user")).toBeNull();

    // 2. 麦克风激活后正常上屏
    voiceActive = true;
    overlay.updateTranscript({ kind: "input.updated", text: "我在说话" });
    expect(messages.querySelector(".live-overlay-bubble-user")?.textContent).toBe("我在说话");
  });
});
