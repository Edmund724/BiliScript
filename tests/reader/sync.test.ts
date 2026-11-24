import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let readerState: typeof import("../../extension/reader/state.js");
let sync: typeof shell;
let playerHost: typeof shell;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  transitionReaderShell = stateMod.transitionReaderShell;
  shell = await import("../../extension/reader/index.js");
  readerState = await import("../../extension/reader/state.js");
  ids = readerState.ids;
  sync = shell;
  playerHost = shell;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function switchReaderScriptTab(tab: "subtitle" | "overview"): void {
  readerState.setReaderActiveScriptTab(tab);
  uiRenderer.setReaderScriptTab(tab);
}

function mountExtraSkeleton() {
  const doc = document;

  const readingView = doc.body.querySelector(`#${ids.readingView}`) as HTMLElement;
  const readingThemeSelect = doc.createElement("button");
  readingThemeSelect.id = ids.readingThemeSelect;
  readingView.appendChild(readingThemeSelect);

  const readingCloseBtn = doc.createElement("button");
  readingCloseBtn.id = ids.readingCloseBtn;
  readingView.appendChild(readingCloseBtn);

  const panel = doc.createElement("div");
  panel.id = "biliscript-panel";
  doc.body.appendChild(panel);
  (
    [
      ["biliscript-close-btn", "button"],
      ["biliscript-refresh-btn", "button"],
      ["biliscript-subtitle-select", "select"],
      ["biliscript-copy-btn", "button"],
      ["biliscript-download-btn", "button"],
      ["biliscript-settings-btn", "button"]
    ] as [string, keyof HTMLElementTagNameMap][]
  ).forEach(([id, tag]) => {
    const node = doc.createElement(tag);
    node.id = id;
    panel.appendChild(node);
  });

  return { readingThemeSelect, readingCloseBtn, panel };
}

