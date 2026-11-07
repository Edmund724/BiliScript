import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startPlaybackRateButtons,
  stopPlaybackRateButtons
} from "../../extension/bilibili/playback-rate.js";

describe("bilibili/playback-rate 播放器 3x/4x 倍速按钮模块", () => {
  let container: HTMLElement;
  let nativeRateBtn: HTMLElement;
  let video: HTMLVideoElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";

    container = document.createElement("div");
    container.className = "bpx-player-control-bottom-right";

    nativeRateBtn = document.createElement("div");
    nativeRateBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-playbackrate";

    const nativeResult = document.createElement("div");
    nativeResult.className = "bpx-player-ctrl-playbackrate-result";
    nativeResult.textContent = "倍速";
    nativeRateBtn.appendChild(nativeResult);

    container.appendChild(nativeRateBtn);
    document.body.appendChild(container);

    video = document.createElement("video");
    video.src = "https://example.com/video1.mp4";
    document.body.appendChild(video);
  });

  afterEach(() => {
    stopPlaybackRateButtons();
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("启动时在原生按钮左侧插入 4x 和 3x 按钮，顺序为 [4x] [3x] [原生]", () => {
    startPlaybackRateButtons();

    const children = Array.from(container.children);
    expect(children.length).toBe(3);

    const btn4 = children[0] as HTMLElement;
    const btn3 = children[1] as HTMLElement;
    const btnNative = children[2] as HTMLElement;

    expect(btn4.getAttribute("data-bilibili-3x")).toBe("4");
    expect(btn4.querySelector(".bpx-player-ctrl-playbackrate-result")?.textContent).toBe("4x");

    expect(btn3.getAttribute("data-bilibili-3x")).toBe("3");
    expect(btn3.querySelector(".bpx-player-ctrl-playbackrate-result")?.textContent).toBe("3x");

    expect(btnNative).toBe(nativeRateBtn);
  });

  it("点击按钮可切换倍速：1x -> 3x -> 1x，1x -> 4x -> 1x", () => {
    startPlaybackRateButtons();

    const btn3 = container.querySelector('[data-bilibili-3x="3"]') as HTMLElement;
    const btn4 = container.querySelector('[data-bilibili-3x="4"]') as HTMLElement;

    expect(video.playbackRate).toBe(1);

    // 点击 3x
    btn3.click();
    expect(video.playbackRate).toBe(3);

    // 再次点击 3x 回到 1x
    btn3.click();
    expect(video.playbackRate).toBe(1);

    // 点击 4x
    btn4.click();
    expect(video.playbackRate).toBe(4);

    // 再次点击 4x 回到 1x
    btn4.click();
    expect(video.playbackRate).toBe(1);
  });

  it("视频源发生变化时自动恢复 1x 倍速", () => {
    startPlaybackRateButtons();

    const btn4 = container.querySelector('[data-bilibili-3x="4"]') as HTMLElement;
    btn4.click();
    expect(video.playbackRate).toBe(4);

    // 模拟换视频
    video.src = "https://example.com/video2.mp4";
    video.dispatchEvent(new Event("loadedmetadata"));

    expect(video.playbackRate).toBe(1);
  });

  it("调用 stopPlaybackRateButtons 时干净卸载所有创建的按钮", () => {
    startPlaybackRateButtons();
    expect(container.querySelectorAll("[data-bilibili-3x]").length).toBe(2);

    stopPlaybackRateButtons();
    expect(container.querySelectorAll("[data-bilibili-3x]").length).toBe(0);
    expect(container.contains(nativeRateBtn)).toBe(true);
  });
});
