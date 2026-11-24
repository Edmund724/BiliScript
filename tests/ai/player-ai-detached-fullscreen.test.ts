// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const mocks = vi.hoisted(() => ({
  exitPlayerFullscreenIfNeeded: vi.fn(async () => false),
  sendRuntimeMessage: vi.fn(async () => ({ ok: true })),
  getSettings: vi.fn(async () => ({
    enablePlayerAiQuickAction: true,
    enableLiveCompanion: false
  }))
}));

vi.mock("../../extension/bilibili/fullscreen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/fullscreen.js")>();
  return {
    ...actual,
    exitPlayerFullscreenIfNeeded: mocks.exitPlayerFullscreenIfNeeded
  };
});

vi.mock("../../extension/shared/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/shared/messaging.js")>();
  return {
    ...actual,
    sendRuntimeMessage: mocks.sendRuntimeMessage
  };
});

vi.mock("../../extension/core/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/core/runtime.js")>();
  return {
    ...actual,
    getSettings: mocks.getSettings
  };
});

import { resetActiveReaderHost, setActiveReaderHost } from "../../extension/shared/active-host.js";

class StubDetachedWindow extends EventTarget {
  closed = false;
  document = document.implementation.createHTMLDocument("Detached");
}

describe("player-ai 独立窗口态全屏保留", () => {
  beforeEach(() => {
    resetModuleState();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="bilibili-player">
        <div class="bpx-player-primary-area">
          <div class="bpx-player-container bpx-state-fullscreen">
            <div class="bpx-player-control-wrap">
              <div class="bpx-player-control-bottom-right">
                <div class="bpx-player-ctrl-btn bpx-player-ctrl-playbackrate"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    resetActiveReaderHost();
    try {
      const playerAi = await import("../../extension/ai/player-ai.js");
      playerAi.stopPlayerAiQuickAction();
    } catch {
    }
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("独立窗口打开时点击播放器 AI 快捷按钮不退出全屏并正常派发消息", async () => {
    const childWin = new StubDetachedWindow();
    setActiveReaderHost(childWin.document, childWin as unknown as Window);

    const playerAi = await import("../../extension/ai/player-ai.js");
    playerAi.schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);
    const btn = document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement;
    expect(btn).not.toBeNull();

    btn.click();
    await vi.waitFor(() => {
      expect(mocks.sendRuntimeMessage).toHaveBeenCalledWith({ type: "player-ai-quick-action" });
    });
    expect(mocks.exitPlayerFullscreenIfNeeded).not.toHaveBeenCalled();

    resetActiveReaderHost();
    btn.click();
    await vi.waitFor(() => {
      expect(mocks.exitPlayerFullscreenIfNeeded).toHaveBeenCalledTimes(1);
    });
  });
});
