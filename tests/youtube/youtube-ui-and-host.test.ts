// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState } from "../setup.js";

const YOUTUBE_WATCH_A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YOUTUBE_WATCH_B = "https://www.youtube.com/watch?v=9bZkp7q19f0";
const YOUTUBE_HOME = "https://www.youtube.com/";

function setTestUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

class StubChildWindow extends EventTarget {
  closed = false;
  innerWidth: number;
  innerHeight: number;
  document: Document;
  focus = vi.fn();

  constructor(options: { width?: number; height?: number } = {}) {
    super();
    this.innerWidth = options.width ?? 520;
    this.innerHeight = options.height ?? 740;
    this.document = document.implementation.createHTMLDocument("Detached");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.dispatchEvent(new Event("pagehide"));
  }
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({ left, top, width, height })
  } as DOMRect;
}

function mockElementRect(el: Element, rect: DOMRect): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => rect
  });
}

function mockViewportSize(width: number, height = 900): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: height });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

function makeYoutubeWatchDom(): {
  flexy: HTMLElement;
  actions: HTMLElement;
  topButtons: HTMLElement;
  player: HTMLElement;
  secondary: HTMLElement;
  video: HTMLVideoElement;
} {
  document.body.innerHTML = `
    <ytd-watch-flexy>
      <div id="columns">
        <div id="primary">
          <div id="movie_player">
            <video class="html5-main-video"></video>
          </div>
          <div id="above-the-fold">
            <div id="actions">
              <div id="actions-inner">
                <ytd-menu-renderer>
                  <div id="top-level-buttons-computed"></div>
                </ytd-menu-renderer>
              </div>
            </div>
          </div>
        </div>
        <div id="secondary"></div>
      </div>
    </ytd-watch-flexy>
  `;
  const flexy = document.querySelector<HTMLElement>("ytd-watch-flexy")!;
  const actions = document.querySelector<HTMLElement>("#actions")!;
  const topButtons = document.querySelector<HTMLElement>("#top-level-buttons-computed")!;
  const player = document.querySelector<HTMLElement>("#movie_player")!;
  const secondary = document.querySelector<HTMLElement>("#secondary")!;
  const video = document.querySelector<HTMLVideoElement>("#movie_player video")!;
  return { flexy, actions, topButtons, player, secondary, video };
}

function getVars(el: HTMLElement): Record<string, string> {
  return {
    left: el.style.getPropertyValue("--biliscript-script-left"),
    top: el.style.getPropertyValue("--biliscript-script-top"),
    width: el.style.getPropertyValue("--biliscript-script-width"),
    height: el.style.getPropertyValue("--biliscript-script-height")
  };
}

function stubSettingsChromeMessages(overrides: Record<string, unknown> = {}): void {
  const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
  sendMessage.mockImplementation((message: { type?: string }, callback?: (resp: unknown) => void) => {
    if (message?.type === "get-settings") {
      callback?.({
        ok: true,
        settings: {
          readerTheme: "bilibili",
          readerThemeUserSet: false,
          readerPalette: "flyme",
          enablePlayerAiQuickAction: true,
          enableExtraPlaybackRates: true,
          autoOpenReader: false,
          enableAgentBridge: false,
          subtitleTranslateSource: "bilibili-index-translate",
          subtitleTranslateModel: "Index-Translate-35B-A3B",
          ...overrides
        }
      });
      return undefined;
    }
    if (message?.type?.endsWith("-providers-list")) {
      callback?.({ ok: true, providers: [] });
      return undefined;
    }
    callback?.({ ok: true });
    return undefined;
  });
}

function expectDetachedShellOpen(mode: "pip" | "popup"): {
  mode: "pip" | "popup";
  childWin: StubChildWindow;
  setupOpenerMocks: (win: StubChildWindow) => void;
} {
  const childWin = new StubChildWindow();
  const setupOpenerMocks = (win: StubChildWindow) => {
    if (mode === "pip") {
      Object.defineProperty(window, "documentPictureInPicture", {
        configurable: true,
        writable: true,
        value: { requestWindow: vi.fn(async () => win as unknown as Window) }
      });
    } else {
      Object.defineProperty(window, "documentPictureInPicture", {
        configurable: true,
        writable: true,
        value: undefined
      });
      vi.spyOn(window, "open").mockImplementation(() => win as unknown as Window);
    }
  };
  return { mode, childWin, setupOpenerMocks };
}

function emitSyncStorageChanged(changes: Record<string, { newValue: unknown }>): void {
  const addListener = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
  for (const [listener] of addListener.mock.calls) {
    if (typeof listener === "function") {
      listener(changes, "sync");
    }
  }
}

