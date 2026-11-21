import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFullscreenLiveOverlay } from "../../extension/live/fullscreen-live-overlay.js";
import { createLiveOverlayTranscriptMerger } from "../../extension/live/live-transcript-merger.js";
import { buildLensDisplacementMap } from "../../extension/live/liquid-glass-lens.js";
import { encodeBase64Bytes } from "../../extension/live/moss-live-protocol.js";
import type { LiveChatController } from "../../extension/live/live-chat-controller.js";

function flushAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("live/fullscreen-live-overlay 全屏伴看浮窗", () => {
  let playerHost: HTMLElement;
  let mockController: Partial<LiveChatController>;
  let onStopLive: () => void;

  beforeEach(() => {
    document.body.innerHTML = "";
    playerHost = document.createElement("div");
    playerHost.className = "bpx-player-container";
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

    overlay.syncState("connected", true);
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
      ["key-missing", "填写 Key", null, "settings"],
      ["key-rejected", "检查 Key", "重试", "settings"],
      ["gemini-credential", "配置 Gemini Key", "重试", "settings"],
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

  it("Esc 关闭音频弹层并回焦，外点关闭不抢外部焦点且均不结束伴看", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const audioBtn = root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    expect(popover.getAttribute("popover")).toBe("manual");
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
    const outsideInput = document.createElement("input");
    document.body.appendChild(outsideInput);
    outsideInput.focus();
    const outsideDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    outsideInput.dispatchEvent(outsideDown);
    expect(outsideDown.defaultPrevented).toBe(false);
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(outsideInput);
    expect(onStopLive).not.toHaveBeenCalled();
    overlay.dispose();
  });

  it("native popover='manual' 下点喇叭不闪关重开、键盘打开聚焦首控件、外点不抢焦点、Esc 归还焦点", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const audioBtn = root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    const volumeSlider = popover.querySelector<HTMLInputElement>(".live-overlay-volume-slider")!;
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.defineProperty(popover, "showPopover", { configurable: true, value: showPopover });
    Object.defineProperty(popover, "hidePopover", { configurable: true, value: hidePopover });

    audioBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(showPopover).toHaveBeenCalledTimes(1);
    expect(popover.hidden).toBe(false);
    expect(document.activeElement).toBe(volumeSlider);

    audioBtn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    audioBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(hidePopover).toHaveBeenCalledTimes(1);
    expect(popover.hidden).toBe(true);
    expect(audioBtn.getAttribute("aria-expanded")).toBe("false");

    audioBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(popover.hidden).toBe(false);
    const outsideBtn = document.createElement("button");
    document.body.appendChild(outsideBtn);
    outsideBtn.focus();
    outsideBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(outsideBtn);

    audioBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(audioBtn);

    audioBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(popover.hidden).toBe(false);
    overlay.syncState("failure", false, "网络异常", "network");
    expect(popover.hidden).toBe(true);
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

  it("浮窗左侧提供伴看平台与密钥设置按钮入口", () => {
    const onOpenLiveSettings = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onOpenLiveSettings
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const settingsButton = root.querySelector<HTMLButtonElement>(".live-overlay-header-settings-btn")!;
    expect(settingsButton).toBeTruthy();
    expect(root.querySelector(".live-overlay-audio-popover .live-overlay-audio-settings-btn")).toBeNull();
    settingsButton.click();

    expect(onOpenLiveSettings).toHaveBeenCalledWith("live");
    overlay.dispose();
  });

  it("拖动预览后同步音量回包，不回退到旧设置值", () => {
    const onVolumeChange = vi.fn();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      getVolume: () => 80,
      onVolumeChange
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const popover = root.querySelector<HTMLElement>(".live-overlay-audio-popover")!;
    root.querySelector<HTMLButtonElement>(".live-overlay-audio-btn")!.click();
    const slider = popover.querySelector<HTMLInputElement>(".live-overlay-volume-slider:not(.live-overlay-speed-slider)")!;
    const value = popover.querySelector<HTMLElement>(".live-overlay-volume-value:not(.live-overlay-speed-value)")!;

    slider.value = "65";
    slider.dispatchEvent(new Event("input"));
    overlay.syncState();

    expect(slider.value).toBe("65");
    expect(value.textContent).toBe("65%");
    slider.dispatchEvent(new Event("change"));
    expect(onVolumeChange).toHaveBeenCalledWith(65);
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

    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.isVisible()).toBe(true);
    expect(capsule?.hidden).toBe(false);
    expect(el?.hidden).toBe(true);

    capsule?.dispatchEvent(new PointerEvent("pointerdown", { clientX: 10, clientY: 10 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));

    expect(overlay.isMinimized()).toBe(false);
    expect(overlay.isVisible()).toBe(true);
    expect(capsule?.hidden).toBe(true);
    expect(el?.hidden).toBe(false);

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

  it("未连接态（connecting / reconnecting / failure / idle）禁用麦克风钮并隐藏胶囊麦克风指示", () => {
    let liveState: "idle" | "connecting" | "connected" | "failure" = "connecting";
    mockController.getState = () => liveState;
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();
    const root = overlay.getElement()!;
    const capsule = overlay.getMiniCapsuleElement()!;
    const micBtn = root.querySelector<HTMLButtonElement>(".live-overlay-mic-btn")!;
    const micText = capsule.querySelector<HTMLElement>(".live-overlay-mini-mic-text")!;
    const micIcon = capsule.querySelector<SVGElement>(".live-overlay-mini-mic-icon")!;

    expect(micBtn.disabled).toBe(true);
    expect(micText.hidden).toBe(true);
    expect(micIcon.hasAttribute("hidden")).toBe(true);
    expect(capsule.getAttribute("aria-label")).not.toContain("麦克风已开启");

    liveState = "connected";
    overlay.syncState("connected", true);
    expect(micBtn.disabled).toBe(true);
    expect(micText.hidden).toBe(true);
    expect(micIcon.hasAttribute("hidden")).toBe(true);
    expect(capsule.getAttribute("aria-label")).not.toContain("麦克风已开启");

    liveState = "failure";
    overlay.syncState("failure", false, "连接失败", "network");
    expect(micBtn.disabled).toBe(true);
    expect(micText.hidden).toBe(true);
    expect(micIcon.hasAttribute("hidden")).toBe(true);

    liveState = "connected";
    overlay.syncState("connected", false);
    expect(micBtn.disabled).toBe(false);
    expect(micText.hidden).toBe(false);
    expect(micText.textContent).toBe("麦克风已开启");
    expect(micIcon.hasAttribute("hidden")).toBe(false);
    expect(capsule.getAttribute("aria-label")).toContain("麦克风已开启");
    overlay.dispose();
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

    Object.defineProperty(messages, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messages, "scrollTop", { value: 100, writable: true, configurable: true });

    messages.dispatchEvent(new Event("scroll"));
    expect(scrollBtn.hidden).toBe(false);

    scrollBtn.click();
    expect(scrollBtn.hidden).toBe(true);
  });

  it("点击回底在平滑滚动途中不首帧断跟，主动滚轮后恢复检测，隐藏前移交焦点到最小化钮", () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show({ forceExpand: true });
    const root = overlay.getElement()!;
    const messages = root.querySelector(".live-overlay-messages") as HTMLElement;
    const scrollBtn = root.querySelector(".live-overlay-scroll-bottom-btn") as HTMLButtonElement;
    const minBtn = root.querySelector(".live-overlay-min-btn") as HTMLButtonElement;

    Object.defineProperty(messages, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(messages, "scrollTop", { value: 100, writable: true, configurable: true });
    messages.scrollTo = vi.fn();

    messages.dispatchEvent(new Event("scroll"));
    expect(scrollBtn.hidden).toBe(false);

    scrollBtn.focus();
    expect(document.activeElement).toBe(scrollBtn);
    scrollBtn.click();
    expect(scrollBtn.hidden).toBe(true);
    expect(document.activeElement).toBe(minBtn);

    messages.dispatchEvent(new Event("scroll"));
    expect(scrollBtn.hidden).toBe(true);

    messages.dispatchEvent(new Event("wheel"));
    messages.dispatchEvent(new Event("scroll"));
    expect(scrollBtn.hidden).toBe(false);
    overlay.dispose();
  });

  it("纯语音对话流转写更新：用户绿气泡与 Agent 流式气泡，浮窗不提供清空按钮", async () => {
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    overlay.updateTranscript({
      kind: "input.updated",
      text: "你能看到画面吗？"
    });
    await flushAnimationFrame();

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
    await flushAnimationFrame();

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

    expect(overlay.getElement()?.querySelector(".live-overlay-clear-btn")).toBeNull();
    overlay.clearMessages();
    expect(messages.children.length).toBe(0);
  });

  it("麦克风未激活（isVoiceRecentlyActive 为 false）时拦截纯背景原声的 input 转写", async () => {
    let voiceActive = false;
    mockController.isVoiceRecentlyActive = () => voiceActive;

    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController,
      onStopLive
    });
    overlay.show();

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages") as HTMLElement;

    overlay.updateTranscript({ kind: "input.updated", text: "主播正在说话" });
    overlay.updateTranscript({ kind: "input.done", text: "主播正在说话" });
    expect(messages.querySelector(".live-overlay-bubble-user")).toBeNull();

    voiceActive = true;
    overlay.updateTranscript({ kind: "input.updated", text: "我在说话" });
    await flushAnimationFrame();
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

    overlay.updateTranscript({
      kind: "output.updated",
      runId: "r-empty",
      turnId: "t-1",
      text: ""
    });
    expect(messages.querySelectorAll(".live-overlay-bubble-assistant")).toHaveLength(0);

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
    expect(messages.children.length).toBe(0);

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

    overlay.clearMessages();
    expect(messages.children.length).toBe(0);
  });

  it("换片清空转写并保留展开或迷你状态，快速连切只展示最新提示", () => {
    vi.useFakeTimers();
    const overlay = createFullscreenLiveOverlay({
      getPlayerHost: () => playerHost,
      getLiveController: () => mockController as LiveChatController
    });
    try {
      overlay.show({ forceExpand: true });
      overlay.updateTranscript({
        kind: "output.done",
        runId: "old-run",
        turnId: "old-turn",
        text: "旧视频回答"
      });
      overlay.showVideoContextSwitch({
        url: "https://www.bilibili.com/video/BV1/?p=2",
        bvid: "BV1",
        cid: "202",
        title: "视频标题",
        pageIndex: 2,
        pageCount: 3,
        pageTitle: "第二分P",
        chapters: []
      });

      const root = overlay.getElement()!;
      const messages = root.querySelector(".live-overlay-messages")!;
      const notice = root.querySelector(".live-overlay-interpret-notice") as HTMLElement;
      expect(messages.children).toHaveLength(0);
      expect(overlay.isMinimized()).toBe(false);
      expect(notice.textContent).toBe("已切换到 P2：第二分P");

      root.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
      overlay.showVideoContextSwitch({
        url: "https://www.bilibili.com/video/BV1/?p=3",
        bvid: "BV1",
        cid: "303",
        title: "视频标题",
        pageIndex: 3,
        pageCount: 3,
        pageTitle: "第三分P",
        chapters: []
      });
      const capsule = overlay.getMiniCapsuleElement()!;
      expect(overlay.isMinimized()).toBe(true);
      expect(notice.textContent).toBe("已切换到 P3：第三分P");
      expect(capsule.querySelector(".live-overlay-mini-status-text")?.textContent)
        .toBe("已切换到 P3：第三分P");

      vi.advanceTimersByTime(4000);
      expect(notice.hidden).toBe(true);
      expect(capsule.querySelector(".live-overlay-mini-status-text")?.textContent).toBe("正在伴看");
      expect(overlay.isMinimized()).toBe(true);
    } finally {
      overlay.dispose();
      vi.useRealTimers();
    }
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

  it("ResizeObserver 观察浮窗尺寸增长并向上夹紧，且不覆写原始 savedOffset", async () => {
    const originalRO = globalThis.ResizeObserver;
    const observed = new Map<Element, ResizeObserverCallback>();
    class FakeResizeObserver {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        observed.set(target, this.cb);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    try {
      const overlay = createFullscreenLiveOverlay({
        getPlayerHost: () => playerHost,
        getLiveController: () => mockController as LiveChatController,
        onStopLive
      });
      overlay.show({ forceExpand: true });
      const root = overlay.getElement()!;
      const capsule = overlay.getMiniCapsuleElement()!;

      let rootHeight = 120;
      root.getBoundingClientRect = () => ({
        left: 664,
        top: 400,
        right: 984,
        bottom: 400 + rootHeight,
        width: 320,
        height: rootHeight,
        x: 664,
        y: 400,
        toJSON: () => {}
      });
      capsule.getBoundingClientRect = () => ({
        left: 900,
        top: 400,
        right: 984,
        bottom: 428,
        width: 84,
        height: 28,
        x: 900,
        y: 400,
        toJSON: () => {}
      });

      const header = root.querySelector<HTMLElement>(".live-overlay-header")!;
      header.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 800, clientY: 410 }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 800, clientY: 420 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 800, clientY: 420 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.style.top).toBe("410px");

      rootHeight = 400;
      const rootCb = observed.get(root);
      expect(rootCb).toBeDefined();
      rootCb!([], {} as ResizeObserver);
      expect(root.style.top).toBe("184px");

      root.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
      expect(capsule.style.top).toBe("410px");
      overlay.dispose();
    } finally {
      if (originalRO) {
        vi.stubGlobal("ResizeObserver", originalRO);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("rAF 流式合批状态机：同帧高频 updated 原位复用气泡并合批一次写/滚，终态同步落定且清场取消挂起帧", () => {
    const messages = document.createElement("div");
    const scheduled = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const cancelFrame = vi.fn((id: number) => {
      scheduled.delete(id);
    });
    const scrollToBottom = vi.fn();

    const merger = createLiveOverlayTranscriptMerger({
      getMessagesContainer: () => messages,
      scrollToBottom,
      requestFrame: (cb) => {
        const id = nextFrameId++;
        scheduled.set(id, cb);
        return id;
      },
      cancelFrame
    });

    merger.handleEvent({ kind: "output.updated", runId: "r-batch", turnId: "t-1", text: "第" });
    merger.handleEvent({ kind: "output.updated", runId: "r-batch", turnId: "t-1", text: "第一" });
    merger.handleEvent({ kind: "output.updated", runId: "r-batch", turnId: "t-1", text: "第一句" });
    merger.handleEvent({ kind: "output.updated", runId: "r-batch", turnId: "t-1", text: "第一句完整增量" });

    const bubble = messages.querySelector(".live-overlay-bubble-assistant") as HTMLDivElement;
    expect(bubble).not.toBeNull();
    expect(messages.children).toHaveLength(1);
    expect(scheduled.size).toBe(1);
    expect(bubble.textContent).toBe("");
    expect(scrollToBottom).not.toHaveBeenCalled();

    const [frameId, frameCb] = [...scheduled.entries()][0];
    scheduled.delete(frameId);
    frameCb(16);
    expect(messages.querySelector(".live-overlay-bubble-assistant")).toBe(bubble);
    expect(bubble.textContent).toBe("第一句完整增量");
    expect(scrollToBottom).toHaveBeenCalledTimes(1);

    merger.handleEvent({
      kind: "output.updated",
      runId: "r-batch",
      turnId: "t-1",
      text: "中间半截"
    });
    expect(scheduled.size).toBe(1);
    merger.handleEvent({
      kind: "output.done",
      runId: "r-batch",
      turnId: "t-1",
      text: "完整终态回复"
    });
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(scheduled.size).toBe(0);
    expect(bubble.textContent).toBe("完整终态回复");
    expect(bubble.classList.contains("is-streaming")).toBe(false);
    expect(scrollToBottom).toHaveBeenCalledTimes(2);

    merger.handleEvent({
      kind: "output.updated",
      runId: "r-batch",
      turnId: "t-2",
      text: "将被清空的流式分片"
    });
    expect(scheduled.size).toBe(1);
    merger.dispose();
    expect(scheduled.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalledTimes(2);
  });

  function buildReferenceLensBytes(width: number, height: number, radius: number, edge: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    const halfW = width / 2;
    const halfH = height / 2;
    const r = Math.min(radius, halfW, halfH);
    const bx = Math.max(0, halfW - r);
    const by = Math.max(0, halfH - r);
    const maxOffset = 1.1 * edge;
    for (let y = 0; y < height; y++) {
      const py = y + 0.5 - halfH;
      const absPy = Math.abs(py);
      const qy = absPy - by;
      const signY = py < 0 ? -1 : 1;
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const px = x + 0.5 - halfW;
        const absPx = Math.abs(px);
        const qx = absPx - bx;
        const signX = px < 0 ? -1 : 1;
        const outX = Math.max(qx, 0);
        const outY = Math.max(qy, 0);
        const outLen = Math.hypot(outX, outY);
        const sdf = outLen + Math.min(Math.max(qx, qy), 0) - r;
        const d = -sdf;
        if (d <= 0 || d >= edge) {
          data[idx] = 128;
          data[idx + 1] = 128;
          data[idx + 2] = 128;
          data[idx + 3] = 255;
          continue;
        }
        let nx = 0;
        let ny = 0;
        if (outLen > 1e-4) {
          nx = signX * (outX / outLen);
          ny = signY * (outY / outLen);
        } else if (qx > qy) {
          nx = signX;
        } else {
          ny = signY;
        }
        const offset = maxOffset * Math.pow(1 - d / edge, 2.6);
        data[idx] = Math.max(0, Math.min(255, Math.round(128 + (-nx * offset / maxOffset) * 127)));
        data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + (-ny * offset / maxOffset) * 127)));
        data[idx + 2] = 128;
        data[idx + 3] = 255;
      }
    }
    return data;
  }

  function installLensCanvasCaptureMock(): void {
    const capturedByCanvas = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      type: string
    ) {
      if (type !== "2d") return null;
      const canvas = this;
      return {
        createImageData: (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4)
        }),
        putImageData: (imgData: ImageData) => {
          capturedByCanvas.set(canvas, new Uint8ClampedArray(imgData.data));
        }
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      const bytes = capturedByCanvas.get(this) ?? new Uint8ClampedArray(0);
      return `data:image/png;base64,${encodeBase64Bytes(bytes.buffer)}`;
    });
  }

  it("buildLensDisplacementMap 扫描线中段复用与逐像素参考实现字节级等价", () => {
    installLensCanvasCaptureMock();

    const oddBox = buildLensDisplacementMap(321, 241, 14, 12);
    expect(oddBox?.dataUrl).toBe(
      `data:image/png;base64,${encodeBase64Bytes(buildReferenceLensBytes(321, 241, 14, 12).buffer)}`
    );

    const evenBox = buildLensDisplacementMap(320, 121, 14, 12);
    expect(evenBox?.dataUrl).toBe(
      `data:image/png;base64,${encodeBase64Bytes(buildReferenceLensBytes(320, 121, 14, 12).buffer)}`
    );

    const capsuleBox = buildLensDisplacementMap(220, 28, 14, 8);
    expect(capsuleBox?.dataUrl).toBe(
      `data:image/png;base64,${encodeBase64Bytes(buildReferenceLensBytes(220, 28, 14, 8).buffer)}`
    );
  });
});
