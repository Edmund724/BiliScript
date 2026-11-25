import { ensureYoutubeSabrWorker } from "./audio-source.js";
import { YOUTUBE_SABR_CHANNEL } from "./sabr-protocol.js";

const DEFAULT_VIDEO_WINDOW_TIMEOUT_MS = 45_000;

let videoWindowSessionCounter = 0;

function nextVideoWindowSessionId(): string {
  videoWindowSessionCounter += 1;
  return `yt-frame-${Date.now()}-${videoWindowSessionCounter}`;
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

function abortError(): DOMException {
  return new DOMException("历史帧截取已中止", "AbortError");
}

export async function fetchYoutubeVideoWindow(
  options: FetchYoutubeVideoWindowOptions
): Promise<YoutubeVideoWindowPayload> {
  const { videoId, startMs, endMs, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_WINDOW_TIMEOUT_MS;
  if (signal?.aborted) {
    throw abortError();
  }
  await ensureYoutubeSabrWorker();
  if (signal?.aborted) {
    throw abortError();
  }

  const sessionId = nextVideoWindowSessionId();

  return new Promise<YoutubeVideoWindowPayload>((resolve, reject) => {
    let settled = false;

    const sendAbort = () => {
      try {
        window.postMessage(
          {
            channel: YOUTUBE_SABR_CHANNEL,
            sessionId,
            type: "abort-video-window"
          },
          window.location.origin
        );
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
      fail(abortError(), true);
    };

    const timer = setTimeout(() => {
      fail(new Error(`获取 YouTube 视频分片超时（${timeoutMs} 毫秒）`), true);
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || msg.channel !== YOUTUBE_SABR_CHANNEL || msg.sessionId !== sessionId) {
        return;
      }
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

    window.postMessage(
      {
        channel: YOUTUBE_SABR_CHANNEL,
        sessionId,
        type: "capture-video-window",
        expectedVideoId: videoId,
        startMs: Math.max(0, Math.floor(startMs)),
        endMs: Math.max(0, Math.ceil(endMs))
      },
      window.location.origin
    );
  });
}