function setStateClip() {
  state.clip.chapters = [
    { title: "开场", from: 0 },
    { title: "正片", from: 30 },
    { title: "结尾", from: 60 }
  ];
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  mountExtraSkeleton();
  video = mountPlayerChain();
  mockPlayerRects();
  setStateClip();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("播放同步与高亮", () => {
  it("手动渲染列表后无高亮项（activeIndex 为 -1）", () => {
    shell.renderReadingView();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.querySelectorAll(".biliscript-reading-item").length).toBe(3);
    expect(readingView.querySelector(".biliscript-reading-item.is-active")).toBe(null);
    expect(readingView.querySelector(".biliscript-reading-chapter")).toBe(null);
  });

  it("syncReadingViewPlayback：按 currentTime 切换字幕与章节高亮", () => {
    transitionReaderShell("open");
    shell.renderReadingView();

    const bound = playerHost.bindReadingViewVideo(video);
    expect(bound).toBe(video);
    expect(video.__biliscriptReadingSyncController).toBeInstanceOf(AbortController);

    video.currentTime = 12;
    sync.syncReadingViewPlayback();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const activeSubtitle = readingView.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(activeSubtitle.dataset.index).toBe("1");
    expect(activeSubtitle.textContent).toContain("第二句");

    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    expect(state.reader.readingActiveChapterIndex).toBe(0);
  });

  it("概览 tab：按概览章节边界切换高亮，暂停定位保留且不自动滚动", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    shell.renderReadingOverview({
      phase: "ready",
      analysis: {
        summary: "全片简介。",
        chapters: [
          { from: 0, to: 20, title: "概览第一章", summary: "" },
          { from: 20, to: 60, title: "概览第二章", summary: "" }
        ],
        quotes: []
      },
      aiChapters: true,
      progressText: "",
      errorText: "",
      stripText: "",
      generatedFor: ""
    });
    switchReaderScriptTab("overview");
    playerHost.bindReadingViewVideo(video);
    const overview = document.getElementById(ids.readingOverviewBody) as HTMLElement;
    overview.scrollTop = 120;

    video.currentTime = 35;
    sync.syncReadingViewPlayback();
    let active = overview.querySelector<HTMLElement>(".biliscript-reading-ov-chapter.is-active");
    expect(active?.dataset.seconds).toBe("20");
    expect(active?.getAttribute("aria-current")).toBe("true");

    const qsaSpy = vi.spyOn(overview, "querySelectorAll");
    video.currentTime = 42;
    sync.syncReadingViewPlayback();
    expect(qsaSpy).not.toHaveBeenCalled();
    qsaSpy.mockRestore();

    video.currentTime = 5;
    sync.syncReadingViewPlayback();
    active = overview.querySelector<HTMLElement>(".biliscript-reading-ov-chapter.is-active");
    expect(active?.dataset.seconds).toBe("0");
    expect(overview.querySelectorAll(".biliscript-reading-ov-chapter.is-active")).toHaveLength(1);
    expect(overview.scrollTop).toBe(120);
  });

  it("video seeked 事件驱动即时同步并切换字幕高亮（暂停态 seek 兜底）", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    video.currentTime = 35;
    video.dispatchEvent(new Event("seeked"));

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const activeSubtitle = readingView.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(activeSubtitle.dataset.index).toBe("2");
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
    expect(state.reader.readingActiveChapterIndex).toBe(1);
  });

  it("sync tick 布局读取前置短路：稳态拍不读 rect，真实滚动拍恰读两次", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    video.currentTime = 12;
    sync.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    rectSpy.mockClear();

    sync.syncReadingViewPlayback();
    sync.syncReadingViewPlayback();
    expect(rectSpy).not.toHaveBeenCalled();

    video.currentTime = 45;
    sync.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
    expect(rectSpy).toHaveBeenCalledTimes(2);
  });

  it("P3-1 字幕 tab 隐藏：tick 跳过高亮/滚动段，跟随态照常收敛", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    switchReaderScriptTab("overview");

    video.currentTime = 12;
    sync.syncReadingViewPlayback();
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    sync.syncReadingViewPlayback();

    expect(rectSpy).not.toHaveBeenCalled();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.querySelector(".biliscript-reading-item.is-active")).toBe(null);
    expect(state.reader.readingActiveSubtitleIndex).toBe(-1);

    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
  });

  it("P3-1 切回字幕 tab：下一拍补上高亮与索引（跳过的段自然收敛）", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    switchReaderScriptTab("overview");

    video.currentTime = 12;
    sync.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(-1);

    switchReaderScriptTab("subtitle");
    sync.syncReadingViewPlayback();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const activeSubtitle = readingView.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(activeSubtitle.dataset.index).toBe("1");
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });

  it("P3-1 设置抽屉展开（三 tab body 被 CSS 压掉）：同样跳过滚动/高亮段", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    state.reader.setSettingsExpanded(true);

    video.currentTime = 12;
    sync.syncReadingViewPlayback();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.querySelector(".biliscript-reading-item.is-active")).toBe(null);
    expect(state.reader.readingActiveSubtitleIndex).toBe(-1);
  });

  it("播放稳态仅 interval 单路驱动：timeupdate 派发不触发同步（P3 单路化锁）", async () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    video.currentTime = 12;
    sync.syncReadingViewPlayback();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);

    video.currentTime = 35;
    video.dispatchEvent(new Event("timeupdate"));
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    const activeSubtitle = readingView.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(activeSubtitle.textContent).toContain("第二句");

    sync.startReadingViewSync();
    video.currentTime = 45;
    await vi.waitFor(() => {
      expect(state.reader.readingActiveSubtitleIndex).toBe(2);
    });
    sync.stopReadingViewSync();
  });

  it("停止同步：移除事件监听与定时器", () => {
    transitionReaderShell("open");
    playerHost.bindReadingViewVideo(video);
    sync.startReadingViewSync();
    const controller = video.__biliscriptReadingSyncController;
    expect(controller).toBeInstanceOf(AbortController);

    sync.stopReadingViewSync();

    expect(controller!.signal.aborted).toBe(true);
    expect(video.__biliscriptReadingSyncController).toBeUndefined();
  });

  it("点击字幕跳转：选择文本时忽略，空白选区时跳转", async () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());
    uiRenderer.bindUiEvents();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const target = readingView.querySelectorAll(".biliscript-reading-item")[2] as HTMLElement;

    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(video.currentTime).toBe(0);

    selection.removeAllRanges();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(video.currentTime).toBe(30);
    });
    const activeSubtitle = readingView.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(activeSubtitle.dataset.index).toBe("2");
  });

  it("jumpReadingTarget：暂停时触发播放", () => {
    transitionReaderShell("open");
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());

    sync.jumpReadingTarget(45);

    expect(video.currentTime).toBe(45);
    expect(video.play).toHaveBeenCalled();
  });

  it("updateReaderFollowState：按手动暂停状态写入 data-biliscript-reader-follow", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    transitionReaderShell("open");

    sync.noteManualReaderInteraction(5000);
    sync.updateReaderFollowState();
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    sync.updateReaderFollowState();
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
  });

  it("noteManualReaderInteraction：手动交互暂停跟随（data-biliscript-reader-follow=manual）", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    transitionReaderShell("open");

    sync.noteManualReaderInteraction(5000);

    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
  });

  it("noteManualReaderInteraction 缺省无超时：手动滚动后保持 manual 态，视频播放时不被强制拉回", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    video.currentTime = 5;
    sync.syncReadingViewPlayback(true);
    expect(state.reader.readingActiveSubtitleIndex).toBe(0);

    sync.noteManualReaderInteraction();
    sync.updateReaderFollowState();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    sync.updateReaderFollowState();
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    Object.defineProperty(subtitleList, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(subtitleList, "scrollHeight", { value: 1200, configurable: true });
    const listScrollToSpy = vi.fn();
    subtitleList.scrollTo = listScrollToSpy;
    video.currentTime = 12;
    const windowScrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    sync.syncReadingViewPlayback();

    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
    expect(listScrollToSpy).not.toHaveBeenCalled();
    expect(windowScrollToSpy).not.toHaveBeenCalled();

    sync.resumeReaderFollowPlayback();
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
    expect(listScrollToSpy).toHaveBeenCalled();
    expect(windowScrollToSpy).not.toHaveBeenCalled();
  });

  it("短字幕容器未溢出（scrollHeight <= clientHeight + 8）：同步与恢复跟随均不滚动宿主页 window", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    Object.defineProperty(subtitleList, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(subtitleList, "scrollHeight", { value: 200, configurable: true });
    const listScrollToSpy = vi.fn();
    subtitleList.scrollTo = listScrollToSpy;
    const windowScrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    video.currentTime = 12;
    sync.syncReadingViewPlayback(true);
    sync.resumeReaderFollowPlayback();

    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
    expect(listScrollToSpy).not.toHaveBeenCalled();
    expect(windowScrollToSpy).not.toHaveBeenCalled();
  });

  it("pointerdown 时存在文本选区：随后点击收起选区即使选区已空也不触发跳播", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    playerHost.bindReadingViewVideo(video);
    video.play = vi.fn(() => Promise.resolve());
    video.currentTime = 5;

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const target = readingView.querySelectorAll(".biliscript-reading-item")[1] as HTMLElement;

    sync.markSubtitlePointerDownSelection(true);
    document.getSelection()?.removeAllRanges();
    sync.onReadingSubtitleClick({ target } as unknown as MouseEvent);
    expect(video.currentTime).toBe(5);

    sync.markSubtitlePointerDownSelection(false);
    sync.onReadingSubtitleClick({ target } as unknown as MouseEvent);
    expect(video.currentTime).toBe(10);
  });
});

