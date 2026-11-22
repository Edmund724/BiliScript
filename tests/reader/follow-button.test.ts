import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let subtitleScrollFollow: typeof import("../../extension/reader/subtitle-scroll-follow.js").subtitleScrollFollow;
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  const coreState = await import("../../extension/core/state.js");
  state = coreState.state as TestState;
  transitionReaderShell = coreState.transitionReaderShell;
  subtitleScrollFollow = (await import("../../extension/reader/subtitle-scroll-follow.js")).subtitleScrollFollow;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
}

function readingView(): HTMLElement {
  return document.getElementById(ids.readingView) as HTMLElement;
}

function followValue(): string | null {
  return readingView().getAttribute("data-biliscript-reader-follow");
}

function seedBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  mockPlayerRects();
  seedBody();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Follow playback 悬浮按钮", () => {
  it("初始（未交互）无 follow 属性：按钮不应处于任何显态依据", () => {
    shell.renderReadingView();
    expect(followValue()).toBe(null);
  });

  it("manual 态（手动滚离）点击：清暂停、follow 回 auto、跳回当前句但不改播放进度", () => {
    transitionReaderShell("open");
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    video.play = () => Promise.resolve();
    video.currentTime = 12;

    shell.syncReadingViewPlayback(true);
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);

    shell.noteManualReaderInteraction(60_000);
    expect(followValue()).toBe("manual");
    expect(subtitleScrollFollow.isManualPaused()).toBe(true);
    const followBtn = document.getElementById(ids.readingFollowBtn) as HTMLElement;
    expect(followBtn.textContent).toBe("回到当前播放 · 0:12");

    shell.resumeReaderFollowPlayback();
    expect(subtitleScrollFollow.isManualPaused()).toBe(false);
    expect(followValue()).toBe("auto");
    expect(video.currentTime).toBe(12);
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });
});
