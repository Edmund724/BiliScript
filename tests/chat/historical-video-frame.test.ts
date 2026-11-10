import { describe, expect, it, vi } from "vitest";
import { captureHistoricalVideoFrame } from "../../extension/chat/historical-video-frame.js";

function makeVideo(duration = 120) {
  const video = document.createElement("video");
  let currentTime = 0;
  let readyState = 0;
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value - 0.05;
        queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
      }
    },
    readyState: { configurable: true, get: () => readyState },
    duration: { configurable: true, get: () => duration },
    videoWidth: { configurable: true, get: () => 640 },
    videoHeight: { configurable: true, get: () => 360 }
  });
  video.load = vi.fn();
  video.pause = vi.fn();
  return {
    video,
    metadataReady() {
      readyState = 1;
      video.dispatchEvent(new Event("loadedmetadata"));
    },
    canPlay() {
      readyState = 2;
      video.dispatchEvent(new Event("canplay"));
    }
  };
}

function makeCanvas() {
  const canvas = document.createElement("canvas");
  const context = { drawImage: vi.fn() };
  canvas.getContext = vi.fn(() => context) as unknown as typeof canvas.getContext;
  canvas.toBlob = vi.fn((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
  });
  return { canvas, context };
}

describe("隐藏视频历史帧截取", () => {
  it("加载当前视频的 durl，seek 到目标时间并导出实际帧后清理隐藏媒体", async () => {
    const media = makeVideo();
    const { canvas, context } = makeCanvas();
    const transport = vi.fn(async () => ({
      code: 0,
      data: { durl: [{ url: "https://upos.example.com/video.mp4" }] }
    }));

    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      { transport, createVideo: () => media.video, createCanvas: () => canvas }
    );
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
    expect(media.video.crossOrigin).toBe("anonymous");
    expect(media.video.dataset.biliscriptHistoricalFrame).toBe("");
    expect(media.video.muted).toBe(true);
    expect(media.video.src).toBe("https://upos.example.com/video.mp4");
    media.metadataReady();
    media.canPlay();

    const frame = await pending;
    expect(transport).toHaveBeenCalledWith(expect.stringContaining("bvid=BV1history&cid=101"));
    expect(frame.currentTime).toBe(89.95);
    expect(Array.from(frame.jpegBytes)).toEqual([1, 2, 3]);
    expect(context.drawImage).toHaveBeenCalledWith(media.video, 0, 0, 640, 360);
    expect(media.video.isConnected).toBe(false);
    expect(media.video.getAttribute("src")).toBeNull();
    expect(media.video.pause).toHaveBeenCalledTimes(1);
  });

  it("隐藏媒体失败时抛出真实错误并清理，不操作页面播放器", async () => {
    const player = document.createElement("video");
    player.pause = vi.fn();
    player.load = vi.fn();
    document.body.appendChild(player);
    const media = makeVideo();
    const { canvas, context } = makeCanvas();
    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas
      }
    );
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
    media.video.dispatchEvent(new Event("error"));

    await expect(pending).rejects.toThrow("隐藏视频 loadedmetadata 失败：未知媒体错误");
    expect(media.video.isConnected).toBe(false);
    expect(media.video.getAttribute("src")).toBeNull();
    expect(media.video.pause).toHaveBeenCalledTimes(1);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.load).not.toHaveBeenCalled();
    player.remove();
  });
});