function getSentRuntimeMessageTypes(): string[] {
  const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
  return sendMessage.mock.calls
    .map((args) => String((args[0] as { type?: unknown } | undefined)?.type || ""))
    .filter(Boolean);
}

beforeEach(() => {
  setTestUrl(NORMAL_PAGE_URL);
  resetModuleState();
  setTestUrl(YOUTUBE_WATCH_A);
  document.documentElement.removeAttribute("dark");
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
  mockViewportSize(1440, 900);
});

afterEach(() => {
  setTestUrl(NORMAL_PAGE_URL);
  document.documentElement.removeAttribute("dark");
  document.body.innerHTML = "";
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    writable: true,
    value: undefined
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("YouTube host-adapter DOM 探测与视频筛选", () => {
  it("探测操作栏挂载点并过滤隐藏与 miniplayer 容器", async () => {
    const adapter = await import("../../extension/youtube/host-adapter.js");
    document.body.innerHTML = `
      <ytd-miniplayer><div id="actions"><div id="top-level-buttons-computed"></div></div></ytd-miniplayer>
      <ytd-watch-flexy>
        <div id="above-the-fold">
          <div id="actions"><div id="top-level-buttons-computed"></div></div>
        </div>
      </ytd-watch-flexy>
    `;
    const flexyComputed = document.querySelector<HTMLElement>(
      "ytd-watch-flexy #above-the-fold #top-level-buttons-computed"
    )!;
    expect(adapter.findYoutubeActionHost(document)).toBe(flexyComputed);

    document.body.innerHTML = '<div id="actions"></div>';
    expect(adapter.findYoutubeActionHost(document)).toBe(document.querySelector("#actions"));
  });

  it("识别 theater / full-bleed / fullscreen / #secondary 落至播放器下方并校验宽度与视口边界", async () => {
    const adapter = await import("../../extension/youtube/host-adapter.js");
    const { flexy, player, secondary } = makeYoutubeWatchDom();
    mockElementRect(player, makeRect(24, 80, 960, 540));
    mockElementRect(secondary, makeRect(1020, 80, 400, 700));

    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("ok");

    mockElementRect(secondary, makeRect(1020, 80, 279, 700));
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("narrow");

    mockElementRect(secondary, makeRect(1100, 80, 400, 700));
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("out-of-viewport");

    mockElementRect(secondary, makeRect(24, 620, 400, 700));
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("below-player");

    mockElementRect(secondary, makeRect(1020, 80, 400, 700));
    flexy.setAttribute("theater", "");
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("theater-or-full-bleed");

    flexy.removeAttribute("theater");
    flexy.setAttribute("full-bleed-player", "");
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("theater-or-full-bleed");

    flexy.removeAttribute("full-bleed-player");
    player.classList.add("ytp-fullscreen");
    expect(adapter.findYoutubeScriptAnchor(document, 1440).reason).toBe("theater-or-full-bleed");
  });

  it("主视频查找跳过 miniplayer、preview 卡片与历史帧捕获 video", async () => {
    const adapter = await import("../../extension/youtube/host-adapter.js");
    document.body.innerHTML = `
      <ytd-miniplayer><video id="mini-v"></video></ytd-miniplayer>
      <ytd-video-preview><video id="preview-v"></video></ytd-video-preview>
      <video data-biliscript-historical-frame="1" id="hist-v"></video>
      <ytd-watch-flexy>
        <div id="movie_player"><video class="html5-main-video" id="main-v"></video></div>
      </ytd-watch-flexy>
    `;
    expect(adapter.isIgnoredYoutubeVideoCandidate(document.getElementById("mini-v"))).toBe(true);
    expect(adapter.isIgnoredYoutubeVideoCandidate(document.getElementById("preview-v"))).toBe(true);
    expect(adapter.isIgnoredYoutubeVideoCandidate(document.getElementById("hist-v"))).toBe(true);
    expect(adapter.getYoutubeVideoElement(document)).toBe(document.getElementById("main-v"));

    document.getElementById("main-v")?.remove();
    expect(adapter.getYoutubeVideoElement(document)).toBeNull();
  });
});

describe("宿主主题 <html dark> 与主题文案通用化", () => {
  it("支持 <html dark> 布尔属性与观测回调", async () => {
    const hostTheme = await import("../../extension/shared/host-theme.js");
    const onChange = vi.fn();
    const stop = hostTheme.watchExternalThemeChanges(onChange, { doc: document });

    document.documentElement.setAttribute("dark", "");
    expect(hostTheme.detectBilibiliHostTheme(document)).toBe("dark");
    await flushMicrotasks();
    expect(onChange).toHaveBeenCalledTimes(1);

    document.documentElement.setAttribute("dark", "false");
    expect(hostTheme.detectBilibiliHostTheme(document)).toBe("light");

    document.documentElement.setAttribute("dark", "0");
    expect(hostTheme.detectBilibiliHostTheme(document)).toBe("light");

    document.documentElement.setAttribute("dark", "true");
    expect(hostTheme.detectHostTheme(document)).toBe("dark");

    stop();
  });

  it("将主题展示文案统一为「跟随当前站点」且保留 bilibili 枚举键", async () => {
    const { themeButtonView } = await import("../../extension/ui/theme-button.js");
    const { buildSystemPagesHtml } = await import("../../extension/ui/settings/templates/system-pages.js");
    const { deriveSettingsSummaries } = await import("../../extension/ui/settings/summaries.js");

    expect(themeButtonView("dark", "bilibili").title).toBe("跟随当前站点（深色）");
    expect(themeButtonView("light", "bilibili").title).toBe("跟随当前站点（浅色）");
    expect(buildSystemPagesHtml()).toContain('<option value="bilibili">跟随当前站点</option>');

    const summaries = deriveSettingsSummaries({
      form: {
        aiDefaultModelLabel: "",
        asrAutoFallback: false,
        webSearchMaxToolCalls: 3,
        enablePlayerAiQuickAction: false,
        initialQuickPromptCount: 0,
        speechVoiceVolume: 100,
        downloadFormat: "srt",
        subtitleTranslateModelLabel: "Index-Translate",
        subtitleTranslateGlossary: "",
        readerTheme: "bilibili",
        readerPalette: "flyme",
        readerFontSizeScale: 100,
        enableAgentBridge: false,
        chatHistoryMaxCount: 0,
        videoCacheMaxMb: 150,
        enableDebugLogs: false
      },
      providerSnapshot: null,
      agentBridgeState: null,
      playerQuickAiAvailable: false
    });
    expect(summaries.appearanceSettings).toContain("跟随当前站点");
  });
});

describe("YouTube script-button 挂载、明暗外观与 SPA 离开卸载", () => {
  it("在 #actions 挂载非 B 站粉胶囊按钮，响应 <html dark> 并于离开 /watch 时移除", async () => {
    makeYoutubeWatchDom();
    const scriptBtnMod = await import("../../extension/ui/script-button.js");
    await vi.waitFor(() => {
      expect(document.getElementById("biliscript-script-button")).not.toBeNull();
    });

    const btn = document.getElementById("biliscript-script-button")!;
    expect(document.querySelector("#actions")?.contains(btn)).toBe(true);
    expect(btn.style.borderRadius).toBe("18px");
    expect(btn.style.background).not.toContain("251, 114, 153");
    expect(btn.dataset.biliscriptHostTheme).toBe("light");

    document.documentElement.setAttribute("dark", "");
    await vi.waitFor(() => {
      expect(btn.dataset.biliscriptHostTheme).toBe("dark");
    });

    setTestUrl(YOUTUBE_HOME);
    const { contentEventBus } = await import("../../extension/shared/content-event-bus.js");
    contentEventBus.emit("host:url-change", { url: YOUTUBE_HOME });
    expect(document.getElementById("biliscript-script-button")).toBeNull();

    scriptBtnMod.removeScriptButton();
  });

  it("Polymer 延迟水合出 #actions 时通过 MutationObserver 自动挂载按钮", async () => {
    document.body.innerHTML = "<ytd-watch-flexy></ytd-watch-flexy>";
    const scriptBtnMod = await import("../../extension/ui/script-button.js");
    await flushMicrotasks();
    expect(document.getElementById("biliscript-script-button")).toBeNull();

    const flexy = document.querySelector("ytd-watch-flexy")!;
    const actions = document.createElement("div");
    actions.id = "actions";
    flexy.appendChild(actions);

    await vi.waitFor(() => {
      expect(document.getElementById("biliscript-script-button")).not.toBeNull();
    });
    expect(actions.contains(document.getElementById("biliscript-script-button"))).toBe(true);
    scriptBtnMod.removeScriptButton();
  });
});

describe("YouTube script-host 右栏锚定、剧场降级与实时重排", () => {
  it("锚定 #secondary 并对 theater / 落至播放器下方跳过贴栏降级浮层，关闭时清理监听", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { flexy, player, secondary } = makeYoutubeWatchDom();
    mockElementRect(player, makeRect(24, 80, 940, 520));
    mockElementRect(secondary, makeRect(990, 80, 410, 700));

    const view = document.createElement("section");
    view.id = "biliscript-reading-view";
    document.body.appendChild(view);

    const { clipState } = await import("../../extension/core/state.js");
    clipState.setSite("youtube");
    const host = await import("../../extension/reader/script-host.js");
    host.openScriptHost();

    expect(view.getAttribute("data-biliscript-script-float")).toBeNull();
    expect(getVars(view)).toEqual({
      left: "990px",
      top: "80px",
      width: "450px",
      height: "820px"
    });

    flexy.setAttribute("theater", "");
    await vi.waitFor(() => {
      expect(view.getAttribute("data-biliscript-script-float")).toBe("1");
    });

    flexy.removeAttribute("theater");
    await vi.waitFor(() => {
      expect(view.getAttribute("data-biliscript-script-float")).toBeNull();
    });

    mockElementRect(secondary, makeRect(24, 620, 410, 700));
    window.dispatchEvent(new Event("resize"));
    expect(view.getAttribute("data-biliscript-script-float")).toBe("1");

    host.closeScriptHost();
    expect(view.getAttribute("data-biliscript-script-float")).toBeNull();

    mockElementRect(secondary, makeRect(990, 80, 410, 700));
    flexy.setAttribute("theater", "");
    await flushMicrotasks();
    expect(getVars(view).width).toBe("");
  });
});

describe("YouTube 设置抽屉 4 项站点门控与进入阻断", () => {
  it("YouTube 页面隐藏 4 项 B 站专属设置、保留播放器快捷 AI 按钮与 Index-Translate", async () => {
    const { clipState, transitionReaderShell } = await import("../../extension/core/state.js");
    const { requestUiCommand } = await import("../../extension/reader/reader-bus.js");
    const { isSettingsViewAllowed } = await import("../../extension/ui/settings/navigation.js");
    const settingsPanel = await import("../../extension/ui/settings-panel.js");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");

    stubSettingsChromeMessages();
    clipState.setSite("youtube");
    uiRenderer.ensureUiReady();
    transitionReaderShell("open");
    await settingsPanel.renderReaderSettingsPanel();

    const host = document.getElementById("biliscript-reading-settings-host")!;
    expect(document.getElementById("openLiveSettingsBtn")!.hidden).toBe(true);
    expect(document.getElementById("openAsrSettingsBtn")!.hidden).toBe(false);
    expect(document.getElementById("openAgentSettingsBtn")!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-settings-section="ai-button"]')!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-settings-item="extra-playback-rates"]')!.hidden).toBe(true);

    expect(host.querySelector<HTMLElement>("#autoOpenReader")!.closest<HTMLElement>(".biliscript-toggle-row")!.hidden).toBe(false);
    expect(document.getElementById("openSubtitleSettingsBtn")!.hidden).toBe(false);
    expect(document.getElementById("subtitleTranslateSource")).not.toBeNull();
    expect(
      host.querySelector('#subtitleTranslateSource option[value="bilibili-index-translate"]')
    ).not.toBeNull();
    expect(document.getElementById("aiPromptSummary")!.textContent).toContain("播放器快捷开");

    expect(isSettingsViewAllowed("live")).toBe(false);
    expect(isSettingsViewAllowed("asr")).toBe(true);
    expect(isSettingsViewAllowed("agent")).toBe(true);
    expect(isSettingsViewAllowed("agent-address")).toBe(true);
    expect(isSettingsViewAllowed("subtitle")).toBe(true);

    const settingsPanelEl = document.getElementById("biliscript-reading-settings-panel")!;
    expect(settingsPanelEl.hidden).toBe(true);

    requestUiCommand("open-settings", { target: "live" });
    requestUiCommand("open-settings", { target: "gemini-key" });
    await settingsPanel.openLiveSettings("live");
    await flushMicrotasks();

    expect(settingsPanelEl.hidden).toBe(true);
    expect(document.getElementById("biliscriptSettingsSubpageLive")!.hidden).toBe(true);

    document.getElementById("openAsrSettingsBtn")!.click();
    await vi.waitFor(() => {
      expect(document.getElementById("biliscriptSettingsSubpageAsr")!.hidden).toBe(false);
    });

    document.getElementById("openAgentSettingsBtn")!.click();
    await vi.waitFor(() => {
      expect(document.getElementById("biliscriptSettingsSubpageAgent")!.hidden).toBe(false);
    });

    const { ensureReaderDomain } = await import("../../extension/reader/lazy-reader.js");
    requestUiCommand("open-settings", { target: "appearance" });
    await vi.waitFor(() => {
      expect(settingsPanelEl.hidden).toBe(false);
      expect(document.getElementById("biliscriptSettingsSubpageAppearance")!.hidden).toBe(false);
    });
    await ensureReaderDomain();

    (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockClear();
    emitSyncStorageChanged({
      enableAgentBridge: { newValue: true },
      agentBridgeUrl: { newValue: "ws://127.0.0.1:18492" }
    });
    await flushMicrotasks();
    expect(getSentRuntimeMessageTypes()).toContain("agent-bridge-status");
  });

  it("reader.css 通过 #biliscript-reading-view .markdown-body 覆盖 --base-size-* 并隔离 YouTube 根字号", () => {
    const readerCss = readFileSync(
      join(process.cwd(), "extension/entry/styles/reader.css"),
      "utf8"
    );
    expect(readerCss).toMatch(
      /#biliscript-reading-view\s+\.markdown-body\s*\{[^}]*--base-size-16:\s*var\(--biliscript-primitive-space-16\)/s
    );
    expect(readerCss).toMatch(
      /body:has\(ytd-watch-flexy\[fullscreen\]\)\s+#biliscript-reading-view:not\(\[data-biliscript-detached="1"\]\)/
    );
  });

  it("B 站页面保留全部 5 项设置入口可用", async () => {
    setTestUrl(NORMAL_PAGE_URL);
    const { clipState, transitionReaderShell } = await import("../../extension/core/state.js");
    const settingsPanel = await import("../../extension/ui/settings-panel.js");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");

    stubSettingsChromeMessages();
    clipState.setSite("bilibili");
    uiRenderer.ensureUiReady();
    transitionReaderShell("open");
    await settingsPanel.renderReaderSettingsPanel();

    const host = document.getElementById("biliscript-reading-settings-host")!;
    expect(document.getElementById("openAsrSettingsBtn")!.hidden).toBe(false);
    expect(document.getElementById("openAgentSettingsBtn")!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-settings-section="ai-button"]')!.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-settings-item="extra-playback-rates"]')!.hidden).toBe(false);
  });
});

