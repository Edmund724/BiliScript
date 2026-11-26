import type { AudioStreamSource, PushedAudioSegment } from "../asr/offscreen-bridge.page.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { YOUTUBE_SABR_CHANNEL } from "./sabr-channel.js";

const PROBE_TIMEOUT_MS = 5000;
const FIRST_SEGMENT_TIMEOUT_MS = 45_000;
const DEFAULT_VIDEO_WINDOW_TIMEOUT_MS = 45_000;

function sanitizeAudioTrackId(rawTrackId: unknown): string {
  const text = String(rawTrackId ?? "").trim();
  if (!text) return "";
  return text.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function abortFrameError(): DOMException {
  return new DOMException("历史帧截取已中止", "AbortError");
}

function postSabrMessage(payload: Record<string, unknown>): void {
  window.postMessage({ channel: YOUTUBE_SABR_CHANNEL, ...payload }, window.location.origin);
}

function readSabrSessionMessage(
  event: MessageEvent,
  sessionId: string
): Record<string, unknown> | null {
  if (event.source !== window) return null;
  const msg = event.data as Record<string, unknown> | null;
  if (!msg || msg.channel !== YOUTUBE_SABR_CHANNEL || msg.sessionId !== sessionId) {
    return null;
  }
  return msg;
}

export interface YoutubeAudioTrackProbeResult {
  audioTrackId: string;
  itag: number;
  hasSniffedTemplate: boolean;
  isLive: boolean;
  isAdPlaying: boolean;
}

export interface YoutubeVideoWindowPayload {
  mimeType: string;
  durationMs: number;
  initSegment: ArrayBuffer;
  mediaSegments: ArrayBuffer[];
}

export interface FetchYoutubeVideoWindowOptions {
  videoId: string;
  startMs: number;
  endMs: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

let workerEnsurePromise: Promise<void> | null = null;
let sessionCounter = 0;

function nextSessionId(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}-${Date.now()}-${sessionCounter}`;
}

export async function ensureYoutubeSabrWorker(): Promise<void> {
  if (!workerEnsurePromise) {
    workerEnsurePromise = (async () => {
      const resp = await sendRuntimeMessage({ type: "youtube-ensure-sabr-worker" });
      if (!resp?.ok) {
        throw new Error(resp?.error || "YouTube 音频采集模块注入失败");
      }
    })().catch((err) => {
      workerEnsurePromise = null;
      throw err;
    });
  }
  return workerEnsurePromise;
}

export async function probeYoutubeAudioTrack(
  expectedVideoId: string
): Promise<YoutubeAudioTrackProbeResult | null> {
  try {
    await ensureYoutubeSabrWorker();
  } catch {
    return null;
  }
  const sessionId = nextSessionId("probe");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, PROBE_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      const msg = readSabrSessionMessage(event, sessionId);
      if (!msg || msg.type !== "probe-result") return;
      cleanup();
      if (!msg.ok) {
        resolve(null);
        return;
      }
      resolve({
        audioTrackId: sanitizeAudioTrackId(msg.audioTrackId),
        itag: Number(msg.itag) || 0,
        hasSniffedTemplate: Boolean(msg.hasSniffedTemplate),
        isLive: Boolean(msg.isLive),
        isAdPlaying: Boolean(msg.isAdPlaying)
      });
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };

    window.addEventListener("message", onMessage);
    postSabrMessage({
      sessionId,
      type: "probe-audio-track",
      expectedVideoId
    });
  });
}

export function createYoutubeAudioStreamSource(options: {
  videoId: string;
  onProgress?: (message: string) => void;
}): AudioStreamSource {
  const { videoId, onProgress } = options;
  return async function* youtubeSabrStream({ signal }): AsyncGenerator<PushedAudioSegment, void, unknown> {
    if (signal.aborted) {
      throw new Error("ASR 任务已中止");
    }
    await ensureYoutubeSabrWorker();
    if (signal.aborted) {
      throw new Error("ASR 任务已中止");
    }

    const sessionId = nextSessionId("sabr");
    type QueueEvent =
      | { kind: "segment"; seg: PushedAudioSegment }
      | { kind: "end" }
      | { kind: "error"; error: string; code?: string };

    const queue: QueueEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let receivedAny = false;
    let segmentCount = 0;

    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };

    const pushEvent = (evt: QueueEvent) => {
      if (finished) return;
      if (evt.kind === "end" || evt.kind === "error") {
        finished = true;
      }
      queue.push(evt);
      wake();
    };

    const firstSegmentTimer = setTimeout(() => {
      if (!receivedAny && !finished) {
        pushEvent({
          kind: "error",
          error: "等待 YouTube 音频流超时，请播放视频片刻后重试。",
          code: "SABR_TIMEOUT"
        });
      }
    }, FIRST_SEGMENT_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      const msg = readSabrSessionMessage(event, sessionId);
      if (!msg) return;
      const type = String(msg.type || "");
      if (type === "init" && msg.buffer instanceof ArrayBuffer) {
        receivedAny = true;
        clearTimeout(firstSegmentTimer);
        pushEvent({ kind: "segment", seg: { kind: "init", bytes: new Uint8Array(msg.buffer) } });
        return;
      }
      if (type === "segment" && msg.buffer instanceof ArrayBuffer) {
        receivedAny = true;
        clearTimeout(firstSegmentTimer);
        segmentCount += 1;
        if (segmentCount === 1) {
          onProgress?.("音频流采集与解码中…");
        }
        pushEvent({ kind: "segment", seg: { kind: "chunk", bytes: new Uint8Array(msg.buffer) } });
        return;
      }
      if (type === "end") {
        clearTimeout(firstSegmentTimer);
        pushEvent({ kind: "end" });
        return;
      }
      if (type === "error") {
        clearTimeout(firstSegmentTimer);
        pushEvent({
          kind: "error",
          error: String(msg.error || "YouTube 音频流采集失败"),
          ...(typeof msg.code === "string" ? { code: msg.code } : {})
        });
      }
    };

    const sendAbort = () => {
      try {
        postSabrMessage({ sessionId, type: "abort-stream" });
      } catch {
      }
    };

    const onAbort = () => {
      clearTimeout(firstSegmentTimer);
      finished = true;
      sendAbort();
      wake();
    };

    window.addEventListener("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      postSabrMessage({
        sessionId,
        type: "start-stream",
        expectedVideoId: videoId
      });

      while (true) {
        if (signal.aborted) {
          throw new Error("ASR 任务已中止");
        }
        if (queue.length === 0) {
          if (finished) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const item = queue.shift()!;
        if (item.kind === "end") {
          return;
        }
        if (item.kind === "error") {
          const err = new Error(item.error) as Error & { code?: string; kind?: string };
          if (item.code) err.code = item.code;
          err.kind = "asr-media";
          throw err;
        }
        yield item.seg;
      }
    } finally {
      clearTimeout(firstSegmentTimer);
      window.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
      sendAbort();
    }
  };
}

export async function fetchYoutubeVideoWindow(
  options: FetchYoutubeVideoWindowOptions
): Promise<YoutubeVideoWindowPayload> {
  const { videoId, startMs, endMs, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_WINDOW_TIMEOUT_MS;
  if (signal?.aborted) {
    throw abortFrameError();
  }
  await ensureYoutubeSabrWorker();
  if (signal?.aborted) {
    throw abortFrameError();
  }

  const sessionId = nextSessionId("yt-frame");

  return new Promise<YoutubeVideoWindowPayload>((resolve, reject) => {
    let settled = false;

    const sendAbort = () => {
      try {
        postSabrMessage({ sessionId, type: "abort-video-window" });
      } catch {
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (err: unknown, notifyWorker: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (notifyWorker) {
        sendAbort();
      }
      reject(err);
    };

    const onAbort = () => {
      fail(abortFrameError(), true);
    };

    const timer = setTimeout(() => {
      fail(new Error(`获取 YouTube 视频分片超时（${timeoutMs} 毫秒）`), true);
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const msg = readSabrSessionMessage(event, sessionId);
      if (!msg) return;
      if (msg.type === "video-window-error") {
        fail(new Error(String(msg.error || "获取 YouTube 视频分片失败")), false);
        return;
      }
      if (msg.type === "video-window-result") {
        const mimeType = String(msg.mimeType || "").trim();
        const durationMs = Math.max(0, Number(msg.durationMs) || 0);
        const initSegment = msg.initSegment instanceof ArrayBuffer ? msg.initSegment : null;
        const rawSegments = Array.isArray(msg.mediaSegments) ? msg.mediaSegments : [];
        const mediaSegments = rawSegments.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
        if (!mimeType || !initSegment || mediaSegments.length === 0) {
          fail(new Error("YouTube 视频分片数据不完整"), false);
          return;
        }
        settled = true;
        cleanup();
        resolve({ mimeType, durationMs, initSegment, mediaSegments });
      }
    };

    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });

    postSabrMessage({
      sessionId,
      type: "capture-video-window",
      expectedVideoId: videoId,
      startMs: Math.max(0, Math.floor(startMs)),
      endMs: Math.max(0, Math.ceil(endMs))
    });
  });
}
