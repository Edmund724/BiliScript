import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureCurrent, captureHistorical, closeHistorical, createHistorical } = vi.hoisted(() => ({
  captureCurrent: vi.fn(),
  captureHistorical: vi.fn(),
  closeHistorical: vi.fn(),
  createHistorical: vi.fn()
}));

vi.mock("../../extension/live/page-video-frame-capture.js", () => ({
  capturePageVideoFrame: captureCurrent
}));
vi.mock("../../extension/chat/historical-video-frame.js", () => ({
  createHistoricalVideoFrameSession: createHistorical
}));

import { captureAgentBridgeFrames } from "../../extension/agent-bridge/frame.js";

function historicalFrames(targetTime: number) {
  return [targetTime - 2, targetTime, targetTime + 2].map((time) => ({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    targetTime: time,
    currentTime: time + 0.05
  }));
}

beforeEach(() => {
  captureCurrent.mockResolvedValue({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    currentTime: 12.5
  });
  captureHistorical.mockImplementation(async (targetTime: number) => historicalFrames(targetTime));
  createHistorical.mockReturnValue({ capture: captureHistorical, close: closeHistorical });
});

describe("Agent Bridge 视频帧编码", () => {
  it("当前帧不 seek，并以当前播放秒数作为目标时间", async () => {
    const result = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100" });

    expect(captureCurrent).toHaveBeenCalledTimes(1);
    expect(createHistorical).not.toHaveBeenCalled();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ targetTime: 12.5, currentTime: 12.5 });
    expect(result.frames[0].data).toBe("/9j/2Q==");
  });

  it("历史帧逐张保留目标秒数与实际截图秒数", async () => {
    const result = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 });

    expect(createHistorical).toHaveBeenCalledWith({ bvid: "BV1test000000", cid: "100" });
    expect(captureHistorical).toHaveBeenCalledWith(10, { signal: expect.any(AbortSignal) });
    expect(captureCurrent).not.toHaveBeenCalled();
    expect(result.frames.map((frame) => frame.targetTime)).toEqual([8, 10, 12]);
    expect(result.frames.map((frame) => frame.currentTime)).toEqual([8.05, 10.05, 12.05]);
    expect(closeHistorical).toHaveBeenCalledTimes(1);
  });

  it("所有历史帧编码失败时返回可读错误", async () => {
    captureHistorical.mockResolvedValue([]);
    await expect(captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }))
      .rejects.toThrow("没有截取到可用画面");
  });

  it("同视频排队请求复用一个会话，队列空闲后立即销毁", async () => {
    const [first, second] = await Promise.all([
      captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }),
      captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 20 })
    ]);

    expect(createHistorical).toHaveBeenCalledTimes(1);
    expect(captureHistorical.mock.calls.map((call) => call[0])).toEqual([10, 20]);
    expect(first.frames.map((frame) => frame.targetTime)).toEqual([8, 10, 12]);
    expect(second.frames.map((frame) => frame.targetTime)).toEqual([18, 20, 22]);
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
      captureHistorical.mockImplementation((_targetTime, { signal }) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("已中止", "AbortError")), { once: true });
      }));
      const pending = captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(100);
      const outcome = await Promise.race([pending, Promise.resolve("still-pending")]);

      expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("视频截帧超时") }));
      captureHistorical.mockImplementation(async (targetTime: number) => historicalFrames(targetTime));
      await expect(captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      )).resolves.toMatchObject({ frames: [{ targetTime: 8 }, { targetTime: 10 }, { targetTime: 12 }] });
      expect(closeHistorical).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
