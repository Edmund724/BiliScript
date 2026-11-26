import {
  YOUTUBE_SABR_CHANNEL,
  YOUTUBE_SABR_SNIFFER_SLOT_KEY,
  YOUTUBE_SABR_WORKER_SLOT_KEY
} from "./sabr-channel.js";
import { SABR_BODY_LIMIT, isGooglevideoUrlFresh } from "./sabr-protocol.js";
import {
  probeYoutubeSabrAudioTrack,
  runYoutubeSabrAudioSession,
  runYoutubeSabrVideoWindow,
  type SabrSessionHost
} from "./sabr-session.js";
import type { SabrSnifferSlot, SniffedSabrTemplate } from "./sabr-sniffer.main.js";

interface PlayerLike extends HTMLElement {
  getPlayerResponse?: () => Record<string, unknown> | null;
  getVideoData?: () => { video_id?: unknown; isLive?: unknown } | null;
  getAudioTrack?: () => { id?: unknown; languageCode?: unknown; displayName?: unknown } | null;
}

interface YtCfgLike {
  get?: (key: string) => unknown;
  data_?: Record<string, unknown>;
}

const SABR_REQUEST_TIMEOUT_MS = 30_000;

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getMoviePlayer(): PlayerLike | null {
  return document.getElementById("movie_player") as PlayerLike | null;
}

function getSnifferSlot(): SabrSnifferSlot | undefined {
  const slotSym = Symbol.for(YOUTUBE_SABR_SNIFFER_SLOT_KEY);
  return (globalThis as Record<symbol, SabrSnifferSlot | undefined>)[slotSym];
}