describe("YouTube 视频绑定、PageContext、独立窗口 SPA 换片保持与离开关闭", () => {
  it("resolvePageContext 支持 YouTube 单单元 CID 与 video-bind / seek 跳过预览视频", async () => {
    const { clipState, state } = await import("../../extension/core/state.js");
    const { YOUTUBE_UNIT_CID } = await import("../../extension/shared/site.js");
    const { resolvePageContext } = await import("../../extension/reader/page-context.js");
    const { bindReadingViewVideo, unbindReadingViewVideoSync } = await import("../../extension/reader/video-bind.js");
    const { seekReadingTarget } = await import("../../extension/reader/sync.js");

    document.body.innerHTML = `
      <ytd-video-preview><video id="preview"></video></ytd-video-preview>
      <ytd-watch-flexy>
        <div id="movie_player"><video class="html5-main-video" id="main"></video></div>
      </ytd-watch-flexy>
    `;
    const previewVideo = document.getElementById("preview") as HTMLVideoElement;
    const mainVideo = document.getElementById("main") as HTMLVideoElement;
    Object.defineProperty(mainVideo, "duration", { configurable: true, value: 215 });

    clipState.setSite("youtube");
    const ctx = resolvePageContext(YOUTUBE_WATCH_A);
    expect(ctx).toEqual({
      pageIndex: 1,
      cid: YOUTUBE_UNIT_CID,
      cidSource: "youtube-unit",
      duration: 215,
      pageTitle: ""
    });

    const bound = bindReadingViewVideo(previewVideo);
    expect(bound).toBe(mainVideo);
    expect(state.reader.readingVideoEl).toBe(mainVideo);

    const sought = seekReadingTarget(42);
    expect(sought).toBe(42);
    expect(mainVideo.currentTime).toBe(42);

    const firstController = mainVideo.__biliscriptReadingSyncController;
    unbindReadingViewVideoSync();
    expect(state.reader.readingVideoEl).toBeNull();
    expect(firstController?.signal.aborted).toBe(true);

    const rebound = bindReadingViewVideo();
    expect(rebound).toBe(mainVideo);
    expect(mainVideo.__biliscriptReadingSyncController).toBeDefined();
    expect(mainVideo.__biliscriptReadingSyncController).not.toBe(firstController);
  });

  it("YouTube 独立窗口（pip 与 popup）在 SPA 换片时保持开启刷新且离开 /watch 时干净关闭", async () => {
    const pipHarness = expectDetachedShellOpen("pip");
    pipHarness.setupOpenerMocks(pipHarness.childWin);

    const { clipState, state } = await import("../../extension/core/state.js");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const shell = await import("../../extension/reader/shell.js");
    const lifecycle = await import("../../extension/reader/lifecycle.js");
    const detachedWindow = await import("../../extension/reader/detached-window.js");

    makeYoutubeWatchDom();
    clipState.setSite("youtube");
    clipState.setTitle("Clip A");
    await shell.enterReaderShell({ readerUrl: YOUTUBE_WATCH_A, intent: "open" });

    expect(await shell.detachReaderShell()).toBe(true);
    expect(state.reader.readingDetached).toBe(true);
    expect(state.reader.readingDetachedMode).toBe("pip");
    expect(pipHarness.childWin.document.getElementById("biliscript-reading-view")).not.toBeNull();

    setTestUrl(YOUTUBE_WATCH_B);
    clipState.setTitle("Clip B");
    clipState.setSubtitleBody([{ from: 0, to: 10, content: "Hello B" }]);
    uiRenderer.ensureUiReady();
    lifecycle.onReaderSubtitleReady({ syncPlayback: true, triggerMode: "always" });

    expect(state.reader.readingDetached).toBe(true);
    expect(pipHarness.childWin.closed).toBe(false);
    expect(pipHarness.childWin.document.title).toContain("Clip B");

    setTestUrl(YOUTUBE_HOME);
    clipState.setSite("bilibili");
    await shell.exitReaderShell();
    expect(pipHarness.childWin.closed).toBe(true);
    expect(state.reader.readingDetached).toBe(false);
    expect(state.reader.readingViewOpen).toBe(false);
    expect(detachedWindow.getDetachedWindowHost()).toBeNull();

    const popupHarness = expectDetachedShellOpen("popup");
    popupHarness.setupOpenerMocks(popupHarness.childWin);
    setTestUrl(YOUTUBE_WATCH_A);
    makeYoutubeWatchDom();
    clipState.setSite("youtube");
    clipState.setTitle("Popup A");
    await shell.enterReaderShell({ readerUrl: YOUTUBE_WATCH_A, intent: "open" });
    expect(await shell.detachReaderShell()).toBe(true);
    expect(state.reader.readingDetachedMode).toBe("popup");

    setTestUrl(YOUTUBE_WATCH_B);
    clipState.setTitle("Popup B");
    uiRenderer.ensureUiReady();
    lifecycle.onReaderSubtitleReady({ syncPlayback: true, triggerMode: "always" });
    expect(popupHarness.childWin.closed).toBe(false);
    expect(popupHarness.childWin.document.title).toContain("Popup B");

    setTestUrl(YOUTUBE_HOME);
    await shell.exitReaderShell();
    expect(popupHarness.childWin.closed).toBe(true);
    expect(state.reader.readingViewOpen).toBe(false);
  });

  it("Chain 4 协同：clip-switch-transaction 驱动 script-button / script-host / detached-window / shell 完成 SPA 切片与离开 /watch 收口", async () => {
    const pipHarness = expectDetachedShellOpen("pip");
    pipHarness.setupOpenerMocks(pipHarness.childWin);

    const { clipState, state } = await import("../../extension/core/state.js");
    const { detectSiteFromUrl, isYoutubeWatchPage } = await import("../../extension/shared/site.js");
    const { computeCurrentClipSignature, isReaderMode, isSupportedVideoPage } = await import(
      "../../extension/bilibili/video-id-shared.js"
    );
    const { contentEventBus } = await import("../../extension/shared/content-event-bus.js");
    const { createClipSwitchTransaction } = await import("../../extension/entry/clip-switch-transaction.js");
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const shell = await import("../../extension/reader/shell.js");
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    const { enforceNormalPageStateIfNeeded } = await import("../../extension/reader/state.js");
    const scriptBtnMod = await import("../../extension/ui/script-button.js");
    const { player, secondary } = makeYoutubeWatchDom();
    mockElementRect(player, makeRect(24, 80, 960, 540));
    mockElementRect(secondary, makeRect(1020, 80, 400, 700));

    await vi.waitFor(() => {
      expect(document.getElementById("biliscript-script-button")).not.toBeNull();
    });

    clipState.setSite("youtube");
    clipState.setBvid("dQw4w9WgXcQ");
    clipState.setCid("yt");
    clipState.setTitle("Clip A");
    clipState.setCurrentUrl(YOUTUBE_WATCH_A);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(YOUTUBE_WATCH_A));
    await shell.enterReaderShell({ readerUrl: YOUTUBE_WATCH_A, intent: "open" });

    const readingView = document.getElementById("biliscript-reading-view")!;
    expect(readingView.getAttribute("data-biliscript-script-float")).not.toBe("1");
    expect(Number.parseInt(getVars(readingView).left, 10)).toBeGreaterThan(0);

    expect(await shell.detachReaderShell()).toBe(true);
    expect(pipHarness.childWin.document.title).toContain("Clip A");
    expect(document.getElementById("biliscript-script-button")).not.toBeNull();

    const transaction = createClipSwitchTransaction({
      readUrl: () => location.href,
      computeSignature: () => computeCurrentClipSignature(),
      readSignature: () => state.clip.currentClipSignature,
      writeIdentity: (url, signature) => {
        clipState.setSite(detectSiteFromUrl(url));
        clipState.setCurrentUrl(url);
        clipState.setCurrentClipSignature(signature);
      },
      readRunId: () => clipState.fetchRunId,
      writeRunId: (runId) => clipState.setFetchRunId(runId),
      enforceNormalPageStateIfNeeded,
      isReaderViewOpen: () => state.reader.readingViewOpen,
      isReaderMode,
      isSupportedVideoPage: (url) => (detectSiteFromUrl(url) === "youtube" ? isYoutubeWatchPage(url) : isSupportedVideoPage(url)),
      isPlayerAiLoaded: () => false,
      ensureUiReady: async () => {
        uiRenderer.ensureUiReady();
      },
      resetClipState: () => {
        clipState.setTitle("");
        clipState.setSubtitleBody([]);
        notifyReaderPresenter({ kind: "reset" });
      },
      syncPlayerAiQuickAction: () => {},
      enterReaderShellOnUrlNavigation: async (url) => {
        await shell.enterReaderShellOnUrlNavigation({ readerUrl: url });
      },
      refreshReaderClip: async () => {
        await flushMicrotasks();
        clipState.setTitle("Clip B");
        clipState.setSubtitleBody([{ from: 0, to: 10, content: "Subtitle B" }]);
        notifyReaderPresenter({ kind: "subtitle-ready" });
      },
      exitReaderShell: () => shell.exitReaderShell(),
      startSubtitlePrefetch: () => {},
      logWarn: () => {}
    });

    const settledPromises: Array<Promise<void>> = [];
    const waitSettled = () =>
      new Promise<void>((resolve) => {
        transaction.subscribeSettled(() => resolve(), { once: true });
      });

    setTestUrl(YOUTUBE_WATCH_B);
    settledPromises.push(waitSettled());
    transaction.handleUrlChange();
    contentEventBus.emit("host:url-change", { url: YOUTUBE_WATCH_B });
    await settledPromises[0];

    expect(pipHarness.childWin.closed).toBe(false);
    expect(pipHarness.childWin.document.title).toContain("Clip B");
    expect(document.getElementById("biliscript-script-button")).not.toBeNull();

    setTestUrl(YOUTUBE_HOME);
    settledPromises.push(waitSettled());
    transaction.handleUrlChange();
    contentEventBus.emit("host:url-change", { url: YOUTUBE_HOME });
    await settledPromises[1];

    expect(pipHarness.childWin.closed).toBe(true);
    expect(state.reader.readingViewOpen).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(getVars(readingView).left).toBe("");
    expect(document.getElementById("biliscript-script-button")).toBeNull();
    expect(location.href).toBe(YOUTUBE_HOME);
    expect(location.href).not.toContain("biliscript_reader");

    scriptBtnMod.removeScriptButton();
  });

  it("无 biliscript_reader 参数的 YouTube /watch 在 bindNormalPageStateGuard 下打开阅读器异步等待期间保留 data-biliscript-reader-mode=1 且退出后清除", async () => {
    const { clipState, getReaderShellState, state, transitionReaderShell } = await import(
      "../../extension/core/state.js"
    );
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    const readerState = await import("../../extension/reader/state.js");
    const shell = await import("../../extension/reader/shell.js");
    const scriptBtnMod = await import("../../extension/ui/script-button.js");

    makeYoutubeWatchDom();
    clipState.setSite("youtube");
    clipState.setBvid("dQw4w9WgXcQ");
    clipState.setCid("yt");
    uiRenderer.ensureUiReady();
    readerState.bindNormalPageStateGuard();

    expect(transitionReaderShell("entering")).toBe(true);
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    await flushMicrotasks();
    readerState.enforceNormalPageStateIfNeeded(YOUTUBE_WATCH_A);
    expect(getReaderShellState()).toBe("entering");
    expect(state.reader.readingViewOpen).toBe(false);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");

    expect(transitionReaderShell("closed")).toBe(true);
    document.documentElement.removeAttribute("data-biliscript-reader-mode");
    document.body.removeAttribute("data-biliscript-reader-mode");

    await shell.enterReaderShell({ readerUrl: YOUTUBE_WATCH_A, intent: "open" });
    await flushMicrotasks();

    expect(location.href).toBe(YOUTUBE_WATCH_A);
    expect(location.href).not.toContain("biliscript_reader");
    expect(state.reader.readingViewOpen).toBe(true);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");

    await shell.exitReaderShell();
    await flushMicrotasks();

    expect(state.reader.readingViewOpen).toBe(false);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBeNull();
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBeNull();

    scriptBtnMod.removeScriptButton();
  });
});

