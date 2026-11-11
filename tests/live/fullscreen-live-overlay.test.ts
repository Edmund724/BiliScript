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
    let speed = 1.25;
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
      getSpeed: () => speed,
      setSpeed: vi.fn((val: number) => {
        speed = val;
      }),
      isSharingVideoAudio: () => shareAudio,
      getVideoAudioStatus: () => "已获取音轨",
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
    expect(statusText?.textContent).toBe("正在伴看");

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

  it("按失败原因提供匹配的主次动作", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController
    });
    overlay.show({ forceExpand: true });
    const cases = [
      ["provider-unconfigured", "设置伴看", null, "settings"],
      ["key-missing", "填写 Key", "重试", "settings"],
      ["key-rejected", "检查 Key", "重试", "settings"],
      ["gemini-credential", "设置 Gemini Key", "重试", "settings"],
      ["permission-denied", "设置伴看", "重新授权", "retry"],
      ["microphone", null, "重试", "retry"],
      ["network", null, "重试", "retry"]
    ] as const;

    for (const [kind, settingsLabel, retryLabel, primary] of cases) {
      overlay.syncState("failure", false, "失败原因", kind);
      const root = overlay.getElement()!;
      const settings = root.querySelector<HTMLButtonElement>(".live-overlay-settings-btn")!;
      const retry = root.querySelector<HTMLButtonElement>(".live-overlay-retry-btn")!;
      expect(settings.hidden).toBe(settingsLabel === null);
      if (settingsLabel) expect(settings.textContent).toBe(settingsLabel);
      expect(retry.hidden).toBe(retryLabel === null);
      if (retryLabel) expect(retry.textContent).toBe(retryLabel);
      expect(settings.dataset.primaryAction).toBe(String(primary === "settings"));
      expect(retry.dataset.primaryAction).toBe(String(primary === "retry"));
    }
  });

  it("unknown 失败不向浮窗回显外部错误中的凭据", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController
    });
    overlay.show({ forceExpand: true });

    overlay.syncState("failure", false, "启动失败：apiKey=sk-live-secret", "unknown");

    const card = overlay.getElement()!.querySelector<HTMLElement>(".live-overlay-failure-card")!;
    expect(card.querySelector(".live-overlay-failure-reason")?.textContent).toBe("实时伴看启动失败，请重试");
    expect(card.textContent).not.toContain("sk-live-secret");
    expect(card.textContent).not.toContain("apiKey");
  });

  it("设置动作区分实时伴看配置与 Gemini Key 目标", () => {
    const onOpenLiveSettings = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onOpenLiveSettings
    });
    overlay.show({ forceExpand: true });
    const settings = overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-settings-btn")!;

    overlay.syncState("failure", false, "缺少 Key", "key-missing");
    settings.click();
    expect(onOpenLiveSettings).toHaveBeenLastCalledWith("live");

    overlay.syncState("failure", false, "Gemini 凭据失效", "gemini-credential");
    settings.click();
    expect(onOpenLiveSettings).toHaveBeenLastCalledWith("gemini-key");
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

    const micBtn = overlay.getElement()?.querySelector(".live-overlay-mic-btn") as HTMLButtonElement;
    expect(micBtn.getAttribute("aria-pressed")).toBe("false");
    micBtn.click();
    expect(mockController.toggleMute).toHaveBeenCalled();
    expect(micBtn.getAttribute("aria-pressed")).toBe("true");

    const audioBtn = overlay.getElement()?.querySelector(".live-overlay-audio-btn") as HTMLButtonElement;
    const popover = overlay.getElement()?.querySelector(".live-overlay-audio-popover") as HTMLElement;
    expect(audioBtn.getAttribute("aria-controls")).toBe(popover.id);
    expect(audioBtn.getAttribute("aria-expanded")).toBe("false");
    expect(popover.hidden).toBe(true);
    audioBtn.click();
    expect(popover.hidden).toBe(false);
    expect(audioBtn.getAttribute("aria-expanded")).toBe("true");

    const volumeSlider = popover.querySelector(".live-overlay-volume-slider") as HTMLInputElement;
    const volumeValue = popover.querySelector(".live-overlay-volume-value") as HTMLElement;
    expect(volumeSlider.value).toBe("80");
    expect(volumeValue.textContent).toBe("80%");

    volumeSlider.value = "65";
    volumeSlider.dispatchEvent(new Event("input"));
    expect(mockController.setVolume).toHaveBeenCalledWith(0.65);
    expect(onVolumeChange).not.toHaveBeenCalled();
    expect(volumeValue.textContent).toBe("65%");
    volumeSlider.dispatchEvent(new Event("change"));
    expect(onVolumeChange).toHaveBeenCalledTimes(1);
    expect(onVolumeChange).toHaveBeenCalledWith(65);

    const shareSwitch = popover.querySelector(".live-overlay-share-switch") as HTMLButtonElement;
    shareSwitch.click();
    expect(mockController.setShareVideoAudio).toHaveBeenCalledWith(false);

    const prioSwitch = popover.querySelector(".live-overlay-priority-switch") as HTMLButtonElement;
    prioSwitch.click();
    expect(mockController.setVoicePriority).toHaveBeenCalledWith(false);
    overlay.dispose();
  });

  it("Esc 与外点只关闭音频弹层并回焦，不结束伴看", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const audioBtn = root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    Object.defineProperty(popover, "showPopover", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("native popover unavailable");
      })
    });
    audioBtn.click();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(audioBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(audioBtn);
    expect(onStopLive).not.toHaveBeenCalled();

    audioBtn.click();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(audioBtn);
    expect(onStopLive).not.toHaveBeenCalled();
    overlay.dispose();
  });

  it("fixed fallback 在下方空间不足时向上翻转并约束视口边界", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1000);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(400);
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const audioBtn = root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    audioBtn.getBoundingClientRect = () => ({
      left: 860, top: 300, right: 900, bottom: 340, width: 40, height: 40, x: 860, y: 300, toJSON: () => {}
    });
    popover.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180, x: 0, y: 0, toJSON: () => {}
    });

    audioBtn.click();

    expect(popover.dataset.placement).toBe("top");
    expect(popover.style.left).toBe("580px");
    expect(popover.style.top).toBe("114px");
    expect(popover.style.maxHeight).toBe("286px");
    expect(popover.parentElement).toBe(document.body);
    overlay.dispose();
  });

  it("真实无音轨时保留分享开关和语音伴看，仅显示状态提示", () => {
    mockController.getVideoAudioStatus = () => "未检测到音轨";
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!.click();
    const share = popover.querySelector<HTMLButtonElement>(".live-overlay-share-switch")!;
    const priority = popover.querySelector<HTMLButtonElement>(".live-overlay-priority-switch")!;
    const status = popover.querySelector<HTMLElement>(".live-overlay-audio-status")!;

    expect(share.getAttribute("aria-checked")).toBe("true");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("未采到视频音轨；仍可语音伴看");
    priority.click();
    expect(mockController.setVoicePriority).toHaveBeenCalledWith(false);
    expect(mockController.setShareVideoAudio).not.toHaveBeenCalled();
    overlay.dispose();
  });

  it("音频弹层提供伴看平台与密钥入口", () => {
    const onOpenLiveSettings = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onOpenLiveSettings
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const settingsButton = root.querySelector<HTMLButtonElement>(".live-overlay-audio-settings-btn")!;
    root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!.click();
    settingsButton.click();

    expect(onOpenLiveSettings).toHaveBeenCalledWith("live");
    expect(document.querySelector<HTMLElement>(".live-overlay-audio-popover")?.hidden).toBe(true);
    overlay.dispose();
  });

  it("支持 200% 音量与五档吸附语速，并同步服务端调速", () => {
    const onSpeedChange = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onSpeedChange,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const popover = overlay.getElement()?.querySelector(".live-overlay-audio-popover") as HTMLElement;
    const volumeSlider = popover.querySelector(".live-overlay-volume-slider") as HTMLInputElement;
    expect(volumeSlider.max).toBe("200");
    volumeSlider.value = "150";
    volumeSlider.dispatchEvent(new Event("input"));
    expect(mockController.setVolume).toHaveBeenCalledWith(1.5);

    const speedSlider = popover.querySelector(".live-overlay-speed-slider") as HTMLInputElement;
    const speedValue = popover.querySelector(".live-overlay-speed-value") as HTMLElement;
    expect(speedSlider.min).toBe("0");
    expect(speedSlider.max).toBe("4");
    expect(speedSlider.step).toBe("1");
    expect(speedSlider.value).toBe("3");
    expect(speedValue.textContent).toBe("1.25×");

    speedSlider.value = "0";
    speedSlider.dispatchEvent(new Event("input"));
    expect(mockController.setSpeed).toHaveBeenCalledWith(0.5);
    expect(onSpeedChange).toHaveBeenCalledWith(0.5);
    expect(speedValue.textContent).toBe("0.5×");

    mockController.getSpeed = () => 1.5;
    overlay.syncState();
    expect(speedSlider.value).toBe("4");
    expect(speedValue.textContent).toBe("1.5×");
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

  it("原生按钮激活只展开，焦点往返并同步 ARIA、hidden 与 inert", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    const root = overlay.getElement()!;
    const capsule = overlay.getMiniCapsuleElement() as HTMLButtonElement;
    const minButton = root.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!;
    expect(capsule.tagName).toBe("BUTTON");
    expect(capsule.getAttribute("role")).toBeNull();
    expect(capsule.getAttribute("tabindex")).toBeNull();
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(capsule.getAttribute("aria-controls")).toBe(root.id);
    expect(capsule.getAttribute("aria-label")).toContain("正在伴看");
    expect(root.nextElementSibling).toBe(capsule);
    expect(root.hasAttribute("inert")).toBe(true);
    expect(capsule.hasAttribute("inert")).toBe(false);

    capsule.click();

    expect(onStopLive).not.toHaveBeenCalled();
    expect(overlay.isMinimized()).toBe(false);
    expect(document.activeElement).toBe(minButton);
    expect(capsule.getAttribute("aria-expanded")).toBe("true");
    expect(minButton.getAttribute("aria-expanded")).toBe("true");
    expect(minButton.getAttribute("aria-controls")).toBe(root.id);
    expect(minButton.getAttribute("aria-label")).toBe("最小化伴看浮窗");
    expect(root.hidden).toBe(false);
    expect(root.hasAttribute("inert")).toBe(false);
    expect(capsule.hidden).toBe(true);
    expect(capsule.hasAttribute("inert")).toBe(true);
    root.querySelectorAll("svg").forEach((svg) => {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    });

    minButton.click();

    expect(overlay.isMinimized()).toBe(true);
    expect(document.activeElement).toBe(capsule);
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(minButton.getAttribute("aria-expanded")).toBe("false");
    expect(root.hidden).toBe(true);
    expect(root.hasAttribute("inert")).toBe(true);
    expect(capsule.hidden).toBe(false);
    expect(capsule.hasAttribute("inert")).toBe(false);
  });

  it("迷你胶囊显示连接、重连与麦克风静音文本", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();
    const capsule = overlay.getMiniCapsuleElement()!;
    const status = capsule.querySelector(".live-overlay-mini-status-text");
    const mic = capsule.querySelector(".live-overlay-mini-mic-text");

    expect(status?.textContent).toBe("正在伴看");
    expect(mic?.textContent).toBe("麦克风已开启");
    overlay.syncState("connecting");
    expect(status?.textContent).toBe("连接中");
    overlay.syncState("connected", true);
    expect(status?.textContent).toBe("重连中");
    overlay.syncState("connected");
    expect(status?.textContent).toBe("正在伴看");

    capsule.click();
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-mic-btn")!.click();
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();

    expect(mic?.textContent).toBe("麦克风已静音");
    expect(capsule.getAttribute("aria-label")).toContain("麦克风已静音");
    expect(onStopLive).not.toHaveBeenCalled();
  });

  it("连接或失败活跃时隐藏与切换只进入胶囊，空闲才完全隐藏", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });

    overlay.hide();
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.getMiniCapsuleElement()?.hidden).toBe(false);

    overlay.toggle();
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(true);

    overlay.syncState("idle");
    overlay.hide();
    expect(overlay.isVisible()).toBe(false);
    expect(overlay.getElement()?.hasAttribute("inert")).toBe(true);
    expect(overlay.getMiniCapsuleElement()?.hasAttribute("inert")).toBe(true);
  });

  it("失败强制展开错误卡，处理后恢复迷你偏好且后台同步不抢焦点", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    overlay.show();
    outsideButton.focus();

    overlay.syncState("failure", false, "网络超时", "network");
    const root = overlay.getElement()!;
    const capsule = overlay.getMiniCapsuleElement()!;
    const failureCard = root.querySelector<HTMLElement>(".live-overlay-failure-card")!;
    expect(overlay.isMinimized()).toBe(false);
    expect(failureCard.hidden).toBe(false);
    expect(capsule.querySelector(".live-overlay-mini-status-text")?.textContent).toBe("需要处理");
    expect(document.activeElement).toBe(outsideButton);

    overlay.syncState("connecting");
    expect(overlay.isMinimized()).toBe(true);
    expect(failureCard.hidden).toBe(true);
    expect(document.activeElement).toBe(outsideButton);

    capsule.click();
    const minButton = root.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!;
    expect(document.activeElement).toBe(minButton);
    overlay.syncState("connected");
    expect(document.activeElement).toBe(minButton);
    overlay.syncState("failure", false, "再次失败", "network");
    overlay.syncState("connecting");
    expect(overlay.isMinimized()).toBe(false);
    expect(document.activeElement).toBe(minButton);

    minButton.click();
    expect(document.activeElement).toBe(capsule);
    overlay.syncState("connected");
    expect(document.activeElement).toBe(capsule);
  });

  it("用户在失败期间主动最小化后，重复失败同步不重新展开", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();
    mockController.getState = () => "failure";
    overlay.syncState("failure", false, "网络超时", "network");
    const minButton = overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!;
    minButton.click();

    overlay.syncState("failure", false, "网络超时", "network");
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.getElement()?.querySelector<HTMLElement>(".live-overlay-failure-card")?.hidden).toBe(false);
    expect(overlay.getMiniCapsuleElement()?.querySelector(".live-overlay-mini-status-text")?.textContent).toBe("需要处理");
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

  it("拖拽后吸附右侧，展开态继承锚点，容器缩放后重新钳制", async () => {
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

    expect(capsule.style.left).toBe("");

    capsule.dispatchEvent(new PointerEvent("pointerdown", { clientX: 950, clientY: 20 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 910, clientY: 50 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 910, clientY: 50 }));
    capsule.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(capsule.style.right).toBe("16px");
    expect(capsule.style.top).toBe("46px");
    expect(capsule.style.left).toBe("auto");
    expect(overlay.isMinimized()).toBe(true);

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
    expect(el.style.right).toBe("16px");
    expect(el.style.top).toBe("46px");
    expect(el.style.left).toBe("auto");

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
    window.dispatchEvent(new Event("resize"));
    await Promise.resolve();

    expect(el.style.right).toBe("16px");
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

  it("仅在无 CC 字幕时提供实时翻译按钮，无 Key 时禁用并说明原因", () => {
    let shouldShowInterpret = false;
    let availability = { ok: false, error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key" };
    let interpretState = "idle";
    const toggle = vi.fn(async () => {});
    const interpretController = {
      getState: () => interpretState,
      getAvailability: () => availability,
      toggle
    };
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      getInterpretController: () => interpretController as any,
      shouldShowInterpret: () => shouldShowInterpret
    });
    overlay.show({ forceExpand: true });

    const button = overlay.getElement()?.querySelector(".live-overlay-interpret-btn") as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.hidden).toBe(true);

    shouldShowInterpret = true;
    overlay.syncState();
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("实时翻译");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.title).toBe(availability.error);
    button.click();
    expect(toggle).not.toHaveBeenCalled();

    availability = { ok: true } as any;
    overlay.syncState();
    expect(button.getAttribute("aria-disabled")).toBe("false");
    button.click();
    expect(toggle).toHaveBeenCalledTimes(1);

    interpretState = "connected";
    overlay.syncState();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("is-active")).toBe(true);

    overlay.showInterpretNotice("同声传译连接被服务端关闭（关闭码: 1013）", 6000);
    const notice = overlay.getElement()?.querySelector(".live-overlay-interpret-notice") as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("1013");
    overlay.dispose();
  });

  it("展开浮窗拖拽后吸附左侧，兼容点击不误挂断，胶囊继承位置", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    root.getBoundingClientRect = () => ({
      left: 664,
      top: 16,
      right: 984,
      bottom: 416,
      width: 320,
      height: 400,
      x: 664,
      y: 16,
      toJSON: () => {}
    });
    const header = root.querySelector<HTMLElement>(".live-overlay-header")!;

    header.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 800, clientY: 20 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200, clientY: 80 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 200, clientY: 80 }));
    root.querySelector<HTMLButtonElement>(".live-overlay-close-btn")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(root.style.left).toBe("16px");
    expect(root.style.right).toBe("auto");
    expect(root.style.top).toBe("76px");
    expect(overlay.isMinimized()).toBe(false);
    expect(onStopLive).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.getMiniCapsuleElement()?.style.left).toBe("16px");
    expect(overlay.getMiniCapsuleElement()?.style.top).toBe("76px");
  });

  it("浏览器全屏进出时迁移原浮窗与胶囊并保持展开状态", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
    let fullscreenElement: HTMLElement | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement
    });
    const getLiveController = vi.fn(() => mockController as LiveChatController);
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController
    });

    try {
      overlay.show({ forceExpand: true });
      const root = overlay.getElement()!;
      const capsule = overlay.getMiniCapsuleElement()!;
      const fullscreenHost = document.createElement("div");
      fullscreenHost.getBoundingClientRect = () => ({
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
      document.body.appendChild(fullscreenHost);
      fullscreenElement = fullscreenHost;
      const controllerCalls = getLiveController.mock.calls.length;
      document.dispatchEvent(new Event("fullscreenchange"));
      await Promise.resolve();

      expect(root.parentElement).toBe(fullscreenHost);
      expect(capsule.parentElement).toBe(fullscreenHost);
      expect(overlay.getElement()).toBe(root);
      expect(overlay.getMiniCapsuleElement()).toBe(capsule);
      expect(overlay.isMinimized()).toBe(false);
      expect(getLiveController).toHaveBeenCalledTimes(controllerCalls);

      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      await Promise.resolve();
      expect(root.parentElement).toBe(playerHost);
      expect(capsule.parentElement).toBe(playerHost);
      expect(overlay.isMinimized()).toBe(false);
    } finally {
      overlay.dispose();
      if (descriptor) {
        Object.defineProperty(document, "fullscreenElement", descriptor);
      } else {
        delete (document as unknown as { fullscreenElement?: Element | null }).fullscreenElement;
      }
    }
  });

  it("播放器宿主替换时迁移原节点，不重建控制器或重置迷你状态", async () => {
    let currentHost = playerHost;
    const getLiveController = vi.fn(() => mockController as LiveChatController);
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => currentHost,
      getLiveController
    });
    overlay.show();
    const root = overlay.getElement()!;
    const capsule = overlay.getMiniCapsuleElement()!;
    const controllerCalls = getLiveController.mock.calls.length;
    const replacementHost = document.createElement("div");
    replacementHost.className = "bpx-player-container";
    replacementHost.getBoundingClientRect = playerHost.getBoundingClientRect;
    currentHost = replacementHost;
    document.body.appendChild(replacementHost);
    playerHost.remove();
    await Promise.resolve();
    await Promise.resolve();

    expect(root.parentElement).toBe(replacementHost);
    expect(capsule.parentElement).toBe(replacementHost);
    expect(overlay.getElement()).toBe(root);
    expect(overlay.getMiniCapsuleElement()).toBe(capsule);
    expect(overlay.isMinimized()).toBe(true);
    expect(getLiveController).toHaveBeenCalledTimes(controllerCalls);

    capsule.click();
    expect(overlay.isMinimized()).toBe(false);
    expect(overlay.getElement()).toBe(root);
    overlay.dispose();
  });
});