function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function postToIsolated(payload: Record<string, unknown>, transfer?: Transferable[]): void {
  const origin = window.location.origin;
  if (transfer && transfer.length > 0) {
    window.postMessage({ channel: YOUTUBE_SABR_CHANNEL, ...payload }, origin, transfer);
  } else {
    window.postMessage({ channel: YOUTUBE_SABR_CHANNEL, ...payload }, origin);
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("SABR 会话已中止"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createMainWorldSabrHost(): SabrSessionHost {
  return {
    isAdPlaying(): boolean {
      const player = getMoviePlayer();
      if (!player) return false;
      return (
        player.classList.contains("ad-showing") ||
        player.classList.contains("ad-interrupting")
      );
    },

    readPlayerResponse(): Record<string, unknown> | null {
      const player = getMoviePlayer();
      try {
        const live = asObj(player?.getPlayerResponse?.());
        if (live) return live;
      } catch {
      }
      return asObj((window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse);
    },

    readVideoId(playerResponse: Record<string, unknown> | null): string {
      const player = getMoviePlayer();
      try {
        const fromData = String(player?.getVideoData?.()?.video_id || "").trim();
        if (fromData) return fromData;
      } catch {
      }
      const details = asObj(playerResponse?.videoDetails);
      const fromResp = String(details?.videoId || "").trim();
      if (fromResp) return fromResp;
      try {
        return new URL(location.href).searchParams.get("v") || "";
      } catch {
        return "";
      }
    },

    readActiveAudioTrackId(): string {
      const player = getMoviePlayer();
      try {
        const track = player?.getAudioTrack?.();
        const id = String(track?.id || "").trim();
        if (id) return id;
      } catch {
      }
      return "";
    },

    readYtcfg(key: string): unknown {
      const ytcfg = asObj((window as unknown as { ytcfg?: unknown }).ytcfg) as YtCfgLike | null;
      if (!ytcfg) return undefined;
      try {
        if (typeof ytcfg.get === "function") {
          return ytcfg.get(key);
        }
      } catch {
      }
      return asObj(ytcfg.data_)?.[key];
    },

    getSniffedTemplate(expectedVideoId: string): SniffedSabrTemplate | null {
      const slot = getSnifferSlot();
      if (!slot) return null;
      const byId = expectedVideoId ? slot.byVideoId.get(expectedVideoId) : null;
      const candidate = byId || (slot.latest?.videoId === expectedVideoId ? slot.latest : null);
      if (!candidate) return null;
      if (!isGooglevideoUrlFresh(candidate.url)) return null;
      if (
        !(candidate.body instanceof Uint8Array) ||
        candidate.body.byteLength === 0 ||
        candidate.body.byteLength > SABR_BODY_LIMIT
      ) {
        return null;
      }
      return candidate;
    },

    isVideoMimeSupported(mimeType: string): boolean {
      return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
        ? MediaSource.isTypeSupported(mimeType)
        : true;
    },

    async fetchRound(url: string, body: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
      const roundController = new AbortController();
      const onOuterAbort = () => roundController.abort();
      signal.addEventListener("abort", onOuterAbort, { once: true });
      const timer = setTimeout(() => roundController.abort(), SABR_REQUEST_TIMEOUT_MS);
      try {
        const slot = getSnifferSlot();
        const nativeFetch = typeof slot?.origFetch === "function" ? slot.origFetch : window.fetch;
        const res = await nativeFetch.call(window, url, {
          method: "POST",
          credentials: "omit",
          body: body.slice(),
          signal: roundController.signal
        });
        if (!res.ok) {
          throw Object.assign(new Error(`YouTube 媒体流请求失败（HTTP ${res.status}）`), {
            code: "SABR_HTTP_ERROR",
            status: res.status
          });
        }
        return new Uint8Array(await res.arrayBuffer());
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onOuterAbort);
      }
    },

    sleep: sleepAbortable
  };
}

function postSessionError(sessionId: string, type: "error" | "video-window-error", err: unknown): void {
  const code = typeof (err as { code?: unknown })?.code === "string"
    ? (err as { code: string }).code
    : undefined;
  postToIsolated({
    sessionId,
    type,
    error: (err as Error)?.message || String(err),
    ...(code ? { code } : {})
  });
}

(function installYoutubeSabrWorker(): void {
  const slotSym = Symbol.for(YOUTUBE_SABR_WORKER_SLOT_KEY);
  const g = globalThis as Record<symbol, { installed: boolean } | undefined>;
  if (g[slotSym]?.installed) {
    return;
  }
  g[slotSym] = { installed: true };

  const host = createMainWorldSabrHost();
  const activeSessions = new Map<string, AbortController>();

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.channel !== YOUTUBE_SABR_CHANNEL) return;

    const reqType = String(msg.type || "");
    const sessionId = String(msg.sessionId || "");
    if (!sessionId) return;

    if (reqType === "probe-audio-track") {
      try {
        const expectedVideoId = String(msg.expectedVideoId || "").trim();
        const result = probeYoutubeSabrAudioTrack(expectedVideoId, host);
        postToIsolated({
          sessionId,
          type: "probe-result",
          ok: true,
          ...result
        });
      } catch (err) {
        postToIsolated({
          sessionId,
          type: "probe-result",
          ok: false,
          error: (err as Error)?.message || String(err)
        });
      }
      return;
    }

    if (reqType === "abort-stream" || reqType === "abort-video-window") {
      const controller = activeSessions.get(sessionId);
      if (controller) {
        controller.abort();
        activeSessions.delete(sessionId);
      }
      return;
    }

    if (reqType === "capture-video-window") {
      if (activeSessions.has(sessionId)) return;
      const controller = new AbortController();
      activeSessions.set(sessionId, controller);
      const expectedVideoId = String(msg.expectedVideoId || "").trim();
      const startMs = Math.max(0, Number(msg.startMs) || 0);
      const endMs = Math.max(startMs, Number(msg.endMs) || startMs);

      void runYoutubeSabrVideoWindow(
        { expectedVideoId, startMs, endMs, signal: controller.signal },
        host
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          const initBuf = toOwnedArrayBuffer(result.initSegment);
          const mediaBufs = result.mediaSegments.map(toOwnedArrayBuffer);
          postToIsolated(
            {
              sessionId,
              type: "video-window-result",
              mimeType: result.mimeType,
              durationMs: result.durationMs,
              initSegment: initBuf,
              mediaSegments: mediaBufs
            },
            [initBuf, ...mediaBufs]
          );
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          postSessionError(sessionId, "video-window-error", err);
        })
        .finally(() => {
          activeSessions.delete(sessionId);
        });
      return;
    }

    if (reqType === "start-stream") {
      if (activeSessions.has(sessionId)) return;
      const controller = new AbortController();
      activeSessions.set(sessionId, controller);
      const expectedVideoId = String(msg.expectedVideoId || "").trim();

      void runYoutubeSabrAudioSession(
        { expectedVideoId, signal: controller.signal },
        host,
        (evt) => {
          if (controller.signal.aborted) return;
          if (evt.type === "init") {
            const buffer = toOwnedArrayBuffer(evt.data);
            postToIsolated({ sessionId, type: "init", buffer }, [buffer]);
          } else if (evt.type === "segment") {
            const buffer = toOwnedArrayBuffer(evt.data);
            postToIsolated({ sessionId, type: "segment", seq: evt.seq, buffer }, [buffer]);
          } else {
            postToIsolated({ sessionId, type: "end" });
          }
        }
      )
        .catch((err) => {
          if (controller.signal.aborted) return;
          postSessionError(sessionId, "error", err);
        })
        .finally(() => {
          activeSessions.delete(sessionId);
        });
    }
  });
})();
