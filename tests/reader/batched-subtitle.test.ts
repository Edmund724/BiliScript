import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let shell: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let video: HTMLVideoElement;

let rafPending: Map<number, (time: number) => void>;
let rafCancelled: number[];
let rafNextId: number;
let originalRaf: typeof window.requestAnimationFrame;
let originalCancelRaf: typeof window.cancelAnimationFrame;

function installFakeRaf() {
  rafPending = new Map();
  rafCancelled = [];
  rafNextId = 0;
  originalRaf = window.requestAnimationFrame;
  originalCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: (time: number) => void) => {
    rafNextId += 1;
    rafPending.set(rafNextId, cb);
    return rafNextId;
  };
  window.cancelAnimationFrame = (id: number) => {
    rafCancelled.push(id);
    rafPending.delete(id);
  };
}

function flushAnimationFrames(maxRounds = 30) {
  let rounds = 0;
  while (rafPending.size > 0 && rounds < maxRounds) {
    const entries = [...rafPending.entries()];
    entries.forEach(([id, cb]) => {
      rafPending.delete(id);
      cb(0);
    });
    rounds += 1;
  }
  if (rafPending.size > 0) {
    throw new Error(`rAF queue did not drain after ${maxRounds} rounds`);
  }
}

function makeBody(count: number) {
  const body = [];
  for (let i = 0; i < count; i += 1) {
    body.push({ from: i * 2, to: i * 2 + 1.9, content: `字幕第${i}条` });
  }
  return body;
}

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  shell = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
}

function mountSkeleton() {
  mountReaderSkeleton(ids);
  video = mountPlayerChain();
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountSkeleton();
  installFakeRaf();
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCancelRaf;
  document.body.innerHTML = "";
});

function subtitleList() {
  return document.getElementById(ids.readingSubtitleList) as HTMLElement;
}

function renderedItemCount() {
  return subtitleList().querySelectorAll(".biliscript-reading-item").length;
}

