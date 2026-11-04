import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOSS_VIDEO_FRAME_INTERVAL_MS,
  MOSS_VIDEO_FRAME_MAX_EDGE,
  createPageVideoFrameCapture,
  getVideoFrameSize
} from "../../extension/live/page-video-frame-capture.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("getVideoFrameSize", () => {
  it("scales landscape and portrait frames to the configured long edge", () => {
    expect(getVideoFrameSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(getVideoFrameSize(1080, 1920)).toEqual({ width: 540, height: 960 });
    expect(getVideoFrameSize(1920, 1080, 480)).toEqual({ width: 480, height: 270 });
  });

  it("does not upscale smaller frames and keeps at least one pixel per edge", () => {
    expect(getVideoFrameSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(getVideoFrameSize(1, 10000)).toEqual({ width: 1, height: MOSS_VIDEO_FRAME_MAX_EDGE });
  });
});

describe("createPageVideoFrameCapture", () => {
  it("keeps emitting the cached JPEG frame at 1fps while the video is paused without re-encoding", async () => {
    vi.useFakeTimers();

    const fakeVideo = {
      currentSrc: "blob:https://www.bilibili.com/video-1",
      src: "",
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 42.5
    } as unknown as HTMLVideoElement;

    const drawImage = vi.fn();
    let blobByte = 0x10;
    const toBlob = vi.fn((callback: BlobCallback) => {
      blobByte += 1;
      callback(new Blob([new Uint8Array([0xff, 0xd8, blobByte, 0xff, 0xd9])], { type: "image/jpeg" }));
    });
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob
    } as unknown as HTMLCanvasElement;

    const frames: Uint8Array[] = [];
    const session = createPageVideoFrameCapture({
      getVideo: () => fakeVideo,
      createCanvas: () => fakeCanvas,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([0xff, 0xd8, 0x11, 0xff, 0xd9]);

    // Video remains paused at 42.5s across multiple 1-second ticks:
    // cached frame must continue to be sent without re-running drawImage/toBlob.
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(3);
    expect(frames[1]).toBe(frames[0]);
    expect(frames[2]).toBe(frames[0]);

    // Video advances to a new timestamp -> re-encodes a new frame
    (fakeVideo as { currentTime: number }).currentTime = 43.5;
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(4);
    expect(Array.from(frames[3])).toEqual([0xff, 0xd8, 0x12, 0xff, 0xd9]);

    session.stop();
  });
});
