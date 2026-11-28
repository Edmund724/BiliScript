import {
  clusterYoutubeFrameWindows,
  createHistoricalVideoFrameSession,
  expandAndDedupeFrameTargets,
  type HistoricalFrameRequestSpec,
  type HistoricalVideoFrameSession
} from "../chat/historical-video-frame.js";
import { getSiteRuntimeVideoElement } from "../core/site-video-probe.js";
import { state } from "../core/state.js";
import { capturePageVideoFrame } from "../live/page-video-frame-capture.js";
import { encodeBase64Bytes } from "../live/moss-live-protocol.js";
import { detectActiveSite, type SiteId } from "../shared/site.js";
import {
  MAX_BRIDGE_FRAMES_PER_REQUEST,
  type AgentBridgeFrame,
  type AgentBridgeFramesResult
} from "./protocol.js";

export { MAX_BRIDGE_FRAMES_PER_REQUEST } from "./protocol.js";

export interface AgentBridgeFrameInput {
  bvid: string;
  cid: string;
  targetTime?: number;
  times?: number[];
  spanSeconds?: number;
}

export interface AgentBridgeFrameOptions {
  timeoutMs?: number;
}

interface QueuedFrameRequest {
  input: AgentBridgeFrameInput;
  spec: HistoricalFrameRequestSpec | null;
  timeoutMs: number;
  resolve: (result: AgentBridgeFramesResult) => void;
  reject: (error: unknown) => void;
}

const FRAME_TIMEOUT_MS = 45_000;
const EXTRA_CLUSTER_TIMEOUT_MS = 15_000;
const MAX_FRAME_TIMEOUT_MS = 90_000;
const queue: QueuedFrameRequest[] = [];
let draining = false;
let historicalSession: HistoricalVideoFrameSession | null = null;
let historicalSessionKey = "";

export function computeBridgeFrameTimeoutMs(clusterCount: number): number {
  return Math.min(
    MAX_FRAME_TIMEOUT_MS,
    FRAME_TIMEOUT_MS + Math.max(0, clusterCount - 1) * EXTRA_CLUSTER_TIMEOUT_MS
  );
}

function resolveSite(): SiteId {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube" ? "youtube" : "bilibili";
}

function inputKey(site: SiteId, input: AgentBridgeFrameInput): string {
  return JSON.stringify([site, input.bvid, input.cid]);
}

function closeHistoricalSession(): void {
  historicalSession?.close();
  historicalSession = null;
  historicalSessionKey = "";
}

function resolveHistoricalSpecAndTimeout(
  site: SiteId,
  input: AgentBridgeFrameInput,
  explicitTimeoutMs?: number
): { spec: HistoricalFrameRequestSpec | null; timeoutMs: number } {
  if (input.times === undefined && input.targetTime === undefined) {
    return { spec: null, timeoutMs: explicitTimeoutMs ?? FRAME_TIMEOUT_MS };
  }
  let rawTimes: number[];
  if (input.times !== undefined) {
    if (!Array.isArray(input.times) || input.times.length === 0) {
      throw new Error("目标时间点列表不能为空");
    }
    rawTimes = input.times.map((value) => Number(value));
  } else {
    rawTimes = [Number(input.targetTime)];
  }
  const spanSeconds = input.spanSeconds === undefined ? 0 : Number(input.spanSeconds);
  const spec: HistoricalFrameRequestSpec = {
    times: rawTimes,
    spanSeconds
  };
  const { targets } = expandAndDedupeFrameTargets(spec);
  if (targets.length > MAX_BRIDGE_FRAMES_PER_REQUEST) {
    throw new Error(
      `单次截帧最多支持 ${MAX_BRIDGE_FRAMES_PER_REQUEST} 帧（当前展开后为 ${targets.length} 帧），请分批请求或减小 spanSeconds`
    );
  }
  const clusters = clusterYoutubeFrameWindows(
    targets,
    site === "youtube" ? undefined : { maxClusters: Number.POSITIVE_INFINITY }
  );
  return {
    spec,
    timeoutMs: explicitTimeoutMs ?? computeBridgeFrameTimeoutMs(clusters.length)
  };
}

async function captureQueued(
  { input, spec, timeoutMs }: QueuedFrameRequest,
  signal: AbortSignal
): Promise<AgentBridgeFramesResult> {
  const site = resolveSite();
  let frames: AgentBridgeFrame[];
  if (spec === null) {
    const frame = await capturePageVideoFrame({ getVideo: () => getSiteRuntimeVideoElement() });
    frames = [{
      data: encodeBase64Bytes(frame.jpegBytes),
      anchorTime: frame.currentTime,
      targetTime: frame.currentTime,
      currentTime: frame.currentTime
    }];
  } else {
    const key = inputKey(site, input);
    if (historicalSession && historicalSessionKey !== key) {
      closeHistoricalSession();
    }
    if (!historicalSession) {
      historicalSession = createHistoricalVideoFrameSession({ site, bvid: input.bvid, cid: input.cid });
      historicalSessionKey = key;
    }
    const snapshots = await historicalSession.capture(spec, { timeoutMs, signal });
    frames = snapshots.map((frame) => ({
      data: encodeBase64Bytes(frame.jpegBytes),
      anchorTime: frame.anchorTime ?? frame.targetTime,
      targetTime: frame.targetTime,
      currentTime: frame.currentTime
    }));
  }
  if (!frames.length) throw new Error("目标时间点附近没有截取到可用画面");
  return { site, bvid: input.bvid, cid: input.cid, frames };
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
      if (request.spec === null
        || (historicalSession && historicalSessionKey !== inputKey(resolveSite(), request.input))) {
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
  let resolved: { spec: HistoricalFrameRequestSpec | null; timeoutMs: number };
  try {
    resolved = resolveHistoricalSpecAndTimeout(resolveSite(), input, options.timeoutMs);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    queue.push({
      input,
      spec: resolved.spec,
      timeoutMs: resolved.timeoutMs,
      resolve,
      reject
    });
    void drain();
  });
}
