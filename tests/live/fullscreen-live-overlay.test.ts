import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFullscreenLiveOverlay } from "../../extension/live/fullscreen-live-overlay.js";
import type { LiveChatController } from "../../extension/live/live-chat-controller.js";

describe("live/fullscreen-live-overlay 全屏伴看浮窗", () => {
  let playerHost: HTMLElement;
  let mockController: Partial<LiveChatController>;
  let onStopLive: () => void;

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

    let muted = false;
    let shareAudio = true;
    let voicePriority = true;
    let volume = 0.8;
    let state = "connected" as const;

    mockController = {
      getState: () => state,
      isMuted: () => muted,
      toggleMute: vi.fn(() => {
        muted = !muted;
      }),
      getVolume: () => volume,
      setVolume: vi.fn((val: number) => {
        volume = val;
      }),
      isSharingVideoAudio: () => shareAudio,
      setShareVideoAudio: vi.fn((val: boolean) => {
        shareAudio = val;
      }),
      isVoicePriority: () => voicePriority,
      setVoicePriority: vi.fn((val: boolean) => {
        voicePriority = val;
      }),
      stop: vi.fn(async () => {})
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("show() 挂载浮窗节点并显示，默认位于右上角胶囊", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });

    expect(overlay.isVisible()).toBe(false);
    overlay.show();
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(true);

    const el = overlay.getElement();
    const capsule = overlay.getMiniCapsuleElement();
    expect(el).not.toBeNull();
    expect(capsule).not.toBeNull();
    expect(playerHost.contains(el)).toBe(true);
    expect(playerHost.contains(capsule)).toBe(true);
    expect(el?.id).toBe("biliscript-fullscreen-live-overlay");
    expect(el?.hidden).toBe(true);
    expect(capsule?.hidden).toBe(false);

    // 未拖动时，没有内联 left，依 CSS 默认贴右上角
    expect(el?.style.left).toBe("");
    expect(capsule?.style.left).toBe("");
  });

  it("头部状态胶囊展示连接状态，且点击结束伴看", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    const statusText = overlay.getElement()?.querySelector(".live-overlay-status-text");
    expect(statusText?.textContent).toBe("正在陪看");

    overlay.syncState("connecting");
    expect(statusText?.textContent).toBe("连接中...");

    overlay.syncState("failure");
    expect(statusText?.textContent).toBe("连接异常");

    overlay.syncState("connected", true); // reconnecting
    expect(statusText?.textContent).toBe("重连中...");

    const capsule = overlay.getElement()?.querySelector(".live-overlay-status-capsule") as HTMLElement;
    capsule.click();

    expect(onStopLive).not.toHaveBeenCalled();
    expect(overlay.isVisible()).toBe(true);
  });

  it("麦克风语音活动（VAD）动效类切换", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    const capsule = overlay.getElement()?.querySelector(".live-overlay-status-capsule");
    const micBtn = overlay.getElement()?.querySelector(".live-overlay-mic-btn");
    expect(capsule?.classList.contains("is-talking")).toBe(false);
    expect(micBtn?.classList.contains("is-talking")).toBe(false);

    overlay.updateVad(true);
    expect(capsule?.classList.contains("is-talking")).toBe(true);
    expect(micBtn?.classList.contains("is-talking")).toBe(true);

    overlay.updateVad(false);
    expect(capsule?.classList.contains("is-talking")).toBe(false);
    expect(micBtn?.classList.contains("is-talking")).toBe(false);
  });

  it("独立麦克风按钮与音频二级设置（音量滑轨、原声分享、语音优先）", () => {
    const onVolumeChange = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onVolumeChange,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    // 1. 喇叭左侧独立的麦克风按钮切换静音
    const micBtn = overlay.getElement()?.querySelector(".live-overlay-mic-btn") as HTMLButtonElement;
    expect(micBtn).not.toBeNull();
    expect(micBtn.getAttribute("aria-pressed")).toBe("false");

    micBtn.click();
    expect(mockController.toggleMute).toHaveBeenCalled();
    expect(micBtn.getAttribute("aria-pressed")).toBe("true");

    // 2. 喇叭按钮点击弹出二级菜单
    const audioBtn = overlay.getElement()?.querySelector(".live-overlay-audio-btn") as HTMLButtonElement;
    const popover = overlay.getElement()?.querySelector(".live-overlay-audio-popover") as HTMLElement;
    expect(popover.hidden).toBe(true);
    audioBtn.click();
    expect(popover.hidden).toBe(false);

    // 3. 二级菜单内音量滑轨调节
    const volumeSlider = popover.querySelector(".live-overlay-volume-slider") as HTMLInputElement;
    const volumeValue = popover.querySelector(".live-overlay-volume-value") as HTMLElement;
    expect(volumeSlider).not.toBeNull();
    expect(volumeSlider.value).toBe("80");
    expect(volumeValue.textContent).toBe("80%");

    volumeSlider.value = "65";
    volumeSlider.dispatchEvent(new Event("input"));
    expect(mockController.setVolume).toHaveBeenCalledWith(0.65);
    expect(onVolumeChange).toHaveBeenCalledWith(65);
    expect(volumeValue.textContent).toBe("65%");

    // 4. 原声分享与语音优先开关切换
    const shareSwitch = popover.querySelector(".live-overlay-share-switch") as HTMLButtonElement;
    shareSwitch.click();
    expect(mockController.setShareVideoAudio).toHaveBeenCalledWith(false);

    const prioSwitch = popover.querySelector(".live-overlay-priority-switch") as HTMLButtonElement;
    prioSwitch.click();
    expect(mockController.setVoicePriority).toHaveBeenCalledWith(false);
  });

  it("浮窗默认以微型状态胶囊出现，点击展开，点击最小化收回胶囊", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    const el = overlay.getElement();
    const capsule = overlay.getMiniCapsuleElement();

    // 默认胶囊出现
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.isVisible()).toBe(true);
    expect(capsule?.hidden).toBe(false);
    expect(el?.hidden).toBe(true);

    // 点击胶囊展开
    capsule?.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));

    expect(overlay.isMinimized()).toBe(false);
    expect(overlay.isVisible()).toBe(true);
    expect(capsule?.hidden).toBe(true);
    expect(el?.hidden).toBe(false);

    // 点击最小化按钮收回胶囊
    const minBtn = el?.querySelector(".live-overlay-min-btn") as HTMLButtonElement;
    minBtn.click();

    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.isVisible()).toBe(true);
    expect(capsule?.hidden).toBe(false);
    expect(el?.hidden).toBe(true);
  });

  it("关闭按钮彻底结束伴看并隐藏浮窗", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    expect(overlay.isVisible()).toBe(true);

    const closeBtn = overlay.getElement()?.querySelector(".live-overlay-close-btn") as HTMLButtonElement;
    closeBtn.click();

    expect(overlay.isVisible()).toBe(false);
    expect(onStopLive).toHaveBeenCalledTimes(1);
  });

  it("智能跟随滚动：离底大于阈值时暂停自动滚底并显示回底按键，点击平滑回底", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;
    const scrollBtn = overlay.getElement()?.querySelector(".live-overlay-scroll-bottom-btn") as HTMLButtonElement;

    expect(scrollBtn.hidden).toBe(true);

    // 模拟向上滚动
    Object.defineProperty(messages, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messages, "scrollTop", { value: 100, writable: true, configurable: true }); // dist = 200 > 60

    messages.dispatchEvent(new Event("scroll"));
    expect(scrollBtn.hidden).toBe(false);

    // 点击回底
    scrollBtn.click();
    expect(scrollBtn.hidden).toBe(true);
  });

  it("纯语音对话流转写更新：用户绿气泡与 Agent 流式气泡，浮窗不提供清空按钮", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
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

    // 3. 不提供清空按钮，但提供 clearMessages 方法用于房间切换等程序清空
    expect(overlay.getElement()?.querySelector(".live-overlay-clear-btn")).toBeNull();
    overlay.clearMessages();
    expect(messages.children.length).toBe(0);
  });

  it("麦克风未激活（isVoiceRecentlyActive 为 false）时拦截纯背景原声的 input 转写", () => {
    let voiceActive = false;
    mockController.isVoiceRecentlyActive = () => voiceActive;

    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
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

  it("网页全屏时优先挂载到实际 bpx 播放器容器，而非外层 player-wrap", () => {
    const playerWrap = document.createElement("div");
    playerWrap.id = "playerWrap";
    playerWrap.className = "player-wrap";
    document.body.appendChild(playerWrap);
    playerWrap.appendChild(playerHost);
    playerHost.setAttribute("data-screen", "web");

    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerWrap,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    expect(playerHost.contains(overlay.getElement())).toBe(true);
    expect(playerWrap.contains(overlay.getElement())).toBe(true);
  });

  it("共享轮次状态机守卫：拦截空文本流式包、补建直达 output.done 气泡并丢弃打断后的迟到分片", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;

    // 1. 空文本 output.updated 不应提前创建空 DOM 气泡
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "r-empty",
      turnId: "t-1",
      text: ""
    });
    expect(messages.querySelectorAll(".live-overlay-bubble-assistant")).toHaveLength(0);

    // 2. 无前置 output.updated 直接到达非空 output.done 时自动补建定稿气泡
    overlay.updateTranscript({
      kind: "output.done",
      runId: "r-direct",
      turnId: "t-1",
      text: "直达定稿回复"
    });
    const bubblesAfterDirect = messages.querySelectorAll(".live-overlay-bubble-assistant");
    expect(bubblesAfterDirect).toHaveLength(1);
    expect(bubblesAfterDirect[0].textContent).toBe("直达定稿回复");
    expect(bubblesAfterDirect[0].classList.contains("is-streaming")).toBe(false);

    // 3. 打断后迟到的同轮次 output.updated / output.done 不得再冒出幽灵气泡
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "r-int",
      turnId: "t-2",
      text: "说到一半"
    });
    overlay.updateTranscript({
      kind: "response.interrupted",
      runId: "r-int",
      turnId: "t-2"
    });
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "r-int",
      turnId: "t-2",
      text: "打断后迟到的幽灵分片"
    });
    overlay.updateTranscript({
      kind: "output.done",
      runId: "r-int",
      turnId: "t-2",
      text: "打断后迟到的定稿"
    });

    const allAssistantBubbles = messages.querySelectorAll(".live-overlay-bubble-assistant");
    expect(allAssistantBubbles).toHaveLength(2);
    expect(allAssistantBubbles[1].textContent).toBe("说到一半");
    expect(allAssistantBubbles[1].classList.contains("is-streaming")).toBe(false);
  });

  it("未拖动时贴右上角，拖动后以相对右上角偏移保存，容器尺寸变化（进出全屏）保持偏移", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    const capsule = overlay.getMiniCapsuleElement()!;
    capsule.getBoundingClientRect = () => ({
      left: 900,
      top: 16,
      right: 984,
      bottom: 44,
      width: 84,
      height: 28,
      x: 900,
      y: 16,
      toJSON: () => {}
    });

    // 1. 未拖动时，没有 inline left，依靠 CSS 贴右上角
    expect(capsule.style.left).toBe("");

    // 2. 拖动胶囊向左 40px, 向下 30px (clientX: 950 -> 910, clientY: 20 -> 50)
    capsule.dispatchEvent(new PointerEvent("pointerdown", { clientX: 950, clientY: 20 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 910, clientY: 50 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 910, clientY: 50 }));

    // 初始距离右边: 1000 - 984 = 16px. deltaX = -40, nextRight = 16 - (-40) = 56px.
    // 初始距离顶边: 16px. deltaY = +30, nextTop = 16 + 30 = 46px.
    expect(capsule.style.right).toBe("56px");
    expect(capsule.style.top).toBe("46px");
    expect(capsule.style.left).toBe("auto");

    // 3. 点击胶囊展开，展开态也继承该右上角偏移
    const el = overlay.getElement()!;
    el.getBoundingClientRect = () => ({
      left: 624,
      top: 46,
      right: 944,
      bottom: 446,
      width: 320,
      height: 400,
      x: 624,
      y: 46,
      toJSON: () => {}
    });
    capsule.dispatchEvent(new PointerEvent("pointerdown", { clientX: 910, clientY: 50 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 910, clientY: 50 }));

    expect(overlay.isMinimized()).toBe(false);
    expect(el.style.right).toBe("56px");
    expect(el.style.top).toBe("46px");
    expect(el.style.left).toBe("auto");

    // 4. 模拟容器尺寸改变（如进入全屏：1000px -> 1920px）
    playerHost.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    // 浮窗 inline style.right 仍为 56px，保持与右上角偏移，不使用像素 left
    expect(el.style.right).toBe("56px");
    expect(el.style.top).toBe("46px");
    expect(el.style.left).toBe("auto");
  });

  it("消息区不读取面板历史，只显示自身转写与回复，clearMessages 仅清空浮窗自身", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;
    // 初始没有面板历史消息
    expect(messages.children.length).toBe(0);

    // 伴看转写上屏
    overlay.updateTranscript({
      kind: "input.done",
      text: "伴看专属转写"
    });
    overlay.updateTranscript({
      kind: "output.done",
      runId: "r1",
      turnId: "t1",
      text: "伴看专属回复"
    });

    expect(messages.children.length).toBe(2);
    expect(messages.querySelector(".live-overlay-bubble-user")?.textContent).toBe("伴看专属转写");
    expect(messages.querySelector(".live-overlay-bubble-assistant")?.textContent).toBe("伴看专属回复");

    // 清空浮窗消息
    overlay.clearMessages();
    expect(messages.children.length).toBe(0);
  });
});
