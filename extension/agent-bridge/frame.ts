import {
  createHistoricalVideoFrameSession,
  type HistoricalVideoFrameSession
} from "../chat/historical-video-frame.js";
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

interface QueuedFrameRequest {
  input: AgentBridgeFrameInput;
  timeoutMs: number;
  resolve: (result: AgentBridgeFramesResult) => void;
  reject: (error: unknown) => void;
}

const FRAME_TIMEOUT_MS = 45000;
const queue: QueuedFrameRequest[] = [];
let draining = false;
let historicalSession: HistoricalVideoFrameSession | null = null;
let historicalSessionKey = "";

function inputKey(input: AgentBridgeFrameInput): string {
  return JSON.stringify([input.bvid, input.cid]);
}

function closeHistoricalSession(): void {
  historicalSession?.close();
  historicalSession = null;
  historicalSessionKey = "";
}

async function captureQueued(
  { input }: QueuedFrameRequest,
  signal: AbortSignal
): Promise<AgentBridgeFramesResult> {
  let frames: AgentBridgeFrame[];
  if (input.targetTime === undefined) {
    const frame = await capturePageVideoFrame();
    frames = [{
      data: encodeBase64Bytes(frame.jpegBytes),
      targetTime: frame.currentTime,
      currentTime: frame.currentTime
    }];
  } else {
    const key = inputKey(input);
    if (!historicalSession) {
      historicalSession = createHistoricalVideoFrameSession({ bvid: input.bvid, cid: input.cid });
      historicalSessionKey = key;
    }
    const snapshots = await historicalSession.capture(input.targetTime, { signal });
    frames = snapshots.map((frame) => ({
      data: encodeBase64Bytes(frame.jpegBytes),
      targetTime: frame.targetTime,
      currentTime: frame.currentTime
    }));
  }
  if (!frames.length) throw new Error("目标时间点附近没有截取到可用画面");
  return { bvid: input.bvid, cid: input.cid, frames };
}

async function captureWithTimeout(request: QueuedFrameRequest): Promise<AgentBridgeFramesResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`视频截帧超时（${request.timeoutMs} 毫秒）`));
      controller.abort();
    }, request.timeoutMs);
  });
  try {
    return await Promise.race([captureQueued(request, controller.signal), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const request = queue.shift()!;
      if (request.input.targetTime === undefined
        || (historicalSession && historicalSessionKey !== inputKey(request.input))) {
        closeHistoricalSession();
      }
      try {
        request.resolve(await captureWithTimeout(request));
      } catch (error) {
        closeHistoricalSession();
        request.reject(error);
      }
    }
  } finally {
    draining = false;
    closeHistoricalSession();
  }
}

export function captureAgentBridgeFrames(
  input: AgentBridgeFrameInput,
  options: AgentBridgeFrameOptions = {}
): Promise<AgentBridgeFramesResult> {
  return new Promise((resolve, reject) => {
    queue.push({ input, timeoutMs: options.timeoutMs ?? FRAME_TIMEOUT_MS, resolve, reject });
    void drain();
  });
}
