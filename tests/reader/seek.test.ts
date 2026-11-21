import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let scrollState: typeof import("../../extension/reader/state.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let video: HTMLVideoElement;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  const stateModule = await import("../../extension/reader/state.js");
  scrollState = stateModule;
  ids = stateModule.ids;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
  mockPlayerRects();
  state.clip.chapters = [{ title: "开场", from: 0 }];
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "第二句" },
    { from: 30, to: 60, content: "第三句" }
  ];
  state.reader.readingViewOpen = true;
  shell.renderReadingView();
  shell.bindReadingViewVideo(video);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

interface CurrentTimeLogEntry {
  pausedAtAssign: boolean;
  next: number;
}

function recordCurrentTimeAssignments(targetVideo: HTMLVideoElement) {
  const log: CurrentTimeLogEntry[] = [];
  let value = targetVideo.currentTime;
  Object.defineProperty(targetVideo, "currentTime", {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      log.push({ pausedAtAssign: scrollState.isManualScrollPaused(), next });
      value = next;
      targetVideo.dispatchEvent(new Event("timeupdate"));
    }
  });
  return log;
}

describe("seekReadingTarget 规范序", () => {
  it("清手动滚动暂停先于 currentTime 赋值（timeupdate 落在干净状态上）", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    shell.noteManualReaderInteraction(5000);
    expect(scrollState.isManualScrollPaused()).toBe(true);

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    Object.defineProperty(subtitleList, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(subtitleList, "scrollHeight", { value: 1200, configurable: true });
    const listScrollToSpy = vi.fn();
    subtitleList.scrollTo = listScrollToSpy;
    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const log = recordCurrentTimeAssignments(video);
    shell.seekReadingTarget(12, { resumePlayback: false });

    expect(log).toEqual([{ pausedAtAssign: false, next: 12 }]);
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
    expect(listScrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });

  it("未清暂停时同型同步会吞掉跟随滚动（回归对照：bug 形态可观察）", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    shell.noteManualReaderInteraction(5000);
    expect(scrollState.isManualScrollPaused()).toBe(true);

    video.currentTime = 12;
    video.dispatchEvent(new Event("seeked"));

    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
    expect(state.reader.readingActiveSubtitleIndex).toBe(1);
  });
});

describe("seekReadingTarget 播放策略（resumePlayback 参数化）", () => {
  it("resumePlayback:true：暂停中自动播放（阅读视图点击语义）", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    expect(video.paused).toBe(true);

    const seekedTo = shell.seekReadingTarget(30, { resumePlayback: true });

    expect(seekedTo).toBe(30);
    expect(video.currentTime).toBe(30);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("resumePlayback:false：暂停中不自动播放（侧栏 seek 语义）", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    shell.seekReadingTarget(30, { resumePlayback: false });

    expect(video.currentTime).toBe(30);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("resumePlayback:true：正在播放时不重复 play", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    Object.defineProperty(video, "paused", { configurable: true, value: false });

    shell.seekReadingTarget(30, { resumePlayback: true });

    expect(video.play).not.toHaveBeenCalled();
  });

  it("jumpReadingTarget 委托深入口：等价 resumePlayback:true", () => {
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    shell.jumpReadingTarget(45);

    expect(video.currentTime).toBe(45);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
  });

  it("负数与非有限时间截断为 0，返回截断值", () => {
    expect(shell.seekReadingTarget(-5, { resumePlayback: false })).toBe(0);
    expect(video.currentTime).toBe(0);
    expect(shell.seekReadingTarget(Number.NaN, { resumePlayback: false })).toBe(0);
  });

  it("无可用视频：返回 null 并写字幕提示节点，不抛错", () => {
    document.getElementById("playerWrap")?.remove();

    const seekedTo = shell.seekReadingTarget(12, { resumePlayback: false });

    expect(seekedTo).toBeNull();
    const notice = document.getElementById(ids.readingSubtitleNotice) as HTMLElement;
    expect(notice.textContent).toBe("当前页面没有找到可联动的视频播放器。");
  });
});
