// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { encodeVideoStorageBvid } from "../../extension/shared/site.js";
import {
  IDLE_VIDEO_DISPOSE_MS,
  MAX_CLAMP_DRIFT_SECONDS,
  YT_MAX_CLUSTERS_PER_CALL,
  captureHistoricalVideoFrame,
  clampTargetToBufferedWithDriftGuard,
  clusterYoutubeFrameWindows,
  createHistoricalVideoFrameSession,
  expandAndDedupeFrameTargets
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
        currentTime = Math.max(0, value - 0.05);
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

describe("多时间点展开去重与 YouTube 窗口聚类纯函数", () => {
  it("expandAndDedupeFrameTargets 默认单帧收敛、支持邻域展开、0.25s 中心优先去重与 maxFrames 软裁剪", () => {
    expect(expandAndDedupeFrameTargets({ times: [40] })).toEqual({
      targets: [{ anchorTime: 40, targetTime: 40 }],
      truncatedTargets: []
    });

    expect(expandAndDedupeFrameTargets({ times: [40], spanSeconds: 2 })).toEqual({
      targets: [
        { anchorTime: 40, targetTime: 38 },
        { anchorTime: 40, targetTime: 40 },
        { anchorTime: 40, targetTime: 42 }
      ],
      truncatedTargets: []
    });

    expect(expandAndDedupeFrameTargets({ times: [0], spanSeconds: 2 }, 120)).toEqual({
      targets: [
        { anchorTime: 0, targetTime: 0 },
        { anchorTime: 0, targetTime: 2 }
      ],
      truncatedTargets: []
    });

    expect(expandAndDedupeFrameTargets({ times: [0.1], spanSeconds: 2 }, 120)).toEqual({
      targets: [
        { anchorTime: 0.1, targetTime: 0.1 },
        { anchorTime: 0.1, targetTime: 2.1 }
      ],
      truncatedTargets: []
    });

    expect(expandAndDedupeFrameTargets({ times: [10, 12], spanSeconds: 2 }, 120)).toEqual({
      targets: [
        { anchorTime: 10, targetTime: 8 },
        { anchorTime: 10, targetTime: 10 },
        { anchorTime: 12, targetTime: 12 },
        { anchorTime: 12, targetTime: 14 }
      ],
      truncatedTargets: []
    });

    expect(expandAndDedupeFrameTargets({ times: [90, 15, 45, 120], maxFrames: 2 })).toEqual({
      targets: [
        { anchorTime: 15, targetTime: 15 },
        { anchorTime: 45, targetTime: 45 }
      ],
      truncatedTargets: [
        { anchorTime: 90, targetTime: 90 },
        { anchorTime: 120, targetTime: 120 }
      ]
    });

    expect(() => expandAndDedupeFrameTargets({ times: [] })).toThrow("目标时间点列表不能为空");
    expect(() => expandAndDedupeFrameTargets({ times: [-1] })).toThrow("大于或等于 0 的有限秒数");
    expect(() => expandAndDedupeFrameTargets({ times: [10], spanSeconds: -1 })).toThrow("邻域跨度");
    expect(() => expandAndDedupeFrameTargets({ times: [10, 130] }, 120)).toThrow(
      "目标时间点 130 秒超出视频时长 120.0 秒"
    );
  });

  it("clusterYoutubeFrameWindows 按 <=10s 间隔与 <=20s 总跨度双阈值聚类，超 6 簇抛出可读错误", () => {
    const merged = clusterYoutubeFrameWindows([
      { anchorTime: 118, targetTime: 118 },
      { anchorTime: 123, targetTime: 123 },
      { anchorTime: 128, targetTime: 128 }
    ]);
    expect(merged).toEqual([
      {
        startMs: 117_400,
        endMs: 128_600,
        targets: [
          { anchorTime: 118, targetTime: 118 },
          { anchorTime: 123, targetTime: 123 },
          { anchorTime: 128, targetTime: 128 }
        ]
      }
    ]);

    const spanSplit = clusterYoutubeFrameWindows([
      { anchorTime: 10, targetTime: 10 },
      { anchorTime: 20, targetTime: 20 },
      { anchorTime: 30, targetTime: 30 }
    ]);
    expect(spanSplit).toHaveLength(2);
    expect(spanSplit[0]).toMatchObject({ startMs: 9_400, endMs: 20_600 });
    expect(spanSplit[1]).toMatchObject({ startMs: 29_400, endMs: 30_600 });

    const tooMany = Array.from({ length: YT_MAX_CLUSTERS_PER_CALL + 1 }, (_, i) => ({
      anchorTime: i * 60 + 10,
      targetTime: i * 60 + 10
    }));
    expect(() => clusterYoutubeFrameWindows(tooMany)).toThrow("最多支持 6 个分散时间窗口");
  });

  it("clampTargetToBufferedWithDriftGuard 超过 2.5s 漂移返回 null，拒绝跨簇错夹", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "buffered", {
      configurable: true,
      get: () => makeBufferedRanges([[29.4, 30.6], [390, 392]])
    });

    expect(MAX_CLAMP_DRIFT_SECONDS).toBe(2.5);
    expect(clampTargetToBufferedWithDriftGuard(video, 30)).toBe(30);
    expect(clampTargetToBufferedWithDriftGuard(video, 394.5)).toBe(392);
    expect(clampTargetToBufferedWithDriftGuard(video, 400)).toBeNull();
  });
});

