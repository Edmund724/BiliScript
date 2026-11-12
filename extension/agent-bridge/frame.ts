import { captureHistoricalVideoFrame } from "../chat/historical-video-frame.js";
import { capturePageVideoFrame } from "../live/page-video-frame-capture.js";
import { encodeBase64Bytes } from "../live/moss-live-protocol.js";
import type { AgentBridgeFrame, AgentBridgeFramesResult } from "./protocol.js";

export interface AgentBridgeFrameInput {
  bvid: string;
  cid: string;
  targetTime?: number;
}

export interface AgentBridgeFrameOptions {
  timeoutMs?: number;
}

const FRAME_TIMEOUT_MS = 45000;

export async function captureAgentBridgeFrames(
  input: AgentBridgeFrameInput,
  options: AgentBridgeFrameOptions = {}
): Promise<AgentBridgeFramesResult> {
  const timeoutMs = options.timeoutMs ?? FRAME_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const capture = (async (): Promise<AgentBridgeFramesResult> => {
    let frames: AgentBridgeFrame[];
    if (input.targetTime === undefined) {
      const frame = await capturePageVideoFrame();
      frames = [{
        data: encodeBase64Bytes(frame.jpegBytes),
        targetTime: frame.currentTime,
        currentTime: frame.currentTime
      }];
    } else {
      const snapshots = await captureHistoricalVideoFrame({
        bvid: input.bvid,
        cid: input.cid,
        targetTime: input.targetTime
      }, { signal: controller.signal });
      frames = snapshots.map((frame) => ({
        data: encodeBase64Bytes(frame.jpegBytes),
        targetTime: frame.targetTime,
        currentTime: frame.currentTime
      }));
    }
    if (!frames.length) throw new Error("目标时间点附近没有截取到可用画面");
    return { bvid: input.bvid, cid: input.cid, frames };
  })();
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`视频截帧超时（${timeoutMs} 毫秒）`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([capture, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
