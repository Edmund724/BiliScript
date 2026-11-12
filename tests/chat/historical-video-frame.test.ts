import { describe, expect, it, vi } from "vitest";
import { captureHistoricalVideoFrame } from "../../extension/chat/historical-video-frame.js";

function makeVideo(duration = 120) {
  const video = document.createElement("video");
  let currentTime = 0;
  let readyState = 0;
  const seeks: number[] = [];
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        seeks.push(value);
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
    seeks,
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
  it("围绕目标时间依次截取前中后三帧，导出后清理隐藏媒体", async () => {
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

    const frames = await pending;
    expect(transport).toHaveBeenCalledWith(expect.stringContaining("bvid=BV1history&cid=101"));
    expect(media.seeks).toEqual([88, 90, 92]);
    expect(frames.map((frame) => frame.targetTime)).toEqual([88, 90, 92]);
    expect(frames.map((frame) => frame.currentTime)).toEqual([87.95, 89.95, 91.95]);
    expect(frames.every((frame) => Array.from(frame.jpegBytes).join(",") === "1,2,3")).toBe(true);
    expect(context.drawImage).toHaveBeenCalledTimes(3);
    expect(context.drawImage).toHaveBeenCalledWith(media.video, 0, 0, 640, 360);
    expect(media.video.isConnected).toBe(false);
    expect(media.video.getAttribute("src")).toBeNull();
    expect(media.video.pause).toHaveBeenCalledTimes(1);
  });

  it("元数据就绪后直接 seek 首个目标，不等待起始位置缓冲", async () => {
    const media = makeVideo();
    const { canvas } = makeCanvas();
    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas
      }
    );
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
    media.metadataReady();
    try {
      await vi.waitFor(() => expect(media.seeks).toEqual([88]));
    } finally {
      media.canPlay();
    }

    const frames = await pending;
    expect(frames.map((frame) => frame.targetTime)).toEqual([88, 90, 92]);
  });

  it("DASH 请求不返回 MP4 时改用显式 MP4 请求截帧", async () => {
    const media = makeVideo();
    const { canvas } = makeCanvas();
    media.canPlay();
    const transport = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get("fnval") === "16") {
        return { code: 0, data: { dash: { video: [] } } };
      }
      return { code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } };
    });

    const frames = await captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      { transport, createVideo: () => media.video, createCanvas: () => canvas }
    );

    const request = new URL(transport.mock.calls[0][0]);
    expect(request.searchParams.get("qn")).toBe("16");
    expect(request.searchParams.get("fnval")).toBe("1");
    expect(frames.map((frame) => frame.targetTime)).toEqual([88, 90, 92]);
  });

  it("视频首尾边界内的前中后时间点被截断到有效范围", async () => {
    async function seekTimesAt(targetTime: number) {
      const media = makeVideo(10);
      const { canvas } = makeCanvas();
      const pending = captureHistoricalVideoFrame(
        { bvid: "BV1history", cid: "101", targetTime },
        {
          transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      );
      await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
      media.metadataReady();
      media.canPlay();
      await pending;
      return media.seeks;
    }

    await expect(seekTimesAt(0.5)).resolves.toEqual([0, 0.5, 2.5]);
    await expect(seekTimesAt(9.5)).resolves.toEqual([7.5, 9.5, 10]);
  });

  it("中间帧编码失败时保留前后成功帧并继续按序截取", async () => {
    const media = makeVideo();
    const { canvas, context } = makeCanvas();
    vi.mocked(canvas.toBlob).mockImplementation((callback) => {
      callback(context.drawImage.mock.calls.length === 2
        ? null
        : new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    });
    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas
      }
    );
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
    media.metadataReady();
    media.canPlay();

    const frames = await pending;
    expect(media.seeks).toEqual([88, 90, 92]);
    expect(frames.map((frame) => frame.currentTime)).toEqual([87.95, 91.95]);
    expect(media.video.isConnected).toBe(false);
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

  it("等待隐藏媒体就绪时中止会立即结束并释放媒体", async () => {
    const media = makeVideo();
    const controller = new AbortController();
    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        signal: controller.signal
      }
    );
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));

    controller.abort();
    media.video.dispatchEvent(new Event("error"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(media.video.isConnected).toBe(false);
    expect(media.video.getAttribute("src")).toBeNull();
    expect(media.video.pause).toHaveBeenCalledTimes(1);
  });

  it("整次取帧超时返回可读错误并清理，即使画面编码一直不回调", async () => {
    const media = makeVideo();
    const { canvas } = makeCanvas();
    canvas.toBlob = vi.fn();
    const pending = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 90 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas,
        timeoutMs: 100
      }
    );
    const observed = pending.catch((error) => error);
    await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
    media.metadataReady();
    media.canPlay();

    const outcome = await Promise.race([
      observed,
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 300))
    ]);

    expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("历史帧截取超时") }));
    expect(media.video.isConnected).toBe(false);
    expect(media.video.getAttribute("src")).toBeNull();
  });
});
