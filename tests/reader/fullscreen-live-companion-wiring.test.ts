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
    expect(statusText?.textContent).toBe("正在陪看");

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

  it("全屏与退出全屏无缝切换：进入全屏挂起面板并展示浮窗，退出全屏恢复面板并隐藏浮窗", async () => {
    const { ensureChatTabActivated, ensureFullscreenOverlay } = await import("../../extension/reader/chat-tab.js");
    await ensureChatTabActivated();
    const overlay = ensureFullscreenOverlay();

    // 模拟开启伴看
    const liveCtrl = (await import("../../extension/reader/chat-tab.js")).getLiveController();
    if (liveCtrl) {
      vi.spyOn(liveCtrl, "getState").mockReturnValue("connected");
    }

    // 1. 进入网页全屏
    playerContainer.setAttribute("data-screen", "web");
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 20));

    expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBe("1");
    expect(overlay.isVisible()).toBe(true);

    // 2. 退出全屏
    playerContainer.removeAttribute("data-screen");
    window.dispatchEvent(new Event("resize"));
    await new Promise((r) => setTimeout(r, 20));

    expect(document.documentElement.getAttribute("data-biliscript-fullscreen-mode")).toBeNull();
    expect(overlay.isVisible()).toBe(false);
  });
});
