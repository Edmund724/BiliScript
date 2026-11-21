import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubtitleScrollFollowMachine,
  formatFollowButtonClock
} from "../../extension/reader/subtitle-scroll-follow.js";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

describe("字幕跟随状态机（纯状态机单测）", () => {
  function createFakeClockMachine() {
    let nowMs = 10_000;
    let nextTimerId = 1;
    const timers = new Map<number, { runAt: number; cb: () => void }>();

    const machine = createSubtitleScrollFollowMachine({
      now: () => nowMs,
      setTimeout: (cb, ms) => {
        const id = nextTimerId++;
        timers.set(id, { runAt: nowMs + ms, cb });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as unknown as number);
      }
    });

    function advance(ms: number) {
      const target = nowMs + ms;
      while (true) {
        let earliestId: number | null = null;
        let earliestAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of timers.entries()) {
          if (entry.runAt <= target && entry.runAt < earliestAt) {
            earliestAt = entry.runAt;
            earliestId = id;
          }
        }
        if (earliestId === null) {
          break;
        }
        const entry = timers.get(earliestId)!;
        timers.delete(earliestId);
        nowMs = entry.runAt;
        entry.cb();
      }
      nowMs = target;
    }

    return { machine, advance, getNow: () => nowMs };
  }

  it("手动滚轮 / 触控板 / 触摸 / 滚动按键：即使处于程序化平滑滚动途中也立即暂停跟随", () => {
    const { machine } = createFakeClockMachine();
    expect(machine.getMode()).toBe("auto");

    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 600 });
    expect(machine.isProgrammaticScrolling()).toBe(true);

    expect(machine.handleWheel({ deltaY: -40, canScroll: true })).toBe(true);
    expect(machine.getMode()).toBe("manual");
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.resumeAuto();
    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 600, targetTop: 100 });
    expect(machine.handleTouchMove({ canScroll: true })).toBe(true);
    expect(machine.getMode()).toBe("manual");
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.resumeAuto();
    expect(machine.handleKeyDown({ key: "PageDown", canScroll: true, editable: true })).toBe(false);
    expect(machine.getMode()).toBe("auto");
    expect(machine.handleKeyDown({ key: "PageDown", canScroll: true, editable: false })).toBe(true);
    expect(machine.getMode()).toBe("manual");
  });

  it("容器不可滚动或零位移滚轮：不误触发手动暂停", () => {
    const { machine } = createFakeClockMachine();

    expect(machine.handleWheel({ deltaY: 120, canScroll: false })).toBe(false);
    expect(machine.handleWheel({ deltaY: 0, deltaX: 0, canScroll: true })).toBe(false);
    expect(machine.handleTouchMove({ canScroll: false })).toBe(false);
    expect(machine.handleKeyDown({ key: "ArrowDown", canScroll: false })).toBe(false);
    expect(machine.getMode()).toBe("auto");
  });

  it("滚动条拖拽 vs 点击字幕条目：经典滚动条按下即停、悬浮滚动条拖动即停、点击条目不闪停", () => {
    const { machine } = createFakeClockMachine();

    expect(
      machine.handlePointerDown({ isDirectContainer: false, isScrollbar: false, canScroll: true })
    ).toBe(false);
    expect(machine.getMode()).toBe("auto");
    machine.handlePointerUp();

    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 500 });
    expect(
      machine.handlePointerDown({ isDirectContainer: true, isScrollbar: true, canScroll: true })
    ).toBe(true);
    expect(machine.getMode()).toBe("manual");
    expect(machine.isProgrammaticScrolling()).toBe(false);
    machine.handlePointerUp();

    machine.resumeAuto();
    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 500 });
    expect(
      machine.handlePointerDown({ isDirectContainer: true, isScrollbar: false, canScroll: true })
    ).toBe(false);
    expect(machine.getMode()).toBe("auto");
    expect(machine.handleScroll({ scrollTop: 120 })).toBe(true);
    expect(machine.getMode()).toBe("manual");
    expect(machine.isProgrammaticScrolling()).toBe(false);
    machine.handlePointerUp();
  });

  it("长距离程序化 smooth scrollTo（超过 800ms）：滚动帧持续刷新空闲窗口，不误判为手动滚动；scrollend 后立即放锁", () => {
    const { machine, advance } = createFakeClockMachine();

    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 1200 });

    for (let step = 1; step <= 12; step += 1) {
      advance(100);
      expect(machine.handleScroll({ scrollTop: step * 100 })).toBe(false);
      expect(machine.getMode()).toBe("auto");
      expect(machine.isProgrammaticScrolling()).toBe(true);
    }

    machine.handleScrollEnd();
    expect(machine.isProgrammaticScrolling()).toBe(false);

    expect(machine.handleScroll({ scrollTop: 1050 })).toBe(true);
    expect(machine.getMode()).toBe("manual");
  });

  it("程序化 scrollTo 返回 Promise：正常完成立即放锁，被新滚动取代的旧 Promise 决议不提前解除新锁", async () => {
    const { machine } = createFakeClockMachine();

    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    const token1 = machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 400 });
    machine.attachProgrammaticScrollPromise(token1, firstPromise);

    const token2 = machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 150, targetTop: 900 });
    machine.attachProgrammaticScrollPromise(token2, secondPromise);

    resolveFirst();
    await Promise.resolve();
    expect(machine.isProgrammaticScrolling()).toBe(true);
    expect(machine.handleScroll({ scrollTop: 300 })).toBe(false);
    expect(machine.getMode()).toBe("auto");

    resolveSecond();
    await Promise.resolve();
    expect(machine.isProgrammaticScrolling()).toBe(false);
  });

  it("程序化滚动途中若 scrollTop 反向回拉或越过目标：立即识别为用户抢控并暂停跟随", () => {
    const { machine } = createFakeClockMachine();

    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 100, targetTop: 500 });
    expect(machine.handleScroll({ scrollTop: 220 })).toBe(false);
    expect(machine.getMode()).toBe("auto");

    expect(machine.handleScroll({ scrollTop: 180 })).toBe(true);
    expect(machine.getMode()).toBe("manual");
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.resumeAuto();
    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 100, targetTop: 500 });
    expect(machine.handleScroll({ scrollTop: 650 })).toBe(true);
    expect(machine.getMode()).toBe("manual");
  });

  it("无 scrollend / Promise 兜底：空闲超时与硬上限都会自动释放程序化锁", () => {
    const { machine, advance } = createFakeClockMachine();

    machine.beginProgrammaticScroll({ behavior: "auto", startTop: 0, targetTop: 300 });
    advance(120);
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.beginProgrammaticScroll({ behavior: "smooth", startTop: 0, targetTop: 1000, idleMs: 180, maxMs: 600 });
    for (let i = 1; i <= 5; i += 1) {
      advance(100);
      machine.handleScroll({ scrollTop: i * 100 });
    }
    advance(120);
    expect(machine.isProgrammaticScrolling()).toBe(false);
  });

  it("切集复位（resetForVideoSwitch）与列表重建守卫（guardLayoutReset）边界不误判", async () => {
    const { machine, advance } = createFakeClockMachine();

    machine.handlePointerDown({ isDirectContainer: true, isScrollbar: true, canScroll: true });
    expect(machine.getMode()).toBe("manual");

    machine.resetForVideoSwitch();
    expect(machine.getMode()).toBe("auto");
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.guardLayoutReset();
    expect(machine.handleScroll({ scrollTop: 0 })).toBe(false);
    expect(machine.getMode()).toBe("auto");
    advance(130);
    expect(machine.isProgrammaticScrolling()).toBe(false);

    machine.pauseManual();
    machine.guardLayoutReset();
    expect(machine.getMode()).toBe("manual");
  });

  it("formatFollowButtonClock：规范格式化秒数并过滤非法值", () => {
    expect(formatFollowButtonClock(0)).toBe("0:00");
    expect(formatFollowButtonClock(512)).toBe("8:32");
    expect(formatFollowButtonClock(3605)).toBe("1:00:05");
    expect(formatFollowButtonClock(undefined)).toBeNull();
    expect(formatFollowButtonClock(Number.NaN)).toBeNull();
    expect(formatFollowButtonClock(-5)).toBeNull();
  });
});

