import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  MOSS_VIDEO_FRAME_INTERVAL_MS,
  MOSS_VIDEO_FRAME_MAX_EDGE,
  MOSS_VIDEO_JPEG_QUALITY,
  createPageVideoFrameCapture
} from "../../extension/live/page-video-frame-capture.js";

class FakeVideo {
  currentSrc = "https://example.test/video-a.mp4";
  src = this.currentSrc;
  readyState = 2;
  videoWidth = 1920;
  videoHeight = 1080;
  currentTime = 0;
  paused = false;
}

type BlobCallback = (blob: Blob | null) => void;

class FakeCanvas {
  width = 0;
  height = 0;
  drawImage = vi.fn();
  pendingCallbacks: BlobCallback[] = [];
  jpegOptions: { type?: string; quality?: number }[] = [];
  automatic = true;

  getContext(type: string) {
    return type === "2d" ? { drawImage: this.drawImage } : null;
  }

  toBlob(callback: BlobCallback, type?: string, quality?: number): void {
    this.jpegOptions.push({ type, quality });
    if (this.automatic) {
      queueMicrotask(() => callback(createJpegBlob([0xff, 0xd8, 0xff, 0xd9])));
    } else {
      this.pendingCallbacks.push(callback);
    }
  }
}

function createJpegBlob(bytes: number[]): Blob {
  return {
    arrayBuffer: async () => new Uint8Array(bytes).buffer
  } as Blob;
}

async function flushEncoding(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetModuleState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createPageVideoFrameCapture", () => {
  it("captures at 1fps with a 960px long edge and JPEG quality 0.72, skipping an unchanged paused frame", async () => {
    const video = new FakeVideo();
    const canvas = new FakeCanvas();
    const frames: Uint8Array[] = [];
    const capture = createPageVideoFrameCapture({
      getVideo: () => video as unknown as HTMLVideoElement,
      createCanvas: () => canvas as unknown as HTMLCanvasElement,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    await flushEncoding();
    expect(frames).toHaveLength(1);
    expect(canvas.width).toBe(MOSS_VIDEO_FRAME_MAX_EDGE);
    expect(canvas.height).toBe(540);
    expect(canvas.drawImage).toHaveBeenCalledWith(video, 0, 0, 960, 540);
    expect(canvas.jpegOptions[0]).toEqual({ type: "image/jpeg", quality: MOSS_VIDEO_JPEG_QUALITY });

    video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(frames).toHaveLength(2);

    video.paused = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toHaveLength(2);

    video.paused = false;
    video.currentTime = 2;
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(frames).toHaveLength(3);
    capture.stop();
  });

  it("keeps only one encode in flight and drops an old element's late result after switching videos", async () => {
    const firstVideo = new FakeVideo();
    const secondVideo = new FakeVideo();
    secondVideo.currentSrc = "https://example.test/video-b.mp4";
    secondVideo.src = secondVideo.currentSrc;
    let currentVideo = firstVideo;
    const canvas = new FakeCanvas();
    canvas.automatic = false;
    const frames: Uint8Array[] = [];
    const capture = createPageVideoFrameCapture({
      getVideo: () => currentVideo as unknown as HTMLVideoElement,
      createCanvas: () => canvas as unknown as HTMLCanvasElement,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    expect(canvas.pendingCallbacks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(canvas.pendingCallbacks).toHaveLength(1);

    currentVideo = secondVideo;
    canvas.pendingCallbacks.shift()?.(createJpegBlob([1]));
    await flushEncoding();
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(canvas.pendingCallbacks).toHaveLength(1);
    expect(canvas.drawImage).toHaveBeenLastCalledWith(secondVideo, 0, 0, 960, 540);
    canvas.pendingCallbacks.shift()?.(createJpegBlob([2]));
    await flushEncoding();
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([2]);
    capture.stop();
  });

  it("invalidates an in-flight frame when the same element changes video source", async () => {
    const video = new FakeVideo();
    const canvas = new FakeCanvas();
    canvas.automatic = false;
    const frames: Uint8Array[] = [];
    const capture = createPageVideoFrameCapture({
      getVideo: () => video as unknown as HTMLVideoElement,
      createCanvas: () => canvas as unknown as HTMLCanvasElement,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    video.currentSrc = "https://example.test/video-b.mp4";
    video.src = video.currentSrc;
    canvas.pendingCallbacks.shift()?.(createJpegBlob([1]));
    await flushEncoding();
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(canvas.pendingCallbacks).toHaveLength(1);
    capture.stop();
  });

  it("ignores unavailable video and canvas failures, then retries on a later tick", async () => {
    const video = new FakeVideo();
    video.readyState = 0;
    const canvas = new FakeCanvas();
    const frames: Uint8Array[] = [];
    const capture = createPageVideoFrameCapture({
      getVideo: () => video as unknown as HTMLVideoElement,
      createCanvas: () => canvas as unknown as HTMLCanvasElement,
      onJpegFrame: (bytes) => frames.push(bytes)
    });
    expect(canvas.drawImage).not.toHaveBeenCalled();

    video.readyState = 2;
    canvas.drawImage.mockImplementationOnce(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    expect(frames).toHaveLength(0);

    video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(MOSS_VIDEO_FRAME_INTERVAL_MS);
    await flushEncoding();
    expect(frames).toHaveLength(1);
    capture.stop();
  });

  it("stop clears the timer, releases the canvas, and ignores late encoding callbacks", async () => {
    const video = new FakeVideo();
    const canvas = new FakeCanvas();
    canvas.automatic = false;
    const frames: Uint8Array[] = [];
    const capture = createPageVideoFrameCapture({
      getVideo: () => video as unknown as HTMLVideoElement,
      createCanvas: () => canvas as unknown as HTMLCanvasElement,
      onJpegFrame: (bytes) => frames.push(bytes)
    });

    capture.stop();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    canvas.pendingCallbacks.shift()?.(createJpegBlob([1]));
    await flushEncoding();
    await vi.advanceTimersByTimeAsync(5000);
    expect(frames).toHaveLength(0);
    expect(canvas.pendingCallbacks).toHaveLength(0);
  });
});
