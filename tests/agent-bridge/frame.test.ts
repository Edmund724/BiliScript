import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureCurrent, captureHistorical } = vi.hoisted(() => ({
  captureCurrent: vi.fn(),
  captureHistorical: vi.fn()
}));

vi.mock("../../extension/live/page-video-frame-capture.js", () => ({
  capturePageVideoFrame: captureCurrent
}));
vi.mock("../../extension/chat/historical-video-frame.js", () => ({
  captureHistoricalVideoFrame: captureHistorical
}));

import { captureAgentBridgeFrames } from "../../extension/agent-bridge/frame.js";

beforeEach(() => {
  captureCurrent.mockResolvedValue({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    currentTime: 12.5
  });
  captureHistorical.mockResolvedValue([8, 10, 12].map((targetTime) => ({
    jpegBytes: new Uint8Array([255, 216, 255, 217]),
    targetTime,
    currentTime: targetTime + 0.05
  })));
});

describe("Agent Bridge 视频帧编码", () => {
  it("当前帧不 seek，并以当前播放秒数作为目标时间", async () => {
    const result = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100" });

    expect(captureCurrent).toHaveBeenCalledTimes(1);
    expect(captureHistorical).not.toHaveBeenCalled();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ targetTime: 12.5, currentTime: 12.5 });
    expect(result.frames[0].data).toBe("/9j/2Q==");
  });

  it("历史帧逐张保留目标秒数与实际截图秒数", async () => {
    const result = await captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 });

    expect(captureHistorical).toHaveBeenCalledWith(
      { bvid: "BV1test000000", cid: "100", targetTime: 10 },
      { signal: expect.any(AbortSignal) }
    );
    expect(captureCurrent).not.toHaveBeenCalled();
    expect(result.frames.map((frame) => frame.targetTime)).toEqual([8, 10, 12]);
    expect(result.frames.map((frame) => frame.currentTime)).toEqual([8.05, 10.05, 12.05]);
  });

  it("所有历史帧编码失败时返回可读错误", async () => {
    captureHistorical.mockResolvedValue([]);
    await expect(captureAgentBridgeFrames({ bvid: "BV1test000000", cid: "100", targetTime: 10 }))
      .rejects.toThrow("没有截取到可用画面");
  });

  it("截帧超时后中止本次操作，下一次请求仍可执行", async () => {
    vi.useFakeTimers();
    try {
      captureHistorical.mockImplementation(({ signal }) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("已中止", "AbortError")), { once: true });
      }));
      const pending = captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(100);
      const outcome = await Promise.race([pending, Promise.resolve("still-pending")]);

      expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining("视频截帧超时") }));
      captureHistorical.mockResolvedValue([{
        jpegBytes: new Uint8Array([255, 216, 255, 217]),
        targetTime: 10,
        currentTime: 10
      }]);
      await expect(captureAgentBridgeFrames(
        { bvid: "BV1test000000", cid: "100", targetTime: 10 },
        { timeoutMs: 100 }
      )).resolves.toMatchObject({ frames: [{ targetTime: 10 }] });
    } finally {
      vi.useRealTimers();
    }
  });
});
