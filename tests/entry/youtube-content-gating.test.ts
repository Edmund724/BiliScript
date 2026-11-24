// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState } from "../setup.js";

function setCrossOriginLocation(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

const mocks = vi.hoisted(() => ({
  loadScriptButton: vi.fn(() => Promise.resolve({})),
  loadPlayerAi: vi.fn(async () => ({
    startPlayerAiQuickAction: vi.fn(),
    stopPlayerAiQuickAction: vi.fn()
  })),
  isPlayerAiLoaded: vi.fn(() => false),
  loadPlaybackRate: vi.fn(async () => ({
    startPlaybackRateButtons: vi.fn(),
    stopPlaybackRateButtons: vi.fn()
  })),
  isPlaybackRateLoaded: vi.fn(() => false),
  enterReaderShellOnUrlNavigation: vi.fn(async () => {}),
  exitReaderShell: vi.fn(async () => {}),
  resetClipState: vi.fn(),
  collectAgentBridgeTabSnapshot: vi.fn(() => ({
    bvid: "BV1test",
    cid: "1",
    title: "t",
    currentTime: 0,
    duration: 10,
    subtitlesReady: true
  }))
}));

vi.mock("../../extension/ui/lazy-script-button.js", () => ({
  loadScriptButton: mocks.loadScriptButton
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: mocks.loadPlayerAi,
  isPlayerAiLoaded: mocks.isPlayerAiLoaded
}));
vi.mock("../../extension/bilibili/lazy-playback-rate.js", () => ({
  loadPlaybackRate: mocks.loadPlaybackRate,
  isPlaybackRateLoaded: mocks.isPlaybackRateLoaded
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/lazy-reader-presentation.js", () => ({
  hydrateReaderStateFromSettings: vi.fn(async () => {}),
  applyPrePaintReaderTheme: vi.fn(async () => {}),
  applyReadingViewPresentation: vi.fn(async () => {}),
  announceReadingStatus: vi.fn()
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(async () => ({ enterReaderMode: vi.fn(async () => {}) }))
}));
vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: vi.fn(async () => ({
    enterReaderShell: vi.fn(async () => {}),
    enterReaderShellOnUrlNavigation: mocks.enterReaderShellOnUrlNavigation,
    exitReaderShell: mocks.exitReaderShell
  }))
}));
vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    resetClipState: mocks.resetClipState,
    refreshClip: vi.fn(async () => {})
  }))
}));
vi.mock("../../extension/agent-bridge/content.js", () => ({
  collectAgentBridgeTabSnapshot: mocks.collectAgentBridgeTabSnapshot
}));

const YT_WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function stubYoutubeRuntime() {
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      lastError: null,
      sendMessage: vi.fn((msg: { type?: string }, cb?: (resp: unknown) => void) => {
        if (msg?.type === "get-settings") {
          cb?.({
            ok: true,
            settings: {
              enablePlayerAiQuickAction: true,
              enableExtraPlaybackRates: true,
              autoOpenReader: false
            }
          });
        } else {
          cb?.({ ok: true });
        }
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
    },
    storage: {
      sync: {
        get: vi.fn(async () => ({ enablePlayerAiQuickAction: true })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
}

beforeEach(() => {
  resetModuleState();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

afterEach(() => {
  setCrossOriginLocation(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("YouTube 内容脚本启动门控与 Agent 桥接懒加载", () => {
  it("YouTube watch 页启动同步 site=youtube 且门控跳过 player-ai 与 playback-rate，仅加载 script-button", async () => {
    setCrossOriginLocation(YT_WATCH_URL);
    stubYoutubeRuntime();

    const { state } = await import("../../extension/core/state.js");
    await import("../../extension/entry/content.js");
    await vi.waitFor(() => expect(mocks.loadScriptButton).toHaveBeenCalledTimes(1));

    expect(state.clip.site).toBe("youtube");
    expect(state.clip.currentClipSignature).toBe("youtube|dQw4w9WgXcQ|yt");
    expect(mocks.loadPlayerAi).not.toHaveBeenCalled();
    expect(mocks.loadPlaybackRate).not.toHaveBeenCalled();
  });

  it("Agent Bridge 快照在 YouTube 下被门控拒绝，在 B 站下按需懒加载返回快照", async () => {
    setCrossOriginLocation(YT_WATCH_URL);
    const { clipState } = await import("../../extension/core/state.js");
    const { dispatchContentScriptMessage } = await import("../../extension/entry/message-handler.js");

    clipState.setSite("youtube");
    const ytResp = vi.fn();
    const ytKeepOpen = dispatchContentScriptMessage({ type: "agent-bridge-snapshot" }, ytResp);
    expect(ytKeepOpen).toBe(false);
    expect(ytResp).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });
    expect(mocks.collectAgentBridgeTabSnapshot).not.toHaveBeenCalled();

    clipState.setSite("bilibili");
    const biliResp = vi.fn();
    const biliKeepOpen = dispatchContentScriptMessage({ type: "agent-bridge-snapshot" }, biliResp);
    expect(biliKeepOpen).toBe(true);
    await vi.waitFor(() =>
      expect(biliResp).toHaveBeenCalledWith({
        ok: true,
        snapshot: expect.objectContaining({ bvid: "BV1test", cid: "1" })
      })
    );
    expect(mocks.collectAgentBridgeTabSnapshot).toHaveBeenCalledTimes(1);
  });

  it("YouTube SPA 离开 watch 页至首页时关闭阅读面板并调用 resetClipState() 清理状态", async () => {
    setCrossOriginLocation(YT_WATCH_URL);
    const { clipState, transitionReaderShell } = await import("../../extension/core/state.js");
    const { bindUrlChangeHandler } = await import("../../extension/entry/message-handler.js");

    clipState.setSite("youtube");
    clipState.setCurrentClipSignature("youtube|dQw4w9WgXcQ|yt");
    transitionReaderShell("open");
    bindUrlChangeHandler();

    history.pushState({}, "", "https://www.youtube.com/");

    await vi.waitFor(() => {
      expect(mocks.exitReaderShell).toHaveBeenCalledTimes(1);
      expect(mocks.resetClipState).toHaveBeenCalledTimes(1);
    });
    expect(clipState.currentClipSignature).toBe("youtube||yt");
  });
});
