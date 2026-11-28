import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalFrameRequestSpec } from "../../extension/chat/historical-video-frame.js";

const { captureCurrent, captureHistorical, closeHistorical, createHistorical } = vi.hoisted(() => ({
  captureCurrent: vi.fn(),
  captureHistorical: vi.fn(),
  closeHistorical: vi.fn(),
  createHistorical: vi.fn()
}));

vi.mock("../../extension/live/page-video-frame-capture.js", () => ({
  capturePageVideoFrame: captureCurrent
}));
vi.mock("../../extension/chat/historical-video-frame.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/chat/historical-video-frame.js")>();
  return {
    ...actual,
    createHistoricalVideoFrameSession: createHistorical
  };
});

import { expandAndDedupeFrameTargets } from "../../extension/chat/historical-video-frame.js";
import {
  MAX_BRIDGE_FRAMES_PER_REQUEST,
  captureAgentBridgeFrames,
  computeBridgeFrameTimeoutMs
} from "../../extension/agent-bridge/frame.js";

function historicalFrames(request: number | HistoricalFrameRequestSpec) {
  const spec: HistoricalFrameRequestSpec =
    typeof request === "number" ? { times: [request], spanSeconds: 0 } : request;
  const { targets } = expandAndDedupeFrameTargets(spec);
  return targets.map((target) => ({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    anchorTime: target.anchorTime,
    targetTime: target.targetTime,
    currentTime: target.targetTime + 0.05
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  captureCurrent.mockResolvedValue({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    currentTime: 12.5
  });
  captureHistorical.mockImplementation(async (request: number | HistoricalFrameRequestSpec) =>
    historicalFrames(request)
  );
  createHistorical.mockReturnValue({ capture: captureHistorical, close: closeHistorical });
});

describe("Agent Bridge 视频帧编码", () => {
  it("当前帧不 seek，并以当前播放秒数作为目标时间", async () => {
    const result = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100" });

    expect(captureCurrent).toHaveBeenCalledTimes(1);
    expect(createHistorical).not.toHaveBeenCalled();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ anchorTime: 12.5, targetTime: 12.5, currentTime: 12.5 });
    expect(result.frames[0].data).toBe("/9j/2Q==");
  });

  it("历史帧默认单帧收敛并保留 anchorTime、targetTime 与 currentTime，显式 spanSeconds 展开邻域", async () => {
    const single = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 });

    expect(createHistorical).toHaveBeenCalledWith({ site: "bilibili", bvid: "BV1test000000", cid: "100" });
    expect(captureHistorical).toHaveBeenCalledWith(
      { times: [10], spanSeconds: 0 },
      { timeoutMs: 45_000, signal: expect.any(AbortSignal) }
    );
    expect(captureCurrent).not.toHaveBeenCalled();
    expect(single.frames).toEqual([
      { data: "/9j/2Q==", anchorTime: 10, targetTime: 10, currentTime: 10.05 }
    ]);
    expect(closeHistorical).toHaveBeenCalledTimes(1);

    const expanded = await captureAgentBridgeFrames({
      bvid: "BV1test000000",
      cid: "100",
      times: [10],
      spanSeconds: 2
    });
    expect(expanded.frames.map((frame) => ({ anchorTime: frame.anchorTime, targetTime: frame.targetTime }))).toEqual([
      { anchorTime: 10, targetTime: 8 },
      { anchorTime: 10, targetTime: 10 },
      { anchorTime: 10, targetTime: 12 }
    ]);
  });

  it("超过 12 帧上限时拦截并给出可读错误，按聚类簇数自适应放宽超时至 90s", async () => {
    expect(MAX_BRIDGE_FRAMES_PER_REQUEST).toBe(12);
    expect(computeBridgeFrameTimeoutMs(1)).toBe(45_000);
    expect(computeBridgeFrameTimeoutMs(2)).toBe(60_000);
    expect(computeBridgeFrameTimeoutMs(3)).toBe(75_000);
    expect(computeBridgeFrameTimeoutMs(4)).toBe(90_000);
    expect(computeBridgeFrameTimeoutMs(6)).toBe(90_000);

    await expect(
      captureAgentBridgeFrames({
        bvid: "BV1test000000",
        cid: "100",
        times: [10, 30, 50, 70, 90],
        spanSeconds: 2
      })
    ).rejects.toThrow("最多支持 12 帧");
    expect(createHistorical).not.toHaveBeenCalled();

    const twoClusters = await captureAgentBridgeFrames({
      bvid: "BV1test000000",
      cid: "100",
      times: [30, 400]
    });
    expect(twoClusters.frames.map((frame) => frame.targetTime)).toEqual([30, 400]);
    expect(captureHistorical).toHaveBeenLastCalledWith(
      { times: [30, 400], spanSeconds: 0 },
      { timeoutMs: 60_000, signal: expect.any(AbortSignal) }
    );

    const eightBiliPoints = await captureAgentBridgeFrames({
      bvid: "BV1test000000",
      cid: "100",
      times: [10, 100, 200, 300, 400, 500, 600, 700]
    });
    expect(eightBiliPoints.frames).toHaveLength(8);
    expect(captureHistorical).toHaveBeenLastCalledWith(
      { times: [10, 100, 200, 300, 400, 500, 600, 700], spanSeconds: 0 },
      { timeoutMs: 90_000, signal: expect.any(AbortSignal) }
    );
  });

  it("所有历史帧编码失败时返回可读错误", async () => {
    captureHistorical.mockResolvedValue([]);
    await expect(captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }))
      .rejects.toThrow("没有截取到可用画面");
  });

  it("同视频排队请求复用一个会话，队列空闲后立即销毁", async () => {
    const [first, second] = await Promise.all([
      captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }),
      captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", times: [20, 40] })
    ]);

    expect(createHistorical).toHaveBeenCalledTimes(1);
    expect(captureHistorical.mock.calls.map((call) => call[0])).toEqual([
      { times: [10], spanSeconds: 0 },
      { times: [20, 40], spanSeconds: 0 }
    ]);
    expect(first.frames.map((frame) => frame.targetTime)).toEqual([10]);
    expect(second.frames.map((frame) => frame.targetTime)).toEqual([20, 40]);
    expect(closeHistorical).toHaveBeenCalledTimes(1);
  });

  it("队列切换到其他视频时销毁旧会话", async () => {
    await Promise.all([
      captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }),
      captureAgentBridgeFrames({ bvid: "BV1test000001", cid: "200", targetTime: 20 })
    ]);

    expect(createHistorical).toHaveBeenCalledTimes(2);
    expect(closeHistorical).toHaveBeenCalledTimes(2);
  });

  it("截帧超时后中止本次操作，下一次请求仍可执行", async () => {
    vi.useFakeTimers();
    try {
      captureHistorical.mockImplementation((_spec, { signal }) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("已中止", "AbortError")), { once: true });
      }));
      const pending = captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(100);
      const outcome = await Promise.race([pending, Promise.resolve("still-pending")]);

      expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("视频截帧超时") }));
      captureHistorical.mockImplementation(async (spec: number | HistoricalFrameRequestSpec) =>
        historicalFrames(spec)
      );
      await expect(captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      )).resolves.toMatchObject({ frames: [{ anchorTime: 10, targetTime: 10 }] });
      expect(closeHistorical).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("YouTube 站点支持当前帧与多时间点历史截帧，超 6 个分散簇时直接拦截", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    clipState.setSite("youtube");
    try {
      const current = await captureAgentBridgeFrames({ bvid: "dQw4w9WgXcQ", cid: "yt" });
      expect(current).toMatchObject({
        site: "youtube",
        bvid: "dQw4w9WgXcQ",
        cid: "yt",
        frames: [{ targetTime: 12.5, currentTime: 12.5 }]
      });
      const historical = await captureAgentBridgeFrames({
        bvid: "dQw4w9WgXcQ",
        cid: "yt",
        times: [30, 400]
      });
      expect(historical).toMatchObject({
        site: "youtube",
        bvid: "dQw4w9WgXcQ",
        cid: "yt",
        frames: [
          { anchorTime: 30, targetTime: 30 },
          { anchorTime: 400, targetTime: 400 }
        ]
      });
      expect(createHistorical).toHaveBeenCalledWith({ site: "youtube", bvid: "dQw4w9WgXcQ", cid: "yt" });
      expect(captureHistorical).toHaveBeenLastCalledWith(
        { times: [30, 400], spanSeconds: 0 },
        { timeoutMs: 60_000, signal: expect.any(AbortSignal) }
      );

      await expect(
        captureAgentBridgeFrames({
          bvid: "dQw4w9WgXcQ",
          cid: "yt",
          times: [10, 60, 120, 180, 240, 300, 360]
        })
      ).rejects.toThrow("最多支持 6 个分散时间窗口");
    } finally {
      clipState.setSite("bilibili");
    }
  });
});
