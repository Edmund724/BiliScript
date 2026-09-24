// reader 生命周期测试：进入/退出阅读模式。
// 通过 stub DOM（biliscript 阅读视图骨架）与 stub 视频元素驱动
// shell.js 的 enterReaderMode / closeReadingView / hydrate / apply 等真实路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let impl: typeof shell;
let scriptHost: typeof import("../../extension/reader/script-host.js");

// B 形态（阶段 2）：script-host 以 spy 包装（实现保留），验证进入即开始贴右栏
// 定位、关闭即拆除。vi.mock 会被提升到模块求值前，须放在顶层。
vi.mock("../../extension/reader/script-host.js", async (importActual) => {
  const actual = await importActual() as typeof import("../../extension/reader/script-host.js");
  return {
    openScriptHost: vi.fn(actual.openScriptHost),
    closeScriptHost: vi.fn(actual.closeScriptHost)
  };
});

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  scriptHost = await import("../../extension/reader/script-host.js");
  impl = shell;
  return { state, shell, ids };
}

// 通过视频元素上挂载的同步 AbortController 判断播放同步是否在运行
// （内部同步定时器/绑定标志已收成 reader-impl 模块级闭包，不再暴露在 state.reader）
function syncRunning() {
  const video = document.querySelector("video");
  return Boolean((video as HTMLVideoElement | null)?.__biliscriptReadingSyncController);
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  mockPlayerRects();
});