describe("YouTube player-ai 快捷按钮挂载、隔离、点击总结与 SPA 卸载", () => {
  it("在 #movie_player 挂载 AI 快捷按钮且不挂载 live/interpret，支持悬停显隐、防双击冒泡、退全屏并发送 player-ai-quick-action", async () => {
    const { clipState, state } = await import("../../extension/core/state.js");
    const playerAi = await import("../../extension/ai/player-ai.js");
    const { player, video } = makeYoutubeWatchDom();
    mockElementRect(player, makeRect(24, 56, 960, 540));
    mockElementRect(video, makeRect(24, 56, 960, 540));
    stubSettingsChromeMessages({ enablePlayerAiQuickAction: true });

    clipState.setSite("youtube");
    state.setSettings({
      ...state.settings,
      enablePlayerAiQuickAction: true
    });

    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });

    const playerClickSpy = vi.fn();
    const playerDblClickSpy = vi.fn();
    player.addEventListener("click", playerClickSpy);
    player.addEventListener("dblclick", playerDblClickSpy);

    const exitFullscreenMock = vi.fn(async () => {});
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => player
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitFullscreenMock
    });

    const chromeBottom = document.createElement("div");
    chromeBottom.className = "ytp-chrome-bottom";
    const rightControls = document.createElement("div");
    rightControls.className = "ytp-right-controls";
    const nativeSubtitlesBtn = document.createElement("button");
    nativeSubtitlesBtn.className = "ytp-subtitles-button ytp-button";
    rightControls.appendChild(nativeSubtitlesBtn);
    chromeBottom.appendChild(rightControls);
    player.appendChild(chromeBottom);

    try {
      playerAi.startPlayerAiQuickAction();

      const button = document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement | null;
      const wrap = button?.closest(".biliscript-player-ai-wrap") as HTMLElement | null;
      expect(button).not.toBeNull();
      expect(wrap).not.toBeNull();
      expect(wrap?.parentElement).toBe(player);
      expect(document.getElementById("biliscript-player-live-quick-action")).toBeNull();
      const interpretWrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
      const interpretBtn = document.getElementById("biliscript-player-interpret-quick-action");
      expect(interpretWrap?.parentElement).toBe(rightControls);
      expect(interpretWrap?.nextElementSibling).toBe(nativeSubtitlesBtn);
      expect(interpretBtn?.classList.contains("biliscript-player-interpret-quick-action--youtube")).toBe(true);

      player.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      expect(wrap?.classList.contains("is-active")).toBe(true);
      player.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      expect(wrap?.classList.contains("is-active")).toBe(false);

      button!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      expect(playerDblClickSpy).not.toHaveBeenCalled();

      (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockClear();
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(getSentRuntimeMessageTypes()).toContain("player-ai-quick-action");
      });
      expect(playerClickSpy).not.toHaveBeenCalled();
      expect(exitFullscreenMock).toHaveBeenCalledTimes(1);

      setTestUrl(YOUTUBE_HOME);
      playerAi.schedulePlayerAiQuickActionSync(0);
      expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();

      setTestUrl(YOUTUBE_WATCH_B);
      player.closest("ytd-watch-flexy")!.setAttribute("hidden", "");
      playerAi.schedulePlayerAiQuickActionSync(0);
      expect(document.getElementById("biliscript-player-ai-quick-action")).toBeNull();

      player.closest("ytd-watch-flexy")!.removeAttribute("hidden");
      playerAi.schedulePlayerAiQuickActionSync(0);
      expect(document.getElementById("biliscript-player-ai-quick-action")).not.toBeNull();
    } finally {
      playerAi.stopPlayerAiQuickAction();
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => null
      });
      rafSpy.mockRestore();
    }
  });
});
