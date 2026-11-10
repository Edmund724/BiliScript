import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeVideoElement } from "../../extension/bilibili/video-probe.js";
import { state } from "../../extension/core/state.js";

function appendVideo(rect: { width: number; height: number }) {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    currentSrc: { value: "https://upos.example.com/video.mp4" },
    readyState: { value: 4 }
  });
  video.getBoundingClientRect = () => ({
    ...rect,
    x: 0,
    y: 0,
    top: 0,
    right: rect.width,
    bottom: rect.height,
    left: 0,
    toJSON: () => ({})
  });
  document.body.appendChild(video);
  return video;
}

afterEach(() => {
  document.body.replaceChildren();
  state.reader.readingVideoEl = null;
});

describe("运行时视频探针", () => {
  it("历史帧隐藏视频不参与用户播放器候选", () => {
    const player = appendVideo({ width: 320, height: 180 });
    const hidden = appendVideo({ width: 640, height: 360 });
    hidden.dataset.biliscriptHistoricalFrame = "";

    expect(getRuntimeVideoElement()).toBe(player);
  });
});
