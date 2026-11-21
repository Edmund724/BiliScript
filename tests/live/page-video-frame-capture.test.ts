import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VIDEO_SEEK_CAPTURE_DEBOUNCE_MS,
  MIN_LIVE_VIDEO_CAPTURE_INTERVAL_MS,
  MOSS_VIDEO_FRAME_MAX_EDGE,
  capturePageVideoFrame,
  createPageVideoFrameCapture,
  getVideoFrameSize
} from "../../extension/live/page-video-frame-capture.js";
import { MOSS_STANDARD_VIDEO_CONFIG } from "../../extension/live/moss-video-config.js";

function createFakeDomVideo(initial: {
  currentTime?: number;
  paused?: boolean;
  ended?: boolean;
  currentSrc?: string;
} = {}) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentSrc: initial.currentSrc ?? "blob:https://www.bilibili.com/video-live",
    src: "",
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: initial.currentTime ?? 10,
    paused: initial.paused ?? false,
    ended: initial.ended ?? false,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    }),
    dispatch(type: string) {
      listeners.get(type)?.forEach((fn) => fn());
    }
  };
}

function createFakeCanvasHarness() {
  const drawImage = vi.fn();
  let seq = 0x20;
  const toBlob = vi.fn((callback: BlobCallback, _mime?: string, _quality?: number) => {
    seq += 1;
    callback(new Blob([new Uint8Array([0xff, 0xd8, seq, 0xff, 0xd9])], { type: "image/jpeg" }));
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob
  } as unknown as HTMLCanvasElement;
  return { canvas, drawImage, toBlob };
}

describe("capturePageVideoFrame", () => {
  it("截取当前播放位置并返回 960px JPEG 字节与 currentTime", async () => {
    const video = {
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 151
    } as HTMLVideoElement;
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, mime?: string, quality?: number) => {
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: mime }));
      expect(quality).toBe(0.72);
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob
    } as unknown as HTMLCanvasElement;

    const result = await capturePageVideoFrame({ getVideo: () => video, createCanvas: () => canvas });

    expect(canvas.width).toBe(960);
    expect(canvas.height).toBe(540);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.72);
    expect(result.currentTime).toBe(151);
    expect(Array.from(result.jpegBytes)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("没有可用视频画面时 reject", async () => {
    await expect(capturePageVideoFrame({ getVideo: () => null })).rejects.toThrow("当前没有可截取的视频画面");
  });

  it("JPEG 编码返回 null 时 reject", async () => {
    const video = { readyState: 4, videoWidth: 1920, videoHeight: 1080, currentTime: 1 } as HTMLVideoElement;
    const canvas = {
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(null)
    } as unknown as HTMLCanvasElement;

    await expect(capturePageVideoFrame({ getVideo: () => video, createCanvas: () => canvas })).rejects.toThrow("视频画面编码失败");
  });
});

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

    await vi.advanceTimersByTimeAsync(MOSS_STANDARD_VIDEO_CONFIG.intervalMs);
    await vi.advanceTimersByTimeAsync(MOSS_STANDARD_VIDEO_CONFIG.intervalMs);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(3);
    expect(frames[1]).toBe(frames[0]);
    expect(frames[2]).toBe(frames[0]);

    (fakeVideo as { currentTime: number }).currentTime = 43.5;
    await vi.advanceTimersByTimeAsync(MOSS_STANDARD_VIDEO_CONFIG.intervalMs);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect(frames).toHaveLength(4);
    expect(Array.from(frames[3])).toEqual([0xff, 0xd8, 0x12, 0xff, 0xd9]);

    session.stop();
  });

  it("按会话参数缩放抽帧，并在 configure 后按新长边、质量与间隔生效", async () => {
    vi.useFakeTimers();

    const fakeVideo = {
      currentSrc: "blob:https://www.bilibili.com/video-2",
      src: "",
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 7
    } as unknown as HTMLVideoElement;

    const drawImage = vi.fn();
    let lastQuality = 0;
    const toBlob = vi.fn((callback: BlobCallback, _mime?: string, quality?: number) => {
      lastQuality = quality ?? 0;
      callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));
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
      config: { maxLongSide: 384, jpegQuality: 0.5, intervalMs: 2000 },
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fakeCanvas.width).toBe(384);
    expect(fakeCanvas.height).toBe(216);
    expect(lastQuality).toBe(0.5);
    expect(frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(frames).toHaveLength(1);

    session.configure({ maxLongSide: 512, jpegQuality: 0.75, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeCanvas.width).toBe(512);
    expect(fakeCanvas.height).toBe(288);
    expect(lastQuality).toBe(0.75);
    expect(frames).toHaveLength(2);

    session.stop();
  });

  it("pauseWhenStatic 下钳制采样率不超过 1 FPS，暂停/结束/隐藏即停推并支持恢复与 snapshot", async () => {
    vi.useFakeTimers();
    const fakeVideo = createFakeDomVideo({ paused: false, currentTime: 5 });
    const { canvas, drawImage, toBlob } = createFakeCanvasHarness();
    let hidden = false;
    const frames: Uint8Array[] = [];

    const session = createPageVideoFrameCapture({
      getVideo: () => fakeVideo as unknown as HTMLVideoElement,
      createCanvas: () => canvas,
      config: { intervalMs: 250 },
      pauseWhenStatic: true,
      isDocumentHidden: () => hidden,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);
    expect(session.isSuspended?.()).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(frames).toHaveLength(1);
    fakeVideo.currentTime = 6;
    await vi.advanceTimersByTimeAsync(MIN_LIVE_VIDEO_CAPTURE_INTERVAL_MS - 500);
    expect(frames).toHaveLength(2);

    session.configure({ intervalMs: 300 });
    fakeVideo.currentTime = 7;
    await vi.advanceTimersByTimeAsync(999);
    expect(frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(3);

    fakeVideo.paused = true;
    fakeVideo.dispatch("pause");
    const countAfterPause = frames.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toHaveLength(countAfterPause);
    expect(session.isSuspended?.()).toBe(true);

    fakeVideo.currentTime = 7.5;
    const snapshot = await session.captureSnapshot?.();
    expect(snapshot).not.toBeNull();
    expect(frames).toHaveLength(countAfterPause);
    expect(drawImage).toHaveBeenCalledTimes(countAfterPause + 1);
    expect(toBlob).toHaveBeenCalledTimes(countAfterPause + 1);

    fakeVideo.paused = false;
    fakeVideo.currentTime = 8;
    fakeVideo.dispatch("play");
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(countAfterPause + 1);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(session.isSuspended?.()).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(frames).toHaveLength(countAfterPause + 1);

    hidden = false;
    fakeVideo.currentTime = 12;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(countAfterPause + 2);

    fakeVideo.ended = true;
    fakeVideo.dispatch("ended");
    await vi.advanceTimersByTimeAsync(3000);
    expect(frames).toHaveLength(countAfterPause + 2);

    session.stop();
  });

  it("pauseWhenStatic 下 seeked 经防抖仅补推一帧新画面，暂停态拖动也补推单帧但保持停推", async () => {
    vi.useFakeTimers();
    const fakeVideo = createFakeDomVideo({ paused: true, currentTime: 20 });
    const { canvas, drawImage } = createFakeCanvasHarness();
    const frames: Uint8Array[] = [];

    const session = createPageVideoFrameCapture({
      getVideo: () => fakeVideo as unknown as HTMLVideoElement,
      createCanvas: () => canvas,
      pauseWhenStatic: true,
      seekDebounceMs: DEFAULT_VIDEO_SEEK_CAPTURE_DEBOUNCE_MS,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(0);

    fakeVideo.currentTime = 45;
    fakeVideo.dispatch("seeked");
    await vi.advanceTimersByTimeAsync(100);
    fakeVideo.currentTime = 90;
    fakeVideo.dispatch("seeked");
    await vi.advanceTimersByTimeAsync(100);
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(frames).toHaveLength(1);

    session.stop();
  });
});
