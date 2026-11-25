// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";

const mockTranslate = vi.hoisted(() => ({
  translateSubtitleTrack: vi.fn(async (input: { items: SubtitleBodyItem[]; targetLang: string }) => ({
    mode: "cc-json" as const,
    items: input.items,
    translations: input.items.map((item) => ({
      from: item.from,
      to: item.to,
      content: input.targetLang === "en" ? "Hello world" : `[${input.targetLang}] ${item.content}`
    }))
  }))
}));

vi.mock("../../extension/ai/subtitle-translate.js", async () => {
  const actual = await vi.importActual<typeof import("../../extension/ai/subtitle-translate.js")>(
    "../../extension/ai/subtitle-translate.js"
  );
  return {
    ...actual,
    translateSubtitleTrack: mockTranslate.translateSubtitleTrack
  };
});

function buildBiliPlayerDom(options: {
  wrapHeight?: number;
  controlHeight?: number;
  controlsHidden?: boolean;
} = {}) {
  const wrapHeight = options.wrapHeight ?? 500;
  const controlHeight = options.controlHeight ?? 56;

  const container = document.createElement("div");
  container.className = options.controlsHidden
    ? "bpx-player-container bpx-state-no-cursor"
    : "bpx-player-container";

  const videoWrap = document.createElement("div");
  videoWrap.className = "bpx-player-video-wrap";
  Object.defineProperty(videoWrap, "clientHeight", { value: wrapHeight, configurable: true });
  videoWrap.getBoundingClientRect = () =>
    ({ width: 800, height: wrapHeight, top: 0, left: 0, right: 800, bottom: wrapHeight, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

  const nativeSubtitleWrap = document.createElement("div");
  nativeSubtitleWrap.className = "bpx-player-subtitle-wrap";

  const controlWrap = document.createElement("div");
  controlWrap.className = "bpx-player-control-wrap";
  Object.defineProperty(controlWrap, "clientHeight", { value: controlHeight, configurable: true });
  controlWrap.getBoundingClientRect = () =>
    ({ width: 800, height: controlHeight, top: wrapHeight - controlHeight, left: 0, right: 800, bottom: wrapHeight, x: 0, y: wrapHeight - controlHeight, toJSON: () => ({}) }) as DOMRect;

  const controlBottomRight = document.createElement("div");
  controlBottomRight.className = "bpx-player-control-bottom-right";
  const qualityBtn = document.createElement("button");
  qualityBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-quality";
  controlBottomRight.appendChild(qualityBtn);
  controlWrap.appendChild(controlBottomRight);

  const actionWrap = document.createElement("div");
  actionWrap.id = "biliscript-player-interpret-quick-action-wrap";
  const actionBtn = document.createElement("button");
  actionBtn.id = "biliscript-player-interpret-quick-action";
  actionWrap.appendChild(actionBtn);
  controlBottomRight.appendChild(actionWrap);

  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
  videoWrap.appendChild(video);

  container.append(videoWrap, nativeSubtitleWrap, controlWrap);
  document.body.appendChild(container);
  return { container, videoWrap, nativeSubtitleWrap, controlWrap, actionWrap, actionBtn, video };
}

describe("播放器双语字幕叠层升级验收", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = "";
    mockTranslate.translateSubtitleTrack.mockClear();
  });

  afterEach(async () => {
    const { disposePlayerInterpret } = await import("../../extension/live/player-interpret.js");
    disposePlayerInterpret();
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("1) 原生 en-US(3条) 与 zh-CN(2条、错开 0.3s) 异构双轨独立二分命中与局部防闪烁更新", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const { acceptSubtitle, acceptSecondarySubtitle } = await import("../../extension/subtitle/commit.js");
    const { createInterpretSubtitleOverlay } = await import("../../extension/live/player-interpret.js");
    const { createInterpretSessionController } = await import(
      "../../extension/live/interpret-session-controller.js"
    );

    const { container, videoWrap, video } = buildBiliPlayerDom({ controlsHidden: true });

    const enTrack = {
      id: "cc-en",
      lan: "en-US",
      lanDoc: "English",
      subtitleUrl: "https://sub.test/en.json",
      source: "player" as const
    };
    const zhTrack = {
      id: "cc-zh",
      lan: "zh-CN",
      lanDoc: "中文（简体）",
      subtitleUrl: "https://sub.test/zh.json",
      source: "player" as const
    };

    const enBody: SubtitleBodyItem[] = [
      { from: 0.0, to: 2.0, content: "First English sentence." },
      { from: 2.5, to: 4.5, content: "Second English sentence." },
      { from: 5.0, to: 7.0, content: "Third English sentence." }
    ];
    const zhBody: SubtitleBodyItem[] = [
      { from: 0.3, to: 3.2, content: "第一句对应跨段中文。" },
      { from: 3.5, to: 7.3, content: "第二句错位中文结尾。" }
    ];

    state.setSettings({
      ...DEFAULT_SETTINGS,
      liveInterpretDisplayMode: "bilingual",
      secondarySubtitleLang: "zh-CN"
    });
    clipState.setBvid("BV1heteroPair");
    clipState.setCid("1001");
    clipState.setSubtitles([enTrack, zhTrack] as never);
    await acceptSubtitle({
      body: enBody,
      selectedSubtitleId: enTrack.id,
      selectedSubtitleUrl: enTrack.subtitleUrl,
      selectedSubtitleLang: enTrack.lanDoc,
      skipHotComments: true
    });

    let activeGen = 0;
    const overlay = createInterpretSubtitleOverlay({
      getPlayerHost: () => container,
      getTargetLang: () => "zh",
      getDisplayMode: () => "bilingual",
      getDisplayOrder: () => "original-first"
    });

    const controller = createInterpretSessionController({
      getVideoElement: () => video,
      onGenerationChange: (gen) => {
        activeGen = gen;
        overlay.setSessionGeneration(gen);
      },
      setSubtitle: (orig, trans) => overlay.setSubtitle(orig, trans, activeGen),
      clearSubtitles: overlay.unmount,
      clearSubtitlesOnSeek: overlay.clearForSeek,
      loadNativeSecondaryTrack: async (target) => {
        await acceptSecondarySubtitle({
          body: zhBody,
          subtitleId: target.id,
          subtitleUrl: target.url
        });
      }
    });

    video.currentTime = 0.1;
    expect(await controller.start()).toBe(true);

    const root = overlay.getElement()!;
    expect(videoWrap.contains(overlay.getContainerElement())).toBe(true);
    const originalEl = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translationEl = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;

    expect(originalEl.textContent).toBe("First English sentence.");
    expect(originalEl.hidden).toBe(false);
    expect(translationEl.hidden).toBe(true);
    expect(root.hidden).toBe(false);

    video.currentTime = 1.0;
    video.dispatchEvent(new Event("timeupdate"));
    expect(originalEl.textContent).toBe("First English sentence.");
    expect(originalEl.hidden).toBe(false);
    expect(translationEl.textContent).toBe("第一句对应跨段中文。");
    expect(translationEl.hidden).toBe(false);

    const translationTextNode = translationEl.firstChild;
    video.currentTime = 2.2;
    video.dispatchEvent(new Event("timeupdate"));
    expect(originalEl.hidden).toBe(true);
    expect(translationEl.hidden).toBe(false);
    expect(translationEl.textContent).toBe("第一句对应跨段中文。");
    expect(translationEl.firstChild).toBe(translationTextNode);

    video.currentTime = 2.8;
    video.dispatchEvent(new Event("timeupdate"));
    expect(originalEl.hidden).toBe(false);
    expect(originalEl.textContent).toBe("Second English sentence.");
    expect(translationEl.hidden).toBe(false);
    expect(translationEl.textContent).toBe("第一句对应跨段中文。");
    expect(translationEl.firstChild).toBe(translationTextNode);

    video.currentTime = 3.3;
    video.dispatchEvent(new Event("timeupdate"));
    expect(originalEl.hidden).toBe(false);
    expect(originalEl.textContent).toBe("Second English sentence.");
    expect(translationEl.hidden).toBe(true);

    video.currentTime = 7.1;
    video.dispatchEvent(new Event("seeking"));
    expect(originalEl.hidden).toBe(true);
    expect(translationEl.hidden).toBe(false);
    expect(translationEl.textContent).toBe("第二句错位中文结尾。");

    overlay.setSubtitle("过期原文", "过期译文", activeGen - 1);
    expect(translationEl.textContent).toBe("第二句错位中文结尾。");

    video.currentTime = 7.5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(root.hidden).toBe(true);

    await controller.stop();
    expect(overlay.getElement()).toBeNull();
    overlay.dispose();
  });

  it("2) 纯中文单轨未开双语不挂载叠层；开启 zh -> en 双语后挂载并由 blurSecondary 作用于英文副行，缩放 75%-150% 防抖落盘", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const { acceptSubtitle } = await import("../../extension/subtitle/commit.js");
    const interpret = await import("../../extension/live/player-interpret.js");

    const sendMessageSpy = vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(
      (message: any, callback?: (res: unknown) => void) => {
        if (message?.type === "resolve-subtitle-translate-provider") {
          callback?.({
            ok: true,
            provider: {
              id: "mock-ai",
              name: "Mock AI",
              baseUrl: "https://api.mock",
              models: ["m1"],
              enabled: true
            },
            apiKey: "sk-mock",
            model: "m1",
            isFallback: false
          });
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      }
    );

    const { container, videoWrap, actionWrap, video } = buildBiliPlayerDom({ controlsHidden: true });
    video.currentTime = 1.0;

    state.setSettings({
      ...DEFAULT_SETTINGS,
      bilingualSubtitles: false,
      liveInterpretTargetLang: "zh",
      liveInterpretFontScale: 100,
      liveInterpretBlurSecondary: false
    });
    clipState.setBvid("BV1zhOnlyTest");
    clipState.setCid("2002");
    clipState.setSubtitles([
      {
        id: "cc-zh",
        lan: "zh-CN",
        lanDoc: "中文（简体）",
        subtitleUrl: "https://sub.test/zh.json",
        source: "player"
      }
    ] as never);
    await acceptSubtitle({
      body: [{ from: 0, to: 5, content: "你好，世界" }],
      selectedSubtitleId: "cc-zh",
      selectedSubtitleUrl: "https://sub.test/zh.json",
      selectedSubtitleLang: "中文（简体）",
      skipHotComments: true
    });

    interpret.syncPlayerInterpretQuickAction();

    expect(videoWrap.querySelector(".biliscript-interpret-subtitle-container")).toBeNull();
    expect(container.querySelector(".biliscript-interpret-subtitle-overlay")).toBeNull();
    expect(container.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);

    state.patchSettings({ bilingualSubtitles: true });
    interpret.syncPlayerInterpretQuickAction();
    expect(videoWrap.querySelector(".biliscript-interpret-subtitle-container")).toBeNull();
    expect(container.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);

    await interpret.applyInterpretMenuChoice({ kind: "bilingual", targetLang: "en" });
    await vi.waitFor(() => {
      const overlayRoot = videoWrap.querySelector<HTMLElement>("#biliscript-interpret-subtitle-overlay");
      expect(overlayRoot).not.toBeNull();
      expect(overlayRoot!.hidden).toBe(false);
      expect(
        overlayRoot!.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")?.textContent
      ).toBe("Hello world");
    });

    const overlayContainer = videoWrap.querySelector<HTMLElement>(".biliscript-interpret-subtitle-container")!;
    const overlayRoot = videoWrap.querySelector<HTMLElement>("#biliscript-interpret-subtitle-overlay")!;
    const originalEl = overlayRoot.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translationEl = overlayRoot.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;

    expect(container.getAttribute("data-biliscript-subtitle-takeover")).toBe("true");
    expect(originalEl.textContent).toBe("你好，世界");
    expect(originalEl.getAttribute("data-subtitle-role")).toBe("primary");
    expect(translationEl.textContent).toBe("Hello world");
    expect(translationEl.getAttribute("data-subtitle-role")).toBe("secondary");
    expect(overlayRoot.getAttribute("data-blur-secondary")).toBe("false");

    await interpret.togglePlayerInterpretMenu(actionWrap);
    const menu = document.getElementById("biliscript-interpret-menu")!;
    const blurSwitch = menu.querySelector<HTMLButtonElement>('[data-action="toggle-blur-secondary"]')!;
    expect(blurSwitch).not.toBeNull();

    vi.useFakeTimers();
    sendMessageSpy.mockClear();
    blurSwitch.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(overlayRoot.getAttribute("data-blur-secondary")).toBe("true");
    expect(translationEl.getAttribute("data-subtitle-role")).toBe("secondary");

    const incBtn = () => menu.querySelector<HTMLButtonElement>('[data-action="scale-up"]')!;
    const decBtn = () => menu.querySelector<HTMLButtonElement>('[data-action="scale-down"]')!;
    const resetBtn = () => menu.querySelector<HTMLButtonElement>('[data-action="scale-reset"]')!;
    expect(resetBtn().textContent).toBe("100%");

    incBtn().click();
    await vi.advanceTimersByTimeAsync(1);
    expect(resetBtn().textContent).toBe("110%");
    incBtn().click();
    await vi.advanceTimersByTimeAsync(1);
    expect(resetBtn().textContent).toBe("120%");
    expect(overlayContainer.style.getPropertyValue("--biliscript-interpret-font-scale")).toBe("1.2");

    const saveCallsBeforeTimer = sendMessageSpy.mock.calls
      .map(([msg]) => msg as Record<string, unknown>)
      .filter((m) => m.type === "save-settings");
    expect(saveCallsBeforeTimer).toHaveLength(0);

    vi.advanceTimersByTime(300);
    const saveCallsAfterTimer = sendMessageSpy.mock.calls
      .map(([msg]) => msg as Record<string, unknown>)
      .filter((m) => m.type === "save-settings");
    expect(saveCallsAfterTimer).toHaveLength(1);
    expect(saveCallsAfterTimer[0].settings).toEqual({
      liveInterpretBlurSecondary: true,
      liveInterpretFontScale: 120
    });

    await interpret.applyInterpretMenuChoice({ kind: "set-font-scale", fontScale: 150 });
    await interpret.syncInterpretSubtitleMenu();
    expect(incBtn().disabled).toBe(true);
    expect(decBtn().disabled).toBe(false);

    await interpret.applyInterpretMenuChoice({ kind: "set-font-scale", fontScale: 75 });
    await interpret.syncInterpretSubtitleMenu();
    expect(decBtn().disabled).toBe(true);
    expect(incBtn().disabled).toBe(false);

    resetBtn().click();
    await vi.advanceTimersByTimeAsync(1);
    expect(resetBtn().textContent).toBe("100%");
    expect(overlayContainer.style.getPropertyValue("--biliscript-interpret-font-scale")).toBe("1");
    vi.useRealTimers();

    await interpret.applyInterpretMenuChoice({ kind: "off" });
    expect(videoWrap.querySelector(".biliscript-interpret-subtitle-container")).toBeNull();
    expect(container.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);
  });

  it("3) 控制栏避让偏移计算、isHovered 冻结锁、点击/拖拽区分与 positionRatio 边界钳制", async () => {
    const {
      computeInterpretPositionRatio,
      computeInterpretSubtitleBottomPx,
      createInterpretSubtitleOverlay
    } = await import("../../extension/live/player-interpret.js");
    const { clampInterpretPositionRatio } = await import(
      "../../extension/live/interpret-position-persistence.js"
    );

    expect(clampInterpretPositionRatio(-0.5)).toBe(0.04);
    expect(clampInterpretPositionRatio(0.99)).toBe(0.85);
    expect(clampInterpretPositionRatio("bad")).toBeNull();
    expect(computeInterpretPositionRatio(200, 0)).toBeNull();
    expect(computeInterpretPositionRatio(150, 500)).toBe(0.3);

    expect(
      computeInterpretSubtitleBottomPx({
        playerClientHeight: 500,
        positionRatio: null,
        controlsVisible: false,
        controlBarHeight: 56
      })
    ).toBe(40);

    expect(
      computeInterpretSubtitleBottomPx({
        playerClientHeight: 500,
        positionRatio: null,
        controlsVisible: true,
        controlBarHeight: 56
      })
    ).toBe(72);

    expect(
      computeInterpretSubtitleBottomPx({
        playerClientHeight: 500,
        positionRatio: 0.5,
        controlsVisible: true,
        controlBarHeight: 56
      })
    ).toBe(250);

    expect(
      computeInterpretSubtitleBottomPx({
        playerClientHeight: 500,
        positionRatio: null,
        controlsVisible: false,
        controlBarHeight: 56,
        isHovered: true,
        frozenBottomPx: 72
      })
    ).toBe(72);

    const { container } = buildBiliPlayerDom({
      wrapHeight: 500,
      controlHeight: 56,
      controlsHidden: true
    });
    const saveRatioSpy = vi.fn();
    const overlay = createInterpretSubtitleOverlay({
      getPlayerHost: () => container,
      getTargetLang: () => "zh",
      getDisplayMode: () => "bilingual",
      loadPositionRatio: async () => null,
      savePositionRatio: saveRatioSpy
    });

    overlay.setSubtitle("Line A", "台词 A");
    const root = overlay.getElement()!;
    root.getBoundingClientRect = () =>
      ({ width: 320, height: 52, top: 408, left: 240, right: 560, bottom: 460, x: 240, y: 408, toJSON: () => ({}) }) as DOMRect;
    overlay.syncPosition();
    expect(root.style.bottom).toBe("40px");

    container.classList.remove("bpx-state-no-cursor");
    await vi.waitFor(() => expect(root.style.bottom).toBe("72px"));

    root.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
    expect(overlay.isHovered()).toBe(true);
    container.classList.add("bpx-state-no-cursor");
    await Promise.resolve();
    await Promise.resolve();
    expect(root.style.bottom).toBe("72px");

    root.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
    expect(overlay.isHovered()).toBe(false);
    expect(root.style.bottom).toBe("40px");

    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 400, bubbles: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: 101, clientY: 398, bubbles: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: 101, clientY: 398, bubbles: true })
    );
    expect(saveRatioSpy).not.toHaveBeenCalled();
    expect(root.style.bottom).toBe("40px");

    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 2, clientX: 100, clientY: 400, bubbles: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 2, clientX: 100, clientY: 240, bubbles: true })
    );
    expect(root.classList.contains("is-dragging")).toBe(true);
    expect(root.style.bottom).toBe("200px");
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 2, clientX: 100, clientY: 240, bubbles: true })
    );
    expect(root.classList.contains("is-dragging")).toBe(false);
    expect(saveRatioSpy).toHaveBeenCalledTimes(1);
    expect(saveRatioSpy).toHaveBeenLastCalledWith(0.4);
    expect(overlay.getPositionRatio()).toBe(0.4);

    root.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, pointerId: 3, clientX: 100, clientY: 300, bubbles: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 3, clientX: 100, clientY: -500, bubbles: true })
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 3, clientX: 100, clientY: -500, bubbles: true })
    );
    expect(root.style.bottom).toBe("425px");
    expect(saveRatioSpy).toHaveBeenLastCalledWith(0.85);

    overlay.dispose();
  });

  it("6) YouTube #movie_player 叠层挂载、ytp-autohide 避让、原生字幕接管与无字幕不回落 ASR", async () => {
    const { state, clipState } = await import("../../extension/core/state.js");
    const {
      createInterpretSubtitleOverlay,
      detectPlayerControlBarState,
      syncNativePlayerSubtitleTakeover
    } = await import("../../extension/live/player-interpret.js");
    const { createInterpretSessionController } = await import(
      "../../extension/live/interpret-session-controller.js"
    );

    clipState.setSite("youtube");
    clipState.setBvid("yt~dQw4w9WgXcQ");
    clipState.setCid("yt");
    clipState.setSubtitles([]);
    clipState.setSubtitleBody([]);
    clipState.setSubtitleFetchState("empty");

    const player = document.createElement("div");
    player.id = "movie_player";
    player.className = "html5-video-player";
    Object.defineProperty(player, "clientHeight", { value: 540, configurable: true });
    player.getBoundingClientRect = () =>
      ({ width: 960, height: 540, top: 0, left: 0, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const chromeBottom = document.createElement("div");
    chromeBottom.className = "ytp-chrome-bottom";
    Object.defineProperty(chromeBottom, "clientHeight", { value: 52, configurable: true });
    chromeBottom.getBoundingClientRect = () =>
      ({ width: 960, height: 52, top: 488, left: 0, right: 960, bottom: 540, x: 0, y: 488, toJSON: () => ({}) }) as DOMRect;

    const nativeCaptions = document.createElement("div");
    nativeCaptions.className = "ytp-caption-window-container";
    player.append(nativeCaptions, chromeBottom);
    document.body.appendChild(player);

    expect(detectPlayerControlBarState(player)).toEqual({ visible: true, height: 52 });

    const overlay = createInterpretSubtitleOverlay({
      getPlayerHost: () => player,
      getTargetLang: () => "zh",
      getDisplayMode: () => "bilingual",
      loadPositionRatio: async () => null,
      savePositionRatio: () => {}
    });

    overlay.setSubtitle("Hello YouTube", "你好 YouTube");
    const container = overlay.getContainerElement()!;
    const root = overlay.getElement()!;
    expect(container.parentElement).toBe(player);
    expect(root.style.bottom).toBe("68px");

    player.classList.add("ytp-autohide");
    expect(detectPlayerControlBarState(player)).toEqual({ visible: false, height: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.style.bottom).toBe("40px");

    syncNativePlayerSubtitleTakeover(true, player);
    expect(player.getAttribute("data-biliscript-subtitle-takeover")).toBe("true");
    syncNativePlayerSubtitleTakeover(false);
    expect(player.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);

    const controller = createInterpretSessionController({
      resolveTranslateProvider: async () =>
        ({
          provider: { id: "test", name: "Test" },
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          model: "gpt-test",
          presetId: "openai",
          isFallback: false
        }) as never
    });
    const availability = await controller.refreshAvailability();
    expect(availability).toEqual({ ok: false, error: "当前视频暂无可用字幕" });

    controller.dispose();
    overlay.dispose();
    expect(state.clip.site).toBe("youtube");
  });
});
