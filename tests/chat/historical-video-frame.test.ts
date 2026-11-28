// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { encodeVideoStorageBvid } from "../../extension/shared/site.js";
import {
  IDLE_VIDEO_DISPOSE_MS,
  captureHistoricalVideoFrame,
  createHistoricalVideoFrameSession
} from "../../extension/chat/historical-video-frame.js";
import { contentEventBus } from "../../extension/shared/content-event-bus.js";

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
    expect(media.video.preload).toBe("metadata");
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

  it("会话内连续取帧复用视频，关闭时才清理媒体", async () => {
    const media = makeVideo();
    const { canvas } = makeCanvas();
    const transport = vi.fn(async () => ({
      code: 0,
      data: { durl: [{ url: "https://upos.example.com/video.mp4" }] }
    }));
    const createVideo = vi.fn(() => media.video);
    const session = createHistoricalVideoFrameSession(
      { bvid: "BV1history", cid: "101" },
      { transport, createVideo, createCanvas: () => canvas }
    );
    try {
      const first = session.capture(90);
      await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
      media.metadataReady();
      media.canPlay();
      await first;
      expect(media.video.isConnected).toBe(true);

      await session.capture(30);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(createVideo).toHaveBeenCalledTimes(1);
      expect(media.seeks).toEqual([88, 90, 92, 28, 30, 32]);
    } finally {
      session.close();
    }
    expect(media.video.isConnected).toBe(false);
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

  it("B 站会话静置 20000ms 自动卸载移除隐藏 video，连续抽帧顺延计时且销毁后可按需重建", async () => {
    vi.useFakeTimers();
    try {
      const firstMedia = makeVideo();
      const secondMedia = makeVideo();
      const created = [firstMedia, secondMedia];
      let createIdx = 0;
      const { canvas } = makeCanvas();
      const transport = vi.fn(async () => ({
        code: 0,
        data: { durl: [{ url: "https://upos.example.com/video.mp4" }] }
      }));
      const createVideo = vi.fn(() => created[createIdx++].video);
      const session = createHistoricalVideoFrameSession(
        { bvid: "BV1idle", cid: "202" },
        { transport, createVideo, createCanvas: () => canvas }
      );
      try {
        const firstCapture = session.capture(90);
        await Promise.resolve();
        await Promise.resolve();
        expect(firstMedia.video.isConnected).toBe(true);
        expect(firstMedia.video.preload).toBe("metadata");
        firstMedia.metadataReady();
        firstMedia.canPlay();
        await firstCapture;

        await vi.advanceTimersByTimeAsync(15_000);
        expect(firstMedia.video.isConnected).toBe(true);

        await session.capture(30);
        expect(createVideo).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(firstMedia.video.isConnected).toBe(true);

        await vi.advanceTimersByTimeAsync(IDLE_VIDEO_DISPOSE_MS - 15_000);
        expect(firstMedia.video.isConnected).toBe(false);
        expect(firstMedia.video.getAttribute("src")).toBeNull();
        expect(firstMedia.video.pause).toHaveBeenCalledTimes(1);
        expect(firstMedia.video.load).toHaveBeenCalledTimes(1);

        const rebuildCapture = session.capture(50);
        await Promise.resolve();
        await Promise.resolve();
        expect(createVideo).toHaveBeenCalledTimes(2);
        expect(secondMedia.video.isConnected).toBe(true);
        secondMedia.metadataReady();
        secondMedia.canPlay();
        await rebuildCapture;
      } finally {
        session.close();
      }
      expect(secondMedia.video.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("换片事件 clip:switch-start 立即销毁闲置隐藏 video", async () => {
    const media = makeVideo();
    const { canvas } = makeCanvas();
    const session = createHistoricalVideoFrameSession(
      { bvid: "BV1switch", cid: "303" },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas
      }
    );
    try {
      const first = session.capture(40);
      await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
      media.metadataReady();
      media.canPlay();
      await first;
      expect(media.video.isConnected).toBe(true);

      contentEventBus.emit("clip:switch-start", {
        url: "https://www.bilibili.com/",
        signature: "home",
        runId: 2
      });

      expect(media.video.isConnected).toBe(false);
      expect(media.video.getAttribute("src")).toBeNull();
      expect(media.video.pause).toHaveBeenCalledTimes(1);
      expect(media.video.load).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });
});

function makeFakeMediaSource(opts: { autoOpen?: boolean; hangAppend?: boolean } = {}) {
  const { autoOpen = true, hangAppend = false } = opts;
  const msTarget = new EventTarget();
  const sbTarget = new EventTarget();
  const appended: ArrayBuffer[] = [];
  let readyState: MediaSource["readyState"] = autoOpen ? "open" : "closed";
  let ended = false;
  let addedMimeType = "";

  const sourceBuffer = Object.assign(sbTarget, {
    updating: false,
    appendBuffer: vi.fn((data: ArrayBuffer) => {
      appended.push(data);
      if (!hangAppend) {
        queueMicrotask(() => sbTarget.dispatchEvent(new Event("updateend")));
      }
    })
  }) as unknown as SourceBuffer;

  const mediaSource = Object.assign(msTarget, {
    addSourceBuffer: vi.fn((mimeType: string) => {
      addedMimeType = mimeType;
      return sourceBuffer;
    }),
    endOfStream: vi.fn(() => {
      ended = true;
      readyState = "ended";
    })
  }) as unknown as MediaSource;
  Object.defineProperty(mediaSource, "readyState", {
    configurable: true,
    get: () => readyState
  });

  return {
    mediaSource,
    sourceBuffer,
    appended,
    get addedMimeType() {
      return addedMimeType;
    },
    get ended() {
      return ended;
    },
    open() {
      readyState = "open";
      msTarget.dispatchEvent(new Event("sourceopen"));
    }
  };
}

function makeBufferedRanges(ranges: Array<[number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index][0],
    end: (index: number) => ranges[index][1]
  };
}

describe("YouTube 离屏 MSE/SABR 历史三帧截取", () => {
  it("解码 yt~ 存储键、按序写入 init 与分片并 endOfStream，截完清理隐藏媒体与 objectURL", async () => {
    const media = makeVideo(120);
    media.canPlay();
    const { canvas, context } = makeCanvas();
    const fakeMs = makeFakeMediaSource({ autoOpen: false });
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-frame-1");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const rawVideoId = "ab_cd-12345";
    const storageBvid = encodeVideoStorageBvid("youtube", rawVideoId);
    const initSeg = new Uint8Array([1, 2]).buffer;
    const seg1 = new Uint8Array([3, 4]).buffer;
    const seg2 = new Uint8Array([5, 6]).buffer;
    const fetchYoutubeWindow = vi.fn(async () => ({
      mimeType: 'video/mp4; codecs="avc1.4d401f"',
      durationMs: 120_000,
      initSegment: initSeg,
      mediaSegments: [seg1, seg2]
    }));

    try {
      const pending = captureHistoricalVideoFrame(
        { site: "youtube", bvid: storageBvid, cid: "1", targetTime: 40 },
        {
          fetchYoutubeWindow,
          createMediaSource: () => fakeMs.mediaSource,
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      );

      await vi.waitFor(() => expect(media.video.isConnected).toBe(true));
      expect(media.video.src).toBe("blob:yt-frame-1");
      fakeMs.open();

      const frames = await pending;
      expect(fetchYoutubeWindow).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: rawVideoId, startMs: 38_000, endMs: 42_000 })
      );
      expect(fakeMs.addedMimeType).toBe('video/mp4; codecs="avc1.4d401f"');
      expect(fakeMs.appended).toEqual([initSeg, seg1, seg2]);
      expect(fakeMs.ended).toBe(true);
      expect(media.seeks).toEqual([38, 40, 42]);
      expect(frames.map((frame) => frame.targetTime)).toEqual([38, 40, 42]);
      expect(context.drawImage).toHaveBeenCalledTimes(3);
      expect(media.video.isConnected).toBe(false);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-frame-1");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("缓冲区间窄于 [t-2, t+2] 时经 clampToBufferedRange 夹紧至最近有效缓冲点", async () => {
    const media = makeVideo(120);
    media.canPlay();
    Object.defineProperty(media.video, "buffered", {
      configurable: true,
      get: () => makeBufferedRanges([[39, 41]])
    });
    const { canvas } = makeCanvas();
    const fakeMs = makeFakeMediaSource();
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-frame-2");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      const frames = await captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", targetTime: 40 },
        {
          fetchYoutubeWindow: async () => ({
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 120_000,
            initSegment: new Uint8Array([1]).buffer,
            mediaSegments: [new Uint8Array([2]).buffer]
          }),
          createMediaSource: () => fakeMs.mediaSource,
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      );

      expect(media.seeks).toEqual([39, 40, 41]);
      expect(frames.map((frame) => frame.targetTime)).toEqual([39, 40, 41]);
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("目标时间超出 YouTube 视频时长时立即抛出可读错误", async () => {
    await expect(
      captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", targetTime: 130 },
        {
          fetchYoutubeWindow: async () => ({
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 120_000,
            initSegment: new Uint8Array([1]).buffer,
            mediaSegments: [new Uint8Array([2]).buffer]
          })
        }
      )
    ).rejects.toThrow("目标时间点 130 秒超出视频时长 120.0 秒");
  });

  it("YouTube MSE 写入阶段中止时抛出 AbortError 并清理隐藏视频与 objectURL", async () => {
    const media = makeVideo(120);
    const fakeMs = makeFakeMediaSource({ autoOpen: true, hangAppend: true });
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-frame-abort");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const controller = new AbortController();

    try {
      const pending = captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", targetTime: 20 },
        {
          fetchYoutubeWindow: async () => ({
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 120_000,
            initSegment: new Uint8Array([1]).buffer,
            mediaSegments: [new Uint8Array([2]).buffer]
          }),
          createMediaSource: () => fakeMs.mediaSource,
          createVideo: () => media.video,
          signal: controller.signal
        }
      );

      await vi.waitFor(() => expect(fakeMs.appended).toHaveLength(1));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(media.video.isConnected).toBe(false);
      expect(media.video.pause).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-frame-abort");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });
});
