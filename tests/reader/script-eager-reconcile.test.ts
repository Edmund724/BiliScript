import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const { overviewTriggerSpy } = vi.hoisted(() => ({
  overviewTriggerSpy: vi.fn(() => Promise.resolve())
}));
vi.mock("../../extension/reader/overview-coordinator.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../extension/reader/overview-coordinator.js")
  >();
  return {
    ...actual,
    createOverviewCoordinator: ((deps: Parameters<typeof actual.createOverviewCoordinator>[0]) =>
      Object.assign(actual.createOverviewCoordinator(deps), {
        trigger: overviewTriggerSpy
      })) as typeof actual.createOverviewCoordinator
  };
});

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  mockPlayerRects();
  const video = document.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(video, "duration", { value: 120, configurable: true });
});

afterEach(() => {
  try {
    shell.stopReadingViewSync();
  } catch {
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("后台抓取落定后的对账收尾（通知丢失兜底）", () => {
  it("refresh 落定 → 字幕列表按落定数据渲染、概览生成再次触发", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [
        { from: 0, to: 10, content: "大家好" },
        { from: 10, to: 30, content: "开始今天的话题" }
      ];
      return Promise.resolve();
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    await shell.enterReaderMode();

    expect(overviewTriggerSpy).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".biliscript-reading-item").length).toBe(2);
    });
    expect(overviewTriggerSpy).toHaveBeenCalledTimes(2);

    shell.closeReadingView();
  });

  it("字幕在元数据等待期间落账（另一处先抓完）：不再起第二轮抓取，仍对账重渲", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { value: NaN, configurable: true });

    await shell.enterReaderMode();

    state.clip.bvid = "BV1test000000";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    Object.defineProperty(video, "duration", { value: 120, configurable: true });

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".biliscript-reading-item").length).toBe(1);
    });
    expect(refreshSpy).not.toHaveBeenCalled();

    shell.closeReadingView();
  });

  it("refresh 落定时视图已关：跳过对账（重开时 enterReaderMode 自会渲染+触发）", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => {
      state.clip.bvid = "BV1test000000";
      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
      return Promise.resolve();
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    await shell.enterReaderMode();
    shell.closeReadingView();
    await refreshSpy();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(overviewTriggerSpy).toHaveBeenCalledTimes(1);

    await shell.enterReaderMode();
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".biliscript-reading-item").length).toBe(1);
    });
    shell.closeReadingView();
  });
});