describe("字幕精读列表跟随滚动集成（DOM + sync + subtitle-tab-ui + lifecycle）", () => {
  let state: TestState;
  let shell: typeof import("../../extension/reader/index.js");
  let readerBus: typeof import("../../extension/reader/reader-bus.js");
  let ids: typeof import("../../extension/reader/state.js").ids;
  let tabUi: typeof import("../../extension/reader/subtitle-tab-ui.js");
  let video: HTMLVideoElement;

  async function setupEnvironment() {
    resetModuleState();
    document.body.innerHTML = "";
    setLocationUrl(READER_MODE_URL);
    state = (await import("../../extension/core/state.js")).state as TestState;
    shell = await import("../../extension/reader/index.js");
    readerBus = await import("../../extension/reader/reader-bus.js");
    ids = (await import("../../extension/reader/state.js")).ids;
    tabUi = await import("../../extension/reader/subtitle-tab-ui.js");

    mountReaderSkeleton(ids);
    video = mountPlayerChain();
    mockPlayerRects();
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    state.clip.subtitleBody = [
      { from: 0, to: 10, content: "第一句开场" },
      { from: 500, to: 520, content: "中段核心内容" },
      { from: 3600, to: 3620, content: "一小时后的尾声" }
    ];
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    tabUi.bindSubtitleTabEvents();
    shell.bindReadingViewVideo(video);
  }

  function setupScrollableListGeometry(options: {
    listHeight?: number;
    scrollHeight?: number;
    initialScrollTop?: number;
    itemTops?: number[];
    itemHeight?: number;
  } = {}) {
    const listHeight = options.listHeight ?? 400;
    const scrollHeight = options.scrollHeight ?? 1600;
    const itemHeight = options.itemHeight ?? 40;
    const itemTops = options.itemTops ?? [20, 620, 1220];
    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;

    let currentScrollTop = options.initialScrollTop ?? 0;
    Object.defineProperty(subtitleList, "clientHeight", { value: listHeight, configurable: true });
    Object.defineProperty(subtitleList, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(subtitleList, "offsetWidth", { value: 360, configurable: true });
    Object.defineProperty(subtitleList, "clientWidth", { value: 348, configurable: true });
    Object.defineProperty(subtitleList, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      }
    });
    subtitleList.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 100 + listHeight,
        left: 0,
        right: 360,
        width: 360,
        height: listHeight,
        x: 0,
        y: 100,
        toJSON() {
          return this;
        }
      }) as DOMRect;

    const items = subtitleList.querySelectorAll<HTMLElement>(".biliscript-reading-item");
    items.forEach((item, index) => {
      const contentTop = itemTops[index] ?? index * 60;
      item.getBoundingClientRect = () =>
        ({
          top: 100 + contentTop - currentScrollTop,
          bottom: 100 + contentTop - currentScrollTop + itemHeight,
          left: 0,
          right: 340,
          width: 340,
          height: itemHeight,
          x: 0,
          y: 100 + contentTop - currentScrollTop,
          toJSON() {
            return this;
          }
        }) as DOMRect;
    });

    const scrollToSpy = vi.fn((arg?: ScrollToOptions | number) => {
      if (typeof arg === "object" && arg && typeof arg.top === "number") {
        currentScrollTop = arg.top;
      } else if (typeof arg === "number") {
        currentScrollTop = arg;
      }
      subtitleList.dispatchEvent(new Event("scroll"));
    });
    subtitleList.scrollTo = scrollToSpy as unknown as HTMLElement["scrollTo"];

    return { subtitleList, scrollToSpy };
  }

  beforeEach(async () => {
    await setupEnvironment();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("滚轮手动浏览立即暂停自动居中跟随，并在底部胶囊实时展示当前播放进度", () => {
    const { subtitleList, scrollToSpy } = setupScrollableListGeometry();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const followBtn = document.getElementById(ids.readingFollowBtn) as HTMLButtonElement;

    video.currentTime = 512;
    shell.syncReadingViewPlayback(true);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 440, behavior: "smooth" });
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    subtitleList.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
    expect(followBtn.textContent).toBe("回到当前播放 · 8:32");

    scrollToSpy.mockClear();
    video.currentTime = 3605;
    shell.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(2);
    expect(followBtn.textContent).toBe("回到当前播放 · 1:00:05");
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("点击回位胶囊平滑居中滚回当前高亮字幕并恢复自动跟随（即使暂停期间触发过 seeked）", async () => {
    const { subtitleList, scrollToSpy } = setupScrollableListGeometry();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const followBtn = document.getElementById(ids.readingFollowBtn) as HTMLButtonElement;

    video.currentTime = 512;
    shell.syncReadingViewPlayback(true);
    subtitleList.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    video.currentTime = 3605;
    video.dispatchEvent(new Event("seeked"));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
    expect(followBtn.textContent).toBe("回到当前播放 · 1:00:05");

    scrollToSpy.mockClear();
    followBtn.click();
    await vi.waitFor(() => {
      expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
    });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1040, behavior: "smooth" });
    expect(video.currentTime).toBe(3605);
  });

  it("点击某条字幕跳播：pointerdown 不闪弹胶囊，click 同步恢复自动跟随并隐藏回位胶囊", async () => {
    const { subtitleList, scrollToSpy } = setupScrollableListGeometry();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;

    video.currentTime = 5;
    shell.syncReadingViewPlayback(true);
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    const secondItem = subtitleList.querySelectorAll<HTMLElement>(".biliscript-reading-item")[1];
    secondItem.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    subtitleList.dispatchEvent(new WheelEvent("wheel", { deltaY: 160 }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    scrollToSpy.mockClear();
    secondItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(video.currentTime).toBe(500);
    });
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 440, behavior: "smooth" });
  });

  it("拖动经典滚动条轨道：pointerdown 立即暂停跟随", () => {
    const { subtitleList } = setupScrollableListGeometry();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;

    video.currentTime = 512;
    shell.syncReadingViewPlayback(true);
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    subtitleList.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 354 }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");
  });

  it("切集（reset → rerender → subtitle-ready）：重置 manual 态、屏蔽重建 scroll 钳制、新集恢复自动跟随", () => {
    const { subtitleList } = setupScrollableListGeometry({ initialScrollTop: 500 });
    const readingView = document.getElementById(ids.readingView) as HTMLElement;

    video.currentTime = 512;
    shell.syncReadingViewPlayback(true);
    subtitleList.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("manual");

    readerBus.notifyReaderPresenter({ kind: "reset" });
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    state.clip.subtitleBody = [];
    readerBus.notifyReaderPresenter({ kind: "rerender" });
    subtitleList.scrollTop = 0;
    subtitleList.dispatchEvent(new Event("scroll"));
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");

    state.clip.subtitleBody = [
      { from: 0, to: 15, content: "第二集开场" },
      { from: 15, to: 40, content: "第二集正文" }
    ];
    video.currentTime = 20;
    readerBus.notifyReaderPresenter({ kind: "subtitle-ready" });
    const { scrollToSpy } = setupScrollableListGeometry({ itemTops: [20, 520] });
    shell.syncReadingViewPlayback(true);
    expect(readingView.getAttribute("data-biliscript-reader-follow")).toBe("auto");
    expect(scrollToSpy).toHaveBeenCalled();
  });
});
