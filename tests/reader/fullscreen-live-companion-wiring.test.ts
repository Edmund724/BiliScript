import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetModuleState, setLocationUrl, READER_MODE_URL } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";

describe("reader/chat-tab: 全屏实时伴看浮窗联动与全屏自适应", () => {
  let playerContainer: HTMLElement;

  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(READER_MODE_URL);
    document.body.innerHTML = "";

    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    mountPlayerChain();

    playerContainer = document.querySelector(".bpx-player-container") as HTMLElement;
    if (!playerContainer) {
      playerContainer = document.createElement("div");
      playerContainer.className = "bpx-player-container";
      document.body.appendChild(playerContainer);
    }
  });

  afterEach(async () => {
    const { closeChatSession } = await import("../../extension/reader/chat-tab.js");
    closeChatSession();
    resetModuleState();
    await new Promise((resolve) => setTimeout(resolve, 20));
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("ensureFullscreenOverlay 返回浮窗实例并在播放器全屏时展示", async () => {
    const { ensureFullscreenOverlay } = await import("../../extension/reader/chat-tab.js");

    const overlay = ensureFullscreenOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay.isVisible()).toBe(false);

    // 网页全屏模式
    playerContainer.setAttribute("data-screen", "web");
    overlay.show();

    expect(overlay.isVisible()).toBe(true);
    expect(document.querySelector("#biliscript-fullscreen-live-overlay")).not.toBeNull();

    overlay.hide();
    expect(overlay.isVisible()).toBe(false);
  });

  it("浮窗状态同步：连接中、陪看中、VAD 语音活动与转写流式上屏", async () => {
    const { ensureFullscreenOverlay } = await import("../../extension/reader/chat-tab.js");
    const overlay = ensureFullscreenOverlay();
    overlay.show();

    // 状态胶囊同步
    overlay.syncState("connecting");
    const statusText = overlay.getElement()?.querySelector(".live-overlay-status-text");
    expect(statusText?.textContent).toBe("连接中...");

    overlay.syncState("connected");
    expect(statusText?.textContent).toBe("正在伴看");

    // VAD 动效
    overlay.updateVad(true);
    expect(overlay.getElement()?.querySelector(".live-overlay-status-capsule")?.classList.contains("is-talking")).toBe(true);
    overlay.updateVad(false);
    expect(overlay.getElement()?.querySelector(".live-overlay-status-capsule")?.classList.contains("is-talking")).toBe(false);

    // 用户与 Assistant 实时转写字幕上屏
    overlay.updateTranscript({
      kind: "input.done",
      text: "视频里这个人是谁？"
    });
    overlay.updateTranscript({
      kind: "output.updated",
      runId: "run-abc",
      turnId: "turn-1",
      text: "这是主角"
    });

    const messages = overlay.getElement()?.querySelector(".live-overlay-messages");
    expect(messages?.querySelector(".live-overlay-bubble-user")?.textContent).toBe("视频里这个人是谁？");
    expect(messages?.querySelector(".live-overlay-bubble-assistant")?.textContent).toBe("这是主角");
  });

  describe("伴看进行中切换全屏", () => {
    async function startConnectedCompanion() {
      const chat = await import("../../extension/reader/chat-tab.js");
      await chat.ensureChatTabActivated();
      const liveCtrl = chat.getLiveController();
      expect(liveCtrl).not.toBeNull();
      vi.spyOn(liveCtrl!, "start").mockImplementation(async () => {
        vi.spyOn(liveCtrl!, "getState").mockReturnValue("connected");
        return true;
      });

      expect(await chat.startLiveCompanion()).toBe(true);
      expect(chat.getFullscreenLiveOverlay()?.isVisible()).toBe(true);
      return chat;
    }

    afterEach(() => {
      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    });

    it("进出网页全屏时浮窗持续展示且不中断会话，不操作全屏模式 DOM 属性", async () => {
      const chat = await startConnectedCompanion();
      const overlay = chat.getFullscreenLiveOverlay();
      expect(overlay?.isVisible()).toBe(true);

      playerContainer.setAttribute("data-screen", "web");
      expect(overlay?.isVisible()).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBeNull();

      playerContainer.removeAttribute("data-screen");
      expect(overlay?.isVisible()).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBeNull();
    });

    it("进出浏览器全屏时浮窗持续展示且不中断会话", async () => {
      const chat = await startConnectedCompanion();
      const overlay = chat.getFullscreenLiveOverlay();
      expect(overlay?.isVisible()).toBe(true);

      Object.defineProperty(document, "fullscreenElement", { value: playerContainer, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(overlay?.isVisible()).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBeNull();

      Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(overlay?.isVisible()).toBe(true);
      expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBeNull();
    });

    it("已处于浏览器全屏时开启伴看，浮窗挂载进实际全屏元素", async () => {
      const chat = await import("../../extension/reader/chat-tab.js");
      await chat.ensureChatTabActivated();
      const liveCtrl = chat.getLiveController();
      expect(liveCtrl).not.toBeNull();
      vi.spyOn(liveCtrl!, "start").mockImplementation(async () => {
        vi.spyOn(liveCtrl!, "getState").mockReturnValue("connected");
        return true;
      });

      const fullscreenElement = document.createElement("div");
      playerContainer.appendChild(fullscreenElement);
      Object.defineProperty(document, "fullscreenElement", { value: fullscreenElement, configurable: true });

      expect(await chat.startLiveCompanion()).toBe(true);
      const overlay = chat.getFullscreenLiveOverlay();
      expect(overlay?.isVisible()).toBe(true);
      expect(fullscreenElement.contains(overlay?.getElement() ?? null)).toBe(true);
    });
  });
});
