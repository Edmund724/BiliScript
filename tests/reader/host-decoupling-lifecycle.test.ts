import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

describe("宿主解耦生命周期验收：SPA 切集 / 全屏宽屏切换 / 面板开合（零滚动漂移 + 无残留监听器）", () => {
  beforeEach(() => {
    resetModuleState();
    vi.useFakeTimers();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("SPA 切 BV 立即 abort 上一片作用域并取消在途 waitForVideoMetadata 轮询，且宿主滚动位置不漂移", async () => {
    const { createClipSwitchTransaction } = await import(
      "../../extension/entry/clip-switch-transaction.js"
    );
    const { waitForVideoMetadata } = await import("../../extension/bilibili/video-probe.js");
    const { contentEventBus } = await import("../../extension/shared/content-event-bus.js");

    const scrollToSpy = vi.spyOn(window, "scrollTo");
    const scrollBySpy = vi.spyOn(window, "scrollBy");
    document.documentElement.scrollTop = 420;
    Object.defineProperty(window, "scrollY", { value: 420, configurable: true });

    let currentUrl = "https://www.bilibili.com/video/BV1first00001/";
    let currentSig = "sig-1";
    let storedSig = "sig-1";
    let runId = 1;

    const tx = createClipSwitchTransaction({
      readUrl: () => currentUrl,
      computeSignature: () => currentSig,
      readSignature: () => storedSig,
      writeIdentity: (url, sig) => {
        currentUrl = url;
        storedSig = sig;
      },
      readRunId: () => runId,
      writeRunId: (id) => {
        runId = id;
      },
      enforceNormalPageStateIfNeeded: () => {},
      isReaderViewOpen: () => false,
      isReaderMode: () => false,
      isSupportedVideoPage: () => true,
      isPlayerAiLoaded: () => false,
      ensureUiReady: async () => {},
      resetClipState: () => {},
      syncPlayerAiQuickAction: () => {},
      enterReaderShellOnUrlNavigation: async () => {},
      refreshReaderClip: async () => {},
      exitReaderShell: async () => {},
      startSubtitlePrefetch: () => {},
      logWarn: () => {}
    });

    const firstClipSignal = tx.getClipSignal();
    const clipListener = vi.fn();
    contentEventBus.on("subtitle:status-phase", clipListener, { signal: firstClipSignal });

    let metadataResolved = false;
    const metadataPromise = waitForVideoMetadata(5000, firstClipSignal).then(() => {
      metadataResolved = true;
    });

    currentUrl = "https://www.bilibili.com/video/BV1second0002/";
    currentSig = "sig-2";
    const startEvents: unknown[] = [];
    const settledEvents: unknown[] = [];
    contentEventBus.on("clip:switch-start", (e) => startEvents.push(e));
    contentEventBus.on("clip:switch-settled", (e) => settledEvents.push(e));

    tx.handleUrlChange();

    expect(firstClipSignal.aborted).toBe(true);
    expect(tx.getClipSignal()).not.toBe(firstClipSignal);
    expect(tx.getClipSignal().aborted).toBe(false);
    expect(startEvents).toHaveLength(1);

    await metadataPromise;
    expect(metadataResolved).toBe(true);

    contentEventBus.emit("subtitle:status-phase", "asr-transcribing");
    expect(clipListener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(settledEvents).toHaveLength(1);

    expect(document.documentElement.scrollTop).toBe(420);
    expect(window.scrollY).toBe(420);
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(scrollBySpy).not.toHaveBeenCalled();
  });

  it("全屏/宽屏切换与面板打开/关闭周期：宿主滚动条零漂移、共享 observer 与全局监听全部归零", async () => {
    document.body.innerHTML = `
      <div id="bilibili-player">
        <div class="bpx-player-container">
          <div class="bpx-player-video-area"><video src="blob:test"></video></div>
          <div class="bpx-player-control-wrap">
            <div class="bpx-player-control-bottom-right">
              <div class="bpx-player-ctrl-btn bpx-player-ctrl-playbackrate">
                <div class="bpx-player-ctrl-playbackrate-result">1.0x</div>
              </div>
              <button type="button" aria-label="字幕" title="字幕">CC</button>
            </div>
          </div>
        </div>
      </div>
      <div class="right-container-inner"></div>
      <div id="biliscript-reading-view"></div>`;

    const rightAnchor = document.querySelector(".right-container-inner") as HTMLElement;
    rightAnchor.getBoundingClientRect = () =>
      ({ x: 900, y: 120, top: 120, left: 900, right: 1260, bottom: 720, width: 360, height: 600, toJSON: () => ({}) });
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    document.documentElement.scrollTop = 300;
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });

    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const scrollToSpy = vi.spyOn(window, "scrollTo");

    const { biliHostAdapter } = await import("../../extension/bilibili/host-adapter.js");
    const { startPlaybackRateButtons, stopPlaybackRateButtons } = await import(
      "../../extension/bilibili/playback-rate.js"
    );
    const { openScriptHost, closeScriptHost } = await import("../../extension/reader/script-host.js");
    const { startReadingViewSync, stopReadingViewSync } = await import("../../extension/reader/sync.js");
    const { isPlayerFullscreen } = await import("../../extension/bilibili/fullscreen.js");

    startPlaybackRateButtons();
    openScriptHost();
    startReadingViewSync();
    expect(biliHostAdapter.getActiveObserverCount()).toBe(1);

    const player = document.querySelector(".bpx-player-container") as HTMLElement;
    player.setAttribute("data-screen", "wide");
    window.dispatchEvent(new Event("resize"));
    expect(isPlayerFullscreen(player)).toBe(false);

    player.setAttribute("data-screen", "web");
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(isPlayerFullscreen(player)).toBe(true);

    player.setAttribute("data-screen", "normal");
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(isPlayerFullscreen(player)).toBe(false);

    await vi.advanceTimersByTimeAsync(400);

    stopReadingViewSync();
    closeScriptHost();
    stopPlaybackRateButtons();

    expect(biliHostAdapter.getActiveObserverCount()).toBe(0);
    expect(biliHostAdapter.getSubscriberCount()).toBe(0);

    for (const [type, handler] of winAdd.mock.calls) {
      expect(
        winRemove.mock.calls.some(([rt, rh]) => rt === type && rh === handler),
        `window 监听未回收: ${String(type)}`
      ).toBe(true);
    }
    for (const [type, handler] of docAdd.mock.calls) {
      expect(
        docRemove.mock.calls.some(([rt, rh]) => rt === type && rh === handler),
        `document 监听未回收: ${String(type)}`
      ).toBe(true);
    }

    expect(document.documentElement.scrollTop).toBe(300);
    expect(window.scrollY).toBe(300);
    expect(scrollToSpy).not.toHaveBeenCalled();

    const readingView = document.getElementById("biliscript-reading-view") as HTMLElement;
    await vi.advanceTimersByTimeAsync(10000);
    expect(readingView.style.getPropertyValue("--biliscript-script-top")).toBe("");
  });
});