describe("站点感知运行时视频探针 (getSiteRuntimeVideoElement)", () => {
  it("YouTube 站点优先使用已连接的 readingVideoEl，否则回退主播放器并忽略悬浮预览与迷你播放器", async () => {
    const { getSiteRuntimeVideoElement } = await import("../../extension/core/site-video-probe.js");
    state.clip.site = "youtube";
    state.reader.readingVideoEl = null;

    document.body.innerHTML = `
      <ytd-video-preview><video id="preview-v"></video></ytd-video-preview>
      <ytd-miniplayer><video id="mini-v"></video></ytd-miniplayer>
      <div id="movie_player"><video id="main-v" class="html5-main-video"></video></div>
    `;
    const previewVideo = document.getElementById("preview-v") as HTMLVideoElement;
    const miniVideo = document.getElementById("mini-v") as HTMLVideoElement;
    const mainVideo = document.getElementById("main-v") as HTMLVideoElement;
    previewVideo.getBoundingClientRect = () => ({ width: 800, height: 450 } as DOMRect);
    miniVideo.getBoundingClientRect = () => ({ width: 400, height: 225 } as DOMRect);
    mainVideo.getBoundingClientRect = () => ({ width: 640, height: 360 } as DOMRect);

    expect(getSiteRuntimeVideoElement(document)).toBe(mainVideo);

    const disconnectedVideo = document.createElement("video");
    state.reader.readingVideoEl = disconnectedVideo;
    expect(getSiteRuntimeVideoElement(document)).toBe(mainVideo);

    const boundVideo = document.createElement("video");
    document.body.appendChild(boundVideo);
    state.reader.readingVideoEl = boundVideo;
    expect(getSiteRuntimeVideoElement(document)).toBe(boundVideo);
  });
});
