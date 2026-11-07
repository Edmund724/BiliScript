import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetModuleState } from "../setup.js";

describe("player-ai: 播放器实时伴看快捷按钮与全屏联动", () => {
  let playerContainer: HTMLElement;
  let mockShell: { enterReaderShell: ReturnType<typeof vi.fn> };
  let mockChatTab: {
    ensureChatTabActivated: ReturnType<typeof vi.fn>;
    startLiveCompanion: ReturnType<typeof vi.fn>;
    stopLiveCompanion: ReturnType<typeof vi.fn>;
    getFullscreenLiveOverlay: ReturnType<typeof vi.fn>;
  };
  let mockOverlay: {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
  };
  let isReaderOpen = false;

  beforeEach(async () => {
    resetModuleState();
    vi.useFakeTimers();

    document.body.innerHTML = "";
    isReaderOpen = false;

    playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);

    mockOverlay = {
      show: vi.fn(),
      hide: vi.fn(),
      isVisible: vi.fn(() => false)
    };

    mockShell = {
      enterReaderShell: vi.fn(async () => {
        isReaderOpen = true;
      })
    };

    mockChatTab = {
      ensureChatTabActivated: vi.fn(async () => {}),
      startLiveCompanion: vi.fn(async () => true),
      stopLiveCompanion: vi.fn(() => {}),
      getFullscreenLiveOverlay: vi.fn(() => mockOverlay)
    };

    vi.doMock("../../extension/reader/lazy-shell.js", () => ({
      ensureReaderShell: async () => mockShell
    }));

    vi.doMock("../../extension/reader/lazy-chat-tab.js", () => ({
      ensureReaderChatTab: async () => mockChatTab,
      isReaderChatTabLoaded: () => true
    }));

    vi.doMock("../../extension/reader/state.js", () => ({
      isReaderViewOpen: () => isReaderOpen
    }));

    vi.doMock("../../extension/core/runtime.js", () => ({
      getSettings: async () => ({
        enablePlayerAiQuickAction: true
      })
    }));

    const { state } = await import("../../extension/core/state.js");
    state.setSettings({ enablePlayerAiQuickAction: true } as any);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("在播放器 wrap 内挂载实时伴看按钮，位于 AI 快捷按钮下方", async () => {
    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const aiButton = document.getElementById("biliscript-player-ai-quick-action");
    const liveButton = document.getElementById("biliscript-player-live-quick-action");
    const wrap = playerContainer.querySelector(".biliscript-player-ai-wrap");

    expect(aiButton).not.toBeNull();
    expect(liveButton).not.toBeNull();
    expect(wrap).not.toBeNull();

    expect(wrap?.children[0]).toBe(aiButton);
    expect(wrap?.children[1]).toBe(liveButton);
    expect(liveButton?.getAttribute("aria-label")).toBe("实时伴看");

    stopPlayerAiQuickAction();
    expect(document.getElementById("biliscript-player-live-quick-action")).toBeNull();
    expect(document.querySelector(".biliscript-player-ai-wrap")).toBeNull();
  });

  it("非全屏下点击伴看按钮：打开阅读模式对话页并开启伴看", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockShell.enterReaderShell).toHaveBeenCalledWith({
      readerUrl: "",
      intent: "chat"
    });
    expect(mockChatTab.ensureChatTabActivated).toHaveBeenCalled();
    expect(mockChatTab.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(mockOverlay.show).not.toHaveBeenCalled();
  });

  it("全屏下点击伴看按钮：直接唤起右上角全屏伴看浮窗并开启伴看", async () => {
    // 模拟 B 站网页全屏
    playerContainer.setAttribute("data-screen", "web");

    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockShell.enterReaderShell).not.toHaveBeenCalled();
    expect(mockChatTab.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(mockOverlay.show).toHaveBeenCalled();
  });
});
