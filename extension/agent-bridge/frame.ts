import { captureHistoricalVideoFrame } from "../chat/historical-video-frame.js";
import { capturePageVideoFrame } from "../live/page-video-frame-capture.js";
import { encodeBase64Bytes } from "../live/moss-live-protocol.js";
import type { AgentBridgeFrame, AgentBridgeFramesResult } from "./protocol.js";

export interface AgentBridgeFrameInput {
  bvid: string;
  cid: string;
  targetTime?: number;
}

export async function captureAgentBridgeFrames(input: AgentBridgeFrameInput): Promise<AgentBridgeFramesResult> {
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
    });
    frames = snapshots.map((frame) => ({
      data: encodeBase64Bytes(frame.jpegBytes),
      targetTime: frame.targetTime,
      currentTime: frame.currentTime
    }));
  }
  if (!frames.length) throw new Error("目标时间点附近没有截取到可用画面");
  return { bvid: input.bvid, cid: input.cid, frames };
}