describe("隐藏视频历史帧截取（B 站）", () => {
  it("默认单帧收敛：targetTime: 40 与 times: [40] 均仅执行 1 次 seek 并返回单帧，显式 spanSeconds=2 返回三帧", async () => {
    const mediaSingle = makeVideo();
    const { canvas: canvasSingle, context: contextSingle } = makeCanvas();
    const transport = vi.fn(async () => ({
      code: 0,
      data: { durl: [{ url: "https://upos.example.com/video.mp4" }] }
    }));

    const pendingSingle = captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", targetTime: 40 },
      { transport, createVideo: () => mediaSingle.video, createCanvas: () => canvasSingle }
    );
    await vi.waitFor(() => expect(mediaSingle.video.isConnected).toBe(true));
    expect(mediaSingle.video.crossOrigin).toBe("anonymous");
    expect(mediaSingle.video.preload).toBe("metadata");
    expect(mediaSingle.video.dataset.biliscriptHistoricalFrame).toBe("");
    expect(mediaSingle.video.muted).toBe(true);
    expect(mediaSingle.video.src).toBe("https://upos.example.com/video.mp4");
    mediaSingle.metadataReady();
    mediaSingle.canPlay();

    const singleFrames = await pendingSingle;
    expect(transport).toHaveBeenCalledWith(expect.stringContaining("bvid=BV1history&cid=101"));
    expect(mediaSingle.seeks).toEqual([40]);
    expect(singleFrames.map((frame) => frame.anchorTime)).toEqual([40]);
    expect(singleFrames.map((frame) => frame.targetTime)).toEqual([40]);
    expect(singleFrames.map((frame) => frame.currentTime)).toEqual([39.95]);
    expect(contextSingle.drawImage).toHaveBeenCalledTimes(1);
    expect(mediaSingle.video.isConnected).toBe(false);
    expect(mediaSingle.video.getAttribute("src")).toBeNull();
    expect(mediaSingle.video.pause).toHaveBeenCalledTimes(1);

    const mediaTimesSingle = makeVideo();
    const { canvas: canvasTimesSingle } = makeCanvas();
    mediaTimesSingle.canPlay();
    const timesSingleFrames = await captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", times: [40] },
      { transport, createVideo: () => mediaTimesSingle.video, createCanvas: () => canvasTimesSingle }
    );
    expect(mediaTimesSingle.seeks).toEqual([40]);
    expect(timesSingleFrames.map((frame) => frame.targetTime)).toEqual([40]);

    const mediaSpan = makeVideo();
    const { canvas: canvasSpan, context: contextSpan } = makeCanvas();
    mediaSpan.canPlay();
    const spanFrames = await captureHistoricalVideoFrame(
      { bvid: "BV1history", cid: "101", times: [40], spanSeconds: 2 },
      { transport, createVideo: () => mediaSpan.video, createCanvas: () => canvasSpan }
    );
    expect(mediaSpan.seeks).toEqual([38, 40, 42]);
    expect(spanFrames.map((frame) => frame.anchorTime)).toEqual([40, 40, 40]);
    expect(spanFrames.map((frame) => frame.targetTime)).toEqual([38, 40, 42]);
    expect(contextSpan.drawImage).toHaveBeenCalledTimes(3);
  });

  it("times: [0], spanSeconds: 2 经 0.25s 去重仅返回 [0, 2] 两帧，零重复 0s 帧", async () => {
    const media = makeVideo(120);
    media.canPlay();
    const { canvas, context } = makeCanvas();
    const frames = await captureHistoricalVideoFrame(
      { bvid: "BV1zero", cid: "101", times: [0], spanSeconds: 2 },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo: () => media.video,
        createCanvas: () => canvas
      }
    );
    expect(media.seeks).toEqual([0, 2]);
    expect(frames.map((frame) => frame.anchorTime)).toEqual([0, 0]);
    expect(frames.map((frame) => frame.targetTime)).toEqual([0, 2]);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
  });

  it("离散多点 times: [90, 15, 45] 自动按升序 [15, 45, 90] 单向 seek 同一隐藏 video 并携带准确 anchorTime", async () => {
    const media = makeVideo(120);
    media.canPlay();
    const { canvas } = makeCanvas();
    const createVideo = vi.fn(() => media.video);
    const frames = await captureHistoricalVideoFrame(
      { bvid: "BV1multi", cid: "101", times: [90, 15, 45] },
      {
        transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
        createVideo,
        createCanvas: () => canvas
      }
    );
    expect(createVideo).toHaveBeenCalledTimes(1);
    expect(media.seeks).toEqual([15, 45, 90]);
    expect(frames.map((frame) => ({ anchorTime: frame.anchorTime, targetTime: frame.targetTime }))).toEqual([
      { anchorTime: 15, targetTime: 15 },
      { anchorTime: 45, targetTime: 45 },
      { anchorTime: 90, targetTime: 90 }
    ]);
  });

  it("B 站显式 anchorTime 超出视频 duration 时立即抛错", async () => {
    const media = makeVideo(100);
    media.canPlay();
    const { canvas } = makeCanvas();
    await expect(
      captureHistoricalVideoFrame(
        { bvid: "BV1oob", cid: "101", times: [20, 120] },
        {
          transport: async () => ({ code: 0, data: { durl: [{ url: "https://upos.example.com/video.mp4" }] } }),
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      )
    ).rejects.toThrow("目标时间点 120 秒超出视频时长 100.0 秒");
    expect(media.seeks).toEqual([]);
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

      await session.capture({ times: [30], spanSeconds: 2 });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(createVideo).toHaveBeenCalledTimes(1);
      expect(media.seeks).toEqual([90, 28, 30, 32]);
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
      { bvid: "BV1history", cid: "101", times: [90], spanSeconds: 2 },
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
    expect(frames.map((frame) => frame.targetTime)).toEqual([90]);
  });

  it("视频首尾边界内的展开时间点被夹紧到有效范围", async () => {
    async function seekTimesAt(targetTime: number) {
      const media = makeVideo(10);
      const { canvas } = makeCanvas();
      const pending = captureHistoricalVideoFrame(
        { bvid: "BV1history", cid: "101", times: [targetTime], spanSeconds: 2 },
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
      { bvid: "BV1history", cid: "101", times: [90], spanSeconds: 2 },
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

describe("YouTube 离屏 MSE/SABR 多时间点聚类与漂移守卫", () => {
  it("近距多点 times: [118, 123, 128] 合并为 1 次窗口拉取 [117400, 128600]，解码存储键并在 finally 清理", async () => {
    const media = makeVideo(200);
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
      durationMs: 200_000,
      initSegment: initSeg,
      mediaSegments: [seg1, seg2]
    }));

    try {
      const pending = captureHistoricalVideoFrame(
        { site: "youtube", bvid: storageBvid, cid: "1", times: [118, 123, 128] },
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
      expect(fetchYoutubeWindow).toHaveBeenCalledTimes(1);
      expect(fetchYoutubeWindow).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: rawVideoId, startMs: 117_400, endMs: 128_600 })
      );
      expect(fakeMs.addedMimeType).toBe('video/mp4; codecs="avc1.4d401f"');
      expect(fakeMs.appended).toEqual([initSeg, seg1, seg2]);
      expect(fakeMs.ended).toBe(true);
      expect(media.seeks).toEqual([118, 123, 128]);
      expect(frames.map((frame) => ({ anchorTime: frame.anchorTime, targetTime: frame.targetTime }))).toEqual([
        { anchorTime: 118, targetTime: 118 },
        { anchorTime: 123, targetTime: 123 },
        { anchorTime: 128, targetTime: 128 }
      ]);
      expect(context.drawImage).toHaveBeenCalledTimes(3);
      expect(media.video.isConnected).toBe(false);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-frame-1");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("远距多点 times: [30, 400] 拆为 2 次严格串行拉取并复用同一 MediaSource，同编码只写入一次 initSegment", async () => {
    const media = makeVideo(600);
    media.canPlay();
    Object.defineProperty(media.video, "buffered", {
      configurable: true,
      get: () => makeBufferedRanges([[29.4, 30.6], [399.4, 400.6]])
    });
    const { canvas } = makeCanvas();
    const fakeMs = makeFakeMediaSource();
    const createMediaSource = vi.fn(() => fakeMs.mediaSource);
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-reuse");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const init1 = new Uint8Array([1]).buffer;
    const seg1 = new Uint8Array([2]).buffer;
    const init2 = new Uint8Array([3]).buffer;
    const seg2 = new Uint8Array([4]).buffer;
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchYoutubeWindow = vi.fn(async ({ startMs }: { startMs: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return startMs < 100_000
        ? {
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 600_000,
            initSegment: init1,
            mediaSegments: [seg1]
          }
        : {
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 600_000,
            initSegment: init2,
            mediaSegments: [seg2]
          };
    });

    try {
      const frames = await captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", times: [30, 400] },
        {
          fetchYoutubeWindow,
          createMediaSource,
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      );

      expect(maxInFlight).toBe(1);
      expect(fetchYoutubeWindow).toHaveBeenCalledTimes(2);
      expect(fetchYoutubeWindow).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ startMs: 29_400, endMs: 30_600 })
      );
      expect(fetchYoutubeWindow).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ startMs: 399_400, endMs: 400_600 })
      );
      expect(createMediaSource).toHaveBeenCalledTimes(1);
      expect(fakeMs.appended).toEqual([init1, seg1, seg2]);
      expect(media.seeks).toEqual([30, 400]);
      expect(frames.map((frame) => frame.targetTime)).toEqual([30, 400]);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-reuse");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("第 2 簇缓冲仅覆盖 [390, 392]（距 400s 漂移 8s > 2.5s）时跳过 400s，绝不跨簇错夹到 30.6s 或 392s", async () => {
    const media = makeVideo(600);
    media.canPlay();
    Object.defineProperty(media.video, "buffered", {
      configurable: true,
      get: () => makeBufferedRanges([[29.4, 30.6], [390, 392]])
    });
    const { canvas } = makeCanvas();
    const fakeMs = makeFakeMediaSource();
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-drift");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      const frames = await captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", times: [30, 400] },
        {
          fetchYoutubeWindow: async () => ({
            mimeType: 'video/mp4; codecs="avc1.4d401f"',
            durationMs: 600_000,
            initSegment: new Uint8Array([1]).buffer,
            mediaSegments: [new Uint8Array([2]).buffer]
          }),
          createMediaSource: () => fakeMs.mediaSource,
          createVideo: () => media.video,
          createCanvas: () => canvas
        }
      );

      expect(media.seeks).toEqual([30]);
      expect(frames.map((frame) => ({ anchorTime: frame.anchorTime, targetTime: frame.targetTime }))).toEqual([
        { anchorTime: 30, targetTime: 30 }
      ]);
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("整批目标均因缓冲漂移超 2.5s 跳过导致 0 帧命中时抛出可读错误", async () => {
    const media = makeVideo(600);
    media.canPlay();
    Object.defineProperty(media.video, "buffered", {
      configurable: true,
      get: () => makeBufferedRanges([[390, 392]])
    });
    const { canvas } = makeCanvas();
    const fakeMs = makeFakeMediaSource();
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:yt-empty");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    try {
      await expect(
        captureHistoricalVideoFrame(
          { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", times: [400] },
          {
            fetchYoutubeWindow: async () => ({
              mimeType: 'video/mp4; codecs="avc1.4d401f"',
              durationMs: 600_000,
              initSegment: new Uint8Array([1]).buffer,
              mediaSegments: [new Uint8Array([2]).buffer]
            }),
            createMediaSource: () => fakeMs.mediaSource,
            createVideo: () => media.video,
            createCanvas: () => canvas
          }
        )
      ).rejects.toThrow("未截取到可用画面");
      expect(media.seeks).toEqual([]);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-empty");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("后续簇 mimeType 变化时降级新建 MediaSource 并统一释放两套离屏媒体", async () => {
    const media1 = makeVideo(600);
    media1.canPlay();
    const media2 = makeVideo(600);
    media2.canPlay();
    const medias = [media1, media2];
    let mediaIdx = 0;
    const ms1 = makeFakeMediaSource();
    const ms2 = makeFakeMediaSource();
    const sources = [ms1, ms2];
    let msIdx = 0;
    const { canvas } = makeCanvas();
    let urlIdx = 0;
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:yt-mime-${++urlIdx}`);
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    let callIdx = 0;
    try {
      const frames = await captureHistoricalVideoFrame(
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", times: [30, 400] },
        {
          fetchYoutubeWindow: async () => {
            callIdx += 1;
            return {
              mimeType: callIdx === 1 ? 'video/mp4; codecs="avc1.4d401f"' : 'video/webm; codecs="vp9"',
              durationMs: 600_000,
              initSegment: new Uint8Array([callIdx]).buffer,
              mediaSegments: [new Uint8Array([callIdx + 10]).buffer]
            };
          },
          createMediaSource: () => sources[msIdx++].mediaSource,
          createVideo: () => medias[mediaIdx++].video,
          createCanvas: () => canvas
        }
      );

      expect(frames.map((frame) => frame.targetTime)).toEqual([30, 400]);
      expect(ms1.addedMimeType).toBe('video/mp4; codecs="avc1.4d401f"');
      expect(ms2.addedMimeType).toBe('video/webm; codecs="vp9"');
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-mime-1");
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:yt-mime-2");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
    }
  });

  it("缓冲区间窄于 [t-2, t+2] 且漂移在 2.5s 内时夹紧至最近有效缓冲点", async () => {
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
        { site: "youtube", bvid: encodeVideoStorageBvid("youtube", "dQw4w9WgXcQ"), cid: "1", times: [40], spanSeconds: 2 },
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
      expect(frames.map((frame) => frame.anchorTime)).toEqual([40, 40, 40]);
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
