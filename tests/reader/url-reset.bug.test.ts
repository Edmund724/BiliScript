import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { TestState } from "./reader-test-env.js";

const shellMocks = vi.hoisted(() => ({
  enterReaderShell: vi.fn(async () => {}),
  enterReaderShellOnUrlNavigation: vi.fn(async () => {}),
  exitReaderShell: vi.fn(async () => {})
}));

vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: vi.fn(async () => shellMocks)
}));

vi.mock("../../extension/reader/index.js", async (importActual) => {
  const actual = await importActual() as typeof import("../../extension/reader/index.js");
  return { ...actual, enterReaderMode: vi.fn(async () => {}) };
});

const OTHER_VIDEO_URL = "https://www.bilibili.com/video/BV1test999999/";
const OTHER_VIDEO_READER_URL = "https://www.bilibili.com/video/BV1test999999/?biliscript_reader=1";

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let readerUrl: typeof import("../../extension/bilibili/reader-url.js");
let messageHandler: typeof import("../../extension/entry/message-handler.js");
let videoIdShared: typeof import("../../extension/bilibili/video-id-shared.js");
let readerState: typeof import("../../extension/reader/state.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(NORMAL_PAGE_URL);
  const stateModule = await import("../../extension/core/state.js") as typeof import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  readerUrl = await import("../../extension/bilibili/reader-url.js");
  messageHandler = await import("../../extension/entry/message-handler.js");
  videoIdShared = await import("../../extension/bilibili/video-id-shared.js");
  readerState = await import("../../extension/reader/state.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function seedFetchedClip() {
  state.clip.title = "测试视频";
  state.clip.chapters = [
    { title: "开场", from: 0 },
    { title: "正片", from: 30 }
  ];
  clipState.setCurrentClipSignature(videoIdShared.computeCurrentClipSignature());
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SPA URL 变化的阅读壳分支", () => {
  it("pushState 串联同 clip reader 入口与非支持页退出，且入口不重置内容", async () => {
    const pageUrl = "https://www.bilibili.com/video/BV1test000000/?p=2";
    setLocationUrl(pageUrl);
    seedFetchedClip();
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "保留字幕" }];
    clipState.setFetchRunId(7);
    messageHandler.bindUrlChangeHandler();

    history.pushState(history.state, "", `${pageUrl}&biliscript_reader=1`);

    await vi.waitFor(() => {
      expect(shellMocks.enterReaderShellOnUrlNavigation).toHaveBeenCalledTimes(1);
    });
    expect(state.clip.chapters).toHaveLength(2);
    expect(state.clip.subtitleBody).toHaveLength(1);
    expect(clipState.fetchRunId).toBe(7);
    expect(shellMocks.exitReaderShell).not.toHaveBeenCalled();

    state.reader.setViewOpen(true);
    history.pushState(history.state, "", "https://www.bilibili.com/read/cv123/?biliscript_reader=1");

    await vi.waitFor(() => {
      expect(shellMocks.exitReaderShell).toHaveBeenCalledTimes(1);
    });
    expect(shellMocks.enterReaderShellOnUrlNavigation).toHaveBeenCalledTimes(1);
  });
});

describe("replaceState 补丁与章节清空（5be8f39 嫌疑路径）", () => {
  it("F1. 修复后：replaceReaderModeUrl 切换到另一视频的阅读模式 URL，已抓取章节保留", () => {
    seedFetchedClip();
    messageHandler.bindUrlChangeHandler();

    readerUrl.replaceReaderModeUrl(OTHER_VIDEO_READER_URL);

    expect(state.clip.chapters.length).toBe(2);
    expect(state.clip.title).toBe("测试视频");
  });

  it("F2. 旧调用模式（red-capable 对照）：replaceState 前不更新签名，章节被清空", async () => {
    seedFetchedClip();
    messageHandler.bindUrlChangeHandler();

    history.replaceState(history.state, "", OTHER_VIDEO_READER_URL);

    await vi.waitFor(() => {
      expect(state.clip.chapters.length).toBe(0);
    }, { timeout: 5000 });
  });
});

describe("非支持页的 reader 页面状态", () => {
  it("即使 URL 带 reader 参数且视图状态仍开着，也清除阅读模式页面属性", () => {
    state.reader.setViewOpen(true);
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    const unsupportedReaderUrl = "https://www.bilibili.com/read/cv123/?biliscript_reader=1";

    readerState.enforceNormalPageStateIfNeeded(unsupportedReaderUrl);

    expect(document.documentElement.hasAttribute("data-biliscript-reader-mode")).toBe(false);
    expect(document.body.hasAttribute("data-biliscript-reader-mode")).toBe(false);
  });
});