afterEach(() => {
  // 清理 enterReaderMode 启动的同步定时器，避免 jsdom 定时器在清理后回调
  try {
    impl.stopReadingViewSync();
  } catch {
    // ignore
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reader 生命周期", () => {
  it("进入阅读模式：打开视图、写 data 属性、渲染字幕列表并打开 script-host", async () => {
    // B 形态：播放器挂载/整页接管链退役，进入不再绑定视频同步——
    // 绑定由 sync tick 的 bindReadingViewVideo 兜底。script-host 以 spy 验证
    // 进入即开始贴右栏定位、关闭即拆除。
    state.clip.title = "测试视频";
    state.clip.author = "up主";
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];
    // bvid 未设置（≠ 当前地址）→ 进入会触发后台重抓链；给 stub 视频一个有效
    // duration 让 waitForVideoMetadata 当拍就绪，抓取链在本用例窗口内落定，
    // 不拖到后续用例 teardown 后对账重渲（视图开着但骨架已拆，byId 抛错）。
    const enteredVideo = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(enteredVideo, "duration", { value: 120, configurable: true });

    await shell.enterReaderMode();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingViewOpen).toBe(true);
    expect(readingView.classList.contains("open")).toBe(true);
    expect(readingView.classList.contains("reader-page")).toBe(true);
    expect(readingView.getAttribute("aria-hidden")).toBe("false");
    expect(document.body.getAttribute("data-biliscript-reading-active")).toBe("1");

    // data-biliscript-reader-mode 由 content.js 的 init 在进入前设置，enterReaderMode 不负责
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");

    // B 形态不再渲染 rail 章节列表（章节由概览 tab 提供）；字幕列表照常渲染
    const chapterButtons = readingView.querySelectorAll(".biliscript-reading-chapter") as NodeListOf<HTMLElement>;
    expect(chapterButtons.length).toBe(0);

    const subtitleItems = readingView.querySelectorAll(".biliscript-reading-item") as NodeListOf<HTMLElement>;
    expect(subtitleItems.length).toBe(2);
    expect(subtitleItems[1].dataset.seconds).toBe("10");
    expect(subtitleItems[1].textContent).toContain("今天讲测试");

    // B 形态不驱动播放器挂载：视图打开即 ready，无挂载等待文案
    expect(state.reader.readingViewReady).toBe(true);
    expect(readingView.getAttribute("data-biliscript-reader-ready")).toBe("1");
    expect(readingView.getAttribute("aria-busy")).toBe("false");

    // 进入即开始右栏定位（script-host open），且不等播放器
    expect(scriptHost.openScriptHost).toHaveBeenCalledTimes(1);

    // 关闭视图以清掉同步定时器等，避免污染后续测试
    shell.closeReadingView();
    expect(scriptHost.closeScriptHost).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("关闭后移动进度再重开（字幕已缓存）：进入即定位到新进度并启动同步", async () => {
    // 用户报障形态：关闭 script → 拖动进度 → 重开 script。重开时字幕命中缓存、
    // 不再触发 subtitle-ready，进入路径必须自己启动同步并把滚动定位到当前进度。
    state.clip.bvid = "BV1test000000"; // 与 READER_MODE_URL 同 bvid，不触发后台重抓
    const body = [];
    for (let i = 0; i < 400; i += 1) {
      body.push({ from: i * 2, to: i * 2 + 1.9, content: `字幕第${i}条` });
    }
    state.clip.subtitleBody = body;

    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 0;
    await shell.enterReaderMode();
    shell.closeReadingView();

    // 关闭期间用户拖动了进度：第 300 条
    video.currentTime = 600;

    const elementScrollSpy = vi.fn();
    Element.prototype.scrollIntoView = elementScrollSpy;
    // jsdom 无布局：scrollHeight/clientHeight 恒 0，滚动走 window.scrollTo 分支
    const windowScrollSpy = vi.fn();
    window.scrollTo = windowScrollSpy;

    await shell.enterReaderMode();

    // 进入当拍即定位：高亮 + 滚动落位，不等任何后续播放事件
    const active = document.querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(active?.dataset.index).toBe("300");
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
    expect(elementScrollSpy.mock.calls.length + windowScrollSpy.mock.calls.length).toBeGreaterThan(0);
    // 同步 tick 已启动（视频事件绑定由 tick 兜底建立）
    expect(syncRunning()).toBe(true);

    shell.closeReadingView();
  });

  it("退出阅读模式：清空 data 属性、关闭视图、停止同步", async () => {
    state.clip.chapters = [
      { title: "开场", from: 0 },
      { title: "正片", from: 30 }
    ];
    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "大家好" },
      { from: 10, to: 30, content: "今天讲测试" }
    ];

    await shell.enterReaderMode();

    // 进入即启动同步 tick 并立即定位（重开路径不再有 subtitle-ready 通知，
    // 见「关闭后移动进度再重开」用例）：视频事件绑定随进入建立。
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(syncRunning()).toBe(true);

    shell.closeReadingView();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(state.reader.readingViewOpen).toBe(false);
    expect(readingView.classList.contains("open")).toBe(false);
    expect(readingView.getAttribute("aria-hidden")).toBe("true");
    expect(readingView.getAttribute("data-biliscript-reader-ready")).toBe("0");
    expect(document.body.getAttribute("data-biliscript-reading-active")).toBe(null);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe(null);
    expect(document.documentElement.getAttribute("data-biliscript-reader-theme")).toBe(null);
    expect(document.body.getAttribute("data-biliscript-reader-theme")).toBe(null);

    // 同步保持未运行、视频事件监听不存在
    expect(syncRunning()).toBe(false);
    expect(video.__biliscriptReadingSyncController).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("字幕缓存属上一个视频（bvid 与当前地址不符）：进入阅读模式触发后台重抓", async () => {
    // 稍后再看列表内 SPA 换片逃逸 URL 监听时 state.clip 残留旧视频数据；
    // 缓存命中判定带 bvid 校验，明确不符则按未抓取处理、走后台 refreshClip。
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);
    // waitForVideoMetadata 不等满超时：给 stub 视频一个有效 duration。
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: 120, configurable: true });

    state.clip.bvid = "BV1oldVideoA";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "旧视频字幕" }];

    await shell.enterReaderMode();

    await vi.waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    shell.closeReadingView();
  });

  it("字幕缓存与当前地址同 bvid：进入阅读模式不触发后台重抓", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    state.clip.bvid = "BV1test000000";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "当前视频字幕" }];

    await shell.enterReaderMode();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(refreshSpy).not.toHaveBeenCalled();
    shell.closeReadingView();
  });
});