describe("字幕列表分批渲染", () => {
  it("首屏只渲染前 120 条，按序收尾，追加任务挂起", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120);
    expect(subtitleList().lastElementChild?.getAttribute("data-index")).toBe("119");
    expect(rafPending.size).toBe(2);
  });

  it("rAF 每帧追加直至完成：800 条不重不漏，按序收尾", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    flushAnimationFrames();
    expect(renderedItemCount()).toBe(800);
    const list = subtitleList();
    expect(list.lastElementChild?.getAttribute("data-index")).toBe("799");
    for (let i = 0; i < 800; i += 50) {
      expect(list.querySelectorAll(`[data-index="${i}"]`).length).toBe(1);
    }
  });

  it("分批追加后的条目可点击跳转（容器层事件委托）", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    video.play = () => Promise.resolve();
    shell.renderReadingView();
    flushAnimationFrames();
    const target = subtitleList().querySelector('[data-index="300"]') as HTMLElement;
    expect(target).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    shell.onReadingSubtitleClick(event);
    expect(video.currentTime).toBe(600);
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
  });

  it("follow 跳转到未渲染区：同步补渲染到目标 index 再滚动，不依赖后续帧", () => {
    state.clip.subtitleBody = makeBody(600);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120);

    const bound = shell.bindReadingViewVideo(video);
    expect(bound).toBe(video);
    video.play = () => Promise.resolve();
    video.currentTime = 600;

    shell.syncReadingViewPlayback(true);

    expect(renderedItemCount()).toBe(301);
    const active = subtitleList().querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(active.dataset.index).toBe("300");
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
    flushAnimationFrames();
    expect(renderedItemCount()).toBe(600);
  });

  it("同步补渲染超限：只同步上屏上限条，落点区间由后续帧补齐后自愈落位", () => {
    state.clip.subtitleBody = makeBody(1500);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(renderedItemCount()).toBe(120);

    const bound = shell.bindReadingViewVideo(video);
    expect(bound).toBe(video);
    video.play = () => Promise.resolve();
    video.currentTime = 2800;

    shell.syncReadingViewPlayback(true);
    expect(renderedItemCount()).toBe(320);
    expect(subtitleList().querySelector(".biliscript-reading-item.is-active")).toBeNull();

    flushAnimationFrames();
    expect(renderedItemCount()).toBe(1500);
    shell.syncReadingViewPlayback(true);
    const active = subtitleList().querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(active.dataset.index).toBe("1400");
    expect(state.reader.readingActiveSubtitleIndex).toBe(1400);
  });

  it("force 拍落点超出同步 flush 上限：rAF 补齐后，后续非 force tick 必须补滚动", () => {
    state.clip.subtitleBody = makeBody(1500);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    video.currentTime = 2800;

    const list = subtitleList();
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 4000, configurable: true });
    const listScrollSpy = vi.fn();
    list.scrollTo = listScrollSpy;
    const elementScrollSpy = vi.fn();
    Element.prototype.scrollIntoView = elementScrollSpy;
    const windowScrollSpy = vi.fn();
    window.scrollTo = windowScrollSpy;

    shell.syncReadingViewPlayback(true);
    expect(subtitleList().querySelector('[data-index="1400"]')).toBeNull();

    flushAnimationFrames();
    expect(renderedItemCount()).toBe(1500);
    elementScrollSpy.mockClear();
    listScrollSpy.mockClear();
    windowScrollSpy.mockClear();

    shell.syncReadingViewPlayback();
    shell.syncReadingViewPlayback();
    const active = subtitleList().querySelector(".biliscript-reading-item.is-active") as HTMLElement;
    expect(active.dataset.index).toBe("1400");
    expect(elementScrollSpy.mock.calls.length + listScrollSpy.mock.calls.length).toBeGreaterThan(0);
    expect(windowScrollSpy).not.toHaveBeenCalled();
  });

  it("手动暂停中的激活计算照旧：不补渲染/滚动，恢复后下一拍补高亮", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    shell.bindReadingViewVideo(video);
    shell.noteManualReaderInteraction(60_000);
    video.currentTime = 600;
    shell.syncReadingViewPlayback();
    expect(state.reader.readingActiveSubtitleIndex).toBe(300);
    expect(subtitleList().querySelector(".biliscript-reading-item.is-active")).toBeNull();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    shell.syncReadingViewPlayback(true);
    expect(renderedItemCount()).toBeGreaterThanOrEqual(301);
    expect((subtitleList().querySelector(".biliscript-reading-item.is-active") as HTMLElement).dataset.index).toBe("300");
  });

  it("渲染期间再次 renderReadingView（切轨）：取消上一轮任务，新数据不重不漏", () => {
    state.clip.subtitleBody = makeBody(800);
    shell.renderReadingView();
    const snapshot = [...rafPending.values()];
    snapshot.forEach((cb) => cb(0));
    expect(renderedItemCount()).toBe(320);

    state.clip.subtitleBody = makeBody(400);
    shell.renderReadingView();
    expect(rafCancelled.length).toBeGreaterThanOrEqual(1);
    expect(renderedItemCount()).toBe(120);

    flushAnimationFrames();
    const list = subtitleList();
    expect(renderedItemCount()).toBe(400);
    expect(list.querySelectorAll('[data-index="0"]').length).toBe(1);
    expect(list.querySelectorAll('[data-index="399"]').length).toBe(1);
    expect(list.querySelector('[data-index="400"]')).toBeNull();
    expect(list.lastElementChild?.getAttribute("data-index")).toBe("399");
  });

  it("closeReadingView 取消挂起的追加任务，关闭后不再追加", () => {
    state.clip.subtitleBody = makeBody(800);
    state.reader.readingViewOpen = true;
    shell.renderReadingView();
    expect(rafPending.size).toBe(2);
    shell.closeReadingView();
    expect(rafPending.size).toBe(0);
    expect(rafCancelled.length).toBeGreaterThanOrEqual(1);
    flushAnimationFrames();
    expect(renderedItemCount()).toBe(120);
  });
});
